import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockers, CLOUD_STEPS, initialState, MAX_REPOS, parseCents, progress, reduce, STATE_REPO_NAME, validateLimits, validateProviderKey,
  type Action, type RepoRef, type SetupState,
} from '../src/client/setup/model';
import { decideLaunch, probeOwnOrigin, SIGNED_OUT_NOTICE, type LaunchEnv } from '../src/client/setup/launch';
import { githubClientId } from '../src/client/setup/config';

const repo = (name: string, owner = 'octo'): RepoRef => ({ owner, name, private: true, defaultBranch: 'main' });
const run = (s: SetupState, ...actions: Action[]) => actions.reduce(reduce, s);

// ---- State machine -------------------------------------------------------------------------------------

test('setup: welcome → mode → server path, and back again', () => {
  let s = initialState();
  assert.equal(s.step, 'welcome');
  s = run(s, { type: 'begin' });
  assert.equal(s.step, 'mode');
  assert.deepEqual(blockers(s), ['Choose how your Empire runs.']);
  assert.equal(run(s, { type: 'next' }).step, 'mode', 'next without a mode does nothing');
  s = run(s, { type: 'chooseMode', mode: 'server' });
  assert.equal(s.step, 'server');
  assert.equal(s.mode, 'server');
  assert.deepEqual(progress(s).map((p) => [p.step, p.state]), [['mode', 'done'], ['server', 'current']]);
  s = run(s, { type: 'back' });
  assert.equal(s.step, 'mode');
  assert.equal(run(s, { type: 'back' }).step, 'welcome');
});

test('setup: the cloud path advances only when each step is complete, in order', () => {
  let s = run(initialState(), { type: 'begin' }, { type: 'chooseMode', mode: 'cloud' });
  assert.equal(s.step, 'github');
  assert.equal(run(s, { type: 'next' }).step, 'github', 'GitHub must be linked first');
  s = run(s, { type: 'githubLinked', login: 'octo', token: 'gho_x', via: 'device' }, { type: 'next' });
  assert.equal(s.step, 'repos');
  assert.equal(run(s, { type: 'next' }).step, 'repos', 'a project repository is required');
  s = run(s, { type: 'toggleRepo', repo: repo('app') }, { type: 'next' });
  assert.equal(s.step, 'providers');
  assert.match(blockers(s)[0], /at least one API key/);
  s = run(s, { type: 'setProvider', id: 'openai', value: 'sk-proj-' + 'a'.repeat(30) }, { type: 'next' });
  assert.equal(s.step, 'limits');
  s = run(s, { type: 'setLimits', patch: { daily: '1' } });
  assert.deepEqual(blockers(s), ['The daily allowance must be at least the allowance per job.']);
  s = run(s, { type: 'setLimits', patch: { daily: '50' } }, { type: 'next' });
  assert.equal(s.step, 'review');
  assert.equal(run(s, { type: 'next' }).step, 'review', 'costs must be acknowledged');
  s = run(s, { type: 'acceptCosts', value: true }, { type: 'next' });
  assert.equal(s.step, 'create');
  assert.deepEqual(progress(s).map((p) => p.state), ['done', 'done', 'done', 'done', 'done', 'done', 'current']);
  assert.equal(CLOUD_STEPS.at(-1), 'create');
  assert.equal(run(s, { type: 'next' }), s, 'create finishes through its own async work, not "next"');
  assert.equal(run(s, { type: 'back' }).step, 'review');
});

