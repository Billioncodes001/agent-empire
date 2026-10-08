/**
 * claude/cloud-exec-setup: automatic Anthropic execution setup for cloud Empires, plus the cloud-installer security
 * review fixes. Everything runs against fakes: a fake Anthropic control plane, FakeGitHub and FakeProvider. No network,
 * no real key, no session, no paid call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import nacl from 'tweetnacl';
import { AnthropicManaged } from '../src/server/providers/anthropic-managed';
import { provisionAnthropicExecution, ProvisionError, WORKER_ENVIRONMENT, WORKER_MARKER } from '../src/cloud/provisioning';
import { AnthropicCloudAdapter } from '../src/cloud/anthropic-adapter';
import { providerFromEnv } from '../src/cloud/cli';
import { initialCloudState, parseStateFiles, PROVISION_RETRY_MS, serializeState } from '../src/cloud/schema';
import { parseIntent, intentPath } from '../src/cloud/intents';
import { MemoryStateStore } from '../src/cloud/store';
import { createEmpire, executionPlan, type CloudPlan, type CreateDeps } from '../src/client/setup/cloud-setup';
import { DEFAULT_LIMITS } from '../src/client/setup/model';
import { toBase64 } from '../src/client/setup/sealed-box';
import { executionStatus } from '../src/client/cloud/map';
import { submitFailureMessage } from '../src/client/cloud/net';
import { RepoError } from '../src/client/cloud/repo';
import { githubApiBase, GITHUB_API } from '../src/client/cloud/api-base';
import { EXECUTION, FakeProvider, harness, intent, makeStore, newJob, push, T0, uuid } from './cloud-fixtures';
import { FakeGitHub } from './fake-github';
// @ts-expect-error -- plain ESM tool without types
import { fixtureFiles, FIXTURE_MARKER } from '../tools/check-no-fixture.mjs';

// ---- A fake Anthropic Managed Agents control plane --------------------------------------------------------------

interface Call { method: string; path: string; headers: Headers; body?: any }
function fakeAnthropic(opts: { agents?: any[]; environments?: any[]; status?: number; loseCreate?: 'agent' | 'environment'; pageSize?: number } = {}) {
  const calls: Call[] = [];
  const agents = [...(opts.agents ?? [])];
  const environments = [...(opts.environments ?? [])];
  let n = 0;
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.anthropic.com');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname + url.search, headers: new Headers(init.headers), body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (opts.status) return json(opts.status, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    const list = url.pathname === '/v1/agents' ? agents : url.pathname === '/v1/environments' ? environments : null;
    if (!list) return json(404, { type: 'error' });
    if (method === 'GET') {
      const archived = url.searchParams.get('include_archived') === 'true';
      const visible = list.filter((item) => archived || item.archived_at == null);
      const size = opts.pageSize ?? 100;
      const start = Number(url.searchParams.get('page') ?? 0);
      const next = start + size < visible.length ? String(start + size) : null;
      return json(200, { data: visible.slice(start, start + size), next_page: next });
    }
    if (method === 'POST') {
      const kind = url.pathname === '/v1/agents' ? 'agent' : 'environment';
      if (kind === 'environment' && environments.some((e) => e.name === body.name)) return json(409, { type: 'error', error: { type: 'invalid_request_error', message: 'name in use' } });
      const id = `${kind === 'agent' ? 'agent' : 'env'}_created${String(++n).padStart(4, '0')}`;
      const item = kind === 'agent'
        ? { type: 'agent', id, version: 1, archived_at: null, multiagent: null, created_at: '2026-10-01T00:00:00Z', ...body, tools: body.tools }
        : { type: 'environment', id, archived_at: null, created_at: '2026-10-01T00:00:00Z', ...body };
      list.push(item);
      if (opts.loseCreate === kind) throw new TypeError('socket hang up'); // created, but the response was lost
      return json(200, item);
    }
    return json(405, {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, agents, environments };
}

const KEY = 'sk-ant-' + 'k'.repeat(40);

test('provisioning: creates the worker agent (Sonnet 5 by default) and an unrestricted cloud environment once, with the beta header, and never a session', async () => {
  const api = fakeAnthropic();
  const result = await provisionAnthropicExecution(new AnthropicManaged(api.fetchImpl), KEY);
  assert.deepEqual(result, { agentId: 'agent_created0001', environmentId: 'env_created0002', agentCreated: true, environmentCreated: true, model: 'claude-sonnet-5' });
  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`), ['GET /v1/agents', 'POST /v1/agents', 'GET /v1/environments', 'POST /v1/environments']);
  for (const c of api.calls) {
    assert.equal(c.headers.get('anthropic-beta'), 'managed-agents-2026-04-01');
    assert.equal(c.headers.get('x-api-key'), KEY);
    assert.ok(!c.path.startsWith('/v1/sessions'), 'no session, no paid work');
    assert.doesNotMatch(JSON.stringify(c.body ?? {}), /sk-ant-/, 'the key is never in a body');
  }
  const agent = api.calls[1].body;
  assert.equal(agent.name, 'Agent Empire worker');
  assert.equal(agent.model, 'claude-sonnet-5', 'owner decision 2026-10-02');
  assert.equal(agent.metadata.agent_empire_model, 'claude-sonnet-5');
  assert.equal(agent.tools[0].default_config, undefined, 'tool approval stays the toolset default (always allow in the sandbox)');
  assert.deepEqual(agent.tools, [{ type: 'agent_toolset_20260401' }], 'satisfies AnthropicManaged.check');
  assert.equal(agent.multiagent, undefined);
  assert.match(agent.system, /Never commit to, push to, merge into or rewrite the default branch/);
  assert.equal(agent.metadata[WORKER_MARKER.key], WORKER_MARKER.agent);
  const env = api.calls[3].body;
  assert.deepEqual(env.config, WORKER_ENVIRONMENT.config);
  assert.equal(env.config.type, 'cloud');
  assert.deepEqual(env.config.networking, { type: 'unrestricted' }, 'owner decision 2026-10-02');
  // Second run: both are found and reused, nothing is created.
  const again = await provisionAnthropicExecution(new AnthropicManaged(api.fetchImpl), KEY);
  assert.deepEqual(again, { agentId: 'agent_created0001', environmentId: 'env_created0002', agentCreated: false, environmentCreated: false, model: 'claude-sonnet-5' });
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 2, 'idempotent');
});

test('provisioning: reuses by marker (even renamed) or exact name across pages; a lost create response is found, not repeated', async () => {
  const usable = { tools: [{ type: 'agent_toolset_20260401' }], multiagent: null, archived_at: null, model: { id: 'claude-sonnet-5' } };
  const filler = Array.from({ length: 5 }, (_, i) => ({ id: `agent_other${String(i).padStart(4, '0')}`, name: `Other ${i}`, ...usable }));
  const api = fakeAnthropic({
    pageSize: 2,
    agents: [...filler, { id: 'agent_renamed0001', name: 'My worker', metadata: { [WORKER_MARKER.key]: WORKER_MARKER.agent }, ...usable }],
    environments: [{ id: 'env_byname0001', name: WORKER_ENVIRONMENT.name, config: { type: 'cloud', networking: { type: 'unrestricted' } }, archived_at: null }],
  });
  const result = await provisionAnthropicExecution(new AnthropicManaged(api.fetchImpl), KEY);
  assert.deepEqual(result, { agentId: 'agent_renamed0001', environmentId: 'env_byname0001', agentCreated: false, environmentCreated: false, model: 'claude-sonnet-5' });
  assert.ok(!api.calls.some((c) => c.method === 'POST'));
  const lost = fakeAnthropic({ loseCreate: 'agent' });
  const after = await provisionAnthropicExecution(new AnthropicManaged(lost.fetchImpl), KEY);
  assert.equal(after.agentId, 'agent_created0001');
  assert.equal(after.agentCreated, false, 'found by the follow-up lookup');
  assert.equal(lost.agents.length, 1, 'created exactly once');
  assert.ok(lost.calls.some((c) => c.method === 'GET' && c.path.includes('include_archived=true')));
});

test('provisioning: unusable or archived resources and a rejected key are user-fixable failures; a timeout is retryable', async () => {
  const multi = fakeAnthropic({ agents: [{ id: 'agent_multi00001', name: 'Agent Empire worker', model: 'claude-sonnet-5', tools: [{ type: 'agent_toolset_20260401' }], multiagent: { type: 'coordinator', agents: [] }, archived_at: null }] });
  await assert.rejects(provisionAnthropicExecution(new AnthropicManaged(multi.fetchImpl), KEY), (e: unknown) => e instanceof ProvisionError && !e.retryable && /multiagent/.test(e.message));
  const archived = fakeAnthropic({ environments: [{ id: 'env_archived0001', name: WORKER_ENVIRONMENT.name, config: { type: 'cloud', networking: { type: 'unrestricted' } }, archived_at: '2026-09-01T00:00:00Z' }] });
  await assert.rejects(provisionAnthropicExecution(new AnthropicManaged(archived.fetchImpl), KEY), (e: unknown) => e instanceof ProvisionError && !e.retryable && /archived/.test(e.message));
  const denied = fakeAnthropic({ status: 401 });
  await assert.rejects(provisionAnthropicExecution(new AnthropicManaged(denied.fetchImpl), KEY), (e: unknown) => e instanceof ProvisionError && !e.retryable && /HTTP 401/.test(e.message) && /No agent session was started/.test(e.message) && !e.message.includes(KEY));
  const slow = (() => new Promise(() => {})) as unknown as typeof fetch;
  await assert.rejects(provisionAnthropicExecution(new AnthropicManaged(slow, 20), KEY), (e: unknown) => e instanceof ProvisionError && e.retryable);
  await assert.rejects(provisionAnthropicExecution(new AnthropicManaged(denied.fetchImpl), ''), (e: unknown) => e instanceof ProvisionError && /ANTHROPIC_API_KEY/.test(e.message));
  // The coordinator adapter can provision with only the Anthropic key; it cannot dispatch without the project token.
  const adapter = providerFromEnv({ ANTHROPIC_API_KEY: KEY }, fakeAnthropic().fetchImpl);
  assert.ok(adapter instanceof AnthropicCloudAdapter && adapter.canProvision && !adapter.canDispatch);
  assert.equal(providerFromEnv({}).canProvision, false);
});

// ---- Coordinator --------------------------------------------------------------------------------------------------

const REPO = { owner: 'fixture', name: 'repo', baseBranch: 'main' };
function provisioningStore(mutate?: (s: ReturnType<typeof initialCloudState>) => void) {
  const state = initialCloudState(T0, { limits: { maxConcurrent: 2, perTaskBudgetCents: 100, dailyBudgetCents: 1000 }, provision: REPO });
  mutate?.(state);
  return new MemoryStateStore(serializeState(state));
}

test('coordinator: a fresh Empire’s first run sets up execution, starts nothing, and jobs are accepted after it', async () => {
  const h = harness(provisioningStore());
  const before = await h.state();
  assert.equal(before.meta.provisioning?.status, 'pending');
  assert.equal(before.meta.execution, undefined);
  // A job sent before the first run is refused honestly, not left to "wait".
  push(h.store, newJob(1, 1));
  const report = await h.tick();
  assert.equal(report.provisioning, 'ready');
  assert.deepEqual(report.dispatched, []);
  assert.deepEqual(h.provider.calls, ['provision'], 'one control-plane call; no dispatch');
  const after = await h.state();
  assert.deepEqual(after.meta.execution, { provider: 'anthropic', repository: REPO, anthropic: { agentId: 'agent_provisioned1', environmentId: 'env_provisioned1' } });
  assert.equal(after.meta.provisioning, undefined);
  assert.equal(after.meta.configRevision, 1);
  assert.equal(after.jobs.jobs.length, 0);
  assert.match(after.journal.entries.find((e) => e.kind === 'intent_rejected')!.message, /still being set up[\s\S]*Submit the job again/);
  assert.match(after.journal.entries.at(-1)!.message, /Execution ready for fixture\/repo[\s\S]*No session was started and nothing was charged/);
  // Now a confirmed job (against revision 1) is queued and dispatched.
  push(h.store, newJob(2, 2, { configRevision: 1 }));
  await h.tick();
  assert.deepEqual(h.provider.calls, ['provision', `dispatch:${uuid(2)}`]);
});

test('coordinator: failures are recorded once, retried hourly when retryable, waited on without a key, and re-requested by intent', async () => {
  const provider = new FakeProvider();
  provider.provisionFails = ['retryable', 'fatal'];
  const h = harness(provisioningStore(), provider);
  assert.equal((await h.tick()).provisioning, 'failed');
  let p = (await h.state()).meta.provisioning!;
  assert.deepEqual([p.status, p.retryable, p.attempts], ['failed', true, 1]);
  await h.tick();
  assert.deepEqual(provider.calls, ['provision'], 'not retried within the hour');
  h.advance(PROVISION_RETRY_MS);
  await h.tick();
  p = (await h.state()).meta.provisioning!;
  assert.deepEqual([p.status, p.retryable, p.attempts, p.message], ['failed', false, 2, 'Anthropic rejected the key.']);
  h.advance(3 * PROVISION_RETRY_MS);
  await h.tick();
  assert.equal(provider.calls.length, 2, 'a user-fixable failure is not retried on its own');
  const status = executionStatus(await h.state());
  assert.equal(status.kind, 'failed');
  assert.match(status.detail, /Anthropic rejected the key\.[\s\S]*Set up automatically/);
  // The user fixed it and asks again from Limits.
  push(h.store, intent(5, { kind: 'provision', repository: REPO, configRevision: 0 } as any));
  await h.tick();
  assert.equal((await h.state()).meta.execution?.anthropic.agentId, 'agent_provisioned1');
  // No key at all: nothing is called, and the state says why.
  const keyless = new FakeProvider();
  keyless.canProvision = false;
  const k = harness(provisioningStore(), keyless);
  assert.equal((await k.tick()).provisioning, 'waiting_for_key');
  assert.deepEqual(keyless.calls, []);
  assert.match((await k.state()).meta.provisioning!.message!, /ANTHROPIC_API_KEY[\s\S]*or choose OpenAI/);
});

test('coordinator: a provision intent is refused while jobs are queued or running, and rejects a stale revision', async () => {
  const h = harness(makeStore());
  push(h.store, newJob(1, 1));
  await h.tick();
  push(h.store, intent(2, { kind: 'provision', repository: REPO, configRevision: 0 } as any), intent(3, { kind: 'provision', repository: REPO, configRevision: 9 } as any));
  const report = await h.tick();
  assert.deepEqual(report.intents.map((i) => `${i.outcome}`), ['rejected', 'rejected']);
  assert.match(report.intents[0].reason!, /Cancel or finish queued and active jobs/);
  assert.match(report.intents[1].reason!, /Settings changed/);
  assert.throws(() => parseIntent(intentPath(uuid(7)), JSON.stringify({ schemaVersion: 1, id: uuid(7), createdAt: 1, kind: 'provision', repository: { owner: 'a', name: '', baseBranch: 'main' }, configRevision: 0 })), /owner, a name and a base branch/);
});

test('coordinator: a job for a site that is not built is refused; founding first makes it valid (review note a)', async () => {
  const h = harness(makeStore());
  push(h.store, newJob(1, 1, { site: 'cafe' }));
  const first = await h.tick();
  assert.equal(first.intents[0].outcome, 'rejected');
  assert.match(first.intents[0].reason!, /not built in your city[\s\S]*nothing was charged/);
  push(h.store, intent(2, { kind: 'empire_action', action: { kind: 'found', sites: ['cafe'] } } as any), newJob(3, 3, { site: 'cafe' }));
  const second = await h.tick();
  assert.deepEqual(second.intents.map((i) => i.outcome), ['applied', 'applied']);
  push(h.store, newJob(4, 4, { site: 'hq' }));
  assert.equal((await h.tick()).intents[0].outcome, 'applied', 'headquarters is always built');
});

test('schema: provisioning round-trips, is refused when malformed, and never holds a secret field', () => {
  const state = initialCloudState(T0, { provision: REPO });
  const files = serializeState(state);
  assert.deepEqual(parseStateFiles(files, T0).state.meta.provisioning, { provider: 'anthropic', repository: REPO, status: 'pending', model: 'claude-sonnet-5', requestedAt: T0, attempts: 0 });
  const meta = JSON.parse(files['state/meta.json']);
  for (const bad of [{ ...meta.provisioning, apiKey: 'x' }, { ...meta.provisioning, status: 'ok' }, { ...meta.provisioning, repository: { owner: 'x' } }])
    assert.throws(() => parseStateFiles({ ...files, 'state/meta.json': JSON.stringify({ ...meta, provisioning: bad }) }, T0));
  assert.equal(initialCloudState(T0, { provision: REPO, execution: EXECUTION }).meta.provisioning, undefined, 'explicit settings win');
});

// ---- Installer / setup ----------------------------------------------------------------------------------------------

const STATE_REPO = 'octo/agent-empire-state';
const BUNDLE = '// coordinator bundle (test)\nexport {};\n';
const plan = (over: Partial<CloudPlan> = {}): CloudPlan => ({
  login: 'octo',
  projects: [{ owner: 'octo', name: 'app', private: true, defaultBranch: 'trunk' }, { owner: 'octo', name: 'site', private: true, defaultBranch: 'main' }],
  providers: { anthropic: 'sk-ant-' + 'A'.repeat(40), openai: '' },
  limits: { ...DEFAULT_LIMITS },
  interval: 30,
  platform: 'web',
  ...over,
});
function github() {
  const gh = new FakeGitHub();
  gh.login = 'octo';
  gh.publicKey = toBase64(nacl.box.keyPair().publicKey);
  return gh;
}
const deps = (gh: FakeGitHub): CreateDeps => ({ fetch: gh.fetch, bundle: async () => BUNDLE, now: () => Date.parse('2026-10-01T12:00:00Z'), sleep: async () => {} });

test('setup: a new Empire asks its coordinator to set up execution for the first project, in the starting state', async () => {
  const gh = github();
  const steps: string[] = [];
  const repo = await createEmpire(plan(), 't', deps(gh), (s, st, d) => st !== 'running' && steps.push(`${s}:${st}${d ? `:${d}` : ''}`));
  assert.equal(repo.execution, 'requested');
  assert.ok(steps.includes('execution:done:requested: your coordinator creates or reuses them on its first run'));
  const files = gh.files(STATE_REPO);
  const meta = JSON.parse(files['state/meta.json']);
  assert.deepEqual(meta.provisioning.repository, { owner: 'octo', name: 'app', baseBranch: 'trunk' });
  assert.equal(meta.execution, undefined);
  assert.ok(!Object.keys(files).some((f) => f.startsWith('intents/')), 'no intent for a new Empire');
  assert.ok(!gh.requests.some((r) => /anthropic/.test(r.path)), 'setup never calls Anthropic');
  assert.doesNotMatch(files['state/meta.json'], /sk-ant-/);
  assert.match(executionPlan(plan()).note, /octo\/app \(the first of your 2 projects[\s\S]*not a billed item and starts no session/);
});

test('setup: OpenAI-only says jobs can’t run yet; adding an Anthropic key later requests setup through an intent, once', async () => {
  const gh = github();
  const openaiOnly = plan({ providers: { anthropic: '', openai: 'sk-proj-' + 'B'.repeat(40) } });
  const steps: string[] = [];
  const first = await createEmpire(openaiOnly, 't', deps(gh), (s, st, d) => s === 'execution' && st !== 'running' && steps.push(`${st}:${d}`));
  assert.equal(first.execution, 'no_anthropic_key');
  assert.deepEqual(steps, ['skipped:OpenAI only: jobs can’t run until the OpenAI adapter exists']);
  assert.match(executionPlan(openaiOnly).note, /OpenAI-only Empires can’t run jobs until the OpenAI adapter exists/);
  assert.equal(JSON.parse(gh.files(STATE_REPO)['state/meta.json']).provisioning, undefined);
  // Re-running setup with an Anthropic key keeps the Empire and asks its coordinator via an intent.
  const second = await createEmpire(plan(), 't', deps(gh));
  assert.equal(second.alreadyInstalled, true);
  assert.equal(second.execution, 'requested');
  const intents = Object.entries(gh.files(STATE_REPO)).filter(([f]) => f.startsWith('intents/'));
  assert.equal(intents.length, 1);
  const parsed = parseIntent(intents[0][0], intents[0][1]);
  assert.equal(parsed.kind, 'provision');
  assert.deepEqual((parsed as any).repository, { owner: 'octo', name: 'app', baseBranch: 'trunk' });
  const third = await createEmpire(plan(), 't', deps(gh));
  assert.equal(third.execution, 'already_requested');
  assert.equal(Object.keys(gh.files(STATE_REPO)).filter((f) => f.startsWith('intents/')).length, 1, 'never requested twice');
  // The coordinator applies it.
  const state = parseStateFiles(Object.fromEntries(Object.entries(gh.files(STATE_REPO)).filter(([f]) => f.startsWith('state/'))), T0).state;
  const store = new MemoryStateStore(serializeState(state));
  push(store, parsed);
  const h = harness(store);
  await h.tick();
  assert.deepEqual((await h.state()).meta.execution?.repository, { owner: 'octo', name: 'app', baseBranch: 'trunk' });
});

test('setup: an Empire with execution already set is left as it is', async () => {
  const gh = github();
  const existing = initialCloudState(Date.parse('2026-09-01T00:00:00Z'), { execution: EXECUTION });
  gh.create(STATE_REPO, true, { 'README.md': '#\n', ...serializeState(existing) });
  const repo = await createEmpire(plan(), 't', deps(gh));
  assert.equal(repo.execution, 'already_configured');
  assert.ok(!Object.keys(gh.files(STATE_REPO)).some((f) => f.startsWith('intents/')));
  assert.deepEqual(JSON.parse(gh.files(STATE_REPO)['state/meta.json']).execution, EXECUTION);
});

test('setup: an empty repository gets README.md only because it is needed, and errors list exactly what was written (review #2)', async () => {
  const gh = github();
  gh.create(STATE_REPO, true, null);
  gh.failures.push({ method: 'PUT', path: /\/actions\/secrets\/ANTHROPIC_API_KEY$/, status: 502, times: 1 });
  await assert.rejects(createEmpire(plan(), 't', deps(gh)), (e: unknown) => e instanceof Error && /Already done on GitHub: added README\.md as the first commit of the empty repository octo\/agent-empire-state\./.test(e.message));
  const full = github();
  full.create(STATE_REPO, true, { 'notes.md': 'mine\n' });
  await createEmpire(plan(), 't', deps(full));
  assert.ok(!full.requests.some((r) => r.method === 'PUT' && r.path.endsWith('/contents/README.md')), 'a non-empty repository gets no README');
});

// ---- Client copy ------------------------------------------------------------------------------------------------------

test('cloud UI: execution status never says jobs “will wait”; only ready execution accepts a paid job', () => {
  const none = executionStatus(initialCloudState(T0));
  const setting = executionStatus(initialCloudState(T0, { provision: REPO }));
  const ready = executionStatus(initialCloudState(T0, { execution: EXECUTION }));
  assert.deepEqual([none.kind, none.canSubmit, setting.kind, setting.canSubmit, ready.kind, ready.canSubmit], ['none', false, 'setting_up', false, 'ready', true]);
  for (const s of [none, setting]) {
    assert.doesNotMatch(s.detail, /will wait|jobs wait/i);
    assert.match(s.detail, /refuse[sd][\s\S]*(nothing is charged|not charged)/);
  }
  assert.match(setting.detail, /not a billed item and starts no session/);
  assert.match(none.detail, /Anthropic, or OpenAI once it is verified/);
});

test('cloud UI: a paid job whose write may have landed tells the user to check Jobs before re-assigning (review note b)', () => {
  const offline = submitFailureMessage('new_job', 'New job “x”', new RepoError('offline', 'Can’t reach GitHub.'));
  assert.match(offline, /may not have been sent[\s\S]*Check Cloud Empire → Jobs first[\s\S]*second paid job/);
  assert.match(submitFailureMessage('new_job', 'New job', new RepoError('github', 'GitHub is having trouble.', 502)), /Check Cloud Empire → Jobs first/);
  assert.equal(submitFailureMessage('new_job', 'New job', new RepoError('forbidden', 'GitHub refused this.', 403)), 'New job: not sent. GitHub refused this.');
  assert.equal(submitFailureMessage('limits', 'New limits', new RepoError('offline', 'Can’t reach GitHub.')), 'New limits: not sent. Can’t reach GitHub.');
});

// ---- Fixture builds (review #1) ------------------------------------------------------------------------------------

test('fixture builds: the client uses api.github.com unless a fixture build defines the override; packaging finds the marker', () => {
  assert.equal(githubApiBase(), GITHUB_API, 'no define, no override (Node, and every non-fixture build)');
  const dir = mkdtempSync(path.join(tmpdir(), 'fixture-check-'));
  try {
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
    writeFileSync(path.join(dir, 'assets/main.js'), 'const a="https://api.github.com";');
    assert.deepEqual(fixtureFiles(dir), []);
    writeFileSync(path.join(dir, 'assets/setup.js'), `const f={marker:"${FIXTURE_MARKER}",api:"http://127.0.0.1:4710"};`);
    assert.deepEqual(fixtureFiles(dir), [path.join('assets', 'setup.js')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
