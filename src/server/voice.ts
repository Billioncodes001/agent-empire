/**
 * FREE-05 (CITY-03/04): the office host's offline speech runtime.
 *
 * - Models live in `<dataDir>/voice/models/<id>/` and count as installed only once `installed.json` is written, which
 *   happens after the archive was verified (pinned sha256, or the exact size when no digest is published) and
 *   extracted. Nothing is ever downloaded on its own: `startDownload` needs `confirm === true` (FREE_PLAN rule 5).
 * - Speech runs through the optional `sherpa-onnx-node` package (Apache-2.0), loaded lazily on first use. When it is
 *   not installed the office still runs and every voice surface falls back to text.
 * - Push-to-talk audio is held in memory only for the transcription; it is written to disk only when the user opted in
 *   (`keepRecordings`). A transcript is pending until it is sent once or cancelled; it expires after five minutes.
 * - No cloud speech service is used. Downloads go only to the catalogue's official sherpa-onnx release URLs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  MAX_AUDIO_SECONDS, MAX_SPEAK_CHARS, SHERPA_PACKAGE, TRANSCRIPT_TTL_MS, VOICE_MODELS,
  type Transcript, type VoiceDownload, type VoiceKind, type VoiceModel, type VoiceState,
} from '../shared/voice.js';

export class VoiceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface SttEngine { transcribe(samples: Float32Array, sampleRate: number): Promise<string> }
export interface TtsEngine { synthesize(text: string): Promise<{ samples: Float32Array; sampleRate: number }> }
/** The speech engine seam. Production uses sherpa-onnx; tests and fixtures inject fakes (no real models). */
export interface VoiceEngines {
  detect(): Promise<{ available: boolean; detail: string }>;
  stt(model: VoiceModel, dir: string): Promise<SttEngine>;
  tts(model: VoiceModel, dir: string): Promise<TtsEngine>;
}

export interface VoiceOptions {
  dataDir: string;
  engines?: VoiceEngines;
  fetch?: typeof fetch;
  /** Unpacks a .tar.bz2 archive into `dest`. Default: the system `tar` (macOS, Linux, Windows 10+ bsdtar). */
  extract?: (archive: string, dest: string) => Promise<void>;
  catalogue?: readonly VoiceModel[];
  now?: () => number;
  onChange?: () => void;
}

// ---- WAV (16-bit PCM) --------------------------------------------------------------------------------------------

/** Parses a 16-bit PCM WAV (mono, or channels averaged). Throws VoiceError(400) on anything else. */
export function decodeWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new VoiceError(400, 'Expected a WAV recording.');
  let off = 12; let fmt: { channels: number; rate: number; bits: number; format: number } | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4); const size = buf.readUInt32LE(off + 4); const body = off + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1 || fmt.channels > 2 || fmt.rate < 8000 || fmt.rate > 48000) throw new VoiceError(400, 'Expected 16-bit PCM WAV audio, mono or stereo, 8–48 kHz.');
      const end = Math.min(buf.length, body + size);
      const frames = Math.floor((end - body) / (2 * fmt.channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) sum += buf.readInt16LE(body + (i * fmt.channels + c) * 2);
        samples[i] = sum / fmt.channels / 32768;
      }
      return { samples, sampleRate: fmt.rate };
    }
    off = body + size + (size & 1);
  }
  throw new VoiceError(400, 'The WAV recording has no audio data.');
}

export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(36 + samples.length * 2, 4); out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii'); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii'); out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return out;
}

// ---- sherpa-onnx (optional, lazy) --------------------------------------------------------------------------------

function findFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 3) walk(p, depth + 1); else if (e.isFile()) out.push(p); } };
  walk(dir, 0);
  return out;
}
const pick = (files: string[], ...patterns: RegExp[]) => { for (const re of patterns) { const f = files.find((x) => re.test(path.basename(x))); if (f) return f; } return undefined; };
const need = (f: string | undefined, what: string) => { if (!f) throw new VoiceError(500, `The installed model is missing ${what}. Remove it and download it again.`); return f; };

/**
 * Config shapes follow the official Node addon examples
 * (https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-addon-examples: test_asr_non_streaming_moonshine_v2.js,
 * test_asr_non_streaming_whisper.js, test_tts_non_streaming_kokoro_en.js). Calls are synchronous native work, so a
 * transcription briefly occupies the office host's event loop (a 30-second cap bounds it).
 */
