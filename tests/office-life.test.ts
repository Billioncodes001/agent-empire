import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AMENITY_ORDER, BREAK_AFTER_MS, ROTATE_MS, amenityFor, pickSpot, planRoutine, stableHash, staysPut, type RoutineInput } from '../src/client/world/routines';
import { AMENITY_SPOTS, FURNISHING_COLLIDERS } from '../src/client/world/furnishing-layout';
import { NavGrid, pathLength } from '../src/client/world/navgrid';
import { buildNavGrid, deskPoints, layoutObstacles } from '../src/client/world/office-nav';
import { OfficeLife } from '../src/client/world/worker-life';
import { DESKS, FLOOR, deskDefinition } from '../src/shared/layout';
import type { Worker } from '../src/client/world/character';
import type { DeskView, Office } from '../src/client/world/office';

const STATUSES = ['starting', 'idle', 'working', 'needs_input', 'done', 'exited', 'offline', 'mystery'];
const base = (over: Partial<RoutineInput> = {}): RoutineInput => ({ id: 'w-1', status: 'idle', processState: 'running', fresh: true, typing: false, since: 0, now: BREAK_AFTER_MS + 1, ...over });

test('working is always at the desk, typing only with the typing evidence', () => {
  assert.deepEqual(planRoutine(base({ status: 'working', typing: true })), { place: 'desk', activity: 'typing', reason: '' });
  const unconfirmed = planRoutine(base({ status: 'working', typing: false, processState: 'unknown' }));
  assert.equal(unconfirmed.place, 'desk');
  assert.equal(unconfirmed.activity, 'seated');
  // A dependency never pulls a running worker away from its desk.
  assert.equal(planRoutine(base({ status: 'working', typing: true, waitingOn: { name: 'Ada' } })).place, 'desk');
  assert.equal(planRoutine(base({ status: 'starting' })).place, 'desk');
});

test('needs input keeps the worker at its desk with an attention cue', () => {
  const plan = planRoutine(base({ status: 'needs_input', waitingOn: { name: 'Ada' }, now: 10 * ROTATE_MS }));
  assert.deepEqual([plan.place, plan.activity], ['desk', 'attention']);
});

test('stale, disconnected, offline, exited or unknown workers never walk around', () => {
  for (const status of STATUSES) {
    const stale = planRoutine(base({ status, fresh: false, waitingOn: { name: 'Ada' }, now: 10 * ROTATE_MS }));
    assert.equal(stale.place, 'desk', `${status} while stale`);
    assert.ok(staysPut(stale), `${status} while stale is placed without a walk`);
  }
  for (const status of ['offline', 'exited']) {
    const plan = planRoutine(base({ status, now: 10 * ROTATE_MS }));
    assert.deepEqual([plan.place, plan.activity], ['desk', 'asleep']);
    assert.ok(staysPut(plan));
  }
  assert.ok(staysPut(planRoutine(base({ status: 'mystery' }))));
});

test('idle and finished turns take a break after a short dwell, with an honest reason', () => {
  assert.equal(planRoutine(base({ status: 'idle', since: 1000, now: 1000 + BREAK_AFTER_MS - 1 })).place, 'desk', 'a quick reply does not send it walking');
  const idle = planRoutine(base({ status: 'idle' }));
  assert.ok(AMENITY_ORDER.includes(idle.place as never));
  assert.match(idle.reason, /^Idle — /);
  const done = planRoutine(base({ status: 'done' }));
  assert.match(done.reason, /^Turn finished — /);
  const waiting = planRoutine(base({ status: 'idle', since: 5, now: 6, waitingOn: { name: 'Ada' } }));
  assert.notEqual(waiting.place, 'desk');
  assert.match(waiting.reason, /^Waiting on Ada — /);
});

test('only real idle, done or waiting states ever place a worker away from its desk', () => {
  for (const status of STATUSES)
    for (const fresh of [true, false])
      for (const typing of [true, false])
        for (const waitingOn of [undefined, { name: 'Ada' }])
          for (const now of [0, BREAK_AFTER_MS + 1, 3 * ROTATE_MS]) {
            const plan = planRoutine(base({ status, fresh, typing, waitingOn, since: 0, now }));
            if (plan.place !== 'desk') {
              assert.ok(fresh && (status === 'idle' || status === 'done'), `${status}/${fresh}/${typing} left the desk`);
              assert.equal(plan.activity, 'break');
              assert.ok(plan.reason.length > 0, 'a break always says why');
            }
            if (plan.activity === 'typing') assert.ok(fresh && typing && status === 'working', 'typing only on a fresh running turn');
          }
});

