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

// No worker process is ever started: the queue is paused (concurrency 0) and the runtime spawns nothing real.
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-org-server-'));
  writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ tasks: [], maxWorkers: 0 }));
  const cfg: Config = { dir, dataDir: dir, host: '127.0.0.1', port: 0, passwordGenerated: false, verifier: Buffer.alloc(32, 1), salt: Buffer.alloc(16, 2), secret: 'fixture-only-secret', claimed: true, markClaimed() {}, agentCmd: 'claude', agentArgs: [], trustProxy: false, iceServers: [], budgetPause: false };
  const runtime: WorkerRuntime = { taskNaming: false, resolveCommand: () => '/fixture/claude', processExists: () => false, spawn: (() => { throw new Error('no worker may start in this test'); }) as WorkerRuntime['spawn'] };
  const running = await startServer(cfg, { publicDir: dir, backgroundServices: false, workers: runtime, telegram: false });
  const port = (running.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const cookie = `ao_session_${port}=${new Auth(cfg.verifier, cfg.salt, cfg.secret).issue()}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach((s) => s.close());
    await new Promise<void>((resolve) => { running.server.once('close', () => resolve()); running.shutdown(); });
    rmSync(dir, { recursive: true, force: true });
  });
  const api = (route: string, body?: unknown) => fetch(`${origin}/api/consultancy/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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

test('welcome carries the rule-based roster and an org message follows a change', async (t) => {
  const f = await fixture(t);
  const messages = await f.connect();
  const welcome = messages[0];
  assert.equal(welcome.org.schemaVersion, 1);
  assert.deepEqual(welcome.org.executives.map((e: any) => e.role), ['chief_of_staff', 'operations', 'finance', 'marketing_sales', 'research']);
  assert.ok(welcome.org.executives.every((e: any) => e.monitor === 'rule_based'));
  assert.equal(welcome.org.executives.find((e: any) => e.role === 'research').summary, 'Not staffed yet');
  assert.equal(welcome.org.executives.find((e: any) => e.role === 'chief_of_staff').attention, 0);
  const created = await (await f.api('jobs', { requestId: 'org-1', client: 'Acme', title: 'Portal', brief: 'Fixture only', tasks: [{ title: 'Build', prompt: 'Build it' }, { title: 'Test', prompt: 'Test it', phase: 'testing' }] })).json();
  assert.equal(created.estimate.basis.source, 'default', 'no history yet: the stated default');
  assert.deepEqual(created.items.map((i: any) => i.phase), ['build', 'testing']);
  await waitFor(() => messages.some((m) => m.t === 'org' && m.state.executives.find((e: any) => e.role === 'chief_of_staff').attention === 1));
  const approved = await (await f.api(`jobs/${created.id}/approve`, { budgetUsd: 9.5 })).json();
  assert.equal(approved.approvedBudgetUsd, 9.5);
  assert.equal((await f.api(`jobs/${created.id}/approve`, { budgetUsd: 'lots' })).status, 400, 'a malformed budget is refused');
  assert.equal((await (await f.api(`jobs/${created.id}/approve`, {})).json()).approvedBudgetUsd, 9.5, 'a repeat approval keeps the budget');
  const other = await (await f.api('jobs', { requestId: 'org-2', client: 'Acme', title: 'Other', brief: 'Fixture only' })).json();
  assert.equal((await f.api(`jobs/${other.id}/approve`, { budgetUsd: 'lots' })).status, 400);
  const defaulted = await (await f.api(`jobs/${other.id}/approve`, {})).json();
  assert.equal(defaulted.approvedBudgetUsd, 3, 'default: the top of the rough default range');
});

test('review fix 3: the server carries consultancy item order into the queue as dependsOn', async (t) => {
  const f = await fixture(t);
  const job = await (await f.api('jobs', { requestId: 'order-1', client: 'Acme', title: 'Ordered', brief: 'Fixture only', tasks: [{ title: 'First', prompt: 'one' }, { title: 'Second', prompt: 'two' }] })).json();
  assert.equal((await f.api(`jobs/${job.id}/approve`, {})).status, 200);
  const welcome = (await f.connect())[0];
  const tasks = welcome.queue.tasks.filter((q: any) => q.jobKey?.startsWith(`consultancy:${job.id}:`));
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[1].dependsOn, [tasks[0].id]);
  assert.ok(tasks.every((q: any) => q.status === 'queued'), 'concurrency 0: nothing started');
});
