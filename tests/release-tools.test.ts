// Release tooling (REL-01/REL-02): version sync and tag rules, Ed25519 signing, deterministic game bundle, channel
// file builder, Play upload client and the release workflow's static rules. No network, no real keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkTag, checkVersion, compareVersions, isOnMain, parseVersion, releaseChannel, syncVersion, TARGETS, versionCode, versionInfo,
} from '../tools/release/version.mjs';
import { checkPinnedKey, devPrivateKey, pinnedKeys, privateKey, publicKeyBase64, signBytes, verifyBytes } from '../tools/release/sign.mjs';
import { crc32, createZip, readZip } from '../tools/release/zip.mjs';
import { packageGame } from '../tools/release/package-game.mjs';
import { buildChannel, classifyAssets, coordinatorSchema, squirrelFeed } from '../tools/release/channel.mjs';
import { serviceAccountAssertion, uploadBundle } from '../tools/release/play-upload.mjs';
import { DEV_RELEASE_PUBLIC_KEY, RELEASE_KEY_IS_DEVELOPMENT, RELEASE_PUBLIC_KEY } from '../src/shared/release-key';

const ROOT = path.resolve(import.meta.dirname, '..');
const temp = (name: string) => mkdtempSync(path.join(tmpdir(), `ae-release-${name}-`));
const COMMIT = 'a'.repeat(40);

/** A copy of every version target plus the files the key check reads. */
function fixtureRoot(): string {
  const root = temp('root');
  for (const target of TARGETS) {
    mkdirSync(path.dirname(path.join(root, target.file)), { recursive: true });
    copyFileSync(path.join(ROOT, target.file), path.join(root, target.file));
  }
  for (const file of ['src/shared/release-key.ts', 'tools/release/config.json', 'src/cloud/schema.ts']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  return root;
}

test('version codes are deterministic, monotonic and within Play limits', () => {
  assert.equal(versionCode('1.0.0-beta.1'), 10000301);
  assert.equal(versionCode('1.0.0-beta.2'), 10000302);
  assert.equal(versionCode('1.0.0'), 10000999);
  assert.equal(versionCode('0.1.0'), 100999);
  const ordered = ['0.9.9', '1.0.0-alpha.0', '1.0.0-alpha.199', '1.0.0-beta.1', '1.0.0-beta.10', '1.0.0-beta.199', '1.0.0-rc.1', '1.0.0',
    '1.0.1-beta.1', '1.0.1', '1.1.0-alpha.1', '1.99.99', '2.0.0-rc.3', '2.0.0', '209.99.99'];
  for (let i = 1; i < ordered.length; i++) assert.ok(versionCode(ordered[i]) > versionCode(ordered[i - 1]), `${ordered[i]} > ${ordered[i - 1]}`);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-beta.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(versionCode('209.99.99') <= 2_100_000_000);
  assert.throws(() => versionCode('211.0.0'), /Google Play/);
});

test('versions outside X.Y.Z[-(alpha|beta|rc).N] are refused', () => {
  for (const bad of ['1.0', 'v1.0.0', '1.0.0-beta', '1.0.0-beta.01', '01.0.0', '1.0.0-preview.1', '1.100.0', '1.0.100', '1.0.0-beta.200', '1.0.0+build.1', '', ' 1.0.0'])
    assert.throws(() => parseVersion(bad), /Invalid version/, bad);
  assert.deepEqual(parseVersion('1.2.3-rc.4').pre, { tag: 'rc', n: 4 });
});

test('derived values: channel, iOS marketing version and build number', () => {
  assert.equal(releaseChannel('1.0.0-beta.1'), 'beta');
  assert.equal(releaseChannel('1.0.0-rc.2'), 'beta');
  assert.equal(releaseChannel('1.0.0'), 'stable');
  assert.deepEqual(versionInfo('1.2.3-beta.4'), {
    version: '1.2.3-beta.4', tag: 'v1.2.3-beta.4', prerelease: true, channel: 'beta', androidVersionName: '1.2.3-beta.4',
    androidVersionCode: 10203304, iosMarketingVersion: '1.2.3', iosBuildNumber: '10203304',
  });
});

test('this branch is on 1.0.0-beta.1 and every target is in sync', () => {
  assert.equal(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, '1.0.0-beta.1');
  assert.deepEqual(checkVersion(ROOT), []);
  assert.match(readFileSync(path.join(ROOT, 'mobile/android/app/src/main/AndroidManifest.xml'), 'utf8'), /android:versionCode="10000301" android:versionName="1.0.0-beta.1"/);
  const pbx = readFileSync(path.join(ROOT, 'mobile/ios/AgentEmpire.xcodeproj/project.pbxproj'), 'utf8');
  assert.equal([...pbx.matchAll(/MARKETING_VERSION = 1\.0\.0;/g)].length, 2);
  assert.equal([...pbx.matchAll(/CURRENT_PROJECT_VERSION = 10000301;/g)].length, 2);
});

test('sync writes every target, check names drift, and other content is untouched', () => {
  const root = fixtureRoot();
  const pkg = path.join(root, 'package.json');
  writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"version": "1.0.0-beta.1"', '"version": "1.2.0-rc.3"'));
  const before = readFileSync(path.join(root, 'desktop/package.json'), 'utf8');
  assert.equal(checkVersion(root).length, TARGETS.length - 1);
  const changed = syncVersion(root);
  assert.equal(changed.length, TARGETS.length - 1);
  assert.deepEqual(checkVersion(root), []);
  assert.deepEqual(syncVersion(root), []);
  assert.equal(readFileSync(path.join(root, 'desktop/package.json'), 'utf8'), before.replace('"version": "1.0.0-beta.1"', '"version": "1.2.0-rc.3"'));
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, '1.2.0-rc.3');
  assert.equal(lock.packages[''].version, '1.2.0-rc.3');
  assert.match(readFileSync(path.join(root, 'mobile/android/app/build.gradle'), 'utf8'), /versionCode 10200603\n\s+versionName '1.2.0-rc.3'/);
  const pbxPath = path.join(root, 'mobile/ios/AgentEmpire.xcodeproj/project.pbxproj');
  writeFileSync(pbxPath, readFileSync(pbxPath, 'utf8').replace('CURRENT_PROJECT_VERSION = 10200603;', 'CURRENT_PROJECT_VERSION = 7;'));
  const problems = checkVersion(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /project\.pbxproj: has 7, 10200603/);
  writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"version": "1.2.0-rc.3"', '"version": "1.2"'));
  assert.match(checkVersion(root)[0], /package\.json: Invalid version/);
});

