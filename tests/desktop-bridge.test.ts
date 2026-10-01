import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const policy = require('../desktop/bridge-policy.cjs');
const { resolveAsset, createHandler, headersFor, HTML_CSP } = require('../desktop/app-protocol.cjs');
const { createSecureStore } = require('../desktop/secure-store.cjs');
const { runDeviceFlow } = require('../desktop/device-flow.cjs');
const ROOT = path.resolve(import.meta.dirname, '..');

test('bridge policy: method and key allowlists, session keys and per-key values', () => {
  assert.deepEqual([...policy.KEYS], ['mode', 'server.host', 'server.token', 'server.deviceId', 'github.token', 'github.login', 'state.repo']);
  assert.deepEqual([...policy.SESSION_KEYS], ['server.token', 'server.deviceId', 'github.token', 'github.login']);
  assert.equal(policy.isMethod('secure.get'), true);
  assert.equal(policy.isMethod('shell.exec'), false);
  for (const key of ['anthropic.key', 'openai.key', 'password', '__proto__', '']) assert.equal(policy.isKey(key), false, key);

  const ok: [string, string][] = [
    ['mode', 'cloud'], ['mode', 'server'],
    ['server.host', 'https://city.example.com'], ['server.host', 'http://127.0.0.1:4714'], ['server.host', 'http://localhost:4600'], ['server.host', 'https://city.example.com:8443'],
    ['server.token', 'A'.repeat(43)], ['server.deviceId', 'abc_DEF-1'],
    ['github.token', 'gho_abcdefghijklmnop'], ['github.login', 'octo-cat'], ['state.repo', 'octo-cat/agent-empire-state'],
  ];
  for (const [k, v] of ok) assert.equal(policy.invalidValue(k, v), null, `${k}=${v}`);
  const bad: [string, unknown][] = [
    ['mode', 'local'], ['mode', ''],
    ['server.host', 'http://city.example.com'], ['server.host', 'https://city.example.com/path'], ['server.host', 'https://user:pw@city.example.com'],
    ['server.host', 'https://city.example.com/?token=x'], ['server.host', 'javascript:alert(1)'], ['server.host', 'http://192.168.1.4:4600'], ['server.host', 'https://city.example.com/'],
    ['server.token', 'short'], ['server.token', 'A'.repeat(20) + ' x'], ['server.deviceId', 'a/b'],
    ['github.token', 'has space'], ['github.token', 'x'.repeat(513)], ['github.login', '-bad'], ['github.login', 'a'.repeat(40)],
    ['state.repo', 'no-slash'], ['state.repo', '../x/y'], ['openai.key', 'sk-123'], ['mode', 42], ['mode', 'x'.repeat(9000)],
  ];
  for (const [k, v] of bad) assert.notEqual(policy.invalidValue(k, v), null, `${k}=${String(v)}`);
});

test('bridge policy: GitHub scopes, client id, external links, app origin and gesture window', () => {
  assert.equal(policy.scopes(['repo', 'workflow']), 'repo workflow');
  assert.equal(policy.scopes(['repo', 'repo', 'read:user']), 'repo read:user');
  for (const s of [[], ['admin:org'], ['repo', 'delete_repo'], ['user'], ['write:packages'], [''], 'repo', null, Array(11).fill('repo')])
    assert.equal(policy.scopes(s), null, JSON.stringify(s));
  assert.equal(policy.isClientId('Ov23li3G3aR4rgZ0lCJ3'), true);
  assert.equal(policy.isClientId('bad id'), false);

  assert.equal(policy.externalUrl('https://github.com/login/device'), 'https://github.com/login/device');
  for (const u of ['http://github.com', 'https://u:p@github.com', 'empire-app://game/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', `https://x.com/${'a'.repeat(2100)}`])
    assert.equal(policy.externalUrl(u), null, u);
  assert.equal(policy.isVerificationUrl('https://github.com/login/device'), true);
  assert.equal(policy.isVerificationUrl('https://github.com.evil.example/login/device'), false);
  assert.equal(policy.isVerificationUrl('http://github.com/login/device'), false);

  // Node gives custom schemes an opaque origin, so the check must not rely on URL.origin.
  assert.equal(policy.isAppUrl('empire-app://game/'), true);
  assert.equal(policy.isAppUrl('empire-app://game/index.html?x=1'), true);
  for (const u of ['empire-app://other/', 'empire-app://game:81/', 'empire-app://u@game/', 'https://game/', 'file:///game/', 'about:blank', ''])
    assert.equal(policy.isAppUrl(u), false, u);

  assert.equal(policy.gestureAllows(1000, 5999), true);
  assert.equal(policy.gestureAllows(1000, 6001), false);
  assert.equal(policy.gestureAllows(0, 10), false);
  assert.equal(policy.gestureAllows(2000, 1000), false);
});

