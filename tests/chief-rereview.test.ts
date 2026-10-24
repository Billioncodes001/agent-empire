// FREE-02 re-review fixes (2026-10-24). Fake model only; any fetch fails the test.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Consultancy } from '../src/server/consultancy.js';
import { ApprovalInbox } from '../src/server/approvals.js';
import { ChiefBrain, type ChatFn } from '../src/server/chief.js';
import { chiefCommands } from '../src/server/chief-commands.js';
import type { QueueState, QueueTask } from '../src/shared/protocol.js';

const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = (() => { throw new Error('network call attempted'); }) as typeof fetch; });
test.after(() => { globalThis.fetch = realFetch; });

const item = (n: number, prompt = `Do step ${n}.`) => ({ title: `Step ${n}`, prompt, phase: 'build', role: 'engineer', parallel: false, dependsOn: n > 1 ? [n - 1] : [] });
const PLAN = JSON.stringify({ items: [item(1), item(2)] });
const REVIEW = JSON.stringify({ recommendation: 'accept', summary: 'Done.', concerns: [] });

/** Many approved jobs with finished items, as a snapshot/queue pair the brain reads. */
function world(n: number) {
  const tasks: QueueTask[] = [];
  const jobs = Array.from({ length: Math.ceil(n / 8) }, (_, j) => ({ id: `consultancy-${String(j).padStart(12, '0')}`, client: 'c', title: `t${j}`, decision: 'approved', items: [] as { id: string; title: string; prompt: string; queueTaskId: string }[] }));
  for (let i = 0; i < n; i++) {
    const job = jobs[Math.floor(i / 8)];
    job.items.push({ id: `item-${job.items.length + 1}`, title: `i${i}`, prompt: 'p', queueTaskId: `q${i}` });
    tasks.push({ id: `q${i}`, title: `i${i}`, prompt: 'p', addedBy: 'x', addedAt: 1, status: 'done', outcome: 'done', finishedAt: 2_000_000 });
  }
  return { tasks, jobs };
}

test('re-review 1: a paid provider that is down costs one call, not a queue of them; items are reviewed after recovery', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chief-rr1-'));
  const w = world(12);
  let now = 1_000_000;
  let down = true;
  let calls = 0;
  const chat: ChatFn = async (p) => { calls++; if (down) throw new Error('HTTP 503'); return { text: REVIEW, model: p.model, usage: { input: 10, output: 10 }, cost: { usd: 0.001, kind: 'paid-estimate', label: 'x' } }; };
  const brain = new ChiefBrain(dir, { keys: () => ({ ANTHROPIC_API_KEY: 'sk-test-not-real' }), chat, now: () => now, queue: () => ({ tasks: w.tasks, maxWorkers: 0 }),
    office: { create: () => { throw new Error('no'); }, snapshot: () => ({ revision: 1, jobs: w.jobs as never }) } });
  brain.updateSettings({ mode: 'premium', premiumModel: 'm', premiumPrice: [3, 15], dailyCapUsd: 50 });
  brain.reconcile();
  await brain.idle();
  assert.equal(calls, 1, 'only the first queued call reached the provider');
  assert.equal(brain.state().reviews.filter((r) => r.status === 'needs_attention').length, 1, 'skipped reviews are not marked needs attention');
  now += 11 * 60_000;
  down = false;
  for (let i = 0; i < 5; i++) { brain.reconcile(); await brain.idle(); }
  assert.equal(brain.state().reviews.filter((r) => r.status === 'reviewed').length, 11, 'the skipped items are reviewed after the hold');
  assert.equal(calls, 12);
  rmSync(dir, { recursive: true, force: true });
});