export function sherpaEngines(load: () => any = () => createRequire(import.meta.url)(SHERPA_PACKAGE)): VoiceEngines {
  let mod: any; let loadError: string | undefined;
  const get = () => {
    if (mod) return mod;
    try { mod = load(); return mod; } catch (e) { loadError = (e as Error).message; throw new VoiceError(409, `The speech runtime (${SHERPA_PACKAGE}) is not installed on the office host. Text works without it.`); }
  };
  const stt = new Map<string, SttEngine>(); const tts = new Map<string, TtsEngine>();
  return {
    async detect() {
      try { get(); return { available: true, detail: `${SHERPA_PACKAGE} is installed (Apache-2.0). Speech runs on the office host, offline.` }; }
      catch { return { available: false, detail: `${SHERPA_PACKAGE} is not installed on the office host, so voice is off and text is used. To enable it, run “npm install ${SHERPA_PACKAGE}” in the office’s install folder (Apache-2.0; macOS, Windows, Linux).${loadError ? ` Load error: ${loadError.split('\n')[0].slice(0, 160)}` : ''}` }; }
    },
    async stt(model, dir) {
      const cached = stt.get(model.id); if (cached) return cached;
      const sherpa = get(); const files = findFiles(dir);
      const tokens = need(pick(files, /^tokens\.txt$/, /tokens\.txt$/), 'tokens.txt');
      const modelConfig: Record<string, unknown> = { tokens, numThreads: 2, provider: 'cpu', debug: 0 };
      if (model.family === 'moonshine') {
        const merged = pick(files, /^decoder_model_merged.*\.(ort|onnx)$/);
        modelConfig.moonshine = merged
          ? { encoder: need(pick(files, /^encoder_model.*\.(ort|onnx)$/), 'the encoder'), mergedDecoder: merged }
          : { preprocessor: need(pick(files, /^preprocess.*\.onnx$/), 'the preprocessor'), encoder: need(pick(files, /^encode.*\.onnx$/), 'the encoder'), uncachedDecoder: need(pick(files, /^uncached_decode.*\.onnx$/), 'the decoder'), cachedDecoder: need(pick(files, /^cached_decode.*\.onnx$/), 'the cached decoder') };
      } else {
        modelConfig.whisper = { encoder: need(pick(files, /encoder\.int8\.onnx$/, /encoder\.onnx$/), 'the encoder'), decoder: need(pick(files, /decoder\.int8\.onnx$/, /decoder\.onnx$/), 'the decoder') };
      }
      const recognizer = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig });
      const engine: SttEngine = {
        async transcribe(samples, sampleRate) {
          const s = recognizer.createStream();
          s.acceptWaveform({ sampleRate, samples });
          recognizer.decode(s);
          const r = recognizer.getResult(s);
          return String(r?.text ?? '').trim();
        },
      };
      stt.set(model.id, engine);
      return engine;
    },
    async tts(model, dir) {
      const cached = tts.get(model.id); if (cached) return cached;
      const sherpa = get(); const files = findFiles(dir);
      const onnx = need(pick(files, /^model\.int8\.onnx$/, /^model\.onnx$/, /\.onnx$/), 'model.onnx');
      const root = path.dirname(onnx);
      const tool = new sherpa.OfflineTts({
        model: { kokoro: { model: onnx, voices: need(pick(files, /^voices\.bin$/), 'voices.bin'), tokens: need(pick(files, /^tokens\.txt$/), 'tokens.txt'), dataDir: path.join(root, 'espeak-ng-data') }, numThreads: 2, provider: 'cpu', debug: 0 },
        maxNumSentences: 1,
      });
      const engine: TtsEngine = { async synthesize(text) { const a = tool.generate({ text, sid: 0, speed: 1.0 }); return { samples: a.samples, sampleRate: a.sampleRate }; } };
      tts.set(model.id, engine);
      return engine;
    },
  };
}

const systemExtract = (archive: string, dest: string) => new Promise<void>((resolve, reject) => {
  mkdirSync(dest, { recursive: true });
  execFile('tar', ['-xjf', archive, '-C', dest], { timeout: 15 * 60_000 }, (err) => (err ? reject(new Error(`Could not unpack the archive: ${err.message.split('\n')[0]}`)) : resolve()));
});

// ---- runtime -----------------------------------------------------------------------------------------------------

interface Saved { stt?: string; tts?: string; keepRecordings?: boolean }

export class VoiceRuntime {
  readonly root: string;
  readonly modelsDir: string;
  private readonly catalogue: readonly VoiceModel[];
  private readonly engines: VoiceEngines;
  private readonly fetcher: typeof fetch;
  private readonly extract: (archive: string, dest: string) => Promise<void>;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private saved: Saved = {};
  private dl?: VoiceDownload;
  private abort?: AbortController;
  private transcripts = new Map<string, Transcript>();

