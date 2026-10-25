/**
 * CHAR-01 review round 1 (changes requested on 9d6688e). Each test reproduces a reviewer finding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController, groundAt } from '../src/client/player';
import { RIDES, rideSpec, SEDAN, type Ride } from '../src/client/rides';
import { districtLayout, vehicleBox, SedanBody } from '../src/client/world/district-layout';
import { GARAGE, HELIPAD } from '../src/shared/city';
import { gamepadActions, mountGamepad, type PadState } from '../src/client/gamepad';
import { Traversal } from '../src/client/traversal';
import type { Collider, Office } from '../src/client/world/office';
import type { buildCity } from '../src/client/world/city';
import type { Person } from '../src/client/world/character';

class Element extends EventTarget {
  style: Record<string, string> = {};
  textContent = '';
  append() {}
  setAttribute() {}
}
let win: EventTarget;
function controller(colliders: Collider[]) {
  win = new EventTarget();
  Object.assign(globalThis, { window: win, document: Object.assign(new EventTarget(), { createElement: () => new Element(), getElementById: () => new Element(), body: new Element(), documentElement: { classList: { add() {}, remove() {}, contains: () => false } } }) });
  const player = new PlayerController(new THREE.PerspectiveCamera(64, 1, 0.08, 1500), new Element() as unknown as HTMLElement, colliders);
  player.view = 'third';
  let maxX = -Infinity;
  const tick = (s: number) => { for (let i = 0; i < Math.ceil(s * 60); i++) { player.update(1 / 60); maxX = Math.max(maxX, player.pos.x); } };
  return { player, tick, maxX: () => maxX };
}
const key = (type: 'keydown' | 'keyup', code: string) => win.dispatchEvent(Object.assign(new Event(type), { code }));

test('review 1: the helicopter flies over the garage staircase at altitude', () => {
  const layout = districtLayout();
  const stairs = layout.garage.stairs;
  const zMid = (stairs[0].maxZ + stairs.at(-2)!.minZ) / 2;
  const { player, tick, maxX } = controller(layout.colliders.map((c) => ({ ...c })));
  player.ride = rideSpec('helicopter');
  player.driving = true;
  player.pos.set(stairs[0].minX - 12, 30, zMid);
  player.facing = Math.PI / 2;
  player.flight.spool = 1;
  player.setAction('forward', true);
  tick(8);
  assert.ok(maxX() > stairs[0].maxX + 8, `stopped at x ${maxX().toFixed(2)}`);
});

test('review 2: a walker on the helipad deck walks over a van parked in the bay beneath', () => {
  const layout = districtLayout();
  const cols: Collider[] = layout.colliders.map((c) => ({ ...c }));
  const bay = GARAGE.bays[1];
  const car = vehicleBox({ x: bay.x, z: bay.z, yaw: 0 }, RIDES.van.half, RIDES.van.height, 0);
  cols.push(car);
  const { player, tick } = controller(cols);
  player.pos.set(car.minX - 2, HELIPAD.y, bay.z);
  player.launchY = HELIPAD.y;
  player.camYaw = -Math.PI / 2;
  player.facing = Math.PI / 2;
  player.setAction('forward', true);
  tick(4);
  assert.ok(player.pos.x > car.maxX + 0.5 && Math.abs(player.pos.y - HELIPAD.y) < 0.01, `stopped at ${player.pos.toArray().map((v) => v.toFixed(2))}`);
  const c2 = controller(cols);
  c2.player.pos.set(bay.x, HELIPAD.y, bay.z);
  c2.player.launchY = HELIPAD.y;
  c2.player.update(1 / 60);
  assert.ok(Math.abs(c2.player.pos.x - bay.x) < 1e-6 && Math.abs(c2.player.pos.z - bay.z) < 1e-6, 'not shoved by a car 6 m below');
});

test('review 2: a walker climbs the staircase past a car parked beside it at street level', () => {
  const layout = districtLayout();
  const cols: Collider[] = layout.colliders.map((c) => ({ ...c }));
  const s = layout.garage.stairs, first = s[0];
  const car = vehicleBox({ x: first.maxX + 0.1 + RIDES.suv.half.w, z: (s[4].minZ + s[12].maxZ) / 2, yaw: 0 }, RIDES.suv.half, RIDES.suv.height, 0);
  cols.push(car);
  const { player, tick } = controller(cols);
  player.pos.set(first.maxX - 0.25, 0, first.maxZ + 0.5);
  player.camYaw = 0;
  player.facing = Math.PI;
  player.setAction('forward', true);
  let maxY = 0;
  for (let i = 0; i < 60 * 7; i++) { player.update(1 / 60); maxY = Math.max(maxY, player.pos.y); }
  assert.ok(maxY > 4, `stuck beside the car at y ${maxY.toFixed(2)}`);
});

test('review 3: a full stick push never descends the helicopter; B and LT still do', () => {
  const pad = (axes: number[], pressed: number[] = []): PadState => ({ axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })) });
  assert.equal(gamepadActions(pad([0, -1, 0, 0]), undefined, 'fly').run, false);
  assert.equal(gamepadActions(pad([0, -1, 0, 0]), undefined, 'fly').forward, true);
  assert.equal(gamepadActions(pad([0, 0, 0, 0], [1]), undefined, 'fly').run, true);
  assert.equal(gamepadActions(pad([0, 0, 0, 0], [6]), undefined, 'fly').run, true);
  assert.equal(gamepadActions(pad([0, -1, 0, 0])).run, true, 'walking: full push still runs');
});

test('review 4: the foot probe is foot-sized, so a foot beside a step is not lifted onto it', () => {
  const first = districtLayout().garage.stairs[0];
  const fx = first.maxX + 0.25, fz = (first.minZ + first.maxZ) / 2;
  const { player } = controller(districtLayout().colliders);
  assert.equal(player.floorAt(fx, fz, 0.35), 0);
  assert.ok(Math.abs(player.floorAt(first.maxX - 0.1, fz, 0.35) - first.top) < 1e-9);
  assert.ok(groundAt(districtLayout().colliders, fx, fz, 0.35) === 0);
});

test('review 5: a walker boxed in around a car is never frozen', () => {
  const car: Collider = { minX: 9, maxX: 11, minZ: 8, maxZ: 12, top: 1.55, bottom: 0, vehicle: true };
  const walls: Collider[] = [
    { minX: 7, maxX: 8.9, minZ: 0, maxZ: 20, top: 3 }, { minX: 11.1, maxX: 13, minZ: 0, maxZ: 20, top: 3 },
    { minX: 0, maxX: 20, minZ: 6, maxZ: 7.9, top: 3 }, { minX: 0, maxX: 20, minZ: 12.1, maxZ: 14, top: 3 },
  ];
  const { player, tick } = controller([car, ...walls]);
  player.pos.set(10, 0, 10);
  player.camYaw = Math.PI;
  player.setAction('forward', true);
  tick(1);
  assert.ok(Math.abs(player.pos.z - 10) > 0.3, `frozen at ${player.pos.toArray().map((v) => v.toFixed(2))}`);
});

test('review 5: push-out never steps off a platform edge', () => {
  // A car on a raised platform (1 m) whose nearest side (west) is the platform's edge.
  const deck: Collider = { minX: 9.2, maxX: 30, minZ: 0, maxZ: 30, top: 1 };
  const car: Collider = { minX: 9.3, maxX: 11.3, minZ: 8, maxZ: 12.7, top: 2.55, bottom: 1, vehicle: true };
  const { player } = controller([deck, car]);
  player.pos.set(9.6, 1, 10);
  player.launchY = 1;
  player.update(1 / 60);
  assert.ok(Math.abs(player.pos.y - 1) < 0.01 && player.pos.x > 9.2, `stepped off the edge: ${player.pos.toArray().map((v) => v.toFixed(2))}`);
});

test('review 5: the sedan turns solid only once the founder is clear of it (no jump on exit)', () => {
  const body = new SedanBody();
  const car = { position: { x: 10, y: 0, z: 10 }, rotation: { y: Math.PI / 4 } };
  // Driving: not solid.
  let c = body.update(car, true, { x: 10, y: 0, z: 10 }, []);
  assert.ok(c.top <= (c.bottom ?? 0));
  // Just stepped out at a corner of the diagonal AABB: stays non-solid while the walker overlaps the box.
  c = body.update(car, false, { x: 11.6, y: 0, z: 10.2 }, []);
  assert.ok(c.top <= (c.bottom ?? 0), 'deferred while the founder stands inside its box');
  c = body.update(car, false, { x: 20, y: 0, z: 20 }, []);
  assert.ok(c.top > (c.bottom ?? 0) && c.vehicle, 'solid once clear');
  // Once solid it stays solid even if someone walks up to it.
  c = body.update(car, false, { x: 11.6, y: 0, z: 10.2 }, []);
  assert.ok(c.top > (c.bottom ?? 0));
});

test('review 6: releasing the gamepad never drops a key held on the keyboard; a pad connected before mount is seen', () => {
  const { player, tick } = controller([]);
  let pad: PadState | null = { axes: [0, -1, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
  Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => [pad ? { ...pad, connected: true } : null] }, configurable: true });
  const gp = mountGamepad({ player, interact() {}, changeView() {}, openMap() {}, openMenu() {}, blocked: () => false, flying: () => false });
  assert.equal(gp.connected, true, 'pad already connected at mount');
  gp.update(1 / 60);
  key('keydown', 'ArrowUp');
  pad = { axes: [0, 0, 0, 0], buttons: pad.buttons };
  gp.update(1 / 60);
  gp.release();
  player.pos.set(0, 0, 0);
  player.camYaw = Math.PI;
  tick(1);
  assert.ok(player.pos.length() > 1, 'the keyboard still walks');
  key('keyup', 'ArrowUp');
});

test('review 7: Use does not read Exit while still boarding', () => {
  const { player } = controller([]);
  const object = new THREE.Group();
  object.position.set(20, 0, 60);
  const r: Ride = { key: 'v', spec: SEDAN, object, ready: true, setDoor() {}, animate() {} };
  const person = { pose: 'stand', root: new THREE.Group(), setVehiclePose() {}, setTransition() {} } as unknown as Person;
  const office = { floor: 0, group: new THREE.Group(), colliders: [], entranceDoor: { collider: { top: 2.8, bottom: 0 }, update() { this.collider.top = 2.8; } } } as unknown as Office;
  const city = { car: object, setCarDoor() {}, rides: () => [r] } as unknown as ReturnType<typeof buildCity>;
  const t = new Traversal(player, person, office, city, () => {});
  player.pos.set(20 - 1.65, 0, 60.1);
  t.update(1 / 60);
  assert.equal(t.useLabel(), 'Enter');
  assert.equal(t.interactCar(), true);
  for (let i = 0; i < 60; i++) { player.update(1 / 60); t.update(1 / 60); }
  assert.notEqual(t.useLabel(), 'Exit', 'mid-boarding');
});
