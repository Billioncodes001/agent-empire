import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError, NativeBridge, parseShellInfo, SECURE_KEYS, webNative, type BridgeRequest } from '../src/client/native';

type Win = Record<string, unknown>;
const receiver = (w: Win) => w.__empireNative as { resolve(id: string, v: unknown): void; reject(id: string, m: string): void };

function iosWindow(answer?: (req: BridgeRequest, w: Win) => void) {
  const sent: BridgeRequest[] = [];
  const w: Win = { AGENT_EMPIRE_APP: { platform: 'ios' } };
  w.webkit = { messageHandlers: { empire: { postMessage: (m: BridgeRequest) => { sent.push(m); answer?.(m, w); } } } };
  return { w, sent };
}

test('bridge: requests carry unique ids and are answered by id through window.__empireNative', async () => {
  const { w, sent } = iosWindow((req, win) => queueMicrotask(() => receiver(win).resolve(req.id, req.method === 'secure.get' ? 'server' : true)));
  const bridge = new NativeBridge(w);
  assert.equal(bridge.platform, 'ios');
  assert.equal(bridge.available, true);
  const [a, b] = await Promise.all([bridge.secureGet('mode'), bridge.secureSet('server.host', 'https://city.example')]);
  assert.equal(a, 'server');
  assert.equal(b, undefined);
  assert.deepEqual(sent.map((r) => [r.method, r.params]), [['secure.get', { key: 'mode' }], ['secure.set', { key: 'server.host', value: 'https://city.example' }]]);
  assert.notEqual(sent[0].id, sent[1].id);
  assert.equal(bridge.inFlight, 0);
});

test('bridge: a rejection, a timeout and unknown ids are handled; late answers are ignored', async () => {
  const { w, sent } = iosWindow();
  const bridge = new NativeBridge(w);
  const pending = bridge.call('secure.get', { key: 'mode' });
  receiver(w).resolve('not-an-id', 'x');
  receiver(w).reject(sent[0].id, 'Keychain unavailable');
  await assert.rejects(pending, (e: unknown) => e instanceof BridgeError && e.code === 'rejected' && e.message === 'Keychain unavailable');
  const timed = bridge.call('secure.get', { key: 'mode' }, 25);
  await assert.rejects(timed, (e: unknown) => e instanceof BridgeError && e.code === 'timeout');
  receiver(w).resolve(sent[1].id, 'too late'); // no throw, no effect
  assert.equal(bridge.inFlight, 0);
});

test('bridge: only allowlisted keys, bounded values, known GitHub scopes and https links are sent', async () => {
  const { w, sent } = iosWindow();
  const bridge = new NativeBridge(w);
  await assert.rejects(bridge.secureGet('provider.anthropic' as never), (e: unknown) => e instanceof BridgeError && e.code === 'invalid');
  await assert.rejects(bridge.secureSet('mode', 'x'.repeat(9000)), /cannot be stored/);
  await assert.rejects(bridge.githubDeviceFlow({ clientId: '', scopes: ['repo'] }), /not configured/);
  await assert.rejects(bridge.githubDeviceFlow({ clientId: 'Ov23li3G3aR4rgZ0lCJ3', scopes: ['admin:org'] }), /Unsupported/);
  await assert.rejects(bridge.openExternal('javascript:alert(1)'), /https/);
  await assert.rejects(bridge.openExternal('http://example.com'), /https/);
  assert.equal(sent.length, 0, 'nothing invalid reaches the shell');
  assert.deepEqual([...SECURE_KEYS], ['mode', 'server.host', 'server.token', 'server.deviceId', 'github.token', 'github.login', 'state.repo']);
});

