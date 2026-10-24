import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { districtLayout, footprint, PLOT_PAD, ROADS, type Box } from '../src/client/world/district-layout';
import { districtAt, GARAGE, PLOTS, VEHICLE_MODELS } from '../src/shared/city';
import { CITY } from '../src/shared/empire';

const overlaps = (a: Box, b: { minX: number; maxX: number; minZ: number; maxZ: number }) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
const rect = (x: number, z: number, w: number, d: number) => ({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });

test('district buildings stay off the streets, plots and garage, inside their own district and the city bounds', () => {
  const { placements } = districtLayout();
  const buildings = placements.filter((p) => p.kit === 'commercial' || p.kit === 'industrial');
  assert.ok(buildings.length >= 25, `${buildings.length} buildings`);
  const keepClear = [
    ...ROADS.map((r) => rect(r.x, r.z, r.w + 4.6 * (r.w > r.d ? 0 : 1), r.d + 4.6 * (r.w > r.d ? 1 : 0))),
    ...PLOTS.map((p) => rect(p.x, p.z, PLOT_PAD.w, PLOT_PAD.d)),
    rect(GARAGE.x, GARAGE.z, GARAGE.width, GARAGE.depth),
  ];
  for (const p of buildings) {
    const f = footprint(p);
    for (const k of keepClear) if (p.model !== 'detail-parasol-a') assert.ok(!overlaps(f, k), `${p.kit}/${p.model} at ${p.x.toFixed(1)},${p.z} overlaps ${JSON.stringify(k)}`);
    assert.equal(districtAt(p.x, p.z), p.district, `${p.model} at ${p.x},${p.z}`);
    assert.ok(f.minX >= 55 && f.maxX <= CITY.maxX && f.maxZ <= CITY.maxZ, `${p.model} within bounds`);
  }
});

test('every model shipped in the city kits is used by the layout or the garage catalogue', () => {
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../src/client/public/models/city/manifest.json'), 'utf8'));
  const used = new Set(districtLayout().placements.map((p) => `${p.kit}/${p.model}`));
  for (const m of VEHICLE_MODELS) used.add(`vehicles/${m.asset}`);
  for (const [kit, data] of Object.entries<{ models: Record<string, unknown> }>(manifest.kits))
    for (const model of Object.keys(data.models)) assert.ok(used.has(`${kit}/${model}`), `${kit}/${model} is shipped but unused`);
});

test('review 3: founding skyline colliders clear the z = 146 road and kerb and stay out of the new districts', async () => {
  const { skylineColliders, FOUNDING_KERB_146 } = await import('../src/client/world/district-layout');
  const layout = districtLayout();
  const road146 = rect(0, 146, 106, 2 * (FOUNDING_KERB_146 - 146));
  for (const c of skylineColliders()) {
    assert.ok(!overlaps(c, road146), `tower collider ${JSON.stringify(c)} intrudes on the z = 146 road or kerb`);
    assert.ok(c.maxX <= 55, `tower collider at x ${c.minX}..${c.maxX} sits in Harbour works`);
    for (const r of ROADS) assert.ok(!overlaps(c, rect(r.x, r.z, r.w, r.d)), 'tower collider on a new street');
    for (const b of layout.colliders) assert.ok(!overlaps(c, b), 'tower collider overlaps a district collider');
  }
});

test('review 4: a bay or kerb slot turns solid only once the sedan and the founder have left it', async () => {
  const { slotClear } = await import('../src/client/world/district-layout');
  const bay = { minX: GARAGE.bays[0].x - 1.1, maxX: GARAGE.bays[0].x + 1.1, minZ: GARAGE.bays[0].z - 2.4, maxZ: GARAGE.bays[0].z + 2.4, top: 0 };
  const away = { position: { x: 0, z: 90 }, rotation: { y: 0 } };
  assert.equal(slotClear(bay, { position: { x: GARAGE.bays[0].x, z: GARAGE.bays[0].z }, rotation: { y: 0 } }, { x: 0, z: 0 }), false, 'sedan parked in the bay');
  assert.equal(slotClear(bay, away, { x: GARAGE.bays[0].x, z: GARAGE.bays[0].z + 2 }), false, 'founder standing in the bay');
  assert.equal(slotClear(bay, away, { x: 72, z: 82 }), true);
});

test('re-review 2: slots use the live sedan pose and footprint while driving, and solid slots stay solid', async () => {
  const { liveCarPose, settleSlots, slotClear } = await import('../src/client/world/district-layout');
  const b = GARAGE.bays[1];
  const bay = { minX: b.x - 1.1, maxX: b.x + 1.1, minZ: b.z - 2.4, maxZ: b.z + 2.4, top: 0 };
  // city.car still holds last frame's pose outside; the controller has already driven the sedan into the bay's edge.
  const stale = { position: { x: b.x, z: 95 }, rotation: { y: 0 } };
  const player = { x: b.x + 2.0, z: b.z }; // car centre outside the bay (2.0 m > 1.1 + 0.4), its body overlapping it
  assert.equal(slotClear(bay, stale, player, true), true, 'the stale pose wrongly says clear');
  assert.equal(slotClear(bay, liveCarPose(true, player, 0, stale), player, true), false, 'the live pose and full body block it');
  assert.deepEqual(liveCarPose(false, player, 1, stale), stale, 'on foot the parked sedan pose is used');
  const slots = [{ occupied: true, collider: { ...bay, top: 1.7 } }, { occupied: true, collider: { ...bay, top: 1.7 } }];
  settleSlots(slots, [true, false]);
  assert.equal(slots[0].collider.top, 1.7, 'an occupied solid slot stays solid when another vehicle changes');
  assert.equal(slots[1].collider.top, 0, 'a freed slot opens');
});
