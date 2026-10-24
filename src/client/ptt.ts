/**
 * FREE-05 (CITY-04) push-to-talk capture: the browser's microphone (getUserMedia), downmixed and resampled to the
 * 16 kHz mono 16-bit WAV the office host transcribes. Nothing leaves this page except that one WAV, uploaded over the
 * signed-in connection to the office host; it never goes to a cloud speech service. Capture stops itself at the limit.
 * The mobile game apps keep the microphone off (their WebViews deny the permission), so the phone offers text there.
 */
import { appConfig } from './endpoint';
import { MAX_AUDIO_SECONDS, VOICE_SAMPLE_RATE } from '../shared/voice';

/** Why push-to-talk is unavailable here, or null when the browser can try. */
export function micUnavailableReason(): string | null {
  const app = appConfig();
  if (app && (app.platform === 'ios' || app.platform === 'android')) return 'This app keeps the microphone off. Type to the chief instead; push-to-talk works in the browser and the desktop app.';
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'This browser has no microphone access here (it needs HTTPS or localhost). Type instead.';
  return null;
}

export function encodeWav16(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

/** Linear resampling is enough for speech recognition at 16 kHz. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const out = new Float32Array(Math.floor((input.length * to) / from));
  const ratio = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio; const i0 = Math.floor(x); const i1 = Math.min(input.length - 1, i0 + 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (x - i0);
  }
  return out;
}

export interface Recorder {
  /** Stops and returns the WAV (null if cancelled or empty). */
  stop(): Promise<Blob | null>;
  cancel(): void;
}

/** Opens the microphone and records until stop/cancel or the time limit. `onLevel` gets 0..1 RMS for a meter. */
export async function startRecording(opts: { onLevel?: (level: number) => void; onLimit?: () => void } = {}): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but universally available and needs no extra module file; capture is short.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let frames = 0; let finished = false;
  const limit = MAX_AUDIO_SECONDS * ctx.sampleRate - 4096;
  proc.onaudioprocess = (e) => {
    if (finished) return;
    const data = new Float32Array(e.inputBuffer.getChannelData(0));
    if (frames + data.length > limit) { finished = true; opts.onLimit?.(); return; }
    chunks.push(data); frames += data.length;
    let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    opts.onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 4));
  };
  source.connect(proc); proc.connect(ctx.destination);
  const release = () => { finished = true; proc.disconnect(); source.disconnect(); stream.getTracks().forEach((t) => t.stop()); void ctx.close(); };
  return {
    async stop() {
      const rate = ctx.sampleRate;
      release();
      if (!frames) return null;
      const all = new Float32Array(frames); let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      return encodeWav16(resample(all, rate, VOICE_SAMPLE_RATE), VOICE_SAMPLE_RATE);
    },
    cancel() { release(); chunks.length = 0; frames = 0; },
  };
}
