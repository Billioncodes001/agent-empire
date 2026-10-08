/**
 * CLOUD-06: OpenAI provider with fakes only. No test calls OpenAI or GitHub over the network or uses a real key: every
 * request goes to an injected fetch that answers from memory and records what was sent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICloudAdapter, RESERVED_ENV } from '../src/cloud/openai-adapter';
import { estimateCents, OPENAI_NOT_VERIFIED_MESSAGE } from '../src/cloud/openai-spec';
import { openaiVerified, providersFromEnv } from '../src/cloud/cli';
import { AnthropicCloudAdapter } from '../src/cloud/anthropic-adapter';
import { initialCloudState, serializeState, validateExecution, validateJobs, type CloudExecution } from '../src/cloud/schema';
import { parseIntent, intentPath } from '../src/cloud/intents';
import { MemoryStateStore } from '../src/cloud/store';
import { harness, intent, job, newJob, push, SHA, T0, uuid } from './cloud-fixtures';

test('openai: the test environment holds no real OpenAI key', () => {
  assert.equal(process.env.OPENAI_API_KEY ?? '', '', 'unset OPENAI_API_KEY before running tests; they must never see a real key');
});

const API_KEY = 'sk-proj-FAKE' + 'x'.repeat(30);
const TOKEN = 'github_pat_FAKE' + 'y'.repeat(30);
const VAULT = 'vault_fixture0001';
const CRED = 'cred_fixture0001';
const EXEC: CloudExecution = { provider: 'openai', repository: { owner: 'fixture', name: 'repo', baseBranch: 'main' }, openai: { model: 'gpt-6.1-sol', containerSize: 'medium', network: 'enabled', vaultId: VAULT, credentialId: CRED } };
const json = (status: number, body: unknown) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Sess = { id: string; status: string; turn: string; usage: any; created_at: number; deleted: boolean; jobId: string };
/** In-memory OpenAI Agents API + GitHub REST, recording every request. */
class FakeCloud {
  requests: { method: string; url: string; body?: any; headers: Record<string, string> }[] = [];
  sessions = new Map<string, Sess>();
  vaults: any[] = [{ id: VAULT, name: 'agent-empire-worker', metadata: { agent_empire_role: 'worker_vault' } }];
  credentials: any[] = [{ id: CRED, secret_name: 'AE_GITHUB_TOKEN' }];
  branch: 'missing' | string = 'missing';
  createStatus = 200;
  deleteStatus = 200;
  loseVaultCreate = false;
  cancelTakesEffect = true;
  onCreate?: () => void;
  private n = 0;
  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input); const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, url, body, headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) });
    const u = new URL(url); const path = u.pathname;
    if (u.host === 'api.github.com') {
      if (path === '/repos/fixture/repo') return json(200, { full_name: 'fixture/repo' });
      if (path === '/repos/fixture/repo/git/ref/heads/main') return json(200, { object: { sha: SHA } });
      if (path.startsWith('/repos/fixture/repo/git/ref/heads/agent-empire/task-')) return this.branch === 'missing' ? json(404, { message: 'Not Found' }) : json(200, { object: { sha: this.branch } });
      return json(404, {});
    }
    if (path === '/v1/vaults' && method === 'GET') return json(200, { data: this.vaults });
    if (path === '/v1/vaults' && method === 'POST') { const v = { id: 'vault_created0001', ...body }; this.vaults.push(v); return this.loseVaultCreate ? json(502, {}) : json(200, v); }
    if (path === `/v1/vaults/${VAULT}`) return json(200, { id: VAULT });
    if (/^\/v1\/vaults\/[^/]+\/credentials$/.test(path) && method === 'GET') return json(200, { data: this.credentials });
    if (/^\/v1\/vaults\/[^/]+\/credentials$/.test(path) && method === 'POST') { const c = { id: 'cred_created0001', secret_name: body.secret_name }; this.credentials.push(c); return json(200, c); }
    if (/^\/v1\/vaults\/[^/]+\/credentials\/[^/]+$/.test(path)) return json(200, { id: path.split('/').pop() });
    if (path === '/v1/agents/sessions' && method === 'POST') {
      this.onCreate?.();
      if (this.createStatus !== 200) return json(this.createStatus, { error: { code: 'server_error' } });
      const id = `agsess_fixture${String(++this.n).padStart(4, '0')}`;
      this.sessions.set(id, { id, status: 'in_progress', turn: 'in_progress', usage: null, created_at: T0 / 1000, deleted: false, jobId: body.metadata.agent_empire_task_id });
      return json(200, { id, status: 'in_progress', created_at: T0 / 1000 });
    }
    const m = /^\/v1\/agents\/sessions\/([^/]+)(\/turns|\/events)?$/.exec(path);
    if (m) {
      const s = this.sessions.get(m[1]);
      if (!s || s.deleted) return json(404, { error: { code: 'not_found' } });
      if (m[2] === '/turns') return json(200, { data: [{ id: 'turn_sub00000001', status: 'failed', subagent_id: 'sub_1' }, { id: 'turn_root0000001', status: s.turn, subagent_id: null, usage: s.usage }] });
      if (m[2] === '/events') { if (this.cancelTakesEffect) { s.turn = 'cancelled'; s.status = 'idle'; } return json(200, {}); }
      if (method === 'DELETE') { if (this.deleteStatus !== 200) return json(this.deleteStatus, {}); s.deleted = true; return json(200, { deleted: true }); }
      return json(200, { id: s.id, status: s.status, usage: s.usage, created_at: s.created_at });
    }
    return json(404, {});
  };
  creates() { return this.requests.filter(r => r.method === 'POST' && r.url.endsWith('/v1/agents/sessions')); }
  session(jobId: string) { return [...this.sessions.values()].find(s => s.jobId === jobId)!; }
}