test('bridge policy: requests are validated before any handler runs', () => {
  assert.equal(policy.parseRequest(null), null);
  assert.equal(policy.parseRequest({ id: 'bad id!', method: 'secure.get' }), null);
  assert.deepEqual(policy.parseRequest({ id: 'a1', method: 'secure.get', params: { key: 'mode' } }), { id: 'a1', method: 'secure.get', params: { key: 'mode' } });
  assert.match(policy.parseRequest({ id: 'a1', method: 'secure.get', params: { key: 'anthropic.key' } }).error, /not allowed/);
  assert.match(policy.parseRequest({ id: 'a1', method: 'secure.set', params: { key: 'server.host', value: 'http://evil.example' } }).error, /isn’t allowed/);
  assert.match(policy.parseRequest({ id: 'a1', method: 'eval', params: {} }).error, /Unknown method/);
  assert.deepEqual(policy.parseRequest({ id: 'a1', method: 'github.deviceFlow', params: { clientId: 'Ov23li3G3aR4rgZ0lCJ3', scopes: ['repo', 'workflow'] } }).params, { clientId: 'Ov23li3G3aR4rgZ0lCJ3', scope: 'repo workflow' });
  assert.match(policy.parseRequest({ id: 'a1', method: 'github.deviceFlow', params: { clientId: 'Ov23li3G3aR4rgZ0lCJ3', scopes: ['repo', 'admin:org'] } }).error, /^invalid_request/);
  assert.match(policy.parseRequest({ id: 'a1', method: 'app.openExternal', params: { url: 'http://example.com' } }).error, /https/);
  assert.equal(policy.parseRequest({ id: 'a1', method: 'app.signedOut', params: { reason: 'weird' } }).params.reason, 'unauthorized');
});

test('bridge policy: page config carries a session only in server mode with a valid host and token', () => {
  const token = 'T'.repeat(43);
  assert.deepEqual(policy.configFor({ deviceName: 'Mac‮', mode: undefined }), { platform: 'desktop', deviceName: 'Mac' });
  assert.deepEqual(policy.configFor({ deviceName: 'Mac', mode: 'cloud', host: 'https://a.example', token }), { platform: 'desktop', deviceName: 'Mac', mode: 'cloud' });
  assert.deepEqual(policy.configFor({ deviceName: 'Mac', mode: 'server', host: 'https://a.example', token, deviceId: 'd1', signedOut: 'revoked' }),
    { platform: 'desktop', deviceName: 'Mac', mode: 'server', host: 'https://a.example', token, deviceId: 'd1', signedOut: 'revoked' });
  assert.equal(policy.configFor({ mode: 'server', host: 'http://evil.example', token }).token, undefined);
  assert.equal(policy.configFor({ mode: 'server', host: 'https://a.example', token: 'short' }).host, undefined);
  assert.equal(policy.configFor({ mode: 'server', host: 'http://127.0.0.1:5000', token, local: true }).local, true);
  assert.equal(policy.configFor({ mode: 'server', local: true }).local, undefined);
  assert.equal(policy.configFor({ deviceName: '' }).deviceName, 'Desktop app');
});

