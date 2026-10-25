/**
 * CHAR-01: basic gamepad support (standard mapping), behind feature detection. The pad drives the same actions as the
 * keyboard through PlayerController.setAction, so remapped keys keep working.
 *
 *   Left stick / d-pad  move (full deflection runs)    Right stick  camera
 *   A (0)  jump / climb      B (1), LT (6)  run, accelerate or descend
 *   X (2)  use               Y (3)  first / third person
 *   Back (8)  map            Start (9)  menu
 */
import { stickActions, NO_STICK } from './touch-input';

export interface PadState { axes: readonly number[]; buttons: readonly { pressed: boolean; value: number }[] }
export interface PadActions {
  forward: boolean; backward: boolean; left: boolean; right: boolean; run: boolean; jump: boolean;
  interact: boolean; camera: boolean; map: boolean; menu: boolean;
  /** Right stick after its dead zone, −1..1. */
  lookX: number; lookY: number;
}
export const NO_PAD: PadActions = { forward: false, backward: false, left: false, right: false, run: false, jump: false, interact: false, camera: false, map: false, menu: false, lookX: 0, lookY: 0 };
const DEAD = 0.18;

/** `mode` 'fly': the run action means descend there, so only B or LT hold it, never a full stick push (review 3). */
export function gamepadActions(pad: PadState | null | undefined, prev: PadActions = NO_PAD, mode: 'walk' | 'drive' | 'fly' = 'walk'): PadActions {
  if (!pad) return NO_PAD;
  const b = (i: number) => !!pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.5);
  const a = (i: number) => pad.axes[i] ?? 0;
  // The left stick reuses the touch stick's 8-way mapping with hysteresis; a radius of 1 is full deflection.
  const stick = stickActions(a(0), a(1), 1, { ...NO_STICK, forward: prev.forward, backward: prev.backward, left: prev.left, right: prev.right, run: prev.run && !b(1) && !b(6) });
  const look = (v: number) => (Math.abs(v) < DEAD ? 0 : (Math.sign(v) * (Math.abs(v) - DEAD)) / (1 - DEAD));
  return {
    forward: stick.forward || b(12), backward: stick.backward || b(13), left: stick.left || b(14), right: stick.right || b(15),
    run: (stick.run && mode !== 'fly') || b(1) || b(6),
    jump: b(0), interact: b(2), camera: b(3), map: b(8), menu: b(9),
    lookX: look(a(2)), lookY: look(a(3)),
  };
}

type Held = 'forward' | 'backward' | 'left' | 'right' | 'run' | 'jump';
const HELD: Held[] = ['forward', 'backward', 'left', 'right', 'run', 'jump'];
export interface GamepadTarget {
  setAction(action: Held, pressed: boolean): void;
  lookBy(dx: number, dy: number): void;
  readonly enabled: boolean;
}
/**
 * Polls the pad once a frame (call `update` from the render loop). Does nothing without the Gamepad API or before a
 * pad connects. `blocked()` (a window open, text being typed) releases everything held.
 */
export function mountGamepad(opts: { player: GamepadTarget; interact(): void; changeView(): void; openMap(): void; openMenu(): void; blocked(): boolean; flying(): boolean }) {
  // Review 6: a pad connected before the page loaded fires no event; look for it now.
  let connected = !!readPad(), prev: PadActions = NO_PAD;
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
    window.addEventListener('gamepadconnected', () => { connected = true; document.documentElement.classList.add('ae-gamepad'); });
    window.addEventListener('gamepaddisconnected', () => { connected = !!readPad(); if (!connected) { release(); document.documentElement.classList.remove('ae-gamepad'); } });
  }
  const release = () => {
    for (const a of HELD) if (prev[a]) opts.player.setAction(a, false);
    prev = NO_PAD;
  };
  return {
    get connected() { return connected; },
    update(dt: number) {
      if (!connected) return;
      if (opts.blocked() || !opts.player.enabled) { release(); return; }
      const next = gamepadActions(readPad(), prev, opts.flying() ? 'fly' : 'walk');
      for (const a of HELD) if (next[a] !== prev[a]) opts.player.setAction(a, next[a]);
      if (next.interact && !prev.interact) opts.interact();
      if (next.camera && !prev.camera) opts.changeView();
      if (next.map && !prev.map) opts.openMap();
      if (next.menu && !prev.menu) opts.openMenu();
      if (next.lookX || next.lookY) opts.player.lookBy(next.lookX * 2.6 * dt, next.lookY * 1.6 * dt);
      prev = next;
    },
    release,
  };
}

/** The first connected pad, or null (also when the Gamepad API is missing). */
export function readPad(): PadState | null {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
  for (const p of navigator.getGamepads()) if (p && p.connected) return p;
  return null;
}
