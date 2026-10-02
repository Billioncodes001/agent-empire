/**
 * Round trip of the release lane's channel builder into every consumer (security review #1): tools/release/channel.mjs
 * buildChannel() → client parseChannel() → client nativeOffer() → desktop parseRequest(update.openNative). Stable and
 * beta, macOS signed and unsigned, Windows Squirrel and zip-only builds, Android signed and debug-signed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packageGame } from '../tools/release/package-game.mjs';
import { buildChannel } from '../tools/release/channel.mjs';
import { nupkgName } from '../tools/release/package-windows-installer.mjs';
import { parseChannel } from '../src/client/update/channel';
import { nativeOffer } from '../src/client/update/decide';
import type { NativeInfo } from '../src/client/update/bridge';

const require = createRequire(import.meta.url);
const policy = require('../desktop/bridge-policy.cjs');
const ROOT = path.resolve(import.meta.dirname, '..');
const temp = (n: string) => mkdtempSync(path.join(tmpdir(), `ae-roundtrip-${n}-`));
const CONFIG = { playListing: 'https://play.google.com/store/apps/details?id=com.agentempire.mobile', iosTestFlight: 'https://testflight.apple.com/join/AbCdEf12', iosAppStore: null };

function assetsDir(version: string, names: string[]) {
  const dist = temp('dist');
  mkdirSync(path.join(dist, 'cloud'), { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Agent Empire</title>');
  writeFileSync(path.join(dist, 'cloud/agent-empire-coordinator.mjs'), 'export const runCoordinatorTick = 1;');
  const out = temp('assets');
  packageGame({ dist, outDir: out, version, commit: 'a'.repeat(40), minShell: '1.0.0-beta.1' });
  writeFileSync(path.join(out, 'agent-empire-coordinator.mjs'), 'export const runCoordinatorTick = 1;');
  for (const n of names) writeFileSync(path.join(out, n), `binary ${n}`);
  return out;
}

const desktop = (os: 'macos' | 'windows', arch: 'arm64' | 'x64'): NativeInfo => ({
  platform: 'desktop', os, arch, shellVersion: '0.9.0', installedGame: '0.9.0', builtinGame: '0.9.0', pendingGame: null, canInstallGame: true, canAutoUpdate: true,
});

const cases = [
  { version: '1.0.0', signed: true, label: 'stable, signed builds' },
  { version: '1.0.0', signed: false, label: 'stable, unsigned builds' },
  { version: '1.1.0-beta.2', signed: true, label: 'beta, signed builds' },
  { version: '1.1.0-beta.2', signed: false, label: 'beta, unsigned builds' },
];

for (const c of cases) {
  test(`round trip: ${c.label}`, () => {
    const v = c.version;
    const u = c.signed ? '' : '-unsigned';
    const names = [
      `Agent-Empire-${v}-macos-arm64${u}.zip`, `Agent-Empire-${v}-macos-arm64${u}.dmg`, `Agent-Empire-${v}-macos-x64${u}.zip`,
      `Agent-Empire-${v}-windows-x64${u}.zip`, `Agent-Empire-${v}-windows-x64-Setup${u}.exe`, ...(c.signed ? [nupkgName(v), 'RELEASES'] : []),
      `Agent-Empire-${v}-android${c.signed ? '' : '-debug-signed'}.apk`,
    ];
    const dir = assetsDir(v, names);
    const channels = v.includes('-') ? ['beta'] : ['stable', 'beta'];
    for (const channel of channels) {
      const doc = buildChannel({ assetsDir: dir, version: v, channel, repo: 'Billioncodes001/agent-empire', publishedAt: '2026-10-02T12:00:00.000Z', notes: 'Notes', config: CONFIG, playPublished: true, root: ROOT });
      const parsed = parseChannel(JSON.stringify(doc), channel as 'stable' | 'beta');
      assert.equal(parsed.version, v);
      assert.equal(parsed.shell.macos?.auto, c.signed, `${channel}: macOS auto`);
      assert.equal(parsed.shell.windows?.auto, c.signed, `${channel}: Windows auto`);
      if (c.signed) {
        assert.equal(parsed.shell.windows?.nupkg?.sha256, doc.shell.windows.downloads.x64.nupkg.sha256, `${channel}: the signed nupkg hash reaches the client`);
        assert.equal(parsed.shell.windows?.nupkg?.url, doc.shell.windows.downloads.x64.nupkg.url);
      }
      for (const [os, arch] of [['macos', 'arm64'], ['macos', 'x64'], ['windows', 'x64']] as const) {
        const offer = nativeOffer(parsed, desktop(os, arch));
        assert.ok(offer, `${channel} ${os}/${arch}: offered`);
        assert.equal(offer!.how, c.signed ? 'auto' : 'download', `${channel} ${os}/${arch}: how`);
        const req = policy.parseRequest({ id: 'r1', method: 'update.openNative', params: offer!.params });
        assert.equal(req.error, undefined, `${channel} ${os}/${arch}: the desktop shell accepts the offer (${req.error})`);
        if (c.signed && os === 'macos') assert.equal(req.params.feed, doc.shell.macos.feed[arch]);
      }
      assert.equal(parsed.shell.android?.sha256 !== undefined, true, `${channel}: Android APK hash`);
    }
  });
}

test('the macOS stable feed is accepted only as RELEASES-darwin-<arch>.json under latest/download', () => {
  const base = 'https://github.com/Billioncodes001/agent-empire/releases/latest/download';
  for (const good of [`${base}/RELEASES-darwin-arm64.json`, `${base}/RELEASES-darwin-x64.json`])
    assert.equal(policy.parseRequest({ id: 'a', method: 'update.openNative', params: { version: '1.0.1', url: 'https://github.com/Billioncodes001/agent-empire/releases/tag/v1.0.1', feed: good } }).error, undefined, good);
  for (const bad of [`${base}/evil.json`, `${base}/RELEASES-darwin-arm64.json.exe`, `${base}/agent-empire-game-1.0.0.zip`])
    assert.ok(policy.parseRequest({ id: 'a', method: 'update.openNative', params: { version: '1.0.1', url: 'https://github.com/Billioncodes001/agent-empire/releases/tag/v1.0.1', feed: bad } }).error, bad);
});
