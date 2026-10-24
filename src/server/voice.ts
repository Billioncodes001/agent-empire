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
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
  /** Unpacks a .tar.bz2 into `dest` within the limits. Default: `safeExtract` with the system tar (absolute path). */
  extract?: (archive: string, dest: string, signal: AbortSignal, limits: { maxBytes: number; maxFiles: number }) => Promise<void>;
  /** Opens the download file. Tests inject a failing stream; default `createWriteStream(path, { flags: 'wx' })`. */
  openWrite?: (file: string) => Writable;
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

// ---- safe extraction ---------------------------------------------------------------------------------------------

/** The system tar by absolute path (never PATH or the working directory): bsdtar on macOS/Windows, GNU or bsdtar on Linux. */
export function systemTar(): string | undefined {
  if (process.platform === 'win32') return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return ['/usr/bin/tar', '/bin/tar'].find((p) => existsSync(p));
}

export interface ExtractLimits { maxBytes: number; maxFiles: number; signal?: AbortSignal }

const run = (file: string, args: string[], signal?: AbortSignal, maxBuffer = 16 * 1024 * 1024) => new Promise<string>((resolve, reject) => {
  execFile(file, args, { timeout: 15 * 60_000, maxBuffer, signal, env: { LC_ALL: 'C', PATH: '' }, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

const unsafeName = (name: string) => !name || path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.startsWith('\\') || name.split(/[\\/]+/).includes('..');

/**
 * Lists the archive first and refuses absolute or `..` paths, links, devices, more than `maxFiles` entries and more
 * than `maxBytes` in total; then unpacks with `--no-same-owner` and re-checks what landed (no links, same caps).
 */
export async function safeExtract(archive: string, dest: string, limits: ExtractLimits): Promise<void> {
  const tar = systemTar();
  if (!tar || !existsSync(tar)) throw new Error('No system tar was found to unpack the model.');
  const names = (await run(tar, ['-tjf', archive], limits.signal)).split('\n').filter((l) => l.length);
  const long = (await run(tar, ['-tvjf', archive], limits.signal)).split('\n').filter((l) => l.length);
  if (names.length !== long.length) throw new Error('The archive listing is inconsistent; refusing to unpack.');
  if (names.length > limits.maxFiles) throw new Error(`The archive has too many files (${names.length}); refusing to unpack.`);
  let total = 0;
  names.forEach((name, i) => {
    if (unsafeName(name)) throw new Error(`The archive contains an unsafe path (${name.slice(0, 80)}); refusing to unpack.`);
    const line = long[i];
    const type = line[0];
    if (type !== '-' && type !== 'd') throw new Error(`The archive contains a link or special file (${name.slice(0, 80)}), not a regular file; refusing to unpack.`);
    const f = line.trim().split(/\s+/);
    const size = Number(f[1]?.includes('/') ? f[2] : f[4]); // GNU: mode owner/group size …; bsdtar: mode links owner group size …
    if (!Number.isFinite(size) || size < 0) throw new Error('The archive listing could not be read; refusing to unpack.');
    total += size;
  });
  if (total > limits.maxBytes) throw new Error(`The archive is too large when unpacked (${total} bytes); refusing to unpack.`);
  mkdirSync(dest, { recursive: true });
  await run(tar, ['-xjf', archive, '-C', dest, '--no-same-owner'], limits.signal);
  // Defence in depth: what actually landed.
  let files = 0; let bytes = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e); const st = lstatSync(p);
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) throw new Error('The unpacked model contains a link or special file; removed.');
      if (st.isDirectory()) walk(p); else { files++; bytes += st.size; }
    }
  };
  walk(dest);
  if (files > limits.maxFiles || bytes > limits.maxBytes) throw new Error('The unpacked model is larger than allowed; removed.');
}

// ---- runtime -----------------------------------------------------------------------------------------------------

interface Saved { stt?: string; tts?: string; keepRecordings?: boolean; digests?: Record<string, string> }
const RECORDING_DAYS = 30;

export class VoiceRuntime {
  readonly root: string;
  readonly modelsDir: string;
  private readonly catalogue: readonly VoiceModel[];
  private readonly engines: VoiceEngines;
  private readonly fetcher: typeof fetch;
  private readonly extract: NonNullable<VoiceOptions['extract']>;
  private readonly openWrite: NonNullable<VoiceOptions['openWrite']>;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private saved: Saved = {};
  private dl?: VoiceDownload;
  private abort?: AbortController;
  /** The download in flight, until it has fully stopped (cancel included). */
  private running?: Promise<void>;
  /** One speech job (transcription or synthesis) at a time: sherpa-onnx runs synchronously on this thread. */
  private speechBusy = false;
  private transcripts = new Map<string, Transcript>();

