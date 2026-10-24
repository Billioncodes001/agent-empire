/**
 * FREE-04: GitHub Actions as the job sandbox. Fakes only: an in-memory Actions API (dispatch, runs, artifacts,
 * secrets list, contents) and the in-memory state store. No network, no real GitHub writes, no paid calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { GitHubActionsAdapter, readZipEntry, runTitle } from '../src/cloud/actions-adapter';
import { chooseModelSource, engineLabel, JOB_PINS, MAX_TASK_B64, parseRunResult, rotationStatus, subscriptionChecklist, validateActionsSettings, type ActionsSettings } from '../src/cloud/actions-spec';
import { checkJobSecret, installJobWorkflow } from '../src/cloud/actions-setup';
import { ENGINE_INSTRUCTION, jobWorkflow, QWEN_SHA512_HEX } from '../src/cloud/job-workflow';
import { ProviderRouter, UnavailableProvider, DispatchFailure } from '../src/cloud/provider';
import { providersFromEnv } from '../src/cloud/cli';
import { serializeState, validateJobs, type ActionsExecution, type CloudExecution } from '../src/cloud/schema';
import { GitHubClient } from '../src/cloud/store';
import { PINNED_ACTIONS } from '../src/cloud/workflow';
import { FakeProvider, harness, intent, job, makeStore, newJob, push, uuid, EXECUTION } from './cloud-fixtures';

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(data === undefined || status === 204 ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const HEAD = 'c'.repeat(40);
const PUSHED = 'd'.repeat(40);

const FREE: ActionsSettings = { engine: 'qwen-free', modelSource: 'cpu_small', maxTurns: 30, timeoutMinutes: 60, openPullRequest: true };
const SUB: ActionsSettings = { engine: 'claude-subscription', maxTurns: 40, timeoutMinutes: 90, openPullRequest: true };
const KEY: ActionsSettings = { engine: 'claude-api-key', maxTurns: 40, timeoutMinutes: 90, openPullRequest: false };
const exec = (actions: ActionsSettings): ActionsExecution => ({ provider: 'github-actions', repository: { owner: 'fixture', name: 'repo', baseBranch: 'main' }, actions });

/** A single-entry zip (deflated), as actions/upload-artifact produces. */
function zip(name: string, text: string): Uint8Array {
  const data = Buffer.from(text, 'utf8');
  const comp = deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  return new Uint8Array(Buffer.concat([local, nameBuf, comp]));
}

