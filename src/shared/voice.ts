/**
 * FREE-05 (CITY-02/03/04): offline voice, the in-game phone and the chief call. Shared by the office host and the game.
 *
 * Speech runs on the office host through sherpa-onnx (Apache-2.0, https://github.com/k2-fsa/sherpa-onnx; Node addon
 * `sherpa-onnx-node`, docs https://k2-fsa.github.io/sherpa/onnx/javascript-api/index.html). Models come only from the
 * official sherpa-onnx GitHub releases (`asr-models`, `tts-models`), and only after an explicit click that showed the
 * name, size and licence (FREE_PLAN rule 5). Sizes and sha256 digests below were read on 2026-10-24 from the GitHub
 * release-asset API (`GET /repos/k2-fsa/sherpa-onnx/releases/{id}/assets`, field `digest`). Where GitHub publishes no
 * digest (older assets), the exact byte size is pinned and verified instead, and the UI says so.
 */

export type VoiceKind = 'stt' | 'tts';
export type VoiceFamily = 'moonshine' | 'whisper' | 'kokoro';

export interface VoiceModel {
  id: string;
  kind: VoiceKind;
  family: VoiceFamily;
  name: string;
  /** Exact archive size in bytes (verified after download). */
  sizeBytes: number;
  /** Pinned sha256 of the archive (hex), when the official release publishes one. */
  sha256?: string;
  licence: string;
  licenceUrl: string;
  /** The archive (an official sherpa-onnx release asset). */
  url: string;
  /** Where the model and its licence are described. */
  source: string;
  note: string;
  /** Cap on the unpacked size (default 4x the archive). */
  maxUnpackedBytes?: number;
}

const ASR = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/';
const TTS = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/';

export const VOICE_MODELS: readonly VoiceModel[] = [
  {
    id: 'moonshine-tiny-en', kind: 'stt', family: 'moonshine', name: 'Moonshine Tiny (English)',
    sizeBytes: 29_858_559, sha256: '9ec31b342d8fa3240c3b81b8f82e1cf7e3ac467c93ca5a999b741d5887164f8d',
    licence: 'MIT', licenceUrl: 'https://github.com/moonshine-ai/moonshine/blob/main/LICENSE',
    url: `${ASR}sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2`,
    source: 'https://k2-fsa.github.io/sherpa/onnx/moonshine/index.html',
    note: 'Fastest. English only. Good for short commands.',
  },
  {
    id: 'moonshine-base-en', kind: 'stt', family: 'moonshine', name: 'Moonshine Base (English)',
    sizeBytes: 111_266_225, sha256: '43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891',
    licence: 'MIT', licenceUrl: 'https://github.com/moonshine-ai/moonshine/blob/main/LICENSE',
    url: `${ASR}sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2`,
    source: 'https://k2-fsa.github.io/sherpa/onnx/moonshine/index.html',
    note: 'More accurate than Tiny, still fast. English only.',
  },
  {
    id: 'whisper-small-en', kind: 'stt', family: 'whisper', name: 'Whisper Small (English)',
    sizeBytes: 635_693_775,
    licence: 'MIT', licenceUrl: 'https://github.com/openai/whisper/blob/main/LICENSE',
    url: `${ASR}sherpa-onnx-whisper-small.en.tar.bz2`,
    source: 'https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/index.html',
    note: 'Most accurate, slowest and largest. No published checksum: only the exact size is verified (an extra confirmation is asked).',
  },
  {
    id: 'kokoro-en-int8', kind: 'tts', family: 'kokoro', name: 'Kokoro (English, int8)',
    sizeBytes: 103_248_205, sha256: 'c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/hexgrad/Kokoro-82M',
    url: `${TTS}kokoro-int8-en-v0_19.tar.bz2`,
    source: 'https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html',
    note: 'Natural voice, smaller download. 11 English speakers.',
  },
  {
    id: 'kokoro-en', kind: 'tts', family: 'kokoro', name: 'Kokoro (English, full)',
    sizeBytes: 319_625_534, sha256: '912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/hexgrad/Kokoro-82M',
    url: `${TTS}kokoro-en-v0_19.tar.bz2`,
    source: 'https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html',
    note: 'Same voice at full precision; larger download.',
  },
];

/** Push-to-talk audio: 16 kHz mono 16-bit WAV, at most 30 seconds (about 0.96 MB). */
export const VOICE_SAMPLE_RATE = 16_000;
export const MAX_AUDIO_SECONDS = 30;
export const MAX_AUDIO_BYTES = 44 + MAX_AUDIO_SECONDS * VOICE_SAMPLE_RATE * 2 + 1024;
export const MAX_SPEAK_CHARS = 1200;
export const MAX_CHIEF_TEXT = 2000;
/** A transcript waits this long for confirmation, then expires unsent. */
export const TRANSCRIPT_TTL_MS = 5 * 60_000;
export const SHERPA_PACKAGE = 'sherpa-onnx-node';

export interface VoiceDownload {
  model: string;
  status: string;
  completed: number;
  total: number;
  done: boolean;
  cancelled?: boolean;
  error?: string;
  /** E.g. a size-only model whose digest differs from an earlier install. */
  warning?: string;
}

export interface VoiceModelState extends VoiceModel { installed: boolean }

export interface VoiceState {
  runtime: { available: boolean; package: string; detail: string };
  models: VoiceModelState[];
  selected: { stt?: string; tts?: string };
  ready: { stt: boolean; tts: boolean };
  keepRecordings: boolean;
  /** How many push-to-talk recordings are kept (only when the user opted in; pruned after 30 days). */
  keptRecordings: number;
  download?: VoiceDownload;
  modelsDir: string;
}

export type TranscriptStatus = 'pending' | 'sent' | 'cancelled';
export interface Transcript { id: string; text: string; createdAt: number; status: TranscriptStatus; durationSec: number }

export type BriefingSource = 'rule_based' | 'model';
/** What the chief says when called. FREE-02 may back `source: 'model'`; today it is always rule-based. */
export interface ChiefBriefing { text: string; source: BriefingSource; observedAt: number }
export interface ChiefReply extends ChiefBriefing {
  label: string;
  kind: 'briefing' | 'new_job' | 'needs_text';
  jobId?: string;
  approvalId?: string;
}

export const sourceLabel = (s: BriefingSource) => (s === 'model' ? 'Model-backed report' : 'Rule-based report');

export type ChiefRequest = { kind: 'briefing'; question?: string } | { kind: 'new_job'; title: string; brief: string } | { kind: 'needs_text'; reason: string };

/** "new job: …" (or "new job …") creates a pending plan; anything else is a question for the briefing. */
export function parseChiefRequest(raw: unknown): ChiefRequest {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, MAX_CHIEF_TEXT) : '';
  if (!text) return { kind: 'briefing' };
  const job = /^(?:please\s+)?(?:a\s+)?new\s+job\b[\s:,.-]*(.*)$/i.exec(text);
  if (job) {
    const brief = job[1].trim();
    if (brief.length < 3) return { kind: 'needs_text', reason: 'Say or type what the job is after “new job:”.' };
    const title = brief.length > 80 ? `${brief.slice(0, 77).trimEnd()}…` : brief;
    return { kind: 'new_job', title: title.charAt(0).toUpperCase() + title.slice(1), brief };
  }
  return { kind: 'briefing', question: text };
}

export const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
