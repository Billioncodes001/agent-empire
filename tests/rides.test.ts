/**
 * CITY-06/08: every bought vehicle and the helicopter are entered, driven or flown and left with the same player
 * controller and traversal as the executive sedan, each with its own footprint, collider and camera offsets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Traversal } from '../src/client/traversal';
import { PlayerController } from '../src/client/player';
import { RIDES, rideSpec, SEDAN, type RideSpec } from '../src/client/rides';
import { FLIGHT, landingSpot } from '../src/client/flight';
import { vehicleOverlaps } from '../src/client/vehicle';
import { districtLayout } from '../src/client/world/district-layout';
import { GARAGE, HELIPAD, VEHICLE_MODELS } from '../src/shared/city';
import { CITY } from '../src/shared/empire';
import type { Office, Collider } from '../src/client/world/office';
import type { buildCity, Ride } from '../src/client/world/city';
import type { Person } from '../src/client/world/character';

class Element extends EventTarget {
  style: Record<string, string> = {};
  className = '';
  textContent = '';
  append(..._children: unknown[]) {}
  setAttribute(_k: string, _v: string) {}
  remove() {}
}
function dom() {
  const root = new Element();
  const doc = Object.assign(new EventTarget(), { createElement: () => new Element(), getElementById: () => root, body: root });
  Object.assign(globalThis, { window: new EventTarget(), document: doc, Node: Element });
}
function controller(colliders: Collider[]) {
  dom();
  const player = new PlayerController(new THREE.PerspectiveCamera(64, 1, 0.08, 1500), new Element() as unknown as HTMLElement, colliders);
  player.view = 'third';
  const tick = (seconds: number, until: () => boolean = () => false) => {
    for (let i = 0; i < Math.ceil(seconds * 60) && !until(); i++) player.update(1 / 60);
  };
  return { player, tick };
}
const KENNEY = VEHICLE_MODELS.map((m) => m.id);

test('CITY-06: each bought model has its own footprint, height, seat, door, eye and chase camera', () => {
  for (const id of KENNEY) {
    const s = rideSpec(id);
    assert.equal(s.kind, 'car');
    assert.ok(s.half.w > 1 && s.half.l > 2 && s.height > 1.8, `${id} ${JSON.stringify(s.half)} ${s.height}`);
    assert.ok(s.door[0] < -s.half.w, `${id}: the driver's door point stands outside the body`);
    assert.ok(Math.abs(s.seat[0]) < s.half.w && s.eye[1] < s.height && s.eye[1] > 1, `${id}: seat and eye inside the cabin`);
    assert.ok(s.chase >= 7, id);
  }
  assert.notDeepEqual(rideSpec('van').half, rideSpec('coupe').half);
  assert.equal(RIDES.sedan, SEDAN);
  assert.deepEqual(SEDAN.half, { w: 1.07, l: 2.36 }, 'the sedan keeps its authored footprint');
});

test('CITY-06: each model stops at a wall with its own body length and never overlaps it', () => {
  const stops = new Map<string, number>();
  for (const id of KENNEY) {
    const wall = { minX: 60, maxX: 61, minZ: 80, maxZ: 96, top: 5 };
    const { player, tick } = controller([wall]);
    const s = rideSpec(id);
    player.ride = s;
    player.driving = true;
    player.pos.set(40, 0, 88);
    player.facing = Math.PI / 2;
    player.setAction('forward', true);
    tick(12);
    const front = player.pos.x + s.half.l;
    assert.ok(front <= 60 + 1e-6 && front > 59.3, `${id}: front bumper at ${front.toFixed(2)}`);
    assert.equal(vehicleOverlaps(player.pos.x, player.pos.z, player.facing, wall, s.half), false, id);
    stops.set(id, player.pos.x);
  }
  assert.ok(Math.abs(stops.get('van')! - stops.get('coupe')!) > 0.1, 'different lengths stop at different points');
});

test('CITY-06: a tall van is stopped by a low beam the coupe drives under', () => {
  const beam = { minX: 55, maxX: 56, minZ: 80, maxZ: 96, bottom: 2.2, top: 3 };
  const run = (id: 'van' | 'coupe') => {
    const { player, tick } = controller([beam]);
    player.ride = rideSpec(id);
    player.driving = true;
    player.pos.set(40, 0, 88);
    player.facing = Math.PI / 2;
    player.setAction('forward', true);
    tick(10);
    return player.pos.x;
  };
  assert.ok(run('van') < 55, 'the van is too tall');
  assert.ok(run('coupe') > 60, 'the coupe fits');
});

test('CITY-06: every bought model drives from the kerb through the open roller door into the garage', () => {
  const layout = districtLayout();
  for (const id of KENNEY) {
    const { player, tick } = controller(layout.colliders.map((c) => ({ ...c })));
    player.ride = rideSpec(id);
    player.driving = true;
    player.pos.set(GARAGE.door.x, 0, 93);
    player.facing = Math.PI; // nose north, towards the door
    player.setAction('forward', true);
    tick(10, () => player.pos.z < 79);
    assert.ok(player.pos.z < 79, `${id} reached the bays: z ${player.pos.z.toFixed(1)}`);
    for (const w of layout.garage.walls.filter((c) => (c.bottom ?? 0) < 2)) assert.equal(vehicleOverlaps(player.pos.x, player.pos.z, player.facing, w, player.ride.half), false, `${id} inside a wall`);
  }
});

// ---------------------------------------------------------------- entering, driving and leaving a bought vehicle
function traversalWith(rides: () => Ride[], colliders: Collider[] = []) {
  dom();
  const camera = new THREE.PerspectiveCamera(64, 1, 0.08, 1500);
  const player = new PlayerController(camera, new Element() as unknown as HTMLElement, colliders);
  const phases: string[] = [];
  const person = {
    pose: 'stand', root: new THREE.Group(), setVehiclePose() {},
    setTransition(name: string | null) { if (name) phases.push(name); },
  } as unknown as Person;
  const office = { floor: 0, group: new THREE.Group(), colliders, entranceDoor: { collider: { top: 2.8, bottom: 0 }, update() { this.collider.top = 2.8; } } } as unknown as Office;
  const sedan = new THREE.Group();
  sedan.position.set(5, 0, 45);
  const city = { car: sedan, setCarDoor() {}, rides } as unknown as ReturnType<typeof buildCity>;
  const cues: string[] = [];
  const traversal = new Traversal(player, person, office, city, () => {}, (cue) => cues.push(cue));
  const tick = (seconds: number) => {
    for (let i = 0; i < Math.ceil(seconds * 60); i++) {
      player.update(1 / 60);
      traversal.update(1 / 60);
      traversal.syncRide();
    }
  };
  return { player, traversal, tick, phases, cues };
}
function ride(key: string, spec: RideSpec, x: number, z: number, yaw = 0) {
  const object = new THREE.Group();
  object.position.set(x, 0, z);
  object.rotation.y = yaw;
  const log = { doors: [] as number[], entered: 0, exited: 0 };
  const r: Ride = { key, spec, object, ready: true, setDoor: (v: number) => log.doors.push(v), enter: () => log.entered++, exit: () => log.exited++, animate() {} };
  return { r, log };
}
const world = (r: Ride, local: readonly number[]) => new THREE.Vector3(local[0], local[1], local[2]).applyAxisAngle(new THREE.Vector3(0, 1, 0), r.object.rotation.y).add(r.object.position);

test('CITY-06: a bought hatchback is entered at its door, driven with its own footprint and parked where it is left', () => {
  const hatch = ride('vehicle-1', rideSpec('hatchback'), 20, 60);
  const f = traversalWith(() => [hatch.r]);
  f.player.view = 'third';
  f.player.pos.copy(world(hatch.r, hatch.r.spec.door)).add(new THREE.Vector3(-0.4, 0, 0));
  assert.equal(f.traversal.interactCar(), true);
  f.tick(6);
  assert.equal(f.player.driving, true);
  assert.equal(f.player.ride.id, 'hatchback');
  assert.equal(f.player.camDist, hatch.r.spec.chase);
  assert.equal(hatch.log.entered, 1);
  assert.ok(hatch.log.doors.some((v) => v > 0.95) && hatch.log.doors.at(-1) === 0, 'the door leaf opened and closed');
  assert.ok(f.phases.includes('sit_down_chair_01'));
  assert.deepEqual(f.cues, ['door-open', 'door-close', 'engine-start']);
  f.player.setAction('forward', true);
  f.tick(2);
  f.player.setAction('forward', false);
  f.player.vehicle.stop();
  const parked = hatch.r.object.position.clone();
  assert.ok(parked.z > 63, `the car moved with the driver: z ${parked.z.toFixed(1)}`);
  assert.equal(f.traversal.interactCar(), true);
  f.tick(5);
  assert.equal(f.player.driving, false);
  assert.equal(hatch.log.exited, 1);
  assert.ok(hatch.r.object.position.distanceTo(parked) < 1e-9, 'the car stays where it was left');
  assert.ok(f.player.pos.distanceTo(world(hatch.r, hatch.r.spec.door)) < 0.5, 'the founder stands at the driver’s door');
  assert.equal(f.player.ride, SEDAN, 'on foot the controller falls back to the sedan footprint');
});

test('CITY-06: with the driver’s side against a wall the founder climbs out on the passenger side', () => {
  const van = ride('vehicle-2', rideSpec('van'), 20, 60);
  const wall = { minX: 20 - van.r.spec.half.w - 1.6, maxX: 20 - van.r.spec.half.w - 0.2, minZ: 50, maxZ: 70, top: 4 };
  const f = traversalWith(() => [van.r], [wall]);
  f.player.pos.copy(world(van.r, van.r.spec.seat));
  f.player.ride = van.r.spec;
  f.player.driving = true;
  f.traversal.adopt(van.r);
  assert.equal(f.traversal.interactCar(), true);
  f.tick(5);
  assert.equal(f.player.driving, false);
  assert.ok(f.player.pos.x > 20 + van.r.spec.half.w, `stepped out on the passenger side: x ${f.player.pos.x.toFixed(2)}`);
});

// ---------------------------------------------------------------- CITY-08: flight
function pilot(colliders: Collider[], x: number, y: number, z: number, yaw = Math.PI / 2) {
  const f = controller(colliders);
  f.player.ride = rideSpec('helicopter');
  f.player.driving = true;
  f.player.pos.set(x, y, z);
  f.player.facing = yaw;
  if (y > 0) f.player.flight.spool = 1;
  return f;
}

test('CITY-08: the rotor spools up before lift-off, then the helicopter climbs and stops at the ceiling', () => {
  const { player, tick } = pilot([], 20, 0, 100);
  player.setAction('jump', true);
  tick(1);
  assert.equal(player.pos.y, 0, 'no lift while the rotor spools up');
  tick(3);
  assert.ok(player.pos.y > 1, `lifted off: y ${player.pos.y.toFixed(2)}`);
  tick(30);
  assert.ok(player.pos.y <= FLIGHT.ceiling + 1e-9 && player.pos.y > FLIGHT.ceiling - 0.5, `held at the ceiling: y ${player.pos.y.toFixed(2)}`);
});

test('CITY-08: descending lands on the terrain and never falls through it', () => {
  const { player, tick } = pilot([], 20, 30, 100);
  player.setAction('run', true);
  let lowest = Infinity;
  for (let i = 0; i < 60 * 40; i++) { player.update(1 / 60); lowest = Math.min(lowest, player.pos.y); }
  assert.equal(player.pos.y, 0);
  assert.ok(lowest >= 0, `lowest ${lowest}`);
  assert.equal(player.flight.landed, true);
  assert.equal(landingSpot(player.pos, 0), 'street');
});

test('CITY-08: a tall building stops the airframe; climbing above it clears it; landing on its roof is not an exit', () => {
  const tower = { minX: 30, maxX: 90, minZ: 92, maxZ: 108, top: 40 };
  const { player, tick } = pilot([tower], 15, 10, 100);
  player.setAction('forward', true);
  tick(8);
  const heli = rideSpec('helicopter');
  assert.ok(player.pos.x + heli.half.l <= 30 + 1e-6, `stopped short of the wall: nose at ${(player.pos.x + heli.half.l).toFixed(2)}`);
  assert.equal(vehicleOverlaps(player.pos.x, player.pos.z, player.facing, tower, heli.half), false);
  player.setAction('forward', false);
  player.setAction('jump', true);
  tick(8, () => player.pos.y > 44);
  player.setAction('jump', false);
  player.setAction('forward', true);
  tick(4, () => player.pos.x > 35);
  player.setAction('forward', false);
  assert.ok(player.pos.x > 35, 'flew over the roof');
  tick(4);
  player.setAction('run', true);
  tick(20);
  assert.ok(Math.abs(player.pos.y - 40) < 1e-6, `rests on the roof: y ${player.pos.y}`);
  assert.equal(landingSpot(player.pos, 40), null, 'no exit onto a roof you cannot climb down from');
  player.setAction('run', false);
  player.setAction('jump', true);
  tick(3);
  assert.ok(player.pos.y > 41, 'can always climb away');
});

test('CITY-08: the helicopter lands on the rooftop pad, where exit is allowed, and the city bounds hold in flight', () => {
  const layout = districtLayout();
  const { player, tick } = pilot(layout.colliders.map((c) => ({ ...c })), HELIPAD.x, 20, HELIPAD.z, HELIPAD.yaw);
  player.setAction('run', true);
  tick(20);
  assert.ok(Math.abs(player.pos.y - HELIPAD.y) < 1e-6, `on the pad: y ${player.pos.y}`);
  assert.equal(landingSpot(player.pos, player.pos.y), 'pad');
  const edge = pilot([], 140, 30, 100);
  edge.player.setAction('forward', true);
  edge.tick(10);
  assert.ok(edge.player.pos.x + rideSpec('helicopter').half.l <= CITY.maxX + 1e-6, `x ${edge.player.pos.x.toFixed(1)}`);
});

test('CITY-08: exit is refused in the air and on a roof, allowed once landed at street level', () => {
  const heli = ride('helicopter', rideSpec('helicopter'), 20, 100, Math.PI / 2);
  const tower = { minX: 30, maxX: 45, minZ: 90, maxZ: 110, top: 30 };
  const f = traversalWith(() => [heli.r], [tower]);
  f.player.ride = heli.r.spec;
  f.player.driving = true;
  f.player.pos.set(37, 35, 100);
  f.player.facing = Math.PI / 2;
  f.player.flight.spool = 1;
  f.traversal.adopt(heli.r);
  assert.equal(f.traversal.interactCar(), true);
  f.tick(0.5);
  assert.equal(f.player.driving, true, 'still flying: no exit in the air');
  f.player.setAction('run', true);
  f.tick(12);
  f.player.setAction('run', false);
  assert.ok(Math.abs(f.player.pos.y - 30) < 1e-6);
  f.traversal.interactCar();
  f.tick(0.5);
  assert.equal(f.player.driving, true, 'no exit onto the roof');
  f.player.setAction('jump', true);
  f.tick(1.5);
  f.player.setAction('jump', false);
  f.player.facing = -Math.PI / 2;
  f.player.setAction('forward', true);
  f.tick(4, );
  f.player.setAction('forward', false);
  f.tick(3);
  f.player.setAction('run', true);
  f.tick(20);
  f.player.setAction('run', false);
  assert.equal(f.player.pos.y, 0, `landed in the street at x ${f.player.pos.x.toFixed(1)}`);
  f.tick(1);
  assert.equal(f.traversal.interactCar(), true);
  f.tick(5);
  assert.equal(f.player.driving, false, 'stepped out at street level');
  assert.equal(f.player.pos.y, 0);
  assert.equal(heli.log.exited, 1);
});