test('bridge: the device flow returns {token, login} and rejects malformed answers', async () => {
  const { w, sent } = iosWindow((req, win) => setTimeout(() => receiver(win).resolve(req.id, req.params.scopes ? { token: 'gho_abc', login: 'octo' } : null), 5));
  const bridge = new NativeBridge(w);
  assert.deepEqual(await bridge.githubDeviceFlow({ clientId: 'Ov23li3G3aR4rgZ0lCJ3', scopes: ['repo', 'workflow', 'repo'] }), { token: 'gho_abc', login: 'octo' });
  assert.deepEqual(sent[0].params, { clientId: 'Ov23li3G3aR4rgZ0lCJ3', scopes: ['repo', 'workflow'] });
  const bad = iosWindow((req, win) => receiver(win).resolve(req.id, { token: '' }));
  await assert.rejects(new NativeBridge(bad.w).githubDeviceFlow({ clientId: 'abc', scopes: ['repo'] }), (e: unknown) => e instanceof BridgeError && e.code === 'invalid');
});

test('bridge: Android posts one JSON string to EmpireNative; desktop posts to empireDesktop; neither without a platform', async () => {
  const strings: string[] = [];
  const android: Win = { AGENT_EMPIRE_APP: { platform: 'android' }, EmpireNative: { postMessage: (s: string) => strings.push(s) } };
  const a = new NativeBridge(android);
  const p = a.signedOut('revoked');
  const req = JSON.parse(strings[0]) as BridgeRequest;
  assert.deepEqual([req.method, req.params], ['app.signedOut', { reason: 'revoked' }]);
  receiver(android).resolve(req.id, true);
  await p;
  const objs: BridgeRequest[] = [];
  const desktop: Win = { AGENT_EMPIRE_APP: { platform: 'desktop' }, empireDesktop: { postMessage: (m: BridgeRequest) => objs.push(m) } };
  void new NativeBridge(desktop).openExternal('https://github.com/login/device').catch(() => {});
  assert.equal(objs[0].method, 'app.openExternal');
  const plain = new NativeBridge({ webkit: { messageHandlers: { empire: { postMessage() { throw new Error('should not be used'); } } } } });
  assert.equal(plain.available, false, 'a transport without the injected platform is not a shell');
  await assert.rejects(plain.secureGet('mode'), (e: unknown) => e instanceof BridgeError && e.code === 'unavailable');
});

test('bridge: shell info is validated', () => {
  assert.deepEqual(parseShellInfo({ platform: 'ios', mode: 'cloud', deviceName: ' Ana’s iPhone ', signedOut: 'user', token: 'ignored' }), { platform: 'ios', mode: 'cloud', deviceName: 'Ana’s iPhone', signedOut: 'user' });
  assert.deepEqual(parseShellInfo({ platform: 'ios', mode: 'nope', signedOut: 'x' }), { platform: 'ios' });
  assert.equal(parseShellInfo({ platform: 'web' }), null);
  assert.equal(parseShellInfo(null), null);
});

test('web fallback: non-secret choices in localStorage, secrets refused, no device flow, links open', async () => {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  const opened: string[] = [];
  const web = webNative(storage, (u) => opened.push(u));
  assert.equal(web.available, false);
  await web.secureSet('mode', 'cloud');
  assert.equal(await web.secureGet('mode'), 'cloud');
  assert.equal(data.get('agent-empire.setup.mode'), 'cloud');
  await assert.rejects(web.secureSet('github.token', 'gho_x'), (e: unknown) => e instanceof BridgeError && e.code === 'unavailable');
  await assert.rejects(web.secureSet('server.token', 'tok'), /secure storage/);
  assert.equal(await web.secureGet('github.token'), null);
  assert.ok(![...data.values()].includes('gho_x'));
  await assert.rejects(web.githubDeviceFlow({ clientId: 'Ov23li3G3aR4rgZ0lCJ3', scopes: ['repo'] }), /paste a token/);
  await web.openExternal('https://github.com/settings/personal-access-tokens/new');
  assert.deepEqual(opened, ['https://github.com/settings/personal-access-tokens/new']);
  await web.secureDelete('mode');
  assert.equal(await web.secureGet('mode'), null);
  const blocked = webNative({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} });
  assert.equal(await blocked.secureGet('mode'), null);
  await assert.rejects(blocked.secureSet('mode', 'server'), /blocked local storage/);
});
