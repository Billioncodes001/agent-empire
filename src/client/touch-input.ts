/**
 * Pure mapping from a virtual joystick deflection to the existing movement actions.
 * The stick drives the same actions as the keyboard (forward/backward/left/right/run),
 * so remapped keys and desktop input are untouched.
 */
export interface StickActions {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  run: boolean;
  /** Deflection 0..1 after clamping to the base radius. */
  magnitude: number;
}

export const STICK = {
  /** Below this deflection the stick is at rest. */
  dead: 0.18,
  /** Pushed this far (or further) the character runs; released below `walkBack`. */
  run: 0.8,
  walkBack: 0.72,
  /** A direction component switches on above `on` and back off below `off` (8-way with hysteresis). */
  on: 0.42,
  off: 0.3,
} as const;

export const NO_STICK: StickActions = { forward: false, backward: false, left: false, right: false, run: false, magnitude: 0 };

/** `dx`, `dy` are screen pixels from the stick centre (down is positive); `radius` is the full-deflection distance. */
export function stickActions(dx: number, dy: number, radius: number, prev: StickActions = NO_STICK): StickActions {
  const len = Math.hypot(dx, dy);
  const magnitude = radius > 0 ? Math.min(1, len / radius) : 0;
  if (magnitude < STICK.dead || len === 0) return { ...NO_STICK, magnitude };
  const ux = dx / len;
  const uy = dy / len;
  const axis = (value: number, was: boolean) => value > (was ? STICK.off : STICK.on);
  const run = magnitude >= (prev.run ? STICK.walkBack : STICK.run);
  return {
    forward: axis(-uy, prev.forward),
    backward: axis(uy, prev.backward),
    left: axis(-ux, prev.left),
    right: axis(ux, prev.right),
    run,
    magnitude,
  };
}

/** The knob offset, clamped inside the base. */
export function knobOffset(dx: number, dy: number, radius: number): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  if (len <= radius || len === 0) return { x: dx, y: dy };
  return { x: (dx / len) * radius, y: (dy / len) * radius };
}
