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
import { checkFeed, nugetVersion, nupkgName, parseReleases, SQUIRREL_ID } from '../tools/release/package-windows-installer.mjs';
import { createHash } from 'node:crypto';
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
  // Every file that pins the key (the shells list theirs in config.json) comes along, so the gate sees them all.
  const pinned: string[] = JSON.parse(readFileSync(path.join(ROOT, 'tools/release/config.json'), 'utf8')).pinnedKeyFiles ?? [];
  for (const file of new Set(['src/shared/release-key.ts', 'tools/release/config.json', 'src/cloud/schema.ts', ...pinned])) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  return root;
}

/** What the owner does by hand: swap the release key line (never the dev one) in every pinned shell file. */
function pinInShells(root: string, key: string) {
  const pinned: string[] = JSON.parse(readFileSync(path.join(root, 'tools/release/config.json'), 'utf8')).pinnedKeyFiles ?? [];
  for (const file of pinned.filter((f) => f !== 'src/shared/release-key.ts')) {
    const full = path.join(root, file);
    const lines = readFileSync(full, 'utf8').split('\n').map((line) =>
      /RELEASE_PUBLIC_KEY|releasePublicKey/.test(line) && !/DEV_RELEASE_PUBLIC_KEY\s*=|devReleasePublicKey\s*=/.test(line) ? line.replace(DEV_RELEASE_PUBLIC_KEY, key) : line,
    );
    writeFileSync(full, lines.join('\n'));
  }
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
  // Until every shell pins the owner key too, the gate refuses the release.
  assert.match(checkPinnedKey({ root, signingKey: ownerPem }).join('\n'), /does not pin RELEASE_PUBLIC_KEY/);
  pinInShells(root, ownerPub);
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
  assert.equal(doc.shell.macos.feed.arm64, `https://github.com/Billioncodes001/agent-empire/releases/download/v${V}/RELEASES-darwin-arm64.json`);
  assert.equal(doc.shell.windows.downloads.x64.signed, true);
  // A zip without the Squirrel installer and feed cannot update in place.
  assert.equal(doc.shell.windows.auto, false);
  assert.equal(doc.shell.windows.feed, null);
  assert.equal(doc.shell.android.signed, true);
  assert.equal(doc.shell.android.play, CONFIG.playListing);
  const feed = squirrelFeed({ version: V, url: doc.shell.macos.downloads.arm64.zip.url, notes: 'n', publishedAt: doc.publishedAt });
  assert.equal(feed.currentRelease, V);
  assert.equal(feed.releases[0].updateTo.url, doc.shell.macos.downloads.arm64.zip.url);
});

