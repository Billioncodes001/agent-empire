/**
 * DEVICE-BUGS-03 review 5: setup progress survives a reload or a killed app (Android display-size change, a WebView
 * renderer restart, a low-memory kill). Only non-secret choices are kept, in localStorage; tokens and keys never are.
 * A restore never lands past a step whose requirements are missing again (the GitHub token, in-memory API keys, the
 * cost confirmation), and never on "create".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, progressSnapshot, restoreProgress, type SetupState } from '../src/client/setup/model';

const repo = { owner: 'octo', name: 'shop', private: true, defaultBranch: 'main' };
function walk(...actions: Parameters<typeof reduce>[1][]): SetupState {
  return actions.reduce((s, a) => reduce(s, a), initialState());
}
const atLimits = () => walk(
  { type: 'begin' }, { type: 'chooseMode', mode: 'cloud' },
  { type: 'githubLinked', login: 'octo', token: 'gho_SECRET_TOKEN_000', via: 'device', plan: 'free' }, { type: 'next' },
  { type: 'toggleRepo', repo }, { type: 'next' },
  { type: 'setProvider', id: 'anthropic', value: 'sk-ant-SECRET-KEY-000000000000' }, { type: 'next' },
  { type: 'setLimits', patch: { daily: '12.50' } }, { type: 'setInterval', interval: 15 }, { type: 'setProjectToken', value: 'github_pat_SECRET' },
);

test('progress snapshot: non-secret choices only, as plain JSON', () => {
  const s = atLimits();
  assert.equal(s.step, 'limits');
  const snap = progressSnapshot(s);
  const text = JSON.stringify(snap);
  for (const secret of ['gho_SECRET', 'sk-ant-SECRET', 'github_pat_SECRET']) assert.ok(!text.includes(secret), `no ${secret}`);
  assert.equal(snap.step, 'limits');
  assert.equal(snap.mode, 'cloud');
  assert.deepEqual(snap.repos, [repo]);
  assert.equal(snap.limits.daily, '12.50');
  assert.equal(snap.interval, 15);
  assert.equal(snap.github.login, 'octo');
  assert.ok(!('token' in snap.github) && !('providers' in snap) && !('projectToken' in snap) && !('acceptedCosts' in snap));
});

test('restore: with the token back from secure storage, the steps whose requirements still hold are skipped again', () => {
  const snap = JSON.parse(JSON.stringify(progressSnapshot(walk(
    { type: 'begin' }, { type: 'chooseMode', mode: 'cloud' },
    { type: 'githubLinked', login: 'octo', token: 'gho_X', via: 'device' }, { type: 'next' }, { type: 'toggleRepo', repo },
  ))));
  assert.equal(snap.step, 'repos');
  const r = restoreProgress(initialState(), snap, { token: 'gho_FROM_SECURE_STORE', login: 'octo' });
  assert.equal(r.step, 'repos');
  assert.equal(r.github.token, 'gho_FROM_SECURE_STORE');
  assert.deepEqual(r.repos, [repo]);
});

test('restore: no token (web, or signed out) goes back to the GitHub step and keeps the choices', () => {
  const r = restoreProgress(initialState(), JSON.parse(JSON.stringify(progressSnapshot(atLimits()))), {});
  assert.equal(r.step, 'github');
  assert.deepEqual(r.repos, [repo]);
  assert.equal(r.limits.daily, '12.50');
});

test('restore: API keys were in memory only, so a restore past the engine step stops there for the keys', () => {
  const r = restoreProgress(initialState(), JSON.parse(JSON.stringify(progressSnapshot(atLimits()))), { token: 'gho_Y', login: 'octo' });
  assert.equal(r.step, 'providers');
  assert.equal(r.providers.anthropic, '');
  assert.equal(r.limits.daily, '12.50');
});

test('restore: review and create come back at review, with the cost confirmation to give again', () => {
  const free = { ...progressSnapshot(atLimits()), engine: 'qwen-free', step: 'create' };
  const r = restoreProgress(initialState(), JSON.parse(JSON.stringify(free)), { token: 'gho_Z', login: 'octo' });
  assert.ok(['providers', 'limits', 'review'].includes(r.step), r.step);
  assert.notEqual(r.step, 'create');
  assert.equal(r.acceptedCosts, false);
});

test('restore: the server path keeps the typed address; junk and other accounts are ignored', () => {
  const server = progressSnapshot(walk({ type: 'begin' }, { type: 'chooseMode', mode: 'server' }, { type: 'setAddress', address: 'https://office.example.com' }));
  const r = restoreProgress(initialState(), JSON.parse(JSON.stringify(server)), {});
  assert.equal(r.step, 'server');
  assert.equal(r.mode, 'server');
  assert.equal(r.server.address, 'https://office.example.com');
  for (const junk of [null, 'x', 42, { v: 99, step: 'repos' }, { v: 1, step: 'nowhere' }, { v: 1, step: 'repos', mode: 'cloud', repos: 'nope', limits: { daily: {} } }])
    assert.equal(restoreProgress(initialState(), junk, {}).step, 'welcome', JSON.stringify(junk));
  const other = restoreProgress(initialState(), JSON.parse(JSON.stringify(progressSnapshot(atLimits()))), { token: 'gho_W', login: 'someone-else' });
  assert.equal(other.step, 'github', 'a different signed-in account starts at GitHub');
  assert.deepEqual(other.repos, [], 'and does not inherit the other account’s projects');
});
