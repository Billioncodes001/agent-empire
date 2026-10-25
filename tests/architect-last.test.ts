/**
 * CITY-10 last review (approved at f11db7e, scratchpad c10d/probe/last.test.ts): a sleeping host still grows every day,
 * and a run that touches one addition twice reconciles after a crash. Each failed before its fix.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArchitectService } from '../src/server/architect.js';
import type { ChatFn } from '../src/server/chief.js';
import { DEFAULT_CHIEF_SETTINGS, type ChiefSettings } from '../src/shared/chief.js';
import { LOTS, applyChanges, emptyWorld, footprintOf } from '../src/shared/world.js';

const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = (() => { throw new Error('network call attempted'); }) as typeof fetch; });
test.after(() => { globalThis.fetch = realFetch; });

const local = (y: number, mo: number, d: number, h: number, m = 0) => new Date(y, mo, d, h, m).getTime();
const PREMIUM: ChiefSettings = { ...DEFAULT_CHIEF_SETTINGS, premiumModel: 'm', premiumPrice: [3, 15] };

test('last 1: a host awake only 4 hours a day (monotonic time stops while it sleeps) still runs every day; paid calls stay spaced', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'architect-last-'));
  const clock = { t: local(2026, 9, 1, 3) }, mono = { t: 0 };
  const calls: number[] = [];
  const chat: ChatFn = async (p) => { calls.push(1); return { text: '{"changes":[]}', model: p.model, usage: { input: 0, output: 0 }, cost: { usd: null, kind: 'paid-estimate', label: '' } }; };
  try {
    const a = new ArchitectService(dir, { host: 'server', keys: () => ({ ANTHROPIC_API_KEY: 'sk-test-not-real' }), chiefSettings: () => PREMIUM, chat, now: () => clock.t, monotonic: () => mono.t });
    a.updateSettings({ enabled: true, engine: 'premium', dailyCapUsd: 1, monthlyCapUsd: 10 });
    const days = new Set<string>();
    const runs: { day: string; engine: string; note?: string }[] = [];
    for (let d = 0; d < 10; d++) {
      for (let minute = 0; minute < 24 * 60; minute += 5) {
        clock.t = local(2026, 9, 1 + d, 3) + minute * 60_000;
        mono.t = ((d * 24 * 60 + minute) * 60_000) / 6; // awake a sixth of the time
        const r = await a.tick();
        if (r) { days.add(r.day); runs.push({ day: r.day, engine: r.engine, note: r.note }); }
      }
    }
    assert.equal(days.size, 10, `one run every day: ${runs.map((r) => `${r.day}:${r.engine}`).join(' ')}`);
    assert.equal(runs.length, 10);
    assert.ok(runs.filter((r) => r.engine === 'premium').length <= Math.ceil((10 * 4) / 23) + 1, 'paid calls still need 23 h of awake time between them');
    assert.ok(runs.filter((r) => r.engine === 'rules').every((r) => /23 hours/.test(r.note ?? '')), 'the rule-based days say why');
    for (const r of runs) assert.equal(new Date(local(2026, 9, Number(r.day.slice(8)), 3)).getDate(), Number(r.day.slice(8)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('last 2: a run that moves the same addition twice reconciles at both crash points', () => {
  const META = { day: '2026-10-25', runId: 'R1', engine: 'rules' as const, at: 1, maxChanges: 5 };
  const l = LOTS.find((x) => x.id === 'harbour-yard-west')!;
  const f = footprintOf('flora/shrub', 0, 0, 0);
  const x0 = Math.round((l.minX - f.minX + 1) * 4) / 4, z0 = Math.round((l.minZ - f.minZ + 1) * 4) / 4;
  const base = applyChanges(emptyWorld(), [{ op: 'place', model: 'flora/shrub', lot: l.id, x: x0, z: z0, yaw: 0, reason: 'a' }], META);
  assert.ok('ok' in base);
  const run = applyChanges(base.ok.doc, [{ op: 'move', id: 'W1', x: x0, z: z0 + 4, yaw: 0, reason: 'b' }, { op: 'move', id: 'W1', x: x0, z: z0 + 8, yaw: 0, reason: 'c' }], { ...META, runId: 'R2', firstChange: 2 });
  assert.ok('ok' in run, 'the rules accept moving an addition twice');
  for (const [label, world, expect] of [['before the world write', base.ok.doc, 'interrupted'], ['after the world write', run.ok.doc, 'applied']] as const) {
    const dir = mkdtempSync(path.join(tmpdir(), 'architect-last-'));
    try {
      mkdirSync(path.join(dir, 'world'));
      writeFileSync(path.join(dir, 'world', 'additions.json'), JSON.stringify(world));
      const r = { id: 'R2', day: '2026-10-25', trigger: 'manual', engine: 'rules', status: 'applying', startedAt: Date.now(), engineLabel: 'Rule-based growth · US$0', costLabel: 'US$0', costUsd: 0, worldRevision: run.ok.doc.revision, changes: run.ok.applied };
      writeFileSync(path.join(dir, 'world', 'architect.json'), JSON.stringify({ version: 1, settings: {}, spend: {}, nextRun: 3, nextChange: 4, runs: [r] }));
      const a = new ArchitectService(dir, { host: 'server', keys: () => ({}), chiefSettings: () => DEFAULT_CHIEF_SETTINGS, now: () => Date.now() });
      const s = a.state();
      assert.equal(s.storageError, undefined, label);
      assert.equal(s.runs[0].status, expect, label);
      if (expect === 'applied') {
        assert.equal(s.world.additions[0].z, z0 + 8);
        // Undo the second move, then the first: back to where W1 started.
        a.undo('C3', 'CEO');
        assert.equal(a.undo('C2', 'CEO').world.additions[0].z, z0);
      } else assert.equal(s.world.additions[0].z, z0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
