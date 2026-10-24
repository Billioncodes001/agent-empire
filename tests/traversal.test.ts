import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Traversal } from '../src/client/traversal';
import { PlayerController } from '../src/client/player';
import type { Office } from '../src/client/world/office';
import type { buildCity } from '../src/client/world/city';
import type { Person } from '../src/client/world/character';
class Element extends EventTarget {
  style: Record<string, string> = {};
  className = '';
  textContent = '';
  append(..._children: unknown[]) {}
  setAttribute(_k: string, _v: string) {}
  remove() {}
}
function setup() {
  const root = new Element();
  const doc = new EventTarget();
  Object.assign(doc, { createElement: () => new Element(), getElementById: () => root, body: root });
  Object.assign(globalThis, { window: new EventTarget(), document: doc, Node: Element });
  const colliders = [{ minX: -33.2, maxX: -14.8, minZ: 41.7, maxZ: 54.3, top: 11.4 }];
  const camera = new THREE.PerspectiveCamera(64, 1, 0.08, 1500),
    player = new PlayerController(camera, new Element() as unknown as HTMLElement, colliders);
  const car = new THREE.Group();
  car.position.set(5, 0, 45);
  car.userData.ready = true;
  const phases: string[] = [],
    doors: number[] = [];
  const person = {
    pose: 'stand',
    root: new THREE.Group(),
    reach() {},
    setVehiclePose() {},
    setTransition(name: string | null) {
      if (name) phases.push(name);
    },
  } as unknown as Person;
  const office = { floor: 0, group: new THREE.Group(), colliders, entranceDoor: { collider: {top: 2.8, bottom: 0}, update() { this.collider.top = 2.8; } } } as unknown as Office;
  const city = {
    car,
    setCarDoor(v: number) {
      doors.push(v);
    },
  } as unknown as ReturnType<typeof buildCity>;
  let delegated = 0;
  const cues: string[] = [];
  const traversal = new Traversal(player, person, office, city, () => delegated++, cue => cues.push(cue));
  const tick = (seconds: number) => {
    for (let i = 0; i < Math.ceil(seconds * 60); i++) {
      player.update(1 / 60);
      traversal.update(1 / 60);
    }
  };
  return { player, traversal, tick, phases, doors, cues, colliders, delegated: () => delegated };
}
test('walking through office door transfers to street once, then allows re-entry', () => {
  const f = setup();
  f.player.view = 'third';
  f.player.pos.set(0, 0, 10);
  f.player.camYaw = Math.PI;
  f.player.setAction('forward', true);
  f.tick(4);
  assert.ok(f.player.pos.z > 54 && f.player.pos.z < 58);
  assert.equal(f.delegated(), 1);
  assert.equal(f.player.scripted, false);
  f.tick(2);
  assert.equal(f.delegated(), 1);
  f.player.camYaw = 0;
  f.player.facing = Math.PI;
  f.player.setAction('forward', true);
  f.tick(4);
  assert.ok(f.player.pos.z < 13);
  assert.equal(f.player.scripted, false);
  assert.equal(f.delegated(), 1);
});
test('car entry and exit retain camera preference, animate door and restore movement', () => {
  const f = setup();
  f.player.pos.set(3.2, 0, 45.1);
  f.player.view = 'first';
  assert.equal(f.traversal.interactCar(), true);
  assert.equal(f.player.driving, false);
  assert.equal(f.player.scripted, true);
  f.tick(5.5);
  assert.equal(f.player.driving, true);
  assert.equal(f.player.view, 'first');
  assert.equal(f.player.scripted, false);
  assert.ok(f.phases.includes('sit_down_chair_01'));
  assert.ok(f.doors.some((v) => v > 0.95));
  assert.equal(f.doors.at(-1), 0);
  f.player.vehicle.speed = 3;
  assert.equal(f.traversal.interactCar(), true);
  assert.equal(f.traversal.state, 'driving');
  assert.equal(f.player.scripted, false);
  f.player.vehicle.speed = 0;
  assert.equal(f.traversal.interactCar(), true);
  f.tick(4.5);
  assert.equal(f.player.driving, false);
  assert.equal(f.player.scripted, false);
  assert.ok(f.player.pos.x < 4);
  assert.equal(f.player.view, 'first');
  assert.ok(f.phases.includes('sit_stand_up_chair_01'));
  assert.equal(f.doors.at(-1), 0);
  assert.deepEqual(f.cues, ['door-open', 'door-close', 'engine-start', 'engine-stop', 'door-open', 'door-close']);
});
test('door transitions cannot be triggered while jumping or standing still', () => {
  const f = setup();
  f.player.pos.set(0, 0, 12.4);
  f.player.facing = 0;
  f.player.moving = false;
  f.traversal.update(0.02);
  assert.equal(f.player.scripted, false);
  f.player.moving = true;
  f.player.grounded = false;
  f.traversal.update(0.02);
  assert.equal(f.player.scripted, false);
});

