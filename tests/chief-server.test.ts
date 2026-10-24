import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../src/server/server.js';
import { Auth } from '../src/server/auth.js';
import type { Config } from '../src/server/config.js';
import type { WorkerRuntime } from '../src/server/workers.js';
import type { ChatFn } from '../src/server/chief.js';
import { ChiefBrain } from '../src/server/chief.js';
import { Consultancy } from '../src/server/consultancy.js';
import { ApprovalInbox } from '../src/server/approvals.js';
import { chiefCommands } from '../src/server/chief-commands.js';
import type { QueueState, QueueTask } from '../src/shared/protocol.js';

const PLAN = JSON.stringify({ summary: 'Two steps.', items: [
  { title: 'Build the API', prompt: 'Build it with tests.', phase: 'build', role: 'backend_engineer', parallel: false, dependsOn: [] },
  { title: 'Test it', prompt: 'Test it end to end.', phase: 'testing', role: 'qa_tester', parallel: false, dependsOn: [1] },
] });

/** The fake model: Ollama-shaped provider in, a fixed plan out. No network. */
const calls: string[] = [];
const fakeChat: ChatFn = async (p) => { calls.push(`${p.id}:${p.model}`); return { text: PLAN, model: p.model, usage: { input: 1, output: 1 }, cost: { usd: 0, kind: 'local', label: 'US$0 · local model' } }; };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-chief-server-'));
  writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ tasks: [], maxWorkers: 0 }));
  const cfg: Config = { dir, dataDir: dir, host: '127.0.0.1', port: 0, passwordGenerated: false, verifier: Buffer.alloc(32, 1), salt: Buffer.alloc(16, 2), secret: 'fixture-only-secret', claimed: true, markClaimed() {}, agentCmd: 'claude', agentArgs: [], trustProxy: false, iceServers: [], budgetPause: false };
  const runtime: WorkerRuntime = { taskNaming: false, resolveCommand: () => '/fixture/claude', processExists: () => false, spawn: (() => { throw new Error('no worker may start in this test'); }) as WorkerRuntime['spawn'] };
  const running = await startServer(cfg, { publicDir: dir, backgroundServices: false, workers: runtime, telegram: false, engines: { providerKeys: () => ({}) }, chief: { chat: fakeChat } });
  const port = (running.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const cookie = `ao_session_${port}=${new Auth(cfg.verifier, cfg.salt, cfg.secret).issue()}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach((s) => s.close());
    await new Promise<void>((resolve) => { running.server.once('close', () => resolve()); running.shutdown(); });
    rmSync(dir, { recursive: true, force: true });
  });
  const api = (route: string, body?: unknown, o: { origin?: string } = {}) => fetch(`${origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: o.origin ?? origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function connect() {
    const ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { origin, headers: { cookie } });
    sockets.push(ws);
    const messages: any[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No welcome')), 3000);
      ws.on('error', reject);
      ws.on('message', () => { if (messages[0]?.t === 'welcome') { clearTimeout(timeout); resolve(); } });
    });
    return messages;
  }
  return { api, connect };
}

const waitFor = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); }
};

test('/api/chief: off by default, settings, a proposed plan reaches the inbox, the chief card says model-backed', async (t) => {
  const f = await fixture(t);
  const messages = await f.connect();
  assert.equal(messages[0].chief.brain.mode, 'off');
  assert.equal(messages[0].org.executives[0].monitor, 'rule_based');
  assert.equal((await f.api('chief/plans', { requestId: 'x', client: 'A', title: 'B', brief: 'C' })).status, 409, 'brain off: no plan');
  assert.equal((await f.api('chief/settings', { mode: 'free' }, { origin: 'http://evil.example' })).status, 403, 'cross-origin refused');
  const set = await f.api('chief/settings', { mode: 'free', freeModel: 'gpt-oss:20b' });
  assert.equal(set.status, 200);
  const state = await set.json();
  assert.equal(state.brain.ready, true);
  assert.ok(!JSON.stringify(state).includes('apiKey'), 'no credential fields');
  const res = await f.api('chief/plans', { requestId: 'srv-1', client: 'Northwind', title: 'Portal', brief: 'Fixture only' });
  assert.equal(res.status, 202);
  await waitFor(() => messages.some((m) => m.t === 'chief' && m.state.plans[0]?.status === 'proposed'));
  assert.deepEqual(calls, ['ollama:gpt-oss:20b']);
  await waitFor(() => messages.some((m) => m.t === 'approvals' && m.state.items.some((i: any) => i.kind === 'job_plan' && i.proposedBy === 'Model-backed · gpt-oss:20b · proposals only')));
  await waitFor(() => messages.some((m) => m.t === 'org' && m.state.executives[0].monitor === 'model_backed' && m.state.executives[0].model === 'gpt-oss:20b'));
  const jobs = await (await f.api('consultancy/jobs')).json();
  assert.equal(jobs.jobs[0].decision, 'pending_approval');
  assert.equal(jobs.jobs[0].items.length, 2);
});

test('Telegram /plan proposes through the same brain; a failed plan is announced with the reason', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chief-telegram-'));
  const tasks: QueueTask[] = [];
  const queue = { state: (): QueueState => ({ tasks, maxWorkers: 0 }), add: () => undefined };
  const office = new Consultancy(dir, queue);
  const inbox = new ApprovalInbox(dir, office);
  let answer = PLAN;
  const brain = new ChiefBrain(dir, { keys: () => ({}), office, queue: queue.state, chat: async (p) => ({ text: answer, model: p.model, usage: { input: 0, output: 0 }, cost: { usd: 0, kind: 'local', label: 'US$0' } }), onChange: () => inbox.reconcile() });
  inbox.setChief({ check: () => undefined, apply: () => '' }, (jobId) => (brain.planFor(jobId) ? brain.label() : undefined));
  const bot = chiefCommands(office, () => 'desks', inbox, undefined, undefined, undefined, brain);
  assert.match(bot.execute('/plan A | B | C', 'tg-1'), /planning brain is off/);
  brain.updateSettings({ mode: 'free' });
  assert.match(bot.execute('/plan Northwind', 'tg-2'), /Use \/plan Client \| Job title \| Brief/);
  assert.match(bot.execute('/plan Northwind | Portal | Clients book online', 'tg-3'), /drafting a proposed plan .* Nothing starts before you approve/);
  assert.match(bot.execute('/plan Northwind | Portal | Clients book online', 'tg-3'), /drafting|already proposed/, 'replay is idempotent');
  await brain.idle();
  const pending = bot.notifications!().find((n) => /Client plan/.test(n.text))!;
  assert.match(pending.text, /model-backed|Model-backed/);
  assert.match(pending.text, /approve in the game or on the founder desk/i);
  assert.doesNotMatch(pending.text, /\/approve A1/);
  const jobId = brain.state().plans[0].jobId!;
  assert.match(bot.execute(`/job ${jobId}`, 'tg-4'), /Proposed by the chief .*\n1\. Build the API · Backend engineer\nRole: Backend engineer\.\n\nBuild it with tests\.\n2\. Test it · QA tester · after 1/);
  answer = 'no json here';
  bot.execute('/plan Harbor | Audit | Review it', 'tg-5');
  await brain.idle();
  const failed = bot.notifications!().find((n) => n.key.startsWith('chief-plan:'))!;
  assert.match(failed.text, /could not propose a plan for Harbor · Audit .*not a single JSON object/s);
  assert.equal(office.snapshot().jobs.length, 1, 'nothing created for the failed plan');
  rmSync(dir, { recursive: true, force: true });
});
