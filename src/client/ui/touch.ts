import type { Action } from '../controls';
import type { PlayerController } from '../player';
import { NO_STICK, knobOffset, stickActions, type StickActions } from '../touch-input';
import { h, modalOpen, onModalChange } from './dom';

const MOVES = ['forward', 'backward', 'left', 'right', 'run'] as const satisfies readonly Action[];
/** A tap shorter than a frame would add and remove the jump key before the player sees it. */
const MIN_JUMP_HOLD_MS = 120;

const root = document.documentElement;
const coarse = window.matchMedia('(pointer: coarse)');

/** Whether touch controls are in use. Tests and tablets with a mouse can force it with ?touch=1 / ?touch=0. */
function touchWanted(): boolean {
  const force = new URLSearchParams(location.search).get('touch');
  if (force === '1') return true;
  if (force === '0') return false;
  return coarse.matches;
}

function isTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable || !!el.closest('.xterm');
}

export interface TouchControls {
  /** Release every held action (used when the game loses input). */
  release(): void;
}

/**
 * Landscape touch controls: a floating analog joystick on the left half, Jump / Use / View on the right.
 * Dragging the scene outside the controls orbits (third person) or looks around (first person).
 */
export function mountTouchControls(opts: { player: PlayerController; interact: () => void; changeView: () => void }): TouchControls {
  const { player } = opts;
  const paintMode = () => root.classList.toggle('ae-touch', touchWanted());
  paintMode();
  coarse.addEventListener?.('change', paintMode);

  // ---- Joystick -----------------------------------------------------------------------------------
  const knob = h('div.touch-stick-knob');
  const base = h('div.touch-stick-base', { 'aria-hidden': 'true' }, knob);
  const zone = h(
    'div.touch-stick-zone',
    { role: 'application', 'aria-label': 'Movement joystick. Touch and drag to walk; push to the edge to run.' },
    base,
  );
  let stick: { id: number; cx: number; cy: number; radius: number } | null = null;
  let held: StickActions = NO_STICK;

  const apply = (next: StickActions) => {
    for (const action of MOVES) if (next[action] !== held[action]) player.setAction(action, next[action]);
    held = next;
    root.dataset.stick = next.magnitude ? (next.run ? 'run' : 'walk') : 'rest';
  };
  const releaseStick = () => {
    stick = null;
    base.style.removeProperty('left');
    base.style.removeProperty('top');
    base.classList.remove('active', 'run');
    knob.style.transform = '';
    apply(NO_STICK);
  };
  zone.addEventListener('pointerdown', (e) => {
    if (stick || !player.enabled) return;
    e.preventDefault();
    zone.setPointerCapture?.(e.pointerId);
    const r = zone.getBoundingClientRect();
    const size = base.offsetWidth || 112;
    const radius = size / 2;
    // The base jumps under the thumb, but stays whole inside the zone.
    const cx = Math.min(Math.max(e.clientX, r.left + radius), r.right - radius);
    const cy = Math.min(Math.max(e.clientY, r.top + radius), r.bottom - radius);
    base.style.left = `${cx - r.left - radius}px`;
    base.style.top = `${cy - r.top - radius}px`;
    base.classList.add('active');
    stick = { id: e.pointerId, cx, cy, radius };
    move(e);
  });
  const move = (e: PointerEvent) => {
    if (!stick || e.pointerId !== stick.id) return;
    const dx = e.clientX - stick.cx, dy = e.clientY - stick.cy;
    const k = knobOffset(dx, dy, stick.radius);
    knob.style.transform = `translate(${k.x}px, ${k.y}px)`;
    const next = stickActions(dx, dy, stick.radius, held);
    base.classList.toggle('run', next.run);
    apply(next);
  };
  zone.addEventListener('pointermove', move);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
    zone.addEventListener(type, (e) => {
      if (stick && e.pointerId === stick.id) releaseStick();
    });

  // ---- Buttons -------------------------------------------------------------------------------------
  const button = (cls: string, label: string, text: string, icon: string) =>
    h(`button.touch-btn.${cls}` as 'button.x', { type: 'button', 'aria-label': label }, h('span.touch-icon', { 'aria-hidden': 'true' }, icon), h('span.touch-label', {}, text));
  const jump = button('touch-jump', 'Jump', 'Jump', '⤒');
  const use = button('touch-use', 'Interact with what is in front of you', 'Use', 'E');
  const view = button('touch-view', 'Switch camera view', 'View', '◐');
  // Touching a control must not focus it: a focused button would swallow keyboard input for the game.
  for (const b of [jump, use, view]) b.addEventListener('pointerdown', (e) => e.preventDefault());

  let jumpDown = 0;
  let jumpTimer = 0;
  const jumpPress = (e: PointerEvent) => {
    e.preventDefault();
    jump.setPointerCapture?.(e.pointerId);
    clearTimeout(jumpTimer);
    jumpDown = performance.now();
    jump.classList.add('down');
    player.setAction('jump', true);
  };
  const jumpRelease = () => {
    if (!jumpDown) return;
    jump.classList.remove('down');
    const wait = Math.max(0, MIN_JUMP_HOLD_MS - (performance.now() - jumpDown));
    jumpDown = 0;
    jumpTimer = window.setTimeout(() => player.setAction('jump', false), wait);
  };
  jump.addEventListener('pointerdown', jumpPress);
  for (const type of ['pointerup', 'pointercancel'] as const) jump.addEventListener(type, jumpRelease);
  // Keyboard / switch access: a click is a short jump.
  jump.addEventListener('click', (e) => {
    if ((e as PointerEvent).pointerType) return;
    player.setAction('jump', true);
    window.setTimeout(() => player.setAction('jump', false), MIN_JUMP_HOLD_MS);
  });
  use.addEventListener('click', () => opts.interact());
  view.addEventListener('click', () => opts.changeView());

  const actions = h('div.touch-actions', { role: 'group', 'aria-label': 'Touch actions' }, view, use, jump);
  const ui = h('div.touch-ui', {}, zone, actions);
  document.getElementById('hud')!.append(ui);

  // Portrait phones: ask to rotate. Pure CSS decides when it shows.
  document.getElementById('app')!.append(
    h(
      'div.rotate-hint',
      { role: 'status' },
      h('div.rotate-icon', { 'aria-hidden': 'true' }),
      h('strong', {}, 'Rotate your device'),
      h('span', {}, 'Agent Empire plays in landscape.'),
    ),
  );

  // ---- Hide while typing or while a window is open ---------------------------------------------------
  const release = () => {
    releaseStick();
    clearTimeout(jumpTimer);
    jumpDown = 0;
    jump.classList.remove('down');
    player.setAction('jump', false);
  };
  const paintTyping = () => {
    const typing = isTextEntry(document.activeElement);
    root.classList.toggle('ae-typing', typing);
    if (typing) release();
  };
  document.addEventListener('focusin', paintTyping);
  document.addEventListener('focusout', () => setTimeout(paintTyping, 0));
  onModalChange((open) => {
    root.classList.toggle('ae-modal', open);
    if (open) release();
  });
  root.classList.toggle('ae-modal', modalOpen());
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => document.hidden && release());
  return { release };
}
