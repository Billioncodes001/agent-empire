import { DEFAULT_KEYS, ACTION_LABELS, keyLabel, validKey, type Action } from '../controls';
import type { Settings, ViewMode } from '../state';
import { GRAPHICS, type GraphicsQuality } from '../graphics';
import { h, openModal } from './dom';

const VIEWS: [ViewMode, string, string][] = [
  ['first', '👀 First person', 'See through your own eyes. Direction keys turn your body and view toward your movement. Click the scene for mouse look and interactions. Esc frees the mouse.'],
  ['third', '🎥 Third person', 'Follows your character’s turns while you walk. Drag to look around; following resumes after you release. Scroll to zoom. The First person button switches to eye level.'],
];

export function openSettings(
  settings: Settings,
  onChange: (s: Settings) => void,
  onCharacter: () => void,
  previewSound: () => void,
  section?: { el: HTMLElement; dispose(): void },
) {
  const seg = h('div.seg', { role: 'radiogroup', 'aria-label': 'Camera view' });
  const note = h('p.setting-note');
  const paint = () => {
    seg.replaceChildren(
      ...VIEWS.map(([view, label]) =>
        h(
          'button.btn',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(settings.view === view),
            class: settings.view === view ? 'on' : '',
            onclick: () => {
              if (settings.view === view) return;
              settings = { ...settings, view };
              onChange(settings);
              paint();
            },
          },
          label,
        ),
      ),
    );
    note.textContent = VIEWS.find(([v]) => v === settings.view)![2];
  };
  paint();

  const quality = h('div.quality-options', { role: 'radiogroup', 'aria-label': 'Graphics quality' });
  const paintQuality = () => quality.replaceChildren(...(Object.keys(GRAPHICS) as GraphicsQuality[]).map(value => {
    const profile = GRAPHICS[value];
    return h('button.quality-option', { type: 'button', role: 'radio', 'aria-checked': String(settings.quality === value), onclick: () => {
      if (settings.quality === value) return;
      settings = { ...settings, quality: value }; onChange(settings); paintQuality();
    } }, h('strong', {}, profile.label), h('span', {}, profile.description));
  }));
  paintQuality();
  const volume = h('input' , { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'World sounds volume' });
  const pct = h('span.vol-pct');
  const mute = h('button.btn', { type: 'button' });
  const soundRow = h('div.volume', {}, mute, volume, pct);
  const paintSound = () => {
    const level = Math.round(settings.volume * 100);
    volume.value = String(level);
    volume.style.setProperty('--fill', `${level}%`);
    pct.textContent = settings.muted ? 'Muted' : `${level}%`;
    mute.textContent = settings.muted ? '🔊 Unmute' : '🔇 Mute';
    mute.setAttribute('aria-pressed', String(settings.muted));
    mute.classList.toggle('danger', settings.muted);
    soundRow.classList.toggle('muted', settings.muted);
  };
  paintSound();
  // Dragging the slider turns sound back on; letting go plays a sample at the new level.
  volume.addEventListener('input', () => {
    settings = { ...settings, volume: Number(volume.value) / 100, muted: false };
    onChange(settings);
    paintSound();
  });
  volume.addEventListener('change', previewSound);
  mute.addEventListener('click', () => {
    settings = { ...settings, muted: !settings.muted };
    onChange(settings);
    paintSound();
    if (!settings.muted) previewSound();
  });

  const keyRows = h('div.key-bindings');
  const keyNote = h('p.setting-note', {}, 'Select a control, then press a key. Conflicting controls swap automatically. Escape cancels.');
  const paintKeys = () => {
    keyRows.replaceChildren(...(Object.keys(DEFAULT_KEYS) as Action[]).map(action => {
      const button = h('button.btn', { type: 'button', 'aria-label': `Remap ${ACTION_LABELS[action]}` }, keyLabel(settings.keys[action]));
      button.addEventListener('click', () => { button.textContent = 'Press a key…'; button.dataset.listening = 'true'; });
      button.addEventListener('keydown', e => {
        if (!button.dataset.listening) return;
        e.preventDefault(); e.stopPropagation();
        if (e.code === 'Escape') { delete button.dataset.listening; button.textContent = keyLabel(settings.keys[action]); return; }
        if (e.metaKey || e.ctrlKey || e.altKey || !validKey(e.code)) { keyNote.textContent = 'Use letters, numbers, arrows, Shift, or Space.'; return; }
        const keys = { ...settings.keys };
        const duplicate = (Object.keys(keys) as Action[]).find(a => keys[a] === e.code);
        if (duplicate) keys[duplicate] = keys[action];
        keys[action] = e.code;
        settings = { ...settings, keys }; onChange(settings); paintKeys();
      });
      button.addEventListener('blur', () => { delete button.dataset.listening; button.textContent = keyLabel(settings.keys[action]); });
      return h('div.key-row', {}, h('span', {}, ACTION_LABELS[action]), button);
    }));
  };
  paintKeys();
  const resetKeys = h('button.btn', { type: 'button', onclick: () => { settings = { ...settings, keys: { ...DEFAULT_KEYS } }; onChange(settings); paintKeys(); } }, 'Restore arrow-key defaults');

  const character = h('button.btn', { type: 'button' }, '🧍 Change your look & name');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const el = h(
    'div.modal',
    { role: 'dialog', 'aria-label': 'Settings' },
    h('header', {}, h('h2', {}, '⚙️ Settings'), close),
    h(
      'div.body',
      {},
      h('label', {}, 'Graphics quality'), quality,
      h('p.setting-note', {}, 'Changes apply immediately and are saved on this device. Character controls and city progress are unchanged.'),
      h('label', {}, 'Camera view'),
      seg,
      note,
      h('label', { style: 'margin-top:18px' }, 'World sounds'),
      soundRow,
      h('p.setting-note', {}, 'Footsteps, car engine and road noise, doors, office ambience, and worker alerts. Vehicle sound changes with speed and camera view. Voice chat isn’t affected.'),
      h('label', { style: 'margin-top:18px' }, 'Keyboard controls'), keyNote, keyRows, resetKeys,
      h('label', { style: 'margin-top:18px' }, 'Your character'),
      character,
      section?.el,
    ),
  );
  const modal = openModal(el, { onClose: () => section?.dispose() });
  close.addEventListener('click', () => modal.close());
  character.addEventListener('click', () => {
    modal.close();
    onCharacter();
  });
}
