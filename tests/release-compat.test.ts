// Installed v1.0.0-beta.1 apps must still detect, verify and install the next release after the asset clean-up
// (docs/team/reports/release-assets.md). The readers under tests/compat/beta1/ are frozen copies of the code tagged
// v1.0.0-beta.1 (client, desktop shell, Android and iOS policy); they are never edited. Each test builds a beta.2-style
// release with today's tools, serves only the files the workflow would publish from a fake GitHub, and runs the frozen
// readers against it. A reader that needed a removed file would get a 404 and fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packageGame } from '../tools/release/package-game.mjs';
import { checkPublished, writeRelease } from '../tools/release/channel.mjs';
import { NAMES, writeBuildInfo } from '../tools/release/assets.mjs';
import { nupkgName } from '../tools/release/package-windows-installer.mjs';
import { devPrivateKey, publicKeyBase64, signBytes, verifyBytes } from '../tools/release/sign.mjs';
// Frozen v1.0.0-beta.1 readers.
import { fetchChannel } from './compat/beta1/src/client/update/source';
import { newestPrereleaseTag, RELEASES_API, releaseAsset as clientReleaseAsset } from './compat/beta1/src/client/update/channel';
import { compareSemver } from './compat/beta1/src/client/update/semver';
import { decide } from './compat/beta1/src/client/update/decide';

const ROOT = path.resolve(import.meta.dirname, '..');
const BETA1 = path.join(ROOT, 'tests/compat/beta1');
const requireBeta1 = createRequire(path.join(BETA1, 'desktop/package.json'));
const desktopStore = requireBeta1('./update-store.cjs');
const desktopPolicy = requireBeta1('./bridge-policy.cjs');

const REPO = 'Billioncodes001/agent-empire';
const OLD = '1.0.0-beta.1';
const V = '1.0.0-beta.2';
const TAG = `v${V}`;
const COMMIT = 'b'.repeat(40);
/** Tests sign with the public development key; the frozen readers take the key to trust as a parameter. */
const KEY = publicKeyBase64(devPrivateKey());
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const temp = (name: string) => mkdtempSync(path.join(tmpdir(), `ae-compat-${name}-`));

/** The names v1.0.0-beta.1 published (its real asset list) and which ones the next release drops. */
const BETA1_ASSETS = [
  `Agent-Empire-${OLD}-android.aab`, `Agent-Empire-${OLD}-android.apk`, `Agent-Empire-${OLD}-macos-arm64-unsigned.dmg`, `Agent-Empire-${OLD}-macos-arm64-unsigned.zip`,
  `Agent-Empire-${OLD}-macos-x64-unsigned.dmg`, `Agent-Empire-${OLD}-macos-x64-unsigned.zip`, `Agent-Empire-${OLD}-windows-x64-Setup-unsigned.exe`, `Agent-Empire-${OLD}-windows-x64-unsigned.zip`,
  'AgentEmpire-1.0.0-beta001-full.nupkg', 'RELEASES', `agent-empire-game-${OLD}.zip`, 'agent-empire-coordinator.mjs', 'channel-beta.json', 'channel-beta.json.sig',
  'game-manifest.json', 'game-manifest.json.sig', 'SHA256SUMS',
];

function fakeDist(): string {
  const dist = temp('dist');
  execFileSync('mkdir', ['-p', path.join(dist, 'cloud')]);
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Agent Empire beta.2</title>');
  writeFileSync(path.join(dist, 'cloud/agent-empire-coordinator.mjs'), 'export const runCoordinatorTick = 2;');
  return dist;
}

