import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer, APP_ORIGINS } from '../src/server/server.js';
import { Auth } from '../src/server/auth.js';
import { sanitizeDeviceName } from '../src/server/devices.js';
import type { Config } from '../src/server/config.js';
import type { WorkerRuntime } from '../src/server/workers.js';

const PASSWORD = 'fixture-password';
const IOS = 'empire-app://game';
const ANDROID = 'https://appassets.androidplatform.net';

const runtime: WorkerRuntime = {
  taskNaming: false, resolveCommand: () => '/fixture/claude', processExists: () => false,
  spawn: (() => { throw new Error('no worker launches in device-auth tests'); }) as WorkerRuntime['spawn'],
};

function makeConfig(dir: string, secret = 'fixture-only-secret', password = PASSWORD): Config {
  const salt = Buffer.alloc(16, 2);
  return {
    dir, dataDir: dir, host: '127.0.0.1', port: 0, passwordGenerated: false, verifier: scryptSync(password, salt, 32), salt, secret,
    claimed: true, markClaimed() {}, agentCmd: 'claude', agentArgs: [], trustProxy: false, iceServers: [], budgetPause: false,
  };
}

async function fixture(t: any) {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-device-auth-'));
  writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ tasks: [], maxWorkers: 1 }));
  let cfg = makeConfig(dir);
  let running = await startServer(cfg, { publicDir: dir, backgroundServices: false, workers: runtime, telegram: false });
  const stop = () => new Promise<void>((resolve) => { running.server.once('close', resolve); running.shutdown(); });
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });
  const port = () => (running.server.address() as { port: number }).port;
  const base = () => `http://127.0.0.1:${port()}`;
  return {
    dir,
    base,
    port,
    cookie: () => `ao_session_${port()}=${new Auth(cfg.verifier, cfg.salt, cfg.secret).issue()}`,
    fetch: (route: string, init: RequestInit = {}) => fetch(`${base()}${route}`, init),
    async deviceLogin(body: unknown, headers: Record<string, string> = {}) {
      return fetch(`${base()}/api/device/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    },
    async token(name = 'Test iPhone') {
      const res = await this.deviceLogin({ password: PASSWORD, deviceName: name });
      assert.equal(res.status, 200);
      return (await res.json()) as { token: string; deviceId: string };
    },
    async restart(next: Partial<{ secret: string; password: string }> = {}) {
      await stop();
      cfg = makeConfig(dir, next.secret, next.password);
      running = await startServer(cfg, { publicDir: dir, backgroundServices: false, workers: runtime, telegram: false });
    },
  };
}

const brief = { requestId: 'device-job-1', client: 'Client A', title: 'Portal', brief: 'Fixture only; do not invoke any external service.' };

function openWs(url: string, protocols: string[] | undefined, headers: Record<string, string>, origin?: string) {
  return new Promise<{ ok: true; ws: WebSocket; protocolHeader: string | undefined; welcome: Promise<any> } | { ok: false; status: number }>((resolve) => {
    const ws = new WebSocket(url, protocols, { origin, headers });
    // Listen from the start: the server's first messages can arrive in the same packet as the handshake.
    const welcome = new Promise<any>((done) => ws.on('message', (m) => { const msg = JSON.parse(m.toString()); if (msg.t === 'welcome') done(msg); }));
    let protocolHeader: string | undefined;
    ws.on('upgrade', (res) => { protocolHeader = res.headers['sec-websocket-protocol'] as string | undefined; });
    ws.on('open', () => resolve({ ok: true, ws, protocolHeader, welcome }));
    ws.on('unexpected-response', (_req, res) => { resolve({ ok: false, status: res.statusCode ?? 0 }); ws.terminate(); });
    ws.on('error', () => resolve({ ok: false, status: 0 }));
  });
}

test('APP_ORIGINS is exactly the two bundled app origins', () => {
  assert.deepEqual([...APP_ORIGINS].sort(), [IOS, ANDROID].sort());
});

test('device login issues a token for the right password and refuses a wrong one', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.deviceLogin({ password: 'nope', deviceName: 'x' })).status, 401);
  assert.equal((await f.fetch('/api/device/login', { method: 'POST', body: 'not json' })).status, 400);
  const { token, deviceId } = await f.token();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(deviceId);
  // No cookie is handed out by device login.
  const again = await f.deviceLogin({ password: PASSWORD, deviceName: 'Pixel' });
  assert.equal(again.headers.get('set-cookie'), null);
});

test('device login shares the cookie login attempt budget', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) {
    const r = await f.fetch('/api/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
    assert.equal(r.status, 401);
  }
  for (let i = 0; i < 5; i++) assert.equal((await f.deviceLogin({ password: 'wrong' })).status, 401);
  // The 11th attempt from this client is refused on either endpoint, even with the right password.
  assert.equal((await f.deviceLogin({ password: PASSWORD })).status, 429);
  assert.equal((await f.fetch('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) })).status, 429);
});

test('bearer token authenticates GETs and mutations without an Origin header', async (t) => {
  const f = await fixture(t);
  const { token, deviceId } = await f.token();
  const auth = { authorization: `Bearer ${token}` };
  const who = await f.fetch('/api/whoami', { headers: auth });
  assert.equal(who.status, 200);
  assert.deepEqual(await who.json(), { ok: true, deviceId });
  const created = await f.fetch('/api/consultancy/jobs', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(brief) });
  assert.equal(created.status, 200);
  // A page (non-API) is served to a bearer client too, and an invalid bearer gets a 401, not a login redirect.
  assert.equal((await f.fetch('/api/whoami', { headers: { authorization: 'Bearer ' + 'A'.repeat(43) } })).status, 401);
  assert.equal((await f.fetch('/', { headers: { authorization: 'Bearer nope' }, redirect: 'manual' })).status, 401);
});

test('cookie requests keep the same-origin check; other auth schemes do not displace the cookie', async (t) => {
  const f = await fixture(t);
  const cookie = f.cookie();
  const post = (headers: Record<string, string>) => f.fetch('/api/consultancy/jobs', { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(brief) });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ origin: IOS })).status, 403);
  assert.equal((await post({ origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await post({ origin: f.base() })).status, 200);
  // A reverse proxy's Basic auth header must not break cookie sessions.
  assert.equal((await f.fetch('/api/whoami', { headers: { cookie, authorization: 'Basic dXNlcjpwdw==' } })).status, 200);
  // Without a cookie, a browser page still redirects to the sign-in page as before.
  assert.equal((await f.fetch('/', { redirect: 'manual' })).status, 302);
});

test('tokens are never accepted from the query string', async (t) => {
  const f = await fixture(t);
  const { token } = await f.token();
  for (const q of ['token', 'access_token', 'bearer', 'auth']) {
    assert.equal((await f.fetch(`/api/whoami?${q}=${token}`)).status, 401);
  }
  const ws = await openWs(`ws://127.0.0.1:${f.port()}/ws?token=${token}`, undefined, {}, IOS);
  assert.deepEqual(ws, { ok: false, status: 401 });
});

test('devices are listed without hashes and revoked tokens stop working', async (t) => {
  const f = await fixture(t);
  const a = await f.token('Alice’s iPhone‮\u0007');
  const b = await f.token('Pixel');
  const listed = await (await f.fetch('/api/devices', { headers: { authorization: `Bearer ${a.token}` } })).json();
  assert.equal(listed.devices.length, 2);
  const mine = listed.devices.find((d: any) => d.id === a.deviceId);
  assert.equal(mine.current, true);
  assert.equal(mine.name, 'Alice’s iPhone');
  for (const d of listed.devices) assert.deepEqual(Object.keys(d).sort(), ['createdAt', 'current', 'id', 'lastUsedAt', 'name']);
  assert.equal((await f.fetch('/api/devices')).status, 401);

  // Cookie revocation needs same-origin; bearer revocation doesn't.
  const cookie = f.cookie();
  assert.equal((await f.fetch(`/api/devices/${b.deviceId}`, { method: 'DELETE', headers: { cookie } })).status, 403);
  assert.equal((await f.fetch(`/api/devices/${b.deviceId}`, { method: 'DELETE', headers: { cookie, origin: f.base() } })).status, 200);
  assert.equal((await f.fetch('/api/whoami', { headers: { authorization: `Bearer ${b.token}` } })).status, 401);
  assert.equal((await f.fetch('/api/devices/nope', { method: 'DELETE', headers: { authorization: `Bearer ${a.token}` } })).status, 404);

  // Revoking a device closes its live connection.
  const live = await openWs(`ws://127.0.0.1:${f.port()}/ws`, ['empire.v1', `bearer.${a.token}`], {}, IOS);
  assert.ok(live.ok);
  const closed = new Promise<number>((resolve) => live.ws.once('close', (code) => resolve(code)));
  assert.equal((await f.fetch(`/api/devices/${a.deviceId}`, { method: 'DELETE', headers: { authorization: `Bearer ${a.token}` } })).status, 200);
  assert.equal(await closed, 4401);
  assert.equal((await f.fetch('/api/whoami', { headers: { authorization: `Bearer ${a.token}` } })).status, 401);
});

test('the device store keeps only hashes, with owner-only permissions', async (t) => {
  const f = await fixture(t);
  const { token } = await f.token();
  const file = path.join(f.dir, 'devices.json');
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes(token));
  assert.ok(!text.includes(Buffer.from(token, 'base64url').toString('hex')));
  const stored = JSON.parse(text);
  assert.match(stored.devices[0].hash, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('CORS is answered only for the bundled app origins, without credentials', async (t) => {
  const f = await fixture(t);
  const { token } = await f.token();
  for (const origin of [IOS, ANDROID]) {
    const pre = await f.fetch('/api/devices', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'authorization' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), origin);
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Authorization/);
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Content-Type/);
    assert.match(pre.headers.get('access-control-allow-methods') ?? '', /DELETE/);
    assert.equal(pre.headers.get('access-control-allow-credentials'), null);
    const got = await f.fetch('/api/whoami', { headers: { origin, authorization: `Bearer ${token}` } });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('access-control-allow-origin'), origin);
    assert.equal(got.headers.get('access-control-allow-credentials'), null);
    const signIn = await f.deviceLogin({ password: 'wrong' }, { origin });
    assert.equal(signIn.headers.get('access-control-allow-origin'), origin);
  }
  // Cookie requests from an app origin get no CORS grant.
  const cookieGet = await f.fetch('/api/whoami', { headers: { origin: IOS, cookie: f.cookie() } });
  assert.equal(cookieGet.headers.get('access-control-allow-origin'), null);
  for (const origin of ['https://attacker.invalid', 'empire-app://evil', 'http://appassets.androidplatform.net', 'null']) {
    const pre = await f.fetch('/api/devices', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } });
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    assert.notEqual(pre.status, 204);
    const got = await f.fetch('/api/whoami', { headers: { origin, authorization: `Bearer ${token}` } });
    assert.equal(got.headers.get('access-control-allow-origin'), null);
  }
});

