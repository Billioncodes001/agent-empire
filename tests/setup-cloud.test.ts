import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { fromBase64, sealBox, sealForGitHub, sealNonce, sealOpen, SEAL_OVERHEAD, toBase64 } from '../src/client/setup/sealed-box';
import { GitHubClient, GitHubError, utf8Base64 } from '../src/client/setup/github';
import { createHash } from 'node:crypto';
import { CloudSetupError, createEmpire, loadCoordinatorBundle, planLimits, planSecrets, SECRET_NAMES, type CloudPlan, type CreateDeps } from '../src/client/setup/cloud-setup';
import { actionsEstimate, DEFAULT_LIMITS, initialState, reduce, validateProjectToken } from '../src/client/setup/model';
import { COORDINATOR_BUNDLE_PATH, WORKFLOW_PATH } from '../src/cloud/workflow';
import { FakeGitHub } from './fake-github';
import { LoginFailure, parseServerAddress, revokeDevice, signInToServer } from '../src/client/setup/server-login';

// ---- Sealed box ----------------------------------------------------------------------------------------
// Vectors generated with libsodium 1.0.20 through PHP's ext-sodium (sodium_crypto_box_seed_keypair,
// sodium_crypto_box_seal, sodium_crypto_generichash, sodium_crypto_box) on 2026-09-30. The recipient key pair comes
// from the seed 0x07 × 32, the fixed ephemeral key pair from the seed 0x09 × 32. Our output was also checked the
// other way: sodium_crypto_box_seal_open opened a box sealed by sealForGitHub. No published crypto_box_seal vector
// with a fixed ephemeral key was found, so the fixed-ephemeral vector below is libsodium's own primitives' output.
const RECIPIENT = { pk: 'dh2I7IMEE5Gd/p1NHVbxfmU8jJlAgt9bE3uQoK5u33Q=', sk: 'L605/v1/o+IAqcYm7vWZ5hotBVxIqCiKTn5MS8o5KPg=' };
const LIBSODIUM_SEALED = {
  message: 'Agent Empire sealed-box vector: sk-ant-test-0000',
  sealed: 'iUGRlc/2uAmVUE8HQLXb+3wdPTvMJdGtMEUl+qFH9XdjEd9AoQ1Tv3HYZdg0wB0OikQFAoKybl332GrFCG9Bulm+yGWPu7ZQbCL4BIvJaRqJYAAaLKTzMfO7BQ6kKVM+',
};
const FIXED_EPHEMERAL = {
  esk: 'Po/jqzDAqr9UrNJ289i7vCt8pKlJXSBPJVus9XjHTIY=',
  epk: '7eI5P+Le/Q/3A3mYQcaZsD/WNKm5xBHtdg33vOXVwmc=',
  nonceHex: '57a1013e8382cf2b5c6bc5ca3b288f63a7750c77047c038b',
  message: 'fixed-ephemeral vector',
  sealed: '7eI5P+Le/Q/3A3mYQcaZsD/WNKm5xBHtdg33vOXVwmcm/hY3n8SEM4db8IucY+X0N0PDYuDiDnufARqMJ+HeFHCf9ZfkSw==',
};
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

test('sealed box: opens a box sealed by libsodium (crypto_box_seal)', () => {
  const opened = sealOpen(fromBase64(LIBSODIUM_SEALED.sealed), fromBase64(RECIPIENT.pk), fromBase64(RECIPIENT.sk));
  assert.equal(new TextDecoder().decode(opened!), LIBSODIUM_SEALED.message);
});

test('sealed box: with a fixed ephemeral key it reproduces libsodium byte for byte (nonce = BLAKE2b-192(epk || pk))', () => {
  const pk = fromBase64(RECIPIENT.pk);
  const kp = nacl.box.keyPair.fromSecretKey(fromBase64(FIXED_EPHEMERAL.esk));
  assert.equal(toBase64(kp.publicKey), FIXED_EPHEMERAL.epk);
  assert.equal(hex(sealNonce(kp.publicKey, pk)), FIXED_EPHEMERAL.nonceHex);
  const sealed = sealBox(new TextEncoder().encode(FIXED_EPHEMERAL.message), pk, kp);
  assert.equal(toBase64(sealed), FIXED_EPHEMERAL.sealed);
  assert.ok(kp.secretKey.every((b) => b === 0), 'the ephemeral secret key is wiped after sealing');
});