interface Run { id: number; title: string; status: string; conclusion: string | null; path: string; artifact?: Uint8Array | null; artifactSize?: number }
class FakeActions {
  requests: { method: string; url: string; auth?: string; body?: any }[] = [];
  runs = new Map<number, Run>();
  nextRun = 9001;
  dispatchMode: 'ok' | 'no_run_id' | 'network' | 'http500' | 'http422' | 'http404' = 'ok';
  secrets: { name: string; updated_at: string }[] = [];
  branches = new Map<string, string>();
  files = new Map<string, { sha: string; content: string }>();
  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const auth = (init.headers as Record<string, string> | undefined)?.authorization;
    this.requests.push({ method, url, auth, body });
    if (url.startsWith('https://blob.example/')) {
      if (auth) return json({ message: 'token leaked to blob storage' }, 400);
      const run = this.runs.get(Number(url.split('/').pop()));
      return new Response(run?.artifact ? Buffer.from(run.artifact) : null, { status: 200 });
    }
    const path = url.replace('https://api.github.com', '').split('?')[0];
    let m: RegExpExecArray | null;
    if (path === '/repos/fixture/repo/commits/main') return json({ sha: HEAD });
    if (path === '/repos/fixture/repo/actions/workflows/agent-empire-job.yml/dispatches' && method === 'POST') {
      if (this.dispatchMode === 'network') throw new TypeError('fetch failed');
      if (this.dispatchMode === 'http500') return json({ message: 'boom' }, 500);
      if (this.dispatchMode === 'http422') return json({ message: 'Unexpected inputs' }, 422);
      if (this.dispatchMode === 'http404') return json({ message: 'Not Found' }, 404);
      const id = this.nextRun++;
      this.runs.set(id, { id, title: `Agent Empire job ${body.inputs.job_id} budget ${body.inputs.budget_cents}c turns ${body.inputs.max_turns}`, status: 'queued', conclusion: null, path: '.github/workflows/agent-empire-job.yml' });
      return this.dispatchMode === 'no_run_id' ? json(undefined, 204) : json({ workflow_run_id: id, run_url: `https://api.github.com/repos/fixture/repo/actions/runs/${id}`, html_url: `https://github.com/fixture/repo/actions/runs/${id}` });
    }
    if ((m = /^\/repos\/fixture\/repo\/actions\/runs\/(\d+)$/.exec(path))) {
      const run = this.runs.get(Number(m[1]));
      return run ? json({ id: run.id, display_title: run.title, status: run.status, conclusion: run.conclusion, path: run.path }) : json({ message: 'Not Found' }, 404);
    }
    if ((m = /^\/repos\/fixture\/repo\/actions\/runs\/(\d+)\/cancel$/.exec(path)) && method === 'POST') {
      const run = this.runs.get(Number(m[1]))!; run.status = 'completed'; run.conclusion = 'cancelled'; return json({}, 202);
    }
    if ((m = /^\/repos\/fixture\/repo\/actions\/runs\/(\d+)\/artifacts$/.exec(path))) {
      const run = this.runs.get(Number(m[1]))!;
      return json({ artifacts: run.artifact === null || run.artifact === undefined ? [] : [{ id: run.id, name: 'agent-empire-result', size_in_bytes: run.artifactSize ?? run.artifact.length, expired: false }] });
    }
    if ((m = /^\/repos\/fixture\/repo\/actions\/artifacts\/(\d+)\/zip$/.exec(path))) return new Response(null, { status: 302, headers: { location: `https://blob.example/${m[1]}` } });
    if ((m = /^\/repos\/fixture\/repo\/git\/ref\/heads\/(.+)$/.exec(path))) { const sha = this.branches.get(m[1]); return sha ? json({ object: { sha } }) : json({ message: 'Not Found' }, 404); }
    if (path === '/repos/fixture/repo/actions/secrets') return json({ total_count: this.secrets.length, secrets: this.secrets });
    if ((m = /^\/repos\/fixture\/repo\/contents\/(.+)$/.exec(path))) {
      const f = this.files.get(m[1]);
      if (method === 'GET') return f ? json({ sha: f.sha, content: f.content }) : json({ message: 'Not Found' }, 404);
      if (method === 'PUT') { if (f && body.sha !== f.sha) return json({ message: 'sha mismatch' }, 409); this.files.set(m[1], { sha: 'e'.repeat(40), content: body.content }); return json({ content: {} }, f ? 200 : 201); }
    }
    return json({ message: `unhandled ${method} ${path}` }, 404);
  };
  finish(id: number, result: object | null, conclusion = 'success') {
    const run = this.runs.get(id)!; run.status = 'completed'; run.conclusion = conclusion;
    run.artifact = result === null ? null : zip('result.json', JSON.stringify(result));
  }
}

function actionsHarness(settings: ActionsSettings, limits = { maxConcurrent: 2, perTaskBudgetCents: 100, dailyBudgetCents: 1000 }) {
  const gh = new FakeActions();
  const adapter = new GitHubActionsAdapter('github_pat_fixture', { fetch: gh.fetch as typeof fetch });
  const h = harness(makeStore({ execution: exec(settings), limits, mutate: s => { s.empire.setup.completed = true; s.empire.economy.startedAt = 0; } }), adapter as unknown as FakeProvider);
  return { gh, adapter, h };
}

// ---------------------------------------------------------------- money safety in the coordinator