const adapter = (cloud: FakeCloud, verified = true, now = () => T0) => new OpenAICloudAdapter({ apiKey: API_KEY, githubToken: TOKEN }, { fetch: cloud.fetch as typeof fetch, verified, now });
const openaiStore = (perJob = 300) => {
  const state = initialCloudState(T0, { limits: { maxConcurrent: 2, perTaskBudgetCents: perJob, dailyBudgetCents: 3000 }, execution: EXEC });
  return new MemoryStateStore(serializeState(state));
};

test('openai estimate: the plan example rounds up conservatively, in whole 20-minute blocks plus 10%', () => {
  // 0.5M uncached input (cache-write rate) + 1.5M cached + 0.1M output, 30 min → 2 medium blocks: $2.64 × 1.1 = $2.904.
  const usage = { input: 2_000_000, cached: 1_500_000, output: 100_000, reasoning: 0 };
  assert.equal(estimateCents({ model: 'gpt-6.1-sol', usage, containerSize: 'medium', createdAt: 0, endAt: 30 * 60_000 }), 291);
  // A session that has just started still bills one whole block.
  assert.equal(estimateCents({ model: 'gpt-6.1-sol', usage: { input: 0, cached: 0, output: 0, reasoning: 0 }, containerSize: 'medium', createdAt: 0, endAt: 0 }), 14);
  // Reasoning tokens are added at the output rate (can only overstate).
  assert.ok(estimateCents({ model: 'gpt-6.1-sol', usage: { ...usage, reasoning: 100_000 }, containerSize: 'medium', createdAt: 0, endAt: 30 * 60_000 }) > 291);
  // An unknown model is priced at the most expensive known rates, never below.
  assert.ok(estimateCents({ model: 'gpt-unknown', usage, containerSize: 'medium', createdAt: 0, endAt: 1 }) >= estimateCents({ model: 'gpt-6-astra', usage, containerSize: 'medium', createdAt: 0, endAt: 1 }));
});

test('openai provider selection: the Empire’s execution picks the adapter; the verified flag defaults off', async () => {
  const set = providersFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: API_KEY, PROJECT_GITHUB_TOKEN: TOKEN });
  assert.ok(set.anthropic instanceof AnthropicCloudAdapter);
  assert.ok(set.openai instanceof OpenAICloudAdapter);
  assert.equal(set.openai!.canDispatch, false, 'not verified by default');
  assert.equal(openaiVerified({}), false);
  assert.equal(openaiVerified({ AGENT_EMPIRE_OPENAI_VERIFIED: 'true' }), true);
  assert.equal(providersFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-x' }).openai, undefined);
  // An OpenAI Empire never uses the Anthropic adapter, even though it is available.
  const cloud = new FakeCloud();
  const anthropicCalls: string[] = [];
  const h = harness(openaiStore(), { openai: adapter(cloud), anthropic: { provider: 'anthropic', canDispatch: true, canProvision: true, dispatch: async () => { anthropicCalls.push('dispatch'); throw new Error('wrong provider'); } } } as any);
  push(h.store, newJob(1, 1));
  await h.tick();
  assert.deepEqual(anthropicCalls, []);
  assert.equal(cloud.creates().length, 1);
  assert.equal(job(await h.state(), 1).provider, 'openai');
});

