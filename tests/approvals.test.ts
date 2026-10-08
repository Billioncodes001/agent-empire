import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Consultancy } from '../src/server/consultancy.js';
import { estimateJob, type PlannedItem } from '../src/server/estimate.js';
import { ApprovalError, ApprovalInbox, suggestBudget } from '../src/server/approvals.js';
import { projectOrg, type OrgInput } from '../src/server/org.js';
import type { QueueState, QueueTask } from '../src/shared/protocol.js';
import type { Approval } from '../src/shared/approvals.js';

class FakeQueue {
  tasks: QueueTask[] = [];
  private next = 1;
  state(): QueueState { return { tasks: this.tasks.map((t) => ({ ...t })), maxWorkers: 2 }; }
  add(prompt: string, by: string, title?: string, _issue?: number, jobKey?: string, dependsOn?: readonly string[]): string | undefined {
    if (jobKey && this.tasks.some((t) => t.jobKey === jobKey)) return undefined;
    this.tasks.push({ id: `q-${this.next++}`, jobKey, title: title ?? 'task', prompt, addedBy: by, addedAt: 1, status: 'queued', ...(dependsOn?.length ? { dependsOn: [...dependsOn] } : {}) });
    return undefined;
  }
}

const MIN = 60_000;
const history = [1, 2, 3, 4, 5].map((c) => ({ costUsd: c, durationMs: c * 10 * MIN }));

