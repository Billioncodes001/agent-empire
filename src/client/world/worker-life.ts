/**
 * Runtime side of LIFE-03: moves each HQ worker between its desk and the office amenities
 * according to planRoutine() (routines.ts), which reads only the worker's real server state.
 * Workers stand up, walk the aisles on a nav grid, use a spot, and walk back to sit down before
 * they type. Typing is only ever shown seated at the desk. Unknown, stale, offline or exited
 * workers are placed at the desk without walking, and prefers-reduced-motion places everyone
 * directly (no walking animation). Nothing here sends a message or spends tokens.
 */
import * as THREE from 'three';
import type { Worker } from './character';
import type { DeskView, Office } from './office';
import type { HumanActivity } from './human';
import { AMENITY_SPOTS, type AmenitySpot } from './furnishing-layout';
import { buildNavGrid, deskPoints } from './office-nav';
import type { NavGrid, Point } from './navgrid';
import { BREAK_AFTER_MS, pickSpot, planRoutine, stableHash, staysPut, type RoutinePlan, type WaitingOn } from './routines';

export interface LifeInput {
  status: string;
  processState?: string;
  fresh: boolean;
  /** typingPose() for this worker. */
  typing: boolean;
  waitingOn?: WaitingOn;
}

type Phase = 'seated' | 'standUp' | 'walk' | 'enterSpot' | 'using' | 'leaveSpot' | 'sitDown';
type Goal = { kind: 'desk' } | { kind: 'spot'; spot: AmenitySpot };

const WALK_SPEED = 1.3;
const STAND_TIME = 1.7;
const SIT_TIME = 1.9;
const SPOT_TIME = 0.6;
const PLAN_EVERY = 0.25;
const CHAIR_HOME = { z: 0.9, rot: 0 };
const CHAIR_OUT = { z: 1.12, rot: 0.45 };
const ACTIVITY: Record<AmenitySpot['pose'], HumanActivity> = { stand: 'coffee', sit: 'eat', treadmill: 'none', bike: 'bike', weights: 'weights', stretch: 'stretch' };

interface Life {
  id: string;
  worker: Worker;
  desk: DeskView;
  input: LifeInput;
  status: string;
  since: number;
  plan: RoutinePlan;
  goal: Goal;
  phase: Phase;
  /** 0..1 within a timed phase (standing up, sitting down, stepping on or off a spot). */
  u: number;
  /** Leaving a chair: already stood up, now stepping aside. */
  stood: boolean;
  path: Point[];
  /** Where the current step onto a spot started. */
  from: Point;
  /** The spot the body is on, entering or leaving. */
  spot?: AmenitySpot;
  typing: boolean;
  planTimer: number;
}