  constructor(opts: VoiceOptions) {
    this.root = path.join(opts.dataDir, 'voice');
    this.modelsDir = path.join(this.root, 'models');
    this.catalogue = opts.catalogue ?? VOICE_MODELS;
    this.engines = opts.engines ?? sherpaEngines();
    this.fetcher = opts.fetch ?? fetch;
    this.extract = opts.extract ?? ((archive, dest, signal, limits) => safeExtract(archive, dest, { ...limits, signal }));
    this.openWrite = opts.openWrite ?? ((file) => createWriteStream(file, { flags: 'wx' }));
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange ?? (() => {});
    try { this.saved = JSON.parse(readFileSync(path.join(this.root, 'voice.json'), 'utf8')) ?? {}; } catch { this.saved = {}; }
    this.pruneRecordings();
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

  private get recordingsDir() { return path.join(this.root, 'recordings'); }
  private recordings(): string[] { try { return readdirSync(this.recordingsDir).filter((f) => f.endsWith('.wav')); } catch { return []; } }

  /** Kept recordings older than 30 days are deleted. */
  pruneRecordings() {
    const cutoff = this.now() - RECORDING_DAYS * 864e5;
    for (const f of this.recordings()) { const p = path.join(this.recordingsDir, f); try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true }); } catch { /* gone */ } }
  }

  deleteRecordings(): number {
    const list = this.recordings();
    for (const f of list) rmSync(path.join(this.recordingsDir, f), { force: true });
    this.onChange();
    return list.length;
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
      keptRecordings: this.recordings().length,
      download: this.dl ? { ...this.dl } : undefined,
      // A display path only: the absolute data directory is not sent to clients.
      modelsDir: 'voice/models (in the office data folder)',
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

  /** Removes an installed model (its recorded digest is kept, to flag a different file on reinstall). */
  remove(id: unknown) {
    const m = this.catalogue.find((x) => x.id === id);
    if (!m) throw new VoiceError(400, 'Unknown voice model.');
    if (this.running) throw new VoiceError(409, 'Wait for the current download to finish.');
    rmSync(path.join(this.modelsDir, m.id), { recursive: true, force: true });
    this.onChange();
  }

  setKeepRecordings(on: unknown) {
    if (typeof on !== 'boolean') throw new VoiceError(400, 'keepRecordings must be true or false.');
    this.saved = { ...this.saved, keepRecordings: on };
    this.persist();
    this.onChange();
  }

  /**
   * Starts a download of a catalogue model, only with `confirm === true`; a model without a published checksum also
   * needs `confirmUnverified === true`. One download at a time, including one that is still stopping after a cancel.
   */
  startDownload(id: unknown, confirm: unknown, confirmUnverified?: unknown): { error?: string; started?: Promise<void> } {
    if (confirm !== true) return { error: 'A voice model download needs explicit confirmation of its name, size and licence.' };
    const m = this.catalogue.find((x) => x.id === id);
    if (!m) return { error: 'Only the listed voice models can be downloaded from here.' };
    if (!m.sha256 && confirmUnverified !== true) return { error: `${m.name} has no published checksum: only its size can be checked. Confirm that warning to download it.` };
    if (this.running) return { error: this.dl?.cancelled ? `${this.dl.model} is still stopping; try again in a moment.` : `${this.dl?.model ?? 'A model'} is still downloading.` };
    if (this.installed(m.id)) return { error: `${m.name} is already installed.` };
    const free = freeBytes(this.root);
    if (free !== undefined && free < m.sizeBytes * 3) return { error: `Not enough free disk space for ${m.name}: about ${Math.ceil((m.sizeBytes * 3) / 1e6)} MB is needed for the download and unpacking.` };
    const abort = new AbortController();
    this.abort = abort;
    this.dl = { model: m.id, status: 'starting', completed: 0, total: m.sizeBytes, done: false };
    this.onChange();
    const started = this.runDownload(m, abort.signal, this.dl).finally(() => { this.running = undefined; this.onChange(); });
    this.running = started;
    return { started };
  }

  /** Asks the download to stop; it reports `done` once it has really stopped and cleaned up. */
  cancelDownload(): boolean {
    if (!this.dl || this.dl.done || this.dl.cancelled) return false;
    Object.assign(this.dl, { cancelled: true, status: 'cancelling' });
    this.abort?.abort();
    this.onChange();
    return true;
  }

  private async runDownload(m: VoiceModel, signal: AbortSignal, dl: VoiceDownload) {
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.modelsDir, { recursive: true });
    const runId = randomBytes(6).toString('hex');
    const part = path.join(this.root, `${m.id}.${runId}.part`);
    const tmp = path.join(this.modelsDir, `${m.id}.${runId}.tmp`);
    const hash = createHash('sha256');
    try {
      const res = await this.fetcher(m.url, { signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`The release server answered HTTP ${res.status}.`);
      dl.status = 'downloading';
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          dl.completed += chunk.length;
          if (dl.completed > m.sizeBytes) return cb(new Error(`The download is larger than the pinned size (${m.sizeBytes} bytes); stopped.`));
          hash.update(chunk); cb(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, this.openWrite(part), { signal });
      } catch (e) {
        if (signal.aborted) throw new Error('cancelled');
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'EEXIST' || /no space/i.test((e as Error).message)) throw new Error(`The download could not be saved on the office host (${code ?? 'write error'}: ${(e as Error).message}). Nothing was installed.`);
        throw e;
      }
      if (dl.completed !== m.sizeBytes) throw new Error(`Size mismatch: got ${dl.completed} bytes, expected ${m.sizeBytes}. Nothing was installed.`);
      const digest = hash.digest('hex');
      if (m.sha256 && digest !== m.sha256) throw new Error('Checksum mismatch: the file is not the published release. Nothing was installed.');
      if (signal.aborted) throw new Error('cancelled');
      dl.status = 'unpacking';
      this.onChange();
      await this.extract(part, tmp, signal, { maxBytes: m.maxUnpackedBytes ?? Math.max(m.sizeBytes * 4, 64e6), maxFiles: 2000 });
      if (signal.aborted) throw new Error('cancelled');
      const earlier = this.saved.digests?.[m.id];
      if (!m.sha256 && earlier && earlier !== digest) dl.warning = `This download’s sha256 (${digest.slice(0, 12)}…) differs from the earlier install (${earlier.slice(0, 12)}…). The release file changed; check the source before using it.`;
      writeFileSync(path.join(tmp, 'installed.json'), JSON.stringify({ id: m.id, url: m.url, sizeBytes: m.sizeBytes, sha256: digest, verified: m.sha256 ? 'sha256' : 'size', installedAt: this.now() }, null, 2));
      if (signal.aborted) throw new Error('cancelled');
      rmSync(path.join(this.modelsDir, m.id), { recursive: true, force: true });
      renameSync(tmp, path.join(this.modelsDir, m.id));
      this.saved = { ...this.saved, digests: { ...this.saved.digests, [m.id]: earlier ?? digest } };
      if (!this.saved[m.kind] || !this.installed(this.saved[m.kind]!)) this.saved = { ...this.saved, [m.kind]: m.id };
      this.persist();
      Object.assign(dl, { done: true, status: 'installed' });
    } catch (e) {
      const cancelled = signal.aborted || (e as Error).name === 'AbortError' || (e as Error).message === 'cancelled';
      Object.assign(dl, cancelled ? { done: true, cancelled: true, status: 'cancelled' } : { done: true, error: (e as Error).message, status: 'failed' });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(part, { force: true });
    }
  }

  private sweep() { const cutoff = this.now() - TRANSCRIPT_TTL_MS; for (const [id, t] of this.transcripts) if (t.createdAt < cutoff) this.transcripts.delete(id); }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.speechBusy) throw new VoiceError(429, 'The office host is busy with another speech request; try again in a moment.');
    this.speechBusy = true;
    try { return await fn(); } finally { this.speechBusy = false; }
  }

  /** Transcribes one push-to-talk recording on this host. The audio is dropped afterwards unless the user opted in. */
  async transcribe(wav: Buffer): Promise<Transcript> {
    const model = this.selectedModel('stt');
    if (!model) throw new VoiceError(409, 'No speech-to-text model is installed. Choose one in Settings → Voice, or type instead.');
    const { samples, sampleRate } = decodeWav(wav);
    const durationSec = samples.length / sampleRate;
    if (durationSec > MAX_AUDIO_SECONDS) throw new VoiceError(413, `Recordings are limited to ${MAX_AUDIO_SECONDS} seconds.`);
    if (durationSec < 0.2) throw new VoiceError(400, 'The recording is too short. Hold the button while you speak.');
    return this.exclusive(async () => {
      const runtime = await this.engines.detect();
      if (!runtime.available) throw new VoiceError(409, runtime.detail);
      const engine = await this.engines.stt(model, path.join(this.modelsDir, model.id));
      const text = (await engine.transcribe(samples, sampleRate)).replace(/\s+/g, ' ').trim().slice(0, 2000);
      this.sweep();
      const t: Transcript = { id: `T${randomBytes(9).toString('base64url')}`, text, createdAt: this.now(), status: 'pending', durationSec: Math.round(durationSec * 10) / 10 };
      this.transcripts.set(t.id, t);
      if (this.saved.keepRecordings) {
        mkdirSync(this.recordingsDir, { recursive: true });
        writeFileSync(path.join(this.recordingsDir, `${t.id}.wav`), wav);
        this.pruneRecordings();
      }
      return { ...t };
    });
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
    return this.exclusive(async () => {
      const runtime = await this.engines.detect();
      if (!runtime.available) throw new VoiceError(409, runtime.detail);
      const engine = await this.engines.tts(model, path.join(this.modelsDir, model.id));
      const { samples, sampleRate } = await engine.synthesize(clean);
      return encodeWav(samples, sampleRate);
    });
  }
}

function freeBytes(dir: string): number | undefined {
  try { mkdirSync(dir, { recursive: true }); const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return undefined; }
}