// ---------------------------------------------------------------- FREE-09 (CITY-05/07): districts and garage
import { districtLayout } from '../src/client/world/district-layout';
import { GARAGE } from '../src/shared/city';
import type { Collider } from '../src/client/world/office';

function cityWalker(colliders: Collider[]) {
  setup(); // installs the minimal DOM the controller expects
  const player = new PlayerController(new THREE.PerspectiveCamera(64, 1, 0.08, 1500), new Element() as unknown as HTMLElement, colliders);
  player.view = 'third';
  const walk = (yaw: number, until: () => boolean, seconds = 90) => {
    player.camYaw = yaw;
    player.setAction('forward', true);
    for (let i = 0; i < seconds * 60 && !until(); i++) player.update(1 / 60);
    player.setAction('forward', false);
    for (let i = 0; i < 30; i++) player.update(1 / 60);
  };
  return { player, walk };
}

test('the founder walks from the founding district along new streets into the business district and Harbour works', () => {
  const layout = districtLayout();
  const { player, walk } = cityWalker(layout.colliders.map((c) => ({ ...c })));
  player.pos.set(40, 0, 90);
  walk(-Math.PI / 2, () => player.pos.x >= 100);
  assert.ok(player.pos.x >= 99.5 && Math.abs(player.pos.z - 90) < 1, `reached the avenue: ${player.pos.x.toFixed(1)}, ${player.pos.z.toFixed(1)}`);
  walk(Math.PI, () => player.pos.z >= 175);
  assert.ok(player.pos.z >= 174, `walked down the avenue to the harbour road: z ${player.pos.z.toFixed(1)}`);
  walk(-Math.PI / 2, () => player.pos.x >= 140);
  assert.ok(player.pos.x >= 139, `crossed Harbour works: x ${player.pos.x.toFixed(1)}`);
  assert.ok(player.pos.x <= 150, 'stays within the city bounds');
});

test('the garage is entered physically through its roller door; the closed door and walls block entry', () => {
  const layout = districtLayout();
  const door = { ...layout.garage.door };
  const { player, walk } = cityWalker([...layout.colliders.map((c) => ({ ...c })), door]);
  player.pos.set(GARAGE.door.x, 0, 91);
  walk(0, () => player.pos.z < 80, 8);
  assert.ok(player.pos.z > GARAGE.door.z, `held outside by the closed door: z ${player.pos.z.toFixed(2)}`);
  door.top = 0;
  player.pos.set(64, 0, 91);
  walk(0, () => player.pos.z < 80, 8);
  assert.ok(player.pos.z > GARAGE.door.z, 'the front wall is solid');
  player.pos.set(GARAGE.door.x, 0, 91);
  walk(0, () => player.pos.z < 80, 12);
  assert.ok(player.pos.z < 80, `inside the garage: z ${player.pos.z.toFixed(2)}`);
});

test('the executive sedan can drive from the founding district into the business district', () => {
  const layout = districtLayout();
  const { player } = cityWalker(layout.colliders.map((c) => ({ ...c })));
  player.pos.set(40, 0, 88);
  player.driving = true;
  player.facing = Math.PI / 2;
  player.setAction('forward', true);
  for (let i = 0; i < 60 * 30 && player.pos.x < 95; i++) player.update(1 / 60);
  assert.ok(player.pos.x >= 95, `drove east along the z = 90 street: x ${player.pos.x.toFixed(1)}`);
});

test('review 3: the founding z = 146 road stays open past the skyline into Harbour works', async () => {
  const { skylineColliders } = await import('../src/client/world/district-layout');
  const layout = districtLayout();
  const { player, walk } = cityWalker([...layout.colliders, ...skylineColliders()].map((c) => ({ ...c })));
  player.pos.set(-40, 0, 148.5); // the northern lane, next to the kerb under the towers
  walk(-Math.PI / 2, () => player.pos.x >= 92);
  assert.ok(player.pos.x >= 91 && Math.abs(player.pos.z - 148.5) < 0.6, `walked the z = 146 road: ${player.pos.x.toFixed(1)}, ${player.pos.z.toFixed(2)}`);
});
