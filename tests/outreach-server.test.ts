// ORG-04a through the real server: routes, auth, the inbox and a fake SMTP transport. No message leaves the process.
import test from 'node:test';
import { scryptSync } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../src/server/server.js';
import { Auth } from '../src/server/auth.js';
import type { Config } from '../src/server/config.js';
import type { WorkerRuntime } from '../src/server/workers.js';
import type { MailMessage } from '../src/server/email.js';

const JOB = 'consultancy-00000000a0a1';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-outreach-server-'));
  // The drafting task already finished (outcome done) for the reserved job id, so approval binds to it and nothing runs.
  writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ maxWorkers: 0, tasks: [{ id: 'q-draft', jobKey: `consultancy:${JOB}:item-1`, title: 'Draft', prompt: 'x', addedBy: 'CEO', addedAt: 1, status: 'done', outcome: 'done', workerName: 'Wren', finishedAt: 2 }] }));
  mkdirSync(path.join(dir, 'docs/empire/campaigns'), { recursive: true });
  writeFileSync(path.join(dir, `docs/empire/campaigns/${JOB}.md`), '---\nsubject: Hello {{name}}\naudience: [all]\n---\nHi {{name}} at {{company}}.\n');
  const cfg: Config = { dir, dataDir: dir, host: '127.0.0.1', port: 0, passwordGenerated: false, verifier: scryptSync('fixture-password', Buffer.alloc(16, 2), 32), salt: Buffer.alloc(16, 2), secret: 'fixture-only-secret', claimed: true, markClaimed() {}, agentCmd: 'claude', agentArgs: [], trustProxy: false, iceServers: [], budgetPause: false };
  const runtime: WorkerRuntime = { taskNaming: false, resolveCommand: () => '/fixture/claude', processExists: () => false, spawn: (() => { throw new Error('no worker may start in this test'); }) as WorkerRuntime['spawn'] };
  const sent: MailMessage[] = [];
  const running = await startServer(cfg, {
    publicDir: dir, backgroundServices: false, workers: runtime, telegram: false, email: false,
    outreach: { config: { from: 'sales@acme.example', address: 'Acme Ltd, 1 Main St, Springfield', dailyCap: 200, intervalMs: 10_000, problems: [] }, transport: { send: async (m) => { sent.push(m); } } },
  });
  const port = (running.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const cookie = `ao_session_${port}=${new Auth(cfg.verifier, cfg.salt, cfg.secret).issue()}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach((s) => s.close());
    await new Promise<void>((resolve) => { running.server.once('close', () => resolve()); running.shutdown(); });
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (route: string, body?: unknown, headers: Record<string, string> = { cookie, origin }) => fetch(`${origin}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function welcome() {
    const ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { origin, headers: { cookie } });
    sockets.push(ws);
    return new Promise<any>((resolve, reject) => { ws.on('error', reject); ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.t === 'welcome') resolve(m); }); });
  }
  return { call, running, sent, welcome, cookie };
}

test('outreach routes: authenticated, same-origin to change, validated; the whole flow sends through the fake transport only', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/outreach', undefined, {})).status, 401);
  assert.equal((await f.call('/api/outreach/suppression', { email: 'a@b.example', reason: 'opt_out' }, { cookie: f.cookie })).status, 403, 'a cookie without Origin cannot change anything');
  const state = await (await f.call('/api/outreach')).json();
  assert.equal(state.status.sendingEnabled, true);
  assert.equal(state.status.label, 'Outreach sending: enabled');

  const imported = await (await f.call('/api/outreach/leads/import', { csv: 'name,email,company,source,basis\nAnn,ann@client.example,Northwind,inbound,existing customer\nBob,bob@client.example,Harbor,conference,consent\nNo,bad,X,s,b' })).json();
  assert.deepEqual([imported.added, imported.errors.length], [2, 1]);
  assert.equal((await f.call('/api/outreach/suppression', { email: 'bob@client.example', reason: 'bounce' })).status, 400, 'the CEO adds opt-outs or blocks; bounces come from SMTP');
  assert.equal((await f.call('/api/outreach/suppression', { email: 'bob@client.example', reason: 'opt_out' })).status, 200);
  assert.equal((await f.call('/api/outreach/campaigns', { requestId: 'x', title: '', brief: 'b' })).status, 400);

  // The drafting job uses the reserved id whose task already finished.
  const campaign = f.running.outreach.createCampaign({ requestId: 'c1', title: 'Autumn', brief: 'Tell customers.' }, 'CEO', { jobId: JOB });
  const plan = (await (await f.call('/api/approvals')).json()).items.find((i: any) => i.kind === 'job_plan');
  assert.equal(plan.title, 'Internal · Campaign draft: Autumn');
  assert.equal((await f.call(`/api/approvals/${plan.id}/approve`, {})).status, 200);
  const after = await (await f.call('/api/outreach')).json();
  const c = after.campaigns.find((x: any) => x.id === campaign.id);
  assert.equal(c.state, 'awaiting_approval');
  assert.equal(c.draft.draftedBy, 'Wren');
  const send = (await (await f.call('/api/approvals')).json()).items.find((i: any) => i.kind === 'external_action');
  assert.equal(send.raisedBy, 'marketing_sales');
  assert.deepEqual(send.outreach.recipients, ['ann@client.example']);
  assert.equal(send.outreach.excluded.suppressed, 1);
  const w = await f.welcome();
  const marketing = w.org.executives.find((e: any) => e.role === 'marketing_sales');
  assert.equal(marketing.active, true);
  assert.equal(marketing.attention, 1);
  assert.match(marketing.summary, /1 campaign · 2 leads · 1 send waiting for approval/);

  assert.equal((await f.call(`/api/approvals/${send.id}/approve`, { budgetUsd: 3 })).status, 400);
  assert.equal((await f.call(`/api/approvals/${send.id}/approve`, {})).status, 200);
  for (let i = 0; i < 40 && !f.sent.length; i++) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(f.sent.map((m) => m.to), ['ann@client.example']);
  assert.equal(f.sent[0].subject, 'Hello Ann');
  assert.match(f.sent[0].text, /Reply STOP to stop receiving these emails\.\n$/);
  const done = (await (await f.call('/api/outreach')).json()).campaigns[0];
  assert.equal(done.state, 'completed');
  assert.equal(done.counts.sent, 1);
  assert.equal((await f.call(`/api/outreach/campaigns/${campaign.id}/pause`, {})).status, 409);
  assert.equal((await f.call('/api/outreach/campaigns/C99/cancel', {})).status, 404);
});