/** Builds and dev-signs a beta.2 release the way the assemble job does; returns the published folder. */
function release({ signedDesktop }: { signedDesktop: boolean }): string {
  const assets = temp('assets');
  const info = temp('info');
  packageGame({ dist: fakeDist(), outDir: assets, manifestDir: info, version: V, commit: COMMIT, minShell: OLD });
  writeFileSync(path.join(assets, NAMES.coordinator), 'export const runCoordinatorTick = 2;');
  for (const arch of ['arm64', 'x64'] as const) {
    writeFileSync(path.join(assets, NAMES.macDmg(arch)), `dmg ${arch}`);
    if (signedDesktop) writeFileSync(path.join(assets, NAMES.macZip(arch)), `zip ${arch}`);
    writeBuildInfo(info, { platform: 'macos', arch, signed: signedDesktop });
  }
  writeFileSync(path.join(assets, NAMES.windowsSetup), 'setup');
  if (signedDesktop) {
    const pkg = Buffer.from('nupkg beta.2');
    writeFileSync(path.join(assets, nupkgName(V)), pkg);
    writeFileSync(path.join(assets, 'RELEASES'), `${createHash('sha1').update(pkg).digest('hex').toUpperCase()} ${nupkgName(V)} ${pkg.length}\r\n`);
  }
  writeBuildInfo(info, { platform: 'windows', arch: 'x64', signed: signedDesktop });
  writeFileSync(path.join(assets, NAMES.androidApk), 'apk beta.2');
  writeBuildInfo(info, { platform: 'android', signed: true });
  writeRelease({ assetsDir: assets, infoDir: info, version: V, repo: REPO, publishedAt: '2026-10-26T12:00:00Z', notes: 'beta.2', config: { playListing: null, iosTestFlight: null, iosAppStore: null } });
  for (const c of readdirSync(assets).filter((n) => /^channel-(stable|beta)\.json$/.test(n)))
    writeFileSync(path.join(assets, `${c}.sig`), signBytes(readFileSync(path.join(assets, c)), devPrivateKey()) + '\n');
  assert.deepEqual(checkPublished(assets), []);
  return assets;
}

/** GitHub as installed apps see it: beta.1 (its real asset names) and the new pre-release, served from `dir`. */
function fakeGitHub(dir: string, { latest = false }: { latest?: boolean } = {}) {
  const published = readdirSync(dir).sort();
  const requested: string[] = [];
  // `latest`: GitHub's "latest release" (never a pre-release) is this release, so .../releases/latest/download/<file> serves it.
  const listing = JSON.stringify([
    { tag_name: TAG, prerelease: !latest, draft: false, assets: published.map(name => ({ name })) },
    { tag_name: `v${OLD}`, prerelease: true, draft: false, assets: BETA1_ASSETS.map(name => ({ name })) },
  ]);
  const prefix = `https://github.com/${REPO}/releases/download/${TAG}/`;
  const latestPrefix = `https://github.com/${REPO}/releases/latest/download/`;
  const bytes = (url: string): Buffer | null => {
    requested.push(url);
    const from = url.startsWith(prefix) ? prefix : latest && url.startsWith(latestPrefix) ? latestPrefix : null;
    if (!from) return null;
    const name = decodeURIComponent(url.slice(from.length));
    return published.includes(name) ? readFileSync(path.join(dir, name)) : null;
  };
  return {
    published,
    requested,
    /** The client's fetcher (src/client/update/bridge.ts FetchResult). */
    client: async (url: string) => {
      if (url === RELEASES_API) { requested.push(url); return { status: 200, body: listing, etag: '"1"' }; }
      const b = bytes(url);
      return b ? { status: 200, body: b.toString('utf8'), etag: null } : { status: 404, body: 'Not Found', etag: null };
    },
    /** The desktop shell's download (update-store.cjs: {status, body: Buffer}). */
    shell: async (url: string) => {
      const b = bytes(url);
      return b ? { status: 200, body: b } : { status: 404, body: Buffer.from('Not Found') };
    },
    get: (url: string) => bytes(url),
  };
}

const desktopInfo = (os: 'macos' | 'windows', canAutoUpdate: boolean) => ({
  platform: 'desktop' as const, os, arch: 'x64' as const, shellVersion: OLD, installedGame: OLD, builtinGame: OLD, pendingGame: null, canInstallGame: true, canAutoUpdate,
});

