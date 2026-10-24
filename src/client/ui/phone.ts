/**
 * FREE-05 (CITY-02/04): the in-game phone. Contacts are the executives (rule-based reports, labelled) and the workers
 * (their real status and current task). Calling the chief returns `chiefBriefing()` from the office host as subtitles,
 * spoken with the installed Kokoro voice when the user wants it. Push-to-talk records on hold, shows the transcript for
 * confirmation, and sends it once. Workers never "speak": their entry is their live status, nothing invented.
 */
import { EXECUTIVES, type Executive } from '../../shared/org';
import type { WorkerInfo } from '../../shared/protocol';
import { sourceLabel, type ChiefReply, type Transcript, type VoiceState } from '../../shared/voice';
import { micUnavailableReason, startRecording, type Recorder } from '../ptt';
import { store } from '../state';
import { h, openModal, toast } from './dom';
import { voiceApi } from './voice-setup';
import './phone.css';

const SPEAK_KEY = 'agent-empire.phone.speak';
const OFFERED_KEY = 'agent-empire.voice.offered';
const STATUS_TEXT: Record<string, string> = { starting: 'Starting', idle: 'Idle', working: 'Working', needs_input: 'Needs your input', done: 'Turn ended, not verified', exited: 'Stopped', offline: 'Offline (server restarted)' };
const store_ = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const initials = (name: string) => name.split(/[\s·]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

type Contact = { id: string; kind: 'chief' | 'executive' | 'worker'; name: string; role: string; status: string; tone: 'good' | 'warn' | 'unknown'; exec?: Executive; worker?: WorkerInfo };

function contacts(): Contact[] {
  const execs: Contact[] = (store.org?.executives ?? []).map((e) => ({
    id: `exec-${e.role}`, kind: e.role === 'chief_of_staff' ? 'chief' : 'executive', name: e.name, role: `${EXECUTIVES[e.role].title} · Rule-based`,
    status: e.active ? (e.attention ? `${e.attention} waiting on you` : 'Available') : 'Not staffed yet', tone: !e.active ? 'unknown' : e.attention ? 'warn' : 'good', exec: e,
  }));
  if (!execs.some((c) => c.kind === 'chief')) execs.unshift({ id: 'exec-chief_of_staff', kind: 'chief', name: EXECUTIVES.chief_of_staff.name, role: 'Chief of staff · Rule-based', status: 'Available', tone: 'good' });
  const workers: Contact[] = [...store.workers.values()].filter((w) => w.kind === 'agent').map((w) => ({
    id: `worker-${w.id}`, kind: 'worker', name: w.name, role: 'Worker · live status', status: STATUS_TEXT[w.status] ?? 'Status unknown',
    tone: w.status === 'needs_input' ? 'warn' : w.status === 'working' || w.status === 'idle' ? 'good' : 'unknown', worker: w,
  }));
  return [...execs, ...workers];
}

export function openPhone() {
  let voice: VoiceState | null = null;
  let speak = store_(SPEAK_KEY) !== 'off';
  let audio: HTMLAudioElement | null = null;
  let recorder: Recorder | null = null;
  let pending: Transcript | null = null;
  let active: Contact | null = null;
  let seq = 0;
  let failed: { text: string; rid: string } | null = null;

  const list = h('ul.phone-contacts', { 'aria-label': 'Contacts' });
  const screen = h('div.phone-screen', { 'aria-live': 'polite' });
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close phone' }, '✕');
  const el = h('div.modal.phone-modal.ae-dark', { role: 'dialog', 'aria-label': 'Phone' },
    h('header', {}, h('h2', {}, '📱 Phone'), h('span.phone-clock', { 'aria-hidden': 'true' }, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), close),
    h('div.phone-body', {}, h('nav.phone-list', { 'aria-label': 'Contacts' }, h('span.empire-eyebrow', {}, 'Executives & workers'), list), screen));

  const stopAudio = () => { audio?.pause(); if (audio?.src) URL.revokeObjectURL(audio.src); audio = null; };
  const cancelRecording = () => { recorder?.cancel(); recorder = null; el.classList.remove('recording'); };
  const modal = openModal(el, {
    onClose: () => { cancelRecording(); stopAudio(); if (pending) void voiceApi.discard(pending.id).catch(() => {}); unsubscribe(); },
    // Escape first cancels a recording or a pending transcript, then hangs up, then closes.
    onEscape: () => {
      if (recorder) { cancelRecording(); paintCall(); return true; }
      if (pending) { void voiceApi.discard(pending.id).catch(() => {}); pending = null; paintCall(); return true; }
      if (active) { hangUp(); return true; }
      return false;
    },
  });
  close.addEventListener('click', () => modal.close());

  const paintList = () => {
    list.replaceChildren(...contacts().map((c) => h('li', {},
      h('button.phone-contact', { type: 'button', 'data-contact': c.id, 'data-kind': c.kind, 'aria-current': active?.id === c.id ? 'true' : 'false', disabled: c.kind === 'executive' && !c.exec?.active,
        'aria-label': `${c.kind === 'worker' ? 'View' : 'Call'} ${c.name}, ${c.role}, ${c.status}`, onclick: () => dial(c) },
        h('span.phone-avatar', { 'aria-hidden': 'true', 'data-tone': c.tone }, initials(c.name)),
        h('span.phone-contact-text', {}, h('strong', {}, c.name), h('span', {}, c.role), h('span.phone-status', { 'data-tone': c.tone }, c.status))))));
  };
  const unsubscribe = (() => { const offs = [store.on('workers', () => { paintList(); if (active?.kind === 'worker') dial(contacts().find((c) => c.id === active!.id) ?? active!, true); }), store.on('org', paintList), store.on('queue', () => { if (active?.kind === 'worker') paintCall(); })]; return () => offs.forEach((off) => typeof off === 'function' && off()); })();

  const subtitles = h('ol.phone-subtitles', { 'aria-label': 'Call subtitles', 'aria-live': 'polite' });
  const addLine = (who: 'you' | 'chief' | 'system', text: string, label?: string) => {
    subtitles.append(h('li', { 'data-who': who }, label ? h('span.phone-label', {}, label) : '', h('p', {}, text)));
    subtitles.scrollTop = subtitles.scrollHeight;
  };
  const reply = async (r: ChiefReply) => {
    addLine('chief', r.text, r.label);
    if (speak && voice?.ready.tts && r.kind !== 'needs_text') {
      try { stopAudio(); audio = new Audio(URL.createObjectURL(await voiceApi.speak(r.text))); await audio.play(); }
      catch (e) { addLine('system', `Spoken reply unavailable: ${(e as Error).message} Subtitles continue.`); }
    }
  };
  const ask = async (text: string) => {
    const t = text.trim();
    if (t) addLine('you', t);
    // A retry of the same text after a failure reuses its requestId, so a "new job" that did reach the host is not saved twice.
    const rid = failed?.text === t ? failed.rid : `${Date.now().toString(36)}-${++seq}`;
    try { await reply(await voiceApi.chief(t, rid)); failed = null; }
    catch (e) { failed = { text: t, rid }; addLine('system', `The chief could not answer: ${(e as Error).message} Send the same text again to retry safely.`); }
  };

  const hangUp = () => { cancelRecording(); stopAudio(); if (pending) void voiceApi.discard(pending.id).catch(() => {}); pending = null; active = null; subtitles.replaceChildren(); paintList(); paintIdle(); };

  const paintIdle = () => screen.replaceChildren(h('div.phone-idle', {},
    h('p.phone-idle-title', {}, 'Who do you want to reach?'),
    h('p.setting-note', {}, 'Executives answer with rule-based reports from the office records. Workers show their live status; they don’t take calls.')));

  function dial(c: Contact, refresh = false) {
    if (!refresh && active?.id !== c.id) { hangUp(); active = c; paintList(); }
    active = c;
    if (c.kind === 'chief' && !refresh) { paintCall(); void ask(''); maybeOfferSetup(); }
    else if (c.kind === 'executive' && !refresh) { paintCall(); addLine('chief', `${c.exec?.summary ?? 'No report.'}`, sourceLabel('rule_based')); }
    else paintCall();
  }

  const paintCall = () => {
    const c = active;
    if (!c) return paintIdle();
    const head = h('div.phone-call-head', {},
      h('span.phone-avatar.big', { 'aria-hidden': 'true', 'data-tone': c.tone, 'data-live': String(c.kind !== 'worker') }, initials(c.name)),
      h('div', {}, h('strong', {}, c.name), h('span', {}, c.kind === 'worker' ? 'Live status from the office' : `On the line · ${c.role}`)),
      h('button.btn.danger.phone-hangup', { type: 'button', onclick: hangUp }, c.kind === 'worker' ? 'Close' : 'Hang up'));
    if (c.kind === 'worker') {
      const w = store.workers.get(c.worker!.id) ?? c.worker!;
      const task = store.queue.tasks.find((t) => t.workerId === w.id && t.status === 'running');
      screen.replaceChildren(head, h('dl.phone-worker', {},
        h('dt', {}, 'Status'), h('dd', {}, STATUS_TEXT[w.status] ?? 'Status unknown'),
        h('dt', {}, 'Doing'), h('dd', {}, w.activity || 'Nothing reported'),
        h('dt', {}, 'Current task'), h('dd', {}, task?.title ?? 'No running task'),
        h('dt', {}, 'Desk'), h('dd', {}, w.deskId ?? '—')),
        h('p.setting-note', {}, 'Workers don’t take calls. This is exactly what the office reports for them; open their desk terminal to talk to them.'));
      return;
    }
    const input = h('input', { type: 'text', maxlength: '2000', placeholder: c.kind === 'chief' ? 'Ask the chief, or “new job: …”' : 'Calls to this executive are read-only', 'aria-label': 'Message to the chief', disabled: c.kind !== 'chief' }) as HTMLInputElement;
    const send = h('button.btn.primary', { type: 'submit', disabled: c.kind !== 'chief' }, 'Send');
    const form = h('form.phone-compose', { onsubmit: (e: Event) => { e.preventDefault(); const v = input.value; input.value = ''; void ask(v); } }, input, send);
    const speakBox = h('input', { type: 'checkbox', id: 'phone-speak' }) as HTMLInputElement;
    speakBox.checked = speak; speakBox.disabled = !voice?.ready.tts;
    speakBox.addEventListener('change', () => { speak = speakBox.checked; save(SPEAK_KEY, speak ? 'on' : 'off'); if (!speak) stopAudio(); });
    const speakRow = h('label.voice-check.phone-speak', { for: 'phone-speak' }, speakBox, voice?.ready.tts ? ' Speak replies aloud' : ' Spoken replies: install a voice in Settings → Voice');
    screen.replaceChildren(head, subtitles, c.kind === 'chief' ? pttBlock() : '', form, speakRow);
  };

  const pttBlock = () => {
    if (pending) {
      const t = pending;
      const sendBtn = h('button.btn.primary', { type: 'button' }, 'Send to chief');
      const edit = h('button.btn', { type: 'button' }, 'Edit as text');
      const discard = h('button.btn', { type: 'button' }, 'Discard');
      sendBtn.addEventListener('click', async () => {
        sendBtn.disabled = edit.disabled = discard.disabled = true; // sent once: the buttons go before the request
        pending = null;
        addLine('you', t.text);
        paintCall();
        try { await reply(await voiceApi.send(t.id)); } catch (e) { addLine('system', `Not sent: ${(e as Error).message}`); }
      });
      edit.addEventListener('click', () => { void voiceApi.discard(t.id).catch(() => {}); pending = null; paintCall(); const i = screen.querySelector<HTMLInputElement>('.phone-compose input'); if (i) { i.value = t.text; i.focus(); } });
      discard.addEventListener('click', () => { void voiceApi.discard(t.id).catch(() => {}); pending = null; paintCall(); });
      queueMicrotask(() => sendBtn.focus());
      return h('div.phone-confirm', { role: 'group', 'aria-label': 'Confirm transcript' },
        h('span.empire-eyebrow', {}, `Heard (${t.durationSec}s) · check before sending`), h('blockquote', {}, t.text || '(nothing recognised)'),
        h('div.sector-actions', {}, sendBtn, edit, discard));
    }
    const reason = micUnavailableReason() ?? (!voice ? 'Checking voice…' : !voice.runtime.available ? 'Push-to-talk is off: the speech runtime is not installed on the office host. Type instead.' : !voice.ready.stt ? 'Push-to-talk is off: install a speech-to-text model in Settings → Voice. Type instead.' : null);
    const meter = h('span.ptt-meter', { 'aria-hidden': 'true' }, h('span'));
    const btn = h('button.btn.ptt', { type: 'button', disabled: !!reason, 'aria-describedby': 'ptt-help' }, h('span.ptt-dot', { 'aria-hidden': 'true' }), recorder ? 'Release to stop' : 'Hold to talk');
    const help = h('p.setting-note', { id: 'ptt-help' }, reason ?? 'Hold the button (or hold Space while it is focused) and speak, up to 30 seconds. You’ll see what was heard before anything is sent. Esc cancels.');
    let holding = false;
    const begin = async () => {
      if (holding || recorder) return; holding = true;
      try {
        recorder = await startRecording({ onLevel: (l) => { (meter.firstElementChild as HTMLElement).style.transform = `scaleX(${l.toFixed(2)})`; }, onLimit: () => void end() });
        if (!holding) { await end(); return; }
        el.classList.add('recording'); btn.lastChild!.textContent = 'Release to stop'; btn.setAttribute('aria-pressed', 'true');
      } catch (e) { holding = false; recorder = null; toast(`Microphone not available: ${(e as Error).message}`, 'warn'); }
    };
    const end = async () => {
      holding = false;
      const r = recorder; if (!r) return;
      recorder = null; el.classList.remove('recording');
      const wav = await r.stop();
      if (!wav) { paintCall(); return; }
      help.textContent = 'Transcribing on the office host…'; btn.disabled = true;
      try { pending = await voiceApi.transcribe(wav); } catch (e) { addLine('system', `Not transcribed: ${(e as Error).message}`); }
      paintCall();
    };
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); btn.setPointerCapture?.(e.pointerId); void begin(); });
    btn.addEventListener('pointerup', () => void end());
    btn.addEventListener('pointercancel', () => { cancelRecording(); holding = false; paintCall(); });
    btn.addEventListener('keydown', (e) => { if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); void begin(); } });
    btn.addEventListener('keyup', (e) => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); e.stopPropagation(); void end(); } });
    return h('div.phone-ptt', {}, h('div.sector-actions', {}, btn, meter), help);
  };

  /** CITY-03 first-launch choice, offered once: set up voice, or keep text. Nothing downloads from here. */
  const maybeOfferSetup = () => {
    if (store_(OFFERED_KEY) || !voice || voice.ready.stt) return;
    save(OFFERED_KEY, '1');
    addLine('system', 'Voice is optional. To talk instead of typing, open Settings → Voice and choose a speech model (each download shows its size and licence first). Text always works.');
  };

  paintList();
  paintIdle();
  voiceApi.state().then((s) => { voice = s; if (active) paintCall(); }, () => { voice = null; });
  queueMicrotask(() => list.querySelector<HTMLButtonElement>('.phone-contact')?.focus());
  return modal;
}
