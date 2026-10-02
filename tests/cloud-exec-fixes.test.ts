/**
 * claude/cloud-exec-fixes: re-review fixes (M1 manual IDs vs automatic setup, M2 the GitHub client-id override, the
 * low findings) and the owner decisions of 2026-10-02 (Sonnet 5 by default, unrestricted networking). Fakes only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import nacl from 'tweetnacl';
import { AnthropicManaged } from '../src/server/providers/anthropic-managed';
import { provisionAnthropicExecution, ProvisionError } from '../src/cloud/provisioning';
import { DEFAULT_WORKER_MODEL, WORKER_MODELS, workerAgentName } from '../src/cloud/worker-spec';
import { initialCloudState, parseStateFiles, serializeState } from '../src/cloud/schema';
import { intentPath, parseIntent } from '../src/cloud/intents';
import { MemoryStateStore } from '../src/cloud/store';
import { attemptProvisioning, recordProvisioning } from '../src/cloud/tick';
import { uuidv7Time } from '../src/client/cloud/uuid';
import { executionStatus } from '../src/client/cloud/map';
import { createEmpire, executionPlan, type CloudPlan } from '../src/client/setup/cloud-setup';
import { DEFAULT_LIMITS } from '../src/client/setup/model';
import { toBase64 } from '../src/client/setup/sealed-box';
import { EXECUTION, FakeProvider, harness, intent, newJob, push, T0, uuid } from './cloud-fixtures';
import { FakeGitHub } from './fake-github';

const REPO = { owner: 'fixture', name: 'repo', baseBranch: 'main' };
const MANUAL = { provider: 'anthropic' as const, repository: REPO, anthropic: { agentId: 'agent_manual00001', environmentId: 'env_manual00001' } };
const store = (mutate?: (s: ReturnType<typeof initialCloudState>) => void) => {
  const state = initialCloudState(T0, { limits: { maxConcurrent: 2, perTaskBudgetCents: 100, dailyBudgetCents: 1000 }, provision: REPO });
  mutate?.(state);
  return new MemoryStateStore(serializeState(state));
};
const configure = (n: number, revision: number) => intent(n, { kind: 'configure', execution: MANUAL, configRevision: revision } as any);

// ---- M1 ---------------------------------------------------------------------------------------------------------------

test('M1: after a failed automatic setup, manual IDs unblock the Empire and jobs are accepted', async () => {
  const provider = new FakeProvider();
  provider.provisionFails = ['fatal'];
  const h = harness(store(), provider);
  await h.tick();
  assert.equal((await h.state()).meta.provisioning?.status, 'failed');
  push(h.store, configure(1, 0));
  await h.tick();
  const state = await h.state();
  assert.equal(state.meta.provisioning, undefined, 'configure withdraws the failed request');
  assert.deepEqual(state.meta.execution, MANUAL);
  assert.match(state.journal.entries.at(-1)!.message, /with the IDs you entered\. The failed automatic setup request was withdrawn\./);
  assert.equal(executionStatus(state).canSubmit, true, 'the app lets the user submit again');
  push(h.store, newJob(2, 2, { configRevision: state.meta.configRevision }));
  const report = await h.tick();
  assert.equal(report.intents[0].outcome, 'applied');
  assert.deepEqual(provider.calls, ['provision', `dispatch:${uuid(2)}`]);
});

test('M1: manual IDs entered while setup is pending are never overwritten by a later setup result', async () => {
  const provider = new FakeProvider();
  const h = harness(store(), provider);
  push(h.store, configure(1, 0)); // applied before the first run's setup attempt
  await h.tick();
  h.advance(2 * 3600_000);
  await h.tick();
  assert.deepEqual(provider.calls, [], 'the withdrawn request is never attempted');
  assert.deepEqual((await h.state()).meta.execution, MANUAL);
  // An outcome computed for the request before it was withdrawn (a slow run racing a configure) is ignored.
  const pending = parseStateFiles(serializeState(initialCloudState(T0, { provision: REPO })), T0).state;
  const outcome = await attemptProvisioning(pending, new FakeProvider());
  const manual = parseStateFiles(serializeState(initialCloudState(T0, { execution: MANUAL })), T0).state;
  assert.deepEqual(recordProvisioning(manual, outcome, { now: T0, runId: 'r' }).meta.execution, MANUAL);
  // So is one for an older request replaced by a newer one (different requestedAt).
  const newer = parseStateFiles(serializeState(initialCloudState(T0 + 5, { provision: REPO })), T0).state;
  assert.equal(recordProvisioning(newer, outcome, { now: T0, runId: 'r' }).meta.provisioning?.status, 'pending');
});

test('M1: “Set up automatically” explicitly replaces manual IDs, and says so', async () => {
  const provider = new FakeProvider();
  const h = harness(new MemoryStateStore(serializeState(initialCloudState(T0, { execution: MANUAL }))), provider);
  push(h.store, intent(1, { kind: 'provision', repository: REPO, model: 'claude-opus-5-5', configRevision: 0 } as any));
  await h.tick();
  const state = await h.state();
  assert.match(state.journal.entries.find((e) => /requested/.test(e.message))!.message, /with Claude Opus 5\.5[\s\S]*replaces the current execution settings/);
  assert.equal(state.meta.execution?.anthropic.agentId, 'agent_provisioned1');
  assert.deepEqual(state.meta.executionProfile, { model: 'claude-opus-5-5', networking: 'unrestricted' });
  assert.deepEqual(provider.models, ['claude-opus-5-5']);
  assert.match(executionStatus(state).detail, /Set up automatically: Claude Opus 5\.5, unrestricted networking[\s\S]*full internet access[\s\S]*untrusted content/);
  // Manual IDs again: the profile is dropped, since the coordinator cannot know what those resources are.
  push(h.store, configure(2, state.meta.configRevision));
  await h.tick();
  const after = await h.state();
  assert.equal(after.meta.executionProfile, undefined);
  assert.match(executionStatus(after).detail, /IDs entered by hand/);
});

// ---- M2 ---------------------------------------------------------------------------------------------------------------

test('M2: every build-time variable the client reads uses the exposed prefix; the old client-id name fails loudly', () => {
  const vite = readFileSync('vite.config.ts', 'utf8');
  const prefix = /envPrefix:\s*'([^']+)'/.exec(vite)?.[1];
  assert.equal(prefix, 'VITE_PUBLIC_');
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.ts$/.test(entry.name)) for (const m of readFileSync(file, 'utf8').matchAll(/\benv\??\.(VITE_[A-Z0-9_]+)/g)) names.add(m[1]);
    }
  };
  walk('src/client');
  assert.ok(names.has('VITE_PUBLIC_AGENT_EMPIRE_GITHUB_CLIENT_ID'), [...names].join(','));
  for (const name of names) assert.ok(name.startsWith(prefix!), `${name} would be invisible to the client build`);
  assert.match(readFileSync('src/client/index.html', 'utf8'), /VITE_PUBLIC_AGENT_EMPIRE_GITHUB_CLIENT_ID/);
  assert.match(vite, /VITE_AGENT_EMPIRE_GITHUB_CLIENT_ID was renamed/);
});

// ---- Lows and owner decisions -----------------------------------------------------------------------------------------

const KEY = 'sk-ant-' + 'k'.repeat(40);
function anthropic(agents: any[] = [], environments: any[] = []) {
  const posts: any[] = [];
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const list = url.pathname === '/v1/agents' ? agents : environments;
    if ((init.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ data: list, next_page: null }), { status: 200 });
    const body = JSON.parse(String(init.body));
    posts.push(body);
    const item = { id: `${url.pathname === '/v1/agents' ? 'agent' : 'env'}_new${String(posts.length).padStart(5, '0')}`, archived_at: null, multiagent: null, ...body };
    list.push(item);
    return new Response(JSON.stringify(item), { status: 200 });
  }) as unknown as typeof fetch;
  return { client: new AnthropicManaged(fetchImpl), posts };
}
const sonnetAgent = { id: 'agent_sonnet00001', name: 'Agent Empire worker', model: { id: 'claude-sonnet-5' }, tools: [{ type: 'agent_toolset_20260401' }], multiagent: null, archived_at: null, metadata: { agent_empire_role: 'worker', agent_empire_model: 'claude-sonnet-5' } };

test('low: an environment reused by name must have the expected networking; a mismatch is reported, not accepted', async () => {
  const limited = anthropic([sonnetAgent], [{ id: 'env_limited00001', name: 'agent-empire-worker', config: { type: 'cloud', networking: { type: 'limited', allowed_hosts: [] } }, archived_at: null }]);
  await assert.rejects(provisionAnthropicExecution(limited.client, KEY), (e: unknown) => e instanceof ProvisionError && !e.retryable && /networking is “limited”, but Agent Empire runs jobs with unrestricted networking/.test(e.message));
  assert.equal(limited.posts.length, 0, 'nothing is created next to it');
  const ok = anthropic([sonnetAgent], [{ id: 'env_open00000001', name: 'agent-empire-worker', config: { type: 'cloud', networking: { type: 'unrestricted' } }, archived_at: null }]);
  assert.equal((await provisionAnthropicExecution(ok.client, KEY)).environmentId, 'env_open00000001');
});

test('owner decision: each model gets its own agent; choosing Opus creates one beside the Sonnet worker, Fable stays selectable', async () => {
  assert.equal(DEFAULT_WORKER_MODEL, 'claude-sonnet-5');
  assert.deepEqual(WORKER_MODELS.map((m) => m.id), ['claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1']);
  const api = anthropic([sonnetAgent], [{ id: 'env_open00000001', name: 'agent-empire-worker', config: { type: 'cloud', networking: { type: 'unrestricted' } }, archived_at: null }]);
  const opus = await provisionAnthropicExecution(api.client, KEY, 'claude-opus-5-5');
  assert.equal(opus.agentCreated, true);
  assert.equal(api.posts[0].name, 'Agent Empire worker (Claude Opus 5.5)');
  assert.equal(api.posts[0].model, 'claude-opus-5-5');
  assert.equal((await provisionAnthropicExecution(api.client, KEY, 'claude-sonnet-5')).agentId, 'agent_sonnet00001', 'the Sonnet worker is untouched and reused');
  assert.equal((await provisionAnthropicExecution(api.client, KEY, 'claude-opus-5-5')).agentCreated, false, 'idempotent per model');
  assert.equal(workerAgentName('claude-fable-5-1'), 'Agent Empire worker (Claude Fable 5.1)');
  // An agent with our exact name but another model is reported, not silently used with the wrong model.
  const clash = anthropic([{ ...sonnetAgent, id: 'agent_clash00001', metadata: {}, name: 'Agent Empire worker (Claude Opus 5.5)' }], []);
  await assert.rejects(provisionAnthropicExecution(clash.client, KEY, 'claude-opus-5-5'), /runs claude-sonnet-5, not claude-opus-5-5/);
  assert.throws(() => parseIntent(intentPath(uuid(9)), JSON.stringify({ schemaVersion: 1, id: uuid(9), createdAt: 1, kind: 'provision', repository: REPO, model: 'claude-haiku-4-5', configRevision: 0 })), /Unsupported worker model/);
});

const STATE_REPO = 'octo/agent-empire-state';
const plan = (over: Partial<CloudPlan> = {}): CloudPlan => ({
  login: 'octo', projects: [{ owner: 'octo', name: 'app', private: true, defaultBranch: 'main' }],
  providers: { anthropic: 'sk-ant-' + 'A'.repeat(40), openai: '' }, limits: { ...DEFAULT_LIMITS }, interval: 30, platform: 'web', ...over,
});
const NOW = Date.parse('2026-10-02T12:00:00Z');
function github() {
  const gh = new FakeGitHub();
  gh.login = 'octo';
  gh.publicKey = toBase64(nacl.box.keyPair().publicKey);
  return gh;
}
const deps = (gh: FakeGitHub) => ({ fetch: gh.fetch, bundle: async () => '// bundle\n', now: () => NOW, sleep: async () => {} });

test('low: re-running setup after a failed automatic setup writes a fresh UUIDv7 provision intent (once)', async () => {
  const gh = github();
  const failed = initialCloudState(Date.parse('2026-10-01T00:00:00Z'), { provision: { owner: 'octo', name: 'app', baseBranch: 'main' } });
  failed.meta.provisioning = { ...failed.meta.provisioning!, status: 'failed', retryable: false, attempts: 1, message: 'Anthropic rejected the key.' };
  gh.create(STATE_REPO, true, { 'README.md': '#\n', ...serializeState(failed) });
  const first = await createEmpire(plan(), 't', deps(gh));
  assert.equal(first.execution, 'requested');
  const intents = Object.entries(gh.files(STATE_REPO)).filter(([f]) => f.startsWith('intents/'));
  assert.equal(intents.length, 1);
  const parsed = parseIntent(intents[0][0], intents[0][1]) as any;
  assert.equal(parsed.kind, 'provision');
  assert.equal(parsed.id[14], '7', 'UUIDv7');
  assert.equal(uuidv7Time(parsed.id), NOW, 'time-ordered by the setup clock');
  assert.equal(parsed.model, 'claude-sonnet-5');
  assert.equal((await createEmpire(plan(), 't', deps(gh))).execution, 'already_requested');
  assert.equal(Object.keys(gh.files(STATE_REPO)).filter((f) => f.startsWith('intents/')).length, 1);
});

test('owner decisions are shown in setup and status: Sonnet 5, full internet access, untrusted content', async () => {
  const note = executionPlan(plan()).note;
  assert.match(note, /with Claude Sonnet 5 \(change the model under Cloud Empire → Limits\)/);
  assert.match(note, /full internet access[\s\S]*fetch untrusted content[\s\S]*approves its own tool use/);
  const setting = executionStatus(initialCloudState(T0, { provision: REPO }));
  assert.match(setting.detail, /agent with Claude Sonnet 5/);
  const gh = github();
  await createEmpire(plan(), 't', deps(gh));
  assert.equal(JSON.parse(gh.files(STATE_REPO)['state/meta.json']).provisioning.model, 'claude-sonnet-5');
  assert.equal(executionStatus(initialCloudState(T0, { execution: EXECUTION })).kind, 'ready');
});
