import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController, EYE_HEIGHT } from '../src/client/player';
import type { Collider } from '../src/client/world/office';

function setup(colliders: Collider[] = []) {
  const win = new EventTarget();
  Object.assign(globalThis, { window: win, document: new EventTarget() });
  const canvas = new EventTarget() as unknown as HTMLElement;
  const camera = new THREE.PerspectiveCamera(64, 1, 0.08, 1500);
  const player = new PlayerController(camera, canvas, colliders);
  player.pos.set(0, 0, 60);
  player.camYaw = 0;
  player.view = 'third';
  const key = (type: string, code: string) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { code, metaKey: false, ctrlKey: false, altKey: false });
    win.dispatchEvent(event);
  };
  return { player, camera, key };
}
test('arrow input moves forward; opening a modal can stop held movement', () => {
  const { player, key } = setup();
  key('keydown', 'ArrowUp');
  for (let i = 0; i < 10; i++) player.update(0.02);
  assert.ok(player.pos.z < 59.5);
  key('keyup', 'ArrowUp');
  const stopped = player.pos.clone();
  player.update(0.02);
  assert.ok(player.pos.equals(stopped));
  key('keydown', 'ArrowUp');
  player.enabled = false;
  player.clearKeys();
  player.update(0.02);
  assert.ok(player.pos.equals(stopped));
});
test('first person is at human eye height; switching back retains a grounded camera', () => {
  const { player, camera } = setup();
  player.setView('first');
  player.updateCamera(true);
  assert.equal(camera.position.y, EYE_HEIGHT);
  assert.equal(camera.position.z, player.pos.z);
  player.setView('third');
  player.updateCamera(true);
  assert.ok(camera.position.y > 1.5 && camera.position.y < 3);
  assert.ok(camera.position.distanceTo(player.pos) < 6);
});
test('shoulder camera pulls in before a building wall', () => {
  const { player, camera } = setup([{ minX: -2, maxX: 2, minZ: 62, maxZ: 65, top: 8 }]);
  player.camDist = 4.6;
  player.camPitch = 0.16;
  player.updateCamera(true);
  assert.ok(camera.position.z < 61.9);
  assert.ok(camera.position.z > 60);
});
test('walking and driving cannot pass through a built sector', () => {
  const { player } = setup([{ minX: -9, maxX: 9, minZ: 50, maxZ: 58, top: 8 }]);
  player.setAction('forward', true);
  for (let i = 0; i < 180; i++) player.update(1 / 60);
  assert.ok(player.pos.z >= 58.3);
  player.pos.set(0, 0, 60);
  player.driving = true;
  player.facing = Math.PI;
  for (let i = 0; i < 180; i++) player.update(1 / 60);
  assert.ok(player.pos.z >= 59.69);
});
