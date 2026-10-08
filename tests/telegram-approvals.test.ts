import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Consultancy } from '../src/server/consultancy.js';
import { ApprovalInbox } from '../src/server/approvals.js';
import { chiefCommands } from '../src/server/chief-commands.js';
import { TelegramBridge, type TelegramTransport, type TelegramUpdate } from '../src/server/telegram.js';
import type { QueueTask } from '../src/shared/protocol.js';

function office(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-tg-approvals-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tasks: QueueTask[] = [];
  const costs: Record<string, number> = {};
  const queue = { state: () => ({ tasks, maxWorkers: 0 }), add: (prompt: string, by: string, title?: string, _i?: number, jobKey?: string) => {
    if (!tasks.some((x) => x.jobKey === jobKey)) tasks.push({ id: `q${tasks.length + 1}`, jobKey, prompt, addedBy: by, title: title ?? '', addedAt: 1, status: 'queued' });
    return undefined;
  } };
  let inbox!: ApprovalInbox;
  const consultancy = new Consultancy(dir, queue, () => inbox?.reconcile(), { taskCost: (id) => costs[id] });
  inbox = new ApprovalInbox(dir, consultancy);
  let decisions = 0;
  let raises = 0;
  const raise = consultancy.raiseBudget.bind(consultancy);
  consultancy.raiseBudget = (...args) => { raises++; return raise(...args); };
  const chief = chiefCommands(consultancy, () => 'resources', inbox, () => { decisions++; });
  return { dir, tasks, costs, consultancy, inbox, chief, decisions: () => decisions, raises: () => raises };
}

test('/approvals lists pending items of every kind; /approve and /reject work by inbox id and by job id', (t) => {
  const f = office(t);
  assert.match(f.chief.execute('/approvals', 'r1'), /Nothing is waiting for your approval/);
  f.chief.execute('/new Acme | Portal | Secret brief text', 'r2');
  f.chief.execute('/new Beta | Audit | Another brief', 'r3');
  const list = f.chief.execute('/approvals', 'r4');
  assert.match(list, /A1 · Client plan · Acme · Portal/);
  assert.match(list, /A2 · Client plan · Beta · Audit/);
  assert.doesNotMatch(list, /Secret brief/, 'the list never carries briefs');
  assert.match(f.chief.execute('/approve A1 lots', 'r5'), /Use \/approve ID/);
  assert.match(f.chief.execute('/approve A99', 'r6'), /Unknown approval/);
  // Inbox id, lower case accepted, with a budget.
  assert.match(f.chief.execute('/approve a1 4', 'r7'), /A1 approved/);
  const acme = f.consultancy.snapshot().jobs.find((j) => j.client === 'Acme')!;
  assert.equal(acme.decision, 'approved');
  assert.equal(acme.approvedBudgetUsd, 4);
  assert.equal(f.inbox.get('A1')!.decidedBy, 'CEO via Telegram');
  // The existing job-id form still works and resolves the inbox item.
  const beta = f.consultancy.snapshot().jobs.find((j) => j.client === 'Beta')!;
  assert.match(f.chief.execute(`/reject ${beta.id}`, 'r8'), /declined/);
  assert.equal(f.inbox.get('A2')!.status, 'rejected');
  assert.match(f.chief.execute('/reject A2', 'r9'), /A2 is already rejected/);
  // A budget increase: item 1 finishes over budget.
  Object.assign(f.tasks[0], { status: 'done', outcome: 'done', finishedAt: 2 });
  f.costs[f.tasks[0].id] = 4.5;
  f.consultancy.reconcile();
  assert.match(f.chief.execute('/approvals', 'r10'), /A3 · Budget increase · Acme · Portal reached its budget · spent \$4\.50 of \$4\.00/);
  assert.match(f.chief.execute('/approve A3 3', 'r11'), /must exceed/);
  assert.match(f.chief.execute('/approve A3 12', 'r12'), /A3 approved · budget \$12\.00/);
  assert.equal(f.consultancy.snapshot().jobs.find((j) => j.client === 'Acme')!.approvedBudgetUsd, 12);
  assert.match(f.chief.execute('/approve A3 99', 'r12'), /A3 is already approved/);
});