test('app protocol: serves the bundle with correct MIME and refuses traversal, web-only pages and escapes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-protocol-'));
  const root = path.join(dir, 'public');
  try {
    mkdirSync(path.join(root, 'assets'), { recursive: true });
    mkdirSync(path.join(root, 'models'));
    writeFileSync(path.join(root, 'index.html'), '<!doctype html>game');
    writeFileSync(path.join(root, 'assets', 'main.js'), 'export {}');
    writeFileSync(path.join(root, 'assets', 'main.css'), 'body{}');
    writeFileSync(path.join(root, 'assets', 'main.js.map'), '{}');
    writeFileSync(path.join(root, 'models', 'a b.glb'), 'glTF');
    writeFileSync(path.join(root, 'login.html'), 'web login');
    writeFileSync(path.join(root, 'sw.js'), 'sw');
    writeFileSync(path.join(root, '.env'), 'SECRET=1');
    writeFileSync(path.join(root, 'notes.unknownext'), 'x');
    writeFileSync(path.join(dir, 'secret.json'), '{"secret":true}');
    symlinkSync(path.join(dir, 'secret.json'), path.join(root, 'assets', 'link.json'));

    const at = (u: string) => resolveAsset(root, u);
    assert.equal(at('empire-app://game/').type, 'text/html; charset=utf-8');
    assert.equal(at('empire-app://game/').file, path.join(statSync(root) && require('node:fs').realpathSync(root), 'index.html'));
    assert.equal(at('empire-app://game/assets/main.js').type, 'text/javascript; charset=utf-8');
    assert.equal(at('empire-app://game/assets/main.css').type, 'text/css; charset=utf-8');
    assert.equal(at('empire-app://game/models/a%20b.glb').type, 'model/gltf-binary');
    assert.equal(at('empire-app://game/assets/main.js?v=1#x').status, 200);
    for (const u of ['empire-app://game/%2e%2e/secret.json', 'empire-app://game/assets/%2e%2e%2f%2e%2e%2fsecret.json', 'empire-app://game/assets/..%5c..%5csecret.json',
      'empire-app://game/%252e%252e/secret.json', 'empire-app://game/assets/%00.js'])
      assert.ok([403, 404].includes(at(u).status), u); // refused, or normalised by the URL parser to a path inside the bundle that doesn't exist
    assert.equal(at('empire-app://game/assets/link.json').status, 403, 'a symlink out of the bundle');
    for (const u of ['empire-app://game/login.html', 'empire-app://game/sw.js', 'empire-app://game/.env', 'empire-app://game/assets/main.js.map', 'empire-app://game/notes.unknownext', 'empire-app://game/missing.js', 'empire-app://game/assets'])
      assert.equal(at(u).status, 404, u);
    for (const u of ['empire-app://other/index.html', 'https://game/index.html', 'empire-app://u:p@game/']) assert.equal(at(u).status, 403, u);
    assert.equal(at('::not a url').status, 400);

    const handler = createHandler(root);
    const res = await handler(new Request('empire-app://game/'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<!doctype html>game');
    assert.equal(res.headers.get('content-security-policy'), HTML_CSP);
    assert.match(HTML_CSP, /script-src 'self'/);
    assert.doesNotMatch(HTML_CSP, /unsafe|\*/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await handler(new Request('empire-app://game/assets/main.js'))).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.notEqual((await handler(new Request('empire-app://game/%2e%2e/secret.json'))).status, 200);
    assert.equal((await handler(new Request('empire-app://game/', { method: 'POST', body: 'x' }))).status, 405);
    assert.equal(headersFor('image/png')['Content-Security-Policy'], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const fakeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s.split('').reverse().join('')),
  decryptString: (b: Buffer) => b.toString().split('').reverse().join(''),
};

test('secure store: encrypted, allowlisted, validated; sign-out clears exactly the session keys', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-store-'));
  const file = path.join(dir, 'app-session.enc');
  try {
    const store = createSecureStore(file, fakeCrypto);
    assert.equal(store.get('mode'), null);
    const token = 'Tok_' + 'abcdefghij'.repeat(4);
    for (const [k, v] of [['mode', 'server'], ['server.host', 'https://city.example.com'], ['server.token', token], ['server.deviceId', 'dev1'], ['github.token', 'gho_x123456789'], ['github.login', 'octo'], ['state.repo', 'octo/agent-empire-state']])
      store.set(k, v);
    assert.equal(readFileSync(file, 'utf8').includes(token), false, 'stored encrypted');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.throws(() => store.set('anthropic.key', 'sk-ant'), /not allowed/);
    assert.throws(() => store.set('server.host', 'http://evil.example'));
    assert.throws(() => store.get('openai.key'));
    store.clearSession();
    assert.deepEqual(store.snapshot(), { mode: 'server', 'server.host': 'https://city.example.com', 'state.repo': 'octo/agent-empire-state' });
    store.delete('state.repo');
    assert.equal(store.get('state.repo'), null);

    // Unprotected or unavailable storage is refused and leaves the file untouched.
    const before = readFileSync(file);
    assert.throws(() => createSecureStore(file, { ...fakeCrypto, getSelectedStorageBackend: () => 'basic_text' }).set('mode', 'cloud'));
    assert.throws(() => createSecureStore(file, { ...fakeCrypto, isEncryptionAvailable: () => false }).set('mode', 'cloud'));
    assert.deepEqual(readFileSync(file), before);

    // Tampered content outside the allowlist is never handed back.
    writeFileSync(file, fakeCrypto.encryptString(JSON.stringify({ mode: 'server', 'anthropic.key': 'sk', 'server.host': 'http://evil.example' })));
    assert.deepEqual(store.snapshot(), { mode: 'server' });
    store.clearAll();
    assert.deepEqual(store.snapshot(), {});

    writeFileSync(file, 'garbage');
    assert.throws(() => store.snapshot(), /could not be opened/);
    assert.throws(() => store.set('mode', 'cloud'));
    assert.equal(readFileSync(file, 'utf8'), 'garbage');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeGitHub(answers: Record<string, unknown>[]) {
  const calls: { url: string; body: string }[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: String(init.body ?? '') });
    if (url.endsWith('/login/device/code'))
      return new Response(JSON.stringify({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }));
    if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'octo' }));
    return new Response(JSON.stringify(answers.shift() ?? { error: 'authorization_pending' }));
  };
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

