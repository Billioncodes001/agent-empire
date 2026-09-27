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
  const traversal = new Traversal(player, person, office, city, () => delegated++);
  const tick = (seconds: number) => {
    for (let i = 0; i < Math.ceil(seconds * 60); i++) {
      player.update(1 / 60);
      traversal.update(1 / 60);
    }
  };
  return { player, traversal, tick, phases, doors, colliders, delegated: () => delegated };
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
  assert.equal(f.traversal.interactCar(), true);
  f.tick(4.5);
  assert.equal(f.player.driving, false);
  assert.equal(f.player.scripted, false);
  assert.ok(f.player.pos.x < 4);
  assert.equal(f.player.view, 'first');
  assert.ok(f.phases.includes('sit_stand_up_chair_01'));
  assert.equal(f.doors.at(-1), 0);
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
