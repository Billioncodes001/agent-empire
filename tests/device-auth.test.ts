import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { scryptSync, randomBytes } from 'node:crypto';
import net from 'node:net';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer, APP_ORIGINS } from '../src/server/server.js';
import { Auth } from '../src/server/auth.js';
import { sanitizeDeviceName, DeviceStore } from '../src/server/devices.js';
import { upstreamHeaders } from '../src/server/relay.js';
import { writeJsonAtomic } from '../src/server/persistence.js';
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

/** A bare-bones WebSocket client that never answers the server's close frame, like a hostile peer. */
async function rawBearerSocket(port: number, token: string) {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.on('error', () => {});
  socket.write([
    'GET /ws HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Protocol: empire.v1, bearer.${token}`, `Origin: ${IOS}`, '', '',
  ].join('\r\n'));
  let received = Buffer.alloc(0);
  socket.on('data', (d) => { received = Buffer.concat([received, d]); });
  await new Promise<void>((resolve) => { const check = () => (received.includes('\r\n\r\n') ? resolve() : setTimeout(check, 10)); check(); });
  assert.match(received.toString('latin1'), /^HTTP\/1\.1 101/);
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  return {
    send(msg: unknown) {
      const payload = Buffer.from(JSON.stringify(msg));
      assert.ok(payload.length < 126);
      const mask = randomBytes(4);
      const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
    },
    closed,
    destroy: () => socket.destroy(),
  };
}

test('a revoked device that ignores the close frame gets no further messages through and is cut off', async (t) => {
  const f = await fixture(t);
  const { token, deviceId } = await f.token();
  const observer = await openWs(`ws://127.0.0.1:${f.port()}/ws`, undefined, { cookie: f.cookie() }, f.base());
  assert.ok(observer.ok);
  const chats: string[] = [];
  observer.ws.on('message', (m) => { const msg = JSON.parse(m.toString()); if (msg.t === 'chat') chats.push(msg.text); });
  const raw = await rawBearerSocket(f.port(), token);
  t.after(() => { raw.destroy(); observer.ws.close(); });
  raw.send({ t: 'chat', text: 'before' });
  const deadline = Date.now() + 3000;
  while (!chats.includes('before') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(chats, ['before'], 'the raw client works while signed in');

  const cookie = f.cookie();
  assert.equal((await f.fetch(`/api/devices/${deviceId}`, { method: 'DELETE', headers: { cookie, origin: f.base() } })).status, 200);
  raw.send({ t: 'chat', text: 'after' });
  const cut = await Promise.race([raw.closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
  assert.equal(cut, true, 'the server terminates a socket that ignores the close handshake');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(chats, ['before']);
});

// Device testing (v1.0.0-beta.1): restarting the isolated UI fixture signed the Android app out ("Your sign-in is no
// longer valid") because the fixture keeps tokens in memory. The real server must keep a device signed in across a restart.
test('device store: an issued app token still verifies after a server restart (same secret and password)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-device-restart-'));
  try {
    const verifier = Buffer.alloc(32, 9);
    const a = new DeviceStore(dir, 'secret', verifier).issue('Android')!;
    const restarted = new DeviceStore(dir, 'secret', verifier);
    assert.equal(restarted.verify(a.token)?.id, a.deviceId, 'the app stays signed in after a restart');
    assert.equal(new DeviceStore(dir, 'other-secret', verifier).verify(a.token), undefined, 'a rotated secret still signs it out');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('device store: a failed write changes nothing, so revocations cannot be undone by a restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-device-store-'));
  try {
    let failing = false;
    const writer = (file: string, value: unknown) => { if (failing) throw new Error('disk full (fixture)'); writeJsonAtomic(file, value); };
    const verifier = Buffer.alloc(32, 7);
    const store = new DeviceStore(dir, 'secret', verifier, writer);
    const a = store.issue('A')!;

    failing = true;
    assert.throws(() => store.issue('B'), /disk full/);
    assert.equal(store.list().length, 1, 'no dead entry is left behind by a failed issue');
    assert.throws(() => store.revoke(a.deviceId), /disk full/);
    assert.ok(store.verify(a.token), 'memory still matches disk after a failed revoke');
    assert.equal(new DeviceStore(dir, 'secret', verifier).list().length, 1);

    failing = false;
    assert.equal(store.revoke(a.deviceId), true);
    assert.equal(store.verify(a.token), undefined);
    assert.equal(new DeviceStore(dir, 'secret', verifier).list().length, 0, 'the revocation survives a restart');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a revocation that cannot be saved still disconnects the device and reports an error', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const f = await fixture(t);
  const { token, deviceId } = await f.token();
  const live = await openWs(`ws://127.0.0.1:${f.port()}/ws`, ['empire.v1', `bearer.${token}`], {}, IOS);
  assert.ok(live.ok);
  const closed = new Promise<number>((resolve) => live.ws.once('close', (code) => resolve(code)));
  chmodSync(f.dir, 0o500);
  let status: number;
  let body: any;
  try {
    const res = await f.fetch(`/api/devices/${deviceId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    status = res.status;
    body = await res.json();
  } finally {
    chmodSync(f.dir, 0o700);
  }
  assert.equal(status, 500);
  assert.match(body.error, /still signed in/);
  assert.equal(await closed, 4401);
  // Memory and disk agree: the device is still listed, and revoking again (now writable) works.
  assert.equal((await f.fetch(`/api/devices/${deviceId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await f.fetch('/api/whoami', { headers: { authorization: `Bearer ${token}` } })).status, 401);
});

test('service tunnels never forward device tokens to a worker server', () => {
  const req = (headers: http.IncomingHttpHeaders) => ({ headers }) as http.IncomingMessage;
  const token = 'A'.repeat(43);
  const out = upstreamHeaders(req({ host: 'localhost:5173', authorization: `Bearer ${token}`, 'sec-websocket-protocol': `vite-hmr, bearer.${token}, empire.v1`, cookie: 'ao_session_4600=x; theme=dark' }));
  assert.equal(out.authorization, undefined);
  assert.equal(out['sec-websocket-protocol'], 'vite-hmr, empire.v1');
  assert.equal(out.cookie, 'theme=dark');
  assert.ok(!JSON.stringify(out).includes(token));
  assert.equal(upstreamHeaders(req({ 'sec-websocket-protocol': `bearer.${token}` }))['sec-websocket-protocol'], undefined);
  // A service's own non-Bearer auth still passes through.
  assert.equal(upstreamHeaders(req({ authorization: 'Basic dXNlcjpwdw==' })).authorization, 'Basic dXNlcjpwdw==');
});