test('sealed box: round trip, fresh ephemeral keys, tamper and wrong-key detection', () => {
  const recipient = nacl.box.keyPair();
  const a = sealForGitHub(toBase64(recipient.publicKey), 'sk-ant-secret-value');
  const b = sealForGitHub(toBase64(recipient.publicKey), 'sk-ant-secret-value');
  assert.notEqual(a, b, 'every seal uses a new ephemeral key');
  const raw = fromBase64(a);
  assert.equal(raw.length, SEAL_OVERHEAD + 'sk-ant-secret-value'.length);
  assert.equal(new TextDecoder().decode(sealOpen(raw, recipient.publicKey, recipient.secretKey)!), 'sk-ant-secret-value');
  const tampered = raw.slice();
  tampered[40] ^= 1;
  assert.equal(sealOpen(tampered, recipient.publicKey, recipient.secretKey), null);
  const other = nacl.box.keyPair();
  assert.equal(sealOpen(raw, other.publicKey, other.secretKey), null);
  assert.throws(() => sealForGitHub(toBase64(new Uint8Array(31)), 'x'), /unexpected repository public key/);
  assert.doesNotMatch(a, /sk-ant/);
});

// ---- A fake GitHub -------------------------------------------------------------------------------------

interface Call { method: string; path: string; body?: Record<string, unknown>; auth: string | null; credentials?: RequestCredentials }
function fakeGitHub(opts: { existing?: { private: boolean; owner?: string } | null; failSecret?: boolean; repos?: unknown[] } = {}) {
  const recipient = nacl.box.keyPair();
  const calls: Call[] = [];
  const files = new Map<string, string>();
  const secrets = new Map<string, { encrypted_value: string; key_id: string }>();
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.github.com', 'only api.github.com is called');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname + url.search, body, auth: new Headers(init.headers).get('authorization'), credentials: init.credentials });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const p = url.pathname;
    if (p === '/user') return json(200, { login: 'octo', name: 'Octo' });
    if (p === '/user/repos' && method === 'GET') return json(200, opts.repos ?? []);
    if (p === '/user/repos' && method === 'POST') {
      if (opts.existing) return json(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] });
      return json(201, { name: body!.name, owner: { login: 'octo' }, private: body!.private, default_branch: 'main' });
    }
    if (p === '/repos/octo/agent-empire-state' && method === 'GET')
      return opts.existing ? json(200, { name: 'agent-empire-state', owner: { login: opts.existing.owner ?? 'octo' }, private: opts.existing.private, default_branch: 'main' }) : json(404, { message: 'Not Found' });
    if (p === '/repos/octo/agent-empire-state/actions/secrets/public-key') return json(200, { key_id: 'kid-1', key: toBase64(recipient.publicKey) });
    const secret = /^\/repos\/octo\/agent-empire-state\/actions\/secrets\/([A-Z_]+)$/.exec(p);
    if (secret && method === 'PUT') {
      if (opts.failSecret) return json(403, { message: 'Resource not accessible by personal access token' });
      secrets.set(secret[1], body as { encrypted_value: string; key_id: string });
      return new Response(null, { status: 201 });
    }
    const content = /^\/repos\/octo\/agent-empire-state\/contents\/(.+)$/.exec(p);
    if (content && method === 'GET') return files.has(content[1]) ? json(200, { sha: 'sha-' + content[1] }) : json(404, { message: 'Not Found' });
    if (content && method === 'PUT') {
      files.set(content[1], Buffer.from(String(body!.content), 'base64').toString('utf8'));
      return json(201, { content: { path: content[1] } });
    }
    return json(404, { message: 'Not Found (fake)' });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, files, secrets, recipient };
}