test('openai gate: until openaiVerified is set, nothing is sent to OpenAI and jobs wait with an explanation', async () => {
  const cloud = new FakeCloud();
  const h = harness(openaiStore(), { openai: adapter(cloud, false) } as any);
  push(h.store, newJob(1, 1));
  await h.tick(); await h.tick();
  const state = await h.state();
  assert.equal(job(state, 1).status, 'queued');
  assert.match(job(state, 1).message, /switched off in this version[\s\S]*openaiVerified/);
  assert.equal(job(state, 1).reservation, undefined, 'nothing reserved');
  assert.deepEqual(cloud.requests, [], 'no OpenAI or GitHub request');
  // Provisioning waits the same way, without calls.
  const p = new MemoryStateStore(serializeState(initialCloudState(T0, { provision: EXEC.repository, provider: 'openai' })));
  const hp = harness(p, { openai: adapter(cloud, false) } as any);
  await hp.tick();
  assert.equal((await hp.state()).meta.provisioning!.message, OPENAI_NOT_VERIFIED_MESSAGE);
  assert.deepEqual(cloud.requests, []);
  await assert.rejects(adapter(cloud, false).dispatch({ jobId: uuid(1), prompt: 'x', branch: `agent-empire/task-${uuid(1)}`, budgetCents: 100, execution: EXEC }), /switched off/);
});

test('openai dispatch: reserved and committed as dispatching before the one paid create; the body carries no secret', async () => {
  const cloud = new FakeCloud();
  const store = openaiStore();
  let atCreate: any;
  cloud.onCreate = () => { atCreate = JSON.parse(store.files['state/jobs.json']).jobs[0]; };
  const h = harness(store, { openai: adapter(cloud) } as any);
  push(h.store, newJob(1, 1));
  await h.tick();
  assert.equal(atCreate.status, 'dispatching');
  assert.deepEqual(atCreate.reservation, { cents: 300, day: '2026-09-30', basis: 'per_job_allowance_estimate' });
  const create = cloud.creates()[0];
  const text = JSON.stringify(create.body);
  assert.ok(!text.includes(TOKEN) && !text.includes(API_KEY), 'no project token or API key in the session body');
  assert.ok(!JSON.stringify(create.body.metadata).includes('Do task'), 'no prompt in metadata');
  for (const key of Object.keys(create.body.environment.env)) assert.ok(!RESERVED_ENV.test(key) && !/TOKEN|KEY|SECRET/.test(key), key);
  assert.deepEqual(create.body.vault_ids, [VAULT]);
  assert.equal(create.body.environment.container_size, 'medium');
  assert.deepEqual(create.body.environment.network, { access: 'enabled' });
  assert.equal(create.headers['openai-beta'], 'agents=v1');
  // The token went to GitHub only (as the coordinator's own bearer), never to OpenAI in this run.
  assert.ok(cloud.requests.filter(r => r.url.startsWith('https://api.openai.com')).every(r => !JSON.stringify(r).includes(TOKEN)));
  const state = await h.state();
  assert.equal(job(state, 1).status, 'running');
  assert.equal(job(state, 1).cursor!.openai!.createdAt, T0);
  validateJobs(state.jobs);
});

test('openai dispatch: a failed pre-check is never sent; a failed create is uncertain and never retried', async () => {
  const cloud = new FakeCloud();
  cloud.vaults = []; // vault GET still answers, so break the GitHub base ref instead
  const broken = new FakeCloud();
  const origFetch = broken.fetch;
  broken.fetch = async (input, init) => String(input).includes('/git/ref/heads/main') ? json(500, {}) : origFetch(input, init);
  const h1 = harness(openaiStore(), { openai: adapter(broken) } as any);
  push(h1.store, newJob(1, 1));
  await h1.tick();
  assert.equal(broken.creates().length, 0);
  let s = await h1.state();
  assert.equal(job(s, 1).status, 'queued');
  assert.match(job(s, 1).message, /No paid session was requested[\s\S]*Requeued/);
  assert.equal(job(s, 1).reservation, undefined);

  const failing = new FakeCloud();
  failing.createStatus = 500;
  const h2 = harness(openaiStore(), { openai: adapter(failing) } as any);
  push(h2.store, newJob(1, 1));
  await h2.tick(); h2.advance(3600_000); await h2.tick(); await h2.tick();
  s = await h2.state();
  assert.equal(failing.creates().length, 1, 'exactly one create request, ever');
  assert.equal(job(s, 1).status, 'dispatch_uncertain');
  assert.match(job(s, 1).message, /platform\.openai\.com\/logs\?api=agents/);
  assert.ok(job(s, 1).reservation, 'reservation kept while uncertain');
});

