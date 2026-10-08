/**
 * Security review fixes (claude/updater-fixes): the desktop shell verifies the release's own signed channel before it
 * installs a game bundle or an app update (defense in depth against a page XSS), Windows applies only the signed
 * nupkg through a local verified feed, and the coordinator is never offered below what runs (beta → stable switch).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RELEASE_PUBLIC_KEY } from '../src/shared/release-key';
import { DEV_RELEASE_PUBLIC_KEY } from '../tools/release/dev-key.mjs';
import { channelJson, OTHER_KEYPAIR, sign, asset } from './update-fixtures';
import { nugetVersion as releaseNuget, parseReleases } from '../tools/release/package-windows-installer.mjs';
import { coordinatorDecision } from '../src/client/update/coordinator';
import { parseChannel } from '../src/client/update/channel';

const require = createRequire(import.meta.url);
const updates = require('../desktop/update-store.cjs');
/** What a development desktop build (prepare-desktop.mjs --dev-updates) trusts; fixtures are dev-signed. */
const DEV_TRUST = [RELEASE_PUBLIC_KEY, DEV_RELEASE_PUBLIC_KEY];

const signedDoc = (version: string, over: Record<string, unknown> = {}, key?: Uint8Array) => {
  const doc = { ...channelJson({ version, gameSha: 'a'.repeat(64), minShell: '0.2.0' }), ...over };
  const text = JSON.stringify(doc);
  return { doc, text, sig: sign(text, key) };
};
const getter = (files: Record<string, { text: string; status?: number }>) => async (url: string) => {
  const f = files[url];
  return f ? { status: f.status ?? 200, body: Buffer.from(f.text) } : { status: 404, body: Buffer.from('') };
};

test('desktop: Ed25519 with node:crypto; tampering and other keys fail; a release build trusts only the owner key', () => {
  const msg = 'hello release';
  assert.equal(updates.verifyEd25519(Buffer.from(msg), sign(msg), DEV_RELEASE_PUBLIC_KEY), true);
  assert.equal(updates.verifyEd25519(Buffer.from(`${msg}!`), sign(msg), DEV_RELEASE_PUBLIC_KEY), false);
  assert.equal(updates.verifyEd25519(Buffer.from(msg), sign(msg, OTHER_KEYPAIR.secretKey), DEV_RELEASE_PUBLIC_KEY), false);
  assert.equal(updates.verifyEd25519(Buffer.from(msg), 'garbage', DEV_RELEASE_PUBLIC_KEY), false);
  // REL-07: this tree has no desktop/dev-trust.json, so update-store.cjs is in its release shape.
  assert.equal(updates.RELEASE_PUBLIC_KEY, RELEASE_PUBLIC_KEY);
  assert.equal(updates.DEV_KEY_TRUSTED, false);
  assert.deepEqual([...updates.TRUSTED_KEYS], [RELEASE_PUBLIC_KEY]);
  assert.equal(updates.verifyEd25519(Buffer.from(msg), sign(msg)), false, 'a dev signature fails against the owner key');
  assert.equal(updates.verifyTrusted(Buffer.from(msg), sign(msg)), false, 'and against the release build trusted set');
  assert.equal(updates.verifyTrusted(Buffer.from(msg), sign(msg), DEV_TRUST), true);
  assert.equal(updates.verifyTrusted(Buffer.from(`${msg}!`), sign(msg), DEV_TRUST), false);
});

test('desktop: development trust comes only from a valid dev-trust.json written at build time', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ae-devtrust-'));
  assert.equal(updates.readDevTrust(dir), null);
  writeFileSync(path.join(dir, 'dev-trust.json'), JSON.stringify({ devReleasePublicKey: DEV_RELEASE_PUBLIC_KEY }));
  assert.equal(updates.readDevTrust(dir), DEV_RELEASE_PUBLIC_KEY);
  for (const bad of ['{', '{}', JSON.stringify({ devReleasePublicKey: 'short' }), JSON.stringify({ devReleasePublicKey: RELEASE_PUBLIC_KEY })]) {
    writeFileSync(path.join(dir, 'dev-trust.json'), bad);
    assert.throws(() => updates.readDevTrust(dir), /malformed/, bad);
  }
});

