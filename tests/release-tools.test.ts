// Release tooling (REL-01/REL-02): version sync and tag rules, Ed25519 signing, deterministic game bundle, channel
// file builder, Play upload client and the release workflow's static rules. No network, no real keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkTag, checkVersion, compareVersions, isOnMain, parseVersion, releaseChannel, syncVersion, TARGETS, versionCode, versionInfo,
} from '../tools/release/version.mjs';
import { checkPinnedKey, checkReleaseTrust, devPrivateKey, pinnedKeys, privateKey, publicKeyBase64, signBytes, verifyBytes } from '../tools/release/sign.mjs';
import { crc32, createZip, readZip } from '../tools/release/zip.mjs';
import { packageGame } from '../tools/release/package-game.mjs';
import { buildChannel, checkPublished, coordinatorSchema, squirrelFeed, writeRelease } from '../tools/release/channel.mjs';
import { NAMES, readBuildInfo, writeBuildInfo } from '../tools/release/assets.mjs';
import { serviceAccountAssertion, uploadBundle } from '../tools/release/play-upload.mjs';
import { checkFeed, nugetVersion, nupkgName, parseReleases, SQUIRREL_ID } from '../tools/release/package-windows-installer.mjs';
import { createHash } from 'node:crypto';
import { RELEASE_PUBLIC_KEY } from '../src/shared/release-key';
import { DEV_RELEASE_PUBLIC_KEY } from '../tools/release/dev-key.mjs';
import { devKeyFiles } from '../tools/check-no-fixture.mjs';

/** The owner's release key (REL-07, pinned 2026-10-08). */
const OWNER_KEY = 'rIRaOVUyoolaIritW/W8zMW7kGymgcjvg7uXhHtTqPk=';

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
  // Plus the per-build trust sources the gate inspects (REL-07).
  const trust = ['src/client/update/trust.ts', 'desktop/main.cjs', 'mobile/android/app/src/release/java/com/agentempire/mobile/DevTrust.java',
    'mobile/android/app/src/debug/java/com/agentempire/mobile/DevTrust.java', 'mobile/android/app/src/main/java/com/agentempire/mobile/GameUpdater.java', 'mobile/ios/AgentEmpire/GameUpdater.swift'];
  for (const file of new Set(['src/shared/release-key.ts', 'tools/release/dev-release-public-key.txt', 'tools/release/config.json', 'src/cloud/schema.ts', ...pinned, ...trust])) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  return root;
}

