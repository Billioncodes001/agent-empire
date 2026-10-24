/**
 * FREE-08 through the real server: same-origin writes, secrets never echoed, resumable progress across a restart, old
 * installs not offered, env precedence, saved budget, and "send test" to fake Telegram/ntfy/SMTP servers on loopback.
 * No real Telegram, ntfy or SMTP; no worker process; nothing is sent unless a test endpoint is called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, type ServerRuntime } from '../src/server/server.js';
import { Auth } from '../src/server/auth.js';
import { Empire } from '../src/server/empire.js';
import type { Config } from '../src/server/config.js';
import type { WorkerRuntime } from '../src/server/workers.js';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SMTP_PASS = 'smtp-pass-never-echoed';
const NTFY_TOKEN = 'tk_ntfytokennotechoed12345';

async function fakeHttp() {
  const hits: { url?: string; auth?: string; body: string }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { hits.push({ url: req.url, auth: req.headers.authorization, body }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"result":{}}'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { hits, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

async function fakeSmtp() {
  const log: string[] = [];
  const server = net.createServer((socket) => {
    let buf = '', data = false;
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (line === '.') { data = false; socket.write('250 queued\r\n'); } else log.push(`DATA ${line}`); continue; }
        log.push(line);
        if (/^EHLO/.test(line)) socket.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) socket.write('235 ok\r\n');
        else if (/^(MAIL|RCPT)/.test(line)) socket.write('250 ok\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 go\r\n'); }
        else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { log, port: (server.address() as { port: number }).port, close: () => server.close() };
}

function repo(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: dir });
  return dir;
}

async function boot(t: { after(fn: () => Promise<void> | void): void }, o: { root?: string; founded?: boolean; env?: NodeJS.ProcessEnv; telegramBase?: string; budget?: number } = {}) {
  const root = o.root ?? realpathSync(mkdtempSync(path.join(tmpdir(), 'empire-onboarding-server-')));
  const office = path.join(root, 'office');
  const dataDir = path.join(office, '.agent-office');
  if (!o.root) { repo(office); mkdirSync(dataDir); }
  if (o.founded) { const e = new Empire(dataDir, () => {}); e.action({ kind: 'found', sites: [] }); e.flush(); }
  const cfg: Config = { dir: office, dataDir, host: '127.0.0.1', port: 0, passwordGenerated: false, verifier: Buffer.alloc(32, 1), salt: Buffer.alloc(16, 2), secret: 'fixture-only-secret', claimed: true, markClaimed() {}, agentCmd: 'claude', agentArgs: [], trustProxy: false, iceServers: [], budgetPause: false,
    ...(o.budget ? { budget: o.budget, budgetSource: 'cli' as const } : {}) };
  const workers: WorkerRuntime = { taskNaming: false, resolveCommand: () => '/fixture/claude', processExists: () => false, spawn: (() => { throw new Error('no worker may start'); }) as WorkerRuntime['spawn'] };
  const runtime: ServerRuntime = { publicDir: dataDir, backgroundServices: false, workers, outreach: false, engines: { providerKeys: () => ({}) },
    notify: { env: o.env ?? {}, ...(o.telegramBase ? { telegramApiBase: o.telegramBase } : {}) } };
  const running = await startServer(cfg, runtime);
  const port = (running.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const cookie = `ao_session_${port}=${new Auth(cfg.verifier, cfg.salt, cfg.secret).issue()}`;
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await new Promise<void>((r) => { running.server.once('close', () => r()); running.shutdown(); }); };
  t.after(async () => { await stop(); if (!o.root) rmSync(root, { recursive: true, force: true }); });
  const api = async (route: string, method = 'GET', body?: unknown, from = origin) => {
    const res = await fetch(`${origin}/api/${route}`, { method, headers: { cookie, origin: from, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await res.text();
    return { status: res.status, raw, json: (() => { try { return JSON.parse(raw); } catch { return null; } })() as any };
  };
  return { root, dataDir, api, stop };
}

test('cross-origin writes and test sends are refused, and nothing reaches the fake servers', async (t) => {
  const ntfy = await fakeHttp();
  t.after(() => ntfy.close());
  const f = await boot(t);
  const evil = 'http://evil.example';
  assert.equal((await f.api('settings', 'PUT', { profile: { name: 'Evil' } }, evil)).status, 403);
  assert.equal((await f.api('onboarding/progress', 'POST', { action: 'dismiss' }, evil)).status, 403);
  assert.equal((await f.api('settings', 'PUT', { notifications: { ntfy: { server: ntfy.base, topic: 'empire-topic-abc' } } })).status, 200);
  assert.equal((await f.api('settings/test/ntfy', 'POST', {}, evil)).status, 403);
  assert.equal(ntfy.hits.length, 0, 'saving and refused requests send nothing');
  const view = (await f.api('onboarding')).json;
  assert.equal(view.settings.profile.name, '', 'the refused write changed nothing');
  assert.equal(view.progress.status, 'not_started');
});

test('secrets are accepted, reported only as present, never echoed or stored in plain text', async (t) => {
  const f = await boot(t);
  const put = await f.api('settings', 'PUT', { notifications: { telegram: { ownerId: '424242' } }, secrets: { telegramToken: TOKEN, smtpPassword: SMTP_PASS, ntfyToken: NTFY_TOKEN } });
  assert.equal(put.status, 200, put.raw);
  for (const s of [TOKEN, SMTP_PASS, NTFY_TOKEN]) assert.ok(!put.raw.includes(s), 'not in the response');
  assert.deepEqual(put.json.settings.secrets, { telegramToken: true, ntfyToken: true, smtpPassword: true });
  const get = await f.api('onboarding');
  for (const s of [TOKEN, SMTP_PASS, NTFY_TOKEN]) assert.ok(!get.raw.includes(s), 'not in GET');
  for (const file of ['settings.json', 'secrets.enc', 'onboarding.json']) {
    const text = readFileSync(path.join(f.dataDir, file), 'utf8');
    for (const s of [TOKEN, SMTP_PASS, NTFY_TOKEN]) assert.ok(!text.includes(s), `not in ${file}`);
  }
  const bad = await f.api('settings', 'PUT', { secrets: { telegramToken: 'not-a-token' } });
  assert.equal(bad.status, 400);
  assert.ok(!bad.raw.includes('not-a-token'), 'errors never repeat the value');
  assert.equal((await f.api('settings', 'PUT', { secrets: { claudeToken: 'x' } })).status, 400, 'there is no Claude credential field');
  const removed = await f.api('settings', 'PUT', { secrets: { smtpPassword: null } });
  assert.equal(removed.json.settings.secrets.smtpPassword, false);
  assert.equal(removed.json.settings.channels.telegram.source, 'saved');
  assert.equal(removed.json.settings.channels.telegram.running, false, 'tests and previews never start a real bot');
});

test('progress is resumable across a restart and steps can be skipped; settings persist', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'empire-onboarding-resume-')));
  repo(path.join(root, 'office'));
  mkdirSync(path.join(root, 'office', '.agent-office'));
  const a = await boot(t, { root, founded: true });
  let v = (await a.api('onboarding')).json;
  assert.equal(v.progress.legacy, true, 'founded before onboarding existed');
  await a.stop();
  // A fresh, unfounded install instead:
  const root2 = realpathSync(mkdtempSync(path.join(tmpdir(), 'empire-onboarding-resume2-')));
  repo(path.join(root2, 'office'));
  mkdirSync(path.join(root2, 'office', '.agent-office'));
  const b = await boot(t, { root: root2 });
  v = (await b.api('onboarding')).json;
  assert.equal(v.progress.legacy, false);
  assert.equal(v.offer, false, 'not before founding');
  assert.equal((await b.api('settings', 'PUT', { profile: { name: 'Northwind Studio', mission: 'Booking software for clinics' } })).status, 200);
  assert.equal((await b.api('onboarding/progress', 'POST', { action: 'step', step: 'profile', result: 'done' })).status, 200);
  v = (await b.api('onboarding/progress', 'POST', { action: 'step', step: 'engines', result: 'skipped' })).json;
  assert.equal(v.progress.current, 'notifications');
  assert.equal((await b.api('onboarding/progress', 'POST', { action: 'nonsense' })).status, 400);
  await b.stop();
  // Founded later (by the founding dialog), then the host restarts: onboarding resumes at the same step and is offered.
  const e = new Empire(path.join(root2, 'office', '.agent-office'), () => {}); e.action({ kind: 'found', sites: [] }); e.flush();
  const c = await boot(t, { root: root2 });
  // Registered after the servers' own cleanup, so the directories go only once every host has stopped and flushed.
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(root2, { recursive: true, force: true }); });
  v = (await c.api('onboarding')).json;
  assert.equal(v.progress.legacy, false, 'legacy is decided once, on the first start');
  assert.equal(v.progress.current, 'notifications');
  assert.deepEqual(v.progress.steps, { profile: 'done', engines: 'skipped', notifications: 'pending', approvals: 'pending' });
  assert.equal(v.offer, true);
  assert.equal(v.settings.profile.name, 'Northwind Studio');
  v = (await c.api('onboarding/progress', 'POST', { action: 'dismiss' })).json;
  assert.equal(v.offer, false);
  v = (await c.api('onboarding/progress', 'POST', { action: 'reopen' })).json;
  assert.equal(v.progress.current, 'notifications', 're-opened from Settings at the first unanswered step');
});

test('old installs are not offered onboarding', async (t) => {
  const f = await boot(t, { founded: true });
  const v = (await f.api('onboarding')).json;
  assert.equal(v.progress.legacy, true);
  assert.equal(v.offer, false);
  const opened = (await f.api('onboarding/progress', 'POST', { action: 'reopen' })).json;
  assert.equal(opened.progress.status, 'in_progress');
  assert.equal(opened.offer, false, 'still never pushed automatically');
});

test('environment variables win over saved settings, and the test send uses them', async (t) => {
  const tg = await fakeHttp();
  t.after(() => tg.close());
  const envToken = '987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const f = await boot(t, { env: { AGENT_EMPIRE_TELEGRAM_TOKEN: envToken, AGENT_EMPIRE_TELEGRAM_OWNER_ID: '777' }, telegramBase: tg.base, budget: 5 });
  const put = await f.api('settings', 'PUT', { notifications: { telegram: { ownerId: '111' } }, secrets: { telegramToken: TOKEN }, approvals: { dailyBudgetUsd: 9, pauseHiring: true } });
  assert.equal(put.status, 200);
  assert.equal(put.json.settings.channels.telegram.source, 'env');
  assert.deepEqual(put.json.settings.budget, { source: 'cli', usd: 5, pause: false }, '--budget overrides the saved budget');
  assert.equal(put.json.settings.approvals.dailyBudgetUsd, 9, 'the saved value is kept for when the override goes');
  assert.equal(tg.hits.length, 0);
  const sent = await f.api('settings/test/telegram', 'POST', {});
  assert.equal(sent.status, 200, sent.raw);
  assert.equal(tg.hits.length, 1);
  assert.equal(tg.hits[0].url, `/bot${envToken}/sendMessage`);
  assert.equal(JSON.parse(tg.hits[0].body).chat_id, 777);
  assert.ok(!sent.raw.includes(envToken));
  assert.equal((await f.api('settings/test/telegram', 'POST', {})).status, 429, 'tests are rate limited');
});

test('saved settings: test sends reach fake Telegram, ntfy and SMTP servers only when clicked; saved budget applies', async (t) => {
  const tg = await fakeHttp(), ntfy = await fakeHttp(), smtp = await fakeSmtp();
  t.after(() => { tg.close(); ntfy.close(); smtp.close(); });
  const f = await boot(t, { telegramBase: tg.base });
  assert.equal((await f.api('settings/test/ntfy', 'POST', {})).status, 400, 'nothing to test before saving');
  const put = await f.api('settings', 'PUT', {
    profile: { name: 'Northwind' },
    notifications: {
      telegram: { ownerId: '424242' },
      ntfy: { server: ntfy.base, topic: 'empire-topic-abcdef' },
      email: { host: '127.0.0.1', port: smtp.port, security: 'starttls', user: 'bot@example.com', to: 'ceo@example.com', from: '' },
    },
    approvals: { dailyBudgetUsd: 12.5, pauseHiring: true },
    secrets: { telegramToken: TOKEN, ntfyToken: NTFY_TOKEN, smtpPassword: SMTP_PASS },
  });
  assert.equal(put.status, 200, put.raw);
  assert.deepEqual(put.json.settings.budget, { source: 'saved', usd: 12.5, pause: true });
  assert.equal(put.json.settings.channels.email.source, 'saved');
  assert.equal(put.json.settings.channels.ntfy.configured, true);
  assert.equal(tg.hits.length + ntfy.hits.length + smtp.log.length, 0, 'saving sends nothing');

  const t1 = await f.api('settings/test/telegram', 'POST', {});
  assert.equal(t1.status, 200, t1.raw);
  assert.equal(tg.hits[0].url, `/bot${TOKEN}/sendMessage`);
  assert.equal(JSON.parse(tg.hits[0].body).chat_id, 424242);
  assert.match(JSON.parse(tg.hits[0].body).text, /^Northwind: test notification/);

  const t2 = await f.api('settings/test/ntfy', 'POST', {});
  assert.equal(t2.status, 200, t2.raw);
  assert.equal(ntfy.hits[0].auth, `Bearer ${NTFY_TOKEN}`);
  assert.equal(JSON.parse(ntfy.hits[0].body).topic, 'empire-topic-abcdef');

  const t3 = await f.api('settings/test/email', 'POST', {});
  assert.equal(t3.status, 200, t3.raw);
  assert.ok(smtp.log.some((l) => l === `AUTH PLAIN ${Buffer.from(`\0bot@example.com\0${SMTP_PASS}`).toString('base64')}`));
  assert.ok(smtp.log.includes('RCPT TO:<ceo@example.com>'));
  assert.ok(smtp.log.includes('MAIL FROM:<bot@example.com>'));
  for (const r of [t1, t2, t3]) for (const s of [TOKEN, NTFY_TOKEN, SMTP_PASS]) assert.ok(!r.raw.includes(s));

  const status = (await f.api('consultancy/status')).json;
  assert.equal(status.ntfy.state, 'not_configured', 'tests and previews do not deliver approvals (backgroundServices off)');
  // Settings validation is strict: unknown keys and bad values are refused without changing anything.
  assert.equal((await f.api('settings', 'PUT', { approvals: { dailyBudgetUsd: -1 } })).status, 400);
  assert.equal((await f.api('settings', 'PUT', { notifications: { ntfy: { server: 'http://192.168.1.9', topic: 'x' } } })).status, 200, 'saved, but reported');
  const v = (await f.api('onboarding')).json;
  assert.match(v.settings.channels.ntfy.error, /https/);
});
