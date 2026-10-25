/**
 * CHAR-02: which clip a body plays, as a pure function of its state, so every phase and every fallback is testable.
 *
 * Extra clips come from the CC0 Quaternius Universal Animation Library, retargeted onto the Rocketbox rigs
 * (tools/avatars/build-clips.mts) and loaded lazily after the body. Until they arrive, when they fail to download,
 * under Save-Data and under reduced motion, every state falls back to the CHAR-01 behaviour: the held run-flight
 * frame in the air, a procedural landing dip and the chair sit at the wheel.
 */
/** Clips shipped in clips-extra-{male,female}.glb. */
export const EXTRA_CLIPS = ['jump_start', 'jump_air', 'jump_land', 'drive_seated'] as const;
/** The held run frame used as the airborne pose when there is no jump clip (see Human). */
export const FLIGHT = 'airborne_flight';
/** Walk → run above this speed (m/s); run → walk below RUN_EXIT. The gap stops flicker at the boundary. */
export const RUN_ENTER = 2.7;
export const RUN_EXIT = 2.3;
/** CHAR-01: turning on the spot faster than this (rad/s) steps the feet with a slow walk instead of spinning the idle. */
export const TURN_STEP = 2.5;
/** A jump counts as taking off for this long while still rising (s); jump_start is trimmed to about this length. */
export const TAKEOFF_TIME = 0.4;
/** Stairs: grounded vertical speed (m/s) above which a moving body is climbing, and below which it has stopped. */
export const STAIRS_ENTER = 0.35;
export const STAIRS_EXIT = 0.12;

export type JumpPhase = 'takeoff' | 'air' | 'land' | null;
export type Stairs = 'up' | 'down' | null;

/** Which recorded clip a grounded, standing body plays at this speed, with hysteresis between walk and run. */
export function locomotionClip(speed: number, previous: string, turnRate = 0): 'idle_neutral_01' | 'walk_neutral' | 'run_neutral' {
  if (speed <= 0.08) return Math.abs(turnRate) > TURN_STEP ? 'walk_neutral' : 'idle_neutral_01';
  return (previous === 'run_neutral' ? speed > RUN_EXIT : speed > RUN_ENTER) ? 'run_neutral' : 'walk_neutral';
}

/**
 * Jump phase: a take-off while a flight that began rising is still in its first TAKEOFF_TIME and rising, then the
 * airborne loop; after touchdown, the landing for as long as `landing` (s) remains. A fall from a ledge never rose,
 * so it goes straight to the airborne pose.
 */
export function jumpPhase(s: { flying: boolean; airTime: number; vy: number; landing: number }): JumpPhase {
  if (s.flying) return s.airTime < TAKEOFF_TIME && s.vy > 0.5 ? 'takeoff' : 'air';
  return s.landing > 0 ? 'land' : null;
}

/** Stairs from a grounded body's ground speed and smoothed vertical speed, with hysteresis between steps. */
export function stairsState(previous: Stairs, speed: number, vy: number): Stairs {
  if (speed < 0.3) return null;
  const limit = previous ? STAIRS_EXIT : STAIRS_ENTER;
  if (vy > limit && previous !== 'down') return 'up';
  if (vy < -limit && previous !== 'up') return 'down';
  if (Math.abs(vy) > limit) return vy > 0 ? 'up' : 'down';
  return null;
}

export interface MotionInput {
  speed: number;
  previous: string;
  turnRate: number;
  seated: boolean;
  driving: boolean;
  /** A scripted transition clip (sitting down at a desk or into a car) pinned by its caller. */
  transition: string | null;
  jump: JumpPhase;
  stairs: Stairs;
  reducedMotion: boolean;
  /** Whether this body has an action for the clip (extra clips arrive late or not at all). */
  has(name: string): boolean;
}

/** The clip to play now. Never names a clip the body lacks; the last resort is the idle, never a bind (T) pose. */
export function selectMotion(s: MotionInput): string {
  const or = (name: string, fallback: string) => (s.has(name) ? name : fallback);
  const ground = () => locomotionClip(s.speed, s.previous, s.turnRate);
  if (s.transition) return or(s.transition, 'idle_neutral_01');
  if (s.seated || s.driving) return s.driving ? or('drive_seated', 'sit_chair_idle_neutral_01') : 'sit_chair_idle_neutral_01';
  // Reduced motion keeps the calm CHAR-01 jump: the held stride frame and the small procedural dip.
  const extra = !s.reducedMotion;
  if (s.jump === 'takeoff' || s.jump === 'air') {
    const clip = extra ? (s.jump === 'takeoff' ? or('jump_start', or('jump_air', FLIGHT)) : or('jump_air', FLIGHT)) : FLIGHT;
    return s.has(clip) ? clip : ground();
  }
  // A landing crouch plays standing still; moving on returns to the stride at once.
  if (s.jump === 'land' && extra && s.speed <= 0.5 && s.has('jump_land')) return 'jump_land';
  // No stair clip exists in the free libraries: the stride plays, with a lean layer and foot IK (Human).
  return ground();
}
