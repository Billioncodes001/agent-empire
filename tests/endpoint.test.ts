import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginUserSignOut, apiFetch, apiInit, apiUrl, appConfig, normaliseHost, notifySignedOut, parseAppConfig, resetEndpointForTests, signedOutNotified,
  setSessionConfig, wsProtocols, wsUrl, WS_PROTOCOL, WS_REVOKED, type AppConfig,
} from '../src/client/endpoint';
import { Net } from '../src/client/net';
import { WS_PROTOCOL as SERVER_WS_PROTOCOL, APP_ORIGINS } from '../src/server/server';

const TOKEN = 'abcDEF0123456789_-abcDEF0123456789_-abcdefg';
const app = (over: Partial<AppConfig> = {}): AppConfig => ({ host: 'https://city.example.com', token: TOKEN, platform: 'ios', deviceId: 'dev_1', ...over });
const g = globalThis as Record<string, unknown>;
const saved = { fetch: globalThis.fetch, window: g.window, location: g.location, WebSocket: g.WebSocket };

afterEach(() => {
  globalThis.fetch = saved.fetch;
  g.window = saved.window;
  g.location = saved.location;
  g.WebSocket = saved.WebSocket;
  resetEndpointForTests(undefined);
});

/** The reasons of the app.signedOut bridge requests the page sent (each a {id, method, params} request). */
const signOuts = (posted: unknown[]) =>
  posted.map((m) => {
    const r = m as { id?: unknown; method?: string; params?: { reason?: string } };
    assert.equal(typeof r.id, 'string', 'every bridge request carries an id');
    assert.equal(r.method, 'app.signedOut');
    return r.params?.reason;
  });

/** A fake window carrying the injected config and the one native bridge, recording what the page posts. */
function fakeWindow(config: unknown) {
  const posted: unknown[] = [];
  g.window = { AGENT_EMPIRE_APP: config, webkit: { messageHandlers: { empire: { postMessage: (m: unknown) => posted.push(m) } } } };
  resetEndpointForTests(undefined);
  return posted;
}

test('app: a session signed in by the first-launch setup is adopted without a reload, and validated', () => {
  resetEndpointForTests(null);
  assert.equal(apiUrl('/api/whoami'), '/api/whoami');
  setSessionConfig(app({ host: 'http://127.0.0.1:4707' }));
  assert.equal(apiUrl('/api/whoami'), 'http://127.0.0.1:4707/api/whoami');
  assert.deepEqual(wsProtocols(), ['empire.v1', `bearer.${TOKEN}`]);
  assert.throws(() => setSessionConfig(app({ token: 'short' })), /Invalid session/);
});

test('the client and server agree on the WebSocket subprotocol and the iOS origin', () => {
  assert.equal(WS_PROTOCOL, SERVER_WS_PROTOCOL);
  assert.ok(APP_ORIGINS.has('empire-app://game'));
});

test('hosts are reduced to a bare http(s) origin; anything carrying a path, query or credentials is refused', () => {
  assert.equal(normaliseHost('https://City.Example.com/'), 'https://city.example.com');
  assert.equal(normaliseHost(' https://city.example.com:443 '), 'https://city.example.com');
  assert.equal(normaliseHost('https://city.example.com:8443'), 'https://city.example.com:8443');
  assert.equal(normaliseHost('http://127.0.0.1:4705'), 'http://127.0.0.1:4705');
  for (const bad of ['city.example.com', 'ftp://city.example.com', 'https://u:p@city.example.com', 'https://city.example.com/office',
    'https://city.example.com/?t=1', 'https://city.example.com/#x', 'javascript:alert(1)', '', 42, null])
    assert.equal(normaliseHost(bad), undefined, String(bad));
});

