import assert from 'node:assert/strict';
import test from 'node:test';
import { projectOrg, type OrgInput } from '../src/server/org.js';
import type { ConsultancyJob } from '../src/shared/consultancy.js';
import type { SupervisionState } from '../src/shared/empire.js';
import { EXECUTIVE_ROLES, type Executive, type ExecutiveRole } from '../src/shared/org.js';
import type { QueueTask, UsageState, WorkerInfo } from '../src/shared/protocol.js';

const usage = (today: number, budget?: number): UsageState => ({
  total: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: today, calls: 1 },
  today: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: today, calls: 1 },
  day: '2026-10-02',
  budget,
  pauseHiring: false,
});

const task = (id: string, status: QueueTask['status'], extra: Partial<QueueTask> & Record<string, unknown> = {}): QueueTask =>
  ({ id, title: id, prompt: id, addedBy: 'CEO', addedAt: 1, status, ...extra }) as QueueTask;

const worker = (id: string, status: WorkerInfo['status'], extra: Partial<WorkerInfo> & Record<string, unknown> = {}): WorkerInfo =>
  ({ id, kind: 'agent', deskId: 'desk-1', name: id, color: '#fff', status, processState: 'running', acked: false, createdBy: 'CEO', createdAt: 1, cols: 80, rows: 24, viewers: [], ...extra }) as WorkerInfo;

const job = (id: string, extra: Partial<ConsultancyJob> = {}): ConsultancyJob => ({
  id, requestId: id, client: 'Acme', title: id, brief: 'b', decision: 'approved', status: 'queued', createdAt: 1, createdBy: 'CEO', items: [], ...extra,
});

const supervision = (extra: Partial<SupervisionState> = {}): SupervisionState => ({
  schemaVersion: 1, serverRunId: 'run', observedAt: 1, delegationRequested: false,
  monitor: { mode: 'rule_based', lastCheckAt: 1 },
  chief: { phase: 'working' },
  workforce: { active: 2, attention: 1, queued: 3 },
  ...extra,
});

const base = (over: Partial<OrgInput> = {}): OrgInput => ({ now: 42, workers: [], queue: { tasks: [], maxWorkers: 2 }, jobs: [], usage: usage(0), ...over });
const exec = (input: OrgInput, role: ExecutiveRole): Executive => projectOrg(input).executives.find((e) => e.role === role)!;

test('the roster is stable, rule-based and honest about who is not staffed', () => {
  const org = projectOrg(base());
  assert.equal(org.schemaVersion, 1);
  assert.equal(org.observedAt, 42);
  assert.deepEqual(org.executives.map((e) => e.role), EXECUTIVE_ROLES);
  for (const e of org.executives) assert.equal(e.monitor, 'rule_based');
  assert.equal(exec(base(), 'operations').name, 'Morgan · Operations');
  for (const role of ['research'] as const) {
    const e = exec(base(), role);
    assert.equal(e.active, false);
    assert.equal(e.summary, 'Not staffed yet');
    assert.equal(e.attention, 0);
  }
});

test('ORG-04a: marketing & sales is staffed (rule-based) and counts campaigns, leads and sends waiting for approval', () => {
  const none = exec(base(), 'marketing_sales');
  assert.equal(none.active, true);
  assert.equal(none.summary, 'Email outreach is not available on this host');
  const outreach = { campaigns: 2, sending: 1, drafting: 1, confirmedLeads: 14, proposedLeads: 3, suppressed: 2, sendingEnabled: true };
  const approvals = [
    { id: 'A1', kind: 'external_action', raisedBy: 'marketing_sales', status: 'pending' },
    { id: 'A2', kind: 'job_plan', raisedBy: 'chief_of_staff', status: 'pending' },
  ] as never;
  const e = exec(base({ outreach, approvals }), 'marketing_sales');
  assert.equal(e.summary, '2 campaigns · 1 sending · 1 drafting · 14 leads · 3 proposed to accept · 1 send waiting for approval');
  assert.equal(e.attention, 1);
  assert.match(exec(base({ outreach: { ...outreach, sendingEnabled: false, campaigns: 0, sending: 0, drafting: 0 } }), 'marketing_sales').summary, /^No campaigns yet · 14 leads · 3 proposed to accept · sending not configured$/);
});