test('the amenity is stable per worker and break, and rotates slowly', () => {
  const pick = amenityFor('worker-a', 1_000, 1_000 + BREAK_AFTER_MS);
  for (let t = 0; t < ROTATE_MS - BREAK_AFTER_MS - 1_000; t += 997) assert.equal(amenityFor('worker-a', 1_000, 1_000 + BREAK_AFTER_MS + t), pick, 'not random frame to frame');
  assert.notEqual(amenityFor('worker-a', 1_000, 1_000 + ROTATE_MS + 1), pick, 'a long break moves on');
  assert.equal(stableHash('worker-a'), stableHash('worker-a'));
  const kinds = new Set(Array.from({ length: 30 }, (_, i) => amenityFor(`w-${i}`, 0, BREAK_AFTER_MS)));
  assert.equal(kinds.size, 3, 'workers spread over coffee, cafeteria and gym');
});

test('spots are shared out without two workers on one', () => {
  const taken = new Set<string>();
  const gym = AMENITY_SPOTS.filter((s) => s.kind === 'gym');
  for (let i = 0; i < gym.length; i++) {
    const spot = pickSpot(AMENITY_SPOTS, 'gym', stableHash(`w-${i}`), taken)!;
    assert.ok(spot && !taken.has(spot.id));
    taken.add(spot.id);
  }
  assert.equal(pickSpot(AMENITY_SPOTS, 'gym', 0, taken), undefined, 'a full gym leaves the worker at its desk');
});

// ---- Path graph ---------------------------------------------------------------------------------
const grid = buildNavGrid();
const obstacles = layoutObstacles();
const inside = (p: { x: number; z: number }, b: { minX: number; maxX: number; minZ: number; maxZ: number }, m = 0) => p.x > b.minX - m && p.x < b.maxX + m && p.z > b.minZ - m && p.z < b.maxZ + m;

test('every desk reaches every amenity spot over clear aisles, and back', () => {
  let longest = 0;
  for (const desk of DESKS) {
    const { exit } = deskPoints(desk);
    assert.ok(grid.nearestFree(exit, 0.3), `${desk.id} has a free aisle point behind its chair`);
    for (const spot of AMENITY_SPOTS) {
      const path = grid.findPath(exit, spot.approach);
      assert.ok(path, `${desk.id} → ${spot.id}`);
      // Every leg stays in the walkable grid and off every obstacle (with the walker's shoulders).
      let a = exit;
      for (const p of path) {
        const d = Math.hypot(p.x - a.x, p.z - a.z), steps = Math.ceil(d / 0.05);
        for (let i = 0; i <= steps; i++) {
          const q = { x: a.x + ((p.x - a.x) * i) / steps, z: a.z + ((p.z - a.z) * i) / steps };
          assert.ok(q.x > FLOOR.minX + 0.25 && q.x < FLOOR.maxX - 0.25 && q.z > FLOOR.minZ + 0.25 && q.z < FLOOR.maxZ - 0.25, 'inside the walls');
          for (const o of obstacles) assert.ok(!inside(q, o, 0.12), `${desk.id} → ${spot.id} crosses ${'name' in o ? o.name : 'a fitting'}`);
        }
        a = p;
      }
      longest = Math.max(longest, pathLength(exit, path));
      assert.ok(grid.findPath(spot.approach, exit), `${spot.id} → ${desk.id}`);
    }
  }
  assert.ok(longest < 60, `routes are aisles, not detours (${longest.toFixed(1)} m)`);
});

test('amenity approaches are clear, and the last step only meets the spot’s own equipment', () => {
  for (const spot of AMENITY_SPOTS) {
    assert.ok(grid.nearestFree(spot.approach, 0.3), `${spot.id} approach is walkable`);
    const own = FURNISHING_COLLIDERS.filter((f) => inside(spot, f));
    for (let i = 0; i <= 20; i++) {
      const q = { x: spot.approach.x + ((spot.x - spot.approach.x) * i) / 20, z: spot.approach.z + ((spot.z - spot.approach.z) * i) / 20 };
      for (const o of obstacles) if (!own.includes(o as never)) assert.ok(!inside(q, o), `${spot.id} last step crosses ${'name' in o ? o.name : 'a fitting'}`);
    }
  }
});

