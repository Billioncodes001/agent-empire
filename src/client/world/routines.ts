/**
 * Worker routines (LIFE-03): where a worker's body is and what it does, as a pure function of the
 * worker's REAL server state. Nothing here manufactures progress. A worker sits and types only
 * during a fresh, running agent turn; it takes a break only while the server says it is idle,
 * its turn has ended, or (LIFE-04, once the server sends it) it is waiting on another task. It never
 * walks around while its state is unknown, stale, offline or exited. Breaks never cost tokens:
 * this module only reads state and never sends anything.
 */
import type { AmenityKind, AmenitySpot } from './furnishing-layout';

export type Place = 'desk' | AmenityKind | 'away';
export type Activity =
  | 'typing' // fresh, running agent turn (the typingPose gate)
  | 'seated' // at the desk without typing evidence
  | 'attention' // needs input: at the desk, flagged
  | 'booting'
  | 'asleep' // offline or exited, as today
  | 'unknown' // evidence is stale or the status is not recognised
  | 'break'; // at an amenity because the real state is idle, done or waiting

/** Reserved for LIFE-04: the task this worker's task depends on. Not sent by the server yet. */
export interface WaitingOn {
  id?: string;
  name: string;
}

export interface RoutineInput {
  /** Stable worker id; seeds the per-worker amenity choice. */
  id: string;
  status: string;
  processState?: string;
  /** False while the server's evidence is stale: the status is only last-known. */
  fresh: boolean;
  /** typingPose(): fresh, agent, working and processState 'running'. */
  typing: boolean;
  waitingOn?: WaitingOn;
  /** When this client first observed the current status (ms, same clock as `now`). */
  since: number;
  now: number;
}

export interface RoutinePlan {
  place: Place;
  activity: Activity;
  /** Shown on the worker's name card; '' when at the desk doing what the status bubble already says. */
  reason: string;
}

/** An idle or finished worker stays at the desk this long first, so a quick reply does not send it walking. */
export const BREAK_AFTER_MS = 6_000;
/** A long idle spell moves on to the next amenity this often. */
export const ROTATE_MS = 12 * 60_000;
export const AMENITY_ORDER: readonly AmenityKind[] = ['coffee', 'cafeteria', 'gym'];
const AMENITY_LABEL: Record<AmenityKind, string> = { coffee: 'on a coffee break', cafeteria: 'at the cafeteria', gym: 'at the gym' };

/** FNV-1a, so the same worker id always picks the same amenity on every client. */
export function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The amenity for this break: seeded by the worker id and the break's start, fixed for the whole
 * break, advancing one step every ROTATE_MS of a long break. Never random per frame.
 */
export function amenityFor(id: string, since: number, now: number): AmenityKind {
  const step = stableHash(id) + Math.floor(since / ROTATE_MS) + Math.floor(Math.max(0, now - since) / ROTATE_MS);
  return AMENITY_ORDER[step % AMENITY_ORDER.length];
}

const desk = (activity: Activity, reason = ''): RoutinePlan => ({ place: 'desk', activity, reason });

export function planRoutine(i: RoutineInput): RoutinePlan {
  // No live evidence: show the last known worker where it was placed, never walking around.
  if (!i.fresh) return desk('unknown', 'Status unknown — shown at desk');
  switch (i.status) {
    case 'working':
      return i.typing ? desk('typing') : desk('seated', 'Working — process not confirmed running');
    case 'starting':
      return desk('booting');
    case 'needs_input':
      return desk('attention', 'Needs you');
    case 'offline':
    case 'exited':
      return desk('asleep');
    case 'idle':
    case 'done': {
      if (i.waitingOn) {
        const amenity = amenityFor(i.id, i.since, i.now);
        return { place: amenity, activity: 'break', reason: `Waiting on ${i.waitingOn.name} — ${AMENITY_LABEL[amenity]}` };
      }
      if (i.now - i.since < BREAK_AFTER_MS) return desk('seated');
      const amenity = amenityFor(i.id, i.since, i.now);
      return { place: amenity, activity: 'break', reason: `${i.status === 'done' ? 'Turn finished' : 'Idle'} — ${AMENITY_LABEL[amenity]}` };
    }
    default:
      return desk('unknown', 'Status unknown — shown at desk');
  }
}

/** True when the plan keeps the body at the desk and a state change must never be walked out. */
export const staysPut = (plan: RoutinePlan) => plan.activity === 'unknown' || plan.activity === 'asleep';

/**
 * A free spot of `kind`, starting from the worker's own preference so each worker has a usual
 * place, skipping spots other workers hold. Returns undefined when every spot is taken (the worker
 * then waits at its desk).
 */
export function pickSpot(spots: readonly AmenitySpot[], kind: AmenityKind, seed: number, taken: ReadonlySet<string>): AmenitySpot | undefined {
  const of = spots.filter((s) => s.kind === kind);
  for (let k = 0; k < of.length; k++) {
    const spot = of[(seed + k) % of.length];
    if (!taken.has(spot.id)) return spot;
  }
  return undefined;
}