test('beta.1 client: finds the new pre-release by its channel files, verifies it and offers the game and app updates', async () => {
  const gh = fakeGitHub(release({ signedDesktop: false }));
  // The listing filter needs channel-beta.json and its .sig among the release's asset names.
  assert.equal(newestPrereleaseTag(JSON.parse((await gh.client(RELEASES_API)).body), compareSemver), TAG);
  const found = await fetchChannel('beta', gh.client, { publicKey: KEY });
  assert.ok(found, 'the beta.1 client found a channel');
  assert.equal(found.from, TAG);
  assert.equal(found.file.version, V);
  const file = found.file;

  // Game over the air: the URL is served, the bytes match the signed sha256, and minShell admits a beta.1 shell.
  const offer = decide(file, { info: desktopInfo('macos', false) });
  assert.equal(offer.game.kind, 'install');
  if (offer.game.kind !== 'install') return;
  assert.equal(sha256(gh.get(offer.game.url)!), offer.game.sha256);
  assert.equal(file.game.minShell, OLD);
  // Unsigned desktop builds: the app opens the release page (the player picks the new DMG or installer there).
  assert.equal(offer.native?.how, 'download');
  assert.equal(offer.native?.params.url, `https://github.com/${REPO}/releases/tag/${TAG}`);
  assert.equal(decide(file, { info: desktopInfo('windows', true) }).native?.how, 'download', 'an installed unsigned Windows app is never pointed at a feed');
  // Sideloaded Android: the installer gets the renamed APK and its signed sha256.
  const android = decide(file, { info: { platform: 'android', shellVersion: OLD, installedGame: OLD, builtinGame: OLD, pendingGame: null, canInstallGame: true, canAutoUpdate: false, installSource: 'sideload' } });
  assert.equal(android.native?.how, 'installer');
  assert.equal(android.native?.params.url, `https://github.com/${REPO}/releases/download/${TAG}/${NAMES.androidApk}`);
  assert.equal(sha256(gh.get(android.native!.params.url!)!), android.native?.params.sha256);
  // Cloud coordinator (REL-05): the beta.1 client downloads the raw .mjs from the tagged release and checks its sha256.
  assert.ok(file.coordinator);
  assert.equal(sha256((await gh.client(file.coordinator.url)).body), file.coordinator.sha256);

  // Nothing the beta.1 client asked for was missing, and it never asked for a removed file.
  const prefix = `https://github.com/${REPO}/releases/download/${TAG}/`;
  for (const url of gh.requested.filter(u => u.startsWith(prefix))) assert.ok(gh.published.includes(url.slice(prefix.length)), `beta.1 asked for ${url}`);
});

test('beta.1 desktop shell: re-verifies the signed release itself and installs only the files it names', async () => {
  for (const signedDesktop of [false, true]) {
    const gh = fakeGitHub(release({ signedDesktop }));
    const found = await fetchChannel('beta', gh.client, { publicKey: KEY });
    const file = found!.file;
    // update-store.cjs fetches releases/download/v<version>/channel-beta.json(.sig) and checks the pinned key.
    assert.equal(desktopStore.releaseChannelUrl(V), `https://github.com/${REPO}/releases/download/${TAG}/channel-beta.json`);
    const signed = await desktopStore.signedRelease(V, gh.shell, KEY);
    assert.equal(signed.version, V);
    desktopStore.checkGameAgainstRelease(signed, { url: file.game.url, sha256: file.game.sha256, version: V }, OLD);
    // The page asks the shell to fetch only URLs its bridge policy allows.
    for (const url of [RELEASES_API, file.game.url, file.coordinator!.url, `${desktopStore.releaseChannelUrl(V)}.sig`]) assert.ok(desktopPolicy.isUpdateFetchUrl(url), url);
    const mac = decide(file, { info: { ...desktopInfo('macos', true), arch: 'arm64' } }).native!;
    const win = decide(file, { info: desktopInfo('windows', true) }).native!;
    if (!signedDesktop) {
      assert.equal(mac.how, 'download');
      assert.equal(win.how, 'download');
      assert.throws(() => desktopStore.windowsPackage(signed, V), /no Windows update package/);
      continue;
    }
    // Signed builds: Squirrel.Mac gets the per-arch feed from the signed release; the feed points at a served zip.
    assert.equal(mac.how, 'auto');
    assert.ok(desktopPolicy.releaseAsset(mac.params.feed));
    assert.equal(mac.params.feed, signed.shell.macos.feed.arm64);
    const feed = JSON.parse(gh.get(mac.params.feed!)!.toString('utf8'));
    const zip = gh.get(feed.releases[0].updateTo.url);
    assert.ok(zip, 'the Squirrel.Mac payload is published');
    assert.equal(sha256(zip!), signed.shell.macos.downloads.arm64.zip.sha256);
    // Squirrel.Windows: the shell insists on AgentEmpire-<nuget>-full.nupkg from this tag and checks its sha256.
    assert.equal(win.how, 'auto');
    const pkg = desktopStore.windowsPackage(signed, V);
    assert.equal(pkg.name, 'AgentEmpire-1.0.0-beta002-full.nupkg');
    const got = await gh.shell(pkg.url);
    assert.equal(got.status, 200);
    assert.equal(sha256(got.body), pkg.sha256);
  }
});