/** What the owner does by hand when rotating: swap the release key (never the dev one) in every pinned shell file. */
function pinInShells(root: string, from: string, to: string) {
  const pinned: string[] = JSON.parse(readFileSync(path.join(root, 'tools/release/config.json'), 'utf8')).pinnedKeyFiles ?? [];
  for (const file of pinned.filter((f) => f !== 'src/shared/release-key.ts')) {
    const full = path.join(root, file);
    writeFileSync(full, readFileSync(full, 'utf8').split(from).join(to));
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

test('the owner key is pinned everywhere, development trust is development-only, and the release gate passes', () => {
  assert.equal(DEV_RELEASE_PUBLIC_KEY, publicKeyBase64(devPrivateKey()));
  assert.equal(RELEASE_PUBLIC_KEY, OWNER_KEY);
  assert.notEqual(RELEASE_PUBLIC_KEY, DEV_RELEASE_PUBLIC_KEY);
  assert.deepEqual(pinnedKeys(ROOT), { release: OWNER_KEY, dev: DEV_RELEASE_PUBLIC_KEY });
  assert.deepEqual(checkPinnedKey({ root: ROOT }), []);
  assert.deepEqual(checkReleaseTrust(ROOT), []);
  // A signing key that is not the owner's (e.g. the dev key) is refused.
  assert.match(checkPinnedKey({ root: ROOT, signingKey: devPrivateKey() }).join('\n'), /is not the pinned RELEASE_PUBLIC_KEY/);
});

test('release gate: refuses the dev key as release key, an unpinned shell, and any release build that would trust the dev key', () => {
  const fresh = () => { const r = fixtureRoot(); assert.deepEqual(checkPinnedKey({ root: r }), []); return r; };
  const edit = (root: string, file: string, fn: (t: string) => string) => writeFileSync(path.join(root, file), fn(readFileSync(path.join(root, file), 'utf8')));
  const KEYFILE = 'src/shared/release-key.ts';

  // The development key as RELEASE_PUBLIC_KEY.
  let root = fresh();
  edit(root, KEYFILE, (t) => t.replace(`export const RELEASE_PUBLIC_KEY = '${OWNER_KEY}';`, `export const RELEASE_PUBLIC_KEY = '${DEV_RELEASE_PUBLIC_KEY}';`));
  assert.match(checkPinnedKey({ root }).join('\n'), /still the development key/);

  // A rotated key: refused until every shell pins it too.
  root = fresh();
  const { privateKey: owner } = generateKeyPairSync('ed25519');
  const ownerPem = owner.export({ format: 'pem', type: 'pkcs8' }).toString();
  const ownerPub = publicKeyBase64(owner);
  edit(root, KEYFILE, (t) => t.replace(`export const RELEASE_PUBLIC_KEY = '${OWNER_KEY}';`, `export const RELEASE_PUBLIC_KEY = '${ownerPub}';`));
  assert.match(checkPinnedKey({ root, signingKey: ownerPem }).join('\n'), /does not pin RELEASE_PUBLIC_KEY/);
  pinInShells(root, OWNER_KEY, ownerPub);
  assert.deepEqual(checkPinnedKey({ root, signingKey: ownerPem }), []);
  const other = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.match(checkPinnedKey({ root, signingKey: other }).join('\n'), /is not the pinned RELEASE_PUBLIC_KEY/);
  // A shell file listed in pinnedKeyFiles must carry the same key.
  const configFile = path.join(root, 'tools/release/config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, pinnedKeyFiles: [...config.pinnedKeyFiles, 'desktop/release-key.cjs'] }));
  assert.match(checkPinnedKey({ root }).join('\n'), /desktop\/release-key\.cjs: missing/);
  writeFileSync(path.join(root, 'desktop/release-key.cjs'), `module.exports = '${OWNER_KEY}';\n`);
  assert.match(checkPinnedKey({ root }).join('\n'), /desktop\/release-key\.cjs: does not pin/);
  writeFileSync(path.join(root, 'desktop/release-key.cjs'), `module.exports = '${ownerPub}';\n`);
  assert.deepEqual(checkPinnedKey({ root }), []);

  // Release builds that would trust the development key.
  const ANDROID_MAIN = 'mobile/android/app/src/main/java/com/agentempire/mobile/UpdatePolicy.java';
  const ANDROID_RELEASE = 'mobile/android/app/src/release/java/com/agentempire/mobile/DevTrust.java';
  const IOS = 'mobile/ios/AgentEmpire/UpdatePolicy.swift';
  const cases: [string, (r: string) => void, RegExp][] = [
    ['Android main source', (r) => edit(r, ANDROID_MAIN, (t) => t.replace('DevTrust.DEV_RELEASE_PUBLIC_KEY;', `"${DEV_RELEASE_PUBLIC_KEY}";`)), /UpdatePolicy\.java: a release build would trust/],
    ['Android release variant', (r) => edit(r, ANDROID_RELEASE, (t) => t.replace('= null;', `= "${DEV_RELEASE_PUBLIC_KEY}";`)), /DevTrust\.java: a release build would trust/],
    ['Android release variant missing', (r) => rmSync(path.join(r, ANDROID_RELEASE)), /must declare no development key/],
    ['iOS outside #if DEBUG', (r) => edit(r, IOS, (t) => t.replace('static let devReleasePublicKey: String? = nil', `static let devReleasePublicKey: String? = "${DEV_RELEASE_PUBLIC_KEY}"`)), /UpdatePolicy\.swift:\d+: the development key outside #if DEBUG/],
    ['desktop shell source', (r) => edit(r, 'desktop/update-store.cjs', (t) => `${t}\nconst DEV = '${DEV_RELEASE_PUBLIC_KEY}';\n`), /update-store\.cjs: a release build would trust/],
    ['desktop dev-trust.json', (r) => writeFileSync(path.join(r, 'desktop/dev-trust.json'), JSON.stringify({ devReleasePublicKey: DEV_RELEASE_PUBLIC_KEY })), /dev-trust\.json exists/],
    ['web client source', (r) => edit(r, 'src/client/update/trust.ts', (t) => `${t}\nexport const DEV = '${DEV_RELEASE_PUBLIC_KEY}';\n`), /trust\.ts: a release build would trust/],
    // src/shared compiles into dist/server, which ships in the desktop app (review finding: release-key.ts carried it).
    ['shared source (shipped in dist/server)', (r) => edit(r, KEYFILE, (t) => `${t}export const DEV_RELEASE_PUBLIC_KEY = '${DEV_RELEASE_PUBLIC_KEY}';\n`), /release-key\.ts: a release build would trust/],
  ];
  for (const [name, breakIt, expected] of cases) {
    const r = fresh();
    breakIt(r);
    assert.match(checkPinnedKey({ root: r }).join('\n'), expected, name);
  }
});

test('desktop release layout (shell files + runtime/server + runtime/public) carries no development key', () => {
  // What prepare-desktop.mjs stages and electron-packager ships (resources/app): every source tsconfig.server.json compiles
  // into dist/server, the shell files, and the built game when present. This would have caught release-key.ts.
  const app = temp('desktop-app');
  for (const name of readdirSync(path.join(ROOT, 'desktop'))) if (/\.(cjs|js|html|css|json)$/.test(name) && name !== 'package-lock.json') copyFileSync(path.join(ROOT, 'desktop', name), path.join(app, name));
  const server: { include: string[] } = JSON.parse(readFileSync(path.join(ROOT, 'tsconfig.server.json'), 'utf8'));
  for (const glob of server.include) {
    const dir = glob.split('/**')[0];
    cpSync(path.join(ROOT, dir), path.join(app, 'runtime/server', path.relative('src', dir)), { recursive: true });
  }
  // Built output is not copied here: a stale dist/ from an older checkout made this test fail or pass depending on what
  // was built last. `npm run build` scans its own fresh dist/server and dist/public instead (package.json build:server).
  assert.deepEqual(devKeyFiles(app), []);
  assert.match(execFileSync('node', [path.join(ROOT, 'tools/release/sign.mjs'), 'check-trust', app]).toString(), /no development key trust/);
  // A development desktop build is caught.
  writeFileSync(path.join(app, 'dev-trust.json'), JSON.stringify({ devReleasePublicKey: DEV_RELEASE_PUBLIC_KEY }));
  assert.throws(() => execFileSync('node', [path.join(ROOT, 'tools/release/sign.mjs'), 'check-trust', app], { stdio: 'pipe' }));
});

test('release workflow: every run checks release trust; packaged apps, the iOS archive and the APK/AAB are scanned (REL-07)', () => {
  const wf = readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  assert.match(wf, /if: steps\.info\.outputs\.release != 'true'\n\s+run: node tools\/release\/sign\.mjs check-key --allow-dev/);
  assert.match(wf, /check-trust release\/macos\/\*\/"Agent Empire\.app"\/Contents\/Resources\/app/);
  assert.match(wf, /check-trust "\$APP_DIR\/resources\/app"/);
  assert.match(wf, /check-trust "\$RUNNER_TEMP\/ios-sim\/Release-iphonesimulator\/AgentEmpire\.app"/);
  assert.match(wf, /check-trust "\$RUNNER_TEMP\/AgentEmpire\.xcarchive\/Products"/);
  assert.doesNotMatch(wf, /prepare-desktop\.mjs[^\n]*--dev-updates/);
  const android = readFileSync(path.join(ROOT, 'mobile/tools/build-android.py'), 'utf8');
  assert.match(android, /release AAB development-key check/);
  assert.match(android, /APK development-key check/);
});

test('check-trust: built outputs carrying the development key or dev-trust.json are development builds', () => {
  const dir = temp('trust');
  writeFileSync(path.join(dir, 'app.js'), `const k = '${OWNER_KEY}';`);
  assert.deepEqual(devKeyFiles(dir), []);
  mkdirSync(path.join(dir, 'nested'));
  writeFileSync(path.join(dir, 'nested/blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(DEV_RELEASE_PUBLIC_KEY), Buffer.from([3])]));
  assert.deepEqual(devKeyFiles(dir), [path.join('nested', 'blob.bin')]);
  writeFileSync(path.join(dir, 'dev-trust.json'), '{}');
  assert.equal(devKeyFiles(dir).length, 2);
  assert.throws(() => execFileSync('node', [path.join(ROOT, 'tools/release/sign.mjs'), 'check-trust', dir], { stdio: 'pipe' }));
  const clean = temp('trust-clean');
  writeFileSync(path.join(clean, 'index.html'), '<p>release</p>');
  assert.match(execFileSync('node', [path.join(ROOT, 'tools/release/sign.mjs'), 'check-trust', clean]).toString(), /no development key trust/);
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
  const a = packageGame({ dist, outDir: temp('outa'), manifestDir: temp('infoa'), version: '1.0.0-beta.1', commit: COMMIT, minShell: '1.0.0-beta.1' });
  // Different timestamps and a different copy must not change a single byte.
  const copy = temp('dist2');
  cpSync(dist, copy, { recursive: true });
  utimesSync(path.join(copy, 'index.html'), new Date(2001, 1, 1), new Date(2001, 1, 1));
  const b = packageGame({ dist: copy, outDir: temp('outb'), manifestDir: temp('infob'), version: '1.0.0-beta.1', commit: COMMIT, minShell: '1.0.0-beta.1' });
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
  const c = packageGame({ dist: changed, outDir: temp('outc'), manifestDir: temp('infoc'), version: '1.0.0-beta.1', commit: COMMIT, minShell: '1.0.0-beta.1' });
  assert.notEqual(c.manifest.sha256, a.manifest.sha256);
});

test('the game bundle refuses fixture builds, missing pages and bad inputs', () => {
  const dist = fakeDist();
  const ok = { dist, outDir: temp('out'), manifestDir: temp('info'), version: '1.0.0-beta.1', commit: COMMIT, minShell: '1.0.0-beta.1' };
  // The manifest is never staged with the publishable files: its folder is explicit and must differ from outDir.
  assert.throws(() => packageGame({ ...ok, manifestDir: undefined }), /manifestDir/);
  assert.throws(() => packageGame({ ...ok, manifestDir: ok.outDir }), /manifestDir/);
  assert.throws(() => packageGame({ ...ok, commit: 'abc' }), /40-character/);
  assert.throws(() => packageGame({ ...ok, version: '1.0' }), /Invalid version/);
  assert.throws(() => packageGame({ ...ok, dist: temp('empty') }), /index\.html is missing/);
  writeFileSync(path.join(dist, 'assets/fixture.js'), 'window.__AGENT_EMPIRE_FIXTURE_BUILD__ = 1');
  assert.throws(() => packageGame(ok), /fixture build/);
});

const V = '1.0.0-beta.2';
const CONFIG = { playListing: 'https://play.google.com/store/apps/details?id=com.agentempire.mobile', iosTestFlight: null, iosAppStore: null };
const REPO = 'Billioncodes001/agent-empire';
const DOWNLOAD = `https://github.com/${REPO}/releases/download/v${V}/`;
/** The path segment every shipped reader (beta.1 client, desktop, Android, iOS) accepts in a release asset URL. */
const SEGMENT = /^[A-Za-z0-9._+-]{1,128}$/;

interface Stage { version?: string; mac?: Partial<Record<'arm64' | 'x64', boolean>>; windows?: boolean; android?: boolean }
/**
 * A staged release as the workflow's assemble job sees it: release/assets (files that may be published) and
 * release/build-info (each platform's signing state and the game manifest; never published).
 */
function stage({ version = V, mac = {}, windows, android }: Stage = {}): { assets: string; info: string } {
  const assets = temp('assets');
  const info = temp('info');
  packageGame({ dist: fakeDist(), outDir: assets, manifestDir: info, version, commit: COMMIT, minShell: '1.0.0-beta.1' });
  writeFileSync(path.join(assets, NAMES.coordinator), 'export const runCoordinatorTick = 1;');
  for (const [arch, signed] of Object.entries(mac) as Array<['arm64' | 'x64', boolean]>) {
    writeFileSync(path.join(assets, NAMES.macDmg(arch)), `dmg ${arch}`);
    if (signed) writeFileSync(path.join(assets, NAMES.macZip(arch)), `zip ${arch}`);
    writeBuildInfo(info, { platform: 'macos', arch, signed });
  }
  if (windows !== undefined) {
    writeFileSync(path.join(assets, NAMES.windowsSetup), 'setup');
    if (windows) {
      const pkg = Buffer.from('nupkg bytes');
      writeFileSync(path.join(assets, nupkgName(version)), pkg);
      writeFileSync(path.join(assets, 'RELEASES'), `${createHash('sha1').update(pkg).digest('hex').toUpperCase()} ${nupkgName(version)} ${pkg.length}\r\n`);
    }
    writeBuildInfo(info, { platform: 'windows', arch: 'x64', signed: windows });
  }
  if (android !== undefined) {
    writeFileSync(path.join(assets, NAMES.androidApk), 'apk');
    writeBuildInfo(info, { platform: 'android', signed: android });
  }
  return { assets, info };
}
const releaseArgs = (s: { assets: string; info: string }, extra: Record<string, unknown> = {}) => ({
  assetsDir: s.assets, infoDir: s.info, version: V, repo: REPO, publishedAt: '2026-10-26T12:00:00.000Z', notes: 'Notes', config: CONFIG, root: ROOT, ...extra,
});
const channelArgs = (s: { assets: string; info: string }, extra: Record<string, unknown> = {}) => ({ ...releaseArgs(s), channel: 'beta', ...extra });
/** Writes the channel files and feeds, signs them with the development key, and returns the folder listing. */
function publish(s: { assets: string; info: string }, extra: Record<string, unknown> = {}): string[] {
  writeRelease(releaseArgs(s, extra));
  for (const name of readdirSync(s.assets).filter(n => /^channel-\w+\.json$/.test(n)))
    writeFileSync(path.join(s.assets, `${name}.sig`), signBytes(readFileSync(path.join(s.assets, name)), devPrivateKey()) + '\n');
  return readdirSync(s.assets).sort();
}
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

test('asset names: plain words for the files people download, version-free so latest/download links stay stable', () => {
  assert.equal(NAMES.macDmg('arm64'), 'Agent-Empire-Mac-Apple-Silicon.dmg');
  assert.equal(NAMES.macDmg('x64'), 'Agent-Empire-Mac-Intel.dmg');
  assert.equal(NAMES.windowsSetup, 'Agent-Empire-Windows-Setup.exe');
  assert.equal(NAMES.androidApk, 'Agent-Empire-Android.apk');
  assert.equal(NAMES.macZip('arm64'), 'Agent-Empire-Mac-Apple-Silicon-Update.zip');
  assert.equal(NAMES.macFeed('x64'), 'RELEASES-darwin-x64.json');
  // Machine files keep the names installed beta.1 apps look for.
  assert.equal(NAMES.coordinator, 'agent-empire-coordinator.mjs');
  assert.equal(NAMES.channel('beta'), 'channel-beta.json');
  assert.equal(nupkgName(V), 'AgentEmpire-1.0.0-beta002-full.nupkg');
  const people = [NAMES.macDmg('arm64'), NAMES.macDmg('x64'), NAMES.windowsSetup, NAMES.androidApk];
  for (const name of people) assert.doesNotMatch(name, /unsigned|debug|x64|arm64|\d/i, name);
  const all = [...people, NAMES.macZip('arm64'), NAMES.macZip('x64'), NAMES.macFeed('arm64'), NAMES.macFeed('x64'), NAMES.coordinator, NAMES.game(V), nupkgName(V), 'RELEASES', NAMES.channel('beta'), NAMES.channel('stable')];
  assert.equal(new Set(all.map(n => n.toLowerCase())).size, all.length, 'names are unique (case-insensitively)');
  for (const name of all) assert.match(name, SEGMENT, `${name} must be a URL path segment every shipped reader accepts`);
});

test('build info records each platform build and refuses anything ambiguous', () => {
  const info = temp('info');
  writeBuildInfo(info, { platform: 'macos', arch: 'arm64', signed: false });
  writeBuildInfo(info, { platform: 'windows', arch: 'x64', signed: true });
  writeBuildInfo(info, { platform: 'android', signed: true });
  assert.deepEqual(readBuildInfo(info), { macos: { arm64: { signed: false } }, windows: { signed: true }, android: { signed: true } });
  assert.throws(() => writeBuildInfo(info, { platform: 'macos', signed: true } as never), /arch/);
  assert.throws(() => writeBuildInfo(info, { platform: 'linux', signed: true } as never), /platform/);
  assert.throws(() => writeBuildInfo(info, { platform: 'android', signed: 'yes' } as never), /signed/);
  writeFileSync(path.join(info, 'android.json'), '{"platform":"android","signed":"maybe"}');
  assert.throws(() => readBuildInfo(info), /signed/);
  assert.deepEqual(readBuildInfo(temp('empty')), {});
});

test('unsigned beta: only the DMGs, the installer, the APK and the files installed apps read are published', () => {
  const s = stage({ mac: { arm64: false, x64: false }, windows: false, android: true });
  const listing = publish(s);
  assert.deepEqual(listing, [
    'Agent-Empire-Android.apk', 'Agent-Empire-Mac-Apple-Silicon.dmg', 'Agent-Empire-Mac-Intel.dmg', 'Agent-Empire-Windows-Setup.exe',
    'agent-empire-coordinator.mjs', `agent-empire-game-${V}.zip`, 'channel-beta.json', 'channel-beta.json.sig',
  ]);
  assert.deepEqual(checkPublished(s.assets), []);
  const doc = readJson(path.join(s.assets, 'channel-beta.json'));
  assert.deepEqual(Object.keys(doc), ['schema', 'channel', 'version', 'tag', 'publishedAt', 'notes', 'releasePage', 'game', 'shell', 'coordinator', 'assets', 'mandatory']);
  assert.equal(doc.publishedAt, '2026-10-26T12:00:00Z');
  assert.deepEqual(Object.keys(doc.game), ['url', 'sha256', 'bytes', 'minShell', 'commit']);
  assert.equal(doc.game.url, `${DOWNLOAD}agent-empire-game-${V}.zip`);
  assert.equal(doc.game.commit, COMMIT);
  assert.equal(doc.shell.macos.auto, false);
  assert.equal(doc.shell.macos.feed, null);
  assert.deepEqual(Object.keys(doc.shell.macos.downloads.arm64), ['dmg', 'signed']);
  assert.equal(doc.shell.macos.downloads.arm64.dmg.url, `${DOWNLOAD}Agent-Empire-Mac-Apple-Silicon.dmg`);
  assert.equal(doc.shell.macos.downloads.x64.signed, false);
  assert.equal(doc.shell.windows.auto, false);
  assert.equal(doc.shell.windows.feed, null);
  assert.deepEqual(Object.keys(doc.shell.windows.downloads.x64), ['setup', 'signed']);
  assert.equal(doc.shell.android.url, `${DOWNLOAD}Agent-Empire-Android.apk`);
  assert.equal(doc.shell.android.signed, true);
  assert.equal(doc.shell.android.versionCode, 10000302);
  assert.equal(doc.shell.android.play, null);
  assert.deepEqual(doc.shell.ios, { version: V, testflight: null, appStore: null });
  assert.equal(doc.coordinator.url, `${DOWNLOAD}agent-empire-coordinator.mjs`);
  assert.equal(doc.coordinator.schema, coordinatorSchema(ROOT));
  // The signed checksum list replaces SHA256SUMS: every published file except the channel files themselves.
  assert.deepEqual(Object.keys(doc.assets).sort(), listing.filter(n => !n.startsWith('channel-')));
  for (const [name, entry] of Object.entries(doc.assets) as Array<[string, { sha256: string; bytes: number }]>) {
    const bytes = readFileSync(path.join(s.assets, name));
    assert.deepEqual(entry, { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, name);
  }
  assert.equal(doc.mandatory, false);
  assert.deepEqual(buildChannel(channelArgs(s)), doc, 'deterministic for the same inputs');
});

test('signed desktop builds add exactly the update payloads and feeds the updaters read', () => {
  const s = stage({ mac: { arm64: true, x64: true }, windows: true, android: true });
  const listing = publish(s, { playPublished: true });
  assert.deepEqual(listing, [
    'Agent-Empire-Android.apk', 'Agent-Empire-Mac-Apple-Silicon-Update.zip', 'Agent-Empire-Mac-Apple-Silicon.dmg', 'Agent-Empire-Mac-Intel-Update.zip',
    'Agent-Empire-Mac-Intel.dmg', 'Agent-Empire-Windows-Setup.exe', nupkgName(V), 'RELEASES', 'RELEASES-darwin-arm64.json', 'RELEASES-darwin-x64.json',
    'agent-empire-coordinator.mjs', `agent-empire-game-${V}.zip`, 'channel-beta.json', 'channel-beta.json.sig',
  ]);
  assert.deepEqual(checkPublished(s.assets), []);
  const doc = readJson(path.join(s.assets, 'channel-beta.json'));
  assert.equal(doc.shell.macos.auto, true);
  assert.equal(doc.shell.macos.feed.arm64, `${DOWNLOAD}RELEASES-darwin-arm64.json`);
  assert.equal(doc.shell.macos.downloads.arm64.zip.url, `${DOWNLOAD}Agent-Empire-Mac-Apple-Silicon-Update.zip`);
  const feed = readJson(path.join(s.assets, 'RELEASES-darwin-arm64.json'));
  assert.deepEqual(feed, squirrelFeed({ version: V, url: doc.shell.macos.downloads.arm64.zip.url, notes: 'Notes', publishedAt: doc.publishedAt }));
  assert.equal(doc.assets['RELEASES-darwin-arm64.json'].sha256, createHash('sha256').update(readFileSync(path.join(s.assets, 'RELEASES-darwin-arm64.json'))).digest('hex'));
  assert.equal(doc.shell.windows.auto, true);
  assert.equal(doc.shell.windows.feed, `https://github.com/${REPO}/releases/download/v${V}`);
  assert.equal(doc.shell.windows.downloads.x64.nupkg.url, `${DOWNLOAD}${nupkgName(V)}`);
  assert.equal(doc.shell.android.play, CONFIG.playListing);
});

test('a final release writes both channels; stable feeds follow latest/download, beta feeds the tag', () => {
  const S = '1.0.0';
  const s = stage({ version: S, mac: { arm64: true }, windows: true, android: true });
  const listing = publish(s, { version: S });
  assert.ok(listing.includes('channel-stable.json') && listing.includes('channel-stable.json.sig') && listing.includes('channel-beta.json.sig'));
  assert.deepEqual(checkPublished(s.assets), []);
  const stable = readJson(path.join(s.assets, 'channel-stable.json'));
  const beta = readJson(path.join(s.assets, 'channel-beta.json'));
  const repo = `https://github.com/${REPO}/releases`;
  assert.equal(stable.shell.windows.feed, `${repo}/latest/download`);
  assert.equal(beta.shell.windows.feed, `${repo}/download/v${S}`);
  assert.equal(stable.shell.macos.feed.arm64, `${repo}/latest/download/RELEASES-darwin-arm64.json`);
  assert.equal(beta.shell.macos.feed.arm64, `${repo}/download/v${S}/RELEASES-darwin-arm64.json`);
  assert.equal(stable.shell.windows.downloads.x64.nupkg.url, `${repo}/download/v${S}/AgentEmpire-1.0.0-full.nupkg`);
  assert.deepEqual(stable.assets, beta.assets);
});

test('the channel builder refuses a staging folder that would publish the wrong files', () => {
  const ok = () => stage({ mac: { arm64: false }, windows: false, android: true });
  // An unsigned macOS zip or Windows feed has no reader: refuse rather than publish it.
  const macZip = ok(); writeFileSync(path.join(macZip.assets, NAMES.macZip('arm64')), 'zip');
  assert.throws(() => buildChannel(channelArgs(macZip)), /no updater reads it/);
  const winFeed = ok(); writeFileSync(path.join(winFeed.assets, nupkgName(V)), 'pkg');
  assert.throws(() => buildChannel(channelArgs(winFeed)), /no updater reads it/);
  // A signed build must carry its update payload.
  const signedNoZip = stage({ mac: { arm64: true } });
  execFileSync('rm', [path.join(signedNoZip.assets, NAMES.macZip('arm64'))]);
  assert.throws(() => buildChannel(channelArgs(signedNoZip)), /Agent-Empire-Mac-Apple-Silicon-Update\.zip is missing/);
  const signedNoFeed = stage({ windows: true });
  execFileSync('rm', [path.join(signedNoFeed.assets, 'RELEASES')]);
  assert.throws(() => buildChannel(channelArgs(signedNoFeed)), /RELEASES is missing/);
  // A platform file without its build info (signing state unknown), or build info without the file.
  const noInfo = ok(); writeFileSync(path.join(noInfo.assets, NAMES.macDmg('x64')), 'dmg');
  assert.throws(() => buildChannel(channelArgs(noInfo)), /Agent-Empire-Mac-Intel\.dmg has no build info/);
  const noFile = ok(); execFileSync('rm', [path.join(noFile.assets, NAMES.androidApk)]);
  assert.throws(() => buildChannel(channelArgs(noFile)), /Agent-Empire-Android\.apk is missing/);
  // Anything unplanned (an old-style name, a stray file, SHA256SUMS) is never published.
  for (const stray of [`Agent-Empire-${V}-windows-x64-unsigned.zip`, 'SHA256SUMS', 'game-manifest.json', `Agent-Empire-${V}-android.aab`]) {
    const s = ok(); writeFileSync(path.join(s.assets, stray), 'x');
    assert.throws(() => buildChannel(channelArgs(s)), new RegExp(`${stray.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not a release asset`));
  }
  const base = ok();
  assert.throws(() => buildChannel(channelArgs(base, { channel: 'stable' })), /prerelease/);
  assert.throws(() => buildChannel(channelArgs(base, { channel: 'nightly' })), /Unknown channel/);
  assert.throws(() => buildChannel(channelArgs(base, { repo: 'https://evil.example/x' })), /owner\/name/);
  assert.throws(() => buildChannel(channelArgs(base, { version: '1.0.0-beta.3' })), /agent-empire-game-1\.0\.0-beta\.3\.zip/);
  const swapped = ok(); writeFileSync(path.join(swapped.assets, NAMES.game(V)), 'swapped');
  assert.throws(() => buildChannel(channelArgs(swapped)), /does not describe/);
  const noCoordinator = ok(); execFileSync('rm', [path.join(noCoordinator.assets, NAMES.coordinator)]);
  assert.throws(() => buildChannel(channelArgs(noCoordinator)), /agent-empire-coordinator\.mjs/);
});

test('checkPublished: the folder holds exactly the files the signed channel lists, byte for byte', () => {
  const extra = stage({ android: true }); publish(extra);
  writeFileSync(path.join(extra.assets, 'SHA256SUMS'), 'x');
  assert.match(checkPublished(extra.assets).join('\n'), /SHA256SUMS is not listed in channel-beta\.json/);
  const missing = stage({ android: true }); publish(missing);
  execFileSync('rm', [path.join(missing.assets, NAMES.androidApk)]);
  assert.match(checkPublished(missing.assets).join('\n'), /Agent-Empire-Android\.apk is listed in channel-beta\.json but missing/);
  const tampered = stage({ android: true }); publish(tampered);
  writeFileSync(path.join(tampered.assets, NAMES.androidApk), 'other apk');
  assert.match(checkPublished(tampered.assets).join('\n'), /Agent-Empire-Android\.apk does not match its sha256/);
  const unsigned = stage({ android: true }); publish(unsigned);
  execFileSync('rm', [path.join(unsigned.assets, 'channel-beta.json.sig')]);
  assert.match(checkPublished(unsigned.assets).join('\n'), /channel-beta\.json\.sig is missing/);
  assert.match(checkPublished(temp('none')).join('\n'), /channel-beta\.json is missing/);
});

test('writeRelease refuses channel files, signatures and feeds that arrive with the platform artifacts', () => {
  // release.yml signs every channel-*.json in release/assets with the production key: only writeRelease may create them.
  for (const stray of ['channel-beta.json', 'channel-stable.json', 'channel-beta.json.sig', 'game-manifest.json.sig', 'RELEASES-darwin-arm64.json']) {
    const s = stage({ mac: { arm64: true }, android: true });
    writeFileSync(path.join(s.assets, stray), '{}');
    assert.throws(() => writeRelease(releaseArgs(s)), new RegExp(`${stray.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} arrived with the build artifacts`), stray);
    assert.ok(!readdirSync(s.assets).includes('channel-beta.json') || stray === 'channel-beta.json', `${stray}: nothing was written`);
  }
});

test('macOS: no feed unless every macOS build is signed; mixed signing is refused', () => {
  const mixed = stage({ mac: { arm64: true, x64: false } });
  assert.throws(() => writeRelease(releaseArgs(mixed)), /macOS builds disagree on signing/);
  assert.ok(!readdirSync(mixed.assets).some(n => n.startsWith('RELEASES-darwin')));
  const unsigned = stage({ mac: { arm64: false, x64: false } });
  publish(unsigned);
  assert.ok(!readdirSync(unsigned.assets).some(n => n.startsWith('RELEASES-darwin')), 'auto: false publishes no feed');
  assert.equal(readJson(path.join(unsigned.assets, 'channel-beta.json')).shell.macos.auto, false);
});

test('the game manifest must give the real size of the zip', () => {
  const s = stage({ android: true });
  const manifestPath = path.join(s.info, 'game-manifest.json');
  const manifest = readJson(manifestPath);
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, bytes: manifest.bytes + 1 }));
  assert.throws(() => buildChannel(channelArgs(s)), /does not describe/);
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
  const W = '1.0.0-beta.1';
  const dir = temp('feed');
  const pkg = Buffer.from('nupkg bytes');
  writeFileSync(path.join(dir, nupkgName(W)), pkg);
  const sha1 = createHash('sha1').update(pkg).digest('hex').toUpperCase();
  writeFileSync(path.join(dir, 'RELEASES'), `\uFEFF${sha1} ${nupkgName(W)} ${pkg.length}\r\n`);
  assert.deepEqual(parseReleases(readFileSync(path.join(dir, 'RELEASES'), 'utf8')), [{ sha1, file: nupkgName(W), size: pkg.length }]);
  assert.deepEqual(checkFeed(dir, W), []);
  assert.match(checkFeed(dir, '1.0.0-beta.2').join('\n'), /should list only AgentEmpire-1\.0\.0-beta002-full\.nupkg/);
  writeFileSync(path.join(dir, nupkgName(W)), 'tampered!!!');
  assert.match(checkFeed(dir, W).join('\n'), /SHA1 does not match/);
  assert.deepEqual(checkFeed(temp('nofeed'), W), ['RELEASES is missing']);
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
  assert.deepEqual(jobs.filter(j => j.job.includes('secrets.')).map(j => j.name), ['desktop-macos', 'desktop-windows', 'android', 'ios', 'assemble', 'play']);
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
  // The channel files are the only signed release files (the game manifest is no longer published).
  assert.doesNotMatch(jobs.find(x => x.name === 'game')!.job, /sign\.mjs sign|secrets\./);
  for (const name of ['assemble']) {
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
  // The App Bundle is never a release asset: Play takes it from its own workflow artifact, checked against its sha256.
  assert.match(play.job, /name: play-bundle/);
  assert.match(play.job, /sha256sum -c Agent-Empire-Android\.aab\.sha256/);
  assert.doesNotMatch(play.job, /release-bundle|SHA256SUMS/);
  assert.doesNotMatch(jobs.find(x => x.name === 'assemble')!.header, /play/);
  assert.equal(jobs.find(x => x.name === 'verify')!.job.includes('secrets.'), false);
});

test('release workflow: publishes the planned names only; signing state travels as build info, never in a file name', () => {
  const text = readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const jobs = workflowJobs();
  const job = (name: string) => jobs.find(j => j.name === name)!.job;
  for (const gone of [/SHA256SUMS/, /-unsigned\.(dmg|zip|exe|apk)|Setup-unsigned|\$LABEL/, /debug-signed\.apk/, /windows-x64/, /macos-(arm64|x64)/, /zip\.mjs "\$APP_DIR"/, /game-manifest\.json\.sig/, /--label/])
    assert.doesNotMatch(text, gone, String(gone));
  // Each platform job stages release/assets (publishable) and release/build-info (signing state, game manifest).
  for (const name of ['game', 'desktop-macos', 'desktop-windows', 'android']) {
    assert.match(job(name), /name: release-[\w${}. -]+\n {10}path: \|\n {12}release\/assets\n {12}release\/build-info\n/, name);
  }
  assert.match(job('game'), /package-game\.mjs --out release\/assets --manifest-dir release\/build-info/);
  assert.match(job('desktop-macos'), /package-macos\.mjs --out release\/assets --info release\/build-info/);
  assert.match(job('desktop-windows'), /package-windows-installer\.mjs --app "\$APP_DIR" --out release\/assets --info release\/build-info --signed "\${WINDOWS_SIGNED:-false}"/);
  assert.ok(job('desktop-windows').includes(`release\\assets\\${NAMES.windowsSetup}`), 'Azure signs the installer by its published name');
  assert.ok(job('android').includes(`"release/assets/${NAMES.androidApk}"`));
  assert.match(job('android'), /assets\.mjs build-info --out release\/build-info --platform android --signed "\$HAS_ANDROID_KEYSTORE"/);
  // The signed AAB goes to Play through its own artifact; it is never staged in release/assets.
  assert.ok(job('android').includes(`release/play/${NAMES.androidAab}`));
  assert.match(job('android'), /name: play-bundle/);
  assert.doesNotMatch(job('android'), /release\/assets\/[^\n]*\.aab/);
  // assemble builds the channel from both folders and proves the published folder is exactly what the channel lists.
  assert.match(job('assemble'), /pattern: release-\*\n {10}path: release\n {10}merge-multiple: true/);
  assert.match(job('assemble'), /channel\.mjs --assets release\/assets --info release\/build-info/);
  assert.match(job('assemble'), /channel\.mjs check-publish --assets release\/assets/);
  assert.match(job('publish'), /release\/assets\/\*/);
});
