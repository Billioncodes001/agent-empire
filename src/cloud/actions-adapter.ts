/**
 * FREE-04 `github-actions` provider adapter: each job is one workflow_dispatch run of the generated job workflow
 * (job-workflow.ts) in the project repository, started with the project token (PROJECT_GITHUB_TOKEN, which needs
 * Actions read/write and Contents read on that repository).
 *
 * Money-safety rules are the coordinator's (tick.ts) and unchanged: the job is committed as `dispatching` with its
 * reservation before the dispatch request; a request that may have reached GitHub (network error, timeout, 5xx, or a
 * 2xx without a run id) is `DispatchFailure(sent: true)` and becomes `dispatch_uncertain`, never retried; a finished
 * run is `awaiting_review`; city credits move only on accept. Free and subscription runs reserve no money (their caps
 * are the workflow's timeout and turn limit) and report `costCents = 0`; API-key runs report Claude Code's own estimate.
 *
 * Session ids are `ghrun_<run id>`. The run's repository and job identity travel in the job cursor, and every
 * observation re-checks the run's title ("Agent Empire job <id> budget <n>c turns <t>") before trusting it.
 */
import { safeExecutionError } from '../server/execution-errors.js';
import { COMMIT } from '../server/execution-validation.js';
import { ARTIFACT_MAX_BYTES, billingNote, isMoneyEngine, JOB_WORKFLOW_FILE, MAX_TASK_B64, parseRunResult, RESULT_ARTIFACT, RESULT_FILE, RESULT_MAX_BYTES, type CloudEngine, type RunResult } from './actions-spec.js';
import { DispatchFailure, type DispatchRequest, type ProviderAdapter, type ProviderObservation } from './provider.js';
import type { ActionsCursor, CloudExecution, EventCursorState } from './schema.js';
import { GitHubClient, GitHubError } from './store.js';

export const ACTIONS_SESSION = /^ghrun_[1-9][0-9]{0,19}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** GitHub said "slow down": no further GitHub call is made in this coordinator run. A 4xx, so a dispatch is provably not sent. */
export class RateLimited extends GitHubError {
  constructor() { super(429, 'github_rate_limited', 'GitHub rate limit reached; the coordinator backs off and polls again on its next run.'); this.name = 'RateLimited'; }
}
const TASK_BRANCH = /^agent-empire\/task-[a-f0-9-]{36}$/;

export const runTitle = (jobId: string, budgetCents: number, maxTurns: number) => `Agent Empire job ${jobId} budget ${budgetCents}c turns ${maxTurns}`;

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Reads `name` from a small zip (stored or deflated) without trusting its sizes: the entry is refused if its
 * uncompressed form exceeds `maxBytes`. Portable (DecompressionStream works in Node 20 and browsers).
 */