test('setup: leaving the cloud path forgets keys, token, repos and the cost acknowledgement', () => {
  const full = run(initialState(), { type: 'begin' }, { type: 'chooseMode', mode: 'cloud' }, { type: 'githubLinked', login: 'octo', token: 'gho_secret', via: 'token' },
    { type: 'toggleRepo', repo: repo('app') }, { type: 'setProvider', id: 'anthropic', value: 'sk-ant-' + 'k'.repeat(30) }, { type: 'acceptCosts', value: true });
  for (const out of [run({ ...full, step: 'github' }, { type: 'back' }), run({ ...full, step: 'review' }, { type: 'changeMode' })]) {
    assert.equal(out.step, 'mode');
    assert.deepEqual(out.github, {});
    assert.deepEqual(out.repos, []);
    assert.deepEqual(out.providers, { anthropic: '', openai: '' });
    assert.equal(out.acceptedCosts, false);
    assert.doesNotMatch(JSON.stringify(out), /gho_secret|sk-ant-/);
  }
  const chosenServer = run({ ...full, step: 'mode' }, { type: 'chooseMode', mode: 'server' });
  assert.doesNotMatch(JSON.stringify(chosenServer), /gho_secret|sk-ant-/);
  assert.deepEqual(run(full, { type: 'forgetSecrets' }).providers, { anthropic: '', openai: '' });
});

test('setup: repository choice excludes the state repo, caps the count, and resets for another account', () => {
  let s = run(initialState(), { type: 'begin' }, { type: 'chooseMode', mode: 'cloud' }, { type: 'githubLinked', login: 'octo', token: 't', via: 'device' });
  assert.equal(run(s, { type: 'toggleRepo', repo: repo(STATE_REPO_NAME) }).repos.length, 0);
  s = run(s, { type: 'toggleRepo', repo: repo('a') }, { type: 'toggleRepo', repo: repo('A') });
  assert.equal(s.repos.length, 0, 'toggling the same repository (case-insensitive) removes it');
  for (let i = 0; i < MAX_REPOS + 3; i++) s = run(s, { type: 'toggleRepo', repo: repo(`r${i}`) });
  assert.equal(s.repos.length, MAX_REPOS);
  assert.equal(run(s, { type: 'githubLinked', login: 'octo', token: 't2', via: 'device' }).repos.length, MAX_REPOS, 'same account keeps choices');
  assert.equal(run(s, { type: 'githubLinked', login: 'other', token: 't3', via: 'device' }).repos.length, 0, 'another account starts over');
});

test('setup: limits and key formats are validated without any network', () => {
  assert.equal(parseCents('$5'), 500);
  assert.equal(parseCents('12.34'), 1234);
  for (const bad of ['', '-1', '1.234', 'abc', '1e3']) assert.equal(parseCents(bad), null, bad);
  assert.deepEqual(validateLimits({ maxConcurrent: 1, perJob: '5', daily: '20', approveEachJob: true }), []);
  assert.equal(validateLimits({ maxConcurrent: 11, perJob: '0', daily: 'x', approveEachJob: true }).length, 3);
  assert.equal(run(initialState(), { type: 'setLimits', patch: { maxConcurrent: 99 } }).limits.maxConcurrent, 10, 'the stepper clamps');
  assert.equal(validateProviderKey('anthropic', 'sk-ant-' + 'a'.repeat(40)), null);
  assert.match(validateProviderKey('anthropic', 'sk-' + 'a'.repeat(40))!, /sk-ant-/);
  assert.equal(validateProviderKey('openai', 'sk-proj-' + 'a'.repeat(40)), null);
  assert.match(validateProviderKey('openai', 'sk-ant-' + 'a'.repeat(40))!, /OpenAI/);
  assert.match(validateProviderKey('openai', 'sk-abc def')!, /spaces/);
  assert.equal(validateProviderKey('openai', '  '), null, 'empty means "not added"');
});

// ---- Launch decision -----------------------------------------------------------------------------------

function env(over: Partial<LaunchEnv> & { store?: Record<string, string> } = {}): LaunchEnv {
  const store = over.store ?? {};
  return {
    shell: null, hasSession: false, origin: 'https://game.example', probe: async () => 'none',
    get: async (k) => store[k] ?? null,
    ...over,
  };
}

test('launch: an app with no stored mode runs the setup; a stored server session goes straight to the game', async () => {
  assert.deepEqual(await decideLaunch(env({ shell: { platform: 'ios' } })), { kind: 'setup', step: 'welcome' });
  assert.deepEqual(await decideLaunch(env({ shell: { platform: 'ios', mode: 'server' }, hasSession: true })), { kind: 'game' });
  assert.deepEqual(await decideLaunch(env({ shell: { platform: 'android' }, hasSession: true, store: { mode: 'server' } })), { kind: 'game' });
});