test('tag rule: the tag is exactly v<version> and its commit is on main', () => {
  assert.deepEqual(checkTag('v1.0.0-beta.1', '1.0.0-beta.1'), []);
  assert.deepEqual(checkTag('refs/tags/v1.0.0-beta.1', '1.0.0-beta.1'), []);
  for (const tag of ['1.0.0-beta.1', 'v1.0.0-beta.2', 'v1.0.0', 'v0.1.4', 'release-1'])
    assert.equal(checkTag(tag, '1.0.0-beta.1').length, 1, tag);
  const repo = temp('git');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  const onMain = git('rev-parse', 'HEAD');
  git('switch', '-q', '-c', 'codex/empire-world');
  git('commit', '-q', '--allow-empty', '-m', 'two');
  const offMain = git('rev-parse', 'HEAD');
  assert.equal(isOnMain(onMain, 'main', repo), true);
  assert.equal(isOnMain(offMain, 'main', repo), false);
  assert.equal(isOnMain('0'.repeat(40), 'main', repo), false);
});

test('Ed25519 sign/verify round-trips and rejects tampering, other keys and malformed signatures', () => {
  const { privateKey: key } = generateKeyPairSync('ed25519');
  const pem = key.export({ format: 'pem', type: 'pkcs8' }).toString();
  const pub = publicKeyBase64(privateKey(pem));
  const data = Buffer.from(JSON.stringify({ version: '1.0.0-beta.1', mandatory: false }));
  const sig = signBytes(data, pem);
  assert.equal(Buffer.from(sig, 'base64').length, 64);
  assert.equal(verifyBytes(data, sig, pub), true);
  assert.equal(verifyBytes(data, `${sig}\n`, pub), true);
  const tampered = Buffer.from(data); tampered[5] ^= 1;
  assert.equal(verifyBytes(tampered, sig, pub), false);
  assert.equal(verifyBytes(Buffer.concat([data, Buffer.from(' ')]), sig, pub), false);
  assert.equal(verifyBytes(data, sig, publicKeyBase64(devPrivateKey())), false);
  assert.equal(verifyBytes(data, sig.slice(4), pub), false);
  assert.equal(verifyBytes(data, '', pub), false);
  assert.equal(verifyBytes(data, sig, 'AAAA'), false);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.throws(() => signBytes(data, rsa), /Ed25519/);
  // tweetnacl (what the web client can use) accepts the same raw key and signature.
  return import('tweetnacl').then(({ default: nacl }) => {
    assert.equal(nacl.sign.detached.verify(data, Buffer.from(sig, 'base64'), Buffer.from(pub, 'base64')), true);
  });
});