function setup(dir = mkdtempSync(path.join(tmpdir(), 'approvals-'))) {
  const queue = new FakeQueue();
  const costs: Record<string, number> = {};
  let changes = 0;
  let inbox!: ApprovalInbox;
  const office = new Consultancy(dir, queue, () => inbox?.reconcile(), {
    estimate: (items: PlannedItem[]) => estimateJob(items, history, { maxWorkers: 2, now: 7 }),
    taskCost: (id) => costs[id],
  });
  inbox = new ApprovalInbox(dir, office, () => { changes++; });
  return { dir, queue, costs, office, inbox, changes: () => changes, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const plan = (requestId = 'req-1') => ({
  requestId, client: 'Acme', title: 'Booking portal', brief: 'Build booking',
  tasks: [{ title: 'Build API', prompt: 'Build the API' }, { title: 'Iterate UI', prompt: 'Iterate', phase: 'iteration' }],
});

const pending = (inbox: ApprovalInbox) => inbox.state().items.filter((i) => i.status === 'pending');

/** Item 1 finishes over the approved budget: consultancy records the hold, and finance raises an approval. */
function overBudget(f: ReturnType<typeof setup>, budgetUsd = 3) {
  const job = f.office.approve(f.office.create(plan(), 'CEO').id, 'CEO', { budgetUsd });
  const t1 = f.queue.tasks[0];
  Object.assign(t1, { status: 'done', outcome: 'done', finishedAt: 5 });
  f.costs[t1.id] = 3.2;
  f.office.reconcile();
  return job;
}

test('a pending plan becomes a job_plan item raised by the chief of staff, with its estimate', () => {
  const f = setup();
  try {
    const job = f.office.create(plan(), 'CEO');
    const items = pending(f.inbox);
    assert.equal(items.length, 1);
    const [item] = items;
    assert.match(item.id, /^A\d+$/, 'inbox ids are short and distinct from consultancy job ids');
    assert.equal(item.kind, 'job_plan');
    assert.equal(item.raisedBy, 'chief_of_staff');
    assert.equal(item.jobId, job.id);
    assert.deepEqual(item.estimate?.costUsd, job.estimate?.costUsd);
    assert.match(item.title, /Booking portal/);
    assert.equal(f.inbox.state().pending, 1);
  } finally { f.done(); }
});

test('approving a job_plan uses the consultancy approve path with the CEO budget; decisions are idempotent', () => {
  const f = setup();
  try {
    const job = f.office.create(plan(), 'CEO');
    const [item] = pending(f.inbox);
    const approved = f.inbox.approve(item.id, 'CEO', { budgetUsd: 20 });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.budgetUsd, 20);
    const seen = f.office.snapshot().jobs.find((j) => j.id === job.id)!;
    assert.equal(seen.decision, 'approved');
    assert.equal(seen.approvedBudgetUsd, 20);
    assert.equal(f.queue.tasks.length, 2, 'the plan reached the queue once');
    const decidedAt = seen.decidedAt;
    // Repeats and a contrary decision return the existing decision; nothing is decided twice.
    assert.deepEqual(f.inbox.approve(item.id, 'CEO', { budgetUsd: 99 }), approved);
    assert.equal(f.inbox.reject(item.id, 'CEO').status, 'approved');
    assert.equal(f.office.snapshot().jobs[0].decidedAt, decidedAt);
    assert.equal(f.office.snapshot().jobs[0].approvedBudgetUsd, 20);
    assert.throws(() => f.inbox.approve('A999', 'CEO'), (e) => e instanceof ApprovalError && e.status === 404);
  } finally { f.done(); }
});

test('a plan decided on the founder desk or by Telegram resolves its inbox item without a second decision', () => {
  const f = setup();
  try {
    const a = f.office.create(plan('a'), 'CEO');
    const b = f.office.create(plan('b'), 'CEO');
    assert.equal(pending(f.inbox).length, 2);
    f.office.approve(a.id, 'CEO via Telegram', { budgetUsd: 7 });
    f.office.reject(b.id, 'CEO');
    f.inbox.reconcile();
    const items = f.inbox.state().items;
    const ia = items.find((i) => i.jobId === a.id)!;
    const ib = items.find((i) => i.jobId === b.id)!;
    assert.equal(ia.status, 'approved');
    assert.equal(ia.decidedBy, 'CEO via Telegram');
    assert.equal(ia.budgetUsd, 7);
    assert.equal(ib.status, 'rejected');
    assert.equal(f.inbox.approve(ib.id, 'CEO').status, 'rejected', 'an inbox approve cannot revive a declined plan');
    assert.equal(f.office.snapshot().jobs.find((j) => j.id === b.id)!.decision, 'rejected');
  } finally { f.done(); }
});

test('rejecting a job_plan declines the consultancy plan', () => {
  const f = setup();
  try {
    const job = f.office.create(plan(), 'CEO');
    const [item] = pending(f.inbox);
    assert.equal(f.inbox.reject(item.id, 'CEO').status, 'rejected');
    assert.equal(f.office.snapshot().jobs.find((j) => j.id === job.id)!.decision, 'rejected');
    assert.equal(f.queue.tasks.length, 0);
  } finally { f.done(); }
});

test('a budget hold raises a budget_increase from finance; approving raises the budget and releases held items', () => {
  const f = setup();
  try {
    const job = overBudget(f);
    const items = pending(f.inbox);
    assert.equal(items.length, 1);
    const [item] = items;
    assert.equal(item.kind, 'budget_increase');
    assert.equal(item.raisedBy, 'finance');
    assert.equal(item.spentUsd, 3.2);
    assert.equal(item.approvedBudgetUsd, 3);
    assert.ok(item.suggestedBudgetUsd! > 3.2, `suggested ${item.suggestedBudgetUsd}`);
    assert.ok(f.office.snapshot().jobs[0].items[1].held, 'item 2 is held');
    assert.throws(() => f.inbox.approve(item.id, 'CEO', { budgetUsd: 3.1 }), (e) => e instanceof ApprovalError && e.status === 400, 'a budget at or under spend is refused');
    assert.throws(() => f.inbox.approve(item.id, 'CEO', { budgetUsd: Number.POSITIVE_INFINITY }), (e) => e instanceof ApprovalError && e.status === 400);
    assert.throws(() => f.inbox.approve(item.id, 'CEO', { budgetUsd: 100_001 }), (e) => e instanceof ApprovalError && e.status === 400);
    assert.equal(f.inbox.get(item.id)!.status, 'pending');
    const approved = f.inbox.approve(item.id, 'CEO', { budgetUsd: 10, requestId: 'tap-1' });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.budgetUsd, 10);
    const seen = f.office.snapshot().jobs.find((j) => j.id === job.id)!;
    assert.equal(seen.approvedBudgetUsd, 10);
    assert.equal(seen.budgetHold, undefined);
    assert.equal(seen.items[1].held, undefined, 'the held item is released');
    assert.equal(f.office.holdReason(f.queue.tasks[1]), undefined);
    assert.deepEqual(f.inbox.approve(item.id, 'CEO', { budgetUsd: 50, requestId: 'tap-1' }), approved, 'a replay returns the decision');
    f.inbox.reconcile();
    assert.equal(pending(f.inbox).length, 0, 'the resolved hold raises nothing new');
  } finally { f.done(); }
});

