import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { fromBase64, sealBox, sealForGitHub, sealNonce, sealOpen, SEAL_OVERHEAD, toBase64 } from '../src/client/setup/sealed-box';
import { GitHubClient, GitHubError, utf8Base64 } from '../src/client/setup/github';
import {
  CloudSetupError, createEmpire, githubCloudSetup, pendingWorkflow, readiness, SECRET_NAMES, SETUP_INTENT_PATH, setupIntent, sodiumSealer,
  type CloudPlan, type Sealer, type WorkflowSource,
} from '../src/client/setup/cloud-setup';
import { DEFAULT_LIMITS } from '../src/client/setup/model';
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
  platform: 'ios',
  ...over,
});
const workflow: WorkflowSource = { available: true, path: '.github/workflows/agent-empire.yml', content: 'name: Agent Empire (test)\non: workflow_dispatch\n' };

test('cloud setup: creates the private state repo, uploads sealed secrets, installs the workflow and writes a setup intent', async () => {
  const gh = fakeGitHub();
  const steps: string[] = [];
  const p = plan({ providers: { anthropic: 'sk-ant-' + 'A'.repeat(40), openai: 'sk-proj-' + 'B'.repeat(40) } });
  const repo = await createEmpire(p, githubCloudSetup(new GitHubClient('gho_tok', gh.fetchImpl), sodiumSealer, workflow, () => new Date('2026-09-30T12:00:00Z')),
    readiness(sodiumSealer, workflow), (s, st) => steps.push(`${s}:${st}`));
  assert.deepEqual(repo, { owner: 'octo', name: 'agent-empire-state', created: true });
  assert.deepEqual(steps, ['repo:running', 'repo:done', 'secrets:running', 'secrets:done', 'workflow:running', 'workflow:done', 'state:running', 'state:done']);
  const create = gh.calls.find((c) => c.method === 'POST')!;
  assert.equal(create.path, '/user/repos');
  assert.equal(create.body!.private, true);
  assert.equal(create.body!.name, 'agent-empire-state');
  // Secrets: sealed to the repository key; the fake GitHub (holding the private key) can open them.
  assert.deepEqual([...gh.secrets.keys()].sort(), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  for (const [name, value] of [['ANTHROPIC_API_KEY', p.providers.anthropic], ['OPENAI_API_KEY', p.providers.openai]] as const) {
    const s = gh.secrets.get(name)!;
    assert.equal(s.key_id, 'kid-1');
    assert.equal(new TextDecoder().decode(sealOpen(fromBase64(s.encrypted_value), gh.recipient.publicKey, gh.recipient.secretKey)!), value);
  }
  // Keys never appear in plain text in any request, and every request is bearer-authenticated without cookies.
  for (const c of gh.calls) {
    assert.doesNotMatch(JSON.stringify(c.body ?? {}), /sk-ant-|sk-proj-/);
    assert.equal(c.auth, 'Bearer gho_tok');
    assert.equal(c.credentials, 'omit');
  }
  assert.equal(gh.files.get('.github/workflows/agent-empire.yml'), workflow.content);
  const intent = JSON.parse(gh.files.get(SETUP_INTENT_PATH)!);
  assert.deepEqual(intent, {
    schemaVersion: 1, type: 'setup', createdAt: '2026-09-30T12:00:00.000Z', createdBy: { login: 'octo', platform: 'ios' },
    projects: [{ owner: 'octo', name: 'app', defaultBranch: 'main' }], providers: ['anthropic', 'openai'],
    limits: { maxConcurrentJobs: 1, perJobCents: 500, dailyCents: 2000, approveEachJob: true }, changes: 'branches-and-pull-requests-only',
  });
  assert.doesNotMatch(gh.files.get(SETUP_INTENT_PATH)!, /sk-/);
});

test('cloud setup: this build lacks the coordinator workflow, so nothing at all is sent to GitHub', async () => {
  const gh = fakeGitHub();
  const ready = readiness(sodiumSealer, pendingWorkflow);
  assert.deepEqual(ready, [pendingWorkflow.reason]);
  await assert.rejects(createEmpire(plan(), githubCloudSetup(new GitHubClient('t', gh.fetchImpl), sodiumSealer, pendingWorkflow), ready),
    (e: unknown) => e instanceof CloudSetupError && e.code === 'not_ready' && /Nothing was created/.test(e.message) && e.reasons.length === 1);
  assert.equal(gh.calls.length, 0);
  const noCrypto: Sealer = { available: false, reason: 'Encryption library pending approval', seal: () => { throw new Error('unreachable'); } };
  assert.deepEqual(readiness(noCrypto, workflow), ['Encryption library pending approval']);
});

test('cloud setup: an existing private state repo of the same account is reused (resumed setup); a public or foreign one is refused', async () => {
  const reuse = fakeGitHub({ existing: { private: true } });
  const repo = await createEmpire(plan(), githubCloudSetup(new GitHubClient('t', reuse.fetchImpl), sodiumSealer, workflow), []);
  assert.equal(repo.created, false);
  assert.ok(reuse.secrets.has('ANTHROPIC_API_KEY'));
  for (const existing of [{ private: false }, { private: true, owner: 'someone-else' }]) {
    const gh = fakeGitHub({ existing });
    await assert.rejects(createEmpire(plan(), githubCloudSetup(new GitHubClient('t', gh.fetchImpl), sodiumSealer, workflow), []),
      (e: unknown) => e instanceof CloudSetupError && e.code === 'repo_conflict' && e.step === 'repo');
    assert.equal(gh.secrets.size, 0, 'no secret is uploaded to a repository we did not verify');
  }
});

test('cloud setup: a GitHub failure names the step and a plain reason; files are updated with their sha on retry', async () => {
  const gh = fakeGitHub({ failSecret: true });
  await assert.rejects(createEmpire(plan(), githubCloudSetup(new GitHubClient('t', gh.fetchImpl), sodiumSealer, workflow), []),
    (e: unknown) => e instanceof CloudSetupError && e.code === 'github' && e.step === 'secrets' && /permission/.test(e.message));
  const ok = fakeGitHub();
  const setup = githubCloudSetup(new GitHubClient('t', ok.fetchImpl), sodiumSealer, workflow);
  await createEmpire(plan(), setup, []);
  await createEmpire(plan(), setup, []); // second run: files exist, PUT carries their sha
  const puts = ok.calls.filter((c) => c.method === 'PUT' && c.path.includes('/contents/'));
  assert.equal(puts.length, 4);
  assert.equal(puts[2].body!.sha, 'sha-.github/workflows/agent-empire.yml');
  await assert.rejects(setup.uploadSecret({ owner: 'octo', name: 'agent-empire-state', created: false }, 'GITHUB_TOKEN', 'x'), /Unknown secret/);
  await assert.rejects(createEmpire(plan({ providers: { anthropic: '', openai: '' } }), setup, []), /at least one API key/);
});

test('cloud setup: the setup intent carries names and limits only', () => {
  const intent = setupIntent(plan(), new Date(0));
  assert.deepEqual(intent.providers, ['anthropic']);
  assert.doesNotMatch(JSON.stringify(intent), /sk-ant/);
  assert.deepEqual(SECRET_NAMES, { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' });
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
  assert.deepEqual(parseServerAddress('http://localhost.evil.com'), { ok: false, error: 'https_required' });
  assert.deepEqual(parseServerAddress('https://city.example.com/office'), { ok: false, error: 'has_path' });
  assert.deepEqual(parseServerAddress('https://u:p@city.example.com'), { ok: false, error: 'has_path' });
  assert.deepEqual(parseServerAddress('ftp://city.example.com'), { ok: false, error: 'bad_host' });
  assert.deepEqual(parseServerAddress('  '), { ok: false, error: 'empty_host' });
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
