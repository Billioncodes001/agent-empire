/**
 * DEVICE-BUGS-03 (bug 2): "the Mac app seems to use the old world design". The released beta.2 app serves its own
 * beta.2 game, but every later build of codex/empire-world still says 1.0.0-beta.2 (package.json), so a release and a
 * newer development build were indistinguishable in Settings. Each game build now carries its commit and date.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gameBuild } from '../tools/release/game-build.mjs';
import { versionLine, buildLabel } from '../src/client/update/version-line';

const repo = path.resolve(import.meta.dirname, '..');

test('game build: the commit and commit date of the source tree', () => {
  const b = gameBuild({ cwd: repo, env: {} });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(b.commit, head.slice(0, 12));
  assert.match(b.date ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof b.dirty, 'boolean');
});

test('game build: CI can pin the commit (GITHUB_SHA or AGENT_EMPIRE_BUILD_COMMIT); junk is ignored', () => {
  assert.equal(gameBuild({ cwd: repo, env: { GITHUB_SHA: 'ABCDEF0123456789abcdef0123456789abcdef01' } }).commit, 'abcdef012345');
  assert.equal(gameBuild({ cwd: repo, env: { AGENT_EMPIRE_BUILD_COMMIT: '0123456789ab', GITHUB_SHA: 'ffffffffffff' } }).commit, '0123456789ab');
  const junk = gameBuild({ cwd: repo, env: { AGENT_EMPIRE_BUILD_COMMIT: '"><script>' } });
  assert.match(junk.commit ?? '', /^[0-9a-f]{12}$/, 'falls back to git, never echoes junk');
});

test('game build: outside a Git checkout there is no commit, and nothing throws', () => {
  const b = gameBuild({ cwd: mkdtempSync(path.join(tmpdir(), 'ae-nogit-')), env: {} });
  assert.deepEqual(b, { commit: null, date: null, dirty: false });
});

const state = { game: '1.0.0-beta.2', info: { platform: 'desktop', shellVersion: '1.0.0-beta.2' }, serverVersion: null, channel: 'beta' } as const;

test('version line: names the game build, so a release and a newer build of the same version differ', () => {
  const release = versionLine(state, { commit: '1fb8e12aaaaa', date: '2026-10-25T13:04:22Z', dirty: false });
  const newer = versionLine(state, { commit: '64585f8bbbbb', date: '2026-10-25T15:52:00Z', dirty: false });
  assert.equal(release, 'Game 1.0.0-beta.2 (build 1fb8e12, 25 Oct 2026) · desktop app 1.0.0-beta.2 · Beta channel');
  assert.notEqual(release, newer);
  assert.equal(buildLabel({ commit: '64585f8bbbbb', date: '2026-10-25T15:52:00Z', dirty: true }), 'build 64585f8+, 25 Oct 2026');
});

test('version line: without build information it reads as before', () => {
  assert.equal(versionLine(state, null), 'Game 1.0.0-beta.2 · desktop app 1.0.0-beta.2 · Beta channel');
  assert.equal(versionLine({ ...state, info: null, game: null, channel: 'stable' }, null), 'Game version unknown · Stable channel');
});