test('the default budget is current spend plus the remaining estimate top, rounded up', () => {
  const f = setup();
  try {
    overBudget(f);
    const job = f.office.snapshot().jobs[0];
    const remaining = job.items[1].estimate!.costUsd.high;
    const [item] = pending(f.inbox);
    assert.equal(item.suggestedBudgetUsd, Math.ceil(3.2 + remaining));
    assert.equal(suggestBudget(job), item.suggestedBudgetUsd);
    const approved = f.inbox.approve(item.id, 'CEO');
    assert.equal(approved.budgetUsd, item.suggestedBudgetUsd);
    assert.equal(f.office.snapshot().jobs[0].approvedBudgetUsd, item.suggestedBudgetUsd);
  } finally { f.done(); }
});

test('rejecting a budget_increase keeps the job held and records the decision', () => {
  const f = setup();
  try {
    overBudget(f);
    const [item] = pending(f.inbox);
    const rejected = f.inbox.reject(item.id, 'CEO');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.decidedBy, 'CEO');
    assert.ok(rejected.decidedAt);
    const job = f.office.snapshot().jobs[0];
    assert.ok(job.budgetHold, 'still held');
    assert.ok(job.items[1].held);
    f.inbox.reconcile();
    f.office.reconcile();
    assert.equal(pending(f.inbox).length, 0, 'the same hold is not raised again');
    assert.equal(f.inbox.get(item.id)!.reopenable, true, 'review fix 1: it stays approvable while the hold stands');
  } finally { f.done(); }
});

test('the inbox persists, survives restarts, and old data directories without approvals.json work', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'approvals-persist-'));
  try {
    // An "old" data directory: consultancy state exists, no approvals.json yet.
    const queue = new FakeQueue();
    const office = new Consultancy(dir, queue);
    const job = office.create(plan(), 'CEO');
    assert.equal(existsSync(path.join(dir, 'approvals.json')), false);
    const inbox = new ApprovalInbox(dir, office);
    const [item] = pending(inbox);
    assert.equal(item.jobId, job.id);
    assert.ok(existsSync(path.join(dir, 'approvals.json')));
    const saved = JSON.parse(readFileSync(path.join(dir, 'approvals.json'), 'utf8'));
    assert.equal(saved.version, 1);
    const reopened = new ApprovalInbox(dir, office);
    assert.deepEqual(reopened.state().items, inbox.state().items, 'same ids after a restart');
    reopened.reject(item.id, 'CEO');
    assert.equal(new ApprovalInbox(dir, office).get(item.id)!.status, 'rejected');
    // A second plan gets the next id, never a reused one.
    office.create(plan('req-2'), 'CEO');
    const again = new ApprovalInbox(dir, office);
    const ids = again.state().items.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt approvals.json is preserved and blocks decisions instead of being overwritten', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'approvals-corrupt-'));
  try {
    writeFileSync(path.join(dir, 'approvals.json'), '{not json');
    const office = new Consultancy(dir, new FakeQueue());
    office.create(plan(), 'CEO');
    const inbox = new ApprovalInbox(dir, office);
    assert.match(inbox.state().storageError ?? '', /approvals\.json/);
    assert.equal(readFileSync(path.join(dir, 'approvals.json'), 'utf8'), '{not json');
    assert.throws(() => inbox.approve('A1', 'CEO'), (e) => e instanceof ApprovalError && e.status === 503);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('change notifications fire only when the inbox changes', () => {
  const f = setup();
  try {
    f.office.create(plan(), 'CEO');
    const after = f.changes();
    assert.ok(after >= 1);
    f.inbox.reconcile();
    f.inbox.reconcile();
    assert.equal(f.changes(), after);
  } finally { f.done(); }
});

test('finance and chief attention count the inbox items they raised', () => {
  const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, calls: 0 };
  const item = (over: Partial<Approval>): Approval => ({ id: 'A1', kind: 'job_plan', raisedBy: 'chief_of_staff', title: 't', detail: 'd', jobId: 'j', createdAt: 1, status: 'pending', ...over });
  const input: OrgInput = {
    now: 1, workers: [], queue: { tasks: [], maxWorkers: 1 }, jobs: [], usage: { total: zero, today: zero, day: 'd', pauseHiring: false },
    approvals: [
      item({ id: 'A1' }), item({ id: 'A2' }), item({ id: 'A3', status: 'approved' }),
      item({ id: 'A4', kind: 'budget_increase', raisedBy: 'finance' }), item({ id: 'A5', kind: 'budget_increase', raisedBy: 'finance', status: 'rejected' }),
    ],
  };
  const org = projectOrg(input);
  assert.equal(org.executives.find((e) => e.role === 'chief_of_staff')!.attention, 2);
  assert.equal(org.executives.find((e) => e.role === 'finance')!.attention, 1);
  assert.match(org.executives.find((e) => e.role === 'finance')!.summary, /1 budget increase/);
});

test('review fix 1: a declined budget increase can be approved later while its hold stands; the budget is raised once', () => {
  const f = setup();
  try {
    overBudget(f);
    let raises = 0;
    const raise = f.office.raiseBudget.bind(f.office);
    f.office.raiseBudget = (...args) => { raises++; return raise(...args); };
    const [item] = pending(f.inbox);
    f.inbox.reject(item.id, 'CEO');
    assert.equal(f.inbox.get(item.id)!.reopenable, true, 'the hold still stands, so it can be reopened');
    assert.equal(f.inbox.reject(item.id, 'CEO').status, 'rejected', 'a second decline changes nothing');
    assert.throws(() => f.inbox.approve(item.id, 'CEO', { budgetUsd: 3.1 }), (e) => e instanceof ApprovalError && e.status === 400, 'same validation');
    const approved = f.inbox.approve(item.id, 'CEO via Telegram', { budgetUsd: 10 });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.decidedBy, 'CEO via Telegram');
    assert.match(approved.note ?? '', /Reopened after decline on/);
    assert.equal(approved.reopenable, undefined);
    const job = f.office.snapshot().jobs[0];
    assert.equal(job.approvedBudgetUsd, 10);
    assert.equal(job.budgetHold, undefined);
    assert.ok(!job.items.some((i) => i.held), 'held items released');
    assert.deepEqual(f.inbox.approve(item.id, 'CEO', { budgetUsd: 50 }), approved);
    assert.equal(raises, 1);
    assert.equal(new ApprovalInbox(f.dir, f.office).get(item.id)!.status, 'approved', 'persisted');
  } finally { f.done(); }
});