test('a walled-off goal has no path', () => {
  const walled = new NavGrid({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, [{ minX: 4, maxX: 4.5, minZ: 0, maxZ: 10 }]);
  assert.equal(walled.findPath({ x: 1, z: 5 }, { x: 8, z: 5 }), null);
  const open = new NavGrid({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, [{ minX: 4, maxX: 4.5, minZ: 0, maxZ: 8 }]);
  const path = open.findPath({ x: 1, z: 2 }, { x: 8, z: 2 })!;
  assert.ok(path.some((p) => p.z > 8), 'goes round the end of the wall');
  assert.deepEqual(path.at(-1), { x: 8, z: 2 });
});

// ---- The runtime controller, with stand-in bodies (no WebGL) ------------------------------------
function stubWorld() {
  const office = { group: new THREE.Group(), colliders: [] } as unknown as Office;
  const def = deskDefinition('desk-1')!;
  const group = new THREE.Group();
  group.position.set(def.x, 0, def.z);
  group.rotation.y = def.rotY;
  office.group.add(group);
  const chair = new THREE.Group();
  const desk = { def, group, chair } as unknown as DeskView;
  const root = new THREE.Group();
  group.add(root);
  const reasons: string[] = [];
  const worker = { root, typing: false, motion: { speed: 0, seated: true, activity: 'none', detail: true, transition: null, progress: 0 }, setReason: (t: string) => reasons.push(t) } as unknown as Worker;
  return { office, desk, worker, reasons };
}

function run(life: OfficeLife, seconds: number, clock: { now: number }, each?: () => void) {
  for (let t = 0; t < seconds; t += 1 / 30) {
    clock.now += 1000 / 30;
    life.update(1 / 30, clock.now);
    each?.();
  }
}

test('an idle worker walks to an amenity, and a new turn brings it back to sit before typing', () => {
  const { office, desk, worker, reasons } = stubWorld();
  const typingEvents: boolean[] = [];
  const life = new OfficeLife(office, { reducedMotion: () => false, detail: () => true, onTyping: (_id, t) => typingEvents.push(t) });
  const clock = { now: 100_000 };
  const working = { status: 'working', processState: 'running', fresh: true, typing: true };
  life.sync('w-1', worker, desk, working, clock.now);
  assert.equal(worker.typing, true, 'typing at the desk');
  life.sync('w-1', worker, desk, { ...working, status: 'idle', typing: false }, clock.now);
  run(life, 3, clock);
  assert.equal(life.snapshot()[0].phase, 'seated', 'still at the desk inside the dwell');
  let walked = false;
  run(life, 40, clock, () => { if (life.snapshot()[0].phase === 'walk') { walked = true; assert.equal(worker.typing, false); } });
  const away = life.snapshot()[0];
  assert.ok(walked, 'it walked');
  assert.equal(away.phase, 'using');
  assert.ok(away.spot, 'on an amenity spot');
  assert.equal(worker.root.parent, office.group);
  assert.match(reasons.at(-1)!, /^Idle — /);
  // The server reports a running turn again: walk back, sit, and only then type.
  life.sync('w-1', worker, desk, working, clock.now);
  let typedAway = false;
  run(life, 40, clock, () => { if (worker.typing && life.snapshot()[0].phase !== 'seated') typedAway = true; });
  assert.equal(typedAway, false, 'never types away from the desk');
  assert.equal(life.snapshot()[0].phase, 'seated');
  assert.equal(worker.root.parent, desk.group);
  assert.equal(worker.typing, true);
  assert.deepEqual(typingEvents, [true, false, true]);
});

test('going stale mid-walk puts the worker back at its desk without walking', () => {
  const { office, desk, worker } = stubWorld();
  const life = new OfficeLife(office, { reducedMotion: () => false, detail: () => true, onTyping: () => {} });
  const clock = { now: 100_000 };
  life.sync('w-1', worker, desk, { status: 'working', fresh: true, typing: true }, clock.now);
  life.sync('w-1', worker, desk, { status: 'done', fresh: true, typing: false }, clock.now);
  run(life, 10, clock);
  assert.notEqual(life.snapshot()[0].phase, 'seated');
  life.sync('w-1', worker, desk, { status: 'done', fresh: false, typing: false }, clock.now);
  assert.equal(life.snapshot()[0].phase, 'seated', 'placed, not walked');
  assert.equal(worker.root.parent, desk.group);
  run(life, 5, clock);
  assert.equal(life.snapshot()[0].phase, 'seated');
});

test('reduced motion places workers without a walking animation', () => {
  const { office, desk, worker } = stubWorld();
  const life = new OfficeLife(office, { reducedMotion: () => true, detail: () => true, onTyping: () => {} });
  const clock = { now: 100_000 };
  life.sync('w-1', worker, desk, { status: 'working', fresh: true, typing: true }, clock.now);
  life.sync('w-1', worker, desk, { status: 'idle', fresh: true, typing: false }, clock.now);
  const phases = new Set<string>();
  run(life, 10, clock, () => phases.add(life.snapshot()[0].phase));
  assert.ok(!phases.has('walk'), 'no walking');
  assert.equal(life.snapshot()[0].phase, 'using');
});