export async function readZipEntry(zip: Uint8Array, name: string, maxBytes: number): Promise<string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let offset = 0;
  while (offset + 30 <= zip.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    let compressed = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const entryName = new TextDecoder().decode(zip.subarray(offset + 30, offset + 30 + nameLen));
    const start = offset + 30 + nameLen + extraLen;
    if (flags & 0x08) {
      // Sizes are in the central directory; find this entry there.
      const central = findCentral(zip, view, entryName);
      if (central === null) throw new Error('Unreadable zip.');
      compressed = central;
    }
    if (start + compressed > zip.length) throw new Error('Truncated zip.');
    if (entryName === name) {
      const data = zip.subarray(start, start + compressed);
      let bytes: Uint8Array;
      if (method === 0) bytes = data;
      else if (method === 8) bytes = await inflateBounded(data, maxBytes);
      else throw new Error('Unsupported zip compression.');
      if (bytes.length > maxBytes) throw new Error('Zip entry too large.');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    offset = start + compressed + (flags & 0x08 ? descriptorLength(view, start + compressed) : 0);
  }
  throw new Error(`${name} is not in the artifact.`);
}
function findCentral(zip: Uint8Array, view: DataView, name: string): number | null {
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) !== 0x06054b50) continue;
    let p = view.getUint32(i + 16, true);
    const count = view.getUint16(i + 10, true);
    for (let n = 0; n < count && p + 46 <= zip.length; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) return null;
      const size = view.getUint32(p + 20, true);
      const nl = view.getUint16(p + 28, true), el = view.getUint16(p + 30, true), cl = view.getUint16(p + 32, true);
      if (new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nl)) === name) return size;
      p += 46 + nl + el + cl;
    }
    return null;
  }
  return null;
}
const descriptorLength = (view: DataView, at: number) => (at + 4 <= view.byteLength && view.getUint32(at, true) === 0x08074b50 ? 16 : 12);
async function inflateBounded(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    // Not awaited: cancelling a piped stream can wait on its source, and the refusal must not hang the coordinator.
    if (total > maxBytes) { void reader.cancel().catch(() => {}); throw new Error('Zip entry too large.'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Reads a body chunk by chunk and stops past `max` bytes, whatever content-length said (or omitted). */
async function readCapped(response: Response, max: number, controller?: AbortController): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { controller?.abort(); void reader.cancel().catch(() => {}); throw new Error('the result artifact is too large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export class GitHubActionsAdapter implements ProviderAdapter {
  readonly provider = 'github-actions' as const;
  readonly canDispatch: boolean;
  /** Nothing to provision: setup commits the job workflow; the coordinator only dispatches it. */
  readonly canProvision = false;
  private github: GitHubClient;
  private transport: typeof fetch;
  private timeoutMs: number;
  private apiBase: string;
  /** Runs closed in this coordinator run (a finished run has nothing to archive on GitHub). */
  private closed = new Set<string>();
  /** Where each observed run lives, so interrupt (always preceded by observe in tick.ts) can address it. */
  private lastSeen = new Map<string, { owner: string; name: string }>();
  /** Set by a 429, or a 403 that says "rate limit"; every later call in this run fails fast without a request. */
  private rateLimited = false;

  constructor(private githubToken: string, options: { fetch?: typeof fetch; timeoutMs?: number; apiBase?: string } = {}) {
    this.transport = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.apiBase = options.apiBase ?? 'https://api.github.com';
    this.github = new GitHubClient(githubToken, { fetch: this.transport, timeoutMs: this.timeoutMs, apiBase: this.apiBase });
    this.canDispatch = !!githubToken;
  }

  /** All GitHub calls go through here, so one rate-limit reply stops the rest of this run's calls. */
  private async api(method: 'GET' | 'POST', route: string, body?: unknown) {
    if (this.rateLimited) throw new RateLimited();
    try { return await this.github.request(method, route, body); }
    catch (error) {
      if (error instanceof GitHubError && (error.status === 429 || (error.status === 403 && /rate limit/i.test(error.message)))) { this.rateLimited = true; throw new RateLimited(); }
      throw error;
    }
  }

  async provision(): Promise<never> { throw new Error('GitHub Actions jobs need no provisioning: setup installs the job workflow.'); }

  async dispatch(request: DispatchRequest): Promise<{ sourceCommit: string; observation: ProviderObservation; cursor: EventCursorState }> {
    const execution = request.execution;
    if (execution.provider !== 'github-actions') throw new DispatchFailure(false, 'This Empire does not run jobs in GitHub Actions.');
    if (!this.canDispatch) throw new DispatchFailure(false, 'The project GitHub token (PROJECT_GITHUB_TOKEN) is not configured in the state repository secrets. No run was started.');
    if (this.rateLimited) throw new DispatchFailure(false, 'GitHub rate limit reached earlier in this coordinator run. No run was started; the job waits for the next run.', false);
    const { owner, name, baseBranch } = execution.repository;
    const settings = execution.actions;
    const money = isMoneyEngine(settings.engine);
    if (!money && request.budgetCents !== 0) throw new DispatchFailure(false, 'A free or subscription run must not reserve money. No run was started.');
    const taskB64 = utf8ToBase64(request.prompt);
    if (taskB64.length > MAX_TASK_B64) throw new DispatchFailure(false, 'The task is too long for a GitHub Actions dispatch (about 44,000 characters at most). Shorten it. No run was started.');
    const base = `/repos/${owner}/${name}`;
    let sourceCommit: string;
    try {
      const head = await this.api('GET', `${base}/commits/${encodeURIComponent(baseBranch)}`);
      sourceCommit = head.data?.sha;
      if (typeof sourceCommit !== 'string' || !COMMIT.test(sourceCommit)) throw new Error('GitHub returned an invalid commit.');
    } catch (error) {
      if (error instanceof RateLimited) throw new DispatchFailure(false, `${error.message} No run was started.`, false);
      throw new DispatchFailure(false, `${safeExecutionError(error).message} No run was started.`);
    }
    let data: any;
    try {
      ({ data } = await this.api('POST', `${base}/actions/workflows/${JOB_WORKFLOW_FILE}/dispatches`, {
        ref: baseBranch,
        inputs: { job_id: request.jobId, source_commit: sourceCommit, task_b64: taskB64, max_turns: String(settings.maxTurns), budget_cents: String(request.budgetCents) },
        return_run_details: true,
      }));
    } catch (error) {
      // GitHub answered 4xx: the dispatch was refused, so no run exists. Anything else may have started one.
      if (error instanceof RateLimited) throw new DispatchFailure(false, `${error.message} No run was started.`, false);
      if (error instanceof GitHubError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        const hint = error.status === 404 ? ` Is ${JOB_WORKFLOW_FILE} on ${baseBranch}, and may the project token use Actions?` : error.status === 403 ? ' The project token needs Actions read and write on this repository.' : '';
        throw new DispatchFailure(false, `GitHub refused to start the job run (HTTP ${error.status}).${hint} No run was started.`);
      }
      throw new DispatchFailure(true, `The dispatch request to GitHub did not complete cleanly. A run may have started: check the Actions tab of ${owner}/${name} for “${runTitle(request.jobId, request.budgetCents, settings.maxTurns)}”.`);
    }
    const runId = data?.workflow_run_id;
    if (!Number.isSafeInteger(runId) || runId < 1) {
      throw new DispatchFailure(true, `GitHub accepted the dispatch but did not return a run id. A run has probably started: check the Actions tab of ${owner}/${name} for “${runTitle(request.jobId, request.budgetCents, settings.maxTurns)}”.`);
    }
    const sessionId = `ghrun_${runId}`;
    const cursor: EventCursorState = { actions: { owner, name, runId, jobId: request.jobId, engine: settings.engine, budgetCents: request.budgetCents, maxTurns: settings.maxTurns } };
    return {
      sourceCommit, cursor,
      observation: {
        sessionId, status: 'running', providerStatus: 'running', budgetCents: request.budgetCents,
        ...(money ? {} : { costCents: 0, costBasis: settings.engine === 'qwen-free' ? 'free_run' as const : 'claude_plan' as const }),
        message: `GitHub Actions run ${runId} started from ${sourceCommit.slice(0, 12)} (${billingNote(settings.engine)}).`,
      },
    };
  }

  private actionsOf(sessionId: string, cursor: EventCursorState): ActionsCursor {
    const a = cursor.actions;
    if (!ACTIONS_SESSION.test(sessionId) || !a || `ghrun_${a.runId}` !== sessionId) throw new Error('The GitHub Actions run reference is missing from this job.');
    if (typeof a.owner !== 'string' || typeof a.name !== 'string' || !OWNER.test(a.owner) || !REPO.test(a.name)) throw new Error('The GitHub Actions run reference names an invalid repository.');
    return a;
  }

  async observe(sessionId: string, cursor: EventCursorState): Promise<{ observation: ProviderObservation; cursor: EventCursorState }> {
    const a = this.actionsOf(sessionId, cursor);
    this.lastSeen.set(sessionId, { owner: a.owner, name: a.name });
    const next: EventCursorState = { ...cursor, actions: { ...a } };
    const money = isMoneyEngine(a.engine);
    const free: Partial<ProviderObservation> = money ? {} : { costCents: 0, costBasis: a.engine === 'qwen-free' ? 'free_run' : 'claude_plan' };
    if (this.closed.has(sessionId)) {
      return { cursor: next, observation: { sessionId, status: 'cancelled', providerStatus: 'archived', budgetCents: a.budgetCents, ...free, message: 'The run record is closed.' } };
    }
    const { data: run } = await this.api('GET', `/repos/${a.owner}/${a.name}/actions/runs/${a.runId}`);
    const title = typeof run?.display_title === 'string' ? run.display_title : '';
    const ours = title === runTitle(a.jobId, a.budgetCents, a.maxTurns) && typeof run?.path === 'string' && run.path.endsWith(`/${JOB_WORKFLOW_FILE}`);
    // Without a matching title the caps are unconfirmed: budgetCents is left out, so the coordinator marks it unknown.
    const budget = ours ? { budgetCents: a.budgetCents } : {};
    const identity = ours ? '' : ' Its title does not match this job, so its caps are unconfirmed.';
    const status = String(run?.status ?? '');
    if (status !== 'completed') {
      return { cursor: next, observation: { sessionId, status: 'running', providerStatus: 'running', ...budget, ...free, message: `GitHub Actions run ${a.runId} is ${status.replace(/_/g, ' ') || 'in an unknown state'}.${identity}` } };
    }
    const conclusion = String(run?.conclusion ?? '');
    if (conclusion === 'cancelled') return { cursor: next, observation: { sessionId, status: 'cancelled', providerStatus: 'archived', ...budget, ...free, message: `GitHub Actions run ${a.runId} was cancelled.` } };
    if (conclusion !== 'success') {
      const why = conclusion === 'timed_out' ? 'hit its time cap' : conclusion === 'startup_failure' ? 'could not start (check the workflow and runner)' : `ended with “${conclusion.slice(0, 40) || 'unknown'}”`;
      return { cursor: next, observation: { sessionId, status: 'failed', providerStatus: 'terminated', ...budget, ...free, message: `GitHub Actions run ${a.runId} ${why}. Nothing is retried automatically.` } };
    }
    let result: RunResult;
    try { result = await this.readResult(a); }
    catch (error) {
      next.stopReason = 'error';
      return { cursor: next, observation: { sessionId, status: 'idle', providerStatus: 'idle', ...budget, ...free, message: `GitHub Actions run ${a.runId} finished, but its result could not be used (${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}). Check the run, then accept, reject or cancel.` } };
    }
    next.stopReason = 'end_turn';
    const cost = money && result.costUsdEstimate !== undefined ? { costCents: Math.ceil(result.costUsdEstimate * 100), costBasis: 'engine_reported_estimate' as const } : free;
    const what = result.status === 'changes_pushed' ? `pushed ${result.headSha!.slice(0, 12)}${result.pullRequest ? ` and opened draft PR #${result.pullRequest}` : ''}` : result.status === 'no_changes' ? 'made no changes' : 'could not push its changes';
    return { cursor: next, observation: { sessionId, status: 'idle', providerStatus: 'idle', ...budget, ...cost, message: `GitHub Actions run ${a.runId} finished and ${what} (${billingNote(a.engine)}). Unverified until you review it.` } };
  }

  /** Lists the run's artifacts, downloads the one result artifact within the size caps, and validates it. */
  private async readResult(a: ActionsCursor): Promise<RunResult> {
    const { data } = await this.api('GET', `/repos/${a.owner}/${a.name}/actions/runs/${a.runId}/artifacts?per_page=10`);
    const list = Array.isArray(data?.artifacts) ? data.artifacts : [];
    const found = list.filter((x: any) => x?.name === RESULT_ARTIFACT);
    if (found.length !== 1) throw new Error('the result artifact is missing');
    const artifact = found[0];
    if (artifact.expired) throw new Error('the result artifact expired');
    if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes > ARTIFACT_MAX_BYTES) throw new Error('the result artifact is too large');
    if (!Number.isSafeInteger(artifact.id)) throw new Error('the result artifact has no id');
    const bytes = await this.download(`/repos/${a.owner}/${a.name}/actions/artifacts/${artifact.id}/zip`);
    const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
    const text = isZip ? await readZipEntry(bytes, RESULT_FILE, RESULT_MAX_BYTES) : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return parseRunResult(text, { jobId: a.jobId, engine: a.engine as CloudEngine });
  }

  /** GitHub answers with a redirect to blob storage; the token is sent only to GitHub, never to the redirect target. */
  private async download(route: string): Promise<Uint8Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response = await this.transport(this.apiBase + route, { redirect: 'manual', signal: controller.signal, headers: { authorization: `Bearer ${this.githubToken}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Agent-Empire-Coordinator' } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || !/^https:\/\//.test(location)) throw new Error('the artifact download had no safe location');
        response = await this.transport(location, { redirect: 'error', signal: controller.signal });
      }
      if (!response.ok) throw new Error(`the artifact download failed (HTTP ${response.status})`);
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > ARTIFACT_MAX_BYTES) { controller.abort(); throw new Error('the result artifact is too large'); }
      return await readCapped(response, ARTIFACT_MAX_BYTES, controller);
    } finally { clearTimeout(timer); }
  }

  /** Cancels a running workflow run. Only called for a stop already committed to the state branch. */
  async interrupt(sessionId: string): Promise<void> {
    const runId = sessionId.slice('ghrun_'.length);
    if (!ACTIONS_SESSION.test(sessionId)) throw new Error('Invalid run reference.');
    // The run's repository is not in the session id; interrupt is preceded by observe, which recorded it.
    const target = this.lastSeen.get(sessionId);
    if (!target) throw new Error('The run must be observed before it is cancelled.');
    try { await this.api('POST', `/repos/${target.owner}/${target.name}/actions/runs/${runId}/cancel`); }
    catch (error) { if (!(error instanceof GitHubError && error.status === 409)) throw error; } // 409: already finished
  }

  /** A finished run bills nothing more and has no session to archive; the record is closed for this coordinator run. */
  async archive(sessionId: string): Promise<void> {
    if (!ACTIONS_SESSION.test(sessionId)) throw new Error('Invalid run reference.');
    this.closed.add(sessionId);
  }

  async branchHead(execution: CloudExecution, branch: string): Promise<{ state: 'found'; sha: string } | { state: 'missing' }> {
    if (!this.githubToken) throw new Error('The project GitHub token is not configured.');
    if (!TASK_BRANCH.test(branch)) throw new Error('Unexpected task branch name.');
    const { owner, name } = execution.repository;
    try {
      const ref = await this.api('GET', `/repos/${owner}/${name}/git/ref/heads/${branch}`);
      const sha = ref.data?.object?.sha;
      if (typeof sha !== 'string' || !COMMIT.test(sha)) throw new Error('GitHub returned an invalid branch head.');
      return { state: 'found', sha };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return { state: 'missing' };
      throw error;
    }
  }
}
