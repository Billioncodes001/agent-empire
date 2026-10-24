/**
 * CITY-06/08 review round: each test reproduces a reviewer finding and fails without its fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Traversal } from '../src/client/traversal';
import { PlayerController } from '../src/client/player';
import { HELICOPTER_SPEC, rideSpec, type RideSpec } from '../src/client/rides';
import { districtLayout, apronSlotsBlocked, bayBlocked } from '../src/client/world/district-layout';
import { dressKenneyCar } from '../src/client/world/garage-rides';
import { GARAGE, HELIPAD, normalizeCity } from '../src/shared/city';
import type { Office, Collider } from '../src/client/world/office';
import type { buildCity, Ride } from '../src/client/world/city';
import type { Person } from '../src/client/world/character';

class Element extends EventTarget {
  style: Record<string, string> = {};
  className = '';
  textContent = '';
  append() {}
  setAttribute() {}
  remove() {}
}
function rig(ride: Ride, colliders: Collider[], extra: Record<string, unknown> = {}, touch = false) {
  const root = new Element();
  const classes = new Set(touch ? ['ae-touch'] : []);
  const doc = Object.assign(new EventTarget(), {
    createElement: () => new Element(), getElementById: () => root, body: root,
    documentElement: { classList: { contains: (c: string) => classes.has(c) } },
  });
  Object.assign(globalThis, { window: new EventTarget(), document: doc, Node: Element });
  const player = new PlayerController(new THREE.PerspectiveCamera(), new Element() as unknown as HTMLElement, colliders);
  player.view = 'third';
  const person = { pose: 'stand', root: new THREE.Group(), setVehiclePose() {}, setTransition() {} } as unknown as Person;
  const office = { floor: 0, group: new THREE.Group(), colliders, entranceDoor: { collider: { top: 2.8, bottom: 0 }, update() {} } } as unknown as Office;
  const city = { car: new THREE.Group(), setCarDoor() {}, rides: () => [ride], ...extra } as unknown as ReturnType<typeof buildCity>;
  const t = new Traversal(player, person, office, city, () => {}, () => {});
  t.adopt(ride);
  player.ride = ride.spec;
  player.driving = true;
  player.pos.copy(ride.object.position);
  player.facing = ride.object.rotation.y;
  const run = (frames: number) => { for (let i = 0; i < frames; i++) { player.update(1 / 60); t.update(1 / 60); t.syncRide(); } };
  return { player, t, run };
}
function ride(spec: RideSpec, x: number, y: number, z: number, yaw: number, key = 'v1'): Ride {
  const object = new THREE.Group();
  object.position.set(x, y, z);
  object.rotation.y = yaw;
  return { key, spec, object, ready: true, setDoor() {}, enter() {}, exit() {}, animate() {} };
}

test('review 1: with the parked (solid) sedan on the driver side, the founder climbs out on the passenger side, not into the sedan', () => {
  const hatch = rideSpec('hatchback');
  const r = ride(hatch, 51.2, 0, 45, 0);
  const sedan: Collider = { minX: 51.2 - hatch.half.w - 2.24, maxX: 51.2 - hatch.half.w - 0.1, minZ: 42.6, maxZ: 47.4, top: 1.55 };
  const f = rig(r, [sedan], { carCollider: sedan });
  f.t.interactCar();
  f.run(600);
  assert.equal(f.player.driving, false);
  assert.ok(f.player.pos.x > 51.2 + hatch.half.w, `passenger side: x ${f.player.pos.x.toFixed(2)}`);
});

for (const [label, x, z, yaw] of [['south edge', 72, 83.6, HELIPAD.yaw], ['north edge', 72, 72.3, -HELIPAD.yaw], ['east, heading north', 77.5, 78, Math.PI]] as const) {
  test(`review 2: a helicopter exit near the pad's ${label} never drops the founder off the roof`, () => {
    const colliders = districtLayout().colliders.map((c) => ({ ...c }));
    const f = rig(ride(HELICOPTER_SPEC, x, HELIPAD.y, z, yaw, 'helicopter'), colliders);
    f.run(30);
    f.t.interactCar();
    f.run(600);
    assert.ok(Math.abs(f.player.pos.y - HELIPAD.y) < 0.05, `still on the roof: y ${f.player.pos.y.toFixed(2)}`);
    if (!f.player.driving) {
      const p = f.player.pos;
      assert.ok(p.x > 61.3 && p.x < 82.75 && p.z > 71.25 && p.z < 84.75, `inside the rails: ${p.x.toFixed(2)}, ${p.z.toFixed(2)}`);
    }
  });
}

test('review 8: an exit whose door point is south of the city edge uses the other side', () => {
  const r = ride(rideSpec('van'), 20, 0, 31.5, -Math.PI / 2);
  const f = rig(r, []);
  f.t.interactCar();
  f.run(600);
  assert.equal(f.player.driving, false);
  assert.ok(f.player.pos.z >= 30.3, `stays in the city: z ${f.player.pos.z.toFixed(2)}`);
});

test('review 3: on touch screens the flight hint names the on-screen Up and Down buttons', () => {
  const f = rig(ride(HELICOPTER_SPEC, 20, 0, 100, 0, 'helicopter'), [], {}, true);
  f.run(2);
  const hint = (f.t as unknown as { hint: { textContent: string } }).hint.textContent;
  assert.match(hint, /Up Climb · Down Descend/);
});

test('review 4: switching to the chase view uses the ride’s own chase distance', () => {
  const f = rig(ride(rideSpec('van'), 20, 0, 60, 0), []);
  f.player.camDist = 2;
  f.player.resetChase();
  assert.equal(f.player.camDist, rideSpec('van').chase);
  f.player.driving = false;
  f.player.resetChase();
  assert.equal(f.player.camDist, 4.6);
});

test('review 5: a bay with another car parked over it is taken; the kerb slots see the helicopter', () => {
  const city = normalizeCity({ schema: 1, plots: [], vehicles: [{ id: 'vehicle-1', model: 'van', bay: 0, purchasedAt: 1 }, { id: 'vehicle-2', model: 'suv', bay: 1, apron: 0, purchasedAt: 1 }] });
  const parkedOverBay1 = { position: { x: GARAGE.bays[1].x, z: GARAGE.bays[1].z }, rotation: { y: 0.2 }, half: rideSpec('van').half };
  assert.equal(bayBlocked(city, 'vehicle-2', [parkedOverBay1]), true);
  assert.equal(bayBlocked(city, 'vehicle-2', []), false);
  const heli = { position: { x: GARAGE.apron[1].x, z: GARAGE.apron[1].z }, rotation: { y: 0 }, half: HELICOPTER_SPEC.half };
  assert.deepEqual(apronSlotsBlocked([heli], { x: 0, z: 0 }), [1]);
});

test('review 6: a garage car disposes the geometry it generated when it leaves the save', () => {
  const template = new THREE.Group();
  const geo = new THREE.BoxGeometry(1, 1, 2);
  const body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  body.name = 'body';
  template.add(body);
  const car = dressKenneyCar(template, rideSpec('hatchback'));
  let generated = 0, shared = 0;
  car.root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.geometry === geo) o.geometry.addEventListener('dispose', () => shared++);
    else o.geometry.addEventListener('dispose', () => generated++);
  });
  car.dispose();
  assert.ok(generated >= 5, `generated geometries disposed: ${generated}`);
  assert.equal(shared, 0, 'the kit template geometry stays');
});