  constructor(opts: VoiceOptions) {
    this.root = path.join(opts.dataDir, 'voice');
    this.modelsDir = path.join(this.root, 'models');
    this.catalogue = opts.catalogue ?? VOICE_MODELS;
    this.engines = opts.engines ?? sherpaEngines();
    this.fetcher = opts.fetch ?? fetch;
    this.extract = opts.extract ?? systemExtract;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange ?? (() => {});
    try { this.saved = JSON.parse(readFileSync(path.join(this.root, 'voice.json'), 'utf8')) ?? {}; } catch { this.saved = {}; }
  }

  private persist() {
    mkdirSync(this.root, { recursive: true });
    const file = path.join(this.root, 'voice.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(this.saved, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  installed(id: string): boolean { return existsSync(path.join(this.modelsDir, id, 'installed.json')); }

  private selectedModel(kind: VoiceKind): VoiceModel | undefined {
    const id = this.saved[kind];
    const chosen = this.catalogue.find((m) => m.id === id && m.kind === kind && this.installed(m.id));
    return chosen ?? this.catalogue.find((m) => m.kind === kind && this.installed(m.id));
  }

  async state(): Promise<VoiceState> {
    const runtime = await this.engines.detect().catch(() => ({ available: false, detail: 'The speech runtime could not be checked.' }));
    const stt = this.selectedModel('stt'); const tts = this.selectedModel('tts');
    return {
      runtime: { ...runtime, package: SHERPA_PACKAGE },
      models: this.catalogue.map((m) => ({ ...m, installed: this.installed(m.id) })),
      selected: { stt: stt?.id, tts: tts?.id },
      ready: { stt: runtime.available && !!stt, tts: runtime.available && !!tts },
      keepRecordings: !!this.saved.keepRecordings,
      download: this.dl ? { ...this.dl } : undefined,
      modelsDir: this.modelsDir,
    };
  }

  select(kind: unknown, id: unknown) {
    if (kind !== 'stt' && kind !== 'tts') throw new VoiceError(400, 'kind must be stt or tts.');
    const m = this.catalogue.find((x) => x.id === id && x.kind === kind);
    if (!m) throw new VoiceError(400, 'Unknown voice model.');
    if (!this.installed(m.id)) throw new VoiceError(409, `${m.name} is not installed yet.`);
    this.saved = { ...this.saved, [kind]: m.id };
    this.persist();
    this.onChange();
  }

  setKeepRecordings(on: unknown) {
    if (typeof on !== 'boolean') throw new VoiceError(400, 'keepRecordings must be true or false.');
    this.saved = { ...this.saved, keepRecordings: on };
    this.persist();
    this.onChange();
  }

  /** Starts a download of a catalogue model, only with `confirm === true`. Progress is in `state().download`. */
  startDownload(id: unknown, confirm: unknown): { error?: string; started?: Promise<void> } {
    if (confirm !== true) return { error: 'A voice model download needs explicit confirmation of its name, size and licence.' };
    const m = this.catalogue.find((x) => x.id === id);
    if (!m) return { error: 'Only the listed voice models can be downloaded from here.' };
    if (this.dl && !this.dl.done) return { error: `${this.dl.model} is still downloading.` };
    if (this.installed(m.id)) return { error: `${m.name} is already installed.` };
    this.abort = new AbortController();
    this.dl = { model: m.id, status: 'starting', completed: 0, total: m.sizeBytes, done: false };
    this.onChange();
    return { started: this.run(m, this.abort.signal) };
  }

  cancelDownload(): boolean {
    if (!this.dl || this.dl.done) return false;
    this.abort?.abort();
    Object.assign(this.dl, { done: true, cancelled: true, status: 'cancelled' });
    this.onChange();
    return true;
  }

  private async run(m: VoiceModel, signal: AbortSignal) {
    const dl = this.dl!;
    mkdirSync(this.root, { recursive: true });
    const part = path.join(this.root, `${m.id}.part`);
    const tmp = path.join(this.modelsDir, `${m.id}.tmp`);
    const fail = (error: string) => { if (!dl.cancelled) Object.assign(dl, { done: true, error, status: 'failed' }); };
    try {
      const res = await this.fetcher(m.url, { signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`The release server answered HTTP ${res.status}.`);
      dl.status = 'downloading';
      const hash = createHash('sha256');
      const out = createWriteStream(part);
      const reader = res.body.getReader();
      // Cancel ends a pending read even if the transport ignores the abort signal.
      signal.addEventListener('abort', () => { reader.cancel().catch(() => {}); }, { once: true });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal.aborted) throw new Error('cancelled');
          dl.completed += value.length;
          if (dl.completed > m.sizeBytes) throw new Error(`The download is larger than the pinned size (${m.sizeBytes} bytes); stopped.`);
          hash.update(value);
          if (!out.write(value)) await new Promise((r) => out.once('drain', r));
        }
      } finally { await new Promise<void>((r) => out.end(() => r())); }
      if (signal.aborted) throw new Error('cancelled');
      if (dl.completed !== m.sizeBytes) throw new Error(`Size mismatch: got ${dl.completed} bytes, expected ${m.sizeBytes}. Nothing was installed.`);
      const digest = hash.digest('hex');
      if (m.sha256 && digest !== m.sha256) throw new Error('Checksum mismatch: the file is not the published release. Nothing was installed.');
      dl.status = 'unpacking';
      this.onChange();
      rmSync(tmp, { recursive: true, force: true });
      await this.extract(part, tmp);
      writeFileSync(path.join(tmp, 'installed.json'), JSON.stringify({ id: m.id, url: m.url, sizeBytes: m.sizeBytes, sha256: digest, verified: m.sha256 ? 'sha256' : 'size', installedAt: this.now() }, null, 2));
      rmSync(path.join(this.modelsDir, m.id), { recursive: true, force: true });
      renameSync(tmp, path.join(this.modelsDir, m.id));
      if (!this.saved[m.kind] || !this.installed(this.saved[m.kind]!)) { this.saved = { ...this.saved, [m.kind]: m.id }; this.persist(); }
      Object.assign(dl, { done: true, status: 'installed' });
    } catch (e) {
      fail((e as Error).name === 'AbortError' || (e as Error).message === 'cancelled' ? 'cancelled' : (e as Error).message);
      rmSync(tmp, { recursive: true, force: true });
    } finally {
      rmSync(part, { force: true });
      this.onChange();
    }
  }