test('review fix 6: a hold that clears without a recorded budget raise is resolved, never a fabricated approval', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'approvals-resolved-'));
  try {
    const hold = { reachedAt: 5, spentUsd: 3.2, approvedBudgetUsd: 3 };
    const job = { id: 'consultancy-aaaaaaaaaaaa', requestId: 'r', client: 'Acme', title: 'T', brief: 'b', decision: 'approved' as const, status: 'queued' as const, createdAt: 1, createdBy: 'CEO', decidedAt: 2, decidedBy: 'CEO', items: [], approvedBudgetUsd: 3, actualSpendUsd: 3.2, budgetHold: hold as typeof hold | undefined };
    const fake = { snapshot: () => ({ revision: 1, jobs: [structuredClone(job)] }), approve: () => { throw new Error('no'); }, reject: () => { throw new Error('no'); }, raiseBudget: () => { throw new Error('no'); } };
    const inbox = new ApprovalInbox(dir, fake as never);
    const [item] = inbox.pending();
    assert.equal(item.kind, 'budget_increase');
    job.budgetHold = undefined;
    inbox.reconcile();
    assert.equal(inbox.get(item.id)!.status, 'resolved');
    assert.equal(inbox.get(item.id)!.budgetUsd, undefined);
    // A second hold that ends with a higher budget on record is the budget raised elsewhere.
    job.budgetHold = { ...hold, reachedAt: 9 };
    inbox.reconcile();
    const second = inbox.pending()[0];
    job.budgetHold = undefined;
    job.approvedBudgetUsd = 8;
    inbox.reconcile();
    assert.equal(inbox.get(second.id)!.status, 'approved');
    assert.equal(inbox.get(second.id)!.budgetUsd, 8);
    assert.match(inbox.get(second.id)!.decidedBy ?? '', /outside the inbox/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
