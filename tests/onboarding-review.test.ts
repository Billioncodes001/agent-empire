/**
 * FREE-08 security review fixes. Each test failed before its fix:
 *  1 desktop delivery (notify.start) · 2 re-targeting keeps secrets · 3 execution offer marked seen too early
 *  4 budget pause precedence · 5 NOTIFY_FROM alone · 6 unbounded ntfy response · 7 private targets on server hosts
 *  8 corrupt secrets shown as "not saved" · 9 key file mode · 10 partial secret writes · 11 Telegram stop/idle race
 *  (12, desktop keys:save validation, is in desktop-vault.test.ts.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OnboardingError, OnboardingService } from '../src/server/onboarding.js';
import { FileSecretStore, type SecretStore } from '../src/server/secrets.js';
import { ntfyTransport, resolveBudget, resolveEmail } from '../src/server/notify.js';
import { TelegramBridge, type TelegramTransport } from '../src/server/telegram.js';
import { DEFAULT_SETTINGS, advance, executionOfferAnswered, initialProgress, type SecretName } from '../src/shared/onboarding.js';
import { startServer } from '../src/server/server.js';
import { Auth } from '../src/server/auth.js';
import { Empire } from '../src/server/empire.js';
import type { Config } from '../src/server/config.js';
import type { WorkerRuntime } from '../src/server/workers.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'empire-onboarding-review-'));
const service = (dir: string, allowLocalTargets = false) => new OnboardingService(dir, new FileSecretStore(dir), { legacy: false, allowLocalTargets });
const status = (fn: () => unknown) => { try { fn(); return 200; } catch (e) { return e instanceof OnboardingError ? e.status : 500; } };

test('2: changing the ntfy server needs the token again (or removes it); it never follows to a new host', () => {
  const dir = tmp();
  try {
    const s = service(dir);
    s.updateSettings({ notifications: { ntfy: { server: 'https://push.example.com', topic: 'empire-topic' } }, secrets: { ntfyToken: 'tk_original_token_123' } });
    assert.equal(status(() => s.updateSettings({ notifications: { ntfy: { server: 'https://attacker.example' } } })), 400);
    assert.equal(new FileSecretStore(dir).get('ntfyToken'), 'tk_original_token_123', 'refused: nothing changed');
    assert.equal(s.settings().notifications.ntfy.server, 'https://push.example.com');
    assert.equal(status(() => s.updateSettings({ notifications: { ntfy: { server: 'https://push.example.com/' } } })), 200, 'the same server (normalised) keeps it');
    assert.equal(status(() => s.updateSettings({ notifications: { ntfy: { server: 'https://other.example' } }, secrets: { ntfyToken: null } })), 200);
    assert.equal(new FileSecretStore(dir).get('ntfyToken'), undefined);
    assert.equal(status(() => s.updateSettings({ notifications: { ntfy: { server: 'https://third.example' } }, secrets: { ntfyToken: 'tk_new_token_value_456' } })), 200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('2: changing the SMTP host, port or security needs the password again', () => {
  const dir = tmp();
  try {
    const s = service(dir);
    s.updateSettings({ notifications: { email: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me@example.com', to: 'ceo@example.com' } }, secrets: { smtpPassword: 'original-pass' } });
    for (const change of [{ host: 'evil.example' }, { port: 2525 }, { security: 'tls' }])
      assert.equal(status(() => s.updateSettings({ notifications: { email: change } })), 400, JSON.stringify(change));
    assert.equal(new FileSecretStore(dir).get('smtpPassword'), 'original-pass');
    assert.equal(status(() => s.updateSettings({ notifications: { email: { to: 'other@example.com' } } })), 200, 'the recipient is not a target for the password');
    assert.equal(status(() => s.updateSettings({ notifications: { email: { host: 'mail.example.org' } }, secrets: { smtpPassword: 'new-pass' } })), 200);
    assert.equal(new FileSecretStore(dir).get('smtpPassword'), 'new-pass');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('3: the execution offer counts as answered only when the Workers step is done or skipped', () => {
  let p = initialProgress(false);
  assert.equal(executionOfferAnswered(p), false, 'opening onboarding is not enough');
  p = advance(p, 'profile', 'done', 1);
  assert.equal(executionOfferAnswered(p), false, 'closing after step 1 keeps the execution offer');
  assert.equal(executionOfferAnswered(advance(p, 'engines', 'skipped', 2)), true);
  assert.equal(executionOfferAnswered(advance(p, 'engines', 'done', 2)), true);
});

test('4: AGENT_OFFICE_BUDGET_PAUSE on the host beats the saved "pause hiring"', () => {
  const saved = structuredClone(DEFAULT_SETTINGS);
  saved.approvals = { dailyBudgetUsd: 9, pauseHiring: false };
  assert.deepEqual(resolveBudget({ pause: true, pauseSource: 'env' }, saved), { source: 'saved', usd: 9, pause: true });
  saved.approvals.pauseHiring = true;
  assert.deepEqual(resolveBudget({ pause: false, pauseSource: 'env' }, saved), { source: 'saved', usd: 9, pause: false });
  assert.deepEqual(resolveBudget({ pause: false }, saved), { source: 'saved', usd: 9, pause: true });
});

test('5: AGENT_EMPIRE_NOTIFY_FROM on its own is reported, not silently ignored', () => {
  const dir = tmp();
  try {
    const saved = structuredClone(DEFAULT_SETTINGS);
    saved.notifications.email = { host: 'smtp.example.com', port: 587, security: 'starttls', user: '', to: 'ceo@example.com', from: '' };
    const r = resolveEmail({ AGENT_EMPIRE_NOTIFY_FROM: 'x@example.com' }, saved, new FileSecretStore(dir));
    assert.equal(r.source, 'env');
    assert.match(r.error ?? '', /AGENT_EMPIRE_NOTIFY_FROM/);
    assert.equal(r.config, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('6: the ntfy transport never reads an unbounded response body', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(64 * 1024, 120);
    const timer = setInterval(() => res.write(chunk), 5);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const started = Date.now();
    await ntfyTransport({ server: `http://127.0.0.1:${(server.address() as { port: number }).port}`, topic: 'empire-x' }).send({ from: 'a@b.cd', to: 'a@b.cd', subject: 's', text: 't' });
    assert.ok(Date.now() - started < 3000, `returned after ${Date.now() - started} ms`);
  } finally { server.closeAllConnections(); server.close(); }
});

test('7: a server host refuses private, loopback and link-local notification targets; the desktop may use loopback', () => {
  const dir = tmp();
  try {
    const s = service(dir);
    for (const server of ['http://127.0.0.1:8080', 'https://localhost', 'https://10.1.2.3', 'https://192.168.0.9', 'https://172.20.0.1', 'https://169.254.169.254', 'https://[::1]', 'https://[fe80::1]', 'https://[fd00::1]'])
      assert.equal(status(() => s.updateSettings({ notifications: { ntfy: { server, topic: 'empire-x' } } })), 400, server);
    for (const host of ['127.0.0.1', 'localhost', '10.0.0.2', '192.168.1.2', '169.254.0.1'])
      assert.equal(status(() => s.updateSettings({ notifications: { email: { host, to: 'ceo@example.com' } } })), 400, host);
    assert.equal(status(() => s.updateSettings({ notifications: { ntfy: { server: 'https://ntfy.sh', topic: 'empire-x' }, email: { host: 'smtp.example.com', to: 'ceo@example.com' } } })), 200);
    mkdirSync(path.join(dir, 'desktop'));
    const desktop = service(path.join(dir, 'desktop'), true);
    assert.equal(status(() => desktop.updateSettings({ notifications: { ntfy: { server: 'http://127.0.0.1:8080', topic: 'empire-x' }, email: { host: '127.0.0.1', to: 'ceo@example.com' } } })), 200);
    assert.equal(status(() => desktop.updateSettings({ notifications: { ntfy: { server: 'https://169.254.169.254', topic: 'empire-x' } } })), 400, 'link-local stays refused everywhere');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('8: a corrupt secrets file is reported as a storage error, not as "not saved"', () => {
  const dir = tmp();
  try {
    const store = new FileSecretStore(dir);
    store.set('smtpPassword', 'pass-1');
    assert.equal(store.error(), undefined);
    writeFileSync(path.join(dir, 'secrets.enc'), 'garbage');
    assert.match(store.error() ?? '', /could not be opened/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('9: an existing key file is tightened to 0600; the store says the key sits beside the data', () => {
  const dir = tmp();
  try {
    const store = new FileSecretStore(dir);
    store.set('ntfyToken', 'tk_abcdefghijklmnop');
    chmodSync(path.join(dir, 'secrets.key'), 0o644);
    assert.equal(new FileSecretStore(dir).get('ntfyToken'), 'tk_abcdefghijklmnop');
    assert.equal(statSync(path.join(dir, 'secrets.key')).mode & 0o777, 0o600);
    assert.doesNotMatch(store.describe, /out of backups/);
    assert.match(store.describe, /backup of the whole folder/);
    writeFileSync(path.join(dir, 'secrets.key'), '');
    assert.throws(() => new FileSecretStore(dir).set('ntfyToken', 'tk_abcdefghijklmnop'), /could not be opened/, 'an empty key fails closed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('10: a failing secret write rolls back the earlier ones and leaves settings.json unchanged', () => {
  const dir = tmp();
  try {
    const values = new Map<SecretName, string>([['telegramToken', '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']]);
    let fail: SecretName | undefined;
    const store: SecretStore = {
      describe: 'test', names: () => ({ telegramToken: values.has('telegramToken'), ntfyToken: values.has('ntfyToken'), smtpPassword: values.has('smtpPassword') }),
      get: (n) => values.get(n), set: (n, v) => { if (n === fail) throw new Error('disk full'); values.set(n, v); }, delete: (n) => { values.delete(n); },
    };
    const s = new OnboardingService(dir, store, { legacy: false });
    s.updateSettings({ profile: { name: 'Before' } });
    const before = readFileSync(path.join(dir, 'settings.json'), 'utf8');
    fail = 'smtpPassword';
    assert.equal(status(() => s.updateSettings({ profile: { name: 'After' }, secrets: { telegramToken: '987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', ntfyToken: 'tk_new_token_value', smtpPassword: 'x' } })), 409);
    assert.equal(values.get('telegramToken'), '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'restored');
    assert.equal(values.has('ntfyToken'), false, 'removed again');
    assert.equal(readFileSync(path.join(dir, 'settings.json'), 'utf8'), before);
    assert.equal(s.settings().profile.name, 'Before');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('11: a stopped Telegram bridge can be awaited until its in-flight poll has finished', async () => {
  const dir = tmp();
  try {
    let release!: () => void;
    const transport: TelegramTransport = { call: (method) => method === 'getUpdates' ? new Promise((r) => { release = () => r([]); }) : Promise.resolve({}) };
    const bridge = new TelegramBridge(dir, { token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ownerId: 42 }, { execute: () => '', summary: () => ({ fingerprint: 'f', text: 't' }) }, transport);
    const tick = bridge.tick();
    bridge.stop();
    let idle = false;
    const waiting = bridge.idle().then(() => { idle = true; });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(idle, false, 'still polling');
    release();
    await tick; await waiting;
    assert.equal(idle, true);
    assert.equal(existsSync(path.join(dir, 'telegram.json')), false, 'a stopped poll never writes its checkpoint');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('1: with notify.start (the desktop), a new approval is actually delivered to the saved ntfy server', async (t) => {
  const hits: string[] = [];
  const fake = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hits.push(b); res.writeHead(200); res.end('{}'); }); });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'empire-onboarding-deliver-')));
  const office = path.join(root, 'office'), dataDir = path.join(office, '.agent-office');
  mkdirSync(dataDir, { recursive: true });
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: office });
  const e = new Empire(dataDir, () => {}); e.action({ kind: 'found', sites: [] }); e.flush();
  const cfg: Config = { dir: office, dataDir, host: '127.0.0.1', port: 0, passwordGenerated: false, verifier: Buffer.alloc(32, 1), salt: Buffer.alloc(16, 2), secret: 'fixture-only-secret', claimed: true, markClaimed() {}, agentCmd: 'claude', agentArgs: [], trustProxy: false, iceServers: [], budgetPause: false };
  const workers: WorkerRuntime = { taskNaming: false, resolveCommand: () => '/fixture/claude', processExists: () => false, spawn: (() => { throw new Error('no worker may start'); }) as WorkerRuntime['spawn'] };
  const running = await startServer(cfg, { publicDir: dataDir, backgroundServices: false, workers, outreach: false, engines: { providerKeys: () => ({}) }, notify: { env: {}, start: true, allowLocalTargets: true } });
  t.after(async () => { await new Promise<void>((r) => { running.server.once('close', () => r()); running.shutdown(); }); fake.closeAllConnections(); fake.close(); rmSync(root, { recursive: true, force: true }); });
  const port = (running.server.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const cookie = `ao_session_${port}=${new Auth(cfg.verifier, cfg.salt, cfg.secret).issue()}`;
  const api = (route: string, method: string, body: unknown) => fetch(`${origin}/api/${route}`, { method, headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const saved = await api('settings', 'PUT', { notifications: { ntfy: { server: `http://127.0.0.1:${(fake.address() as { port: number }).port}`, topic: 'empire-deliver' } } });
  assert.equal(saved.status, 200);
  const view = await saved.json() as { settings: { channels: { ntfy: { running: boolean; label: string } } } };
  assert.equal(view.settings.channels.ntfy.running, true, view.settings.channels.ntfy.label);
  assert.doesNotMatch(view.settings.channels.ntfy.label, /preview/);
  assert.equal(hits.length, 0, 'saving sends nothing');
  assert.equal((await api('consultancy/jobs', 'POST', { requestId: 'r1', client: 'Northwind', title: 'Booking portal', brief: 'A brief', tasks: [{ title: 'Build', prompt: 'Build it' }] })).status, 200);
  for (let i = 0; i < 50 && !hits.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(hits.length, 1, 'the new pending approval reached the fake ntfy server');
  assert.equal(JSON.parse(hits[0]).topic, 'empire-deliver');
});