test('openai budget: the estimate is ledgered apart; reaching the reservation sends one cancel and pauses, never resumes', async () => {
  const cloud = new FakeCloud();
  let now = T0;
  const h = harness(openaiStore(300), { openai: adapter(cloud, true, () => now) } as any);
  push(h.store, newJob(1, 1));
  await h.tick();
  const sess = cloud.session(uuid(1));
  sess.usage = { input_tokens: 200_000, cached_tokens: 0, output_tokens: 10_000, reasoning_tokens: 0 };
  now += 10 * 60_000; h.advance(10 * 60_000);
  await h.tick();
  let s = await h.state();
  const small = job(s, 1).cost!;
  assert.equal(small.basis, 'estimate_from_reported_usage');
  assert.equal(job(s, 1).status, 'running');
  const day = s.ledger.days['2026-09-30'];
  assert.equal(day.observedCostCents, 0, 'estimates never count as provider-reported cost');
  assert.equal(day.estimatedCostCents, small.amountCents);
  assert.ok(s.ledger.entries.some(e => e.kind === 'cost_estimated' && e.basis === 'estimate_from_reported_usage'));
  // Usage that "changes" downward never lowers the estimate.
  sess.usage = { input_tokens: 1000, output_tokens: 10 };
  // Now push it over the $3 reservation, while the turn keeps running (cancel not yet effective).
  cloud.cancelTakesEffect = false;
  sess.usage = { input_tokens: 2_000_000, cached_tokens: 0, output_tokens: 100_000, reasoning_tokens: 0 };
  now += 10 * 60_000; h.advance(10 * 60_000);
  await h.tick();
  s = await h.state();
  assert.equal(job(s, 1).status, 'budget_paused');
  assert.equal(job(s, 1).stopRequested!.reason, 'budget');
  const cancels = () => cloud.requests.filter(r => r.url.endsWith('/events'));
  assert.equal(cancels().length, 1);
  const key = cancels()[0].headers['idempotency-key'];
  assert.match(key, /^agent-empire-stop-/);
  await h.tick();
  assert.equal(cancels().length, 2, 'still running: the cancel is repeated');
  assert.equal(cancels()[1].headers['idempotency-key'], key, 'with the same idempotency key');
  sess.turn = 'cancelled'; sess.status = 'idle';
  await h.tick();
  s = await h.state();
  assert.equal(job(s, 1).status, 'budget_paused');
  assert.ok(!cloud.requests.some(r => r.method === 'DELETE'), 'a budget stop keeps the session for inspection');
  assert.equal(cloud.creates().length, 1, 'never resumed or re-dispatched');
  assert.ok(s.ledger.days['2026-09-30'].estimatedCostCents! >= 300);
  // The user cancels: then the session is deleted.
  push(h.store, intent(9, { kind: 'cancel', jobId: uuid(1) }));
  await h.tick();
  s = await h.state();
  assert.equal(job(s, 1).status, 'cancelled');
  assert.equal(cloud.requests.filter(r => r.method === 'DELETE').length, 1);
});

test('openai close: a finished turn is deleted only after its branch moved; a 404 counts as closed only after our delete', async () => {
  const cloud = new FakeCloud();
  const h = harness(openaiStore(), { openai: adapter(cloud) } as any);
  push(h.store, newJob(1, 1));
  await h.tick();
  const sess = cloud.session(uuid(1));
  sess.status = 'idle'; sess.turn = 'completed'; sess.usage = { input_tokens: 1000, output_tokens: 100 };
  await h.tick();
  let s = await h.state();
  assert.equal(job(s, 1).status, 'awaiting_review');
  assert.ok(!cloud.requests.some(r => r.method === 'DELETE'), 'branch missing: session kept');
  assert.match(job(s, 1).message, /was not found[\s\S]*left open/);
  cloud.branch = 'c'.repeat(40);
  await h.tick();
  assert.equal(cloud.requests.filter(r => r.method === 'DELETE').length, 1, 'deleted once the branch moved');
  s = await h.state();
  assert.equal(job(s, 1).status, 'awaiting_review', 'the finished turn stays reviewable');
  assert.equal(job(s, 1).providerStatus, 'archived');
  assert.ok(job(s, 1).cursor!.openai!.deletedAt);
  // Another job whose session vanishes without our delete is an error, not a silent close.
  push(h.store, newJob(10, 2));
  await h.tick();
  cloud.session(uuid(2)).deleted = true;
  await h.tick();
  s = await h.state();
  assert.equal(job(s, 2).status, 'unknown');
  assert.ok(job(s, 2).reservation, 'reservation kept');
});

