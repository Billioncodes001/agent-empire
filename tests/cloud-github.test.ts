import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubError, GitHubStateStore, updateWithRetry, encodeBase64Utf8, decodeBase64Utf8 } from '../src/cloud/store';
import { InstallError, installStateRepository } from '../src/cloud/installer';
import { coordinatorWorkflow, COORDINATOR_BUNDLE_PATH, WORKFLOW_PATH } from '../src/cloud/workflow';
import { main } from '../src/cloud/cli';
import { readCloudView, submitIntent, requestShutdown, requestStart } from '../src/cloud/client';
import { STATE_FILES } from '../src/cloud/schema';
import { EXECUTION, FakeProvider, T0, uuid } from './cloud-fixtures';
import { runCoordinatorTick } from '../src/cloud/tick';

const USER_TOKEN = 'ghu_fixture_user_token';
import { FakeGitHub, json } from './fake-github';

/** Anthropic + project-repository endpoints, mirroring tests/execution.test.ts. */
class FakeAnthropic {
  created: any[] = []; branchChecks = 0; status = 'running'; archived: string | null = null; stop = 'end_turn';
  handle = async (url: URL, init: RequestInit): Promise<Response> => {
    const p = url.pathname; const method = init.method ?? 'GET';
    if (url.host === 'api.github.com' && p.includes('/git/ref/heads/agent-empire/task-')) { this.branchChecks++; return json({ object: { sha: 'd'.repeat(40) } }); }
    if (url.host === 'api.github.com') return p.endsWith('/commits/main') ? json({ sha: 'b'.repeat(40) }) : json({ full_name: 'fixture/repo', archived: false, disabled: false });
    if (p.startsWith('/v1/agents/')) return json({ id: 'agent_fixture1', type: 'agent', version: 2, archived_at: null, multiagent: null, tools: [{ type: 'agent_toolset_20260401' }] });
    if (p.startsWith('/v1/environments/')) return json({ id: 'env_fixture1', archived_at: null, config: { type: 'cloud' } });
    if (p === '/v1/sessions' && method === 'POST') { this.created.push(JSON.parse(String(init.body))); return json(this.session()); }
    if (p.endsWith('/archive')) { this.status = 'terminated'; this.archived = '2026-09-30T12:20:00Z'; return json(this.session()); }
    if (p.endsWith('/events')) return json({ data: this.status === 'idle' ? [{ id: 'sevt_fixture1', type: 'session.status_idle', stop_reason: { type: this.stop }, processed_at: '2026-09-30T12:15:00Z' }] : [], next_page: null });
    return json(this.session());
  };
  session() { return { type: 'session', id: 'sesn_fixture1', status: this.status, archived_at: this.archived, budget: { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } }, usage: { list_cost: { amount: '30', currency: 'USD' } } }; }
}

function transport(github: FakeGitHub, anthropic?: FakeAnthropic): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (anthropic && (url.host === 'api.anthropic.com' || (url.host === 'api.github.com' && (init.headers as any)?.authorization === 'Bearer github_pat_fixture'))) return anthropic.handle(url, init);
    if (url.host !== 'api.github.com') throw new Error(`unexpected host ${url.host}`);
    return github.handle(url, init);
  }) as typeof fetch;
}
const client = (github: FakeGitHub, token = USER_TOKEN) => new GitHubClient(token, { fetch: transport(github) });
const fakeEncrypt = async (key: string, value: string) => `sealed(${key}):${encodeBase64Utf8(value).split('').reverse().join('')}`;
const install = (github: FakeGitHub, extra: object = {}) => installStateRepository(client(github), { secrets: { ANTHROPIC_API_KEY: 'sk-ant-fixture', PROJECT_GITHUB_TOKEN: 'github_pat_fixture' }, limits: { maxConcurrent: 1, perTaskBudgetCents: 100, dailyBudgetCents: 500 }, execution: EXECUTION, coordinatorBundle: '// bundle\n', now: T0, ...extra }, fakeEncrypt);

test('cloud github: base64 helpers round-trip UTF-8', () => {
  const text = 'Common Ground café — ✓ '.repeat(3000);
  assert.equal(decodeBase64Utf8(encodeBase64Utf8(text)), text);
});

