/** CITY-10: the architect over the office host's API and WebSocket (fake model; no network; no worker starts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../src/server/server.js';
import { Auth } from '../src/server/auth.js';
import type { Config } from '../src/server/config.js';
import type { WorkerRuntime } from '../src/server/workers.js';
import type { ChatFn } from '../src/server/chief.js';

const modelCalls: string[] = [];
const fakeChat: ChatFn = async (p) => { modelCalls.push(p.id); return { text: '{"changes": []}', model: p.model, usage: { input: 1, output: 1 }, cost: { usd: 0, kind: 'local', label: 'US$0 · local model' } }; };

test('/api/architect: own-server only, off by default, Origin-checked, Run now raises the inbox summary, undo and journal export', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-architect-server-'));
  writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ tasks: [], maxWorkers: 0 }));
  const cfg: Config = { dir, dataDir: dir, host: '127.0.0.1', port: 0, passwordGenerated: false, verifier: Buffer.alloc(32, 1), salt: Buffer.alloc(16, 2), secret: 'fixture-only-secret', claimed: true, markClaimed() {}, agentCmd: 'claude', agentArgs: [], trustProxy: false, iceServers: [], budgetPause: false };
  const runtime: WorkerRuntime = { taskNaming: false, resolveCommand: () => '/fixture/claude', processExists: () => false, spawn: (() => { throw new Error('no worker may start in this test'); }) as WorkerRuntime['spawn'] };
  const running = await startServer(cfg, { publicDir: dir, backgroundServices: false, workers: runtime, telegram: false, engines: { providerKeys: () => ({}) }, chief: { chat: fakeChat }, architect: { chat: fakeChat } });
  const port = (running.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const cookie = `ao_session_${port}=${new Auth(cfg.verifier, cfg.salt, cfg.secret).issue()}`;
  const ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { origin, headers: { cookie } });
  t.after(async () => {
    ws.close();
    await new Promise<void>((resolve) => { running.server.once('close', () => resolve()); running.shutdown(); });
    rmSync(dir, { recursive: true, force: true });
  });
  const messages: any[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => { const to = setTimeout(() => reject(new Error('no welcome')), 3000); ws.on('message', () => { if (messages[0]?.t === 'welcome') { clearTimeout(to); resolve(); } }); });
  const api = (route: string, body?: unknown, o: { origin?: string } = {}) => fetch(`${origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: o.origin ?? origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  assert.equal(messages[0].architect.available, true);
  assert.equal(messages[0].architect.settings.enabled, false);
  assert.equal((await api('architect/run', {})).status, 409, 'off: no run');
  assert.ok(!existsSync(path.join(dir, 'world', 'additions.json')));
  assert.equal((await api('architect/settings', { enabled: true }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await api('architect/settings', { enabled: true, spend: 1 })).status, 400);
  assert.equal((await api('architect/settings', { enabled: true })).status, 200);
  const run = await (await api('architect/run', {})).json();
  assert.equal(run.status, 'applied');
  assert.equal(run.engine, 'rules');
  assert.equal(modelCalls.length, 0, 'rule-based growth calls no model');
  assert.equal((await api('architect/run', {})).status, 409, 'once a day');
  const inbox = await (await api('approvals')).json();
  const item = inbox.items.find((i: { kind: string }) => i.kind === 'architect_summary');
  assert.ok(item, 'the daily summary is in the inbox');
  const undone = await api('architect/undo', { changeId: run.changes[0].id });
  assert.equal(undone.status, 200);
  assert.equal((await undone.json()).world.additions.length, run.changes.length - 1);
  const md = await api('architect/journal.md');
  assert.match(await md.text(), /# City architect journal/);
  assert.ok(messages.some((m) => m.t === 'architect' && m.state.world.additions.length === run.changes.length), 'game clients receive the additions');
  // Declining the summary reverts the rest of the day.
  const declined = await (await api(`approvals/${item.id}/reject`, {})).json();
  assert.match(declined.note ?? '', /Reverted/);
  assert.equal((await (await api('architect')).json()).world.additions.length, 0);
});