test('launch: a signed-out server app returns to the sign-in step with the reason and the last address', async () => {
  const d = await decideLaunch(env({ shell: { platform: 'ios', mode: 'server', signedOut: 'revoked' }, store: { 'server.host': 'https://city.example' } }));
  assert.deepEqual(d, { kind: 'setup', step: 'server', mode: 'server', notice: SIGNED_OUT_NOTICE.revoked, address: 'https://city.example' });
});

test('launch: cloud mode shows the honest pending view with its repository', async () => {
  assert.deepEqual(await decideLaunch(env({ shell: { platform: 'ios', mode: 'cloud' }, store: { 'state.repo': 'octo/agent-empire-state' } })), { kind: 'cloud', repo: 'octo/agent-empire-state' });
  assert.deepEqual(await decideLaunch(env({ store: { mode: 'cloud' } })), { kind: 'cloud', repo: undefined });
});

test('launch (web): a page served by a signed-in server is the game; signed out goes to /login; a static copy runs the setup', async () => {
  assert.deepEqual(await decideLaunch(env({ probe: async () => 'signed-in' })), { kind: 'game' });
  assert.deepEqual(await decideLaunch(env({ probe: async () => 'signed-out' })), { kind: 'redirect', url: '/login' });
  assert.deepEqual(await decideLaunch(env({ probe: async () => { throw new Error('x'); } })), { kind: 'setup', step: 'welcome' });
  assert.deepEqual(await decideLaunch(env({ store: { mode: 'server', 'server.host': 'https://city.example' } })), { kind: 'redirect', url: 'https://city.example/' });
  for (const stored of ['javascript:alert(1)//', 'https://city.example/phish?x=1', 'https://user:pw@city.example', 'data:text/html,x', '//evil.example', 'not a url'])
    assert.deepEqual(await decideLaunch(env({ store: { mode: 'server', 'server.host': stored } })), { kind: 'setup', step: 'welcome' }, `stored host refused: ${stored}`);
  assert.deepEqual(await decideLaunch(env({ store: { mode: 'server', 'server.host': 'https://City.Example:443' } })), { kind: 'redirect', url: 'https://city.example/' }, 'normalised before use');
  const failingStore = env({ get: async () => { throw new Error('storage blocked'); } });
  assert.deepEqual(await decideLaunch(failingStore), { kind: 'setup', step: 'welcome' });
});

test('launch: the same-origin probe maps whoami answers', async () => {
  const f = (status: number, body = '{"ok":true}') => (async () => new Response(body, { status })) as typeof fetch;
  assert.equal(await probeOwnOrigin(f(200)), 'signed-in');
  assert.equal(await probeOwnOrigin(f(401, '{}')), 'signed-out');
  assert.equal(await probeOwnOrigin(f(404, 'nope')), 'none');
  assert.equal(await probeOwnOrigin(f(200, '<html>')), 'none', 'a static host answering index.html is not a server');
  assert.equal(await probeOwnOrigin((async () => { throw new TypeError('offline'); }) as typeof fetch), 'none');
});

test('config: the GitHub client id comes from the build meta and is validated', () => {
  const doc = (content: string | null) => ({ querySelector: () => (content === null ? null : { content }) }) as unknown as Document;
  assert.equal(githubClientId(doc('Ov23li3G3aR4rgZ0lCJ3')), 'Ov23li3G3aR4rgZ0lCJ3');
  assert.equal(githubClientId(doc('')), '');
  assert.equal(githubClientId(doc(null)), '');
  assert.equal(githubClientId(doc('bad id"><script>')), '');
});

test('config: the shipped index.html carries the registered public client id and loads the boot entry', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../src/client/index.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="agent-empire-github-client-id" content="Ov23li3G3aR4rgZ0lCJ3" \/>/);
  assert.match(html, /<script type="module" src="\.\/boot\.ts"><\/script>/);
  assert.doesNotMatch(html, /client[_-]?secret/i);
});
