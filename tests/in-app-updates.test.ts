/**
 * REL-03 / REL-05 client rules, no network: semver, channel parsing, Ed25519 verification (tamper, wrong key),
 * channel selection (stable/beta, ETag, rate limit), offers (downgrade, minShell, rollback, native paths, server),
 * prompt gating, the bridge's page-side validation, the service flow, and the coordinator update against a fake GitHub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSemver, isNewer, isSemver } from '../src/client/update/semver';
import { ChannelError, channelUrls, newestPrereleaseTag, parseChannel, releaseAsset, RELEASES_API, RELEASE_REPO } from '../src/client/update/channel';
import { verifyChannel, verifyEd25519 } from '../src/client/update/verify';
import { fetchChannel, SourceError, type Fetcher, type KeyValue } from '../src/client/update/source';
import { decide, nativeOffer } from '../src/client/update/decide';
import { promptGate } from '../src/client/update/gate';
import { parseNativeInfo, updateBridge, type NativeInfo, type UpdateBridge } from '../src/client/update/bridge';
import { UpdateService } from '../src/client/update/service';
import { commitCoordinatorUpdate, coordinatorDecision, COORDINATOR_MANIFEST_PATH, readInstalledCoordinator } from '../src/client/update/coordinator';
import { NativeBridge, type BridgeRequest } from '../src/client/native';
import { CloudRepo } from '../src/client/cloud/repo';
import { COORDINATOR_BUNDLE_PATH } from '../src/cloud/workflow';
import { FakeGitHub } from './fake-github';
import { asset, channelJson, OTHER_KEYPAIR, sha256, sign, signedChannel } from './update-fixtures';
import { DEV_RELEASE_PUBLIC_KEY, RELEASE_KEY_IS_DEVELOPMENT, RELEASE_PUBLIC_KEY } from '../src/shared/release-key';

const info = (over: Partial<NativeInfo> = {}): NativeInfo => ({
  platform: 'android', shellVersion: '1.0.0-beta.1', installedGame: '1.0.0-beta.1', builtinGame: '1.0.0-beta.1', pendingGame: null, canInstallGame: true, canAutoUpdate: false, installSource: 'sideload', ...over,
});

// ---- semver ---------------------------------------------------------------------------------------------------

test('semver: SemVer 2.0 precedence for release versions', () => {
  const order = ['0.1.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0-beta.1', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  for (let i = 0; i < order.length - 1; i++) assert.ok(compareSemver(order[i], order[i + 1]) < 0, `${order[i]} < ${order[i + 1]}`);
  assert.equal(compareSemver('1.0.0-beta.2', '1.0.0-beta.2'), 0);
  for (const bad of ['1.0', 'v1.0.0', '01.0.0', '1.0.0-', '1.0.0+build', '1.0.0-beta..1', '', ' 1.0.0']) assert.equal(isSemver(bad), false, bad);
  assert.equal(isNewer('1.0.0-beta.2', '1.0.0-beta.1'), true);
  assert.equal(isNewer('1.0.0-beta.1', '1.0.0-beta.1'), false);
  assert.equal(isNewer('1.0.0-beta.1', '1.0.0'), false);
});

// ---- channel parsing --------------------------------------------------------------------------------------------

test('channel: a valid file parses; the release key is the dev key in this tree', () => {
  const c = parseChannel(JSON.stringify(channelJson({ version: '1.0.0-beta.2', channel: 'beta', coordinatorSha: 'c'.repeat(64) })), 'beta');
  assert.equal(c.version, '1.0.0-beta.2');
  assert.equal(c.game.url, asset('1.0.0-beta.2', 'agent-empire-game-1.0.0-beta.2.zip'));
  assert.equal(c.shell.android?.sha256, 'b'.repeat(64));
  assert.equal(c.coordinator?.schema, 1);
  assert.equal(RELEASE_KEY_IS_DEVELOPMENT, true);
  assert.equal(RELEASE_PUBLIC_KEY, DEV_RELEASE_PUBLIC_KEY);
  assert.deepEqual(c.shell.macos?.feed, { arm64: asset('1.0.0-beta.2', 'desktop-update-darwin-arm64.json'), x64: asset('1.0.0-beta.2', 'desktop-update-darwin-x64.json') });
  // Fields this app doesn't use are ignored; a platform without a build is null.
  const extra = { ...channelJson({ version: '1.0.0-beta.2' }), future: { x: 1 }, shell: { ...channelJson({ version: '1.0.0-beta.2' }).shell, windows: null, ios: { version: '1.0.0-beta.2', testflight: null, appStore: null } } };
  const parsed = parseChannel(JSON.stringify(extra), 'stable');
  assert.equal(parsed.shell.windows, undefined);
  assert.deepEqual(parsed.shell.ios, { version: '1.0.0-beta.2' });
});

test('release key: every shell pins the same key, and tools/release/config.json lists each copy for the release gate', async () => {
  const { readFileSync } = await import('node:fs');
  const config = JSON.parse(readFileSync('tools/release/config.json', 'utf8'));
  assert.deepEqual(config.pinnedKeyFiles, ['src/shared/release-key.ts', 'desktop/update-store.cjs', 'mobile/android/app/src/main/java/com/agentempire/mobile/UpdatePolicy.java', 'mobile/ios/AgentEmpire/UpdatePolicy.swift']);
  for (const file of config.pinnedKeyFiles) {
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes(RELEASE_PUBLIC_KEY), `${file} pins RELEASE_PUBLIC_KEY`);
    assert.ok(text.includes(DEV_RELEASE_PUBLIC_KEY), `${file} knows the development key`);
  }
  assert.equal(config.repository, RELEASE_REPO);
});

test('channel: anything unexpected makes the whole file untrusted', () => {
  const base = () => channelJson({ version: '1.0.0-beta.2' });
  const cases: [string, (c: any) => void][] = [
    ['other channel', (c) => (c.channel = 'beta')],
    ['tag for another version', (c) => (c.tag = 'v9.9.9')],
    ['desktop url elsewhere', (c) => (c.shell.macos.url = 'https://evil.test/download')],
    ['feed elsewhere', (c) => (c.shell.macos.feed = { arm64: 'https://evil.test/feed.json' })],
    ['feed elsewhere, as one string', (c) => (c.shell.macos.feed = 'https://evil.test/feed.json')],
    ['feed folder of another repository', (c) => (c.shell.windows.feed = 'https://github.com/evil/agent-empire/releases/download/v1.0.0-beta.2')],
    ['schema 2', (c) => (c.schema = 2)],
    ['bad version', (c) => (c.version = 'latest')],
    ['game from another repository', (c) => (c.game.url = 'https://github.com/evil/agent-empire/releases/download/v1.0.0-beta.2/x.zip')],
    ['game from another release', (c) => (c.game.url = asset('1.0.0-beta.1', 'agent-empire-game-1.0.0-beta.1.zip'))],
    ['game over http', (c) => (c.game.url = c.game.url.replace('https:', 'http:'))],
    ['game with query', (c) => (c.game.url += '?x=1')],
    ['bad sha256', (c) => (c.game.sha256 = 'A'.repeat(64))],
    ['bad minShell', (c) => (c.game.minShell = '1')],
    ['play link elsewhere', (c) => (c.shell.android.play = 'https://evil.test/app')],
    ['apple link elsewhere', (c) => (c.shell.ios.testflight = 'https://testflight.apple.com.evil.test/x')],
    ['notes too long', (c) => (c.notes = 'x'.repeat(5000))],
    ['mandatory not boolean', (c) => (c.mandatory = 'no')],
    ['coordinator from another release', (c) => (c.coordinator = { url: asset('0.9.0', 'agent-empire-coordinator.mjs'), sha256: 'c'.repeat(64), schema: 1 })],
  ];
  for (const [name, mutate] of cases) {
    const c = base();
    mutate(c);
    assert.throws(() => parseChannel(JSON.stringify(c), 'stable'), ChannelError, name);
  }
  assert.throws(() => parseChannel('not json', 'stable'), ChannelError);
});

test('channel: release asset URLs are pinned to the repository and refuse traversal', () => {
  assert.deepEqual(releaseAsset(`https://github.com/${RELEASE_REPO}/releases/download/v1.0.0/a.zip`), { tag: 'v1.0.0', file: 'a.zip' });
  assert.deepEqual(releaseAsset(`https://github.com/${RELEASE_REPO}/releases/latest/download/channel-stable.json`), { tag: null, file: 'channel-stable.json' });
  for (const bad of [
    `https://github.com/${RELEASE_REPO}/releases/download/../a.zip`,
    `https://github.com/${RELEASE_REPO}/releases/download/v1/%2e%2e/a.zip`,
    `https://github.com/${RELEASE_REPO}/archive/v1.zip`,
    `https://github.com.evil.test/${RELEASE_REPO}/releases/download/v1/a.zip`,
    `https://user@github.com/${RELEASE_REPO}/releases/download/v1/a.zip`,
    `https://github.com:8443/${RELEASE_REPO}/releases/download/v1/a.zip`,
    `https://github.com/other/repo/releases/download/v1/a.zip`,
  ])
    assert.equal(releaseAsset(bad), null, bad);
  assert.equal(channelUrls('stable').json, `https://github.com/${RELEASE_REPO}/releases/latest/download/channel-stable.json`);
  assert.equal(channelUrls('beta', 'v1.0.0-beta.2').sig, `https://github.com/${RELEASE_REPO}/releases/download/v1.0.0-beta.2/channel-beta.json.sig`);
});

// ---- signatures -------------------------------------------------------------------------------------------------

test('signature: verified against the pinned key; tampering, the wrong key and garbage are refused', async () => {
  const { text, sig } = signedChannel({ version: '1.0.0-beta.2' });
  assert.equal((await verifyChannel(text, sig, 'stable')).version, '1.0.0-beta.2');
  // tweetnacl path (an engine without Ed25519 in WebCrypto)
  assert.equal((await verifyChannel(text, sig, 'stable', DEV_RELEASE_PUBLIC_KEY, null)).version, '1.0.0-beta.2');
  const tampered = text.replace('"a', '"b');
  await assert.rejects(verifyChannel(tampered, sig, 'stable'), /signature/);
  await assert.rejects(verifyChannel(tampered, sig, 'stable', DEV_RELEASE_PUBLIC_KEY, null), /signature/);
  await assert.rejects(verifyChannel(text, sign(text, OTHER_KEYPAIR.secretKey), 'stable'), /signature/);
  await assert.rejects(verifyChannel(text, 'not base64!', 'stable'), /signature/);
  await assert.rejects(verifyChannel(text, '', 'stable'), /signature/);
  assert.equal(await verifyEd25519(new TextEncoder().encode(text), sig, 'AAAA'), false);
  // A correctly signed file for the other channel is still refused.
  const beta = signedChannel({ version: '1.0.0-beta.3', channel: 'beta' });
  await assert.rejects(verifyChannel(beta.text, beta.sig, 'stable'), /beta channel/);
});

// ---- fetching -----------------------------------------------------------------------------------------------------

function memory(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}
function fakeReleases(files: Record<string, { status?: number; body: string; etag?: string }>) {
  const calls: { url: string; etag?: string }[] = [];
  const fetcher: Fetcher = async (url, etag) => {
    calls.push({ url, etag });
    const f = files[url];
    if (!f) return { status: 404, body: 'Not Found', etag: null };
    if (etag && f.etag === etag) return { status: 304, body: '', etag };
    return { status: f.status ?? 200, body: f.body, etag: f.etag ?? null };
  };
  return { fetcher, calls };
}
function publish(files: Record<string, { status?: number; body: string; etag?: string }>, channel: 'stable' | 'beta', version: string, tag?: string, secret?: Uint8Array) {
  const { text, sig } = signedChannel({ channel, version }, secret);
  const u = channelUrls(channel, tag);
  files[u.json] = { body: text };
  files[u.sig] = { body: sig };
}
const listing = (rels: { tag: string; prerelease: boolean; beta?: boolean }[]) =>
  JSON.stringify(rels.map((r) => ({ tag_name: r.tag, draft: false, prerelease: r.prerelease, assets: r.beta === false ? [] : [{ name: 'channel-beta.json' }, { name: 'channel-beta.json.sig' }] })));

test('fetch: stable reads the latest release; no release yet is not an error', async () => {
  const files: Record<string, { body: string }> = {};
  assert.equal(await fetchChannel('stable', fakeReleases(files).fetcher), null);
  publish(files, 'stable', '1.0.0');
  assert.equal((await fetchChannel('stable', fakeReleases(files).fetcher))?.file.version, '1.0.0');
});

test('fetch: beta takes the newest pre-release, or stable when that is newer; the listing uses ETags', async () => {
  const files: Record<string, { status?: number; body: string; etag?: string }> = {};
  publish(files, 'stable', '1.0.0-beta.1');
  publish(files, 'beta', '1.0.0-beta.3', 'v1.0.0-beta.3');
  publish(files, 'beta', '1.0.0-beta.2', 'v1.0.0-beta.2');
  files[RELEASES_API] = { body: listing([{ tag: 'v1.0.0-beta.2', prerelease: true }, { tag: 'v1.0.0-beta.3', prerelease: true }, { tag: 'v1.0.0-beta.9', prerelease: true, beta: false }]), etag: 'W/"1"' };
  const cache = memory();
  const a = fakeReleases(files);
  const got = await fetchChannel('beta', a.fetcher, { cache });
  assert.equal(got?.file.version, '1.0.0-beta.3');
  assert.equal(got?.from, 'v1.0.0-beta.3');
  // Second check: conditional request, 304, cached listing used.
  const b = fakeReleases(files);
  assert.equal((await fetchChannel('beta', b.fetcher, { cache }))?.file.version, '1.0.0-beta.3');
  assert.equal(b.calls.find((c) => c.url === RELEASES_API)?.etag, 'W/"1"');
  // A newer stable release wins for beta players.
  publish(files, 'stable', '1.0.0');
  assert.equal((await fetchChannel('beta', fakeReleases(files).fetcher, { cache }))?.file.version, '1.0.0');
  assert.equal(newestPrereleaseTag(JSON.parse(listing([{ tag: 'v2.0.0', prerelease: false }])), compareSemver), null);
});

test('fetch: a rate-limited listing falls back to the cached copy, and without one reports the limit', async () => {
  const files: Record<string, { status?: number; body: string; etag?: string }> = {};
  publish(files, 'beta', '1.0.0-beta.2', 'v1.0.0-beta.2');
  files[RELEASES_API] = { body: listing([{ tag: 'v1.0.0-beta.2', prerelease: true }]), etag: 'W/"a"' };
  const cache = memory();
  await fetchChannel('beta', fakeReleases(files).fetcher, { cache });
  files[RELEASES_API] = { status: 403, body: '{"message":"API rate limit exceeded"}' };
  assert.equal((await fetchChannel('beta', fakeReleases(files).fetcher, { cache, now: 1000 }))?.file.version, '1.0.0-beta.2');
  await assert.rejects(fetchChannel('beta', fakeReleases(files).fetcher, { cache: memory() }), (e: unknown) => e instanceof SourceError && e.code === 'rate_limited');
});

test('fetch: a file signed with another key is refused, never used', async () => {
  const files: Record<string, { body: string }> = {};
  publish(files, 'stable', '9.9.9', undefined, OTHER_KEYPAIR.secretKey);
  await assert.rejects(fetchChannel('stable', fakeReleases(files).fetcher), (e: unknown) => e instanceof SourceError && e.code === 'signature');
});

// ---- offers ---------------------------------------------------------------------------------------------------------

const file = (version: string, over: Parameters<typeof channelJson>[0] extends infer P ? Partial<P> : never = {}) => parseChannel(JSON.stringify(channelJson({ version, ...over })), 'stable');

test('offer: a newer game installs; equal, older and rolled-back versions are never offered (forward only)', () => {
  assert.equal(decide(file('1.0.0-beta.2'), { info: info() }).game.kind, 'install');
  assert.equal(decide(file('1.0.0-beta.1'), { info: info() }).game.kind, 'none');
  assert.equal(decide(file('0.9.0'), { info: info() }).game.kind, 'none');
  assert.equal(decide(file('1.0.0-beta.2'), { info: info({ installedGame: '1.0.0-beta.3' }) }).game.kind, 'none', 'never below the running bundle');
  assert.equal(decide(file('1.0.0-beta.2'), { info: info({ installedGame: '1.0.0-beta.1', builtinGame: '1.0.0' }) }).game.kind, 'none', 'never below the built-in bundle');
  assert.equal(decide(file('1.0.0-beta.2'), { info: info({ pendingGame: '1.0.0-beta.2' }) }).game.kind, 'none', 'already waiting');
  assert.equal(decide(file('1.0.0-beta.2'), { info: info({ rolledBack: '1.0.0-beta.2' }) }).game.kind, 'none', 'just rolled back from it');
  assert.equal(decide(file('1.0.0-beta.2'), { info: info({ canInstallGame: false }) }).game.kind, 'none');
  assert.equal(decide(file('1.0.0-beta.2'), { info: null }).any, false, 'a browser gets no game offer');
});

test('offer: minShell above the installed app asks for a native update first', () => {
  const o = decide(file('1.0.0-beta.2', { minShell: '1.0.0-beta.2' }), { info: info() });
  assert.deepEqual(o.game, { kind: 'needs-shell', version: '1.0.0-beta.2', minShell: '1.0.0-beta.2' });
  assert.ok(o.native, 'the app update is offered alongside');
});

test('offer: native paths per platform', () => {
  const c = file('1.0.0-beta.2');
  assert.equal(nativeOffer(c, info())?.how, 'installer');
  assert.deepEqual(nativeOffer(c, info())?.params, { version: '1.0.0-beta.2', url: c.shell.android!.url, sha256: 'b'.repeat(64) });
  assert.equal(nativeOffer(c, info({ installSource: 'play' }))?.how, 'store');
  const noSha = file('1.0.0-beta.2', { android: { sha256: undefined } });
  assert.equal(nativeOffer(noSha, info())?.how, 'store', 'no APK hash in the signed channel: Play instead of installing');
  assert.equal(nativeOffer(c, info({ platform: 'ios', installSource: 'testflight' }))?.params.testflight, c.shell.ios!.testflight);
  assert.equal(nativeOffer(c, info({ platform: 'ios', installSource: 'appstore' }))?.params.appStore, c.shell.ios!.appStore);
  const mac = info({ platform: 'desktop', os: 'macos', arch: 'arm64' });
  assert.equal(nativeOffer(c, mac)?.how, 'download', 'an unsigned app opens the release page');
  assert.equal(nativeOffer(c, mac)?.params.url, `https://github.com/${RELEASE_REPO}/releases/tag/v1.0.0-beta.2`);
  assert.deepEqual(nativeOffer(c, { ...mac, canAutoUpdate: true })?.params.feed, asset('1.0.0-beta.2', 'desktop-update-darwin-arm64.json'));
  assert.equal(nativeOffer(c, { ...mac, canAutoUpdate: true })?.how, 'auto');
  assert.equal(nativeOffer(c, info({ platform: 'desktop', os: 'windows', arch: 'x64', canAutoUpdate: true }))?.how, 'download', 'Windows has no in-place updater yet');
  const squirrel = parseChannel(JSON.stringify({ ...channelJson({ version: '1.0.0-beta.2' }), shell: { windows: { version: '1.0.0-beta.2', url: `https://github.com/${RELEASE_REPO}/releases/tag/v1.0.0-beta.2`, auto: true, feed: `https://github.com/${RELEASE_REPO}/releases/download/v1.0.0-beta.2` } } }), 'stable');
  const win = info({ platform: 'desktop', os: 'windows', arch: 'x64', canAutoUpdate: true });
  assert.deepEqual(nativeOffer(squirrel, win), { version: '1.0.0-beta.2', params: { version: '1.0.0-beta.2', url: `https://github.com/${RELEASE_REPO}/releases/tag/v1.0.0-beta.2`, feed: `https://github.com/${RELEASE_REPO}/releases/download/v1.0.0-beta.2` }, how: 'auto' }, 'a Squirrel.Windows install updates itself');
  assert.equal(nativeOffer(squirrel, { ...win, canAutoUpdate: false })?.how, 'download', 'not a Squirrel install: the release page');
  const stableFeed = parseChannel(JSON.stringify({ ...channelJson({ version: '1.0.0' }), shell: { windows: { version: '1.0.0', url: `https://github.com/${RELEASE_REPO}/releases/tag/v1.0.0`, auto: true, feed: `https://github.com/${RELEASE_REPO}/releases/latest/download` } } }), 'stable');
  assert.equal(stableFeed.shell.windows?.feed?.x64, `https://github.com/${RELEASE_REPO}/releases/latest/download`, 'stable Squirrel.Windows feed folder');
  assert.equal(nativeOffer(c, info({ shellVersion: '1.0.0-beta.2' })), null);
  assert.equal(nativeOffer(c, info({ platform: 'desktop', os: 'linux' })), null);
});

test('offer: server mode shows the server version without acting on it', () => {
  assert.deepEqual(decide(file('1.0.0'), { info: null, serverVersion: '0.1.0' }).server, { running: '0.1.0', available: '1.0.0' });
  assert.equal(decide(file('1.0.0'), { info: null, serverVersion: '1.0.0' }).server, null);
  assert.equal(decide(file('1.0.0'), { info: null, serverVersion: 'abc1234' }).server, null, 'a git sha is not compared');
});

// ---- prompt gating ----------------------------------------------------------------------------------------------------

test('gate: never during a modal, typing, a jump, loading or in the background', () => {
  const calm = { boot: 'ready', modalOpen: false, typing: false, airborne: false, hidden: false };
  assert.equal(promptGate(calm), 'show');
  assert.equal(promptGate({ ...calm, boot: 'forced' }), 'show');
  for (const k of ['modalOpen', 'typing', 'airborne', 'hidden'] as const) assert.equal(promptGate({ ...calm, [k]: true }), 'wait', k);
  for (const boot of ['loading', 'setup', undefined]) assert.equal(promptGate({ ...calm, boot }), 'wait', String(boot));
});

// ---- bridge -------------------------------------------------------------------------------------------------------------

function androidBridge(answer: (req: BridgeRequest) => unknown) {
  const sent: BridgeRequest[] = [];
  const w: Record<string, unknown> = { AGENT_EMPIRE_APP: { platform: 'android' } };
  w.empireAndroid = {
    postMessage: (json: string) => {
      const req = JSON.parse(json) as BridgeRequest;
      sent.push(req);
      queueMicrotask(() => (w.__empireNative as { resolve(id: string, v: unknown): void }).resolve(req.id, answer(req)));
    },
  };
  return { bridge: updateBridge(new NativeBridge(w))!, sent };
}

test('bridge: page-side validation before anything reaches the shell', async () => {
  const { bridge, sent } = androidBridge((req) => (req.method === 'update.installGame' ? { version: (req.params as any).version } : { status: 200, body: 'x', etag: null }));
  await assert.rejects(bridge.fetch('https://evil.test/channel.json'), /not an Agent Empire release/);
  await assert.rejects(bridge.installGame({ url: 'https://evil.test/a.zip', sha256: 'a'.repeat(64), version: '1.0.0' }), /not valid/);
  await assert.rejects(bridge.installGame({ url: asset('1.0.0', 'a.zip'), sha256: 'nothex', version: '1.0.0' }), /not valid/);
  await assert.rejects(bridge.installGame({ url: asset('1.0.0', 'a.zip'), sha256: 'a'.repeat(64), version: 'latest' }), /not valid/);
  assert.equal(sent.length, 0);
  assert.deepEqual(await bridge.installGame({ url: asset('1.0.0', 'a.zip'), sha256: 'a'.repeat(64), version: '1.0.0' }), { version: '1.0.0' });
  assert.equal((await bridge.fetch(RELEASES_API, 'W/"x"')).status, 200);
  assert.deepEqual(sent.map((s) => s.method), ['update.installGame', 'update.fetch']);
  // Unknown fields from openNative are dropped; only validated links are sent.
  await bridge.openNative({ version: '1.0.0', play: 'https://evil.test/x', url: asset('1.0.0', 'a.apk') }).catch(() => {});
  assert.deepEqual(sent[2].params, { version: '1.0.0', url: asset('1.0.0', 'a.apk') });
});

test('bridge: nativeInfo answers are validated', () => {
  assert.equal(parseNativeInfo({ platform: 'ios', shellVersion: '1.0.0', installedGame: '1.0.0', builtinGame: 'x', canInstallGame: true }, 'ios').builtinGame, null);
  assert.throws(() => parseNativeInfo({ platform: 'android', shellVersion: '1.0.0' }, 'ios'));
  assert.throws(() => parseNativeInfo({ platform: 'ios', shellVersion: 'one' }, 'ios'));
  assert.equal(parseNativeInfo({ platform: 'desktop', shellVersion: '1.0.0', os: 'macos', rolledBack: '1.0.1' }, 'desktop').rolledBack, '1.0.1');
  assert.equal(parseNativeInfo({ platform: 'android', shellVersion: '1.0.0', installPending: '1.0.2' }, 'android').installPending, '1.0.2');
  assert.equal(parseNativeInfo({ platform: 'android', shellVersion: '1.0.0', installPending: '<b>' }, 'android').installPending, undefined);
});

// ---- service flow ----------------------------------------------------------------------------------------------------------

function fakeShell(files: Record<string, { body: string }>, over: Partial<NativeInfo> = {}) {
  const calls: string[] = [];
  const bridge: UpdateBridge = {
    platform: 'android',
    fetch: async (url, etag) => fakeReleases(files).fetcher(url, etag),
    installGame: async (p) => (calls.push(`install ${p.version} ${p.sha256.slice(0, 4)}`), { version: p.version }),
    activate: async () => void calls.push('activate'),
    bootOk: async () => void calls.push('bootOk'),
    nativeInfo: async () => info(over),
    openNative: async (p) => (calls.push(`native ${p.version}`), { action: 'installer' }),
  };
  return { bridge, calls };
}

test('service: check → offer → install (only when asked) → restart into it', async () => {
  const files: Record<string, { body: string }> = {};
  publish(files, 'stable', '1.0.0-beta.2');
  const { bridge, calls } = fakeShell(files);
  const svc = new UpdateService({ bridge, storage: memory() });
  await svc.start();
  svc.stop();
  assert.equal(svc.state.offer?.game.kind, 'install');
  assert.deepEqual(calls, [], 'a check never installs anything');
  await svc.installGame();
  assert.equal(svc.state.installed, '1.0.0-beta.2');
  await svc.restart();
  assert.deepEqual(calls, ['install 1.0.0-beta.2 aaaa', 'activate']);
});

test('service: the channel setting persists, and a failed check keeps the app usable', async () => {
  const storage = memory();
  const svc = new UpdateService({ bridge: fakeShell({}).bridge, storage });
  svc.setChannel('beta');
  assert.equal(storage.get('agent-empire.update.channel'), 'beta');
  assert.equal(new UpdateService({ bridge: null, storage }).state.channel, 'beta');
  const broken = new UpdateService({ bridge: null, storage: memory(), fetcher: async () => { throw new Error('offline'); } });
  await broken.check();
  assert.equal(broken.state.phase, 'error');
  assert.match(broken.state.error ?? '', /offline/);
  assert.equal(new UpdateService({ bridge: null, storage: null }).canCheck, false, 'a plain browser does not check');
});

// ---- REL-05: coordinator ------------------------------------------------------------------------------------------------------

const REPO = { owner: 'founder', name: 'agent-empire-state' };
test('coordinator: offered only when newer, refused when the state schema is newer than this app', () => {
  const sha = 'c'.repeat(64);
  const c = file('1.0.0-beta.2', { coordinatorSha: sha });
  assert.equal(coordinatorDecision(c, { version: '1.0.0-beta.1', sha256: 'd'.repeat(64) }).kind, 'available');
  assert.equal(coordinatorDecision(c, { version: null, sha256: 'd'.repeat(64) }).kind, 'available', 'unknown version that differs');
  assert.equal(coordinatorDecision(c, { version: null, sha256: sha }).kind, 'current');
  assert.equal(coordinatorDecision(c, { version: '1.0.0-beta.3', sha256: 'd'.repeat(64) }).kind, 'current', 'never downgraded');
  assert.equal(coordinatorDecision(file('1.0.0-beta.2', { coordinatorSha: sha, schema: 2 }), { version: '1.0.0-beta.1', sha256: null }).kind, 'needs-game');
  assert.equal(coordinatorDecision(file('1.0.0-beta.2'), { version: null, sha256: null }).kind, 'current', 'no coordinator in the channel');
});

test('coordinator: accepting commits the verified bundle and manifest in one commit; a mismatch writes nothing', async () => {
  const gh = new FakeGitHub();
  const full = `${REPO.owner}/${REPO.name}`;
  gh.create(full, true, { 'README.md': '# state\n', [COORDINATOR_BUNDLE_PATH]: 'old coordinator', 'state/meta.json': '{}' });
  const repo = new CloudRepo(REPO, 'ghu_user', gh.fetch);
  const installed = await readInstalledCoordinator(repo);
  assert.deepEqual(installed, { version: null, sha256: sha256('old coordinator') });
  const bundle = '// new coordinator\nexport function runCoordinatorTick() {}\n';
  const c = file('1.0.0-beta.2', { coordinatorSha: sha256(bundle) });
  const offer = coordinatorDecision(c, installed);
  assert.equal(offer.kind, 'available');
  if (offer.kind !== 'available') return;

  const writesBefore = gh.writes.length;
  await assert.rejects(commitCoordinatorUpdate(repo, offer, 1, async () => 'tampered'), /does not match the signed release/);
  assert.equal(gh.writes.length, writesBefore, 'nothing written for a mismatching download');

  gh.commitOnBranch(full, { 'state/meta.json': '{"revision":2}' }); // the coordinator committed meanwhile
  await commitCoordinatorUpdate(repo, offer, 1, async () => bundle);
  const after = gh.files(full);
  assert.equal(after[COORDINATOR_BUNDLE_PATH], bundle);
  assert.deepEqual(JSON.parse(after[COORDINATOR_MANIFEST_PATH]), { version: '1.0.0-beta.2', sha256: sha256(bundle), schema: 1, updatedBy: 'agent-empire-app' });
  assert.equal(after['state/meta.json'], '{"revision":2}', 'state is never touched');
  assert.deepEqual(await readInstalledCoordinator(repo), { version: '1.0.0-beta.2', sha256: sha256(bundle) });
  assert.equal(coordinatorDecision(c, await readInstalledCoordinator(repo)).kind, 'current');
});

test('coordinator: the service commits only after the player accepts, using the bundled copy when it matches', async () => {
  const gh = new FakeGitHub();
  const full = `${REPO.owner}/${REPO.name}`;
  gh.create(full, true, { [COORDINATOR_BUNDLE_PATH]: 'old coordinator' });
  const bundle = 'export function runCoordinatorTick() {} // 1.0.0-beta.2\n';
  const files: Record<string, { body: string }> = {};
  const { text, sig } = signedChannel({ version: '1.0.0-beta.2', coordinatorSha: sha256(bundle) });
  files[channelUrls('stable').json] = { body: text };
  files[channelUrls('stable').sig] = { body: sig };
  const { bridge } = fakeShell(files);
  const svc = new UpdateService({ bridge, storage: memory(), bundledCoordinator: async () => bundle });
  svc.attachCloud(new CloudRepo(REPO, 'ghu_user', gh.fetch));
  await svc.start();
  svc.stop();
  assert.equal(svc.state.coordinator?.kind, 'available');
  assert.equal(gh.writes.length, 0, 'no automatic commit');
  await svc.updateCoordinator();
  assert.equal(gh.files(full)[COORDINATOR_BUNDLE_PATH], bundle);
  assert.equal(svc.state.coordinator?.kind, 'current');
});
