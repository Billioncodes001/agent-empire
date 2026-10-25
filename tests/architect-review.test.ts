/**
 * CITY-10 security review (changes requested on 0bf9e49): one regression test per finding, from the reviewer's probes
 * (scratchpad c10/probe). Each failed before its fix. Fake model clients only; any network call fails the test.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArchitectError, ArchitectService, architectTokenBound, parseArchitectAnswer, type ArchitectInboxPort, type ArchitectPorts } from '../src/server/architect.js';
import { ChiefBrain, type ChatFn } from '../src/server/chief.js';
import { writeJsonAtomic } from '../src/server/persistence.js';
import { DEFAULT_CHIEF_SETTINGS, type ChiefSettings } from '../src/shared/chief.js';
import { ANCHORS, LOTS, applyChanges, emptyWorld, footprintOf, placementProblem } from '../src/shared/world.js';
import { avoidFromUndo } from '../src/shared/world-journal.js';

const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = (() => { throw new Error('network call attempted in an architect review test'); }) as typeof fetch; });
test.after(() => { globalThis.fetch = realFetch; });

const local = (mo: number, d: number, h: number, m = 0) => new Date(2026, mo, d, h, m).getTime();
const PREMIUM: ChiefSettings = { ...DEFAULT_CHIEF_SETTINGS, premiumModel: 'm', premiumPrice: [3, 15] };

function counting(text = '{"changes":[]}', usage = { input: 0, output: 0 }, usd: number | null = null) {
  const calls: number[] = [];
  const chat: ChatFn = (p) => {
    calls.push(1);
    if (text === 'hang') return new Promise(() => {});
    return Promise.resolve({ text, model: p.model, usage, cost: { usd, kind: p.kind === 'local' ? 'local' as const : 'paid-estimate' as const, label: '' } });
  };
  return { chat, calls };
}
function inboxSpy() {
  const items: { id: string; title: string; detail: string }[] = [];
  const port: ArchitectInboxPort = { raise: (f) => { const id = `A${items.length + 1}`; items.push({ id, title: f.title, detail: f.detail }); return id; }, resolve: () => {} };
  return { items, port };
}
function make(dir: string, clock: { t: number }, over: Partial<ArchitectPorts> = {}) {
  return new ArchitectService(dir, { host: 'server', keys: () => ({ ANTHROPIC_API_KEY: 'sk-test-not-real' }), chiefSettings: () => PREMIUM, now: () => clock.t, ...over });
}
const tmp = () => mkdtempSync(path.join(tmpdir(), 'architect-review-'));
const clean = (dir: string) => { try { chmodSync(path.join(dir, 'world'), 0o700); } catch { /* absent */ } rmSync(dir, { recursive: true, force: true }); };

// ---- 1. Failed saves -------------------------------------------------------------------------------------------

test('review 1: a read-only world directory stops the run before any paid call; nothing is paid twice after a restart', async () => {
  const dir = tmp();
  const clock = { t: local(9, 25, 3) };
  const { chat, calls } = counting();
  try {
    const a = make(dir, clock, { chat });
    a.updateSettings({ enabled: true, engine: 'premium' });
    chmodSync(path.join(dir, 'world'), 0o500);
    await assert.rejects(a.runNow('CEO'), (e: ArchitectError) => e.status === 503);
    assert.equal(calls.length, 0, 'no provider call without a saved run record');
    assert.ok(a.state().storageError);
    chmodSync(path.join(dir, 'world'), 0o700);
    const b = make(dir, clock, { chat });
    const r = await b.runNow('CEO');
    assert.equal(calls.length, 1, 'exactly one paid call in total for the day');
    assert.equal(r.engine, 'premium');
  } finally { clean(dir); }
});

test('review 1: the pre-charge save failing stops the paid call', async () => {
  const dir = tmp();
  const clock = { t: local(9, 25, 3) };
  const { chat, calls } = counting();
  let stateWrites = 0, failFrom = Infinity;
  const writeJson = (file: string, value: unknown) => {
    if (file.endsWith('architect.json') && ++stateWrites >= failFrom) throw new Error('ENOSPC: no space left on device');
    writeJsonAtomic(file, value);
  };
  try {
    const a = make(dir, clock, { chat, writeJson });
    a.updateSettings({ enabled: true, engine: 'premium' });
    failFrom = stateWrites + 2; // the run-start save succeeds; the pre-charge save fails
    const r = await a.runNow('CEO').catch((e) => e);
    assert.equal(calls.length, 0, 'no provider call when the worst-case charge could not be saved');
    assert.ok(r instanceof ArchitectError || r.status !== 'applied');
  } finally { clean(dir); }
});

