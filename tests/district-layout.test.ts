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
