// The host (src/server/empire.ts) and the cloud coordinator (src/cloud/economy.ts) share one copy of
// the economy rules (src/shared/economy-rules.ts). These tests drive both paths with the same
// inputs and require identical money, buildings, staff, managers and ledgers. Only report wording
// (and the reward ledger label, "Completed" on a host vs "Accepted" in the cloud) may differ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Empire } from '../src/server/empire';
import { applyEmpireAction, advanceEconomy, rewardAcceptedJob } from '../src/cloud/economy';
import { hourlyRates, SITES, type EmpireAction, type EmpireState } from '../src/shared/empire';
import { HIRE_COST, managerWage, SERVICE_WAGE, TASK_REWARD } from '../src/shared/economy-rules';
import type { CloudJob } from '../src/cloud/schema';
import type { QueueTask } from '../src/shared/protocol';

const NOW = 1_800_000_000_000;

function pair(t: { mock: { timers: { enable(o: object): void } } }) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const dir = mkdtempSync(path.join(tmpdir(), 'economy-parity-'));
  const host = new Empire(dir, () => {});
  const cloud: EmpireState = structuredClone(host.state);
  return { host, cloud, close: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Everything that carries money or rules; report wording and runtime evidence are excluded. */
function rules(state: EmpireState) {
  const { reports: _r, updatedAt: _u, supervision: _s, workforce: _w, ...rest } = state as EmpireState & Record<string, unknown>;
  const copy = structuredClone(rest) as typeof rest;
  // Manager links (task/worker ids) come from the host queue or cloud jobs and are mode-specific.
  for (const sector of copy.sectors) if (sector.manager) { delete sector.manager.taskId; delete sector.manager.workerId; delete sector.manager.error; }
  copy.economy.ledger = copy.economy.ledger.map(e => ({ ...e, label: e.label.replace(/^(Completed|Accepted) AI task: /, 'AI task: ') }));
  return copy;
}

const both = (p: ReturnType<typeof pair>, action: EmpireAction) => {
  const hostError = p.host.action(action);
  const cloudError = applyEmpireAction(p.cloud, action, Date.now());
  assert.equal(hostError, cloudError, `same result for ${JSON.stringify(action)}`);
  assert.deepEqual(rules(p.cloud), rules(p.host.state), `same state after ${JSON.stringify(action)}`);
};

test('host and cloud apply every city action and refusal identically', (t) => {
  const p = pair(t);
  try {
    // Refusals before founding change nothing on either path.
    both(p, { kind: 'office-floor' });
    both(p, { kind: 'reinvest' });
    both(p, { kind: 'found', sites: ['cafe', 'cafe'] as never });
    both(p, { kind: 'found', sites: ['studio'] as never });
    both(p, { kind: 'found', sites: ['cafe', 'hospital'] });
    both(p, { kind: 'found', sites: ['cafe'] });
    both(p, { kind: 'hire', site: 'hq' });
    both(p, { kind: 'upgrade', site: 'hq' });
    both(p, { kind: 'build', site: 'cafe' });
    both(p, { kind: 'build', site: 'studio' });
    both(p, { kind: 'buy-land', site: 'studio' });
    both(p, { kind: 'buy-land', site: 'studio' });
    both(p, { kind: 'build', site: 'studio' });
    both(p, { kind: 'build', site: 'nowhere' as never });
    for (let i = 0; i < 8; i++) both(p, { kind: 'hire', site: 'cafe' }); // runs into capacity
    both(p, { kind: 'upgrade', site: 'cafe' });
    both(p, { kind: 'upgrade', site: 'cafe' });
    both(p, { kind: 'upgrade', site: 'cafe' });
    both(p, { kind: 'upgrade', site: 'home' });
    both(p, { kind: 'office-workstation' });
    both(p, { kind: 'office-floor' });
    both(p, { kind: 'delegate', enabled: false });
    both(p, { kind: 'delegate', enabled: 'yes' as never });
    both(p, { kind: 'unknown' } as never);
    // Spend down until purchases are refused for lack of credits on both.
    for (let i = 0; i < 6; i++) both(p, { kind: 'office-floor' });
    assert.ok(p.host.state.economy.capital > 0);
  } finally { p.close(); }
});

test('host and cloud settle operating hours, pauses and AI task rewards identically', (t) => {
  const p = pair(t);
  try {
    both(p, { kind: 'found', sites: ['cafe', 'hospital', 'school'] });
    for (const state of [p.host.state, p.cloud]) for (const s of state.sectors) if (s.manager) s.manager.status = 'ready';

    // One operating hour: the host closes it on the 5-second tick that crosses the hour.
    const queue = { tasks: [] as QueueTask[], maxWorkers: 0 };
    for (let i = 0; i < 12; i++) p.host.tick([], queue, 5);
    advanceEconomy(p.cloud, 60 * 1000, Date.now());
    assert.equal(p.host.state.economy.lastHour, p.cloud.economy.lastHour);
    assert.deepEqual(rules(p.cloud), rules(p.host.state));
    assert.ok(p.host.state.economy.revenue > 0 && p.host.state.economy.dividends > 0);

    // A finished manager startup task (host) / accepted manager job (cloud) earns the same reward.
    const task: QueueTask = {
      id: 'task-1', title: 'Café opening brief', prompt: 'Sector: Hospitality / Common Ground café\n\nBrief', addedBy: 'Founder', addedAt: NOW,
      status: 'done', outcome: 'done', finishedAt: NOW + 1, workerId: 'worker-1', workerName: 'Worker', jobKey: 'empire-manager-cafe-1',
    };
    const job = { id: 'task-1', title: 'Café opening brief', site: 'cafe', status: 'accepted', createdAt: NOW + 1 } as CloudJob;
    p.host.tick([], { tasks: [task], maxWorkers: 0 }, 0);
    assert.equal(rewardAcceptedJob(p.cloud, job, Date.now()), true);
    assert.equal(rewardAcceptedJob(p.cloud, job, Date.now()), false, 'rewarded once');
    p.host.tick([], { tasks: [task], maxWorkers: 0 }, 0);
    assert.deepEqual(rules(p.cloud), rules(p.host.state));

    // An unfundable payroll pauses the same sectors for the hour on both paths.
    for (const state of [p.host.state, p.cloud]) state.funds = 0;
    for (let i = 0; i < 12; i++) p.host.tick([], { tasks: [task], maxWorkers: 0 }, 5);
    advanceEconomy(p.cloud, 60 * 1000, Date.now());
    assert.deepEqual(rules(p.cloud), rules(p.host.state));
    assert.match(p.host.state.reports.map(r => r.text).join('\n'), /paused for this hour/);
    assert.match(p.cloud.reports.map(r => r.text).join('\n'), /Paused for at least one hour/);
  } finally { p.close(); }
});

test('shared constants match the published rates', () => {
  assert.equal(HIRE_COST, 1200);
  assert.deepEqual(TASK_REWARD, { revenue: 500, wages: 50, dividend: 90 });
  for (const site of SITES.filter(s => s.id !== 'home')) {
    const sector = { id: site.id, built: true, staff: 2, level: 1, manager: { status: 'ready' } } as never;
    assert.equal(hourlyRates(sector).wages, managerWage(site.id) + 2 * SERVICE_WAGE, site.id);
  }
});
