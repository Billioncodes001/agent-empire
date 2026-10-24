/**
 * REL-04 desktop shell: update.* bridge validation, zip-slip protection, downloads that only follow GitHub's asset
 * redirects, and the bundle store's state machine (install, downgrade refusal, activate, bootOk, 20 s rollback,
 * unfinished trial at launch, built-in fallback). No Electron, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asset, gameZip, makeZip, sha256 } from './update-fixtures';

const require = createRequire(import.meta.url);
const policy = require('../desktop/bridge-policy.cjs');
const updates = require('../desktop/update-store.cjs');
const { createHandler } = require('../desktop/app-protocol.cjs');

const tmp = () => mkdtempSync(path.join(tmpdir(), 'ae-upd-'));
const builtin = (version: string | null) => {
  const dir = path.join(tmp(), 'public');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>built-in</title>');
  if (version) writeFileSync(path.join(dir, 'game-version.json'), JSON.stringify({ version }));
  return dir;
};

test('desktop bridge: update.* parameters are validated before any handler runs', () => {
  const ok = (method: string, params: unknown) => policy.parseRequest({ id: 'u1', method, params });
  const url = asset('1.0.0-beta.2', 'agent-empire-game-1.0.0-beta.2.zip');
  assert.deepEqual(ok('update.installGame', { url, sha256: 'a'.repeat(64), version: '1.0.0-beta.2', extra: 1 }).params, { url, sha256: 'a'.repeat(64), version: '1.0.0-beta.2' });
  for (const params of [
    { url: 'https://evil.test/a.zip', sha256: 'a'.repeat(64), version: '1.0.0' },
    { url: asset('1.0.0', 'a.zip').replace('Billioncodes001', 'someone'), sha256: 'a'.repeat(64), version: '1.0.0' },
    { url: `https://github.com/${policy.RELEASE_REPO}/releases/latest/download/a.zip`, sha256: 'a'.repeat(64), version: '1.0.0' },
    { url, sha256: 'A'.repeat(64), version: '1.0.0' },
    { url, sha256: 'a'.repeat(64), version: '1.0' },
    { url: url.replace('https:', 'http:'), sha256: 'a'.repeat(64), version: '1.0.0' },
  ])
    assert.ok(ok('update.installGame', params).error, JSON.stringify(params));
  assert.deepEqual(ok('update.fetch', { url: policy.RELEASES_API, etag: 'W/"abc"' }).params, { url: policy.RELEASES_API, etag: 'W/"abc"' });
  assert.deepEqual(ok('update.fetch', { url: `https://github.com/${policy.RELEASE_REPO}/releases/latest/download/channel-stable.json`, etag: 'bad\netag' }).params, { url: `https://github.com/${policy.RELEASE_REPO}/releases/latest/download/channel-stable.json` });
  assert.ok(ok('update.fetch', { url: 'https://api.github.com/user' }).error);
  assert.ok(ok('update.fetch', { url: 'file:///etc/passwd' }).error);
  assert.deepEqual(ok('update.openNative', { version: '1.0.1', url: asset('1.0.1', 'mac.zip'), feed: asset('1.0.1', 'feed.json'), cmd: 'x' }).params, { version: '1.0.1', url: asset('1.0.1', 'mac.zip'), feed: asset('1.0.1', 'feed.json') });
  assert.ok(ok('update.openNative', { version: '1.0.1', url: 'https://evil.test/mac.zip' }).error);
  assert.ok(ok('update.openNative', { version: '1.0.1' }).error);
  for (const m of ['update.activate', 'update.bootOk', 'update.nativeInfo']) assert.deepEqual(ok(m, { anything: true }).params, {});
  assert.ok(policy.compareSemver('1.0.0-beta.10', '1.0.0-beta.2') > 0 && policy.compareSemver('1.0.0', '1.0.0-rc.1') > 0);
});

test('desktop native updates: Squirrel events, Update.exe and feed options', () => {
  assert.equal(updates.squirrelEvent(['app.exe', '--squirrel-install', '1.0.0']), 'install');
  assert.equal(updates.squirrelEvent(['app.exe', '--squirrel-updated']), 'updated');
  assert.equal(updates.squirrelEvent(['app.exe', '--squirrel-uninstall']), 'uninstall');
  assert.equal(updates.squirrelEvent(['app.exe', '--squirrel-obsolete']), 'obsolete');
  assert.equal(updates.squirrelEvent(['app.exe', '--squirrel-firstrun']), 'firstrun');
  assert.equal(updates.squirrelEvent(['app.exe', '--squirrel-evil']), null);
  assert.equal(updates.squirrelEvent(['app.exe']), null);
  assert.equal(updates.squirrelUpdateExe(path.join(path.sep, 'Users', 'u', 'AppData', 'Local', 'AgentEmpire', 'app-1.0.0', 'Agent Empire.exe')), path.join(path.sep, 'Users', 'u', 'AppData', 'Local', 'AgentEmpire', 'Update.exe'));
  const folder = `https://github.com/${policy.RELEASE_REPO}/releases/download/v1.0.1`;
  assert.deepEqual(updates.autoUpdateFeed('win32', `${folder}/RELEASES`), { url: folder });
  const stableFolder = `https://github.com/${policy.RELEASE_REPO}/releases/latest/download`;
  assert.equal(policy.parseRequest({ id: 'n3', method: 'update.openNative', params: { version: '1.0.1', url: `https://github.com/${policy.RELEASE_REPO}/releases/tag/v1.0.1`, feed: stableFolder } }).params.feed, stableFolder);
  const main = readFileSync(path.resolve(import.meta.dirname, '../desktop/main.cjs'), 'utf8');
  assert.ok(main.indexOf('updates.squirrelEvent(process.argv)') < main.indexOf('protocol.registerSchemesAsPrivileged'), 'Squirrel events are handled before anything else starts');
  assert.deepEqual(updates.autoUpdateFeed('darwin', asset('1.0.1', 'desktop-update-darwin-arm64.json')), { url: asset('1.0.1', 'desktop-update-darwin-arm64.json'), serverType: 'json' });
  assert.deepEqual(policy.parseRequest({ id: 'n1', method: 'update.openNative', params: { version: '1.0.1', url: `https://github.com/${policy.RELEASE_REPO}/releases/tag/v1.0.1`, feed: folder } }).params, { version: '1.0.1', url: `https://github.com/${policy.RELEASE_REPO}/releases/tag/v1.0.1`, feed: folder });
  assert.ok(policy.parseRequest({ id: 'n2', method: 'update.openNative', params: { version: '1.0.1', url: 'https://github.com/evil/x/releases/tag/v1.0.1' } }).error);
});

test('zip: hostile archives are refused before anything is written (zip-slip)', () => {
  const hostile: [string, Buffer][] = [
    ['dot-dot', makeZip([{ name: 'index.html', data: 'x' }, { name: '../evil.txt', data: 'x' }])],
    ['nested dot-dot', makeZip([{ name: 'assets/../../evil.txt', data: 'x' }])],
    ['absolute', makeZip([{ name: '/etc/evil', data: 'x' }])],
    ['drive letter', makeZip([{ name: 'C:/evil', data: 'x' }])],
    ['backslash', makeZip([{ name: '..\\evil.txt', data: 'x' }])],
    ['NUL', makeZip([{ name: 'a\u0000b', data: 'x' }])],
    ['symlink', makeZip([{ name: 'index.html', data: '/etc/passwd', mode: 0o120777 }])],
    ['device', makeZip([{ name: 'dev', data: '', mode: 0o020644 }])],
    ['encrypted', makeZip([{ name: 'index.html', data: 'x', encrypted: true }])],
    ['duplicate', makeZip([{ name: 'index.html', data: 'x' }, { name: 'INDEX.html', data: 'y' }])],
    ['empty segment', makeZip([{ name: 'a//b', data: 'x' }])],
  ];
  for (const [name, zip] of hostile) {
    const root = tmp();
    const dest = path.join(root, 'out');
    assert.throws(() => updates.extractZip(zip, dest), Error, name);
    assert.equal(existsSync(path.join(root, 'evil.txt')), false, name);
    assert.equal(existsSync(dest), false, `${name}: nothing written`);
  }
  assert.throws(() => updates.extractZip(Buffer.from('not a zip'), path.join(tmp(), 'o')), /Not a zip/);
  const dest = path.join(tmp(), 'ok');
  assert.equal(updates.extractZip(gameZip('1.0.0'), dest), 3);
  assert.equal(JSON.parse(readFileSync(path.join(dest, 'game-version.json'), 'utf8')).version, '1.0.0');
  assert.match(readFileSync(path.join(dest, 'assets/main.js'), 'utf8'), /1\.0\.0/);
});

const response = (status: number, body = '', headers: Record<string, string> = {}) => new Response(status === 304 || (status >= 300 && status < 400) ? null : body, { status, headers });

test('download: only GitHub asset redirects are followed; size and first URL are checked', async () => {
  const url = asset('1.0.0', 'a.zip');
  const hops: string[] = [];
  const ok = await updates.download(url, {
    fetchImpl: async (u: string) => {
      hops.push(u);
      return hops.length === 1 ? response(302, '', { location: 'https://release-assets.githubusercontent.com/x?sig=1' }) : response(200, 'zipdata', { etag: 'e1' });
    },
  });
  assert.equal(ok.body.toString(), 'zipdata');
  assert.deepEqual(hops, [url, 'https://release-assets.githubusercontent.com/x?sig=1']);
  await assert.rejects(updates.download(url, { fetchImpl: async () => response(302, '', { location: 'https://evil.test/a.zip' }) }), /redirected somewhere unexpected/);
  await assert.rejects(updates.download(url, { fetchImpl: async () => response(302, '', { location: 'http://release-assets.githubusercontent.com/x' }) }), /unexpected/);
  await assert.rejects(updates.download('https://evil.test/a.zip', { fetchImpl: async () => response(200, 'x') }), /not an Agent Empire release/);
  await assert.rejects(updates.download(url, { maxBytes: 3, fetchImpl: async () => response(200, 'too large') }), /too large/);
  let loops = 0;
  await assert.rejects(updates.download(url, { fetchImpl: async () => (loops++, response(302, '', { location: 'https://objects.githubusercontent.com/again' })) }), /Too many redirects/);
  // Development fixture: github.com paths map to the loopback origin, and redirects must stay there.
  const fixture = updates.fixtureMapper('http://127.0.0.1:4799');
  const seen: string[] = [];
  await updates.download(policy.RELEASES_API, { fixture, fetchImpl: async (u: string) => (seen.push(u), response(200, '[]')) });
  assert.deepEqual(seen, ['http://127.0.0.1:4799/api/repos/Billioncodes001/agent-empire/releases?per_page=20']);
  assert.throws(() => updates.fixtureMapper('http://192.168.1.2:4799'), /loopback/);
  assert.throws(() => updates.fixtureMapper('https://example.com'), /loopback/);
});

function store(builtinVersion = '1.0.0-beta.1', clock = { t: 1_000 }) {
  const root = path.join(tmp(), 'game-bundles');
  const builtinRoot = builtin(builtinVersion);
  const make = () => updates.createBundleStore({ root, builtinRoot, now: () => clock.t });
  return { root, builtinRoot, clock, make };
}
const zipFetcher = (zip: Buffer) => async () => zip;

test('bundle store: install verifies sha256 and version, is forward only, and is atomic', async () => {
  const { root, builtinRoot, make } = store();
  const s = make();
  s.launch();
  const v2 = gameZip('1.0.0-beta.2');
  const params = (version: string, zip: Buffer) => ({ url: asset(version, `agent-empire-game-${version}.zip`), sha256: sha256(zip), version });
  await assert.rejects(s.install({ ...params('1.0.0-beta.2', v2), sha256: 'f'.repeat(64) }, zipFetcher(v2)), /does not match the signed release/);
  await assert.rejects(s.install(params('1.0.0-beta.1', gameZip('1.0.0-beta.1')), zipFetcher(gameZip('1.0.0-beta.1'))), /not newer/);
  await assert.rejects(s.install(params('0.9.0', gameZip('0.9.0')), zipFetcher(gameZip('0.9.0'))), /not newer/);
  const mislabeled = gameZip('1.0.0-beta.3');
  await assert.rejects(s.install(params('1.0.0-beta.4', mislabeled), zipFetcher(mislabeled)), /different version/);
  const slip = makeZip([{ name: 'index.html', data: 'x' }, { name: '../../escape.txt', data: 'x' }]);
  await assert.rejects(s.install(params('1.0.0-beta.5', slip), zipFetcher(slip)), /Unsafe path/);
  assert.deepEqual(readdirSync(root).sort(), ['state.json'], 'failed installs leave nothing behind');
  assert.equal(s.servingRoot(), builtinRoot);

  assert.deepEqual(await s.install(params('1.0.0-beta.2', v2), zipFetcher(v2)), { version: '1.0.0-beta.2' });
  assert.equal(s.state.pending, '1.0.0-beta.2');
  assert.equal(s.servingRoot(), builtinRoot, 'not switched until activate or the next start');
  await assert.rejects(s.install(params('1.0.0-beta.2', v2), zipFetcher(v2)), /not newer/, 'already pending');
});

test('bundle store: activate → trial → bootOk makes it known-good; old bundles are cleaned up', async () => {
  const { root, builtinRoot, make } = store();
  const s = make();
  s.launch();
  for (const v of ['1.0.0-beta.2', '1.0.0-beta.3']) {
    const zip = gameZip(v);
    await s.install({ url: asset(v, 'g.zip'), sha256: sha256(zip), version: v }, zipFetcher(zip));
    assert.equal(s.activate(), true);
    assert.equal(s.servingRoot(), path.join(root, v));
    assert.equal(s.state.trial?.version, v);
    assert.equal(s.bootOk(), true);
    assert.equal(s.state.knownGood, v);
  }
  assert.equal(existsSync(path.join(root, '1.0.0-beta.2')), false, 'superseded bundle removed');
  assert.equal(s.activate(), false, 'nothing pending');
  assert.equal(make().servingRoot(), path.join(root, '1.0.0-beta.3'), 'survives a restart');
  void builtinRoot;
});

test('bundle store: no bootOk within 20 s rolls back to the last known-good bundle; it is never offered again', async () => {
  const { root, builtinRoot, clock, make } = store();
  const s = make();
  s.launch();
  const good = gameZip('1.0.0-beta.2');
  await s.install({ url: asset('1.0.0-beta.2', 'g.zip'), sha256: sha256(good), version: '1.0.0-beta.2' }, zipFetcher(good));
  s.activate();
  s.bootOk();
  const broken = gameZip('1.0.0-beta.3', { broken: true });
  await s.install({ url: asset('1.0.0-beta.3', 'g.zip'), sha256: sha256(broken), version: '1.0.0-beta.3' }, zipFetcher(broken));
  s.activate();
  clock.t += 19_000;
  assert.equal(s.checkTrial(), false, 'still within 20 s');
  clock.t += 1_500;
  assert.equal(s.checkTrial(), true);
  assert.equal(s.servingRoot(), path.join(root, '1.0.0-beta.2'), 'back on the known-good bundle');
  assert.equal(s.takeRolledBack(), '1.0.0-beta.3');
  assert.equal(s.takeRolledBack(), null, 'one-shot');
  assert.match(s.refuse('1.0.0-beta.3'), /failed to start before/);
  void builtinRoot;
});

test('bundle store: a launch that finds an unfinished trial rolls back; pending is switched at launch', async () => {
  const { builtinRoot, root, make } = store();
  const a = make();
  a.launch();
  const zip = gameZip('1.0.0-beta.2');
  await a.install({ url: asset('1.0.0-beta.2', 'g.zip'), sha256: sha256(zip), version: '1.0.0-beta.2' }, zipFetcher(zip));
  // Quit; the next start switches to the pending bundle as a trial.
  const b = make();
  assert.equal(b.launch(), null);
  assert.equal(b.servingRoot(), path.join(root, '1.0.0-beta.2'));
  assert.equal(b.state.trial?.version, '1.0.0-beta.2');
  // It crashed before reporting: the following start goes back to the built-in game.
  const c = make();
  assert.deepEqual(c.launch(), { rolledBack: '1.0.0-beta.2', reason: 'the previous start never reported booting' });
  assert.equal(c.servingRoot(), builtinRoot);
});

test('bundle store: the built-in bundle wins when it is newer, and a damaged state file is ignored', async () => {
  const s1 = store('1.0.0-beta.1');
  const a = s1.make();
  a.launch();
  const zip = gameZip('1.0.0-beta.2');
  await a.install({ url: asset('1.0.0-beta.2', 'g.zip'), sha256: sha256(zip), version: '1.0.0-beta.2' }, zipFetcher(zip));
  a.activate();
  a.bootOk();
  // The app itself is updated with a newer built-in game.
  writeFileSync(path.join(s1.builtinRoot, 'game-version.json'), JSON.stringify({ version: '1.0.0' }));
  const b = s1.make();
  b.launch();
  assert.equal(b.servingRoot(), s1.builtinRoot);
  assert.equal(b.installedGame(), '1.0.0');
  // A removed bundle folder falls back to the built-in game too.
  writeFileSync(path.join(s1.root, 'state.json'), '{not json');
  assert.equal(s1.make().servingRoot(), s1.builtinRoot);
});

test('protocol handler serves the active bundle with the same rules, and the built-in one otherwise', async () => {
  const { make, builtinRoot } = store();
  const s = make();
  s.launch();
  const handler = createHandler(() => s.servingRoot());
  const get = async (p: string) => {
    const r = await handler(new Request(`empire-app://game${p}`));
    return { status: r.status, text: r.status === 200 ? await r.text() : '' };
  };
  assert.match((await get('/')).text, /built-in/);
  const zip = gameZip('1.0.0-beta.2');
  await s.install({ url: asset('1.0.0-beta.2', 'g.zip'), sha256: sha256(zip), version: '1.0.0-beta.2' }, zipFetcher(zip));
  s.activate();
  assert.match((await get('/')).text, /Agent Empire 1\.0\.0-beta\.2/);
  for (const p of ['/../state.json', '/%2e%2e/state.json', '/..%2fstate.json']) assert.notEqual((await get(p)).status, 200, p);
  assert.equal((await get('/game-version.json')).status, 200);
  rmSync(builtinRoot, { recursive: true, force: true });
});

test('macOS self-update needs a Developer ID signature; ad-hoc and unsigned builds fall back to the download prompt (FREE-03)', () => {
  const adhoc = 'Executable=/Applications/Agent Empire.app/Contents/MacOS/Agent Empire\nIdentifier=com.agentempire.desktop\nCodeDirectory v=20400 size=500 flags=0x2(adhoc) hashes=5+7 location=embedded\nSignature=adhoc\nTeamIdentifier=not set\n';
  const devId = 'Executable=/Applications/Agent Empire.app/Contents/MacOS/Agent Empire\nAuthority=Developer ID Application: Example Corp (ABCDE12345)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=ABCDE12345\n';
  assert.equal(updates.macDeveloperIdSigned(adhoc), false, 'ad-hoc');
  assert.equal(updates.macDeveloperIdSigned('/Applications/Agent Empire.app: code object is not signed at all\n'), false, 'unsigned');
  assert.equal(updates.macDeveloperIdSigned(''), false, 'no output');
  assert.equal(updates.macDeveloperIdSigned(undefined), false, 'codesign missing');
  assert.equal(updates.macDeveloperIdSigned('Authority=Apple Development: someone (XYZ)\n'), false, 'development certificate');
  assert.equal(updates.macDeveloperIdSigned(devId), true, 'Developer ID');
});