test('the pinned key file holds the development placeholder, and the release gate refuses it', () => {
  assert.equal(DEV_RELEASE_PUBLIC_KEY, publicKeyBase64(devPrivateKey()));
  assert.equal(RELEASE_PUBLIC_KEY, DEV_RELEASE_PUBLIC_KEY);
  assert.equal(RELEASE_KEY_IS_DEVELOPMENT, true);
  assert.deepEqual(pinnedKeys(ROOT), { release: RELEASE_PUBLIC_KEY, dev: DEV_RELEASE_PUBLIC_KEY });
  assert.match(checkPinnedKey({ root: ROOT }).join('\n'), /still the development key/);
  assert.deepEqual(checkPinnedKey({ root: ROOT, allowDev: true }), []);

  const root = fixtureRoot();
  const { privateKey: owner } = generateKeyPairSync('ed25519');
  const ownerPem = owner.export({ format: 'pem', type: 'pkcs8' }).toString();
  const ownerPub = publicKeyBase64(owner);
  const keyFile = path.join(root, 'src/shared/release-key.ts');
  writeFileSync(keyFile, readFileSync(keyFile, 'utf8').replace(`export const RELEASE_PUBLIC_KEY = '${DEV_RELEASE_PUBLIC_KEY}';`, `export const RELEASE_PUBLIC_KEY = '${ownerPub}';`));
  assert.deepEqual(checkPinnedKey({ root, signingKey: ownerPem }), []);
  const other = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.match(checkPinnedKey({ root, signingKey: other }).join('\n'), /is not the pinned RELEASE_PUBLIC_KEY/);
  // A shell file listed in pinnedKeyFiles must carry the same key.
  const configFile = path.join(root, 'tools/release/config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, pinnedKeyFiles: [...config.pinnedKeyFiles, 'desktop/release-key.cjs'] }));
  assert.match(checkPinnedKey({ root }).join('\n'), /desktop\/release-key\.cjs: missing/);
  writeFileSync(path.join(root, 'desktop/release-key.cjs'), `module.exports = '${DEV_RELEASE_PUBLIC_KEY}';\n`);
  assert.match(checkPinnedKey({ root }).join('\n'), /desktop\/release-key\.cjs: does not pin/);
  writeFileSync(path.join(root, 'desktop/release-key.cjs'), `module.exports = '${ownerPub}';\n`);
  assert.deepEqual(checkPinnedKey({ root }), []);
});

test('zip writer: known CRC, unsafe paths refused, round trip', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  for (const name of ['../x', '/abs', 'a/../b', 'a\\b', 'a//b', '']) assert.throws(() => createZip([{ name, data: Buffer.from('x') }]), /Unsafe archive path/, name);
  assert.throws(() => createZip([{ name: 'a', data: Buffer.from('1') }, { name: 'a', data: Buffer.from('2') }]), /Duplicate/);
  const zip = createZip([{ name: 'b.txt', data: Buffer.from('b'.repeat(1000)) }, { name: 'a/ü.json', data: Buffer.from('{}') }]);
  const files = readZip(zip);
  assert.deepEqual([...files.keys()], ['a/ü.json', 'b.txt']);
  assert.equal(files.get('b.txt')!.toString(), 'b'.repeat(1000));
  const corrupt = Buffer.from(zip); corrupt[40] ^= 0xff;
  assert.throws(() => readZip(corrupt));
});