test('each new pending approval sends one Telegram message; the first poll is a silent baseline', async (t) => {
  const f = office(t);
  const config = { token: '123456:fake_token_for_tests_only_123', ownerId: 42 };
  const sent: string[] = [];
  const transport: TelegramTransport = { async call(method, body) {
    if (method === 'getUpdates') return [] as TelegramUpdate[];
    sent.push(String(body.text));
    return { message_id: 1 };
  } };
  f.chief.execute('/new Old | Before | brief', 'b1');
  const bot = new TelegramBridge(f.dir, config, f.chief, transport, () => 1_800_000_000_000);
  await bot.tick();
  assert.equal(sent.length, 0, 'what was pending before the first poll is a silent baseline');
  // A plan saved on the founder desk (not by /new, whose reply already says so).
  f.consultancy.create({ requestId: 'b2', client: 'Acme', title: 'Portal', brief: 'Secret brief text' }, 'CEO');
  await bot.tick();
  const approvalMessages = sent.filter((s) => /^Approval A2/.test(s));
  assert.equal(approvalMessages.length, 1);
  assert.match(approvalMessages[0], /Client plan/);
  assert.match(approvalMessages[0], /\/approve A2/);
  assert.doesNotMatch(approvalMessages[0], /Secret brief/);
  await bot.tick();
  assert.equal(sent.filter((s) => /^Approval A2/.test(s)).length, 1, 'never twice');
  // A restart remembers what was announced.
  const again = new TelegramBridge(f.dir, config, f.chief, transport, () => 1_800_000_000_000);
  await again.tick();
  assert.equal(sent.filter((s) => /^Approval /.test(s)).length, 1);
});

function overBudget(f: ReturnType<typeof office>) {
  f.chief.execute('/new Acme | Portal | brief', 'o1');
  f.chief.execute('/approve A1 4', 'o2');
  Object.assign(f.tasks[0], { status: 'done', outcome: 'done', finishedAt: 2 });
  f.costs[f.tasks[0].id] = 4.5;
  f.consultancy.reconcile();
  return f.inbox.pending()[0];
}

test('review fix 1: after /reject the reply says how to raise the budget later, and /approve reopens it once', (t) => {
  const f = office(t);
  const item = overBudget(f);
  const declined = f.chief.execute(`/reject ${item.id}`, 'x1');
  assert.match(declined, new RegExp(`/approve ${item.id}`));
  assert.match(declined, /game inbox/);
  assert.match(f.chief.execute(`/approve ${item.id} 12`, 'x2'), new RegExp(`${item.id} approved · budget \\$12\\.00`));
  assert.equal(f.consultancy.snapshot().jobs[0].approvedBudgetUsd, 12);
  assert.match(f.chief.execute(`/approve ${item.id} 20`, 'x3'), /already approved/);
  assert.equal(f.raises(), 1);
});

test('review: the game and Telegram approving the same item raise the budget once; Telegram decisions pump the queue', (t) => {
  const f = office(t);
  const item = overBudget(f);
  const before = f.decisions();
  f.inbox.approve(item.id, 'CEO', { budgetUsd: 9 });
  assert.match(f.chief.execute(`/approve ${item.id} 15`, 'y1'), /already approved/);
  assert.equal(f.raises(), 1);
  assert.equal(f.consultancy.snapshot().jobs[0].approvedBudgetUsd, 9);
  f.chief.execute('/new Beta | Audit | brief', 'y2');
  f.chief.execute('/reject A3', 'y3');
  assert.ok(f.decisions() >= before + 1, 'a Telegram decision pumps the queue like the HTTP route');
});

test('review fix 7: a plan created with /new is not announced again as a new approval', async (t) => {
  const f = office(t);
  const config = { token: '123456:fake_token_for_tests_only_123', ownerId: 42 };
  const now = 1_800_000_000_000;
  const sent: string[] = [];
  let updates: TelegramUpdate[] = [];
  const transport: TelegramTransport = { async call(method, body) {
    if (method === 'getUpdates') { const u = updates; updates = []; return u; }
    sent.push(String(body.text));
    return { message_id: 1 };
  } };
  const bot = new TelegramBridge(f.dir, config, f.chief, transport, () => now);
  await bot.tick();
  updates = [{ update_id: 7, message: { date: now / 1000, text: '/new Acme | Portal | brief', from: { id: 42 }, chat: { id: 42, type: 'private' } } }];
  await bot.tick();
  await bot.tick();
  assert.ok(sent.some((s) => /saved for Acme/.test(s)), 'the reply was sent');
  assert.equal(sent.filter((s) => /^Approval A1/.test(s)).length, 0, 'no duplicate approval notice');
});
