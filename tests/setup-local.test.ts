/** Desktop "Run on this computer" (page side): the app.runLocal bridge call, shell flags and the launch decision. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError, NativeBridge, parseShellInfo, TIMEOUTS, webNative, type BridgeRequest } from '../src/client/native';
import { decideLaunch, type LaunchEnv } from '../src/client/setup/launch';

type Win = Record<string, unknown>;
const receiver = (w: Win) => w.__empireNative as { resolve(id: string, v: unknown): void; reject(id: string, m: string): void };
function desktop(answer: (req: BridgeRequest, w: Win) => void, platform = 'desktop') {
  const sent: BridgeRequest[] = [];
  const w: Win = { AGENT_EMPIRE_APP: { platform, localAvailable: true } };
  const post = (m: BridgeRequest) => { sent.push(m); setTimeout(() => answer(m, w), 1); };
  if (platform === 'desktop') w.empireDesktop = { postMessage: post };
  else w.webkit = { messageHandlers: { empire: { postMessage: post } } };
  return { w, sent };
}
const SESSION = { mode: 'local', host: 'http://127.0.0.1:52971', token: 'T'.repeat(43), deviceId: 'dev_local1' };

test('runLocal: one parameterless request with a long timeout; the loopback session is returned', async () => {
  const { w, sent } = desktop((req, win) => receiver(win).resolve(req.id, SESSION));
  assert.deepEqual(await new NativeBridge(w).runLocal(), SESSION);
  assert.deepEqual([sent[0].method, sent[0].params], ['app.runLocal', {}]);
  assert.ok(TIMEOUTS.runLocal >= 5 * 60_000, 'the player reads a native dialog first');
});

test('runLocal: cancel and failure messages pass through; malformed or non-loopback answers are refused; desktop only', async () => {
  const cancel = desktop((req, win) => receiver(win).reject(req.id, 'cancelled: Running on this computer was cancelled. Nothing was started.'));
  await assert.rejects(new NativeBridge(cancel.w).runLocal(), (e: unknown) => e instanceof BridgeError && /^cancelled:/.test(e.message));
  const failed = desktop((req, win) => receiver(win).reject(req.id, 'The Empire couldn’t start on this computer: port busy'));
  await assert.rejects(new NativeBridge(failed.w).runLocal(), /couldn’t start on this computer/);
  for (const bad of [null, { ...SESSION, mode: 'server' }, { ...SESSION, token: '' }, { ...SESSION, host: 'https://city.example.com' }, { ...SESSION, host: 'http://127.0.0.1:1/x' }]) {
    const d = desktop((req, win) => receiver(win).resolve(req.id, bad));
    await assert.rejects(new NativeBridge(d.w).runLocal(), (e: unknown) => e instanceof BridgeError && e.code === 'invalid');
  }
  const ios = desktop(() => assert.fail('never sent'), 'ios');
  await assert.rejects(new NativeBridge(ios.w).runLocal(), (e: unknown) => e instanceof BridgeError && e.code === 'unavailable');
  assert.equal(ios.sent.length, 0);
  await assert.rejects(webNative(null).runLocal(), (e: unknown) => e instanceof BridgeError && e.code === 'unavailable');
});

test('shell info: localAvailable and mode "local" are desktop-only', () => {
  assert.deepEqual(parseShellInfo({ platform: 'desktop', localAvailable: true, mode: 'local' }), { platform: 'desktop', mode: 'local', localAvailable: true });
  assert.deepEqual(parseShellInfo({ platform: 'ios', localAvailable: true, mode: 'local' }), { platform: 'ios' });
  assert.deepEqual(parseShellInfo({ platform: 'android', localAvailable: 'yes' }), { platform: 'android' });
  assert.deepEqual(parseShellInfo({ platform: 'desktop', localAvailable: 1 }), { platform: 'desktop' });
});

const env = (over: Partial<LaunchEnv> & { store?: Record<string, string> } = {}): LaunchEnv => {
  const store = over.store ?? {};
  return { shell: null, hasSession: false, origin: 'empire-app://game', probe: async () => 'none', get: async (k) => store[k] ?? null, ...over };
};

test('launch: a desktop running locally with its session opens the game; without one it returns to the choice; phones ignore "local"', async () => {
  assert.deepEqual(await decideLaunch(env({ shell: { platform: 'desktop', mode: 'local', localAvailable: true }, hasSession: true })), { kind: 'game' });
  assert.deepEqual(await decideLaunch(env({ shell: { platform: 'desktop', localAvailable: true }, hasSession: true, store: { mode: 'local' } })), { kind: 'game' });
  assert.deepEqual(await decideLaunch(env({ shell: { platform: 'desktop', mode: 'local', localAvailable: true } })), { kind: 'setup', step: 'welcome' });
  assert.deepEqual(await decideLaunch(env({ shell: { platform: 'ios' }, hasSession: true, store: { mode: 'local' } })), { kind: 'setup', step: 'welcome' });
});