test('WebSocket accepts a protocol token from an app origin and echoes only empire.v1', async (t) => {
  const f = await fixture(t);
  const { token } = await f.token();
  const url = `ws://127.0.0.1:${f.port()}/ws`;
  for (const origin of [IOS, ANDROID]) {
    const r = await openWs(url, ['empire.v1', `bearer.${token}`], {}, origin);
    assert.ok(r.ok);
    assert.equal(r.protocolHeader, 'empire.v1');
    assert.equal(r.ws.protocol, 'empire.v1');
    assert.ok((await r.welcome).you);
    r.ws.close();
  }
  // App origin without a token, with a bad token, or a token without empire.v1: refused.
  assert.deepEqual(await openWs(url, undefined, {}, IOS), { ok: false, status: 401 });
  assert.deepEqual(await openWs(url, ['empire.v1'], {}, IOS), { ok: false, status: 401 });
  assert.deepEqual(await openWs(url, ['empire.v1', `bearer.${'A'.repeat(43)}`], {}, IOS), { ok: false, status: 401 });
  assert.deepEqual(await openWs(url, [`bearer.${token}`], {}, IOS), { ok: false, status: 401 });
  assert.deepEqual(await openWs(url, ['empire.v1', `bearer.${token}`, `bearer.${token}x`], {}, IOS), { ok: false, status: 401 });
  // A cookie from an app origin is not enough, and a token from some other site's page is refused.
  assert.deepEqual(await openWs(url, ['empire.v1'], { cookie: f.cookie() }, IOS), { ok: false, status: 401 });
  assert.deepEqual(await openWs(url, ['empire.v1', `bearer.${token}`], {}, 'https://attacker.invalid'), { ok: false, status: 401 });
  // Browsers on the office's own origin still connect with the cookie, as before.
  const browser = await openWs(url, undefined, { cookie: f.cookie() }, f.base());
  assert.ok(browser.ok);
  browser.ws.close();
});

test('rotating the office secret or password signs every device out', async (t) => {
  const f = await fixture(t);
  const { token } = await f.token();
  const whoami = () => f.fetch('/api/whoami', { headers: { authorization: `Bearer ${token}` } });
  await f.restart();
  assert.equal((await whoami()).status, 200, 'tokens survive a plain restart');
  await f.restart({ secret: 'rotated-secret' });
  assert.equal((await whoami()).status, 401);
  const listed = await (await f.fetch('/api/devices', { headers: { cookie: f.cookie() } })).json();
  assert.deepEqual(listed.devices, []);

  const second = await f.token();
  await f.restart({ secret: 'rotated-secret', password: 'new-password' });
  assert.equal((await f.fetch('/api/whoami', { headers: { authorization: `Bearer ${second.token}` } })).status, 401);
});

test('device names are sanitized and bounded', () => {
  assert.equal(sanitizeDeviceName(undefined), 'Device');
  assert.equal(sanitizeDeviceName('  \n\t '), 'Device');
  assert.equal(sanitizeDeviceName('a\u0000b‮c'), 'a b c');
  assert.equal([...sanitizeDeviceName('x'.repeat(500))].length, 64);
});
