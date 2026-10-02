import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NO_STICK, STICK, knobOffset, stickActions } from '../src/client/touch-input';
import { PlayerController } from '../src/client/player';

const R = 58;

test('stick at rest or inside the dead zone presses nothing', () => {
  assert.deepEqual({ ...stickActions(0, 0, R), magnitude: 0 }, NO_STICK);
  const small = stickActions(5, -5, R);
  assert.equal(small.forward || small.backward || small.left || small.right || small.run, false);
});

test('straight and diagonal pushes map to the movement actions', () => {
  const up = stickActions(0, -30, R);
  assert.deepEqual([up.forward, up.backward, up.left, up.right], [true, false, false, false]);
  const diag = stickActions(25, 25, R);
  assert.deepEqual([diag.forward, diag.backward, diag.left, diag.right], [false, true, false, true]);
  const left = stickActions(-40, 4, R);
  assert.deepEqual([left.forward, left.backward, left.left, left.right], [false, false, true, false]);
});

test('partial push walks, near-full push runs, with hysteresis on the way back', () => {
  assert.equal(stickActions(0, -R * 0.5, R).run, false);
  const running = stickActions(0, -R * 0.9, R);
  assert.equal(running.run, true);
  // Easing back slightly below the run threshold keeps running (no flicker at the boundary).
  assert.equal(stickActions(0, -R * (STICK.run - 0.03), R, running).run, true);
  assert.equal(stickActions(0, -R * (STICK.walkBack - 0.05), R, running).run, false);
  // Beyond the rim is clamped to full deflection.
  assert.equal(stickActions(0, -R * 3, R).magnitude, 1);
});

test('direction switches have hysteresis so a thumb on the boundary does not chatter', () => {
  // 30° right of straight up: sin(30°) = 0.5 > on-threshold, so right joins forward.
  const a = stickActions(Math.sin(Math.PI / 6) * 40, -Math.cos(Math.PI / 6) * 40, R);
  assert.equal(a.right, true);
  // Drifting back to 20° keeps it (0.34 > off-threshold) only because it was already on.
  const x20 = Math.sin(Math.PI / 9) * 40, y20 = -Math.cos(Math.PI / 9) * 40;
  assert.equal(stickActions(x20, y20, R, a).right, true);
  assert.equal(stickActions(x20, y20, R).right, false);
});

test('knob is clamped to the base radius', () => {
  const k = knobOffset(300, 400, 50);
  assert.ok(Math.abs(Math.hypot(k.x, k.y) - 50) < 1e-9);
  assert.deepEqual(knobOffset(10, -20, 50), { x: 10, y: -20 });
});

test('stick output drives the existing player actions: walk, run and release', () => {
  Object.assign(globalThis, { window: new EventTarget(), document: new EventTarget() });
  const player = new PlayerController(new THREE.PerspectiveCamera(64, 1, 0.08, 1500), new EventTarget() as unknown as HTMLElement, []);
  player.pos.set(0, 0, 60);
  player.camYaw = 0;
  player.view = 'third';
  const apply = (s: ReturnType<typeof stickActions>) => {
    for (const a of ['forward', 'backward', 'left', 'right', 'run'] as const) player.setAction(a, s[a]);
  };
  apply(stickActions(0, -30, R));
  for (let i = 0; i < 30; i++) player.update(0.02);
  const walkSpeed = player.speed;
  assert.ok(player.pos.z < 60 && walkSpeed > 1 && walkSpeed < 1.7, `walk ${walkSpeed}`);
  apply(stickActions(0, -R, R));
  for (let i = 0; i < 40; i++) player.update(0.02);
  assert.ok(player.speed > 3, `run ${player.speed}`);
  apply(NO_STICK);
  for (let i = 0; i < 40; i++) player.update(0.02);
  assert.ok(player.speed < 0.05);
});