const plan = (over: Partial<CloudPlan> = {}): CloudPlan => ({
  login: 'octo',
  projects: [{ owner: 'octo', name: 'app', private: true, defaultBranch: 'main' }],
  providers: { anthropic: 'sk-ant-' + 'A'.repeat(40), openai: '' },
  limits: { ...DEFAULT_LIMITS },
  interval: 30,
  platform: 'ios',
  ...over,
});
const BUNDLE = '// coordinator bundle (test)\nexport {};\n';
const STATE_REPO = 'octo/agent-empire-state';
function github() {
  const gh = new FakeGitHub();
  gh.login = 'octo';
  const recipient = nacl.box.keyPair();
  gh.publicKey = toBase64(recipient.publicKey);
  return { gh, recipient };
}
const deps = (gh: FakeGitHub, extra: Partial<CreateDeps> = {}): CreateDeps => ({ fetch: gh.fetch, bundle: async () => BUNDLE, now: () => Date.parse('2026-10-01T12:00:00Z'), sleep: async () => {}, ...extra });

test('cloud setup: “Create my Empire” runs the real installer against a fake GitHub, with sealed secrets, state, bundle and workflow last', async () => {
  const { gh, recipient } = github();
  const steps: string[] = [];
  const p = plan({ providers: { anthropic: 'sk-ant-' + 'A'.repeat(40), openai: 'sk-proj-' + 'B'.repeat(40) }, projectToken: 'github_pat_' + 'C'.repeat(40), interval: 60 });
  const repo = await createEmpire(p, 'gho_tok', deps(gh), (s, st) => steps.push(`${s}:${st}`));
  assert.deepEqual(repo, { owner: 'octo', name: 'agent-empire-state', created: true, alreadyInstalled: false, execution: 'requested' });
  assert.deepEqual(steps, ['repo:running', 'repo:done', 'secrets:running', 'secrets:done', 'state:running', 'state:done', 'execution:running', 'execution:done', 'workflow:running', 'workflow:done', 'verify:running', 'verify:done']);
  const create = gh.requests.find((c) => c.method === 'POST' && c.path === '/user/repos')!;
  assert.equal(create.body.private, true);
  assert.equal(create.body.name, 'agent-empire-state');
  // Secrets are real libsodium sealed boxes: the repository's key pair opens them.
  const stored = gh.repos.get(STATE_REPO)!.secrets;
  assert.deepEqual([...stored.keys()].sort(), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PROJECT_GITHUB_TOKEN']);
  for (const [name, value] of [['ANTHROPIC_API_KEY', p.providers.anthropic], ['OPENAI_API_KEY', p.providers.openai], ['PROJECT_GITHUB_TOKEN', p.projectToken!]] as const)
    assert.equal(new TextDecoder().decode(sealOpen(fromBase64(stored.get(name)!.encrypted_value), recipient.publicKey, recipient.secretKey)!), value);
  for (const c of gh.requests) {
    assert.doesNotMatch(JSON.stringify(c.body ?? {}), /sk-ant-|sk-proj-|github_pat_/, `${c.method} ${c.path} carries no plaintext key`);
    assert.equal(c.auth, 'Bearer gho_tok');
  }
  const files = gh.files(STATE_REPO);
  assert.equal(files[COORDINATOR_BUNDLE_PATH], BUNDLE, 'the shipped bundle is committed where the workflow runs it');
  assert.match(files[WORKFLOW_PATH], /cron: '7 \* \* \* \*'/, 'the chosen schedule');
  const meta = JSON.parse(files['state/meta.json']);
  assert.deepEqual(meta.limits, { maxConcurrent: 1, perTaskBudgetCents: 500, dailyBudgetCents: 2000 });
  assert.equal(meta.schedule.billedMinutesPerMonth, 720);
  assert.equal(JSON.parse(files['state/jobs.json']).jobs.length, 0, 'setup never queues paid work');
  assert.equal(gh.repos.get(STATE_REPO)!.dispatches.length, 0, 'setup never triggers a run');
  assert.ok(!gh.requests.some((r) => /dispatches|actions\/workflows/.test(r.path)), 'no workflow is enabled, dispatched or run');
  const repoState = gh.repos.get(STATE_REPO)!;
  assert.equal(repoState.commits.get(repoState.ref)!.message, 'Agent Empire: install the coordinator workflow', 'the workflow is the last commit');
  assert.ok(!Object.keys(files).some((f) => f.startsWith('intents/')), 'no intent is written by setup');
});

test('cloud setup: a build without its coordinator, or with a mismatched one, creates nothing on GitHub', async () => {
  const { gh } = github();
  const missing = (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(createEmpire(plan(), 't', deps(gh, { bundle: () => loadCoordinatorBundle(missing) })),
    (e: unknown) => e instanceof CloudSetupError && e.code === 'not_ready' && /Nothing was created/.test(e.message) && e.reasons.length === 1);
  const html = '<!doctype html><title>app</title>';
  const lying = (async (u: string) => u.endsWith('.json')
    ? new Response(JSON.stringify({ file: 'agent-empire-coordinator.mjs', bytes: 999, sha256: 'a'.repeat(64) }), { status: 200 })
    : new Response(html, { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(createEmpire(plan(), 't', deps(gh, { bundle: () => loadCoordinatorBundle(lying) })), (e: unknown) => e instanceof CloudSetupError && e.code === 'not_ready' && /does not match/.test(e.reasons[0]));
  assert.equal(gh.requests.length, 0, 'no GitHub call at all');
  // The real manifest format is accepted.
  const sha = createHash('sha256').update(BUNDLE).digest('hex');
  const good = (async (u: string) => u.endsWith('.json') ? new Response(JSON.stringify({ file: 'x', bytes: Buffer.byteLength(BUNDLE), sha256: sha })) : new Response(BUNDLE)) as unknown as typeof fetch;
  assert.equal(await loadCoordinatorBundle(good), BUNDLE);
});

test('cloud setup: after a failure, Try again resumes; the repository is reused and finished steps are skipped', async () => {
  const { gh } = github();
  gh.failures.push({ method: 'PUT', path: /\/actions\/secrets\/ANTHROPIC_API_KEY$/, status: 502, times: 1 });
  const first: string[] = [];
  await assert.rejects(createEmpire(plan(), 't', deps(gh), (s, st) => first.push(`${s}:${st}`)),
    (e: unknown) => e instanceof CloudSetupError && e.code === 'github' && e.step === 'secrets' && /GitHub is having trouble/.test(e.message));
  assert.deepEqual(first, ['repo:running', 'repo:done', 'secrets:running']);
  // A ref update failing during the workflow commit (after state was committed).
  let refPatches = 0;
  const second: [string, string, string?][] = [];
  const failOnWorkflow = { method: 'POST', path: /\/git\/trees$/, status: 503, times: 0 };
  gh.failures.push(failOnWorkflow);
  const origFetch = gh.fetch;
  const counting = (async (input: string, init: RequestInit = {}) => {
    if ((init.method ?? 'GET') === 'PATCH') refPatches++;
    if ((init.method ?? 'GET') === 'POST' && String(input).endsWith('/git/trees') && refPatches === 1) failOnWorkflow.times = 1;
    return origFetch(input, init);
  }) as unknown as typeof fetch;
  await assert.rejects(createEmpire(plan(), 't', deps(gh, { fetch: counting }), (s, st, d) => second.push([s, st, d])), (e: unknown) => e instanceof CloudSetupError && e.step === 'workflow');
  assert.deepEqual(second.filter(([, st]) => st !== 'running').map(([s, st, d]) => `${s}:${st}:${d}`), ['repo:done:already there', 'secrets:done:ANTHROPIC_API_KEY', 'state:done:initial state written', 'execution:done:requested: your coordinator creates or reuses them on its first run']);
  assert.equal(gh.requests.filter((r) => r.method === 'POST' && r.path === '/user/repos').length, 1, 'the repository is created once');
  const third: [string, string, string?][] = [];
  const repo = await createEmpire(plan(), 't', deps(gh), (s, st, d) => third.push([s, st, d]));
  assert.equal(repo.alreadyInstalled, true);
  assert.deepEqual(third.filter(([, st]) => st !== 'running').map(([s, st]) => `${s}:${st}`), ['repo:done', 'secrets:done', 'state:skipped', 'execution:skipped', 'workflow:done', 'verify:done']);
  const fourth: string[] = [];
  await createEmpire(plan(), 't', deps(gh), (s, st) => st !== 'running' && fourth.push(`${s}:${st}`));
  assert.deepEqual(fourth, ['repo:done', 'secrets:done', 'state:skipped', 'execution:skipped', 'workflow:skipped', 'verify:done'], 'a complete install is left as it is');
  assert.equal(JSON.parse(gh.files(STATE_REPO)['state/meta.json']).createdAt, Date.parse('2026-10-01T12:00:00Z'), 'the Empire written first is kept');
});

test('cloud setup: a repository the user created (even empty) is reused; a token that cannot create one is told what to do', async () => {
  const { gh } = github();
  gh.createStatus = 403;
  await assert.rejects(createEmpire(plan(), 't', deps(gh)), (e: unknown) => e instanceof CloudSetupError && e.code === 'repo_conflict' && e.step === 'repo' && /Create a private repository named agent-empire-state/.test(e.message));
  assert.equal(gh.repos.size, 0);
  gh.create(STATE_REPO, true, null); // created on github.com without a README: no commits
  const repo = await createEmpire(plan(), 't', deps(gh));
  assert.equal(repo.created, false);
  assert.ok(gh.requests.some((r) => r.method === 'PUT' && r.path.endsWith('/contents/README.md')), 'an empty repository gets a first commit through the Contents API');
  assert.ok(gh.files(STATE_REPO)['state/meta.json']);
});

test('cloud setup: waits for GitHub to finish creating the repository; refuses public or foreign ones before any secret', async () => {
  const slow = github().gh;
  slow.autoInitDelay = 2;
  await createEmpire(plan(), 't', deps(slow));
  assert.ok(slow.files(STATE_REPO)['state/meta.json']);
  const never = github().gh;
  never.autoInitDelay = 99;
  await assert.rejects(createEmpire(plan(), 't', deps(never)), (e: unknown) => e instanceof CloudSetupError && e.step === 'repo' && /hasn’t finished creating/.test(e.message));
  const pub = github().gh;
  pub.create(STATE_REPO, false);
  await assert.rejects(createEmpire(plan(), 't', deps(pub)), (e: unknown) => e instanceof CloudSetupError && e.code === 'repo_conflict' && /public/.test(e.message));
  assert.equal(pub.repos.get(STATE_REPO)!.secrets.size, 0, 'no secret is uploaded to a repository we did not verify');
  const foreign = github().gh;
  foreign.create(STATE_REPO, true).owner = 'someone-else';
  await assert.rejects(createEmpire(plan(), 't', deps(foreign)), (e: unknown) => e instanceof CloudSetupError && e.code === 'repo_conflict');
  assert.equal(foreign.repos.get(STATE_REPO)!.secrets.size, 0);
  const foreignState = github().gh;
  foreignState.create(STATE_REPO, true, { 'state/meta.json': '{"schemaVersion":99}' });
  // Checked at the repository step, before any secret or file is written (security review #2).
  await assert.rejects(createEmpire(plan(), 't', deps(foreignState)), (e: unknown) => e instanceof CloudSetupError && e.step === 'repo' && /not a valid Empire state/.test(e.message) && /Nothing was written to GitHub/.test(e.message));
  assert.equal(foreignState.repos.get(STATE_REPO)!.secrets.size, 0, 'no secret is uploaded next to a state this app cannot use');
  assert.deepEqual(foreignState.writes, [], 'nothing at all is written');
  assert.equal(foreignState.files(STATE_REPO)['state/meta.json'], '{"schemaVersion":99}', 'an unknown state is never overwritten');
  assert.ok(!foreignState.files(STATE_REPO)[WORKFLOW_PATH] && !foreignState.files(STATE_REPO)[COORDINATOR_BUNDLE_PATH], 'nothing is installed that would fail on every run');
});

test('cloud setup: plan → secrets and limits; keys are optional per provider, the project token only when given', async () => {
  assert.deepEqual(planSecrets(plan()), { ANTHROPIC_API_KEY: 'sk-ant-' + 'A'.repeat(40) });
  assert.deepEqual(Object.keys(planSecrets(plan({ projectToken: ' github_pat_x ' }))), ['ANTHROPIC_API_KEY', 'PROJECT_GITHUB_TOKEN']);
  assert.deepEqual(planLimits({ maxConcurrent: 2, perJob: '1.50', daily: '$10', approveEachJob: true }), { maxConcurrent: 2, perTaskBudgetCents: 150, dailyBudgetCents: 1000 });
  const { gh } = github();
  await assert.rejects(createEmpire(plan({ providers: { anthropic: '', openai: '' } }), 't', deps(gh)), /at least one API key/);
  await assert.rejects(createEmpire(plan({ projectToken: 'ghp_classic' + 'x'.repeat(30) }), 't', deps(gh)), (e: unknown) => e instanceof CloudSetupError && e.code === 'invalid' && /fine-grained/.test(e.message));
  assert.equal(gh.requests.length, 0, 'refused before any GitHub call');
  assert.deepEqual(SECRET_NAMES, { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' });
  // An unusable repository key from GitHub is reported plainly at the secrets step, and nothing is stored.
  const bad = github().gh;
  bad.publicKey = 'c2hvcnQ=';
  await assert.rejects(createEmpire(plan(), 't', deps(bad, { seal: undefined })), (e: unknown) => e instanceof CloudSetupError && e.step === 'secrets' && /could not encrypt your ANTHROPIC_API_KEY/.test(e.message) && /Already done on GitHub: created the private repository octo\/agent-empire-state\./.test(e.message));
  assert.equal(bad.repos.get(STATE_REPO)!.secrets.size, 0);
});

test('setup model: the schedule defaults to 30 minutes and the Actions estimate is compared with the plan', () => {
  assert.equal(initialState().interval, 30);
  const e = actionsEstimate(30, 'free');
  assert.deepEqual([e.runs, e.minutes, e.included, Math.round(e.share! * 100)], [1440, 1440, 2000, 72]);
  assert.equal(actionsEstimate(60, 'pro').share, 720 / 3000);
  assert.equal(actionsEstimate(15, null).included, undefined);
  let s = { ...initialState(), step: 'limits' as const };
  s = reduce(s, { type: 'setInterval', interval: 45 });
  assert.equal(s.interval, 30, 'only 15/20/30/60');
  s = reduce(s, { type: 'setInterval', interval: 15 });
  assert.equal(s.interval, 15);
  assert.equal(validateProjectToken('ghp_' + 'x'.repeat(36)), 'Use a fine-grained token (it starts with github_pat_). Classic tokens grant too much access.');
  assert.equal(validateProjectToken(''), null);
  assert.equal(validateProjectToken('github_pat_' + 'A1_'.repeat(10)), null);
  s = reduce({ ...s, step: 'providers' }, { type: 'setProjectToken', value: 'github_pat_' + 'Z'.repeat(30) });
  assert.equal(reduce(s, { type: 'forgetSecrets' }).projectToken, '', 'forgotten with the API keys');
  assert.equal(reduce(s, { type: 'changeMode' }).projectToken, '');
});

test('GitHub client: repositories are listed with push permission; errors become plain messages; paths are validated', async () => {
  const gh = fakeGitHub({
    repos: [
      { name: 'app', owner: { login: 'octo' }, private: true, default_branch: 'trunk', permissions: { push: true }, pushed_at: '2026-09-01T00:00:00Z' },
      { name: 'lib', owner: { login: 'org' }, private: false, permissions: { pull: true } },
    ],
  });
  const client = new GitHubClient('t', gh.fetchImpl);
  const { repos, more } = await client.listRepos();
  assert.equal(more, false);
  assert.deepEqual(repos.map((r) => [r.owner, r.name, r.private, r.defaultBranch, r.canPush]), [['octo', 'app', true, 'trunk', true], ['org', 'lib', false, 'main', false]]);
  assert.match(gh.calls[0].path, /^\/user\/repos\?per_page=100&page=1&sort=pushed&affiliation=owner%2Ccollaborator%2Corganization_member$/);
  const unauthorized = new GitHubClient('t', (async () => new Response('{"message":"Bad credentials"}', { status: 401 })) as unknown as typeof fetch);
  await assert.rejects(unauthorized.user(), (e: unknown) => e instanceof GitHubError && e.status === 401 && /link GitHub again/.test(e.message));
  const offline = new GitHubClient('t', (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch);
  await assert.rejects(offline.user(), /Can’t reach GitHub/);
  await assert.rejects(client.getRepo('../etc', 'x'), /Invalid repository/);
  await assert.rejects(client.putFile('octo', 'agent-empire-state', '../x', '', 'm'), /Invalid file path/);
  assert.throws(() => new GitHubClient('has space'), /token/);
  assert.equal(Buffer.from(utf8Base64('Empire ✓'), 'base64').toString('utf8'), 'Empire ✓');
});

// ---- Server path ---------------------------------------------------------------------------------------

test('server address: bare hosts mean https, http only for loopback, no paths or credentials', () => {
  assert.deepEqual(parseServerAddress('City.Example.com'), { ok: true, host: 'https://city.example.com' });
  assert.deepEqual(parseServerAddress(' https://city.example.com:8443/ '), { ok: true, host: 'https://city.example.com:8443' });
  assert.deepEqual(parseServerAddress('http://127.0.0.1:4707'), { ok: true, host: 'http://127.0.0.1:4707' });
  assert.deepEqual(parseServerAddress('http://localhost:4707'), { ok: true, host: 'http://localhost:4707' });
  assert.deepEqual(parseServerAddress('http://city.example.com'), { ok: false, error: 'https_required' });
  assert.deepEqual(parseServerAddress('http://10.0.2.2:4713'), { ok: false, error: 'https_required' }, 'the emulator alias only in the Android app');
  assert.deepEqual(parseServerAddress('http://10.0.2.2:4713', { platform: 'android', devBuild: true }), { ok: true, host: 'http://10.0.2.2:4713' });
  assert.deepEqual(parseServerAddress('http://10.0.2.3:4713', { platform: 'android', devBuild: true }), { ok: false, error: 'https_required' });
  assert.deepEqual(parseServerAddress('http://localhost.evil.com'), { ok: false, error: 'https_required' });
  assert.deepEqual(parseServerAddress('https://city.example.com/office'), { ok: false, error: 'has_path' });
  assert.deepEqual(parseServerAddress('https://u:p@city.example.com'), { ok: false, error: 'has_path' });
  assert.deepEqual(parseServerAddress('ftp://city.example.com'), { ok: false, error: 'bad_host' });
  assert.deepEqual(parseServerAddress('  '), { ok: false, error: 'empty_host' });
});

test('server address: a release Android build says plainly that it needs HTTPS (no http at all, not even loopback)', () => {
  for (const address of ['http://10.0.2.2:4713', 'http://localhost:4707', 'http://127.0.0.1:4707', 'http://city.example.com'])
    assert.deepEqual(parseServerAddress(address, { platform: 'android' }), { ok: false, error: 'https_required_android' }, address);
  assert.deepEqual(parseServerAddress('https://city.example.com', { platform: 'android' }), { ok: true, host: 'https://city.example.com' });
  assert.deepEqual(parseServerAddress('http://localhost:4707', { platform: 'android', devBuild: true }), { ok: true, host: 'http://localhost:4707' }, 'debug builds keep their local test hosts');
  const android = new LoginFailure('https_required_android').message;
  assert.match(android, /HTTPS/);
  assert.match(android, /release/i);
  assert.doesNotMatch(android, /localhost\) may use http|unreachable|certificate/i, 'never the generic loopback hint or an "unreachable" message');
  // The generic hint stays where it is true: browsers, iOS and desktop allow http for this device's own loopback address.
  assert.match(new LoginFailure('https_required').message, /localhost/);
  for (const platform of ['ios', 'desktop', null] as const) assert.deepEqual(parseServerAddress('http://localhost:4707', { platform }), { ok: true, host: 'http://localhost:4707' });
});

test('server sign-in: a release Android build refuses an http address before any request, with the HTTPS message', async () => {
  const { fetchImpl, calls } = fakeServer(() => new Response('{}', { status: 200 }));
  await assert.rejects(signInToServer({ host: 'http://10.0.2.2:5041', password: 'pw', deviceName: 'Pixel', platform: 'android' }, fetchImpl), (e: unknown) => e instanceof LoginFailure && e.code === 'https_required_android');
  assert.equal(calls.length, 0, 'never probed, so never reported as unreachable');
});

function fakeServer(login: (body: Record<string, unknown>) => Response, health = () => new Response('{"ok":true}', { status: 200 })) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/api/health')) return health();
    if (url.endsWith('/api/device/login')) return login(JSON.parse(String(init.body)));
    if (/\/api\/devices\//.test(url)) return new Response('{"ok":true}', { status: 200 });
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test('server sign-in: probes health, posts the password once, returns the device session, never uses cookies or redirects', async () => {
  const srv = fakeServer((b) => (b.password === 'pw' ? new Response(JSON.stringify({ token: 'T'.repeat(43), deviceId: 'dev_1' }), { status: 200 }) : new Response('{}', { status: 401 })));
  const session = await signInToServer({ host: 'http://127.0.0.1:4707', password: 'pw', deviceName: 'Fixture iPhone' }, srv.fetchImpl);
  assert.deepEqual(session, { host: 'http://127.0.0.1:4707', token: 'T'.repeat(43), deviceId: 'dev_1' });
  assert.deepEqual(srv.calls.map((c) => c.url), ['http://127.0.0.1:4707/api/health', 'http://127.0.0.1:4707/api/device/login']);
  for (const c of srv.calls) {
    assert.equal(c.init.credentials, 'omit');
    assert.equal(c.init.redirect, 'error');
  }
  assert.deepEqual(JSON.parse(String(srv.calls[1].init.body)), { password: 'pw', deviceName: 'Fixture iPhone' });
  assert.doesNotMatch(srv.calls[1].url, /pw/);
});

test('server sign-in: every failure has a plain reason', async () => {
  const expect = async (code: string, login: () => Response, health?: () => Response, password = 'pw') =>
    assert.rejects(signInToServer({ host: 'https://city.example.com', password, deviceName: 'x' }, fakeServer(login, health).fetchImpl), (e: unknown) => e instanceof LoginFailure && e.code === code);
  const r = (status: number, body = '{}') => () => new Response(body, { status });
  await expect('wrong_password', r(401));
  await expect('rate_limited', r(429));
  await expect('too_many_devices', r(409));
  await expect('server', r(500));
  await expect('bad_response', r(200, '{"token":"short","deviceId":"d"}'));
  await expect('not_empire', r(200), r(404, '<html>'));
  await expect('not_empire', r(200), r(200, '{"ok":false}'));
  await expect('empty_password', r(200), undefined, '');
  await assert.rejects(signInToServer({ host: 'https://x.example', password: 'pw', deviceName: 'x' }, (async () => { throw new TypeError('cert'); }) as unknown as typeof fetch),
    (e: unknown) => e instanceof LoginFailure && e.code === 'unreachable');
  assert.match(new LoginFailure('server', 503).message, /error 503/);
});

test('server sign-in: a session that could not be stored is revoked with its own bearer token', async () => {
  const srv = fakeServer(() => new Response('{}'));
  assert.equal(await revokeDevice({ host: 'https://city.example.com', token: 'T'.repeat(43), deviceId: 'dev 1' }, srv.fetchImpl), true);
  assert.equal(srv.calls[0].url, 'https://city.example.com/api/devices/dev%201');
  assert.equal(srv.calls[0].init.method, 'DELETE');
  assert.equal(new Headers(srv.calls[0].init.headers).get('authorization'), `Bearer ${'T'.repeat(43)}`);
  assert.equal(await revokeDevice({ host: 'https://x', token: 't', deviceId: 'd' }, (async () => { throw new Error('offline'); }) as unknown as typeof fetch), false);
});
