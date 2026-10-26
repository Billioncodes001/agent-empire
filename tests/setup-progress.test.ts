/**
 * DEVICE-BUGS-03 review 5: setup progress survives a reload or a killed app (Android display-size change, a WebView
 * renderer restart, a low-memory kill). Only non-secret choices are kept, in localStorage; tokens and keys never are.
 * A restore never lands past a step whose requirements are missing again (the GitHub token, in-memory API keys, the
 * cost confirmation), and never on "create".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockers, hasCredentials, initialState, reduce, progressSnapshot, restoreProgress, type SetupState } from '../src/client/setup/model';

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
  assert.deepEqual(r.repos, [{ owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch }], "visibility comes from the live list, not storage");
});

test('restore: no token (web, or signed out) goes back to the GitHub step and keeps the choices', () => {
  const r = restoreProgress(initialState(), JSON.parse(JSON.stringify(progressSnapshot(atLimits()))), {});
  assert.equal(r.step, 'github');
  assert.deepEqual(r.repos, [{ owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch }], "visibility comes from the live list, not storage");
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

// ---- Re-check 1: a restored repository's visibility is not trusted ------------------------------------------------

test('restore: repositories come back without their saved visibility, so the public-repo runner guard fails closed', () => {
  const snap = JSON.parse(JSON.stringify(progressSnapshot(atLimits())));
  snap.repos[0].private = true; // whatever was saved (or edited in localStorage)
  const r = restoreProgress(initialState(), snap, { token: 'gho_Y', login: 'octo' });
  assert.equal(r.repos[0].private, undefined, 'visibility is unknown until the live list says');
  const selfHosted = reduce(reduce({ ...r, step: 'providers' }, { type: 'setEngine', engine: 'qwen-free' }), { type: 'setFree', patch: { selfHostedLabel: 'my-runner' } });
  assert.ok(blockers({ ...selfHosted, projectToken: 'github_pat_' + 'A'.repeat(82) }).some((b) => /not known to be private/.test(b)), 'the self-hosted runner is refused until visibility is known');
});

const listing = (over: Partial<{ owner: string; name: string; private: boolean; defaultBranch: string; canPush: boolean }> = {}) => ({ owner: 'octo', name: 'shop', private: false, defaultBranch: 'trunk', canPush: true, ...over });

test('projects list: selected repositories take their visibility and default branch from the live list', () => {
  const s = { ...initialState(), step: 'repos' as const, mode: 'cloud' as const, repos: [{ owner: 'octo', name: 'shop', defaultBranch: 'main' } as never] };
  const r = reduce(s, { type: 'reposListed', repos: [listing()], complete: true });
  assert.deepEqual(r.repos, [{ owner: 'octo', name: 'shop', private: false, defaultBranch: 'trunk' }]);
  assert.deepEqual(r.droppedRepos ?? [], []);
});

test('projects list: a selected repository that is gone or read-only is dropped and named', () => {
  const two = [{ owner: 'octo', name: 'shop', private: true, defaultBranch: 'main' }, { owner: 'octo', name: 'gone', private: true, defaultBranch: 'main' }];
  const s = { ...initialState(), step: 'repos' as const, mode: 'cloud' as const, repos: two };
  const readOnly = reduce(s, { type: 'reposListed', repos: [listing({ canPush: false })], complete: false });
  assert.deepEqual(readOnly.repos.map((x) => x.name), ['gone'], 'read-only: dropped even before the list is complete');
  assert.deepEqual(readOnly.droppedRepos, ['octo/shop (you can’t push to it)']);
  const partial = reduce(s, { type: 'reposListed', repos: [listing()], complete: false });
  assert.deepEqual(partial.repos.map((x) => x.name), ['shop', 'gone'], 'not listed yet is not missing while more pages remain');
  const full = reduce(s, { type: 'reposListed', repos: [listing()], complete: true });
  assert.deepEqual(full.repos.map((x) => x.name), ['shop']);
  assert.deepEqual(full.droppedRepos, ['octo/gone (not found in your account)']);
});

// ---- Re-check (optional): credentials never reach saved progress; restored addresses are re-validated ----------

test('credentials in an address: user:pass@ and key-like query parameters are recognised', () => {
  for (const bad of ['https://ada:hunter2@office.example.com', 'ada:pw@office.example.com', 'https://openrouter.ai/api/v1?api_key=sk-1', 'https://x.example.com/v1?foo=1&access_token=abc', 'https://x.example.com/?key=abc', 'https://x.example.com/?Token=abc', 'https://x.example.com/?password=p'])
    assert.ok(hasCredentials(bad), bad);
  for (const good of ['https://office.example.com', 'office.example.com:8443', 'https://openrouter.ai/api/v1', 'http://127.0.0.1:4600', 'https://x.example.com/?region=eu'])
    assert.ok(!hasCredentials(good), good);
});

test('progress snapshot: an address or provider URL with credentials in it is never saved', () => {
  const s = walk({ type: 'begin' }, { type: 'chooseMode', mode: 'server' }, { type: 'setAddress', address: 'https://ada:hunter2@office.example.com' });
  const snap = progressSnapshot(s);
  assert.equal(snap.server.address, '');
  assert.ok(!JSON.stringify(snap).includes('hunter2'));
  const free = progressSnapshot(reduce(initialState(), { type: 'setFree', patch: { hostedBaseUrl: 'https://openrouter.ai/api/v1?api_key=sk-or-SECRET' } }));
  assert.equal(free.free.hostedBaseUrl, initialState().free.hostedBaseUrl);
  assert.ok(!JSON.stringify(free).includes('sk-or-SECRET'));
});

test('restore: a saved server address is checked again and dropped when it is invalid or carries credentials', () => {
  const saved = (address: string) => ({ ...JSON.parse(JSON.stringify(progressSnapshot(walk({ type: 'begin' }, { type: 'chooseMode', mode: 'server' })))), server: { address } });
  const valid = (a: string) => /^https:\/\/[a-z0-9.-]+$/.test(a);
  assert.equal(restoreProgress(initialState(), saved('https://office.example.com'), {}, { validAddress: valid }).server.address, 'https://office.example.com');
  assert.equal(restoreProgress(initialState(), saved('javascript:alert(1)'), {}, { validAddress: valid }).server.address, '');
  assert.equal(restoreProgress(initialState(), saved('https://ada:pw@office.example.com'), {}, { validAddress: () => true }).server.address, '');
  const url = { ...JSON.parse(JSON.stringify(progressSnapshot(atLimits()))) };
  url.free.hostedBaseUrl = 'https://openrouter.ai/api/v1?token=abc';
  assert.equal(restoreProgress(initialState(), url, {}).free.hostedBaseUrl, initialState().free.hostedBaseUrl);
});