test('cloud installer: creates a private repo, uploads only ciphertext via the encryptSecret seam, commits workflow + state once', async () => {
  const github = new FakeGitHub();
  const result = await install(github);
  assert.deepEqual({ owner: result.owner, repo: result.repo, created: result.created, secrets: result.secrets, alreadyInstalled: result.alreadyInstalled }, { owner: 'founder', repo: 'agent-empire-state', created: true, secrets: ['ANTHROPIC_API_KEY', 'PROJECT_GITHUB_TOKEN'], alreadyInstalled: false });
  const repo = github.repos.get('founder/agent-empire-state')!;
  assert.equal(repo.private, true);
  assert.equal(repo.secrets.get('ANTHROPIC_API_KEY')!.key_id, 'key-1');
  assert.ok(repo.secrets.get('ANTHROPIC_API_KEY')!.encrypted_value.startsWith('sealed(cHVibGljLWtleS1iYXNlNjQ=)'));
  const wire = JSON.stringify(github.requests.map(r => r.body));
  assert.ok(!wire.includes('sk-ant-fixture') && !wire.includes('github_pat_fixture'), 'no plaintext secret leaves the installer');
  const files = github.files('founder/agent-empire-state');
  for (const path of [WORKFLOW_PATH, COORDINATOR_BUNDLE_PATH, ...Object.values(STATE_FILES)]) assert.ok(files[path], path);
  assert.deepEqual(repo.commits.get(repo.commits.get(repo.ref)!.parents[0])!.message, 'Agent Empire: initial state and coordinator', 'state and bundle are one atomic commit, before the workflow commit');
  assert.equal(repo.commits.get(repo.ref)!.message, 'Agent Empire: install the coordinator workflow', 'the workflow is committed last');
  assert.equal(JSON.parse(files[STATE_FILES.jobs]).jobs.length, 0, 'setup never queues paid work');
  assert.equal(repo.dispatches.length, 0, 'setup does not trigger a run');
  // Re-running setup updates the coordinator but never overwrites an existing Empire.
  github.commitOnBranch('founder/agent-empire-state', { [STATE_FILES.empire]: files[STATE_FILES.empire].replace('"funds": 100000', '"funds": 99999') });
  const again = await install(github, { coordinatorBundle: '// bundle v2\n' });
  assert.equal(again.alreadyInstalled, true);
  assert.match(github.files('founder/agent-empire-state')[STATE_FILES.empire], /"funds": 99999/);
  assert.equal(github.files('founder/agent-empire-state')[COORDINATOR_BUNDLE_PATH], '// bundle v2\n');
});

test('cloud installer: refuses a public repository', async () => {
  const github = new FakeGitHub();
  github.create('founder/agent-empire-state', false);
  await assert.rejects(install(github), (error: unknown) => error instanceof InstallError && error.code === 'state_repository_public' && error.step === 'repo');
});

test('cloud github: commits are atomic and a moved ref is a conflict that retry resolves', async () => {
  const github = new FakeGitHub();
  await install(github);
  const store = new GitHubStateStore(client(github), { owner: 'founder', repo: 'agent-empire-state', branch: 'main', workflowFile: 'agent-empire.yml' });
  const snapshot = await store.read();
  assert.deepEqual(Object.keys(snapshot.files).sort(), Object.values(STATE_FILES).sort(), 'only state/ and intents/ are read');
  github.commitOnBranch('founder/agent-empire-state', { [`intents/${uuid(1)}.json`]: '{}' });
  const stale = await store.commit(snapshot, [{ path: STATE_FILES.journal, content: 'x' }], 'stale');
  assert.deepEqual(stale, { ok: false, reason: 'conflict' });
  let attempts = 0;
  github.beforeRefUpdate = () => github.commitOnBranch('founder/agent-empire-state', { [`intents/${uuid(2)}.json`]: '{}' });
  const updated = await updateWithRetry(store, snap => {
    attempts++;
    return { changes: [{ path: 'state/extra.json', content: '{"a":1}' }, ...Object.keys(snap.files).filter(p => p.startsWith('intents/')).map(path => ({ path, content: null }))], message: 'consume', value: Object.keys(snap.files).length };
  });
  assert.equal(updated.attempts, 2);
  assert.equal(attempts, 2);
  const files = github.files('founder/agent-empire-state');
  assert.equal(files['state/extra.json'], '{"a":1}');
  assert.ok(!Object.keys(files).some(p => p.startsWith('intents/')), 'both intents deleted in the retried commit');
});