test('chief of staff wraps supervision and counts plans waiting for approval', () => {
  const input = base({ supervision: supervision(), jobs: [job('j1', { decision: 'pending_approval', status: 'awaiting_approval' }), job('j2')] });
  const chief = exec(input, 'chief_of_staff');
  assert.equal(chief.active, true);
  assert.match(chief.summary, /Working/);
  assert.match(chief.summary, /2 active/);
  assert.match(chief.summary, /1 needs input/);
  assert.match(chief.summary, /1 plan awaiting approval/);
  assert.equal(chief.attention, 1);
  assert.match(exec(base(), 'chief_of_staff').summary, /No supervision evidence yet/);
});

test('operations computes queue health, including LIFE-04 fields when present', () => {
  const tasks = [
    task('r1', 'running', { workerId: 'w1' }),
    task('q1', 'queued'),
    task('q2', 'queued', { blockedBy: ['r1'] }),
    task('q3', 'done', { outcome: 'failed', error: 'dependency r0 did not finish' }),
    task('d1', 'done', { outcome: 'done' }),
  ];
  const workers = [worker('w1', 'working'), worker('w2', 'done', { waitingOn: { id: 'w1', name: 'Bea', taskId: 'r1' } })];
  const ops = exec(base({ queue: { tasks, maxWorkers: 2 }, workers }), 'operations');
  assert.equal(ops.summary, '1 running · 2 queued · 1 blocked · 1 waiting worker · 1 dependency failure held');
  assert.equal(ops.attention, 1, 'a held dependency failure waits for the CEO to retry or remove it');
  assert.equal(exec(base(), 'operations').summary, 'Queue idle · nothing queued');
});

test('operations reports items held for budget', () => {
  const held = job('j1', { budgetHold: { reachedAt: 1, spentUsd: 5, approvedBudgetUsd: 5 }, items: [{ id: 'item-2', title: 't', prompt: 'p', jobKey: 'k', status: 'queued', phase: 'build', held: true }] });
  assert.match(exec(base({ jobs: [held], queue: { tasks: [task('q', 'queued')], maxWorkers: 1 } }), 'operations').summary, /1 held for budget/);
});

test('finance compares approved budgets with actual spend and raises budget holds', () => {
  const jobs = [
    job('j1', { approvedBudgetUsd: 8, actualSpendUsd: 3.5 }),
    job('j2', { approvedBudgetUsd: 4, actualSpendUsd: 4.25, budgetHold: { reachedAt: 1, spentUsd: 4.25, approvedBudgetUsd: 4 } }),
    job('j3', { decision: 'pending_approval', status: 'awaiting_approval' }),
  ];
  const fin = exec(base({ jobs, usage: usage(1.2, 10) }), 'finance');
  assert.equal(fin.summary, 'Today $1.20 of $10.00 daily budget · 2 jobs: $7.75 spent of $12.00 approved · 1 budget increase needed');
  assert.equal(fin.attention, 1);
  assert.equal(exec(base({ usage: usage(0.5) }), 'finance').summary, 'Today $0.50 · no daily budget set · no approved job budgets');
});

test('projection is pure and never mixes city credits into spend', () => {
  const input = base({ jobs: [job('j1', { approvedBudgetUsd: 2, actualSpendUsd: 1 })], usage: usage(1) });
  const before = JSON.stringify(input);
  assert.deepEqual(projectOrg(input), projectOrg(input));
  assert.equal(JSON.stringify(input), before);
  assert.doesNotMatch(JSON.stringify(projectOrg(input)), /\bcr\b|credit/);
});