/** The pattern a frozen Java/Swift source compiles for one release-URL path segment. */
function segmentPattern(source: string, re: RegExp): RegExp {
  const m = re.exec(source);
  assert.ok(m, 'the frozen source still declares its segment pattern');
  return new RegExp(`^${m[1].replace(/^\^|\$$/g, '')}$`);
}

test('beta.1 Android and iOS shells: the signed release is where they look, and every URL they install passes their policy', async () => {
  const java = readFileSync(path.join(BETA1, 'mobile/android/app/src/main/java/com/agentempire/mobile/UpdatePolicy.java'), 'utf8');
  const swift = readFileSync(path.join(BETA1, 'mobile/ios/AgentEmpire/UpdatePolicy.swift'), 'utf8');
  const segments = [
    segmentPattern(java, /SEGMENT = Pattern\.compile\("([^"]+)"\)/),
    segmentPattern(swift, /s\.range\(of: "([^"]+)", options: \.regularExpression\) != nil\n/),
  ];
  // Both shells read releases/download/v<version>/channel-beta.json (+ .sig) and verify it with the pinned key.
  assert.match(java, /"\/releases\/download\/v" \+ version \+ "\/channel-beta\.json"/);
  assert.match(swift, /"https:\/\/github\.com\/\\\(releaseRepo\)\/releases\/download\/v\\\(version\)\/channel-beta\.json"/);
  // The fields the shells compare the page's request with (GameUpdater.java installGame/installApk, UpdatePolicy.swift
  // releaseMismatch). The checks below are transcriptions of those lines, anchored to the frozen sources.
  const javaUpdater = readFileSync(path.join(BETA1, 'mobile/android/app/src/main/java/com/agentempire/mobile/GameUpdater.java'), 'utf8');
  assert.ok(javaUpdater.includes('UpdatePolicy.releaseMismatch(str(release, "version"), str(release, "tag"), str(game, "url"), str(game, "sha256"), str(game, "minShell"), version, url, sha256, shellVersion())'));
  assert.ok(javaUpdater.includes('JSONObject signedApk = release.optJSONObject("shell") == null ? null : release.optJSONObject("shell").optJSONObject("android");'));
  assert.ok(javaUpdater.includes('UpdatePolicy.releaseMismatch(str(release, "version"), str(release, "tag"), str(signedApk, "url"), str(signedApk, "sha256"), null, version, url, sha256, shell)'));
  assert.ok(swift.includes('guard let game = doc["game"] as? [String: Any], game["url"] as? String == url, game["sha256"] as? String == sha256 else {'));
  /** UpdatePolicy.java releaseMismatch (beta.1), with the semver comparison delegated to the frozen client's. */
  const javaMismatch = (docVersion: unknown, docTag: unknown, signedUrl: unknown, signedSha: unknown, minShell: string | null, version: string, url: string, sha: string, shell: string) => {
    if (docVersion !== version || (docTag != null && docTag !== `v${version}`)) return 'another version';
    if (signedUrl !== url || signedSha !== sha) return 'mismatch';
    if (minShell != null && compareSemver(shell, minShell) < 0) return 'needs shell';
    return null;
  };
  /** UpdatePolicy.swift releaseMismatch (beta.1). */
  const swiftMismatch = (d: Record<string, any>, version: string, url: string, sha: string, shell: string) => {
    if (d.schema !== 1 || d.version !== version) return 'another version';
    if (typeof d.tag === 'string' && d.tag !== `v${version}`) return 'another version';
    if (!d.game || d.game.url !== url || d.game.sha256 !== sha) return 'mismatch';
    if (typeof d.game.minShell === 'string' && compareSemver(shell, d.game.minShell) < 0) return 'needs shell';
    return null;
  };

  const dir = release({ signedDesktop: false });
  const gh = fakeGitHub(dir);
  const doc = JSON.parse(gh.get(`https://github.com/${REPO}/releases/download/${TAG}/channel-beta.json`)!.toString('utf8'));
  const sig = gh.get(`https://github.com/${REPO}/releases/download/${TAG}/channel-beta.json.sig`)!.toString('utf8');
  assert.ok(verifyBytes(readFileSync(path.join(dir, 'channel-beta.json')), sig, KEY), 'the shells verify the same bytes with Ed25519');
  // Android: installGame and installApk accept only tagged release assets (UpdatePolicy.isTaggedAsset).
  const tagged = (url: string, segment: RegExp) => {
    const parts = new URL(url).pathname.split('/');
    return parts.length === 7 && parts[3] === 'releases' && parts[4] === 'download' && segment.test(parts[5]) && segment.test(parts[6]) && parts[5] === TAG;
  };
  for (const segment of segments) {
    for (const url of [doc.game.url, doc.shell.android.url, doc.coordinator.url]) {
      assert.ok(tagged(url, segment), `${url} vs ${segment}`);
      assert.ok(gh.get(url), `${url} is published`);
    }
    for (const name of gh.published) assert.ok(segment.test(name), `${name} is a segment the shells accept`);
  }
  assert.equal(sha256(gh.get(doc.shell.android.url)!), doc.shell.android.sha256);
  // The page's request comes from the same signed channel; a beta.1 shell accepts it.
  assert.equal(javaMismatch(doc.version, doc.tag, doc.game.url, doc.game.sha256, doc.game.minShell, V, doc.game.url, doc.game.sha256, OLD), null);
  assert.equal(javaMismatch(doc.version, doc.tag, doc.shell.android.url, doc.shell.android.sha256, null, V, doc.shell.android.url, doc.shell.android.sha256, OLD), null);
  assert.equal(swiftMismatch(doc, V, doc.game.url, doc.game.sha256, OLD), null);
  assert.equal(doc.version, V);
  assert.equal(doc.tag, TAG);
  // The client agrees (same policy, TypeScript side).
  assert.deepEqual(clientReleaseAsset(doc.shell.android.url), { tag: TAG, file: NAMES.androidApk });
});