  private sweep() { const cutoff = this.now() - TRANSCRIPT_TTL_MS; for (const [id, t] of this.transcripts) if (t.createdAt < cutoff) this.transcripts.delete(id); }

  /** Transcribes one push-to-talk recording on this host. The audio is dropped afterwards unless the user opted in. */
  async transcribe(wav: Buffer): Promise<Transcript> {
    const runtime = await this.engines.detect();
    const model = this.selectedModel('stt');
    if (!model) throw new VoiceError(409, 'No speech-to-text model is installed. Choose one in Settings → Voice, or type instead.');
    if (!runtime.available) throw new VoiceError(409, runtime.detail);
    const { samples, sampleRate } = decodeWav(wav);
    const durationSec = samples.length / sampleRate;
    if (durationSec > MAX_AUDIO_SECONDS) throw new VoiceError(413, `Recordings are limited to ${MAX_AUDIO_SECONDS} seconds.`);
    if (durationSec < 0.2) throw new VoiceError(400, 'The recording is too short. Hold the button while you speak.');
    const engine = await this.engines.stt(model, path.join(this.modelsDir, model.id));
    const text = (await engine.transcribe(samples, sampleRate)).replace(/\s+/g, ' ').trim().slice(0, 2000);
    this.sweep();
    const t: Transcript = { id: `T${randomBytes(9).toString('base64url')}`, text, createdAt: this.now(), status: 'pending', durationSec: Math.round(durationSec * 10) / 10 };
    this.transcripts.set(t.id, t);
    if (this.saved.keepRecordings) {
      const dir = path.join(this.root, 'recordings');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${t.id}.wav`), wav);
    }
    return { ...t };
  }

  /** Marks a pending transcript sent and returns it. A transcript is sent once: a second call is a 409. */
  takeTranscript(id: string): Transcript {
    this.sweep();
    const t = this.transcripts.get(id);
    if (!t) throw new VoiceError(404, 'That transcript expired or does not exist. Record again.');
    if (t.status !== 'pending') throw new VoiceError(409, `That transcript was already ${t.status}.`);
    t.status = 'sent';
    return { ...t };
  }

  cancelTranscript(id: string): Transcript {
    const t = this.transcripts.get(id);
    if (!t) throw new VoiceError(404, 'That transcript expired or does not exist.');
    if (t.status === 'pending') t.status = 'cancelled';
    return { ...t };
  }

  /** Speaks text with the selected Kokoro voice; a WAV. Text is always shown as subtitles too. */
  async speak(text: unknown): Promise<Buffer> {
    const clean = typeof text === 'string' ? text.trim().slice(0, MAX_SPEAK_CHARS) : '';
    if (!clean) throw new VoiceError(400, 'Nothing to say.');
    const model = this.selectedModel('tts');
    if (!model) throw new VoiceError(409, 'No voice is installed. Subtitles only; choose a voice in Settings → Voice.');
    const runtime = await this.engines.detect();
    if (!runtime.available) throw new VoiceError(409, runtime.detail);
    const engine = await this.engines.tts(model, path.join(this.modelsDir, model.id));
    const { samples, sampleRate } = await engine.synthesize(clean);
    return encodeWav(samples, sampleRate);
  }

}
