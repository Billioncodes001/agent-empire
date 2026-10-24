/**
 * FREE-05 (CITY-03): Settings → Voice. Shows the office host's speech runtime, the installed models, and an explicit,
 * confirmed download for each catalogue model (name, size, licence and source shown first; progress and cancel).
 * Nothing downloads on its own. A microphone test runs only in this page. Text always works without any of it.
 */
import { apiFetch } from '../endpoint';
import { fmtBytes, type ChiefReply, type Transcript, type VoiceKind, type VoiceModelState, type VoiceState } from '../../shared/voice';
import { micUnavailableReason, startRecording } from '../ptt';
import { h, toast } from './dom';
import { confirmDialog } from './prompt';

async function call<T>(path: string, body?: unknown, raw?: Blob): Promise<T> {
  const res = await apiFetch(path, {
    method: body === undefined && !raw ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin',
    ...(raw ? { headers: { 'content-type': 'audio/wav' }, body: raw } : body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json as T;
}

export const voiceApi = {
  state: () => call<VoiceState>('/api/voice'),
  download: (model: string) => call<VoiceState>('/api/voice/download', { model, confirm: true }),
  cancel: () => call<VoiceState>('/api/voice/cancel', {}),
  select: (kind: VoiceKind, id: string) => call<VoiceState>('/api/voice/select', { kind, id }),
  keepRecordings: (on: boolean) => call<VoiceState>('/api/voice/settings', { keepRecordings: on }),
  transcribe: (wav: Blob) => call<Transcript>('/api/voice/transcribe', undefined, wav),
  send: (id: string) => call<ChiefReply & { transcript: Transcript }>(`/api/voice/transcripts/${encodeURIComponent(id)}/send`, {}),
  discard: (id: string) => call<Transcript>(`/api/voice/transcripts/${encodeURIComponent(id)}/cancel`, {}),
  chief: (text: string, requestId: string) => call<ChiefReply>('/api/phone/chief', { text, requestId }),
  async speak(text: string): Promise<Blob> {
    const res = await apiFetch('/api/voice/speak', { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Speech failed (${res.status})`);
    return res.blob();
  },
};

const KIND_LABEL: Record<VoiceKind, string> = { stt: 'Speech to text (your voice → words)', tts: 'Text to speech (the chief’s voice)' };

function modelRow(m: VoiceModelState, s: VoiceState, onChange: (s: VoiceState) => void) {
  const selected = s.selected[m.kind] === m.id;
  const busy = !!s.download && !s.download.done;
  const meta = h('span.voice-meta', {}, `${fmtBytes(m.sizeBytes)} · ${m.licence} · ${m.sha256 ? 'sha256 verified' : 'size verified (no published checksum)'}`);
  const action = m.installed
    ? h('button.btn', { type: 'button', role: 'radio', 'aria-checked': String(selected), class: selected ? 'on' : '', disabled: selected, 'aria-label': `Use ${m.name}`,
      onclick: () => voiceApi.select(m.kind, m.id).then(onChange, (e) => toast(e.message, 'error')) }, selected ? 'In use' : 'Use')
    : h('button.btn', { type: 'button', disabled: busy, 'aria-label': `Download ${m.name}, ${fmtBytes(m.sizeBytes)}`,
      onclick: () => confirmDialog(`Download ${m.name}?`,
        `${fmtBytes(m.sizeBytes)} from the official sherpa-onnx release (${new URL(m.url).hostname}). Licence ${m.licence}. Stored on the office host and used offline. ${m.sha256 ? 'The file is checked against its published sha256.' : 'No checksum is published for this file; its exact size is checked.'}`,
        `Download (${fmtBytes(m.sizeBytes)})`, () => voiceApi.download(m.id).then(onChange, (e) => toast(e.message, 'error'))) }, `Download (${fmtBytes(m.sizeBytes)})`);
  return h('li.voice-model', { 'data-model': m.id, 'data-installed': String(m.installed) },
    h('div.voice-model-text', {}, h('strong', {}, m.name, m.installed ? h('span.voice-badge', {}, 'Installed') : null), meta, h('span.voice-note', {}, m.note, ' ', h('a', { href: m.source, target: '_blank', rel: 'noopener' }, 'Source'), ' · ', h('a', { href: m.licenceUrl, target: '_blank', rel: 'noopener' }, 'Licence'))),
    action);
}

/** Microphone test: three seconds of level meter, nothing uploaded or stored. */
function micTest() {
  const reason = micUnavailableReason();
  const meter = h('div.mic-meter', { role: 'meter', 'aria-label': 'Microphone level', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, h('span'));
  const note = h('p.setting-note', {}, reason ?? 'Speak for three seconds. The sound stays in this page; nothing is uploaded or saved.');
  const btn = h('button.btn', { type: 'button', disabled: !!reason }, '🎙️ Test microphone');
  btn.addEventListener('click', async () => {
    btn.disabled = true; let peak = 0;
    try {
      const rec = await startRecording({ onLevel: (l) => { peak = Math.max(peak, l); (meter.firstElementChild as HTMLElement).style.width = `${Math.round(l * 100)}%`; meter.setAttribute('aria-valuenow', String(Math.round(l * 100))); } });
      note.textContent = 'Listening…';
      await new Promise((r) => setTimeout(r, 3000));
      rec.cancel();
      note.textContent = peak > 0.05 ? 'Your microphone works. Push-to-talk is ready once a speech-to-text model is installed.' : 'No sound reached the page. Check the microphone and the browser’s permission for this site.';
    } catch (e) {
      note.textContent = `Microphone not available: ${(e as Error).message}. Text still works.`;
    } finally { btn.disabled = false; (meter.firstElementChild as HTMLElement).style.width = '0'; }
  });
  return h('div.mic-test', {}, h('div.sector-actions', {}, btn, meter), note);
}

export function voiceSetupSection() {
  const body = h('div.voice-setup', { 'aria-live': 'polite' }, h('p.setting-note', {}, 'Checking the office host’s speech runtime…'));
  let timer: number | undefined; let disposed = false;
  const paint = (s: VoiceState) => {
    if (disposed) return;
    const dl = s.download;
    const progress = dl ? h('div.voice-progress', {},
      h('span', {}, `${dl.model}: ${dl.error ? `failed — ${dl.error}` : dl.status}`),
      !dl.done ? h('progress', { max: String(dl.total || 1), value: String(dl.completed), 'aria-label': 'Download progress' }) : null,
      !dl.done ? h('span.voice-meta', {}, `${fmtBytes(dl.completed)} of ${fmtBytes(dl.total)}`) : null,
      !dl.done ? h('button.btn.danger', { type: 'button', onclick: () => voiceApi.cancel().then(paint, (e) => toast(e.message, 'error')) }, 'Cancel download') : null) : null;
    const group = (kind: VoiceKind) => h('div.voice-group', {}, h('span.empire-eyebrow', {}, KIND_LABEL[kind]),
      h('ul.voice-models', { role: 'radiogroup', 'aria-label': KIND_LABEL[kind] }, ...s.models.filter((m) => m.kind === kind).map((m) => modelRow(m, s, paint))));
    const keep = h('input', { type: 'checkbox', id: 'voice-keep' }) as HTMLInputElement;
    keep.checked = s.keepRecordings;
    keep.addEventListener('change', () => voiceApi.keepRecordings(keep.checked).then(paint, (e) => toast(e.message, 'error')));
    body.replaceChildren(
      h('article.status-card.voice-runtime', { 'data-tone': s.runtime.available ? 'good' : 'unknown' },
        h('span.empire-eyebrow', {}, 'Speech runtime · sherpa-onnx (Apache-2.0)'),
        h('strong', {}, h('span.status-dot', { 'aria-hidden': 'true' }), s.runtime.available ? 'Installed on the office host' : 'Not installed · text only'),
        h('p', {}, s.runtime.detail),
        h('p.setting-note', {}, `Push-to-talk: ${s.ready.stt ? 'ready' : 'off'} · Spoken replies: ${s.ready.tts ? 'ready' : 'off'}. No cloud speech service is used; once models are installed, voice works offline.`)),
      progress ?? '', group('stt'), group('tts'),
      h('label.voice-check', { for: 'voice-keep' }, keep, ' Keep my push-to-talk recordings on the office host (off by default; otherwise audio is dropped after transcription)'),
      micTest(),
    );
    window.clearTimeout(timer);
    if (dl && !dl.done) timer = window.setTimeout(() => voiceApi.state().then(paint, () => {}), 700);
  };
  voiceApi.state().then(paint, (e) => body.replaceChildren(h('p.setting-note', {}, `Voice settings are unavailable: ${e.message}. Text still works.`)));
  const el = h('section.voice-settings', { 'aria-label': 'Voice' }, h('label', { style: 'margin-top:18px' }, 'Voice'), body);
  return { el, dispose: () => { disposed = true; window.clearTimeout(timer); } };
}