const _dir = new THREE.Vector3();
const angleTo = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export class OfficeLife {
  private lives = new Map<string, Life>();
  private grid?: NavGrid;
  constructor(
    private office: Office,
    private opts: { reducedMotion: () => boolean; detail: () => boolean; onTyping: (id: string, typing: boolean) => void },
  ) {}

  /** Walkable floor: the layout plus every live collider between ankle and head height on this floor. */
  private nav(): NavGrid {
    if (!this.grid) {
      const y = this.office.group.position.y;
      this.grid = buildNavGrid(this.office.colliders.filter((c) => (c.bottom ?? y) - y < 1.7 && c.top - y > 0.05));
    }
    return this.grid;
  }

  /** Apply the worker's server state (or a freshness change). */
  sync(id: string, worker: Worker, desk: DeskView, input: LifeInput, now = performance.now()) {
    let life = this.lives.get(id);
    if (life && (life.worker !== worker || life.desk !== desk)) {
      this.remove(id);
      life = undefined;
    }
    if (!life) {
      // First sight: how long it has been idle is unknown, so treat the state as settled and
      // place the body where that state puts it, without a walk.
      life = { id, worker, desk, input, status: input.status, since: now - BREAK_AFTER_MS, plan: { place: 'desk', activity: 'seated', reason: '' },
        goal: { kind: 'desk' }, phase: 'seated', u: 0, stood: false, path: [], from: { x: 0, z: 0 }, typing: false, planTimer: PLAN_EVERY };
      this.lives.set(id, life);
      this.replan(life, now);
      if (life.goal.kind === 'spot') this.teleport(life);
    } else {
      if (input.status !== life.status) {
        life.status = input.status;
        life.since = now;
      }
      life.input = input;
      this.replan(life, now);
    }
    this.applyTyping(life);
  }

  remove(id: string) {
    const life = this.lives.get(id);
    if (!life) return;
    this.chair(life, 0);
    if (life.typing) this.opts.onTyping(id, false);
    this.lives.delete(id);
  }

  /** Where each worker is and why, for the debug handle and headless checks. */
  snapshot() {
    return [...this.lives.values()].map((l) => ({ id: l.id, phase: l.phase, place: l.plan.place, activity: l.plan.activity, reason: l.plan.reason, spot: l.spot?.id ?? null, typing: l.typing }));
  }

  /** Spots other workers are on or heading to. */
  private taken(except: Life): Set<string> {
    const out = new Set<string>();
    for (const l of this.lives.values()) {
      if (l === except) continue;
      if (l.spot) out.add(l.spot.id);
      if (l.goal.kind === 'spot') out.add(l.goal.spot.id);
    }
    return out;
  }

  private replan(life: Life, now: number) {
    const { input } = life;
    const plan = planRoutine({ id: life.id, status: input.status, processState: input.processState, fresh: input.fresh, typing: input.typing, waitingOn: input.waitingOn, since: life.since, now });
    life.plan = plan;
    let goal: Goal = { kind: 'desk' };
    if (plan.place !== 'desk' && plan.place !== 'away') {
      const kind = plan.place;
      // Keep the spot already chosen for this amenity; otherwise this worker's usual free one.
      const kept = life.goal.kind === 'spot' && life.goal.spot.kind === kind ? life.goal.spot : life.spot?.kind === kind ? life.spot : undefined;
      const spot = kept ?? pickSpot(AMENITY_SPOTS, kind, stableHash(life.id), this.taken(life));
      if (spot) goal = { kind: 'spot', spot };
    }
    const changed = goal.kind !== life.goal.kind || (goal.kind === 'spot' && life.goal.kind === 'spot' && goal.spot !== life.goal.spot);
    life.goal = goal;
    // Unknown, asleep, or reduced motion: no walking. Put the body where the state says, now.
    if (changed && (staysPut(plan) || this.opts.reducedMotion())) this.teleport(life);
    else if (changed && life.phase === 'walk') this.route(life);
    this.label(life);
  }

  private label(life: Life) {
    const { plan, phase, goal } = life;
    const text = plan.place !== 'desk' ? plan.reason : phase !== 'seated' && goal.kind === 'desk' ? `Back to the desk${plan.reason ? ` — ${plan.reason.toLowerCase()}` : ''}` : '';
    life.worker.setReason(text);
  }

  private applyTyping(life: Life) {
    const typing = life.input.typing && life.phase === 'seated' && life.goal.kind === 'desk';
    life.worker.typing = typing;
    if (typing !== life.typing) {
      life.typing = typing;
      this.opts.onTyping(life.id, typing);
    }
  }

  /** Place the body directly at its goal, already settled. */
  private teleport(life: Life) {
    const m = life.worker.motion;
    m.transition = null;
    m.speed = 0;
    life.stood = false;
    if (life.goal.kind === 'desk') {
      life.spot = undefined;
      this.seatAtDesk(life);
    } else {
      life.spot = life.goal.spot;
      this.toOffice(life);
      this.settleOnSpot(life, life.goal.spot);
      this.chair(life, 1);
    }
    this.applyTyping(life);
    this.label(life);
  }

  private seatAtDesk(life: Life) {
    const root = life.worker.root, m = life.worker.motion;
    life.desk.group.add(root);
    root.position.set(0, 0, 0.93);
    root.rotation.set(0, Math.PI, 0);
    m.seated = true;
    m.activity = 'none';
    m.transition = null;
    m.speed = 0;
    life.phase = 'seated';
    life.path = [];
    this.chair(life, 0);
  }

  private settleOnSpot(life: Life, spot: AmenitySpot) {
    const root = life.worker.root, m = life.worker.motion;
    root.position.set(spot.x, spot.y, spot.z);
    root.rotation.set(0, spot.rotY + Math.PI, 0);
    m.transition = null;
    m.seated = spot.pose === 'sit' || spot.pose === 'bike';
    // Treadmill: the walk cycle plays in place on the belt.
    m.speed = spot.pose === 'treadmill' ? 1.25 : 0;
    m.activity = ACTIVITY[spot.pose];
    m.detail = this.opts.detail();
    life.phase = 'using';
  }

  /** Move the body from its desk group into office coordinates, keeping where it stands and which way it faces. */
  private toOffice(life: Life) {
    const root = life.worker.root;
    if (root.parent === this.office.group) return;
    root.getWorldDirection(_dir);
    this.office.group.attach(root);
    root.rotation.set(0, Math.atan2(_dir.x, _dir.z), 0);
  }

  /** Slide the desk chair out (1) or home (0). */
  private chair(life: Life, out: number) {
    const c = life.desk.chair;
    c.position.z = THREE.MathUtils.lerp(CHAIR_HOME.z, CHAIR_OUT.z, out);
    c.rotation.y = THREE.MathUtils.lerp(CHAIR_HOME.rot, CHAIR_OUT.rot, out);
  }

  /**
   * Waypoints from where the body stands to its goal: out behind the chair if it is at its desk,
   * along the aisles, and on to the spot's approach, or back to the aisle behind its own chair and
   * in to the seat.
   */
  private route(life: Life) {
    const p = life.worker.root.position;
    const { seat, exit } = deskPoints(life.desk.def);
    const atSeat = life.worker.root.parent === this.office.group && Math.hypot(p.x - seat.x, p.z - seat.z) < 0.35;
    const start = atSeat ? exit : { x: p.x, z: p.z };
    const target = life.goal.kind === 'desk' ? exit : life.goal.spot.approach;
    const path = this.nav().findPath(start, target) ?? [target];
    if (atSeat) path.unshift(exit);
    if (life.goal.kind === 'desk') path.push(seat);
    life.path = path;
    life.phase = 'walk';
  }

  update(dt: number, now = performance.now()) {
    for (const life of this.lives.values()) {
      life.planTimer -= dt;
      if (life.planTimer <= 0) {
        life.planTimer = PLAN_EVERY;
        this.replan(life, now);
      }
      const before = life.phase;
      this.step(life, dt);
      if (life.phase !== before) this.label(life);
      this.applyTyping(life);
    }
  }

  private step(life: Life, dt: number) {
    const m = life.worker.motion, root = life.worker.root, goal = life.goal;
    switch (life.phase) {
      case 'seated':
        if (goal.kind === 'spot') {
          life.phase = 'standUp';
          life.u = 0;
        }
        break;
      case 'standUp':
        // At the desk: stand up and roll the chair back.
        life.u = Math.min(1, life.u + dt / STAND_TIME);
        m.transition = 'sit_stand_up_chair_01';
        m.progress = life.u;
        m.seated = false;
        m.activity = 'none';
        this.chair(life, THREE.MathUtils.smoothstep(life.u, 0.1, 0.6));
        if (life.u >= 1) {
          m.transition = null;
          if (goal.kind === 'desk') {
            life.phase = 'sitDown';
            life.u = 0;
          } else {
            this.toOffice(life);
            this.route(life);
          }
        }
        break;
      case 'walk': {
        m.transition = null;
        m.seated = false;
        m.activity = 'none';
        const next = life.path[0];
        if (!next) {
          this.arrive(life);
          break;
        }
        const p = root.position, dx = next.x - p.x, dz = next.z - p.z, d = Math.hypot(dx, dz);
        if (d > 1e-4) {
          const turn = angleTo(root.rotation.y, Math.atan2(dx, dz));
          root.rotation.y += turn * (1 - Math.exp(-dt * 9));
          // Ease off into sharp corners, so feet don't skate while the body turns.
          const speed = WALK_SPEED * THREE.MathUtils.clamp(1.15 - Math.abs(turn) / 1.6, 0.25, 1);
          m.speed = speed;
          const stepLen = speed * dt;
          if (d > stepLen) {
            p.x += (dx / d) * stepLen;
            p.z += (dz / d) * stepLen;
            p.y = 0;
            break;
          }
        }
        p.set(next.x, 0, next.z);
        life.path.shift();
        break;
      }
      case 'enterSpot': {
        const spot = life.spot!;
        life.u = Math.min(1, life.u + dt / SPOT_TIME);
        const k = THREE.MathUtils.smoothstep(life.u, 0, 1);
        root.position.set(THREE.MathUtils.lerp(life.from.x, spot.x, k), spot.pose === 'sit' ? 0 : spot.y * k, THREE.MathUtils.lerp(life.from.z, spot.z, k));
        root.rotation.y += angleTo(root.rotation.y, spot.rotY + Math.PI) * (1 - Math.exp(-dt * 8));
        m.speed = life.u < 1 ? 0.6 : 0;
        if (life.u >= 1) {
          root.rotation.y = spot.rotY + Math.PI;
          if (spot.pose === 'sit') {
            m.speed = 0;
            life.phase = 'sitDown';
            life.u = 0;
          } else this.settleOnSpot(life, spot);
        }
        break;
      }
      case 'using':
        m.detail = this.opts.detail();
        if (goal.kind !== 'spot' || goal.spot !== life.spot) {
          life.phase = 'leaveSpot';
          life.u = 0;
          life.stood = life.spot?.pose !== 'sit';
        }
        break;
      case 'leaveSpot': {
        const spot = life.spot!;
        m.activity = 'none';
        m.seated = false;
        if (!life.stood) {
          // Stand up from the chair first.
          life.u = Math.min(1, life.u + dt / STAND_TIME);
          m.transition = 'sit_stand_up_chair_01';
          m.progress = life.u;
          if (life.u >= 1) {
            m.transition = null;
            life.stood = true;
            life.u = 0;
          }
          break;
        }
        // Step off the equipment (or aside from the chair) to the approach point.
        life.u = Math.min(1, life.u + dt / SPOT_TIME);
        m.speed = life.u < 1 ? 0.6 : 0;
        const k = THREE.MathUtils.smoothstep(life.u, 0, 1);
        root.position.set(THREE.MathUtils.lerp(spot.x, spot.approach.x, k), spot.pose === 'sit' ? 0 : spot.y * (1 - k), THREE.MathUtils.lerp(spot.z, spot.approach.z, k));
        if (life.u >= 1) {
          life.spot = undefined;
          life.stood = false;
          this.route(life);
        }
        break;
      }
      case 'sitDown': {
        life.u = Math.min(1, life.u + dt / SIT_TIME);
        m.transition = 'sit_down_chair_01';
        m.progress = life.u;
        m.speed = 0;
        m.activity = 'none';
        const atDesk = !life.spot;
        if (atDesk) this.chair(life, 1 - THREE.MathUtils.smoothstep(life.u, 0.4, 0.95));
        if (life.u >= 1) {
          m.transition = null;
          if (!atDesk) this.settleOnSpot(life, life.spot!);
          else if (goal.kind === 'desk') this.seatAtDesk(life);
          else {
            // The state changed back while sitting down: get up again.
            m.seated = true;
            life.phase = 'standUp';
            life.u = 0;
          }
        }
        break;
      }
    }
  }

  private arrive(life: Life) {
    const m = life.worker.motion, root = life.worker.root;
    m.speed = 0;
    if (life.goal.kind === 'desk') {
      // At the seat, facing the desk (the way the last leg walked): sit down in the desk's own frame.
      life.desk.group.add(root);
      root.position.set(0, 0, 0.93);
      root.rotation.set(0, Math.PI, 0);
      life.spot = undefined;
      life.phase = 'sitDown';
      life.u = 0;
      return;
    }
    life.spot = life.goal.spot;
    life.from = { x: root.position.x, z: root.position.z };
    life.phase = 'enterSpot';
    life.u = 0;
  }
}