test('cloud github: workflow disable/enable, dispatch and errors never expose the token', async () => {
  const github = new FakeGitHub();
  await install(github);
  const store = new GitHubStateStore(client(github), { owner: 'founder', repo: 'agent-empire-state', branch: 'main', workflowFile: 'agent-empire.yml' });
  await store.setWorkflowEnabled(false);
  assert.equal(github.repos.get('founder/agent-empire-state')!.workflow, 'disabled_manually');
  await requestStart(store, uuid(7), T0);
  assert.equal(github.repos.get('founder/agent-empire-state')!.workflow, 'active');
  assert.deepEqual(github.repos.get('founder/agent-empire-state')!.dispatches, ['agent-empire-start']);
  await requestShutdown(store, uuid(8), T0);
  const view = await readCloudView(store, T0);
  assert.deepEqual(view.pendingIntents, [`intents/${uuid(7)}.json`, `intents/${uuid(8)}.json`]);
  assert.equal(view.snapshotAgeMs, undefined, 'no coordinator run yet: nothing is presented as live');
  assert.ok(github.requests.every(r => r.auth === `Bearer ${USER_TOKEN}`));
  const missing = new GitHubStateStore(client(github), { owner: 'founder', repo: 'missing', branch: 'main' });
  await assert.rejects(missing.read(), (error: unknown) => error instanceof GitHubError && error.status === 404 && !error.message.includes(USER_TOKEN));
  assert.throws(() => new GitHubStateStore(client(github), { owner: 'founder', repo: '../x', branch: 'main' }));
  await assert.rejects(submitIntent(store, { schemaVersion: 1, id: uuid(9), createdAt: T0, kind: 'limits', configRevision: 0, limits: { maxConcurrent: 99, perTaskBudgetCents: 1, dailyBudgetCents: 1 } } as any));
});

test('cloud workflow: schedule, dispatch, one-at-a-time concurrency, least privilege, secrets only in env', () => {
  const yaml = coordinatorWorkflow();
  assert.match(yaml, /schedule:\n {4}- cron: '\*\/30 \* \* \* \*'/);
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /repository_dispatch:\n {4}types: \[agent-empire-intent, agent-empire-start, agent-empire-shutdown\]/);
  assert.match(yaml, /concurrency:\n {2}group: agent-empire\n {2}cancel-in-progress: false/);
  assert.match(yaml, /permissions:\n {2}contents: write\n {2}actions: write/);
  assert.match(yaml, /run: node coordinator\/agent-empire-coordinator\.mjs tick/);
  const secretLines = yaml.split('\n').filter(line => line.includes('secrets.'));
  assert.equal(secretLines.length, 3);
  for (const line of secretLines) assert.match(line, /^ {10}[A-Z_]+: \$\{\{ secrets\.(ANTHROPIC_API_KEY|OPENAI_API_KEY|PROJECT_GITHUB_TOKEN) \}\}$/);
  assert.ok(!/echo|set -x/.test(yaml));
  const minimal = coordinatorWorkflow({ allowSelfDisable: false });
  assert.match(minimal, /permissions:\n {2}contents: write\n\n/);
  assert.ok(!minimal.includes('actions: write'));
  assert.throws(() => coordinatorWorkflow({ intervalMinutes: 10 }), /15, 20, 30 or 60/);
});