test('no shipped reader refers to a file the next release drops', () => {
  const sources = ['src/client/update/channel.ts', 'src/client/update/source.ts', 'src/client/update/decide.ts', 'src/client/update/verify.ts', 'desktop/update-store.cjs', 'desktop/bridge-policy.cjs',
    'mobile/android/app/src/main/java/com/agentempire/mobile/UpdatePolicy.java', 'mobile/android/app/src/main/java/com/agentempire/mobile/GameUpdater.java',
    'mobile/ios/AgentEmpire/UpdatePolicy.swift', 'mobile/ios/AgentEmpire/GameUpdater.swift'].map(f => readFileSync(path.join(BETA1, f), 'utf8')).join('\n');
  for (const dropped of ['SHA256SUMS', 'game-manifest', 'manifestSig', '.aab', 'windows-x64', 'macos-arm64', 'macos-x64', '-unsigned', 'debug-signed', 'downloads.x64.zip'])
    assert.ok(!sources.includes(dropped), `a beta.1 reader mentions ${dropped}`);
  // What they do name is still published: channel-beta.json, the Squirrel.Windows package pattern and the stable macOS feed.
  assert.ok(sources.includes('channel-beta.json'));
  assert.ok(sources.includes('AgentEmpire-${nugetVersion(version)}-full.nupkg'));
  assert.match(sources, /RELEASES-darwin-\(arm64\|x64\)\\\.json/);
});