test('free run: zero-money run-caps reservation, dispatch with inputs, cost 0, review, credits only on accept', async () => {
  const { gh, h } = actionsHarness(FREE);
  push(h.store, newJob(1, 1, { prompt: 'Fix the README typo' }));
  await h.tick();
  let state = await h.state();
  let j = job(state, 1);
  assert.equal(j.provider, 'github-actions');
  assert.equal(j.status, 'running');
  assert.deepEqual(j.reservation && { cents: j.reservation.cents, basis: j.reservation.basis }, { cents: 0, basis: 'run_caps' });
  assert.equal(j.sessionId, 'ghrun_9001');
  assert.deepEqual(j.cost && { amountCents: j.cost.amountCents, basis: j.cost.basis }, { amountCents: 0, basis: 'free_run' });
  assert.equal(state.ledger.entries.length, 0, 'a free run never enters the money ledger');
  const dispatch = gh.requests.find(r => r.url.endsWith('/dispatches'))!;
  assert.equal(dispatch.auth, 'Bearer github_pat_fixture');
  assert.equal(dispatch.body.ref, 'main');
  assert.equal(dispatch.body.return_run_details, true);
  assert.deepEqual(Object.keys(dispatch.body.inputs).sort(), ['budget_cents', 'job_id', 'max_turns', 'source_commit', 'task_b64']);
  assert.equal(dispatch.body.inputs.budget_cents, '0');
  assert.equal(Buffer.from(dispatch.body.inputs.task_b64, 'base64').toString('utf8'), 'Fix the README typo');
  assert.equal(dispatch.body.inputs.source_commit, HEAD);

  // Still running: nothing changes; then it finishes and pushed.
  await h.tick();
  gh.branches.set(`agent-empire/task-${uuid(1)}`, PUSHED);
  gh.finish(9001, { schemaVersion: 1, jobId: uuid(1), engine: 'qwen-free', status: 'changes_pushed', headSha: PUSHED, pullRequest: 7 });
  await h.tick();
  state = await h.state();
  j = job(state, 1);
  assert.equal(j.status, 'awaiting_review');
  assert.equal(j.branchHead?.sha, PUSHED);
  assert.equal(j.providerStatus, 'archived', 'the finished run record is closed so its slot is released');
  assert.equal(j.cost?.amountCents, 0);
  assert.ok(!state.empire.economy.rewardedTasks.includes(uuid(1)), 'no credits before review');
  push(h.store, intent(10, { kind: 'review', jobId: uuid(1), decision: 'accept' }));
  await h.tick();
  state = await h.state();
  assert.equal(job(state, 1).status, 'accepted');
  assert.ok(state.empire.economy.rewardedTasks.includes(uuid(1)), 'city credits move only on accept');
  assert.doesNotThrow(() => validateJobs(JSON.parse(serializeState(state)['state/jobs.json'])));
});

test('subscription run: billed to the Claude plan (0 cents, no US$), never a money reservation', async () => {
  const { gh, h } = actionsHarness(SUB);
  push(h.store, newJob(1, 1));
  await h.tick();
  gh.finish(9001, { schemaVersion: 1, jobId: uuid(1), engine: 'claude-subscription', status: 'no_changes' });
  await h.tick();
  const j = job(await h.state(), 1);
  assert.equal(j.reservation?.cents, 0, 'no money reserved');
  assert.deepEqual(j.cost && { amountCents: j.cost.amountCents, basis: j.cost.basis }, { amountCents: 0, basis: 'claude_plan' });
  assert.equal(j.status, 'awaiting_review');
  assert.match(j.message, /no commits beyond|was not found|finished/);
});

test('API-key run: money reservation as before, engine-reported estimate kept apart from observed cost', async () => {
  const { gh, h } = actionsHarness(KEY);
  push(h.store, newJob(1, 1));
  await h.tick();
  let state = await h.state();
  assert.deepEqual(job(state, 1).reservation && { cents: job(state, 1).reservation!.cents, basis: job(state, 1).reservation!.basis }, { cents: 100, basis: 'per_job_allowance_estimate' });
  assert.equal(gh.requests.find(r => r.url.endsWith('/dispatches'))!.body.inputs.budget_cents, '100');
  gh.branches.set(`agent-empire/task-${uuid(1)}`, PUSHED);
  gh.finish(9001, { schemaVersion: 1, jobId: uuid(1), engine: 'claude-api-key', status: 'changes_pushed', headSha: PUSHED, costUsdEstimate: 0.4321 });
  await h.tick();
  state = await h.state();
  const j = job(state, 1);
  assert.deepEqual(j.cost && { amountCents: j.cost.amountCents, basis: j.cost.basis }, { amountCents: 44, basis: 'engine_reported_estimate' });
  const day = Object.values(state.ledger.days)[0];
  assert.equal(day.observedCostCents, 0);
  assert.equal(day.estimatedCostCents, 44);
});