test('desktop: the shell reads the release’s own signed channel and installs only what it names', async () => {
  const v = '1.0.1';
  const { text, sig, doc } = signedDoc(v);
  const url = updates.releaseChannelUrl(v);
  const files = getter({ [url]: { text }, [`${url}.sig`]: { text: `${sig}\n` } });
  // A release build (owner key only) refuses the dev-signed fixture; a development build accepts it.
  await assert.rejects(updates.signedRelease(v, files), /signature does not match/);
  const release = await updates.signedRelease(v, files, DEV_TRUST);
  const ok = { url: doc.game.url, sha256: doc.game.sha256, version: v };
  assert.doesNotThrow(() => updates.checkGameAgainstRelease(release, ok, '0.2.0'));
  // A page that asks for another sha256, another release's zip or another version is refused.
  assert.throws(() => updates.checkGameAgainstRelease(release, { ...ok, sha256: 'b'.repeat(64) }, '0.2.0'), /does not match the signed release/);
  assert.throws(() => updates.checkGameAgainstRelease(release, { ...ok, url: asset('0.9.0', 'agent-empire-game-0.9.0.zip') }, '0.2.0'), /does not match/);
  assert.throws(() => updates.checkGameAgainstRelease(release, ok, '0.1.9'), /needs app version 0\.2\.0/);
  // Wrong key, other version, missing signature.
  const forged = signedDoc(v, {}, OTHER_KEYPAIR.secretKey);
  await assert.rejects(updates.signedRelease(v, getter({ [url]: { text: forged.text }, [`${url}.sig`]: { text: forged.sig } }), DEV_TRUST), /signature does not match/);
  const other = signedDoc('1.0.2');
  await assert.rejects(updates.signedRelease(v, getter({ [url]: { text: other.text }, [`${url}.sig`]: { text: other.sig } }), DEV_TRUST), /another version/);
  await assert.rejects(updates.signedRelease(v, getter({ [url]: { text } }), DEV_TRUST), /could not be read/);
});

test('desktop Windows: only the signed release’s nupkg (its tag, not latest), with a RELEASES index computed locally', () => {
  const v = '1.0.0-beta.2';
  assert.equal(updates.nugetVersion(v), releaseNuget(v));
  assert.equal(updates.nugetVersion('1.2.0'), releaseNuget('1.2.0'));
  const name = `AgentEmpire-${updates.nugetVersion(v)}-full.nupkg`;
  const withPkg = (url: string, sha = 'c'.repeat(64)) => ({ shell: { windows: { downloads: { x64: { nupkg: { name, url, sha256: sha } } } } } });
  assert.deepEqual(updates.windowsPackage(withPkg(asset(v, name)), v), { url: asset(v, name), sha256: 'c'.repeat(64), name });
  for (const bad of [
    withPkg(`https://github.com/Billioncodes001/agent-empire/releases/latest/download/${name}`),
    withPkg(asset('1.0.0-beta.1', name)),
    withPkg(asset(v, 'AgentEmpire-9.9.9-full.nupkg')),
    withPkg(asset(v, name), 'nothex'),
    {},
  ])
    assert.throws(() => updates.windowsPackage(bad, v), /no Windows update package/);
  const bytes = Buffer.from('nupkg bytes');
  const line = updates.squirrelReleases(bytes, name);
  assert.deepEqual(parseReleases(line), [{ sha1: createHash('sha1').update(bytes).digest('hex').toUpperCase(), file: name, size: bytes.length }]);
});

test('coordinator: switching from beta to stable never offers an older coordinator (also for an unknown installed version)', () => {
  const stable = parseChannel(JSON.stringify(channelJson({ version: '1.0.0', coordinatorSha: 'c'.repeat(64) })), 'stable');
  assert.equal(coordinatorDecision(stable, { version: '1.1.0-beta.3', sha256: 'd'.repeat(64) }).kind, 'current');
  // A repository set up by a newer app without a manifest: its bundle equals that app's own coordinator.
  assert.equal(coordinatorDecision(stable, { version: null, sha256: 'e'.repeat(64) }, 1, { version: '1.1.0-beta.3', sha256: 'e'.repeat(64) }).kind, 'current');
  assert.equal(coordinatorDecision(stable, { version: null, sha256: 'f'.repeat(64) }, 1, { version: '1.1.0-beta.3', sha256: 'e'.repeat(64) }).kind, 'available', 'an unknown, different bundle predates the manifest');
});