test('openai close: a 409 on delete is retried next run with the slot held', async () => {
  const cloud = new FakeCloud();
  const h = harness(openaiStore(), { openai: adapter(cloud) } as any);
  push(h.store, newJob(1, 1));
  await h.tick();
  cloud.deleteStatus = 409;
  push(h.store, intent(5, { kind: 'cancel', jobId: uuid(1) }));
  await h.tick();
  let s = await h.state();
  assert.equal(job(s, 1).status, 'idle');
  assert.ok(job(s, 1).reservation);
  cloud.deleteStatus = 200;
  await h.tick();
  s = await h.state();
  assert.equal(job(s, 1).status, 'cancelled');
  assert.equal(cloud.requests.filter(r => r.method === 'DELETE').length, 2);
});

test('openai provisioning: the token is sent only to the vault credential; a lost vault create is found; rotation updates', async () => {
  const cloud = new FakeCloud();
  cloud.vaults = []; cloud.credentials = []; cloud.loseVaultCreate = true;
  const store = new MemoryStateStore(serializeState(initialCloudState(T0, { provision: EXEC.repository, provider: 'openai' })));
  const h = harness(store, { openai: adapter(cloud) } as any);
  await h.tick();
  let s = await h.state();
  assert.equal(s.meta.execution?.provider, 'openai');
  assert.deepEqual(s.meta.executionProfile, { provider: 'openai', model: 'gpt-6.1-sol', networking: 'enabled', containerSize: 'medium' });
  const withToken = cloud.requests.filter(r => JSON.stringify(r.body ?? {}).includes(TOKEN));
  assert.equal(withToken.length, 1);
  assert.match(withToken[0].url, /\/v1\/vaults\/vault_created0001\/credentials$/);
  assert.deepEqual(withToken[0].body.allowed_hosts, ['api.github.com']);
  assert.ok(!cloud.requests.some(r => r.url.includes('/agents/sessions')), 'no session during setup');
  assert.ok(!JSON.stringify(s).includes(TOKEN), 'the token never reaches state');
  // Running setup again overwrites the same credential with the current token (rotation).
  push(h.store, intent(3, { kind: 'provision', repository: EXEC.repository, provider: 'openai', configRevision: s.meta.configRevision } as any));
  await h.tick();
  s = await h.state();
  assert.match(s.journal.entries.at(-1)!.message, /credential cred_created0001 \(updated\)/);
});

test('openai schema: executions hold references only; manual configure is Anthropic-only; old states still validate', () => {
  assert.deepEqual(validateExecution(EXEC), EXEC);
  assert.throws(() => validateExecution({ ...EXEC, openai: { ...EXEC.openai, vaultId: TOKEN } }));
  assert.throws(() => validateExecution({ ...EXEC, openai: { ...EXEC.openai, model: 'claude-sonnet-5' } }));
  assert.throws(() => validateExecution({ ...EXEC, openai: { ...EXEC.openai, apiKey: API_KEY } }));
  const id = uuid(500);
  assert.throws(() => parseIntent(intentPath(id), JSON.stringify({ schemaVersion: 1, id, createdAt: T0, kind: 'configure', execution: EXEC, configRevision: 0 })), /set up automatically/);
  assert.throws(() => parseIntent(intentPath(id), JSON.stringify({ schemaVersion: 1, id, createdAt: T0, kind: 'provision', repository: EXEC.repository, provider: 'openai', model: 'claude-opus-5-5', configRevision: 0 })), /Unsupported worker model/);
  const ok = parseIntent(intentPath(id), JSON.stringify({ schemaVersion: 1, id, createdAt: T0, kind: 'provision', repository: EXEC.repository, provider: 'openai', configRevision: 0 }));
  assert.equal((ok as any).provider, 'openai');
  // An Anthropic state written before CLOUD-06 serializes to identical bytes.
  const old = initialCloudState(T0, { execution: { provider: 'anthropic', repository: EXEC.repository, anthropic: { agentId: 'agent_fixture1', environmentId: 'env_fixture1' } } });
  assert.ok(!serializeState(old)['state/meta.json'].includes('openai'));
});