test('device flow: polls through pending and slow_down, returns token and login, and sends only the checked scope', async () => {
  const gh = fakeGitHub([{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { access_token: 'gho_token123456' }]);
  const waits: number[] = [];
  let shown: unknown;
  const result = await runDeviceFlow({
    clientId: 'Ov23li3G3aR4rgZ0lCJ3', scope: 'repo workflow', signal: new AbortController().signal, fetch: gh.fetch,
    onCode: (c: unknown) => (shown = c), sleep: async (ms: number) => void waits.push(ms),
  });
  assert.deepEqual(result, { token: 'gho_token123456', login: 'octo' });
  assert.deepEqual(shown, { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900 });
  assert.deepEqual(waits, [5000, 5000, 10000]);
  assert.equal(new URLSearchParams(gh.calls[0].body).get('scope'), 'repo workflow');
  assert.equal(new URLSearchParams(gh.calls[0].body).get('client_id'), 'Ov23li3G3aR4rgZ0lCJ3');
});

test('device flow: cancel, denial, expiry and a foreign verification page all fail with a coded message', async () => {
  const run = (gh: ReturnType<typeof fakeGitHub>, extra: Record<string, unknown> = {}) =>
    runDeviceFlow({ clientId: 'id', scope: 'repo', signal: new AbortController().signal, fetch: gh.fetch, onCode() {}, sleep: async () => {}, ...extra });
  await assert.rejects(run(fakeGitHub([{ error: 'access_denied' }])), /^Error: access_denied/);
  await assert.rejects(run(fakeGitHub([{ error: 'expired_token' }])), /^Error: expired_token/);
  const controller = new AbortController();
  await assert.rejects(run(fakeGitHub([]), { signal: controller.signal, onCode: () => controller.abort(), sleep: async (_ms: number, s: AbortSignal) => { if (s.aborted) throw new Error('aborted'); } }), /^Error: cancelled/);
  const evil = async (url: string) => new Response(JSON.stringify(url.endsWith('/code') ? { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://evil.example/login/device' } : {}));
  await assert.rejects(run({ calls: [], fetch: evil as unknown as typeof fetch }), /^Error: github_error/);
  const offline = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(run({ calls: [], fetch: offline as unknown as typeof fetch }), /^Error: network/);
});

function loadPreload(origin: string, top = true) {
  const exposed: Record<string, any> = {};
  const invoked: unknown[] = [];
  const executed: string[] = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (k: string, v: unknown) => (exposed[k] = v) },
    ipcRenderer: {
      sendSync: (ch: string) => (ch === 'empire:config' ? { platform: 'desktop', deviceName: 'Mac' } : null),
      invoke: async (ch: string, msg: any) => (invoked.push([ch, msg]), msg.params.key === 'mode' ? { ok: true, result: 'cloud' } : { ok: false, error: 'Key not allowed.' }),
    },
    webFrame: { executeJavaScript: async (code: string) => void executed.push(code) },
  };
  const win: any = {};
  win.top = top ? win : {};
  const code = readFileSync(path.join(ROOT, 'desktop/preload.cjs'), 'utf8');
  vm.runInNewContext(code, { require: (m: string) => (m === 'electron' ? electron : (() => { throw new Error(`preload may not require ${m}`); })()), location: { origin }, window: win, JSON, String });
  return { exposed, invoked, executed };
}

test('preload: exposes only the config and the bridge transport, only to the bundled origin', async () => {
  for (const origin of ['https://evil.example', 'file://', 'null', 'http://127.0.0.1:4714']) assert.deepEqual(Object.keys(loadPreload(origin).exposed), [], origin);
  assert.deepEqual(Object.keys(loadPreload('empire-app://game', false).exposed), [], 'not in subframes');
  const p = loadPreload('empire-app://game');
  assert.deepEqual(Object.keys(p.exposed).sort(), ['AGENT_EMPIRE_APP', 'empireDesktop']);
  assert.deepEqual(Object.keys(p.exposed.empireDesktop), ['postMessage']);
  assert.deepEqual(p.exposed.AGENT_EMPIRE_APP, { platform: 'desktop', deviceName: 'Mac' });

  p.exposed.empireDesktop.postMessage({ id: 'r1', method: 'secure.get', params: { key: 'mode' } });
  p.exposed.empireDesktop.postMessage({ id: 'r2', method: 'secure.get', params: { key: 'anthropic.key' }, extra: 'dropped' });
  p.exposed.empireDesktop.postMessage({ id: 'bad id"); alert(1); ("', method: 'secure.get' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(p.invoked.length, 2, 'a request without a valid id is dropped');
  assert.deepEqual(JSON.parse(JSON.stringify(p.invoked[1])), ['empire:bridge', { id: 'r2', method: 'secure.get', params: { key: 'anthropic.key' } }]);
  assert.deepEqual(p.executed, [
    'void (window.__empireNative && window.__empireNative.resolve("r1", "cloud"))',
    'void (window.__empireNative && window.__empireNative.reject("r2", "Key not allowed."))',
  ]);
});

test('desktop package lists every shell file it loads, and none of the old launcher', () => {
  const prep = readFileSync(path.join(ROOT, 'tools/prepare-desktop.mjs'), 'utf8');
  const list = JSON.parse(prep.match(/const DESKTOP_FILES = (\[[^\]]+\])/)![1].replace(/'/g, '"'));
  for (const name of list) assert.ok(existsSync(path.join(ROOT, 'desktop', name)), name);
  const main = readFileSync(path.join(ROOT, 'desktop/main.cjs'), 'utf8');
  for (const ref of main.matchAll(/'\.\/([a-z-]+\.cjs)'|path\.join\(__dirname, '([a-z-]+\.(?:cjs|html))'\)/g)) assert.ok(list.includes(ref[1] ?? ref[2]), ref[0]);
  for (const html of ['device.html', 'credentials.html']) {
    const page = readFileSync(path.join(ROOT, 'desktop', html), 'utf8');
    for (const ref of page.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(list.includes(ref[1]), `${html} → ${ref[1]}`);
    assert.match(page, /default-src 'none'/);
  }
  assert.equal(list.some((n: string) => n.startsWith('launch')), false);
  assert.match(main, /sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true/);
});