test('an injected app config is validated; a malformed one leaves the web behaviour in place', () => {
  assert.deepEqual(parseAppConfig({ host: 'https://city.example.com/', token: TOKEN, platform: 'ios', deviceId: 'dev_1' }), app());
  assert.deepEqual(parseAppConfig({ host: 'https://city.example.com', token: TOKEN, platform: 'ios', deviceId: 'bad id!' }), { host: 'https://city.example.com', token: TOKEN, platform: 'ios' });
  for (const bad of [null, 'x', {}, { host: 'https://a.b', token: 'short', platform: 'ios' }, { host: 'https://a.b', token: `${TOKEN} x`, platform: 'ios' },
    { host: 'https://a.b', token: TOKEN, platform: 'windows95' }, { host: 'https://a.b/path', token: TOKEN, platform: 'ios' }])
    assert.equal(parseAppConfig(bad), null, JSON.stringify(bad));
  fakeWindow({ host: 'https://a.b', token: 'nope', platform: 'ios' });
  assert.equal(appConfig(), null);
});

test('web: API paths, request options and the socket are exactly as before (relative, cookie, no subprotocol)', async () => {
  resetEndpointForTests(null);
  assert.equal(apiUrl('/api/whoami'), '/api/whoami');
  const init: RequestInit = { credentials: 'same-origin', cache: 'no-store' };
  assert.equal(apiInit(init), init);
  const calls: [unknown, unknown][] = [];
  globalThis.fetch = (async (url: unknown, i: unknown) => { calls.push([url, i]); return new Response('{}', { status: 401 }); }) as typeof fetch;
  const res = await apiFetch('/api/gh/pull?number=3', init);
  assert.equal(res.status, 401);
  assert.deepEqual(calls, [['/api/gh/pull?number=3', init]]);
  assert.equal(wsProtocols(), undefined);
  g.location = new URL('https://office.example:8443/some/page');
  assert.equal(wsUrl('name=A'), 'wss://office.example:8443/ws?name=A');
  g.location = new URL('http://localhost:4600/');
  assert.equal(wsUrl('name=A'), 'ws://localhost:4600/ws?name=A');
  assert.equal(notifySignedOut('unauthorized'), false, 'no native bridge on the web');
});