test('the frozen readers are exactly the code tagged v1.0.0-beta.1', (t) => {
  let tagged = true;
  try { execFileSync('git', ['rev-parse', '--verify', '--quiet', 'v1.0.0-beta.1^{commit}'], { cwd: ROOT, stdio: 'ignore' }); } catch { tagged = false; }
  if (!tagged) return t.skip('tag v1.0.0-beta.1 is not in this clone (git fetch --tags)');
  const files = execFileSync('git', ['ls-files', 'tests/compat/beta1'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(f => f && !f.endsWith('README.md'));
  const onDisk = readdirSync(BETA1, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name !== 'README.md').length;
  assert.ok(files.length === 0 || files.length === onDisk, 'every frozen reader is committed');
  for (const rel of readdirSync(BETA1, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name !== 'README.md').map(e => path.relative(BETA1, path.join(e.parentPath, e.name)))) {
    const original = execFileSync('git', ['show', `v1.0.0-beta.1:${rel}`], { cwd: ROOT });
    assert.ok(original.equals(readFileSync(path.join(BETA1, rel))), `${rel} differs from v1.0.0-beta.1`);
  }
});

// Device testing (v1.0.0-beta.1): installed beta.1 apps default to the STABLE channel (src/client/update/service.ts at the
// tag), which reads .../releases/latest/download/channel-stable.json. v1.0.0-beta.1 was published as a pre-release that is
// not "latest", so that URL is a 404 and those apps say "You're up to date" forever. Until the first stable 1.0.0, each
// 1.0.0 pre-release is therefore also the stable channel's release: it publishes channel-stable.json and is marked latest.
test('beta.1 client on its default stable channel: reaches the next 1.0.0 pre-release through GitHub latest', async () => {
  const dir = release({ signedDesktop: false });
  assert.ok(readdirSync(dir).includes('channel-stable.json'), 'a 1.0.0 pre-release also publishes the stable channel');
  assert.ok(readdirSync(dir).includes('channel-stable.json.sig'));
  const gh = fakeGitHub(dir, { latest: true });
  const stable = await fetchChannel('stable', gh.client, { publicKey: KEY });
  assert.ok(stable, 'the frozen beta.1 stable reader found a release');
  assert.equal(stable.file.version, V);
  assert.ok(gh.requested.includes(`https://github.com/${REPO}/releases/latest/download/channel-stable.json`));
  const offer = decide(stable.file, { info: desktopInfo('macos', false) });
  assert.equal(offer.game.kind, 'install', 'the game update is offered');
  if (offer.game.kind === 'install') assert.equal(sha256(gh.get(offer.game.url)!), offer.game.sha256);
  // The shells' fetch policy admits the latest URL, and the desktop shell re-verifies against the tag's own channel-beta.json.
  assert.ok(desktopPolicy.isUpdateFetchUrl(`https://github.com/${REPO}/releases/latest/download/channel-stable.json`));
  assert.ok(gh.get(desktopStore.releaseChannelUrl(V)), 'channel-beta.json is still published under the tag');
  // A beta.1 player who chose beta still gets it: the listing no longer marks it a pre-release, but beta also reads stable.
  const beta = await fetchChannel('beta', gh.client, { publicKey: KEY });
  assert.equal(beta?.file.version, V);
});
