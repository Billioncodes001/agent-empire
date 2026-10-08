import test from 'node:test';
import { scryptSync } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer, type ServerRuntime } from '../src/server/server.js';
import { Auth } from '../src/server/auth.js';
import type { Config } from '../src/server/config.js';
import type { WorkerRuntime } from '../src/server/workers.js';

// No worker process ever starts (concurrency 0, a runtime that refuses to spawn), no Telegram, no email.
async function fixture(t: { after(fn: () => Promise<void>): void }, extra: Partial<ServerRuntime> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-approvals-server-'));
  writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ tasks: [], maxWorkers: 0 }));
  const cfg: Config = { dir, dataDir: dir, host: '127.0.0.1', port: 0, passwordGenerated: false, verifier: scryptSync('fixture-password', Buffer.alloc(16, 2), 32), salt: Buffer.alloc(16, 2), secret: 'fixture-only-secret', claimed: true, markClaimed() {}, agentCmd: 'claude', agentArgs: [], trustProxy: false, iceServers: [], budgetPause: false };
  const runtime: WorkerRuntime = { taskNaming: false, resolveCommand: () => '/fixture/claude', processExists: () => false, spawn: (() => { throw new Error('no worker may start in this test'); }) as WorkerRuntime['spawn'] };
  const running = await startServer(cfg, { publicDir: dir, backgroundServices: false, workers: runtime, telegram: false, email: false, ...extra });
  const port = (running.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const cookie = `ao_session_${port}=${new Auth(cfg.verifier, cfg.salt, cfg.secret).issue()}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach((s) => s.close());
    await new Promise<void>((resolve) => { running.server.once('close', () => resolve()); running.shutdown(); });
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (route: string, body?: unknown, headers: Record<string, string> = { cookie, origin }) => fetch(`${origin}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
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
  return { call, connect, cookie, origin, running };
}

const waitFor = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); }
};

test('approval routes are authenticated and need a same-origin Origin to decide', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/approvals', undefined, {})).status, 401);
  assert.equal((await f.call('/api/approvals/A1/approve', {}, {})).status, 401);
  assert.equal((await f.call('/api/approvals/A1/approve', {}, { cookie: f.cookie })).status, 403, 'a cookie without Origin cannot decide');
  const empty = await (await f.call('/api/approvals')).json();
  assert.equal(empty.pending, 0);
  assert.deepEqual(empty.items, []);
  assert.equal((await f.call('/api/approvals/A1/approve', {})).status, 404);
  assert.equal((await f.call('/api/approvals/consultancy-x/approve', {})).status, 404);
});

test('a new plan reaches the inbox, the welcome and an approvals message; approve validates the budget like ORG-02', async (t) => {
  const f = await fixture(t);
  const messages = await f.connect();
  assert.equal(messages[0].approvals.pending, 0, 'welcome carries the inbox');
  const job = await (await f.call('/api/consultancy/jobs', { requestId: 'inbox-1', client: 'Acme', title: 'Portal', brief: 'Fixture only' })).json();
  await waitFor(() => messages.some((m) => m.t === 'approvals' && m.state.pending === 1));
  await waitFor(() => messages.some((m) => m.t === 'org' && m.state.executives.find((e: any) => e.role === 'chief_of_staff').attention === 1));
  const state = await (await f.call('/api/approvals')).json();
  const [item] = state.items;
  assert.equal(item.kind, 'job_plan');
  assert.equal(item.jobId, job.id);
  assert.equal(item.status, 'pending');
  for (const budgetUsd of ['lots', 0, -1, 100_001]) assert.equal((await f.call(`/api/approvals/${item.id}/approve`, { budgetUsd })).status, 400, `budget ${budgetUsd}`);
  assert.equal((await f.call(`/api/approvals/${item.id}/approve`, '{bad')).status, 400);
  const approved = await (await f.call(`/api/approvals/${item.id}/approve`, { budgetUsd: 9 })).json();
  assert.equal(approved.status, 'approved');
  assert.equal(approved.budgetUsd, 9);
  const seen = (await (await f.call('/api/consultancy/jobs')).json()).jobs[0];
  assert.equal(seen.decision, 'approved');
  assert.equal(seen.approvedBudgetUsd, 9, 'the founder desk sees the inbox decision');
  const again = await f.call(`/api/approvals/${item.id}/reject`, {});
  assert.equal(again.status, 200);
  assert.equal((await again.json()).status, 'approved', 'a decided item keeps its decision');
  await waitFor(() => messages.some((m) => m.t === 'approvals' && m.state.pending === 0));
  const count = messages.filter((m) => m.t === 'approvals').length;
  await new Promise((r) => setTimeout(r, 300));
  await f.call('/api/approvals');
  assert.equal(messages.filter((m) => m.t === 'approvals').length, count, 'approvals is sent on change only');
});

test('status reports email; with email set up, a new pending approval sends exactly one email', async (t) => {
  const plain = await fixture(t);
  const status = await (await plain.call('/api/consultancy/status')).json();
  assert.equal(status.email.label, 'Email: not configured');
  const sent: any[] = [];
  const f = await fixture(t, { email: { transport: { async send(m) { sent.push(m); } }, to: 'ceo@example.com', from: 'empire@example.com' } });
  assert.equal((await (await f.call('/api/consultancy/status')).json()).email.label, 'Email: configured');
  await f.call('/api/consultancy/jobs', { requestId: 'mail-1', client: 'Acme', title: 'Mailed', brief: 'Secret brief only' });
  await waitFor(() => sent.length === 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /A1/);
  assert.doesNotMatch(sent[0].text, /Secret brief/);
});

test('a plan approved on the founder desk resolves its inbox item', async (t) => {
  const f = await fixture(t);
  const job = await (await f.call('/api/consultancy/jobs', { requestId: 'desk-1', client: 'Acme', title: 'Desk', brief: 'Fixture only' })).json();
  assert.equal((await (await f.call('/api/approvals')).json()).pending, 1);
  assert.equal((await f.call(`/api/consultancy/jobs/${job.id}/approve`, {})).status, 200);
  const state = await (await f.call('/api/approvals')).json();
  assert.equal(state.pending, 0);
  assert.equal(state.items[0].status, 'approved');
});

test('review: a signed-in device (bearer token) can list and decide without an Origin; a bad token cannot', async (t) => {
  const f = await fixture(t);
  const login = await fetch(`${f.origin}/api/device/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'fixture-password', deviceName: 'Phone' }) });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const bearer = { authorization: `Bearer ${token}` };
  await f.call('/api/consultancy/jobs', { requestId: 'dev-1', client: 'Acme', title: 'Device', brief: 'Fixture only' });
  const listed = await f.call('/api/approvals', undefined, bearer);
  assert.equal(listed.status, 200);
  const [item] = (await listed.json()).items;
  const decided = await f.call(`/api/approvals/${item.id}/reject`, {}, bearer);
  assert.equal(decided.status, 200);
  assert.equal((await decided.json()).status, 'rejected');
  assert.equal((await f.call('/api/approvals', undefined, { authorization: 'Bearer not-a-real-token' })).status, 401);
});
