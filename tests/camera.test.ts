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
  return { player, camera, key, canvas, win };
}
test('arrow input moves forward; opening a modal can stop held movement', () => {
  const { player, key } = setup();
  key('keydown', 'ArrowUp');
  for (let i = 0; i < 10; i++) player.update(0.02);
  assert.ok(player.pos.z < 59.85);
  assert.ok(player.speed > 1 && player.speed < 1.65);
  key('keyup', 'ArrowUp');
  const released = player.pos.clone();
  const speed = player.speed;
  player.update(0.02);
  assert.ok(player.speed < speed && player.pos.z < released.z);
  for (let i = 0; i < 40; i++) player.update(.02);
  const stopped = player.pos.clone();
  player.update(.02);
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
test('blocked movement stops animation speed; first person steering does not follow head look',()=>{
 const {player}=setup([{minX:-9,maxX:9,minZ:50,maxZ:58,top:8}]);
 player.setAction('forward',true);
 for(let i=0;i<240;i++)player.update(1/60);
 assert.equal(player.moving,false);assert.equal(player.speed,0);
 player.clearKeys();player.pos.set(0,0,70);player.driving=true;player.view='first';player.facing=0;player.camYaw=.8;
 player.update(.02);assert.equal(player.facing,0);
});
test('driver eye turns with the vehicle while retaining the head-look offset', () => {
  const { player } = setup();
  player.driving = true;
  player.view = 'first';
  player.facing = 0;
  player.camYaw = -Math.PI + 0.4;
  player.setAction('forward', true);
  player.setAction('right', true);
  for (let i = 0; i < 60; i++) player.update(1 / 60);
  assert.ok(Math.abs(player.facing) > 0.2);
  assert.ok(Math.abs(player.camYaw - player.facing - (-Math.PI + 0.4)) < 1e-8);
});

const angleError = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a-b), Math.cos(a-b)));
test('third-person follows a held sideways turn without feeding camera yaw back into movement', () => {
  const { player } = setup();
  player.setAction('right', true);
  for (let i = 0; i < 180; i++) player.update(1 / 60);
  assert.ok(player.pos.x > 4);
  assert.ok(Math.abs(player.pos.z - 60) < .001, 'held direction must stay straight, not spiral');
  assert.ok(angleError(player.camYaw, player.facing - Math.PI) < .003);
  player.setAction('right', false);
  player.setAction('forward', true);
  for (let i = 0; i < 60; i++) player.update(1 / 60);
  assert.ok(player.pos.x > 5.5, 'new forward input follows the recentered view');
});
test('manual orbit pauses automatic following, then resumes behind the character', () => {
  const { player, canvas, win } = setup();
  const pointer = (target: EventTarget, type: string, x: number) => {
    const event = new Event(type);
    Object.assign(event, { clientX: x, clientY: 0, pointerType: 'touch' });
    target.dispatchEvent(event);
  };
  player.setAction('forward', true);
  player.update(.02);
  pointer(canvas, 'pointerdown', 0);
  pointer(win, 'pointermove', 100);
  const orbit = player.camYaw;
  for (let i = 0; i < 90; i++) player.update(1 / 60);
  assert.equal(player.camYaw, orbit, 'drag keeps control even after grace expires');
  pointer(win, 'pointerup', 100);
  // Turn sideways from the manually selected direction, then allow follow to settle.
  player.setAction('forward', false);
  player.setAction('right', true);
  for (let i = 0; i < 180; i++) player.update(1 / 60);
  assert.ok(angleError(player.camYaw, player.facing - Math.PI) < .004);
});
test('camera switches never rotate a vehicle or snap the walking body away from its heading', () => {
  const { player } = setup();
  for (const driving of [false, true]) {
    player.driving = driving;
    player.view = 'third';
    player.facing = .7;
    player.camYaw = 2.4;
    player.setView('first');
    assert.equal(player.facing, .7);
    assert.ok(angleError(player.camYaw, .7 - Math.PI) < 1e-10);
    player.setView('third');
    assert.equal(player.facing, .7);
  }
});
test('district overview retains its angle and modal blocks mouse orbit', () => {
  const { player, canvas, win } = setup();
  player.camDist = 40;
  player.setAction('right', true);
  for (let i = 0; i < 60; i++) player.update(1 / 60);
  assert.equal(player.camYaw, 0);
  const down = new Event('pointerdown');
  Object.assign(down, { clientX: 0, clientY: 0 });
  canvas.dispatchEvent(down);
  player.enabled = false;
  player.clearKeys();
  const move = new Event('pointermove');
  Object.assign(move, { clientX: 100, clientY: 0 });
  win.dispatchEvent(move);
  assert.equal(player.camYaw, 0);
});
test('follow camera settles consistently at 30, 60 and 120 frames per second', () => {
  const samples = [30, 60, 120].map(fps => {
    const { player, camera } = setup();
    player.updateCamera(true);
    player.setAction('right', true);
    for (let i = 0; i < fps * 2; i++) player.update(1 / fps);
    return { yaw: player.camYaw, offset: camera.position.clone().sub(player.pos) };
  });
  assert.ok(angleError(samples[0].yaw, samples[2].yaw) < .003);
  assert.ok(samples[0].offset.distanceTo(samples[2].offset) < .06);
});

