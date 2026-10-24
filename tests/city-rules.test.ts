import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialEmpire, type EmpireAction, type EmpireState } from '../src/shared/empire';
import { applyCityAction, type CityActionText } from '../src/shared/economy-rules';
import { freeApronSlot, GARAGE, normalizeCity, PLOTS, VEHICLE_MODELS, districtAt } from '../src/shared/city';
import { Empire } from '../src/server/empire';
import { validateEmpire } from '../src/cloud/schema';
import { applyEmpireAction } from '../src/cloud/economy';

const text = new Proxy({}, { get: () => () => '' }) as CityActionText;
const founded = () => {
  const s = initialEmpire(1000);
  assert.equal(applyCityAction(s, { kind: 'found', sites: ['cafe'] }, 1000, text, () => {}), undefined);
  return s;
};
const act = (s: EmpireState, a: EmpireAction) => applyCityAction(s, a, 2000, text, () => {});

test('a pre-FREE-09 save (no city block) loads unchanged into the original district on the host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'free09-'));
  const old = founded() as Partial<EmpireState>;
  delete old.city;
  writeFileSync(join(dir, 'empire.json'), JSON.stringify(old));
  const e = new Empire(dir, () => {});
  assert.deepEqual(e.state.city, { schema: 1, plots: [], vehicles: [] });
  assert.equal(e.state.funds, old.funds);
  assert.deepEqual(e.state.sectors, old.sectors);
  assert.equal(e.state.version, 2);
  // The garage purchase persists across a restart.
  assert.equal(e.action({ kind: 'buy-vehicle', model: 'van' }), undefined);
  const again = new Empire(dir, () => {});
  assert.equal(again.state.city!.vehicles[0].model, 'van');
  assert.equal(JSON.parse(readFileSync(join(dir, 'empire.json'), 'utf8')).city.vehicles.length, 1);
});

test('the cloud snapshot validator accepts old saves and rejects malformed city blocks', () => {
  const old = founded() as Partial<EmpireState>;
  delete old.city;
  assert.deepEqual(validateEmpire(old).city, { schema: 1, plots: [], vehicles: [] });
  assert.throws(() => validateEmpire({ ...old, city: { schema: 1, plots: ['nowhere'], vehicles: [] } }), /unknown plot/);
  assert.throws(() => normalizeCity({ schema: 1, plots: [], vehicles: [{ id: 'a', model: 'van', bay: 9, purchasedAt: 1 }] }), /bay/);
  assert.throws(() => normalizeCity({ schema: 1, plots: [], vehicles: [{ id: 'a', model: 'van', bay: 0, purchasedAt: 1 }, { id: 'b', model: 'suv', bay: 0, purchasedAt: 1 }] }), /bay/);
});

test('vehicle purchases spend fictional credits through the capital ledger and refuse invalid requests', () => {
  const fresh = initialEmpire(1000);
  assert.equal(act(fresh, { kind: 'buy-vehicle', model: 'van' }), 'Complete founding setup first');
  const s = founded();
  const before = s.funds;
  assert.equal(act(s, { kind: 'buy-vehicle', model: 'jet' as never }), 'Unknown vehicle');
  assert.equal(act(s, { kind: 'buy-vehicle', model: 'suv' }), undefined);
  const suv = VEHICLE_MODELS.find((m) => m.id === 'suv')!;
  assert.equal(s.funds, before - suv.cost);
  assert.deepEqual(s.economy.ledger[0], { ...s.economy.ledger[0], label: 'Garage vehicle purchase · Luxury SUV', capital: suv.cost, revenue: 0 });
  assert.equal(s.city!.vehicles[0].bay, 0);
  for (let i = 1; i < GARAGE.bays.length; i++) assert.equal(act(s, { kind: 'buy-vehicle', model: 'hatchback' }), undefined);
  assert.equal(act(s, { kind: 'buy-vehicle', model: 'hatchback' }), 'Every garage bay is occupied');
  const poor = founded();
  poor.funds = 100;
  assert.equal(act(poor, { kind: 'buy-vehicle', model: 'hatchback' }), 'Insufficient simulation credits');
  assert.equal(poor.funds, 100);
  assert.deepEqual(poor.city!.vehicles, []);
});

test('host and cloud apply identical plot and vehicle rules', () => {
  const host = founded(), cloud = founded();
  for (const a of [{ kind: 'buy-plot', plot: 'harbour-quay' }, { kind: 'buy-plot', plot: 'harbour-quay' }, { kind: 'buy-vehicle', model: 'coupe' }, { kind: 'vehicle-spawn', vehicle: 'vehicle-1' }] as EmpireAction[]) {
    assert.equal(act(host, a), applyEmpireAction(cloud, a, 2000));
  }
  assert.deepEqual(host.city, cloud.city);
  assert.equal(host.funds, cloud.funds);
  assert.equal(act(host, { kind: 'buy-plot', plot: 'harbour-quay' }), 'Plot already owned');
  assert.equal(act(host, { kind: 'buy-plot', plot: 'moon' as never }), 'Unknown plot');
});

test('bringing a vehicle out uses a free apron slot; occupied slots (saved or reported live) are skipped or refused', () => {
  const s = founded();
  for (const model of ['van', 'coupe', 'suv'] as const) act(s, { kind: 'buy-vehicle', model });
  const funds = s.funds;
  // The live sedan sits on slot 0: the van takes slot 1.
  assert.equal(act(s, { kind: 'vehicle-spawn', vehicle: 'vehicle-1', blocked: [0] }), undefined);
  assert.equal(s.city!.vehicles[0].apron, 1);
  assert.equal(act(s, { kind: 'vehicle-spawn', vehicle: 'vehicle-1' }), 'Vehicle is already outside');
  assert.equal(act(s, { kind: 'vehicle-spawn', vehicle: 'vehicle-2' }), undefined);
  assert.equal(s.city!.vehicles[1].apron, 0);
  assert.match(act(s, { kind: 'vehicle-spawn', vehicle: 'vehicle-3' })!, /apron is occupied/);
  assert.equal(s.city!.vehicles[2].apron, undefined);
  assert.equal(act(s, { kind: 'vehicle-store', vehicle: 'vehicle-1' }), undefined);
  assert.equal(freeApronSlot(s.city!), 1);
  assert.equal(freeApronSlot(s.city!, [1]), -1);
  assert.equal(act(s, { kind: 'vehicle-store', vehicle: 'vehicle-1' }), 'Vehicle is already in its bay');
  assert.equal(act(s, { kind: 'vehicle-spawn', vehicle: 'nope' }), 'Unknown vehicle');
  assert.equal(s.funds, funds, 'moving vehicles is free');
});

test('plots and the garage sit inside the new districts', () => {
  for (const p of PLOTS) assert.equal(districtAt(p.x, p.z), p.district, p.id);
  assert.equal(districtAt(GARAGE.x, GARAGE.z), 'business');
  assert.equal(districtAt(-24, 48), 'founding');
});
