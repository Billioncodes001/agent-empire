/**
 * CITY-10 final review (approved at 0d7e3cf, scratchpad c10c/probe/final.test.ts): a thrashing clock cannot book repeated
 * paid runs, and an `applying` run is reconciled by content, not only by revision. Each failed before its fix.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArchitectError, ArchitectService, type ArchitectPorts } from '../src/server/architect.js';
import type { ChatFn } from '../src/server/chief.js';
import { DEFAULT_CHIEF_SETTINGS, type ChiefSettings } from '../src/shared/chief.js';

const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = (() => { throw new Error('network call attempted'); }) as typeof fetch; });
test.after(() => { globalThis.fetch = realFetch; });

const H = 3_600_000;
const local = (y: number, mo: number, d: number, h: number, m = 0) => new Date(y, mo, d, h, m).getTime();
const PREMIUM: ChiefSettings = { ...DEFAULT_CHIEF_SETTINGS, premiumModel: 'm', premiumPrice: [3, 15] };
function counting() {
  const calls: number[] = [];
  const chat: ChatFn = async (p) => { calls.push(1); return { text: '{"changes":[]}', model: p.model, usage: { input: 0, output: 0 }, cost: { usd: null, kind: 'paid-estimate', label: '' } }; };
  return { chat, calls };
}
function make(dir: string, clock: { t: number }, over: Partial<ArchitectPorts> = {}) {
  const inbox = { items: [] as { title: string; detail: string }[] };
  const a = new ArchitectService(dir, { host: 'server', keys: () => ({ ANTHROPIC_API_KEY: 'sk-test-not-real' }), chiefSettings: () => PREMIUM, now: () => clock.t,
    inbox: { raise: (f) => { inbox.items.push({ title: f.title, detail: f.detail }); return `A${inbox.items.length}`; }, resolve: () => {} }, ...over });
  return Object.assign(a, { inboxItems: inbox.items });
}
const tmp = () => mkdtempSync(path.join(tmpdir(), 'architect-final-'));

// ---- 1. A thrashing clock ------------------------------------------------------------------------------------------

test('final 1: a thrashing clock books at most one paid call per 23 h of real (monotonic) time in a process', async () => {
  const dir = tmp();
  const A = local(2026, 9, 20, 10);
  const clock = { t: A };
  const real = { t: 0 };
  const { chat, calls } = counting();
  try {
    const a = make(dir, clock, { chat, monotonic: () => real.t });
    a.updateSettings({ enabled: true, engine: 'premium', dailyCapUsd: 1, monthlyCapUsd: 10 });
    for (let cycle = 0; cycle < 6; cycle++) {
      real.t = cycle * 60_000;
      clock.t = A + cycle * 60_000;
      await a.runNow('CEO').catch(() => undefined);
      // Readings behind the mark that advance 73 h in two steps, on dates before A (the 72 h reset), then a run there.
      clock.t = A - 200 * H; a.state();
      clock.t = A - 200 * H + 73 * H; a.state();
      await a.runNow('CEO').catch(() => undefined);
    }
    assert.equal(calls.length, 1, 'one paid call in total');
    // Rule-based growth was unaffected: every other run still happened, at US$0.
    assert.ok(a.state().runs.filter((r) => r.engine === 'rules').length >= 6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('final 1: across a restart with the clock moved back, no second paid call before 23 h of real time', async () => {
  const dir = tmp();
  const clock = { t: local(2026, 9, 25, 3) };
  const { chat, calls } = counting();
  try {
    const a = make(dir, clock, { chat, monotonic: () => 0 });
    a.updateSettings({ enabled: true, engine: 'premium', dailyCapUsd: 1, monthlyCapUsd: 10 });
    await a.runNow('CEO');
    assert.equal(calls.length, 1);
    for (const back of [1, 5, 40]) {
      clock.t = local(2026, 9, 25, 3) - back * 24 * H; // an earlier date, even an earlier month
      const b = make(dir, clock, { chat, monotonic: () => 0 });
      const r = await b.runNow('CEO').catch((e) => e);
      assert.equal(calls.length, 1, `restart ${back} days back: no paid call`);
      if (!(r instanceof ArchitectError)) assert.equal(r.engine, 'rules');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('final 1: the monthly cap also holds over the last 30 real days, so booking to a new or old month cannot multiply it', async () => {
  const dir = tmp();
  const clock = { t: local(2026, 9, 30, 3) };
  const { chat, calls } = counting();
  try {
    const a = make(dir, clock, { chat, monotonic: () => 0 });
    a.updateSettings({ enabled: true, engine: 'premium', dailyCapUsd: 0.05, monthlyCapUsd: 0.05 });
    await a.runNow('CEO');
    assert.equal(calls.length, 1);
    // Three days later by the wall clock: a new calendar month (its tally is empty), 36 h of trusted time on restart.
    clock.t = local(2026, 10, 2, 3);
    const b = make(dir, clock, { chat, monotonic: () => 0 });
    assert.equal(b.state().budget.spentMonthUsd, 0, 'the calendar month is new');
    const r = await b.runNow('CEO');
    assert.equal(calls.length, 1, 'no paid call: the last 30 days already used the monthly cap');
    assert.equal(r.engine, 'rules');
    assert.match(r.note ?? '', /30 days/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 2. Reconcile by content ---------------------------------------------------------------------------------------

function applyingFile(worldRevision: number) {
  const after = { id: 'W1', model: 'flora/shrub', x: 60, z: 34, yaw: 0, lot: 'meridian-north-verge', day: '2026-10-25', runId: 'R1', engine: 'rules', reason: 'Green', addedAt: 1 };
  const run = { id: 'R1', day: '2026-10-25', trigger: 'manual', engine: 'rules', status: 'applying', startedAt: Date.now(), engineLabel: 'Rule-based growth · US$0', costLabel: 'US$0', costUsd: 0, worldRevision, changes: [{ id: 'C1', op: 'place', additionId: 'W1', model: 'flora/shrub', lot: 'meridian-north-verge', reason: 'Green', repair: false, after }] };
  return { state: { version: 1, settings: { enabled: true }, spend: {}, lastRunDay: '2026-10-25', nextRun: 2, nextChange: 2, runs: [run] }, after };
}
for (const [label, rev, addition, expect] of [
  ['crash before the world write', 0, 'none', 'interrupted'],
  ['crash after the world write', 1, 'same', 'applied'],
  ['revision matches but the addition is missing', 1, 'none', 'refused'],
  ['revision matches but the addition differs', 1, 'moved', 'refused'],
  ['revision one behind but the addition is there', 0, 'same', 'refused'],
  ['world two ahead', 3, 'same', 'refused'],
] as const) {
  test(`final 2: applying reconcile — ${label} → ${expect}`, () => {
    const dir = tmp();
    try {
      mkdirSync(path.join(dir, 'world'));
      const f = applyingFile(1);
      const additions = addition === 'none' ? [] : addition === 'same' ? [f.after] : [{ ...f.after, x: f.after.x + 2 }];
      writeFileSync(path.join(dir, 'world', 'additions.json'), JSON.stringify({ schema: 1, revision: rev, additions, nextId: 2 }));
      const raw = JSON.stringify(f.state);
      writeFileSync(path.join(dir, 'world', 'architect.json'), raw);
      const a = make(dir, { t: Date.now() });
      const s = a.state();
      if (expect === 'refused') {
        assert.match(s.storageError ?? '', /architect\.json/);
        assert.equal(readFileSync(path.join(dir, 'world', 'architect.json'), 'utf8'), raw, 'preserved');
        return;
      }
      assert.equal(s.storageError, undefined);
      assert.equal(s.runs[0].status, expect);
      if (expect === 'applied') {
        assert.equal(s.runs[0].changes.length, 1);
        assert.equal(a.inboxItems.length, 1, 'a reconciled run raises its daily summary');
        assert.match(a.inboxItems[0].title, /City architect daily summary/);
        assert.match(a.journalMarkdown(), /Green/, 'and its journal entry');
        assert.equal(a.undo('C1', 'CEO').world.additions.length, 0);
      } else assert.equal(s.runs[0].changes.length, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('final 2: restore fuzz — odd values in any stored field never throw outside ArchitectError', () => {
  const base = applyingFile(1).state as any;
  Object.assign(base.runs[0], { status: 'interrupted', costUsd: 0.01 });
  delete base.runs[0].worldRevision;
  const odd = [null, 5, -1, 'x', '', [], {}, true, 1e308, NaN];
  const targets: [string, (s: any, v: unknown) => void][] = [];
  for (const k of Object.keys(base.runs[0])) targets.push([`run.${k}`, (s, v) => { s.runs[0][k] = v; }]);
  for (const k of Object.keys(base.runs[0].changes[0])) targets.push([`change.${k}`, (s, v) => { s.runs[0].changes[0][k] = v; }]);
  for (const k of Object.keys(base.runs[0].changes[0].after)) targets.push([`after.${k}`, (s, v) => { s.runs[0].changes[0].after[k] = v; }]);
  for (const k of ['settings', 'spend', 'lastRunDay', 'nextRun', 'nextChange', 'expiredChange']) targets.push([k, (s, v) => { s[k] = v; }]);
  targets.push(['spend.days', (s, v) => { s.spend = { days: v, months: {}, maxSeenAt: 1 }; }]);
  targets.push(['spend.behindSince', (s, v) => { s.spend = { days: {}, months: {}, maxSeenAt: 1, behindSince: v }; }]);
  targets.push(['spend.paid', (s, v) => { s.spend = { days: {}, months: {}, maxSeenAt: 1, trustedAt: 1, paid: v }; }]);
  const bad: string[] = [];
  for (const [label, set] of targets) for (const v of odd) {
    const dir = tmp();
    try {
      mkdirSync(path.join(dir, 'world'));
      const s = structuredClone(base); set(s, v);
      writeFileSync(path.join(dir, 'world', 'architect.json'), JSON.stringify(s));
      const a = make(dir, { t: Date.now() });
      a.state(); a.journalMarkdown();
      for (const act of [() => a.undo('C1', 'CEO'), () => a.revertRun('R1', 'CEO')]) { try { act(); } catch (e) { if (!(e instanceof ArchitectError)) throw e; } }
    } catch (e) { bad.push(`${label}=${JSON.stringify(v)}: ${(e as Error).message.slice(0, 80)}`); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  assert.deepEqual(bad, []);
});