test('review 1: a journal save failing after the world is written still leaves an undo record on disk', async () => {
  const dir = tmp();
  const clock = { t: local(9, 25, 3) };
  let failJournal = false;
  const writeJson = (file: string, value: unknown) => { if (failJournal && file.endsWith('journal.json')) throw new Error('EIO'); writeJsonAtomic(file, value); };
  try {
    const a = make(dir, clock, { chiefSettings: () => DEFAULT_CHIEF_SETTINGS, writeJson });
    a.updateSettings({ enabled: true });
    failJournal = true;
    const run = await a.runNow('CEO');
    const world = JSON.parse(readFileSync(path.join(dir, 'world', 'additions.json'), 'utf8'));
    const b = make(dir, clock, { chiefSettings: () => DEFAULT_CHIEF_SETTINGS });
    const saved = b.state().runs.find((r) => r.id === run.id);
    assert.equal(saved?.changes.length, world.additions.length, 'every addition on disk has its change recorded');
    if (world.additions.length) {
      const after = b.undo(saved!.changes[0].id, 'CEO');
      assert.equal(after.world.additions.length, world.additions.length - 1);
    }
  } finally { clean(dir); }
});

// ---- 2. Corrupt architect.json ------------------------------------------------------------------------------------

for (const [label, runs] of [
  ['old run, changes not a list', [{ id: 'R1', startedAt: 0, changes: 5 }]],
  ['old run, change without id', [{ id: 'R1', startedAt: 0, changes: [{}] }]],
  ['recent run, changes a string', [{ id: 'R1', startedAt: Date.now(), changes: 'x' }]],
  ['run without a day', [{ id: 'R1', startedAt: Date.now(), status: 'applied', changes: [] }]],
] as const) {
  test(`review 2: a corrupt architect.json (${label}) is refused and preserved; state() never throws`, () => {
    const dir = tmp();
    try {
      mkdirSync(path.join(dir, 'world'));
      const raw = JSON.stringify({ version: 1, settings: {}, spend: {}, nextRun: 2, nextChange: 1, runs });
      writeFileSync(path.join(dir, 'world', 'architect.json'), raw);
      const a = make(dir, { t: Date.now() });
      const s = a.state();
      assert.match(s.storageError ?? '', /architect\.json/);
      assert.throws(() => a.undo('C1', 'CEO'), (e: ArchitectError) => e instanceof ArchitectError && e.status === 503);
      assert.equal(readFileSync(path.join(dir, 'world', 'architect.json'), 'utf8'), raw, 'the file is preserved');
    } finally { clean(dir); }
  });
}

// ---- 3. "Repair" from a model ------------------------------------------------------------------------------------

test('review 3: a model cannot claim "Repair" to bypass avoid-rules or take the Repair label', () => {
  const META = { day: '2026-10-25', runId: 'R1', engine: 'free' as const, at: 1, maxChanges: 5 };
  const spot = (lot: string, dx: number) => { const l = LOTS.find((x) => x.id === lot)!; const f = footprintOf('flora/shrub', 0, 0, 0); return { x: Math.round((l.minX - f.minX + dx) * 4) / 4, z: Math.round((l.minZ - f.minZ + 1) * 4) / 4 }; };
  const placed = applyChanges(emptyWorld(), [{ op: 'place', model: 'flora/shrub', lot: 'harbour-yard-west', ...spot('harbour-yard-west', 1), yaw: 0, reason: 'Green' }], META);
  assert.ok('ok' in placed);
  const avoid = [{ id: 'V1', model: 'flora/shrub', lot: 'harbour-quay-green', text: 'No shrubs here', at: 1, source: 'owner' as const }];
  const sneaky = applyChanges(placed.ok.doc, [{ op: 'move', id: 'W1', ...spot('harbour-quay-green', 1), yaw: 0, lot: 'harbour-quay-green', reason: 'Repair: nicer here' }], { ...META, avoid });
  assert.ok('error' in sneaky, 'a model engine gets no repair exemption');
  assert.match(sneaky.error, /asked not to build/);
  const label = applyChanges(placed.ok.doc, [{ op: 'remove', id: 'W1', reason: 'Repair: tidy' }], META);
  assert.ok('ok' in label);
  assert.equal(label.ok.applied[0].repair, false, 'only rule-based growth marks repairs');
  for (const reason of ['Repair: nicer', 'repair — moved', '  REPAIR it']) {
    const r = parseArchitectAnswer(JSON.stringify({ changes: [{ op: 'remove', id: 'W1', reason }] }), 3);
    assert.ok('error' in r, reason);
    assert.match((r as { error: string }).error, /Repair/);
  }
});

// ---- 4. Clock -----------------------------------------------------------------------------------------------------

test('review 4: moving the clock back neither resets the month tally nor allows paid calls while behind', async () => {
  const dir = tmp();
  const clock = { t: local(9, 25, 3) };
  const { chat, calls } = counting();
  try {
    const a = make(dir, clock, { chat });
    a.updateSettings({ enabled: true, engine: 'premium', dailyCapUsd: 0.05, monthlyCapUsd: 0.1 });
    await a.runNow('CEO');
    const oct = a.state().budget.spentMonthUsd;
    assert.ok(oct > 0);
    clock.t = local(8, 30, 3); // back to September
    const behind = await a.runNow('CEO');
    assert.equal(calls.length, 1, 'no paid call while the clock is behind the last one seen');
    assert.equal(behind.engine, 'rules');
    assert.match(behind.note ?? '', /clock/i);
    clock.t = local(9, 27, 3);
    assert.equal(a.state().budget.spentMonthUsd, oct, 'October still counts what was spent in October');
  } finally { clean(dir); }
});

