import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entranceAccess, assignedWorkers, mapPoint, mapWorld, worldPosition } from '../src/client/navigation';
import { initialEmpire } from '../src/shared/empire';
import { sanitizeKeys, DEFAULT_KEYS } from '../src/client/controls';
import type { WorkerInfo } from '../src/shared/protocol';
const worker = (patch: Partial<WorkerInfo> = {}) =>
  ({
    id: 'one',
    kind: 'agent',
    status: 'working',
    prompt: 'Sector: Healthcare / Harbour hospital\n\nResearch clinical software',
    ...patch,
  }) as WorkerInfo;
test('business entry needs completed construction and an assigned live AI worker', () => {
  const state = initialEmpire();
  assert.equal(entranceAccess('home', state, []).allowed, true);
  assert.equal(entranceAccess('hq', state, []).allowed, true);
  assert.equal(entranceAccess('hospital', state, [worker()]).allowed, false);
  state.sectors.find((s) => s.id === 'hospital')!.built = true;
  state.sectors.find((s) => s.id === 'hospital')!.staff = 12;
  assert.equal(entranceAccess('hospital', state, []).allowed, false, 'fictional staff cannot unlock an AI workplace');
  assert.equal(entranceAccess('hospital', state, [worker()]).allowed, true);
  for (const patch of [{ kind: 'shell' }, { status: 'offline' }, { status: 'exited' }, { prompt: 'unassigned research' }])
    assert.equal(entranceAccess('hospital', state, [worker(patch as Partial<WorkerInfo>)]).allowed, false);
  assert.equal(assignedWorkers('school', [worker()]).length, 0);
});
test('map projection round trips and office position maps to headquarters', () => {
  for (const [x, z] of [
    [-24, 48],
    [24, 104],
    [-55, 125],
  ]) {
    const pixel = mapPoint(x, z, 1000, 760),
      world = mapWorld(pixel.x, pixel.y, 1000, 760);
    assert.ok(Math.abs(world.x - x) < 0.00001 && Math.abs(world.z - z) < 0.00001);
  }
  assert.deepEqual(worldPosition(0, 0), { x: -24, z: 48 });
  assert.deepEqual(worldPosition(5, 60), { x: 5, z: 60 });
});
test('older complete key maps migrate without losing remaps', () => {
  const { map, camera, ...old } = DEFAULT_KEYS;
  const migrated = sanitizeKeys({ ...old, forward: 'KeyW', interact: 'KeyQ' });
  assert.equal(migrated.forward, 'KeyW');
  assert.equal(migrated.interact, 'KeyQ');
  assert.equal(migrated.map, 'KeyG');
  assert.equal(migrated.camera, 'KeyN');
});

test('migration chooses a free shortcut when an old remap already uses G or N', () => {
  const { map, camera, ...old } = DEFAULT_KEYS;
  const migrated = sanitizeKeys({ ...old, forward: 'KeyG', backward: 'KeyN' });
  assert.equal(migrated.forward, 'KeyG');
  assert.equal(migrated.backward, 'KeyN');
  assert.equal(new Set(Object.values(migrated)).size, Object.keys(DEFAULT_KEYS).length);
});