test('cloud cli: a tick in the Actions environment reads intents, dispatches via Anthropic and commits state', async () => {
  const github = new FakeGitHub(); const anthropic = new FakeAnthropic();
  await install(github);
  const store = new GitHubStateStore(client(github), { owner: 'founder', repo: 'agent-empire-state', branch: 'main' });
  await submitIntent(store, { schemaVersion: 1, id: uuid(100), createdAt: T0, kind: 'new_job', job: { id: uuid(1), title: 'Fix docs', prompt: 'Fix the README typo', configRevision: 0, confirmPaid: true } });
  const env = { GITHUB_TOKEN: 'ghs_actions_token', GITHUB_REPOSITORY: 'founder/agent-empire-state', GITHUB_REF_NAME: 'main', AGENT_EMPIRE_STATE_BRANCH: 'main', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', ANTHROPIC_API_KEY: 'sk-ant-fixture', PROJECT_GITHUB_TOKEN: 'github_pat_fixture', AGENT_EMPIRE_SELF_DISABLE: 'true' };
  const out: string[] = [];
  assert.equal(await main(['tick'], env, line => out.push(line), transport(github, anthropic)), 0);
  assert.equal(anthropic.created.length, 1);
  assert.deepEqual(anthropic.created[0].budget, { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } });
  assert.equal(anthropic.created[0].metadata.agent_empire_task_id, uuid(1));
  let files = github.files('founder/agent-empire-state');
  let job = JSON.parse(files[STATE_FILES.jobs]).jobs[0];
  assert.equal(job.status, 'running');
  assert.equal(job.sessionId, 'sesn_fixture1');
  assert.ok(!Object.keys(files).some(p => p.startsWith('intents/')));
  assert.ok(!out.join('\n').match(/sk-ant|github_pat_fixture|ghs_actions/), 'logs contain no credentials');
  anthropic.status = 'idle';
  assert.equal(await main(['tick'], { ...env, GITHUB_RUN_ID: '43' }, line => out.push(line), transport(github, anthropic)), 0);
  files = github.files('founder/agent-empire-state');
  job = JSON.parse(files[STATE_FILES.jobs]).jobs[0];
  assert.equal(job.status, 'awaiting_review');
  assert.equal(anthropic.created.length, 1, 'polling never re-dispatches');
  assert.equal(JSON.parse(files[STATE_FILES.heartbeat]).lastRunId, '43-1');
  assert.equal(await main(['status'], env, line => out.push(line), transport(github, anthropic)), 0);
  assert.match(out[out.length - 1], /"status":"awaiting_review"/);
  assert.equal(await main(['tick'], { ...env, GITHUB_TOKEN: '' }, line => out.push(line), transport(github, anthropic)), 1);
});

test('review fix 1: unreadable intent blobs are rejected and deleted instead of bricking the coordinator', async () => {
  const github = new FakeGitHub();
  await install(github);
  const full = 'founder/agent-empire-state';
  const big = github.addRaw(full, `intents/${uuid(1)}.json`, encodeBase64Utf8('{}'), 70_000);
  github.addRaw(full, `intents/${uuid(2)}.json`, Buffer.from([0xff, 0xfe, 0xfd]).toString('base64'), 3);
  const store = new GitHubStateStore(client(github), { owner: 'founder', repo: 'agent-empire-state', branch: 'main', workflowFile: 'agent-empire.yml' });
  await submitIntent(store, { schemaVersion: 1, id: uuid(3), createdAt: T0, kind: 'shutdown' });
  const report = await runCoordinatorTick({ store, provider: new FakeProvider(), now: () => T0, runId: 'run-1', allowSelfDisable: true, retry: { sleep: async () => {} } });
  assert.ok(!github.blobReads.includes(big), 'an oversized intent is refused from its tree size, never downloaded');
  const outcomes = Object.fromEntries(report.intents.map(i => [i.id, [i.outcome, i.reason]]));
  assert.deepEqual(outcomes[uuid(1)], ['rejected', 'Intent file is larger than 64 KiB.']);
  assert.deepEqual(outcomes[uuid(2)], ['rejected', 'Intent file is not UTF-8 text.']);
  assert.equal(outcomes[uuid(3)][0], 'applied', 'a shutdown behind a bad file still applies');
  const files = github.files(full);
  assert.ok(!Object.keys(files).some(p => p.startsWith('intents/')), 'all three files deleted');
  assert.equal(JSON.parse(files[STATE_FILES.meta]).lifecycle.status, 'shutdown');
  assert.equal(JSON.parse(files[STATE_FILES.journal]).entries.filter((e: any) => e.kind === 'intent_rejected').length, 2);
});

