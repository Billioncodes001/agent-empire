import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Consultancy, ConsultancyError, type ConsultancyOrgPorts } from '../src/server/consultancy.js';
import { estimateJob, type PlannedItem } from '../src/server/estimate.js';
import { TaskQueue, type QueueWorkers } from '../src/server/queue.js';
import type { QueueState, QueueTask, WorkerInfo } from '../src/shared/protocol.js';

class FakeQueue {
  tasks: QueueTask[] = [];
  maxWorkers = 2;
  private next = 1;
  state(): QueueState { return { tasks: this.tasks.map((t) => ({ ...t })), maxWorkers: this.maxWorkers }; }
  add(prompt: string, by: string, title?: string, _issue?: number, jobKey?: string): string | undefined {
    if (jobKey && this.tasks.some((t) => t.jobKey === jobKey)) return undefined;
    this.tasks.push({ id: `q-${this.next++}`, jobKey, title: title ?? 'task', prompt, addedBy: by, addedAt: 1, status: 'queued' });
    return undefined;
  }
}

const MIN = 60_000;
const history = [1, 2, 3, 4, 5].map((c) => ({ costUsd: c, durationMs: c * 10 * MIN }));

function setup(costs: Record<string, number> = {}, ports: Partial<ConsultancyOrgPorts> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'consultancy-budget-'));
  const queue = new FakeQueue();
  const office = new Consultancy(dir, queue, undefined, {
    estimate: (items: PlannedItem[]) => estimateJob(items, history, { maxWorkers: queue.maxWorkers, now: 7 }),
    taskCost: (taskId) => costs[taskId],
    ...ports,
  });
  return { dir, queue, office, costs, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const plan = {
  requestId: 'req-1', client: 'Acme', title: 'Booking portal', brief: 'Build booking',
  tasks: [
    { title: 'Build API', prompt: 'Build the API', phase: 'build' },
    { title: 'Iterate UI', prompt: 'Iterate on the UI', phase: 'iteration' },
    { title: 'Field test', prompt: 'Run a field test', phase: 'field_testing' },
  ],
};

test('a plan keeps each item phase and shows a live estimate before approval', () => {
  const f = setup();
  try {
    const job = f.office.create(plan, 'CEO');
    assert.deepEqual(job.items.map((i) => i.phase), ['build', 'iteration', 'field_testing']);
    assert.ok(job.estimate, 'the review step shows an estimate');
    assert.deepEqual(job.estimate!.costUsd, { low: 6, high: 12 });
    assert.equal(job.estimate!.basis.source, 'history');
    assert.deepEqual(job.items[0].estimate!.costUsd, { low: 2, high: 4 });
    assert.equal(job.approvedBudgetUsd, undefined);
    assert.equal(f.queue.tasks.length, 0, 'nothing starts before approval');
    assert.throws(() => f.office.create({ ...plan, requestId: 'req-2', tasks: [{ title: 't', prompt: 'p', phase: 'launch' }] }, 'CEO'), (e) => e instanceof ConsultancyError && e.status === 400);
  } finally { f.done(); }
});

test('approval records the top of the range, rounded up, unless the CEO edits it', () => {
  const f = setup();
  try {
    const a = f.office.create(plan, 'CEO');
    const approved = f.office.approve(a.id, 'CEO');
    assert.equal(approved.approvedBudgetUsd, 12);
    assert.deepEqual(approved.estimate!.costUsd, { low: 6, high: 12 }, 'the approved estimate is frozen');
    const b = f.office.create({ ...plan, requestId: 'req-2' }, 'CEO');
    assert.throws(() => f.office.approve(b.id, 'CEO', { budgetUsd: -3 }), (e) => e instanceof ConsultancyError && e.status === 400);
    assert.throws(() => f.office.approve(b.id, 'CEO', { budgetUsd: Number.NaN }), (e) => e instanceof ConsultancyError && e.status === 400);
    assert.equal(f.office.snapshot().jobs.find((j) => j.id === b.id)!.decision, 'pending_approval');
    assert.equal(f.office.approve(b.id, 'CEO', { budgetUsd: 25.5 }).approvedBudgetUsd, 25.5);
    // Persisted and restored.
    const reopened = new Consultancy(f.dir, f.queue);
    const saved = reopened.snapshot().jobs;
    assert.equal(saved.find((j) => j.id === a.id)!.approvedBudgetUsd, 12);
    assert.equal(saved.find((j) => j.id === b.id)!.approvedBudgetUsd, 25.5);
    assert.deepEqual(saved.find((j) => j.id === a.id)!.estimate!.costUsd, { low: 6, high: 12 });
  } finally { f.done(); }
});

test('actual spend is the sum of the workers that ran its items', () => {
  const f = setup();
  try {
    const job = f.office.approve(f.office.create(plan, 'CEO').id, 'CEO');
    const [t1, t2] = f.queue.tasks;
    f.costs[t1.id] = 1.25;
    f.costs[t2.id] = 0.5;
    const seen = f.office.snapshot().jobs.find((j) => j.id === job.id)!;
    assert.equal(seen.actualSpendUsd, 1.75);
    assert.equal(seen.items[0].actualSpendUsd, 1.25);
    assert.equal(seen.items[2].actualSpendUsd, undefined);
  } finally { f.done(); }
});

test('reaching the budget holds unstarted items and never stops running work', () => {
  const f = setup();
  try {
    const job = f.office.approve(f.office.create(plan, 'CEO').id, 'CEO', { budgetUsd: 3 });
    const [t1, t2, t3] = f.queue.tasks;
    t1.status = 'running';
    t1.startedAt = 2;
    f.costs[t1.id] = 2;
    f.office.reconcile();
    assert.equal(f.office.holdReason(t2), undefined, 'under budget nothing is held');
    f.costs[t1.id] = 3.2;
    f.office.reconcile();
    const seen = f.office.snapshot().jobs.find((j) => j.id === job.id)!;
    assert.deepEqual(seen.budgetHold && { spent: seen.budgetHold.spentUsd, budget: seen.budgetHold.approvedBudgetUsd }, { spent: 3.2, budget: 3 });
    assert.ok(seen.budgetHold!.reachedAt > 0);
    assert.deepEqual(seen.items.map((i) => !!i.held), [false, true, true]);
    assert.equal(seen.items[0].status, 'running', 'the running item keeps running');
    assert.match(f.office.holdReason(t2)!, /budget/i);
    assert.match(f.office.holdReason(t3)!, /budget/i);
    assert.equal(f.office.holdReason(t1), undefined, 'a running task is never held');
    assert.equal(f.office.holdReason({ ...t2, jobKey: undefined }), undefined, 'other queue work is not affected');
    assert.match(seen.attention ?? '', /budget/i);
    // Durable across restart.
    const reopened = new Consultancy(f.dir, f.queue);
    assert.ok(reopened.snapshot().jobs[0].budgetHold);
    assert.match(reopened.holdReason(t2)!, /budget/i);
    // ORG-03 will raise the budget from an approval; the release path exists and is idempotent.
    f.office.raiseBudget(job.id, 10, 'CEO');
    assert.equal(f.office.holdReason(t2), undefined);
    const raised = f.office.snapshot().jobs[0];
    assert.equal(raised.budgetHold, undefined);
    assert.equal(raised.approvedBudgetUsd, 10);
    assert.throws(() => f.office.raiseBudget(job.id, 2, 'CEO'), (e) => e instanceof ConsultancyError && e.status === 409);
  } finally { f.done(); }
});

test('the queue skips a held task without failing it and seats other work', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'queue-hold-'));
  const spawned: string[] = [];
  const workers: QueueWorkers = {
    list: () => [],
    deskOccupied: () => false,
    spawn: (deskId, _by, prompt) => { spawned.push(prompt); return { id: `w-${spawned.length}`, name: 'W', deskId, status: 'working' } as WorkerInfo; },
    kill: async () => ({}),
  };
  writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ maxWorkers: 2, tasks: [] }));
  const queue = new TaskQueue(dir, workers, false, {
    update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined,
    taskHold: (t) => (t.jobKey === 'held' ? 'Budget reached' : undefined),
  });
  try {
    queue.add('held work', 'CEO', 'Held', undefined, 'held');
    queue.add('free work', 'CEO', 'Free', undefined, 'free');
    const tasks = queue.state().tasks;
    assert.equal(tasks.find((t) => t.jobKey === 'held')!.status, 'queued');
    assert.equal(tasks.find((t) => t.jobKey === 'held')!.outcome, undefined);
    assert.equal(tasks.find((t) => t.jobKey === 'free')!.status, 'running');
    assert.deepEqual(spawned, ['free work']);
  } finally { queue.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test('review fix 1: the next ordered item never starts once spend reached the budget, even before reconcile records it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'budget-live-'));
  const live: WorkerInfo[] = [];
  const costs: Record<string, number> = {};
  const workers: QueueWorkers = {
    list: () => live,
    deskOccupied: (d) => live.some((w) => w.deskId === d),
    spawn: (deskId) => { const w = { id: `w-${live.length + 1}`, kind: 'agent', name: 'W', deskId, status: 'working', processState: 'running', viewers: [] } as unknown as WorkerInfo; live.push(w); return w; },
    kill: async () => ({}),
  };
  writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ maxWorkers: 2, tasks: [] }));
  let office!: Consultancy;
  const queue = new TaskQueue(dir, workers, false, {
    update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined,
    taskHold: (t) => office?.holdReason(t),
  });
  try {
    office = new Consultancy(dir, queue, undefined, { taskCost: (id) => costs[id] });
    const job = office.create({ requestId: 'live-1', client: 'Acme', title: 'Two steps', brief: 'b', tasks: [{ title: 'One', prompt: 'one' }, { title: 'Two', prompt: 'two' }] }, 'CEO');
    office.approve(job.id, 'CEO', { budgetUsd: 3 });
    const [t1, t2] = queue.state().tasks;
    assert.equal(t1.status, 'running');
    assert.deepEqual(t2.dependsOn, [t1.id]);
    // Item 1 finishes over budget; the queue pumps on the worker update, with no reconcile in between.
    costs[t1.id] = 3.2;
    live[0].status = 'done';
    queue.onWorker({ ...live[0] });
    const after = queue.state().tasks;
    assert.equal(after[0].status, 'done');
    assert.equal(after[1].status, 'queued', 'item 2 waits for a budget increase');
    assert.equal(live.length, 1, 'no second worker was hired');
    assert.match(office.holdReason(after[1])!, /budget/i);
    assert.ok(office.snapshot().jobs[0].items[1].held, 'the review shows it held before reconcile');
  } finally { queue.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test('a consultancy.json from before estimates loads unchanged', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'consultancy-legacy-'));
  try {
    const id = 'consultancy-0123456789ab';
    const canonical = { requestId: 'r1', client: 'Acme', title: 'Old job', brief: 'Brief', tasks: [{ title: 'One', prompt: 'Do one' }] };
    const legacy = {
      revision: 3,
      jobs: [{
        id, requestId: 'r1', requestFingerprint: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
        client: 'Acme', title: 'Old job', brief: 'Brief', decision: 'approved', createdAt: 1, createdBy: 'CEO', decidedAt: 2, decidedBy: 'CEO',
        items: [{ id: 'item-1', title: 'One', prompt: 'Do one', jobKey: `consultancy:${id}:item-1`, queueTaskId: 'q-1' }],
      }],
    };
    const file = path.join(dir, 'consultancy.json');
    writeFileSync(file, JSON.stringify(legacy));
    const queue = new FakeQueue();
    queue.tasks.push({ id: 'q-1', jobKey: `consultancy:${id}:item-1`, title: 'One', prompt: 'Do one', addedBy: 'CEO', addedAt: 1, status: 'queued' });
    const office = new Consultancy(dir, queue, undefined, { estimate: () => { throw new Error('approved jobs are not re-estimated'); }, taskCost: () => undefined });
    assert.equal(office.recoveryError, undefined);
    const [job] = office.snapshot().jobs;
    assert.equal(job.items[0].phase, 'build');
    assert.equal(job.approvedBudgetUsd, undefined);
    assert.equal(job.estimate, undefined);
    assert.equal(job.budgetHold, undefined);
    assert.equal(job.status, 'queued');
    assert.equal(office.holdReason(queue.tasks[0]), undefined, 'no budget, no hold');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), legacy, 'loading does not rewrite the file');
    // A legacy create without phases replays idempotently against the same fingerprint.
    assert.equal(office.create({ requestId: 'r1', client: 'Acme', title: 'Old job', brief: 'Brief', tasks: [{ title: 'One', prompt: 'Do one' }] }, 'CEO').id, id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