test('dispatch that may have reached GitHub becomes dispatch_uncertain and is never retried', async () => {
  for (const mode of ['network', 'http500', 'no_run_id'] as const) {
    const { gh, h } = actionsHarness(FREE);
    gh.dispatchMode = mode;
    push(h.store, newJob(1, 1));
    await h.tick();
    await h.tick();
    await h.tick();
    const j = job(await h.state(), 1);
    assert.equal(j.status, 'dispatch_uncertain', mode);
    assert.match(j.message, /Actions tab/);
    assert.equal(gh.requests.filter(r => r.url.endsWith('/dispatches')).length, 1, `${mode}: exactly one dispatch request`);
  }
});

test('a refused dispatch (4xx) proves no run started: requeued, then failed after the attempt limit', async () => {
  const { gh, h } = actionsHarness(FREE);
  gh.dispatchMode = 'http404';
  push(h.store, newJob(1, 1));
  await h.tick();
  let j = job(await h.state(), 1);
  assert.equal(j.status, 'queued');
  assert.match(j.message, /HTTP 404.*agent-empire-job\.yml/);
  await h.tick(); await h.tick();
  j = job(await h.state(), 1);
  assert.equal(j.status, 'failed');
  assert.equal(j.reservation, undefined);
});

test('run outcomes: timed out fails; cancelled cancels; a missing artifact leaves it open for review; title mismatch is unknown', async () => {
  {
    const { gh, h } = actionsHarness(FREE);
    push(h.store, newJob(1, 1)); await h.tick();
    gh.finish(9001, null, 'timed_out'); await h.tick();
    const j = job(await h.state(), 1);
    assert.equal(j.status, 'failed'); assert.match(j.message, /time cap/);
  }
  {
    const { gh, h } = actionsHarness(FREE);
    push(h.store, newJob(1, 1)); await h.tick();
    gh.finish(9001, null); await h.tick();
    const j = job(await h.state(), 1);
    assert.equal(j.status, 'idle'); assert.match(j.message, /result artifact is missing/);
  }
  {
    const { gh, h } = actionsHarness(FREE);
    push(h.store, newJob(1, 1)); await h.tick();
    gh.runs.get(9001)!.title = 'something else'; await h.tick();
    assert.equal(job(await h.state(), 1).status, 'unknown');
  }
  {
    const { gh, h } = actionsHarness(FREE);
    push(h.store, newJob(1, 1)); await h.tick();
    push(h.store, intent(5, { kind: 'cancel', jobId: uuid(1) })); await h.tick();
    assert.ok(gh.requests.some(r => r.method === 'POST' && r.url.endsWith('/actions/runs/9001/cancel')));
    await h.tick();
    assert.equal(job(await h.state(), 1).status, 'cancelled');
  }
});

test('artifact: oversized, wrong job, extra fields and model text are refused; the token never goes to blob storage', async () => {
  const { gh, h } = actionsHarness(FREE);
  push(h.store, newJob(1, 1)); await h.tick();
  gh.finish(9001, { schemaVersion: 1, jobId: uuid(2), engine: 'qwen-free', status: 'no_changes' });
  await h.tick();
  assert.match(job(await h.state(), 1).message, /different job/);
  const blob = gh.requests.filter(r => r.url.startsWith('https://blob.example/'));
  assert.ok(blob.length > 0 && blob.every(r => !r.auth));
  assert.throws(() => parseRunResult(JSON.stringify({ schemaVersion: 1, jobId: uuid(1), engine: 'qwen-free', status: 'no_changes', summary: 'model text' }), { jobId: uuid(1), engine: 'qwen-free' }), /unexpected/);
  assert.throws(() => parseRunResult(JSON.stringify({ schemaVersion: 1, jobId: uuid(1), engine: 'qwen-free', status: 'no_changes', costUsdEstimate: 1 }), { jobId: uuid(1), engine: 'qwen-free' }), /Only API-key/);
  assert.throws(() => parseRunResult('x'.repeat(5000), { jobId: uuid(1), engine: 'qwen-free' }), /too large/);
  await assert.rejects(readZipEntry(zip('result.json', 'y'.repeat(10_000)), 'result.json', 4096), /too large/);
  const big = actionsHarness(FREE);
  push(big.h.store, newJob(1, 1)); await big.h.tick();
  big.gh.finish(9001, { schemaVersion: 1, jobId: uuid(1), engine: 'qwen-free', status: 'no_changes' });
  big.gh.runs.get(9001)!.artifactSize = 50_000;
  await big.h.tick();
  assert.match(job(await big.h.state(), 1).message, /too large/);
  assert.ok(!big.gh.requests.some(r => r.url.includes('/zip')), 'an oversized artifact is never downloaded');
});

