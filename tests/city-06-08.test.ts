/**
 * CITY-06/08: shared rules and save compatibility for the company helicopter, the rooftop helipad layout, and the
 * per-vehicle garage placement rules (a parked car stays where it was left for the session; a reload uses the save).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';
import { initialEmpire, type EmpireAction, type EmpireState } from '../src/shared/empire';
import { applyCityAction, type CityActionText } from '../src/shared/economy-rules';
import { GARAGE, HELICOPTER, HELIPAD, normalizeCity } from '../src/shared/city';
import { Empire } from '../src/server/empire';
import { validateEmpire } from '../src/cloud/schema';
import { applyEmpireAction } from '../src/cloud/economy';
import { intentPath, parseIntent } from '../src/cloud/intents';
import { districtLayout, garagePose, poseBox, ROADS } from '../src/client/world/district-layout';
import { PlayerController } from '../src/client/player';
import type { Collider } from '../src/client/world/office';

const text = new Proxy({}, { get: () => () => '' }) as CityActionText;
const founded = () => {
  const s = initialEmpire(1000);
  assert.equal(applyCityAction(s, { kind: 'found', sites: ['cafe'] }, 1000, text, () => {}), undefined);
  return s;
};
const act = (s: EmpireState, a: EmpireAction) => applyCityAction(s, a, 2000, text, () => {});

test('CITY-08: the company helicopter is bought once with fictional city credits through the capital ledger', () => {
  assert.equal(act(initialEmpire(1000), { kind: 'buy-helicopter', nonce: 'heli-0001' }), 'Complete founding setup first');
  const poor = founded();
  poor.funds = HELICOPTER.cost - 1;
  assert.equal(act(poor, { kind: 'buy-helicopter', nonce: 'heli-0002' }), 'Insufficient simulation credits');
  assert.equal(poor.city?.helicopter, undefined);
  const s = founded();
  const before = s.funds;
  assert.equal(act(s, { kind: 'buy-helicopter', nonce: 'heli-0003' }), undefined);
  assert.equal(s.funds, before - HELICOPTER.cost);
  assert.equal(s.city!.helicopter, true);
  assert.equal(s.economy.ledger[0].label, `Helicopter purchase · ${HELICOPTER.name}`);
  assert.equal(s.economy.ledger[0].capital, HELICOPTER.cost);
  assert.equal(act(s, { kind: 'buy-helicopter', nonce: 'heli-0003' }), 'This purchase was already made');
  assert.equal(act(s, { kind: 'buy-helicopter', nonce: 'heli-0004' }), 'The company helicopter is already owned');
  assert.equal(act(s, { kind: 'buy-helicopter' } as EmpireAction), 'Invalid purchase request');
  assert.equal(s.funds, before - HELICOPTER.cost, 'refusals never spend');
});

test('CITY-08: host and cloud apply identical helicopter rules; the cloud accepts the intent with its nonce only', () => {
  const host = founded(), cloud = founded();
  for (const a of [{ kind: 'buy-helicopter', nonce: 'parity-h1' }, { kind: 'buy-helicopter', nonce: 'parity-h1' }, { kind: 'buy-helicopter', nonce: 'parity-h2' }] as EmpireAction[])
    assert.equal(act(host, a), applyEmpireAction(cloud, a, 2000));
  assert.deepEqual(host.city, cloud.city);
  assert.equal(host.funds, cloud.funds);
  const id = '7f0c2f4e-4a51-4c1e-9a0b-0c8f9e2d1a33';
  const file = (action: unknown) => JSON.stringify({ schemaVersion: 1, id, createdAt: 1, kind: 'empire_action', action });
  const intent = parseIntent(intentPath(id), file({ kind: 'buy-helicopter', nonce: 'cloud-nonce-1' })) as { action: EmpireAction };
  assert.deepEqual(intent.action, { kind: 'buy-helicopter', nonce: 'cloud-nonce-1' });
  assert.throws(() => parseIntent(intentPath(id), file({ kind: 'buy-helicopter', nonce: 'x-nonce-1', cost: 1 })));
});

test('CITY-08 save compatibility: old saves (no city block, or a city block without a helicopter) load unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'city0608-'));
  const old = founded() as Partial<EmpireState>;
  old.city = { schema: 1, plots: ['harbour-yard'], vehicles: [{ id: 'vehicle-1', model: 'van', bay: 0, apron: 1, purchasedAt: 5 }], nonces: ['older-nonce-1'] };
  writeFileSync(join(dir, 'empire.json'), JSON.stringify(old));
  const e = new Empire(dir, () => {});
  assert.deepEqual(e.state.city, old.city);
  assert.equal(e.state.city!.helicopter, undefined);
  assert.equal(e.action({ kind: 'buy-helicopter', nonce: 'restart-heli-1' }), undefined);
  assert.equal(new Empire(dir, () => {}).state.city!.helicopter, true, 'ownership survives a restart');
  const none = founded() as Partial<EmpireState>;
  delete none.city;
  assert.deepEqual(validateEmpire(none).city, { schema: 1, plots: [], vehicles: [], nonces: [] });
  assert.deepEqual(normalizeCity({ schema: 1, plots: [], vehicles: [], helicopter: true }), { schema: 1, plots: [], vehicles: [], nonces: [], helicopter: true });
  assert.throws(() => normalizeCity({ schema: 1, plots: [], vehicles: [], helicopter: 'yes' }), /helicopter/);
  assert.throws(() => normalizeCity({ schema: 1, plots: [], vehicles: [], helicopter: false }), /helicopter/);
});

// ---------------------------------------------------------------- layout: rooftop helipad and staircase
const overlaps = (a: { minX: number; maxX: number; minZ: number; maxZ: number }, b: { minX: number; maxX: number; minZ: number; maxZ: number }) =>
  a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;

class Element extends EventTarget { style = {}; append() {} setAttribute() {} remove() {} }
function walker(colliders: Collider[]) {
  Object.assign(globalThis, { window: new EventTarget(), document: Object.assign(new EventTarget(), { createElement: () => new Element() }) });
  const player = new PlayerController(new THREE.PerspectiveCamera(), new Element() as unknown as HTMLElement, colliders);
  player.view = 'third';
  const walk = (yaw: number, until: () => boolean, seconds = 30) => {
    player.camYaw = yaw;
    player.setAction('forward', true);
    for (let i = 0; i < seconds * 60 && !until(); i++) player.update(1 / 60);
    player.setAction('forward', false);
    for (let i = 0; i < 30; i++) player.update(1 / 60);
  };
  return { player, walk };
}

test('CITY-08: the helipad deck is on the garage roof; the staircase stays off the streets and inside the business district', () => {
  const { garage } = districtLayout();
  assert.ok(Math.abs(HELIPAD.x - GARAGE.x) < 1 && Math.abs(HELIPAD.z - GARAGE.z) < 1, 'pad centred on the garage');
  const roof = garage.walls.find((w) => (w.bottom ?? 0) > 5)!;
  assert.equal(roof.top, HELIPAD.y);
  for (const s of garage.stairs) {
    for (const r of ROADS) assert.ok(!overlaps(s, { minX: r.x - r.w / 2, maxX: r.x + r.w / 2, minZ: r.z - r.d / 2, maxZ: r.z + r.d / 2 }), 'stair on a street');
    assert.ok(s.minX >= GARAGE.x + GARAGE.width / 2 - 0.01, 'outside the east wall');
  }
  const rise = garage.stairs.map((s) => s.top).sort((a, b) => a - b);
  for (let i = 1; i < rise.length; i++) assert.ok(rise[i] - rise[i - 1] < 0.3, 'every step is a walkable rise');
  // The rails keep walkers on the roof but leave the pad clear for the helicopter.
  const pad = { minX: HELIPAD.x - HELIPAD.size / 2, maxX: HELIPAD.x + HELIPAD.size / 2, minZ: HELIPAD.z - HELIPAD.size / 2, maxZ: HELIPAD.z + HELIPAD.size / 2 };
  for (const r of garage.rails) assert.ok(!overlaps(r, pad), 'a rail on the pad');
});

test('CITY-08: the founder walks from the street up the staircase onto the rooftop helipad (physical traversal)', () => {
  const layout = districtLayout();
  const { player, walk } = walker(layout.colliders.map((c) => ({ ...c })));
  const foot = layout.garage.stairs.reduce((a, b) => (a.top < b.top ? a : b));
  player.pos.set((foot.minX + foot.maxX) / 2, 0, foot.maxZ + 1.2);
  walk(0, () => player.pos.z < 71.9);
  assert.ok(Math.abs(player.pos.y - HELIPAD.y) < 0.05, `on the landing at the roof's height: y ${player.pos.y.toFixed(2)}`);
  walk(Math.PI / 2, () => player.pos.x < 80);
  walk(Math.PI, () => player.pos.z > HELIPAD.z - 2);
  assert.ok(player.pos.x < 80.5 && Math.abs(player.pos.y - HELIPAD.y) < 0.05, `walked onto the roof beside the pad: ${player.pos.x.toFixed(1)}, ${player.pos.y.toFixed(2)}, ${player.pos.z.toFixed(1)}`);
  walk(Math.PI / 2, () => player.pos.x < 61, 12);
  assert.ok(player.pos.x > 61.4, `the west rail stops a walker at the roof edge: x ${player.pos.x.toFixed(2)}`);
});

// ---------------------------------------------------------------- CITY-06: where a bought vehicle stands
test('CITY-06: a parked vehicle stays where it was left this session; on reload it returns to the slot in the save', () => {
  const city = normalizeCity({ schema: 1, plots: [], vehicles: [{ id: 'vehicle-1', model: 'van', bay: 2, purchasedAt: 1 }, { id: 'vehicle-2', model: 'suv', bay: 0, apron: 1, purchasedAt: 1 }] });
  const parked = { x: 40, z: 120, yaw: 0.4 };
  assert.deepEqual(garagePose(city, 'vehicle-1', parked), parked, 'session pose wins');
  assert.deepEqual(garagePose(city, 'vehicle-1'), { x: GARAGE.bays[2].x, z: GARAGE.bays[2].z, yaw: 0 }, 'reload: its bay');
  assert.deepEqual(garagePose(city, 'vehicle-2'), { ...GARAGE.apron[1] }, 'reload: its kerb slot');
  // Each model's collider uses its own footprint and height, rotated with the car.
  const van = poseBox({ x: 10, z: 20, yaw: Math.PI / 2 }, { w: 1.35, l: 2.52 }, 2.43);
  assert.ok(Math.abs(van.maxX - van.minX - 5.04) < 1e-9 && Math.abs(van.maxZ - van.minZ - 2.7) < 1e-9 && van.top === 2.43);
});