test('review 4: never two paid runs within 23 hours (re-review 3: 23, so the daily start never creeps), whatever the local date says', async () => {
  const dir = tmp();
  const clock = { t: local(9, 25, 3) };
  const { chat, calls } = counting();
  try {
    const a = make(dir, clock, { chat });
    a.updateSettings({ enabled: true, engine: 'premium', monthlyCapUsd: 1 });
    await a.runNow('CEO');
    clock.t = local(9, 26, 1); // a new local day, 22 hours later
    const early = await a.runNow('CEO');
    assert.equal(calls.length, 1);
    assert.equal(early.engine, 'rules');
    assert.match(early.note ?? '', /23 hours/);
    // The scheduler waits for the gap instead of spending its day on rules.
    clock.t = local(9, 27, 2, 59);
    assert.equal(await a.tick(), undefined);
    clock.t = local(9, 27, 3, 0);
    assert.equal((await a.tick())?.engine, 'premium');
    assert.equal(calls.length, 2);
  } finally { clean(dir); }
});

// ---- 5. Anchor undo ------------------------------------------------------------------------------------------------

test('review 5: undoing an anchored placement avoids that anchor only, not the model everywhere', () => {
  const an = ANCHORS.find((x) => x.id === 'terrace-1')!;
  const rule = avoidFromUndo({ op: 'place', model: 'commercial/detail-parasol-a', anchor: an.id, additionId: 'W1' }, 1)!;
  assert.equal(rule.anchor, an.id);
  const avoid = [{ id: 'V1', ...rule }];
  assert.match(placementProblem({ model: 'commercial/detail-parasol-a', anchor: an.id, x: an.x, z: an.z, yaw: an.yaw }, [], { avoid })!, /asked not to build/);
  const other = ANCHORS.find((x) => x.id === 'terrace-2')!;
  assert.equal(placementProblem({ model: 'commercial/detail-parasol-a', anchor: other.id, x: other.x, z: other.z, yaw: other.yaw }, [], { avoid }), undefined);
  const l = LOTS.find((x) => x.id === 'meridian-north-verge')!;
  const f = footprintOf('commercial/detail-parasol-a', 0, 0, 0);
  assert.equal(placementProblem({ model: 'commercial/detail-parasol-a', lot: l.id, x: Math.round((l.minX - f.minX + 1) * 4) / 4, z: Math.round((l.minZ - f.minZ + 1) * 4) / 4, yaw: 0 }, [], { avoid }), undefined);
});

// ---- 6. The chief's budget note -------------------------------------------------------------------------------------

test('review 6: the chief\'s premium budget note says the city architect has its own cap on the same key', () => {
  const dir = tmp();
  try {
    const brain = new ChiefBrain(dir, { keys: () => ({ ANTHROPIC_API_KEY: 'sk-test-not-real' }), office: { create: () => { throw new Error('no'); }, snapshot: () => ({ jobs: [] }) as never }, queue: () => ({ tasks: [], maxWorkers: 0 }), chat: counting().chat });
    brain.updateSettings({ mode: 'premium', premiumModel: 'm', premiumPrice: [3, 15] });
    assert.match(brain.state().budget.note, /city architect has its own premium cap/i);
  } finally { clean(dir); }
});

// ---- Cheap ones ----------------------------------------------------------------------------------------------------

test('review extra: a zero price never enables premium; the token bound is conservative; an interrupted paid run is reported', async () => {
  const dir = tmp();
  const clock = { t: local(9, 25, 3) };
  try {
    const { chat, calls } = counting();
    const a = make(dir, clock, { chat, chiefSettings: () => ({ ...PREMIUM, premiumPrice: [0, 0] }) });
    a.updateSettings({ enabled: true, engine: 'premium' });
    assert.equal(a.state().engine.ready, false);
    assert.equal((await a.runNow('CEO')).engine, 'rules');
    assert.equal(calls.length, 0);
  } finally { clean(dir); }
  const digits = '1234567890,'.repeat(1000);
  assert.ok(architectTokenBound([{ role: 'user', content: digits }]) >= digits.length / 1.5, 'number-heavy JSON is not undercounted');
  assert.ok(architectTokenBound([{ role: 'system', content: '' }, { role: 'user', content: '' }]) >= 8, 'per-message overhead');
  const d2 = tmp();
  try {
    const hang = counting('hang');
    const a = make(d2, clock, { chat: hang.chat });
    a.updateSettings({ enabled: true, engine: 'premium' });
    void a.runNow('CEO');
    await new Promise((r) => setTimeout(r, 20));
    const inbox = inboxSpy();
    make(d2, clock, { inbox: inbox.port });
    assert.equal(inbox.items.length, 1);
    assert.match(inbox.items[0].detail, /interrupted/i);
    assert.match(inbox.items[0].detail, /worst/i);
  } finally { clean(d2); }
});
