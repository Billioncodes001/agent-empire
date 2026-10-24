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
let nonce = 0;
/** Purchases carry a client nonce; the helper adds a fresh one unless the test supplies its own. */
const act = (s: EmpireState, a: EmpireAction) =>
  applyCityAction(s, (a.kind === 'buy-vehicle' || a.kind === 'buy-plot') && !('nonce' in a) ? { ...a, nonce: `test-nonce-${++nonce}` } : a, 2000, text, () => {});

test('a pre-FREE-09 save (no city block) loads unchanged into the original district on the host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'free09-'));
  const old = founded() as Partial<EmpireState>;
  delete old.city;
  writeFileSync(join(dir, 'empire.json'), JSON.stringify(old));
  const e = new Empire(dir, () => {});
  assert.deepEqual(e.state.city, { schema: 1, plots: [], vehicles: [], nonces: [] });
  assert.equal(e.state.funds, old.funds);
  assert.deepEqual(e.state.sectors, old.sectors);
  assert.equal(e.state.version, 2);
  // The garage purchase persists across a restart.
  assert.equal(e.action({ kind: 'buy-vehicle', model: 'van', nonce: 'restart-0001' }), undefined);
  const again = new Empire(dir, () => {});
  assert.equal(again.state.city!.vehicles[0].model, 'van');
  assert.equal(JSON.parse(readFileSync(join(dir, 'empire.json'), 'utf8')).city.vehicles.length, 1);
});

test('the cloud snapshot validator accepts old saves and rejects malformed city blocks', () => {
  const old = founded() as Partial<EmpireState>;
  delete old.city;
  assert.deepEqual(validateEmpire(old).city, { schema: 1, plots: [], vehicles: [], nonces: [] });
  assert.throws(() => validateEmpire({ ...old, city: { schema: 1, plots: ['nowhere'], vehicles: [] } }), /unknown plot/);
  assert.throws(() => normalizeCity({ schema: 1, plots: [], vehicles: [{ id: 'vehicle-1', model: 'van', bay: 9, purchasedAt: 1 }] }), /bay/);
  assert.throws(() => normalizeCity({ schema: 1, plots: [], vehicles: [{ id: 'vehicle-1', model: 'van', bay: 0, purchasedAt: 1 }, { id: 'vehicle-2', model: 'suv', bay: 0, purchasedAt: 1 }] }), /bay/);
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
  for (const a of [{ kind: 'buy-plot', plot: 'harbour-quay', nonce: 'parity-p1' }, { kind: 'buy-plot', plot: 'harbour-quay', nonce: 'parity-p2' }, { kind: 'buy-vehicle', model: 'coupe', nonce: 'parity-v1' }, { kind: 'buy-vehicle', model: 'coupe', nonce: 'parity-v1' }, { kind: 'vehicle-spawn', vehicle: 'vehicle-1' }] as EmpireAction[]) {
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

// ---------------------------------------------------------------- independent review fixes
test('review 1: plots cannot be bought before founding', () => {
  const fresh = initialEmpire(1000);
  assert.equal(act(fresh, { kind: 'buy-plot', plot: 'harbour-yard' }), 'Complete founding setup first');
  assert.equal(fresh.funds, 100000);
  assert.equal(fresh.economy.ledger.length, 0);
});

test('review 2: a repeated purchase nonce (double click, cloud intent replay) buys once, in host and cloud rules', () => {
  const host = founded(), cloud = founded();
  const buy: EmpireAction = { kind: 'buy-vehicle', model: 'suv', nonce: 'click-abc12345' };
  assert.equal(act(host, buy), undefined);
  assert.equal(act(host, buy), 'This purchase was already made');
  assert.equal(applyEmpireAction(cloud, buy, 2000), undefined);
  assert.equal(applyEmpireAction(cloud, buy, 2000), 'This purchase was already made');
  assert.equal(host.city!.vehicles.length, 1);
  assert.equal(cloud.city!.vehicles.length, 1);
  const plot: EmpireAction = { kind: 'buy-plot', plot: 'harbour-yard', nonce: 'click-plot0001' };
  assert.equal(act(host, plot), undefined);
  host.city!.plots = []; // even if the plot were released, the same click cannot buy it twice
  assert.equal(act(host, plot), 'This purchase was already made');
  // A purchase without a valid nonce is refused; the list of remembered nonces stays bounded.
  assert.equal(applyCityAction(host, { kind: 'buy-vehicle', model: 'van' } as EmpireAction, 2000, text, () => {}), 'Invalid purchase request');
  assert.equal(act(host, { kind: 'buy-plot', plot: 'moon' as never, nonce: 'refused-0001' }), 'Unknown plot');
  assert.ok(!host.city!.nonces!.includes('refused-0001'), 'a refused purchase does not consume its nonce');
  host.city!.nonces = Array.from({ length: 32 }, (_, i) => `older-nonce-${i}`);
  assert.equal(act(host, { kind: 'buy-plot', plot: 'harbour-quay', nonce: 'newest-0001' }), undefined);
  assert.equal(host.city!.nonces!.length, 32);
  assert.equal(host.city!.nonces!.at(-1), 'newest-0001');
  assert.throws(() => normalizeCity({ schema: 1, plots: [], vehicles: [], nonces: Array.from({ length: 40 }, (_, i) => `nonce-${i}-aaaa`) }), /nonces/);
});

test('review 5: normalizeCity copies known fields only and rejects unsafe ids and purchase times', () => {
  const ok = normalizeCity({ schema: 1, plots: [], vehicles: [{ id: 'vehicle-1', model: 'van', bay: 0, purchasedAt: 5, extra: '<b>' }], junk: 1 } as never);
  assert.deepEqual(ok, { schema: 1, plots: [], vehicles: [{ id: 'vehicle-1', model: 'van', bay: 0, purchasedAt: 5 }], nonces: [] });
  assert.throws(() => normalizeCity({ schema: 1, plots: [], vehicles: [{ id: 'x"]', model: 'van', bay: 0, purchasedAt: 5 }] }), /vehicle id/);
  assert.throws(() => normalizeCity({ schema: 1, plots: [], vehicles: [{ id: 'vehicle-1', model: 'van', bay: 0, purchasedAt: -1 }] }), /purchase time/);
});

test('review (optional): extra action fields never reach the ledger label', () => {
  const s = founded();
  assert.equal(act(s, { kind: 'buy-plot', plot: 'harbour-yard', site: 'hospital' } as never), undefined);
  assert.equal(s.economy.ledger[0].label, 'District plot purchase · Harbour Yard parcel');
});