test('Squirrel.Windows: NuGet versions sort like ours, and the RELEASES feed must match the package', () => {
  assert.equal(nugetVersion('1.0.0-beta.1'), '1.0.0-beta001');
  assert.equal(nugetVersion('1.0.0-rc.12'), '1.0.0-rc012');
  assert.equal(nugetVersion('2.3.4'), '2.3.4');
  assert.equal(SQUIRREL_ID, 'AgentEmpire');
  assert.equal(nupkgName('1.0.0-beta.1'), 'AgentEmpire-1.0.0-beta001-full.nupkg');
  // NuGet 2 compares the prerelease label as a string: padding keeps beta.2 < beta.10 < rc.1.
  const ordered = ['1.0.0-alpha.3', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-beta.199', '1.0.0-rc.1'].map(v => nugetVersion(v).split('-')[1]);
  assert.deepEqual([...ordered].sort(), ordered);
  assert.throws(() => parseReleases('nonsense'), /Malformed/);
  const dir = temp('feed');
  const pkg = Buffer.from('nupkg bytes');
  writeFileSync(path.join(dir, nupkgName(V)), pkg);
  const sha1 = createHash('sha1').update(pkg).digest('hex').toUpperCase();
  writeFileSync(path.join(dir, 'RELEASES'), `\uFEFF${sha1} ${nupkgName(V)} ${pkg.length}\r\n`);
  assert.deepEqual(parseReleases(readFileSync(path.join(dir, 'RELEASES'), 'utf8')), [{ sha1, file: nupkgName(V), size: pkg.length }]);
  assert.deepEqual(checkFeed(dir, V), []);
  assert.match(checkFeed(dir, '1.0.0-beta.2').join('\n'), /should list only AgentEmpire-1\.0\.0-beta002-full\.nupkg/);
  writeFileSync(path.join(dir, nupkgName(V)), 'tampered!!!');
  assert.match(checkFeed(dir, V).join('\n'), /SHA1 does not match/);
  assert.deepEqual(checkFeed(temp('nofeed'), V), ['RELEASES is missing']);
});

test('desktop update feeds: Squirrel.Windows folder and Squirrel.Mac JSON, latest/download for stable, per tag for beta', () => {
  const S = '1.0.0';
  const dir = temp('stable');
  packageGame({ dist: fakeDist(), outDir: dir, version: S, commit: COMMIT, minShell: '1.0.0-beta.1' });
  writeFileSync(path.join(dir, 'agent-empire-coordinator.mjs'), 'export const runCoordinatorTick = 1;');
  for (const name of [`Agent-Empire-${S}-macos-arm64.zip`, `Agent-Empire-${S}-windows-x64.zip`, `Agent-Empire-${S}-windows-x64-Setup.exe`, nupkgName(S), 'RELEASES'])
    writeFileSync(path.join(dir, name), name);
  const args = { ...channelArgs(dir), version: S };
  const stable = buildChannel({ ...args, channel: 'stable' });
  const beta = buildChannel({ ...args, channel: 'beta' });
  const repo = 'https://github.com/Billioncodes001/agent-empire/releases';
  assert.equal(stable.shell.windows.auto, true);
  assert.equal(stable.shell.windows.feed, `${repo}/latest/download`);
  assert.equal(beta.shell.windows.feed, `${repo}/download/v${S}`);
  assert.equal(stable.shell.macos.feed.arm64, `${repo}/latest/download/RELEASES-darwin-arm64.json`);
  assert.equal(beta.shell.macos.feed.arm64, `${repo}/download/v${S}/RELEASES-darwin-arm64.json`);
  assert.equal(stable.shell.windows.downloads.x64.setup.name, `Agent-Empire-${S}-windows-x64-Setup.exe`);
  assert.equal(stable.shell.windows.downloads.x64.nupkg.url, `${repo}/download/v${S}/AgentEmpire-1.0.0-full.nupkg`);
  // Unsigned installer: the feed exists but in-place updates stay off.
  const unsigned = assetsDir([`Agent-Empire-${V}-windows-x64-unsigned.zip`, `Agent-Empire-${V}-windows-x64-Setup-unsigned.exe`, nupkgName(V), 'RELEASES']);
  const doc = buildChannel(channelArgs(unsigned));
  assert.equal(doc.shell.windows.auto, false);
  assert.equal(doc.shell.windows.downloads.x64.signed, false);
  assert.equal(doc.shell.windows.feed, `${repo}/download/v${V}`);
  // An installer without its RELEASES feed is a download only.
  const noFeed = assetsDir([`Agent-Empire-${V}-windows-x64-Setup.exe`]);
  assert.equal(buildChannel(channelArgs(noFeed)).shell.windows.feed, null);
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
  assert.deepEqual(jobs.map(job => job.split(':')[0].trim()), ['verify', 'game', 'desktop-macos', 'desktop-windows', 'android', 'ios', 'assemble', 'publish', 'play']);
  for (const job of jobs) assert.match(job, /\n {4}permissions:\n {6}contents: (read|write)\n/, job.split('\n')[0]);
  assert.deepEqual(jobs.filter(job => /contents: write/.test(job)).map(job => job.split(':')[0].trim()), ['publish']);
  assert.match(jobs.find(job => job.startsWith('  publish:'))!, /\n {4}needs: \[verify, assemble\]\n {4}if: needs\.verify\.outputs\.release == 'true'\n/);
  assert.doesNotMatch(jobs.find(job => job.startsWith('  publish:'))!, /secrets\./);
  // Secret values only reach step env/with blocks; job-level env only carries HAS_* presence flags.
  for (const [i, line] of lines.entries()) {
    if (!line.includes('secrets.')) continue;
    if (/^ {6}HAS_[A-Z_]+: \$\{\{ needs\.verify\.outputs\.release == 'true' && (secrets\.[A-Z0-9_]+ != '' && )*secrets\.[A-Z0-9_]+ != ''( && vars\.[A-Z_]+ != '')* \}\}$/.test(line)) continue;
    assert.match(line, /^ {10}[\w-]+: \$\{\{ secrets\.[A-Z0-9_]+ \}\}$/, `line ${i + 1}: ${line}`);
  }
  // Untrusted refs are passed through env, never interpolated into scripts.
  for (const line of lines.filter(l => /\$\{\{ github\.(ref_name|head_ref|event)/.test(l))) assert.match(line, /^ {10}[A-Z_]+: \$\{\{/, line);
  // The release is gated on the tag rule, the version check and the key check.
  for (const step of ['version.mjs tag-check "$TAG" --sha "$GITHUB_SHA" --main origin/main', 'version.mjs check', 'sign.mjs check-key', 'check-no-fixture.mjs dist/public', 'npm test', 'npm run typecheck', 'npm run build:cloud'])
    assert.ok(text.includes(step), step);
});

/** Jobs of release.yml as { name, job, header (job-level lines), steps (each step's text) }. */
function workflowJobs() {
  const text = readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  return text.slice(text.indexOf('\njobs:\n')).split(/\n(?= {2}[a-z][\w-]*:\n)/).slice(1).map(job => {
    const [header, ...steps] = job.split(/\n(?= {6}- )/);
    return { name: job.split(':')[0].trim(), job, header, steps };
  });
}
const RELEASE_ENV_ON_TAG = "    environment: ${{ needs.verify.outputs.release == 'true' && 'release' || '' }}";

test('signing secrets: only jobs in the release environment, only on tag runs, never on a dry run', () => {
  const jobs = workflowJobs();
  const releaseOnly = (j: { header: string }) => /\n {4}if: needs\.verify\.outputs\.release == 'true'\n/.test(j.header) && /\n {4}environment: release\n/.test(j.header);
  assert.deepEqual(jobs.filter(j => j.job.includes('secrets.')).map(j => j.name), ['game', 'desktop-macos', 'desktop-windows', 'android', 'ios', 'assemble', 'play']);
  for (const j of jobs) {
    const env = j.header.split('\n').filter(line => line.startsWith('    environment:'));
    if (!j.job.includes('secrets.')) {
      // verify never joins the environment; publish (no secrets, only GITHUB_TOKEN) is gated by it.
      if (j.name === 'publish') assert.ok(releaseOnly(j), 'publish runs only on a tag, in the release environment');
      else assert.deepEqual(env, [], `${j.name} must not join the release environment`);
      continue;
    }
    // A job that references a signing secret joins `release`: literally (tag-only job) or only when the run is a tag.
    assert.ok(env.length === 1 && (env[0] === RELEASE_ENV_ON_TAG || releaseOnly(j)), `${j.name} references secrets without environment: release`);
    // Presence flags are false outside a tag run, whatever secrets exist.
    for (const line of j.header.split('\n').filter(l => l.includes('secrets.')))
      assert.match(line, /^ {6}HAS_[A-Z_]+: \$\{\{ needs\.verify\.outputs\.release == 'true' && /, `${j.name}: ${line}`);
    // Every step that receives a secret runs only on a tag (RELEASE) or behind a release-gated HAS_* flag.
    for (const step of j.steps.filter(st => st.includes('secrets.'))) {
      if (releaseOnly(j)) continue;
      const cond = /\n {8}if: (.*)/.exec(step)?.[1] ?? '';
      assert.match(cond, /env\.RELEASE == 'true'|env\.HAS_[A-Z_]+ == 'true'/, `${j.name} step without a release gate: ${step.split('\n')[0]}`);
      assert.doesNotMatch(cond, /\|\|/, `${j.name}: an OR condition could open the step on a dry run`);
    }
  }
});

test('dry runs sign with --dev; production signing only on tag runs; Play waits for verified signatures', () => {
  const jobs = workflowJobs();
  for (const name of ['game', 'assemble']) {
    const j = jobs.find(x => x.name === name)!;
    const signs = j.steps.filter(st => /sign\.mjs sign /.test(st));
    assert.equal(signs.length, 2, name);
    const dev = signs.find(st => st.includes('sign.mjs sign --dev'))!;
    const prod = signs.find(st => !st.includes('--dev'))!;
    assert.match(dev, /\n {8}if: env\.RELEASE != 'true'\n/, `${name}: the dry-run path signs with --dev`);
    assert.doesNotMatch(dev, /secrets\./);
    assert.match(prod, /\n {8}if: env\.RELEASE == 'true'\n/, `${name}: production signing only on a tag run`);
    assert.match(prod, /sign\.mjs check-key/);
  }
  // Dry runs build unsigned apps: each signing step has a secret-free twin selected by the same release-gated flag.
  for (const [name, flag] of [['desktop-macos', 'HAS_APPLE_SIGNING'], ['desktop-windows', 'HAS_WINDOWS_CERT'], ['android', 'HAS_ANDROID_KEYSTORE']] as const) {
    const j = jobs.find(x => x.name === name)!;
    assert.ok(j.steps.some(st => st.includes(`if: env.${flag} != 'true'`) && !st.includes('secrets.')), `${name} has an unsigned path`);
  }
  const play = jobs.find(x => x.name === 'play')!;
  assert.match(play.header, /\n {4}needs: \[verify, assemble\]\n/);
  assert.match(play.job, /name: release-bundle/);
  assert.match(play.job, /sha256sum -c -/);
  assert.doesNotMatch(jobs.find(x => x.name === 'assemble')!.header, /play/);
  assert.equal(jobs.find(x => x.name === 'verify')!.job.includes('secrets.'), false);
});