test('app: API calls go to the office host with the bearer token and no cookies, keeping caller headers', () => {
  resetEndpointForTests(app());
  assert.equal(apiUrl('/api/devices/dev_1'), 'https://city.example.com/api/devices/dev_1');
  assert.equal(apiUrl('/api/gh/pull?number=3'), 'https://city.example.com/api/gh/pull?number=3');
  const init = apiInit({ method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' }, '/api/devices/dev_1');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.method, 'PUT');
  assert.equal(init.body, '{}');
});

test('app: the bearer token never goes to another origin (apiUrl/apiInit/apiFetch refuse it)', async () => {
  resetEndpointForTests(app());
  assert.equal(apiUrl('https://city.example.com/api/x'), 'https://city.example.com/api/x', 'an absolute URL on the server itself is fine');
  for (const target of ['https://evil.example/api/x', '//evil.example/api/x', 'http://city.example.com/api/x', 'https://city.example.com:8443/api/x', 'https://city.example.com.evil.example/x'])
    assert.throws(() => apiUrl(target), /signed-in server/, target);
  for (const target of ['https://evil.example/api/x', '//evil.example/x', undefined])
    assert.throws(() => apiInit({}, target), /signed-in server/, String(target));
  const calls: unknown[] = [];
  globalThis.fetch = (async (url: unknown) => { calls.push(url); return new Response('{}'); }) as typeof fetch;
  await assert.rejects(apiFetch('https://evil.example/api/steal'), /signed-in server/);
  assert.equal(calls.length, 0, 'nothing was sent');
});

test('app: the socket goes to the office host, token only in the subprotocol list, never in the URL', () => {
  resetEndpointForTests(app());
  assert.equal(wsUrl('name=A'), 'wss://city.example.com/ws?name=A');
  assert.deepEqual(wsProtocols(), ['empire.v1', `bearer.${TOKEN}`]);
  assert.doesNotMatch(wsUrl('name=A'), new RegExp(TOKEN));
  resetEndpointForTests(app({ host: 'http://127.0.0.1:4705' }));
  assert.equal(wsUrl(''), 'ws://127.0.0.1:4705/ws');
});

test('app: a 401 tells the native shell once, through the single empire bridge', async () => {
  const posted = fakeWindow({ host: 'https://city.example.com', token: TOKEN, platform: 'ios' });
  const seen: [string, RequestInit][] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => { seen.push([url, init]); return new Response('{}', { status: 401 }); }) as typeof fetch;
  await apiFetch('/api/continuity/status', { cache: 'no-store', credentials: 'same-origin' });
  await apiFetch('/api/whoami');
  assert.equal(seen[0][0], 'https://city.example.com/api/continuity/status');
  assert.equal(new Headers(seen[0][1].headers).get('authorization'), `Bearer ${TOKEN}`);
  assert.deepEqual(signOuts(posted), ['unauthorized']);
  assert.equal(signedOutNotified(), true);
});

class FakeSocket {
  static last: FakeSocket | null = null;
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(public url: string, public protocols?: string[]) { FakeSocket.last = this; }
  send() {}
}
const profile = () => ({ name: 'CEO', color: '#123456', look: { skin: 1, hair: 2, style: 0 } }) as never;

test('Net (app): connects with the bearer subprotocol, and a revoked socket (4401) signs out without retrying', async () => {
  const posted = fakeWindow({ host: 'https://city.example.com', token: TOKEN, platform: 'ios' });
  g.WebSocket = FakeSocket;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; return new Response('{}'); }) as typeof fetch;
  const net = new Net(profile);
  net.connect();
  const ws = FakeSocket.last!;
  assert.match(ws.url, /^wss:\/\/city\.example\.com\/ws\?name=CEO&/);
  assert.doesNotMatch(ws.url, /bearer|token/i);
  assert.deepEqual(ws.protocols, ['empire.v1', `bearer.${TOKEN}`]);
  await ws.onclose!({ code: WS_REVOKED });
  assert.deepEqual(signOuts(posted), ['revoked']);
  assert.equal(fetched, 0, 'no whoami probe after an explicit revoke');
  net.reconnectNow();
  assert.equal(FakeSocket.last, ws, 'no reconnect after sign-out');
});

test('Net (web): no subprotocols; a closed socket probes whoami relatively and never touches a native bridge', async () => {
  resetEndpointForTests(null);
  g.location = { protocol: 'https:', host: 'office.example', href: 'https://office.example/' } as unknown as Location;
  g.WebSocket = FakeSocket;
  const urls: unknown[] = [];
  globalThis.fetch = (async (url: unknown) => { urls.push(url); return new Response('{}', { status: 200 }); }) as typeof fetch;
  const net = new Net(profile);
  net.connect();
  const ws = FakeSocket.last!;
  assert.match(ws.url, /^wss:\/\/office\.example\/ws\?name=CEO&/);
  assert.equal(ws.protocols, undefined);
  await ws.onclose!({ code: 1006 });
  assert.deepEqual(urls, ['/api/whoami']);
  net['closedByUs'] = true; // stop the pending retry timer from reconnecting after the test
  clearTimeout(net['retryTimer'] as ReturnType<typeof setTimeout>);
});

test('app: after the player chooses Sign out, the revoke that closes our own socket is reported as the user\'s sign-out', async () => {
  const posted = fakeWindow({ host: 'https://city.example.com', token: TOKEN, platform: 'ios' });
  g.WebSocket = FakeSocket;
  globalThis.fetch = (async () => new Response('{}')) as typeof fetch;
  const net = new Net(profile);
  net.connect();
  beginUserSignOut();
  await FakeSocket.last!.onclose!({ code: WS_REVOKED });
  notifySignedOut('user');
  assert.deepEqual(signOuts(posted), ['user']);
});
