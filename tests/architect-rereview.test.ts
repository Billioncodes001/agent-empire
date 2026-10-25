/**
 * CITY-10 re-review at c5f4ab4 (scratchpad c10b/probe): the restore blocker and the follow-ups, each failing before its
 * fix. Fake model clients only; any network call fails the test.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArchitectService, type ArchitectPorts } from '../src/server/architect.js';
import type { ChatFn } from '../src/server/chief.js';
import { writeJsonAtomic } from '../src/server/persistence.js';
import { DEFAULT_CHIEF_SETTINGS, type ChiefSettings } from '../src/shared/chief.js';
import { colliderMaySolidify } from '../src/client/world/district-layout.js';

const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = (() => { throw new Error('network call attempted'); }) as typeof fetch; });
test.after(() => { globalThis.fetch = realFetch; });

const local = (y: number, mo: number, d: number, h: number, m = 0) => new Date(y, mo, d, h, m).getTime();
const PREMIUM: ChiefSettings = { ...DEFAULT_CHIEF_SETTINGS, premiumModel: 'm', premiumPrice: [3, 15] };
function counting() {
  const calls: number[] = [];
  const chat: ChatFn = async (p) => { calls.push(1); return { text: '{"changes":[]}', model: p.model, usage: { input: 0, output: 0 }, cost: { usd: null, kind: 'paid-estimate', label: '' } }; };
  return { chat, calls };
}
function make(dir: string, now: () => number, over: Partial<ArchitectPorts> = {}) {
  return new ArchitectService(dir, { host: 'server', keys: () => ({ ANTHROPIC_API_KEY: 'sk-test-not-real' }), chiefSettings: () => PREMIUM, now, inbox: { raise: () => 'A1', resolve: () => {} }, ...over });
}
const tmp = () => mkdtempSync(path.join(tmpdir(), 'architect-rereview-'));

// ---- 1. Blocker: every field startup touches is validated ----------------------------------------------------------

const RUN = { id: 'R1', day: '2026-10-25', trigger: 'manual', engine: 'premium', status: 'interrupted', startedAt: Date.now(), engineLabel: 'x', costLabel: 'y', costUsd: 0.01, changes: [] };
for (const extra of [{ reason: 5 }, { note: 7 }, { reason: 'ok', note: { x: 1 } }, { approvalId: 3 }, { finishedAt: 'soon' }, { reverted: 'yes' }, { worstUsd: 'x' },
  { status: 'applied', changes: [{ id: 'C1', op: 'remove', additionId: 'W1', model: 'flora/shrub', reason: 'x', repair: false, lot: 9, before: { id: 'W1', model: 'flora/shrub', x: 1, z: 1 } }] },
  { status: 'applied', changes: [{ id: 'C1', op: 'remove', additionId: 'W1', model: 'flora/shrub', reason: 'x', repair: false, undone: 'no', before: { id: 'W1', model: 'flora/shrub', x: 1, z: 1 } }] }]) {
  test(`re-review 1: a corrupt run (${JSON.stringify(extra).slice(0, 60)}) never crashes startup and the file is preserved`, () => {
    const dir = tmp();
    try {
      mkdirSync(path.join(dir, 'world'));
      const file = JSON.stringify({ version: 1, settings: {}, spend: {}, nextRun: 2, nextChange: 2, runs: [{ ...RUN, ...extra }] });
      writeFileSync(path.join(dir, 'world', 'architect.json'), file);
      const a = make(dir, () => Date.now());
      assert.match(a.state().storageError ?? '', /architect\.json/);
      assert.equal(readFileSync(path.join(dir, 'world', 'architect.json'), 'utf8'), file);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// ---- 2. A forward clock glitch ------------------------------------------------------------------------------------

test('re-review 2: a forward clock glitch at boot never stops the daily run; status says why; premium resumes once time is consistent', async () => {
  const dir = tmp();
  const clock = { t: local(2027, 9, 25, 3) }; // wrongly a year ahead at first boot
  const { chat, calls } = counting();
  try {
    const a = make(dir, () => clock.t, { chat });
    a.updateSettings({ enabled: true, engine: 'premium', monthlyCapUsd: 10, dailyCapUsd: 1 });
    await a.tick();
    const engines: string[] = [];
    for (let d = 0; d < 30; d++) {
      clock.t = local(2026, 9, 26 + d, 4);
      if (d === 0) {
        const s = a.state();
        assert.equal(s.engine.ready, false, 'the engine does not claim ready while the clock is behind');
        assert.match(s.engine.reason ?? '', /clock/i);
        assert.ok(s.nextRunAt !== undefined && s.nextRunAt <= clock.t + 86_400_000, 'nextRunAt stays honest');
      }
      const r = await a.tick();
      assert.ok(r, `day ${d}: the scheduled run happened`);
      engines.push(r!.engine);
    }
    assert.equal(engines[0], 'rules', 'blocked days grow with rule-based growth');
    assert.ok(engines.slice(5).every((e) => e === 'premium'), `premium resumes once time is consistent: ${engines.join(',')}`);
    assert.ok(calls.length >= 25);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 3. Daily start creep -----------------------------------------------------------------------------------------

test('re-review 3: with one-minute ticks the scheduled premium run starts at the set hour every day (no creep)', async () => {
  const dir = tmp();
  const clock = { t: local(2026, 9, 1, 3, 0) + 20_000 };
  try {
    const a = make(dir, () => (clock.t += 1), { chat: counting().chat });
    a.updateSettings({ enabled: true, engine: 'premium', dailyCapUsd: 1, monthlyCapUsd: 10 });
    const starts: number[] = [];
    const base = clock.t;
    for (let minute = 0; minute < 60 * 24 * 20; minute++) {
      clock.t = base + minute * 60_000;
      const r = await a.tick();
      if (r) starts.push(r.startedAt);
    }
    assert.equal(starts.length, 20);
    for (const s of starts) { const d = new Date(s); assert.equal(d.getHours(), 3); assert.ok(d.getMinutes() <= 1, d.toTimeString()); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 4. Crash window between the world and its undo record --------------------------------------------------------

test('re-review 4: the undo record is on disk before the world changes; a death between the writes is reconciled on restore', async () => {
  // a. The final "applied" save fails (the process would die here): after a restart the run is applied with undo data.
  for (const where of ['after-world', 'before-world'] as const) {
    const dir = tmp();
    const clock = { t: local(2026, 9, 25, 3) };
    let phase = 0;
    class Died extends Error {}
    const writeJson = (file: string, value: unknown) => {
      if (phase === 1 && file.endsWith('additions.json')) {
        if (where === 'before-world') throw new Died('process died before the world write');
        writeJsonAtomic(file, value);
        phase = 2;
        return;
      }
      if (phase === 2 && file.endsWith('architect.json')) throw new Died('process died after the world write');
      writeJsonAtomic(file, value);
    };
    try {
      const a = make(dir, () => clock.t, { chiefSettings: () => DEFAULT_CHIEF_SETTINGS, writeJson });
      a.updateSettings({ enabled: true });
      phase = 1;
      await a.runNow('CEO').catch(() => undefined);
      const worldFile = path.join(dir, 'world', 'additions.json');
      const disk = existsSync(worldFile) ? JSON.parse(readFileSync(worldFile, 'utf8')) : { additions: [] };
      const b = make(dir, () => clock.t, { chiefSettings: () => DEFAULT_CHIEF_SETTINGS });
      const s = b.state();
      assert.equal(s.storageError, undefined, where);
      const run = s.runs[0];
      assert.equal(s.world.additions.length, disk.additions.length);
      if (where === 'after-world') {
        assert.ok(disk.additions.length > 0);
        assert.equal(run.status, 'applied', 'the pending record is finished');
        assert.equal(run.changes.length, disk.additions.length, 'every addition has its undo data');
        const after = b.undo(run.changes[0].id, 'CEO');
        assert.equal(after.world.additions.length, disk.additions.length - 1);
      } else {
        assert.equal(disk.additions.length, 0);
        assert.notEqual(run.status, 'applied');
        assert.equal(run.changes.length, 0, 'a world that was never written has no changes recorded');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

// ---- Optional: colliders wait for a driven car ---------------------------------------------------------------------

test('re-review optional: an architect collider waits for a driven car to clear, not only the walker', () => {
  const box = { minX: 10, maxX: 12, minZ: 10, maxZ: 12, top: 3 };
  const car = { position: { x: 11, z: 11 }, rotation: { y: 0 }, half: { w: 1, l: 2 } };
  assert.equal(colliderMaySolidify(box, { x: 50, z: 50 }, [car], true), false, 'the car is inside');
  assert.equal(colliderMaySolidify(box, { x: 11, z: 11 }, [], false), false, 'the walker is inside');
  assert.equal(colliderMaySolidify(box, { x: 50, z: 50 }, [{ ...car, position: { x: 40, z: 40 } }], true), true);
});