test('a following camera retracts in the same frame when a wall obstructs its eased position', () => {
  const { player, camera } = setup([{ minX: -2, maxX: 2, minZ: 62, maxZ: 65, top: 8 }]);
  camera.position.set(0, 2, 64);
  player.updateCamera(false, 1 / 120);
  assert.ok(camera.position.z < 61.9, 'camera must not ease through a wall');
});

test('camera finishes following a brief arrow turn after movement stops', () => {
  const { player } = setup();
  player.setAction('right', true);
  for (let i = 0; i < 6; i++) player.update(1 / 60);
  player.setAction('right', false);
  for (let i = 0; i < 240; i++) player.update(1 / 60);
  assert.equal(player.moving, false);
  assert.ok(angleError(player.camYaw, player.facing - Math.PI) < .002);
  assert.ok(angleError(player.facing, Math.PI / 2) < .001, 'body finishes the entire right turn');
});

for (const view of ['first', 'third'] as const) {
  for (const action of ['left', 'right'] as const) {
    for (const running of [false, true]) {
      test(`${view} ${running ? 'running' : 'walking'} ${action} turns body and view without mouse input`, () => {
        const { player, key } = setup();
        player.setView(view);
        key('keydown', running ? 'ShiftLeft' : 'Unbound');
        key('keydown', action === 'left' ? 'ArrowLeft' : 'ArrowRight');
        const target = action === 'left' ? -Math.PI / 2 : Math.PI / 2;
        player.update(1 / 60);
        assert.ok(angleError(player.facing, target) < Math.PI / 2, 'turn starts on the first frame');
        assert.ok(Math.abs(player.pos.x) < .004, 'turn leads the step instead of a full sideways stride');
        for (let i = 1; i < 180; i++) player.update(1 / 60);
        assert.ok(angleError(player.facing, target) < .001);
        assert.ok(angleError(player.camYaw, target - Math.PI) < .003);
        assert.ok((action === 'left' ? -1 : 1) * player.pos.x > (running ? 10 : 4));
        assert.ok(Math.abs(player.pos.z - 60) < .001, 'automatic camera turn never bends the held path');
      });
    }
  }
  test(`${view} one-frame tap completes its turn, even against a wall`, () => {
    const { player } = setup([{ minX: .32, maxX: 2, minZ: 55, maxZ: 65, top: 8 }]);
    player.setView(view);
    player.setAction('right', true);
    player.update(1 / 120);
    player.setAction('right', false);
    for (let i = 0; i < 480; i++) player.update(1 / 120);
    assert.equal(player.pos.x, 0);
    assert.ok(angleError(player.facing, Math.PI / 2) < .001);
    assert.ok(angleError(player.camYaw, -Math.PI / 2) < .002);
  });
}

test('first-person mouse look can steer held movement after a keyboard turn', () => {
  const { player, canvas, win } = setup();
  player.setView('first');
  player.setAction('right', true);
  for (let i = 0; i < 60; i++) player.update(1 / 60);
  const before = player.pos.clone();
  const down = new Event('pointerdown');
  Object.assign(down, { clientX: 0, clientY: 0, pointerType: 'touch' });
  canvas.dispatchEvent(down);
  const move = new Event('pointermove');
  Object.assign(move, { clientX: 100, clientY: 0 });
  win.dispatchEvent(move);
  for (let i = 0; i < 60; i++) player.update(1 / 60);
  assert.ok(angleError(player.facing, Math.PI / 2 - .5) < .001);
  assert.ok(angleError(player.camYaw, player.facing - Math.PI) < .001);
  assert.ok(player.pos.x > before.x + 1 && player.pos.z > before.z + .5);
});

test('changing view during a held turn preserves the direction of travel', () => {
  const { player } = setup();
  player.setAction('right', true);
  for (let i = 0; i < 30; i++) player.update(1 / 60);
  player.setView('first');
  for (let i = 0; i < 60; i++) player.update(1 / 60);
  player.setView('third');
  for (let i = 0; i < 60; i++) player.update(1 / 60);
  assert.ok(player.pos.x > 3);
  assert.ok(Math.abs(player.pos.z - 60) < .001);
  assert.ok(angleError(player.facing, Math.PI / 2) < .001);
});