test('review fix 7: a run dispatched on another branch skips instead of coordinating the same state', async () => {
  const github = new FakeGitHub();
  await install(github);
  const before = github.requests.length;
  const out: string[] = [];
  const code = await main(['tick'], { GITHUB_TOKEN: 'ghs_x', GITHUB_REPOSITORY: 'founder/agent-empire-state', GITHUB_REF_NAME: 'feature/x', AGENT_EMPIRE_STATE_BRANCH: 'main', ANTHROPIC_API_KEY: 'k', PROJECT_GITHUB_TOKEN: 'github_pat_fixture' }, line => out.push(line), transport(github));
  assert.equal(code, 0);
  assert.match(out.join('\n'), /skipped: this run is on feature\/x/);
  assert.equal(github.requests.length, before, 'no state read, no dispatch');
});

test('review quick fix: the installer refuses a classic project token and records the schedule estimate', async () => {
  const github = new FakeGitHub();
  await assert.rejects(install(github, { secrets: { ANTHROPIC_API_KEY: 'sk-ant-fixture', PROJECT_GITHUB_TOKEN: 'ghp_classic' } }), (error: unknown) => error instanceof InstallError && error.code === 'project_token_not_fine_grained');
  assert.equal(github.repos.size, 0, 'refused before creating anything');
  await install(github, { workflow: { intervalMinutes: 60 } });
  const files = github.files('founder/agent-empire-state');
  assert.equal(JSON.parse(files[STATE_FILES.meta]).schedule.runsPerMonth, 720);
  assert.match(files[WORKFLOW_PATH], /cron: '7 \* \* \* \*'/);
});

test('re-review M1: rate-limited or forbidden intent reads fail the run and keep the file', async () => {
  for (const status of [403, 429, 401, 404, 503]) {
    const github = new FakeGitHub();
    await install(github);
    const full = 'founder/agent-empire-state';
    const store = new GitHubStateStore(client(github), { owner: 'founder', repo: 'agent-empire-state', branch: 'main', workflowFile: 'agent-empire.yml' });
    await submitIntent(store, { schemaVersion: 1, id: uuid(3), createdAt: T0, kind: 'shutdown' });
    const repo = github.repos.get(full)!;
    const blobSha = repo.trees.get(repo.commits.get(repo.ref)!.tree)!.get(`intents/${uuid(3)}.json`)!;
    github.blobStatus.set(blobSha, status);
    const tick = () => runCoordinatorTick({ store, provider: new FakeProvider(), now: () => T0, runId: `run-${status}`, retry: { sleep: async () => {} } });
    await assert.rejects(tick(), (error: unknown) => error instanceof GitHubError && error.status === status, `HTTP ${status} is transient`);
    assert.ok(github.files(full)[`intents/${uuid(3)}.json`], `the shutdown intent survives HTTP ${status}`);
    github.blobStatus.clear();
    const report = await tick();
    assert.deepEqual(report.intents.map(i => [i.id, i.outcome]), [[uuid(3), 'applied']]);
    assert.equal(JSON.parse(github.files(full)[STATE_FILES.meta]).lifecycle.status, 'shutdown');
  }
});

test('re-review M1: a run fetches only about the batch size of intent blobs', async () => {
  const github = new FakeGitHub();
  await install(github);
  const full = 'founder/agent-empire-state';
  const changes: Record<string, string> = {};
  for (let n = 1; n <= 60; n++) changes[`intents/${uuid(n)}.json`] = JSON.stringify({ schemaVersion: 1, id: uuid(n), createdAt: T0 + n, kind: 'start' });
  github.commitOnBranch(full, changes);
  const store = new GitHubStateStore(client(github), { owner: 'founder', repo: 'agent-empire-state', branch: 'main' }, { maxIntents: 5 });
  const before = github.requests.length;
  const snapshot = await store.read();
  const blobGets = github.requests.slice(before).filter(r => r.path.includes('/git/blobs/')).length;
  const stateFiles = Object.values(STATE_FILES).length;
  assert.ok(blobGets <= stateFiles + 5 + 20, `fetched ${blobGets} blobs`);
  assert.equal(Object.keys(snapshot.files).filter(p => p.startsWith('intents/')).length, 5);
  assert.equal(snapshot.intentsTruncated, true);
});
