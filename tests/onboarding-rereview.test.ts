/**
 * FREE-08 re-review fixes, each failing before its change:
 *  1 overlapping saves leave exactly one Telegram bridge, on the latest settings
 *  2 private-range bypasses (numeric hosts, trailing dots, IPv4-compatible and NAT64 IPv6, DNS answers), with a fake
 *    resolver only, and connections pinned to the checked address
 *  3 the re-target guard holds while the secret store cannot be read
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OnboardingError, OnboardingService } from '../src/server/onboarding.js';
import { FileSecretStore } from '../src/server/secrets.js';
import { guardedLookup, ntfyTransport, refusedTarget, type Resolver } from '../src/server/notify.js';
import { smtpTransport } from '../src/server/email.js';
import { startServer } from '../src/server/server.js';
import { Auth } from '../src/server/auth.js';
import type { Config } from '../src/server/config.js';
import type { WorkerRuntime } from '../src/server/workers.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'empire-onboarding-rereview-'));
const status = (fn: () => unknown) => { try { fn(); return 200; } catch (e) { return e instanceof OnboardingError ? e.status : 500; } };
const statusAsync = async (fn: () => Promise<unknown>) => { try { await fn(); return 200; } catch (e) { return e instanceof OnboardingError ? e.status : 500; } };
const fakeDns = (table: Record<string, string[]>, calls: string[] = []): Resolver => async (host) => {
  calls.push(host);
  const a = table[host];
  if (!a) throw new Error('ENOTFOUND');
  return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

test('2: numeric, trailing-dot, IPv4-compatible and NAT64 forms are refused on a server install', () => {
  const dir = tmp();
  try {
    const s = new OnboardingService(dir, new FileSecretStore(dir), { legacy: false });
    for (const host of ['2130706433', '0x7f000001', '0x0a000001', '0177.0.0.1', '127.1', 'localhost.'])
      assert.equal(status(() => s.updateSettings({ notifications: { email: { host, to: 'ceo@example.com' } } })), 400, `SMTP ${host}`);
    for (const server of ['https://localhost./', 'https://foo.local./', 'https://[::127.0.0.1]', 'https://[64:ff9b::a00:1]', 'https://[::ffff:10.0.0.1]', 'https://[::]'])
      assert.equal(status(() => s.updateSettings({ notifications: { ntfy: { server, topic: 'empire-x' } } })), 400, `ntfy ${server}`);
    assert.equal(refusedTarget('ntfy.sh.', false), undefined, 'a public name with a trailing dot is fine');
    assert.equal(refusedTarget('2001:db8::1', false), undefined);
    assert.equal(refusedTarget('::127.0.0.1', true) !== undefined, true, 'IPv4-compatible forms are refused even on the desktop');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('2: on a server install every DNS answer is checked before saving (fake resolver, no real lookup)', async () => {
  const dir = tmp();
  try {
    const calls: string[] = [];
    const resolve = fakeDns({ 'localtest.me': ['127.0.0.1'], 'mixed.example': ['93.184.216.34', '10.0.0.5'], 'mail.example': ['93.184.216.34'], 'push.example': ['2606:4700::1'] }, calls);
    const s = new OnboardingService(dir, new FileSecretStore(dir), { legacy: false });
    assert.equal(await statusAsync(() => s.checkTargets({ notifications: { ntfy: { server: 'https://localtest.me', topic: 'x' } } }, resolve)), 400);
    assert.equal(await statusAsync(() => s.checkTargets({ notifications: { email: { host: 'mixed.example' } } }, resolve)), 400, 'one private answer is enough to refuse');
    assert.equal(await statusAsync(() => s.checkTargets({ notifications: { email: { host: 'unknown.example' } } }, resolve)), 400);
    assert.equal(await statusAsync(() => s.checkTargets({ notifications: { email: { host: 'mail.example' }, ntfy: { server: 'https://push.example', topic: 'x' } } }, resolve)), 200);
    assert.deepEqual(calls, ['localtest.me', 'mixed.example', 'unknown.example', 'push.example', 'mail.example']);
    mkdirSync(path.join(dir, 'd'));
    const desktop = new OnboardingService(path.join(dir, 'd'), new FileSecretStore(dir), { legacy: false, allowLocalTargets: true });
    assert.equal(await statusAsync(() => desktop.checkTargets({ notifications: { ntfy: { server: 'https://localtest.me', topic: 'x' } } }, resolve)), 200, 'the desktop keeps loopback');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('2: ntfy and SMTP connect only to the checked, pinned address', async () => {
  const ntfyHits: string[] = [];
  const ntfy = createServer((req, res) => { ntfyHits.push(String(req.headers.host)); res.writeHead(200); res.end(); });
  await new Promise<void>((r) => ntfy.listen(0, '127.0.0.1', r));
  const smtpLines: string[] = [];
  const smtp = net.createServer((socket) => {
    socket.write('220 fake\r\n');
    let buf = '', data = false;
    socket.on('data', (c) => {
      buf += c; let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (line === '.') { data = false; socket.write('250 ok\r\n'); } continue; }
        smtpLines.push(line);
        if (/^EHLO/.test(line)) socket.write('250 fake\r\n'); else if (line === 'DATA') { data = true; socket.write('354 go\r\n'); } else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); } else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  const np = (ntfy.address() as { port: number }).port, sp = (smtp.address() as { port: number }).port;
  const resolve = fakeDns({ 'ntfy.test': ['127.0.0.1'], 'mail.test': ['127.0.0.1'] });
  const message = { from: 'bot@example.com', to: 'ceo@example.com', subject: 's', text: 't' };
  try {
    await ntfyTransport({ server: `http://ntfy.test:${np}`, topic: 'empire-x' }, { guard: { allowLoopback: true, resolve } }).send(message);
    assert.deepEqual(ntfyHits, [`ntfy.test:${np}`], 'pinned to the checked address, with the configured Host');
    await assert.rejects(ntfyTransport({ server: `http://ntfy.test:${np}`, topic: 'empire-x' }, { guard: { allowLoopback: false, resolve } }).send(message), /refused address|loopback/);
    // URL parsing turns https://0x7f000001 into 127.0.0.1, which is then refused as loopback.
    await assert.rejects(ntfyTransport({ server: 'https://0x7f000001', topic: 'empire-x' }, { guard: { allowLoopback: false, resolve } }).send(message), /loopback/);
    assert.equal(ntfyHits.length, 1, 'refused sends never connect');
    await smtpTransport({ secure: false, host: 'mail.test', port: sp }, { timeoutMs: 2000, refuse: (h) => refusedTarget(h, true), lookup: guardedLookup(true, resolve) }).send(message);
    assert.ok(smtpLines.includes('RCPT TO:<ceo@example.com>'));
    const before = smtpLines.length;
    await assert.rejects(smtpTransport({ secure: false, host: 'mail.test', port: sp }, { timeoutMs: 2000, refuse: (h) => refusedTarget(h, false), lookup: guardedLookup(false, resolve) }).send(message));
    await assert.rejects(smtpTransport({ secure: false, host: '2130706433', port: sp }, { timeoutMs: 2000, refuse: (h) => refusedTarget(h, false), lookup: guardedLookup(false, resolve) }).send(message), /plain IPv4/);
    assert.equal(smtpLines.length, before, 'refused SMTP never connects');
  } finally { ntfy.closeAllConnections(); ntfy.close(); smtp.close(); }
});

test('3: while the secret store is unreadable, ntfy server and SMTP target changes are refused', () => {
  const dir = tmp();
  try {
    const store = new FileSecretStore(dir);
    const s = new OnboardingService(dir, store, { legacy: false });
    s.updateSettings({ notifications: { ntfy: { server: 'https://push.example.com', topic: 'empire-x' }, email: { host: 'smtp.example.com', port: 587, to: 'ceo@example.com' } }, secrets: { ntfyToken: 'tk_token_value_123', smtpPassword: 'pass' } });
    writeFileSync(path.join(dir, 'secrets.enc'), 'garbage');
    assert.equal(status(() => s.updateSettings({ notifications: { ntfy: { server: 'https://attacker.example' } } })), 409);
    for (const email of [{ host: 'attacker.example' }, { port: 2525 }, { security: 'tls' }])
      assert.equal(status(() => s.updateSettings({ notifications: { email } })), 409, JSON.stringify(email));
    assert.equal(s.settings().notifications.ntfy.server, 'https://push.example.com');
    assert.equal(status(() => s.updateSettings({ profile: { name: 'Still editable' } })), 200, 'other settings still save');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('1: overlapping Telegram saves leave exactly one bridge, polling with the latest token', async (t) => {
  const polls: string[] = [];
  const tg = createServer((req, res) => {
    const token = /\/bot([^/]+)\//.exec(req.url ?? '')?.[1] ?? '';
    req.resume();
    if (req.url?.endsWith('/getUpdates')) { polls.push(token); setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"result":[]}'); }, 300); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"result":{}}'); }
  });
  await new Promise<void>((r) => tg.listen(0, '127.0.0.1', r));
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'empire-onboarding-bridges-')));
  const office = path.join(root, 'office'), dataDir = path.join(office, '.agent-office');
  mkdirSync(dataDir, { recursive: true });
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: office });
  const cfg: Config = { dir: office, dataDir, host: '127.0.0.1', port: 0, passwordGenerated: false, verifier: Buffer.alloc(32, 1), salt: Buffer.alloc(16, 2), secret: 'fixture-only-secret', claimed: true, markClaimed() {}, agentCmd: 'claude', agentArgs: [], trustProxy: false, iceServers: [], budgetPause: false };
  const workers: WorkerRuntime = { taskNaming: false, resolveCommand: () => '/fixture/claude', processExists: () => false, spawn: (() => { throw new Error('no worker may start'); }) as WorkerRuntime['spawn'] };
  const running = await startServer(cfg, { publicDir: dataDir, backgroundServices: false, workers, outreach: false, engines: { providerKeys: () => ({}) },
    notify: { env: {}, start: true, allowLocalTargets: true, telegramApiBase: `http://127.0.0.1:${(tg.address() as { port: number }).port}` } });
  t.after(async () => { await new Promise<void>((r) => { running.server.once('close', () => r()); running.shutdown(); }); tg.closeAllConnections(); tg.close(); rmSync(root, { recursive: true, force: true }); });
  const port = (running.server.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const cookie = `ao_session_${port}=${new Auth(cfg.verifier, cfg.salt, cfg.secret).issue()}`;
  const put = (body: unknown) => fetch(`${origin}/api/settings`, { method: 'PUT', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const token = (c: string) => `123456789:${c.repeat(35)}`;
  assert.equal((await put({ notifications: { telegram: { ownerId: '42' } }, secrets: { telegramToken: token('A') } })).status, 200);
  for (let i = 0; i < 40 && !polls.length; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(polls.length, 'bridge A is polling');
  const b = put({ secrets: { telegramToken: token('B') } });
  await new Promise((r) => setTimeout(r, 40));
  const c = put({ secrets: { telegramToken: token('C') } });
  assert.deepEqual([(await b).status, (await c).status], [200, 200]);
  await new Promise((r) => setTimeout(r, 1500));
  polls.length = 0;
  await new Promise((r) => setTimeout(r, 2600));
  assert.ok(polls.length >= 1, 'one bridge keeps polling');
  assert.deepEqual([...new Set(polls)], [token('C')], `only the latest token polls: ${[...new Set(polls)].map((p) => p.slice(10, 11)).join(',')}`);
});