function fakeDist(): string {
  const dist = temp('dist');
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  mkdirSync(path.join(dist, 'cloud'), { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Agent Empire</title>');
  writeFileSync(path.join(dist, 'assets/app.js'), 'console.log("game");'.repeat(200));
  writeFileSync(path.join(dist, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(path.join(dist, 'cloud/agent-empire-coordinator.mjs'), 'export const runCoordinatorTick = 1;');
  writeFileSync(path.join(dist, '.DS_Store'), 'hidden');
  return dist;
}

test('the game bundle is deterministic and its manifest describes it', () => {
  const dist = fakeDist();
  const a = packageGame({ dist, outDir: temp('outa'), version: '1.0.0-beta.1', commit: COMMIT, minShell: '1.0.0-beta.1' });
  // Different timestamps and a different copy must not change a single byte.
  const copy = temp('dist2');
  cpSync(dist, copy, { recursive: true });
  utimesSync(path.join(copy, 'index.html'), new Date(2001, 1, 1), new Date(2001, 1, 1));
  const b = packageGame({ dist: copy, outDir: temp('outb'), version: '1.0.0-beta.1', commit: COMMIT, minShell: '1.0.0-beta.1' });
  assert.deepEqual(readFileSync(a.zipPath), readFileSync(b.zipPath));
  assert.equal(readFileSync(a.manifestPath, 'utf8'), readFileSync(b.manifestPath, 'utf8'));
  assert.equal(path.basename(a.zipPath), 'agent-empire-game-1.0.0-beta.1.zip');
  const files = readZip(readFileSync(a.zipPath));
  assert.deepEqual([...files.keys()], ['assets/app.js', 'assets/logo.png', 'cloud/agent-empire-coordinator.mjs', 'index.html']);
  const manifest = JSON.parse(readFileSync(a.manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest), ['schema', 'name', 'version', 'file', 'bytes', 'sha256', 'files', 'entry', 'minShell', 'commit']);
  assert.equal(manifest.files, 4);
  assert.equal(manifest.bytes, readFileSync(a.zipPath).length);
  assert.equal(manifest.commit, COMMIT);
  const changed = temp('dist3');
  cpSync(dist, changed, { recursive: true });
  writeFileSync(path.join(changed, 'index.html'), '<!doctype html><title>Agent Empire 2</title>');
  const c = packageGame({ dist: changed, outDir: temp('outc'), version: '1.0.0-beta.1', commit: COMMIT, minShell: '1.0.0-beta.1' });
  assert.notEqual(c.manifest.sha256, a.manifest.sha256);
});

test('the game bundle refuses fixture builds, missing pages and bad inputs', () => {
  const dist = fakeDist();
  const ok = { dist, outDir: temp('out'), version: '1.0.0-beta.1', commit: COMMIT, minShell: '1.0.0-beta.1' };
  assert.throws(() => packageGame({ ...ok, commit: 'abc' }), /40-character/);
  assert.throws(() => packageGame({ ...ok, version: '1.0' }), /Invalid version/);
  assert.throws(() => packageGame({ ...ok, dist: temp('empty') }), /index\.html is missing/);
  writeFileSync(path.join(dist, 'assets/fixture.js'), 'window.__AGENT_EMPIRE_FIXTURE_BUILD__ = 1');
  assert.throws(() => packageGame(ok), /fixture build/);
});

const V = '1.0.0-beta.1';
const CONFIG = { playListing: 'https://play.google.com/store/apps/details?id=com.agentempire.mobile', iosTestFlight: null, iosAppStore: null };
function assetsDir(extra: string[]): string {
  const out = temp('assets');
  packageGame({ dist: fakeDist(), outDir: out, version: V, commit: COMMIT, minShell: '1.0.0-beta.1' });
  writeFileSync(path.join(out, 'agent-empire-coordinator.mjs'), 'export const runCoordinatorTick = 1;');
  for (const name of extra) writeFileSync(path.join(out, name), `binary ${name}`);
  return out;
}
const channelArgs = (dir: string) => ({ assetsDir: dir, version: V, channel: 'beta', repo: 'Billioncodes001/agent-empire', publishedAt: '2026-10-02T12:00:00.000Z', notes: 'Notes', config: CONFIG, root: ROOT });

test('channel file for an unsigned beta follows the contract', () => {
  const dir = assetsDir([`Agent-Empire-${V}-macos-arm64-unsigned.zip`, `Agent-Empire-${V}-macos-arm64-unsigned.dmg`, `Agent-Empire-${V}-macos-x64-unsigned.dmg`,
    `Agent-Empire-${V}-windows-x64-unsigned.zip`, `Agent-Empire-${V}-android-debug-signed.apk`, 'unrelated.txt']);
  const doc = buildChannel(channelArgs(dir));
  assert.deepEqual(Object.keys(doc), ['schema', 'channel', 'version', 'tag', 'publishedAt', 'notes', 'releasePage', 'game', 'shell', 'coordinator', 'mandatory']);
  assert.equal(doc.schema, 1);
  assert.equal(doc.publishedAt, '2026-10-02T12:00:00Z');
  const base = `https://github.com/Billioncodes001/agent-empire/releases/download/v${V}/`;
  assert.equal(doc.game.url, `${base}agent-empire-game-${V}.zip`);
  assert.equal(doc.game.minShell, '1.0.0-beta.1');
  assert.equal(doc.game.manifestSig, `${base}game-manifest.json.sig`);
  assert.equal(doc.shell.macos.auto, false);
  assert.equal(doc.shell.macos.feed, null);
  assert.equal(doc.shell.macos.downloads.arm64.signed, false);
  assert.equal(doc.shell.macos.downloads.x64.zip, undefined);
  assert.equal(doc.shell.windows.auto, false);
  assert.equal(doc.shell.android.versionCode, 10000301);
  assert.equal(doc.shell.android.url, `${base}Agent-Empire-${V}-android-debug-signed.apk`);
  assert.match(doc.shell.android.sha256, /^[0-9a-f]{64}$/);
  assert.equal(doc.shell.android.signed, false);
  assert.equal(doc.shell.android.play, null);
  assert.deepEqual(doc.shell.ios, { version: V, testflight: null, appStore: null });
  assert.equal(doc.coordinator.url, `${base}agent-empire-coordinator.mjs`);
  assert.equal(doc.coordinator.schema, coordinatorSchema(ROOT));
  assert.equal(doc.mandatory, false);
  // Deterministic for the same inputs.
  assert.deepEqual(buildChannel(channelArgs(dir)), doc);
});

test('signed macOS builds get auto updates and Squirrel feeds; Play link only after an upload', () => {
  const dir = assetsDir([`Agent-Empire-${V}-macos-arm64.zip`, `Agent-Empire-${V}-macos-arm64.dmg`, `Agent-Empire-${V}-macos-x64.zip`,
    `Agent-Empire-${V}-windows-x64.zip`, `Agent-Empire-${V}-android.apk`, `Agent-Empire-${V}-android.aab`]);
  const doc = buildChannel({ ...channelArgs(dir), playPublished: true });
  assert.equal(doc.shell.macos.auto, true);
  assert.match(doc.shell.macos.feed.arm64, /desktop-update-darwin-arm64\.json$/);
  assert.equal(doc.shell.windows.downloads.x64.signed, true);
  assert.equal(doc.shell.windows.auto, false);
  assert.equal(doc.shell.android.signed, true);
  assert.equal(doc.shell.android.play, CONFIG.playListing);
  const feed = squirrelFeed({ version: V, url: doc.shell.macos.downloads.arm64.zip.url, notes: 'n', publishedAt: doc.publishedAt });
  assert.equal(feed.currentRelease, V);
  assert.equal(feed.releases[0].updateTo.url, doc.shell.macos.downloads.arm64.zip.url);
});

test('channel builder refuses inconsistent inputs', () => {
  const dir = assetsDir([]);
  assert.throws(() => buildChannel({ ...channelArgs(dir), channel: 'stable' }), /prerelease/);
  assert.throws(() => buildChannel({ ...channelArgs(dir), channel: 'nightly' }), /Unknown channel/);
  assert.throws(() => buildChannel({ ...channelArgs(dir), repo: 'https://evil.example/x' }), /owner\/name/);
  assert.throws(() => buildChannel({ ...channelArgs(dir), version: '1.0.0-beta.2' }), /must contain agent-empire-game-1\.0\.0-beta\.2\.zip/);
  writeFileSync(path.join(dir, `agent-empire-game-${V}.zip`), 'swapped');
  assert.throws(() => buildChannel(channelArgs(dir)), /does not describe/);
  const noCoordinator = assetsDir([]);
  execFileSync('rm', [path.join(noCoordinator, 'agent-empire-coordinator.mjs')]);
  assert.throws(() => buildChannel(channelArgs(noCoordinator)), /agent-empire-coordinator\.mjs/);
  assert.throws(() => classifyAssets([`Agent-Empire-${V}-android.apk`, `Agent-Empire-${V}-android-debug-signed.apk`], V), /More than one Android APK/);
  assert.equal(classifyAssets([`Agent-Empire-1.0.0-beta.10-android.apk`], V).android, null);
});

test('Play upload: RS256 service-account assertion and the edit/upload/track/commit sequence', async () => {
  const { privateKey: key, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = { client_email: 'release@example.iam.gserviceaccount.com', private_key: key.export({ format: 'pem', type: 'pkcs8' }).toString(), token_uri: 'https://oauth2.example/token' };
  const jwt = serviceAccountAssertion(account, 1000);
  const [h, c, s] = jwt.split('.');
  assert.ok(cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${c}`), createPublicKey(publicKey.export({ format: 'pem', type: 'spki' })), Buffer.from(s, 'base64url')));
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), { iss: account.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: account.token_uri, iat: 1000, exp: 4600 });
  assert.throws(() => serviceAccountAssertion({}), /service account/);

  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const replies = [{ access_token: 'tok' }, { id: 'edit1' }, { versionCode: 10000301 }, {}, {}];
  const fakeFetch = async (url: string, init: { method: string; body: unknown }) => {
    calls.push({ url, method: init.method, body: init.body });
    return { ok: true, status: 200, text: async () => JSON.stringify(replies.shift()) };
  };
  const code = await uploadBundle({ account, packageName: 'com.agentempire.mobile', aab: Buffer.from('aab'), track: 'internal', status: 'draft', name: V, fetchImpl: fakeFetch as never });
  assert.equal(code, 10000301);
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), [
    'POST https://oauth2.example/token',
    'POST https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.agentempire.mobile/edits',
    'POST https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/com.agentempire.mobile/edits/edit1/bundles?uploadType=media',
    'PUT https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.agentempire.mobile/edits/edit1/tracks/internal',
    'POST https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.agentempire.mobile/edits/edit1:commit',
  ]);
  assert.deepEqual(JSON.parse(String(calls[3].body)), { track: 'internal', releases: [{ name: V, versionCodes: ['10000301'], status: 'draft' }] });
  const failing = async () => ({ ok: false, status: 403, text: async () => 'denied' });
  await assert.rejects(uploadBundle({ account, packageName: 'x', aab: Buffer.from(''), fetchImpl: failing as never }), /OAuth token failed: HTTP 403/);
  await assert.rejects(uploadBundle({ account, packageName: 'x', aab: Buffer.from(''), status: 'live' }), /completed or draft/);
});

test('release workflow: SHA-pinned actions, least privilege, secrets only where needed, no PR triggers', () => {
  const text = readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const lines = text.split('\n');
  const uses = lines.filter(line => /^\s*(- )?uses:/.test(line));
  assert.ok(uses.length >= 10);
  for (const line of uses) assert.match(line, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, line);
  assert.doesNotMatch(text, /^\s*pull_request(_target)?:/m);
  assert.match(text, /^on:\n {2}push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:\n/m);
  assert.match(text, /^permissions: \{\}$/m);
  assert.match(text, /^concurrency:\n {2}group: release-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false$/m);
  // Every job declares its permissions; only the publish job can write.
  const jobs = text.slice(text.indexOf('\njobs:\n')).split(/\n(?= {2}[a-z][\w-]*:\n)/).slice(1);
  assert.deepEqual(jobs.map(job => job.split(':')[0].trim()), ['verify', 'game', 'desktop-macos', 'desktop-windows', 'android', 'play', 'ios', 'assemble', 'publish']);
  for (const job of jobs) assert.match(job, /\n {4}permissions:\n {6}contents: (read|write)\n/, job.split('\n')[0]);
  assert.deepEqual(jobs.filter(job => /contents: write/.test(job)).map(job => job.split(':')[0].trim()), ['publish']);
  assert.match(jobs.find(job => job.startsWith('  publish:'))!, /if: always\(\) && needs\.assemble\.result == 'success' && needs\.verify\.outputs\.release == 'true'/);
  assert.doesNotMatch(jobs.find(job => job.startsWith('  publish:'))!, /secrets\./);
  // Secret values only reach step env/with blocks; job-level env only carries HAS_* presence flags.
  for (const [i, line] of lines.entries()) {
    if (!line.includes('secrets.')) continue;
    if (/^ {6}HAS_[A-Z_]+: \$\{\{ (secrets\.[A-Z0-9_]+ != '' && )*secrets\.[A-Z0-9_]+ != ''( && vars\.[A-Z_]+ != '')* \}\}$/.test(line)) continue;
    assert.match(line, /^ {10}[\w-]+: \$\{\{ secrets\.[A-Z0-9_]+ \}\}$/, `line ${i + 1}: ${line}`);
  }
  // Untrusted refs are passed through env, never interpolated into scripts.
  for (const line of lines.filter(l => /\$\{\{ github\.(ref_name|head_ref|event)/.test(l))) assert.match(line, /^ {10}[A-Z_]+: \$\{\{/, line);
  // The release is gated on the tag rule, the version check and the key check.
  for (const step of ['version.mjs tag-check "$TAG" --sha "$GITHUB_SHA" --main origin/main', 'version.mjs check', 'sign.mjs check-key', 'check-no-fixture.mjs dist/public', 'npm test', 'npm run typecheck', 'npm run build:cloud'])
    assert.ok(text.includes(step), step);
});
