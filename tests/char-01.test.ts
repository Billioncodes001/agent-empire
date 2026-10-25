/**
 * CHAR-01: vehicles are solid to a walker from every side and at every height, nobody stands on a car or a prop,
 * cars never climb the garage staircase and a teleport never drags a ride (Android shot 36: the founder on the sedan
 * on the garage roof). Plus the touch Run button mapping and the gamepad mapping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController } from '../src/client/player';
import { RIDES, rideSpec, SEDAN } from '../src/client/rides';
import { districtLayout, sedanCollider, vehicleBox } from '../src/client/world/district-layout';
import { HELIPAD, VEHICLE_MODELS } from '../src/shared/city';
import { gamepadActions, NO_PAD } from '../src/client/gamepad';
import { stickActions, touchMoves } from '../src/client/touch-input';
import { locomotionClip } from '../src/client/world/human';
import type { Collider } from '../src/client/world/office';

class Element extends EventTarget {
  style: Record<string, string> = {};
  append() {}
  setAttribute() {}
}
function controller(colliders: Collider[]) {
  Object.assign(globalThis, { window: new EventTarget(), document: Object.assign(new EventTarget(), { createElement: () => new Element(), getElementById: () => new Element(), body: new Element() }) });
  const player = new PlayerController(new THREE.PerspectiveCamera(64, 1, 0.08, 1500), new Element() as unknown as HTMLElement, colliders);
  player.view = 'third';
  let maxY = -Infinity;
  const tick = (seconds: number) => {
    for (let i = 0; i < Math.ceil(seconds * 60); i++) { player.update(1 / 60); maxY = Math.max(maxY, player.pos.y); }
  };
  return { player, tick, maxY: () => maxY };
}
const inside = (c: Collider, x: number, z: number, r = 0.3) => x > c.minX - r && x < c.maxX + r && z > c.minZ - r && z < c.maxZ + r;
const roof = (): Collider => ({ minX: 60, maxX: 100, minZ: 60, maxZ: 100, bottom: 5.2, top: HELIPAD.y });
const parked = (x: number, y: number, z: number, yaw = 0) => ({ position: { x, y, z }, rotation: { y: yaw } });

test('CHAR-01: the sedan collider stands at the sedan’s own height, and is a vehicle', () => {
  const c = sedanCollider(parked(80, HELIPAD.y, 80), false);
  assert.equal(c.bottom, HELIPAD.y);
  assert.ok(Math.abs(c.top - (HELIPAD.y + SEDAN.height)) < 1e-9);
  assert.equal(c.vehicle, true);
  assert.ok(sedanCollider(parked(80, HELIPAD.y, 80), true).top <= (sedanCollider(parked(80, HELIPAD.y, 80), true).bottom ?? 0), 'driven: not solid');
  const b = vehicleBox({ x: 10, z: 20, yaw: 0.3 }, RIDES.van.half, RIDES.van.height, 2);
  assert.equal(b.bottom, 2);
  assert.equal(b.vehicle, true);
});

test('CHAR-01: on the garage roof a walker cannot walk into a sedan parked there (shot 36)', () => {
  const car = sedanCollider(parked(80, HELIPAD.y, 80), false);
  const { player, tick } = controller([roof(), car]);
  player.pos.set(80, HELIPAD.y, 74);
  player.grounded = true;
  player.facing = 0;
  player.camYaw = Math.PI;
  player.setAction('forward', true);
  tick(4);
  assert.ok(!inside(car, player.pos.x, player.pos.z, 0.25), `walked into the car: ${player.pos.toArray().map((v) => v.toFixed(2))}`);
  assert.ok(Math.abs(player.pos.y - HELIPAD.y) < 0.01, `stays on the deck, y ${player.pos.y}`);
});

test('CHAR-01: no step-up onto a vehicle, however low', () => {
  const low: Collider = { minX: 9, maxX: 11, minZ: 8, maxZ: 12, top: 0.25, vehicle: true };
  const { player, tick, maxY } = controller([low]);
  player.pos.set(10, 0, 5);
  player.camYaw = Math.PI;
  player.setAction('forward', true);
  tick(4);
  assert.ok(maxY() < 0.01, `stepped onto it: max y ${maxY()}`);
  assert.ok(player.pos.z < 8 - 0.3 + 0.01);
});

test('CHAR-01: jumping at the sedan never lands on its bonnet or roof', () => {
  const car = sedanCollider(parked(10, 0, 10), false);
  const { player, tick } = controller([car]);
  player.pos.set(10, 0, 6.9);
  player.camYaw = Math.PI;
  player.setAction('forward', true);
  for (let i = 0; i < 6; i++) {
    player.setAction('jump', true);
    tick(0.1);
    player.setAction('jump', false);
    tick(0.7);
  }
  assert.ok(player.pos.y < 0.01, `standing on the car at y ${player.pos.y}`);
  assert.ok(!inside(car, player.pos.x, player.pos.z, 0.25));
});

test('CHAR-01: dropped over a car, or found inside one, the walker ends beside it and can walk away', () => {
  for (const y of [0, 0.8, 3]) {
    const car = sedanCollider(parked(10, 0, 10), false);
    const { player, tick } = controller([car]);
    player.pos.set(10.2, y, 10.4);
    player.grounded = y === 0;
    tick(1.5);
    assert.ok(player.pos.y < 0.01, `from ${y}: y ${player.pos.y}`);
    assert.ok(!inside(car, player.pos.x, player.pos.z, 0.25), `from ${y}: still inside at ${player.pos.x.toFixed(2)}, ${player.pos.z.toFixed(2)}`);
    const before = player.pos.clone();
    player.setAction('backward', true);
    tick(1);
    assert.ok(player.pos.distanceTo(before) > 0.5, `from ${y}: stuck`);
  }
});

test('CHAR-01: a jump cannot land on a desk, bench or kiosk (props are not floors)', () => {
  const bench: Collider = { minX: 9, maxX: 11, minZ: 8, maxZ: 9, top: 0.75 };
  const { player, tick } = controller([bench]);
  player.pos.set(10, 0, 7.5);
  player.camYaw = Math.PI;
  player.setAction('forward', true);
  player.setAction('jump', true);
  tick(0.15);
  player.setAction('jump', false);
  tick(0.25);
  // At the top of the jump the walker is above the bench but may not move over it.
  tick(1);
  assert.ok(player.pos.y < 0.01 && player.pos.z < 8, `on the bench: ${player.pos.toArray().map((v) => v.toFixed(2))}`);
});

test('CHAR-01: walkers still climb the garage staircase to the helipad', () => {
  const layout = districtLayout();
  const { player, tick, maxY } = controller(layout.colliders.map((c) => ({ ...c })));
  const first = layout.garage.stairs[0];
  player.pos.set((first.minX + first.maxX) / 2, 0, first.maxZ + 0.6);
  player.camYaw = 0; // walk north (−z)
  player.facing = Math.PI;
  player.setAction('forward', true);
  tick(9);
  assert.ok(maxY() > HELIPAD.y - 0.05, `reached y ${maxY().toFixed(2)}`);
});

test('CHAR-01: no car can be driven up the garage staircase, from any side or at any speed', () => {
  const layout = districtLayout();
  const stairs = layout.garage.stairs, first = stairs[0], last = stairs.at(-2)!;
  const cx = (first.minX + first.maxX) / 2;
  const starts = [
    { x: cx, z: first.maxZ + 6, yaw: Math.PI }, // from the foot, heading north
    { x: first.maxX + 6, z: (first.minZ + last.minZ) / 2, yaw: -Math.PI / 2 }, // from the east side
    { x: cx + 1.5, z: first.maxZ + 6, yaw: Math.PI - 0.35 }, // diagonal
  ];
  for (const id of ['sedan', ...VEHICLE_MODELS.map((m) => m.id)] as const)
    for (const s of starts)
      for (const fast of [false, true]) {
        const { player, tick, maxY } = controller(layout.colliders.map((c) => ({ ...c })));
        player.ride = rideSpec(id);
        player.driving = true;
        player.pos.set(s.x, 0, s.z);
        player.facing = s.yaw;
        player.setAction('forward', true);
        if (fast) player.setAction('run', true);
        for (const steer of ['left', 'right', null] as const) {
          if (steer) player.setAction(steer, true);
          tick(3);
          if (steer) player.setAction(steer, false);
        }
        assert.ok(maxY() < 0.01, `${id} climbed to ${maxY().toFixed(2)} from ${JSON.stringify(s)}`);
      }
  assert.ok(stairs.every((c) => c.walkOnly), 'stair colliders are walker-only');
});

test('CHAR-01: a teleport is refused while driving or flying, so it can never drag a ride onto a roof', () => {
  const { player } = controller([]);
  player.driving = true;
  player.pos.set(5, 0, 45);
  assert.equal(player.teleport(80, HELIPAD.y, 80), false);
  assert.deepEqual(player.pos.toArray(), [5, 0, 45]);
  player.driving = false;
  player.vy = 3;
  assert.equal(player.teleport(10, 0, 12), true);
  assert.deepEqual(player.pos.toArray(), [10, 0, 12]);
  assert.equal(player.vy, 0);
});

// ---------------------------------------------------------------- animation state machine
test('CHAR-01: turning on the spot steps the feet instead of spinning a standing pose', () => {
  assert.equal(locomotionClip(0, 'idle_neutral_01'), 'idle_neutral_01');
  assert.equal(locomotionClip(0, 'idle_neutral_01', 6), 'walk_neutral', 'a fast turn in place shuffles');
  assert.equal(locomotionClip(0, 'idle_neutral_01', 0.5), 'idle_neutral_01', 'a slow camera drift does not');
  assert.equal(locomotionClip(4.3, 'walk_neutral', 6), 'run_neutral');
});

// ---------------------------------------------------------------- touch
test('CHAR-01: the touch Run button runs at any stick deflection, and never descends in flight', () => {
  const walk = stickActions(0, -25, 58);
  assert.equal(walk.run, false);
  assert.equal(touchMoves(walk, true, 'walk').run, true, 'run lock + small push runs');
  assert.equal(touchMoves(walk, false, 'walk').run, false);
  assert.equal(touchMoves(stickActions(0, 0, 58), true, 'walk').run, false, 'standing still does not hold run');
  assert.equal(touchMoves(walk, true, 'drive').run, true, 'accelerates in a car');
  assert.equal(touchMoves(stickActions(0, -58, 58), true, 'fly').run, false, 'in flight only Down descends');
  assert.equal(touchMoves(walk, true, 'walk').forward, true);
});

// ---------------------------------------------------------------- gamepad
const pad = (axes: number[] = [0, 0, 0, 0], pressed: number[] = []) => ({ axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })) });
test('CHAR-01: a standard gamepad maps to the same actions as the keyboard', () => {
  assert.deepEqual(gamepadActions(null), NO_PAD);
  const idle = gamepadActions(pad([0.05, -0.08, 0, 0]));
  assert.equal(idle.forward || idle.backward || idle.left || idle.right || idle.run, false, 'dead zone');
  const fwd = gamepadActions(pad([0, -0.5, 0, 0]));
  assert.equal(fwd.forward, true);
  assert.equal(fwd.run, false);
  assert.equal(gamepadActions(pad([0, -1, 0, 0])).run, true, 'full deflection runs');
  const dpad = gamepadActions(pad([0, 0, 0, 0], [13, 14]));
  assert.equal(dpad.backward && dpad.left, true);
  const b = gamepadActions(pad([0, 0, 0, 0], [0, 1, 2, 3, 8, 9]));
  assert.deepEqual([b.jump, b.run, b.interact, b.camera, b.map, b.menu], [true, true, true, true, true, true]);
  assert.equal(gamepadActions(pad([0, 0, 0, 0], [6])).run, true, 'left trigger runs, accelerates or descends');
  const look = gamepadActions(pad([0, 0, 0.9, -0.4]));
  assert.ok(look.lookX > 0.5 && look.lookY < -0.1);
  assert.equal(gamepadActions(pad([0, 0, 0.1, 0.1])).lookX, 0, 'right stick dead zone');
});