test('re-review 2: Telegram still refuses /approve <jobId> for a model plan after 61 newer plans', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chief-rr2-'));
  const tasks: QueueTask[] = [];
  const q = { state: (): QueueState => ({ tasks, maxWorkers: 0 }), add: () => undefined };
  const office = new Consultancy(dir, q);
  const inbox = new ApprovalInbox(dir, office);
  let answer = PLAN;
  const brain = new ChiefBrain(dir, { keys: () => ({}), office, queue: q.state, onChange: () => inbox.reconcile(),
    chat: async (p) => ({ text: answer, model: p.model, usage: { input: 1, output: 1 }, cost: { usd: 0, kind: 'local', label: 'US$0' } }) });
  inbox.setChief({ check: () => undefined, apply: () => '' }, (jobId) => (brain.planFor(jobId) ? brain.label() : undefined));
  brain.updateSettings({ mode: 'free' });
  brain.requestPlan({ requestId: 'first', client: 'A', title: 'First', brief: 'b' }, 'CEO', 'api');
  await brain.idle();
  const jobId = brain.state().plans[0].jobId!;
  answer = 'not json';
  for (let i = 0; i < 61; i++) { brain.requestPlan({ requestId: `n${i}`, client: 'B', title: `T${i}`, brief: 'b' }, 'CEO', 'api'); await brain.idle(); }
  assert.ok(brain.state().plans.some((p) => p.jobId === jobId), 'a proposed plan whose job is pending is kept');
  const bot = chiefCommands(office, () => 'desks', inbox, undefined, undefined, undefined, brain);
  assert.match(bot.execute(`/approve ${jobId}`, 'tg-x'), /review the prompts in the game/i);
  // Even if the chief's record were gone, the inbox item's proposedBy still refuses it.
  const bare = chiefCommands(office, () => 'desks', inbox);
  assert.match(bare.execute(`/approve ${jobId}`, 'tg-y'), /review the prompts in the game/i);
  assert.equal(office.snapshot().jobs.find((j) => j.id === jobId)!.decision, 'pending_approval');
  rmSync(dir, { recursive: true, force: true });
});

test('re-review 3: the seen set drops keys whose task or job is gone, without re-reviewing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chief-rr3-'));
  const w = world(16);
  let calls = 0;
  const chat: ChatFn = async (p) => { calls++; return { text: REVIEW, model: p.model, usage: { input: 1, output: 1 }, cost: { usd: 0, kind: 'local', label: 'US$0' } }; };
  const brain = new ChiefBrain(dir, { keys: () => ({}), chat, now: () => 1_000_000, queue: () => ({ tasks: w.tasks, maxWorkers: 0 }),
    office: { create: () => { throw new Error('no'); }, snapshot: () => ({ revision: 1, jobs: w.jobs as never }) } });
  brain.updateSettings({ mode: 'free' });
  for (let i = 0; i < 4; i++) { brain.reconcile(); await brain.idle(); }
  assert.equal(calls, 16);
  assert.equal(brain.seenCount(), 16);
  w.tasks.splice(0, 8); // the CEO cleared the first job's finished tasks
  w.jobs.splice(0, 1);
  brain.reconcile();
  await brain.idle();
  assert.equal(brain.seenCount(), 8, 'keys for cleared tasks and gone jobs are dropped');
  for (let i = 0; i < 3; i++) { brain.reconcile(); await brain.idle(); }
  assert.equal(calls, 16, 'nothing is reviewed again');
  rmSync(dir, { recursive: true, force: true });
});

test('re-review 4: the plan shows exactly the prompts that will be queued ({{jobId}} resolved)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chief-rr4-'));
  const tasks: QueueTask[] = [];
  const q = { state: (): QueueState => ({ tasks, maxWorkers: 0 }), add: () => undefined };
  const office = new Consultancy(dir, q);
  const brain = new ChiefBrain(dir, { keys: () => ({}), office, queue: q.state,
    chat: async (p) => ({ text: JSON.stringify({ items: [item(1, 'Write docs/empire/{{jobId}}.md'), item(2)] }), model: p.model, usage: { input: 1, output: 1 }, cost: { usd: 0, kind: 'local', label: 'US$0' } }) });
  brain.updateSettings({ mode: 'free' });
  brain.requestPlan({ requestId: 'tok', client: 'A', title: 'T', brief: 'b' }, 'CEO', 'api');
  await brain.idle();
  const plan = brain.state().plans[0];
  const job = office.snapshot().jobs[0];
  assert.match(job.items[0].prompt, new RegExp(`docs/empire/${job.id}\\.md`));
  assert.deepEqual(plan.items!.map((i) => i.prompt), job.items.map((i) => i.prompt));
  rmSync(dir, { recursive: true, force: true });
});