test('adapter refuses unsafe dispatches before any request: money on a free run, too-long task', async () => {
  const gh = new FakeActions();
  const adapter = new GitHubActionsAdapter('github_pat_fixture', { fetch: gh.fetch as typeof fetch });
  const base = { jobId: uuid(1), branch: `agent-empire/task-${uuid(1)}`, execution: exec(FREE) as CloudExecution };
  await assert.rejects(adapter.dispatch({ ...base, prompt: 'x', budgetCents: 100 }), (e: unknown) => e instanceof DispatchFailure && !e.sent);
  await assert.rejects(adapter.dispatch({ ...base, prompt: 'é'.repeat(MAX_TASK_B64), budgetCents: 0 }), (e: unknown) => e instanceof DispatchFailure && !e.sent && /too long/.test(e.message));
  await assert.rejects(adapter.dispatch({ ...base, execution: EXECUTION, prompt: 'x', budgetCents: 0 }), (e: unknown) => e instanceof DispatchFailure && !e.sent);
  assert.equal(gh.requests.length, 0);
  assert.equal(new GitHubActionsAdapter('').canDispatch, false);
});

test('router: picks the adapter from the execution and the session id, never from which keys exist', async () => {
  const anthropic = new FakeProvider();
  const actions = new UnavailableProvider('no project token');
  const router = new ProviderRouter({ anthropic, 'github-actions': actions });
  assert.equal(router.canDispatchFor(EXECUTION), anthropic.canDispatch);
  assert.equal(router.canDispatchFor(exec(FREE)), false);
  assert.equal(router.canDispatchFor(undefined), false);
  await assert.rejects(router.observe('ghrun_5', {}), /no project token/);
  const env = providersFromEnv({ PROJECT_GITHUB_TOKEN: 'github_pat_x' });
  assert.equal(env.canDispatchFor(exec(FREE)), true);
  assert.equal(env.canDispatchFor(EXECUTION), false, 'no Anthropic key: Anthropic jobs still wait');
  // The coordinator never reads a Claude token: providersFromEnv ignores it entirely.
  assert.equal(providersFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-xyz' }).canDispatchFor(exec(SUB)), false);
});

test('Anthropic Managed Agents path is unchanged: queued jobs keep provider anthropic and money reservations', async () => {
  const h = harness(makeStore());
  push(h.store, newJob(1, 1));
  await h.tick();
  const j = job(await h.state(), 1);
  assert.equal(j.provider, 'anthropic');
  assert.equal(j.reservation?.basis, 'per_job_allowance_estimate');
  assert.equal(j.reservation?.cents, 100);
  assert.equal(j.cost?.basis ?? 'provider_reported_list_cost', 'provider_reported_list_cost');
});

// ---------------------------------------------------------------- workflow generation

const NASTY = ['${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}', '`rm -rf /`', '$(curl evil)', 'line1\nline2\n  - run: echo pwned', "'; exit 0; '", '"quoted"'].join('\n');

test('job workflow: pinned SHAs, minimal permissions, workflow_dispatch only, caps, no secret exposure', () => {
  for (const settings of [FREE, SUB, KEY, { ...FREE, modelSource: 'self_hosted_ollama', runnerLabel: 'gpu-box', model: 'gpt-oss:20b' } as ActionsSettings, { ...FREE, modelSource: 'hosted_free_key', model: 'qwen/qwen3-coder:free', hostedBaseUrl: 'https://openrouter.ai/api/v1' } as ActionsSettings]) {
    const yaml = jobWorkflow({ owner: 'fixture', name: 'repo', baseBranch: 'main' }, settings);
    for (const line of yaml.split('\n').filter(l => /^\s*-? ?uses:/.test(l))) assert.match(line, /@[0-9a-f]{40} # v/, `pinned: ${line}`);
    assert.match(yaml, /^permissions: \{\}$/m);
    assert.match(yaml, /^ {6}contents: write$/m);
    assert.doesNotMatch(yaml, /pull_request_target|pull_request:|push:|schedule:|id-token|actions: write/);
    assert.match(yaml, /^on:\n {2}workflow_dispatch:/m);
    assert.match(yaml, new RegExp(`timeout-minutes: ${settings.timeoutMinutes}\\n`));
    assert.match(yaml, /concurrency:\n {2}group: agent-empire-job-\$\{\{ inputs\.job_id \}\}/);
    assert.match(yaml, /if: github\.repository == 'fixture\/repo'/);
    assert.match(yaml, /persist-credentials: false/);
    // Inputs reach shell only through env, never interpolated into a run: line.
    for (const line of yaml.split('\n').filter(l => /\$\{\{/.test(l))) {
      assert.ok(!/^\s*(run:|.*\$\(|echo .*\$\{\{)/.test(line) || /run-name/.test(line), `expression outside env/with: ${line}`);
    }
    assert.doesNotMatch(yaml, /run: [^\n]*\$\{\{/, 'no expression on a single-line run');
    const secrets = [...yaml.matchAll(/secrets\.([A-Z_]+)/g)].map(m => m[1]);
    assert.ok(secrets.every(s => ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'FREE_LLM_API_KEY'].includes(s)));
    assert.ok(secrets.length <= 1, 'at most one engine secret per workflow');
  }
  const free = jobWorkflow({ owner: 'fixture', name: 'repo', baseBranch: 'main' }, FREE);
  assert.ok(free.includes(`npm pack @qwen-code/qwen-code@${JOB_PINS.qwen.version}`));
  assert.ok(free.includes(`${QWEN_SHA512_HEX}  qwen-code-qwen-code-${JOB_PINS.qwen.version}.tgz" | sha512sum -c -`));
  assert.ok(free.includes(`${JOB_PINS.ollama.sha256}  ollama.tar.zst" | sha256sum -c -`));
  assert.doesNotMatch(free, /GH_TOKEN[^\n]*\n[^\n]*qwen --prompt/, 'Qwen runs without a GitHub token');
  assert.match(free, /pull-requests: write/);
  const sub = jobWorkflow({ owner: 'fixture', name: 'repo', baseBranch: 'main' }, SUB);
  assert.ok(sub.includes(`anthropics/claude-code-action@${JOB_PINS.claudeCodeAction.sha} # ${JOB_PINS.claudeCodeAction.version}`));
  assert.ok(sub.includes('claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}'));
  assert.doesNotMatch(sub, /anthropic_api_key/);
  const key = jobWorkflow({ owner: 'fixture', name: 'repo', baseBranch: 'main' }, KEY);
  assert.ok(key.includes('anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}'));
  assert.doesNotMatch(key, /pull-requests: write/);
  assert.ok(free.includes(PINNED_ACTIONS.checkout.sha));
});

test('job workflow: the task never enters the YAML, whatever it contains; dispatch carries it base64 only', async () => {
  const yaml = jobWorkflow({ owner: 'fixture', name: 'repo', baseBranch: 'main' }, FREE);
  assert.ok(!yaml.includes('rm -rf') && !yaml.includes('pwned'));
  assert.match(yaml, /TASK_B64: \$\{\{ inputs\.task_b64 \}\}\n {8}run: \|\n {10}set -euo pipefail\n {10}\[\[ "\$TASK_B64" =~ \^\[A-Za-z0-9\+\/\]\+=\{0,2\}\$ \]\]/);
  assert.ok(yaml.includes(JSON.stringify(ENGINE_INSTRUCTION)));
  const gh = new FakeActions();
  const adapter = new GitHubActionsAdapter('github_pat_fixture', { fetch: gh.fetch as typeof fetch });
  await adapter.dispatch({ jobId: uuid(1), branch: `agent-empire/task-${uuid(1)}`, execution: exec(FREE), prompt: NASTY, budgetCents: 0 });
  const inputs = gh.requests.find(r => r.url.endsWith('/dispatches'))!.body.inputs;
  assert.match(inputs.task_b64, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from(inputs.task_b64, 'base64').toString('utf8'), NASTY);
  for (const [k, v] of Object.entries(inputs)) if (k !== 'task_b64') assert.match(String(v), /^[0-9a-f-]+$/, k);
  assert.equal(gh.runs.get(9001)!.title, runTitle(uuid(1), 0, 30));
});

test('settings validation refuses anything that could inject into YAML', () => {
  const bad: unknown[] = [
    { ...FREE, modelSource: 'self_hosted_ollama', runnerLabel: 'x]\n  evil: 1', model: 'm' },
    { ...FREE, modelSource: 'self_hosted_ollama', runnerLabel: 'ok', model: "m' ; curl x" },
    { ...FREE, modelSource: 'hosted_free_key', model: 'm', hostedBaseUrl: 'http://insecure.example/v1' },
    { ...FREE, modelSource: 'hosted_free_key', model: 'm', hostedBaseUrl: 'https://user:pw@x.example/v1' },
    { ...FREE, modelSource: 'hosted_free_key', model: 'm', hostedBaseUrl: 'https://x.example/v1?key=${{ secrets.X }}' },
    { ...FREE, maxTurns: 0 }, { ...FREE, timeoutMinutes: 361 }, { ...SUB, model: 'x' }, { ...FREE, extra: 1 },
  ];
  for (const b of bad) assert.throws(() => validateActionsSettings(b), undefined, JSON.stringify(b));
  assert.throws(() => jobWorkflow({ owner: 'a b', name: 'r', baseBranch: 'main' }, FREE));
  assert.throws(() => jobWorkflow({ owner: 'a', name: 'r', baseBranch: 'main\nx' }, FREE));
});

test('model source order: self-hosted runner, then free hosted key, then CPU; honest labels', () => {
  assert.equal(chooseModelSource({ selfHostedLabel: 'box', hostedKeyOptIn: true, cpuOptIn: true }), 'self_hosted_ollama');
  assert.equal(chooseModelSource({ hostedKeyOptIn: true, cpuOptIn: true }), 'hosted_free_key');
  assert.equal(chooseModelSource({ cpuOptIn: true }), 'cpu_small');
  assert.equal(chooseModelSource({}), null);
  assert.equal(engineLabel(validateActionsSettings(FREE)), 'Qwen Code · qwen2.5-coder:1.5b (CPU, slow)');
  assert.equal(engineLabel(SUB), 'Claude Code · your Claude account');
});

// ---------------------------------------------------------------- setup: secret names only, workflow install

test('secret check reads names only, reminds to rotate at 11 months, and has no way to accept a token', async () => {
  const gh = new FakeActions();
  const client = new GitHubClient('gho_user', { fetch: gh.fetch as typeof fetch });
  const now = Date.parse('2026-10-24T00:00:00Z');
  assert.deepEqual(await checkJobSecret(client, { owner: 'fixture', name: 'repo' }, SUB, now), { name: 'CLAUDE_CODE_OAUTH_TOKEN', present: false });
  gh.secrets = [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', updated_at: '2025-11-01T00:00:00Z' }];
  const due = await checkJobSecret(client, { owner: 'fixture', name: 'repo' }, SUB, now);
  assert.equal(due.present, true); assert.equal(due.rotationDue, true);
  gh.secrets = [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', updated_at: '2026-10-01T00:00:00Z' }];
  assert.equal((await checkJobSecret(client, { owner: 'fixture', name: 'repo' }, SUB, now)).rotationDue, false);
  assert.deepEqual(await checkJobSecret(client, { owner: 'fixture', name: 'repo' }, FREE, now), { name: null, present: true });
  const reqs = gh.requests;
  assert.ok(reqs.every(r => r.method === 'GET' && r.body === undefined), 'only GETs, never a secret write');
  assert.equal(checkJobSecret.length, 4, 'no token parameter');
  assert.equal(rotationStatus(undefined, now).due, false);
  assert.deepEqual(subscriptionChecklist({ owner: 'fixture', name: 'repo' }), ['claude setup-token', 'gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo fixture/repo']);
});

test('job workflow install commits once and skips when unchanged', async () => {
  const gh = new FakeActions();
  const client = new GitHubClient('gho_user', { fetch: gh.fetch as typeof fetch });
  const target = { owner: 'fixture', name: 'repo', baseBranch: 'main' };
  assert.equal(await installJobWorkflow(client, target, FREE), 'installed');
  assert.equal(await installJobWorkflow(client, target, FREE), 'unchanged');
  assert.equal(await installJobWorkflow(client, target, SUB), 'installed');
  assert.equal(gh.requests.filter(r => r.method === 'PUT').length, 2);
});
