/**
 * CLOUD-06 slice 06-2/06-5: OpenAI Agents API adapter for the cloud coordinator (owner decision D1: Agents API with an
 * OpenAI-hosted sandbox; the Responses API + hosted shell route is only a documented fallback and is not built).
 *
 * Transport rules match AnthropicManaged: no SDK, no automatic retries, a 2 MiB response cap, `redirect: 'error'`, a
 * timeout, and user-safe errors that never echo upstream bodies. Headers: `Authorization: Bearer`, `OpenAI-Beta:
 * agents=v1`, `content-type`.
 *
 * Money safety (docs/team/CLOUD_06_OPENAI_PLAN.md §5): the coordinator reserves the allowance before dispatch; session
 * creation is sent once and never retried (any doubt → `sent: true` → dispatch_uncertain); the adapter reports a
 * conservative ESTIMATE (`estimate_from_reported_usage`), never a provider dollar figure; the coordinator cancels the turn
 * when the estimate reaches the reservation, because OpenAI has no documented per-session budget.
 *
 * Everything below marked UNVERIFIED is taken from the guides, not the per-method reference (which returned 404 on
 * 2026-10-08), and must be confirmed by the owner's first real run before `openaiVerified` is set:
 *   - endpoint paths and JSON field names for vaults, credentials, sessions, turns, events (U1, U3)
 *   - `metadata` accepted on session create and echoed (U1); model ids accepted by the Agents API (U2)
 *   - `usage` field names and when they are populated (U5); `created_at` units
 *   - container billing granularity (U7); whether DELETE stops billing and 404s afterwards (U6)
 *   - the id formats (OPENAI_ID in schema.ts)
 */
import { COMMIT } from '../server/execution-validation.js';
import { GitHubClient, GitHubError } from './store.js';
import { DispatchFailure, ProvisionError, type DispatchRequest, type ProviderAdapter, type ProviderObservation, type ProvisionResult } from './provider.js';
import { isOpenAIId, type CloudExecution, type EventCursorState, type OpenAICursor } from './schema.js';
import { isOpenAIWorkerModel, type AnyWorkerModel } from './worker-spec.js';
import { estimateCents, OPENAI_ENVIRONMENT, OPENAI_NOT_VERIFIED_MESSAGE, OPENAI_WORKER_INSTRUCTIONS, type ContainerSize } from './openai-spec.js';
import { HELPER_PATH, HELPER_SETUP_COMMAND, helperBase64 } from './openai-repo-helper.js';

export const OPENAI_API = 'https://api.openai.com';
const MAX_BYTES = 2 * 1024 * 1024;
/** The vault and credential the coordinator manages (found again by metadata, then by name). */
export const OPENAI_VAULT = { name: 'agent-empire-worker', marker: { agent_empire_role: 'worker_vault' } } as const;
export const GITHUB_SECRET_NAME = 'AE_GITHUB_TOKEN';
export const GITHUB_ALLOWED_HOSTS = ['api.github.com'] as const;
/** Names the Agents API rejects in `environment.env` (openai-hosted guide), plus anything that looks like a secret. */
export const RESERVED_ENV = /^(OPENAI_API_KEY|PATH|CODEX_.*)$/;
export const logsHint = (jobId: string) => `Check platform.openai.com/logs?api=agents for task ${jobId}.`;

export interface OpenAICredentials { apiKey: string; githubToken: string }

/** User-safe OpenAI failure; `status` 0 means no HTTP answer (network, timeout, oversize, invalid JSON). */
export class OpenAIError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'OpenAIError'; }
}

export class OpenAITransport {
  constructor(private fetchImpl: typeof fetch, private apiKey: string, private timeoutMs = 15_000) {}
  async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; data: any }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const label = `${method} ${path.split('?')[0].replace(/\/[a-z]+_[A-Za-z0-9_-]+/g, '/{id}')}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${OPENAI_API}${path}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${this.apiKey}`, 'openai-beta': 'agents=v1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new OpenAIError(0, `OpenAI ${label} got no answer (network error or timeout).`); }
    finally { clearTimeout(timer); }
    let text: string;
    try { text = await response.text(); } catch { throw new OpenAIError(0, `OpenAI ${label} returned an unreadable response.`); }
    if (text.length > MAX_BYTES) throw new OpenAIError(0, `OpenAI ${label} returned more than 2 MiB.`);
    let data: any = null;
    if (text) { try { data = JSON.parse(text); } catch { if (response.ok) throw new OpenAIError(0, `OpenAI ${label} returned invalid JSON.`); } }
    if (!response.ok) {
      const code = typeof data?.error?.code === 'string' ? ` (${data.error.code.replace(/[^a-z0-9_.-]/gi, '').slice(0, 60)})` : '';
      throw new OpenAIError(response.status, `OpenAI ${label} failed with HTTP ${response.status}${code}.`);
    }
    return { status: response.status, data };
  }
}

const list = (data: any): any[] => (Array.isArray(data?.data) ? data.data.filter((x: unknown) => x && typeof x === 'object') : []);
/** Seconds or milliseconds since the epoch, or an ISO date (UNVERIFIED units). */
export function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') { const t = Date.parse(value); if (Number.isFinite(t)) return t; }
  return undefined;
}
const count = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined);
/** Best-effort usage; `undefined` when OpenAI reports none yet ("can be null when unknown"). */
export function parseUsage(u: any): OpenAICursor['usage'] | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const input = count(u.input_tokens); const output = count(u.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    input: input ?? 0,
    cached: count(u.cached_tokens) ?? count(u.input_tokens_details?.cached_tokens) ?? 0,
    output: output ?? 0,
    reasoning: count(u.reasoning_tokens) ?? count(u.output_tokens_details?.reasoning_tokens) ?? 0,
  };
}
/** Usage "may change": keep the maximum seen per field, so the estimate never goes down. */
function maxUsage(a: OpenAICursor['usage'], b: OpenAICursor['usage']): OpenAICursor['usage'] {
  if (!a) return b; if (!b) return a;
  return { input: Math.max(a.input, b.input), cached: Math.max(a.cached, b.cached), output: Math.max(a.output, b.output), reasoning: Math.max(a.reasoning, b.reasoning) };
}

export class OpenAICloudAdapter implements ProviderAdapter {
  readonly provider = 'openai' as const;
  readonly budget = 'coordinator_estimate' as const;
  readonly canDispatch: boolean;
  readonly canProvision: boolean;
  readonly blockedReason?: string;
  readonly verified: boolean;
  private api: OpenAITransport;
  private github: GitHubClient;
  private now: () => number;
  private checked = new Map<string, Promise<string>>();

  constructor(private credentials: OpenAICredentials, options: { fetch?: typeof fetch; timeoutMs?: number; now?: () => number; verified?: boolean } = {}) {
    const fetchImpl = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.api = new OpenAITransport(fetchImpl, credentials.apiKey, options.timeoutMs ?? 15_000);
    this.github = new GitHubClient(credentials.githubToken, { fetch: fetchImpl, timeoutMs: options.timeoutMs ?? 15_000 });
    this.now = options.now ?? Date.now;
    this.verified = options.verified === true;
    this.canProvision = !!credentials.apiKey && this.verified;
    this.canDispatch = this.canProvision && !!credentials.githubToken;
    this.blockedReason = !credentials.apiKey ? 'the OPENAI_API_KEY Actions secret is not set in the state repository. Run setup again with an OpenAI key.'
      : !this.verified ? OPENAI_NOT_VERIFIED_MESSAGE
      : !credentials.githubToken ? 'the project GitHub token (PROJECT_GITHUB_TOKEN) is missing from the state repository secrets; OpenAI jobs need it to read and publish the task branch.'
      : undefined;
  }

  // ------------------------------------------------------------------ provisioning (vault + credential; no session)

  async provision(model: AnyWorkerModel): Promise<ProvisionResult> {
    if (!this.verified) throw new ProvisionError(OPENAI_NOT_VERIFIED_MESSAGE, true);
    if (!isOpenAIWorkerModel(model)) throw new ProvisionError('Unsupported OpenAI worker model. Choose one under Cloud Empire → Limits.', false);
    if (!this.credentials.apiKey) throw new ProvisionError('The OPENAI_API_KEY Actions secret is missing from the state repository. Run setup again with an OpenAI API key.', false);
    if (!this.credentials.githubToken) throw new ProvisionError('The PROJECT_GITHUB_TOKEN Actions secret is missing. OpenAI jobs need a fine-grained project token, which is stored in an OpenAI vault for api.github.com only. Run setup again with one.', false);
    try {
      const vault = await this.findOrCreateVault();
      const credential = await this.syncCredential(vault.id);
      return { provider: 'openai', vaultId: vault.id, credentialId: credential.id, vaultCreated: vault.created, credential: credential.kind, model };
    } catch (error) {
      if (error instanceof ProvisionError) throw error;
      const status = error instanceof OpenAIError ? error.status : 0;
      const message = error instanceof OpenAIError ? error.message : 'OpenAI setup failed unexpectedly.';
      throw new ProvisionError(`${message} No agent session was started.`, status === 0 || status === 429 || status >= 500);
    }
  }

  /** UNVERIFIED: GET/POST /v1/vaults and their `data`, `name`, `metadata` fields. */
  private async findOrCreateVault(): Promise<{ id: string; created: boolean }> {
    const pick = async () => {
      const items = list((await this.api.request('GET', '/v1/vaults?limit=100')).data).filter(v => isOpenAIId(v.id));
      return items.find(v => v.metadata?.agent_empire_role === OPENAI_VAULT.marker.agent_empire_role) ?? items.find(v => v.name === OPENAI_VAULT.name);
    };
    const existing = await pick();
    if (existing) return { id: existing.id, created: false };
    try {
      const created = (await this.api.request('POST', '/v1/vaults', { name: OPENAI_VAULT.name, metadata: OPENAI_VAULT.marker })).data;
      if (!isOpenAIId(created?.id)) throw new ProvisionError('OpenAI did not confirm the new vault.', true);
      return { id: created.id, created: true };
    } catch (error) {
      if (error instanceof ProvisionError && !error.retryable) throw error;
      const again = await pick(); // a lost create response, or another run, may have created it
      if (again) return { id: again.id, created: false };
      throw error;
    }
  }

  /**
   * Creates the AE_GITHUB_TOKEN credential, or overwrites an existing one with the current project token (rotation is
   * picked up on every provisioning run). The token is sent only in this request, to OpenAI's vault API.
   * UNVERIFIED: credential paths, `type: environment_variable`, `secret_name`, `value`, `allowed_hosts` field names.
   */
  private async syncCredential(vaultId: string): Promise<{ id: string; kind: 'created' | 'updated' }> {
    const body = { type: 'environment_variable', secret_name: GITHUB_SECRET_NAME, value: this.credentials.githubToken, allowed_hosts: [...GITHUB_ALLOWED_HOSTS] };
    const find = async () => list((await this.api.request('GET', `/v1/vaults/${vaultId}/credentials?limit=100`)).data).find(c => isOpenAIId(c.id) && c.secret_name === GITHUB_SECRET_NAME);
    const existing = await find();
    if (existing) {
      await this.api.request('POST', `/v1/vaults/${vaultId}/credentials/${existing.id}`, { value: body.value, allowed_hosts: body.allowed_hosts });
      return { id: existing.id, kind: 'updated' };
    }
    try {
      const created = (await this.api.request('POST', `/v1/vaults/${vaultId}/credentials`, body)).data;
      if (!isOpenAIId(created?.id)) throw new ProvisionError('OpenAI did not confirm the new vault credential.', true);
      return { id: created.id, kind: 'created' };
    } catch (error) {
      const again = await find();
      if (again) { await this.api.request('POST', `/v1/vaults/${vaultId}/credentials/${again.id}`, { value: body.value, allowed_hosts: body.allowed_hosts }); return { id: again.id, kind: 'updated' }; }
      throw error;
    }
  }

  // ------------------------------------------------------------------ dispatch

  /** The session-create body. Exported for tests: it must never contain the project token or the API key. */
  sessionBody(request: DispatchRequest, sourceCommit: string) {
    const execution = request.execution;
    if (execution.provider !== 'openai') throw new DispatchFailure(false, 'This Empire runs jobs on another provider. No paid session was requested.');
    const { owner, name } = execution.repository;
    const env: Record<string, string> = { AE_REPO: `${owner}/${name}`, AE_SOURCE_COMMIT: sourceCommit, AE_TASK_BRANCH: request.branch };
    return {
      // Inline agent (no saved agent). Web search and subagents are left off: their cost is not attributable.
      agent: { model: execution.openai.model, instructions: OPENAI_WORKER_INSTRUCTIONS, reasoning: { effort: 'medium' } },
      environment: {
        type: OPENAI_ENVIRONMENT.type, container_size: execution.openai.containerSize, network: { access: execution.openai.network },
        // UNVERIFIED shape of an inline file.
        files: [{ path: HELPER_PATH, content: helperBase64(), encoding: 'base64' }],
        setup_commands: [HELPER_SETUP_COMMAND],
        env,
      },
      vault_ids: [execution.openai.vaultId],
      metadata: { agent_empire_task_id: request.jobId }, // UNVERIFIED (U1): accepted on create and echoed
      input: [{ role: 'user', content: [
        `Agent Empire task ${request.jobId}.`,
        `Repository ${owner}/${name}, pinned at source commit ${sourceCommit}, is in /workspace/repo.`,
        `Task branch: ${request.branch}. Publish with \`node ${HELPER_PATH} publish "<commit message>"\`; it only ever writes that branch.`,
        'Task:', request.prompt,
      ].join('\n') }],
      stream: false,
    };
  }

  async dispatch(request: DispatchRequest): Promise<{ sourceCommit: string; observation: ProviderObservation; cursor: EventCursorState }> {
    if (!this.canDispatch) throw new DispatchFailure(false, `${this.blockedReason ?? 'OpenAI is not configured.'} No paid session was requested.`);
    const execution = request.execution;
    if (execution.provider !== 'openai') throw new DispatchFailure(false, 'This Empire runs jobs on another provider. No paid session was requested.');
    // (1) Read-only checks, once per run and configuration: any failure means nothing was sent.
    const key = JSON.stringify([execution.repository, execution.openai.vaultId]);
    let sourceCommit: string;
    try {
      let check = this.checked.get(key);
      if (!check) { check = this.precheck(execution); this.checked.set(key, check); }
      sourceCommit = await check;
    } catch (error) {
      this.checked.delete(key);
      const why = error instanceof OpenAIError || error instanceof GitHubError || error instanceof DispatchFailure ? error.message : 'The pre-dispatch check failed.';
      throw new DispatchFailure(false, `${why} No paid session was requested.`);
    }
    const body = this.sessionBody(request, sourceCommit);
    // Captured before the request, so a missing created_at can only overstate sandbox time.
    const sentAt = this.now();
    // (2) One create, never retried. Any failure after this point may have created a paid session.
    let data: any;
    try { data = (await this.api.request('POST', '/v1/agents/sessions', body)).data; }
    catch (error) {
      throw new DispatchFailure(true, `${error instanceof OpenAIError ? error.message : 'The OpenAI request failed.'} The session may have been accepted. ${logsHint(request.jobId)}`);
    }
    if (!isOpenAIId(data?.id)) throw new DispatchFailure(true, `OpenAI did not return a usable session id; the session may have been accepted. ${logsHint(request.jobId)}`);
    const cursor: EventCursorState = { openai: { createdAt: Math.min(sentAt, parseTime(data.created_at) ?? sentAt), model: execution.openai.model, containerSize: execution.openai.containerSize, observedAt: sentAt } };
    const mapped = this.map(data, undefined, cursor);
    return { sourceCommit, observation: mapped.observation, cursor: mapped.cursor };
  }

  private async precheck(execution: Extract<CloudExecution, { provider: 'openai' }>): Promise<string> {
    const vault = (await this.api.request('GET', `/v1/vaults/${execution.openai.vaultId}`)).data;
    if (vault?.id !== execution.openai.vaultId) throw new DispatchFailure(false, 'The OpenAI vault for this Empire was not found. Set up execution again under Cloud Empire → Limits.');
    const { owner, name, baseBranch } = execution.repository;
    await this.github.request('GET', `/repos/${owner}/${name}`);
    const ref = await this.github.request('GET', `/repos/${owner}/${name}/git/ref/heads/${baseBranch}`);
    const sha = ref.data?.object?.sha;
    if (typeof sha !== 'string' || !COMMIT.test(sha)) throw new DispatchFailure(false, 'GitHub returned an invalid base branch head.');
    return sha;
  }

  // ------------------------------------------------------------------ observe

  /** Session (+ latest root turn) → the coordinator's vocabulary. Persists ids, statuses and token counts only. */
  private map(session: any, turn: any, cursor: EventCursorState): { observation: ProviderObservation; cursor: EventCursorState } {
    const sessionId = String(session.id);
    const prev = cursor.openai ?? {};
    const usage = maxUsage(prev.usage, maxUsage(parseUsage(session.usage), parseUsage(turn?.usage)));
    const now = this.now();
    const openai: OpenAICursor = { ...prev, observedAt: now, ...(usage ? { usage } : {}), ...(isOpenAIId(turn?.id) ? { turnId: turn.id } : {}) };
    const next: EventCursorState = { ...cursor, openai };
    delete next.stopReason;
    const s = session.status; const t = turn?.status;
    let observation: ProviderObservation;
    const base = { sessionId, costBasis: 'estimate_from_reported_usage' as const };
    if (s === 'in_progress' || t === 'queued' || t === 'in_progress') observation = { ...base, status: 'running', providerStatus: 'running', message: 'OpenAI turn in progress.' };
    else if (s === 'requires_action' || t === 'waiting') { next.stopReason = 'requires_action'; observation = { ...base, status: 'idle', providerStatus: 'idle', stopReason: 'requires_action', message: 'OpenAI is waiting for an action.' }; }
    else if (s === 'failed' || t === 'failed') { next.stopReason = 'error'; observation = { ...base, status: 'idle', providerStatus: 'idle', stopReason: 'error', message: 'OpenAI reports the turn or session failed. Cancel the job to close the session.' }; }
    else if (s === 'idle' && t === 'completed') { next.stopReason = 'end_turn'; observation = { ...base, status: 'idle', providerStatus: 'idle', stopReason: 'end_turn', message: 'OpenAI turn completed.' }; }
    else if (s === 'idle' && t === 'cancelled') { next.stopReason = 'cancelled'; observation = { ...base, status: 'idle', providerStatus: 'idle', message: 'OpenAI turn cancelled.' }; }
    else if (s === 'idle') { next.stopReason = 'unknown'; observation = { ...base, status: 'idle', providerStatus: 'idle', stopReason: 'unknown', message: 'OpenAI session is idle without a finished turn.' }; }
    else observation = { ...base, status: 'unknown', message: 'OpenAI reported a session state this app does not recognise.' };
    // Missing usage is "not reported yet", never $0: no cost is reported until OpenAI reports tokens.
    if (usage) observation.costCents = estimateCents({ model: openai.model ?? '', usage, containerSize: (openai.containerSize ?? OPENAI_ENVIRONMENT.containerSize) as ContainerSize, createdAt: openai.createdAt ?? now, endAt: openai.deletedAt ?? now });
    return { observation, cursor: next };
  }

  async observe(sessionId: string, cursor: EventCursorState): Promise<{ observation: ProviderObservation; cursor: EventCursorState }> {
    let session: any;
    try { session = (await this.api.request('GET', `/v1/agents/sessions/${sessionId}`)).data; }
    catch (error) {
      // A 404 means "closed" only after a delete we confirmed; any other 404 is an error, never a silent close.
      if (error instanceof OpenAIError && error.status === 404 && cursor.openai?.deletedAt !== undefined) {
        const closed = this.map({ id: sessionId, status: 'deleted' }, undefined, cursor);
        return { observation: { ...closed.observation, status: 'cancelled', providerStatus: 'archived', message: 'OpenAI session deleted.' }, cursor: closed.cursor };
      }
      throw error;
    }
    if (session?.id !== sessionId) throw new OpenAIError(0, 'OpenAI returned a different session.');
    const turns = list((await this.api.request('GET', `/v1/agents/sessions/${sessionId}/turns?order=desc&limit=20`)).data);
    const root = turns.find(turn => turn.subagent_id == null); // subagent turns never decide the outcome
    return this.map(session, root, cursor);
  }

  /** Cancels the running turn. The idempotency key is stable per stop request across coordinator runs. */
  async interrupt(sessionId: string, idempotencyKey?: string): Promise<void> {
    await this.api.request('POST', `/v1/agents/sessions/${sessionId}/events`, { events: [{ type: 'agent.session.input.cancel' }] }, idempotencyKey ? { 'idempotency-key': idempotencyKey } : {});
  }

  /**
   * DELETE (owner decision D9: delete once the branch moved, or on cancel/shutdown). 409 (still setting up or executing)
   * is retried next run with the slot held. A 404 on DELETE is treated as already deleted.
   */
  async archive(sessionId: string, cursor: EventCursorState = {}): Promise<void | EventCursorState> {
    try { await this.api.request('DELETE', `/v1/agents/sessions/${sessionId}`); }
    catch (error) {
      if (error instanceof OpenAIError && error.status === 409) return undefined;
      if (!(error instanceof OpenAIError && error.status === 404)) throw error;
    }
    return { ...cursor, openai: { ...(cursor.openai ?? {}), deletedAt: this.now() } };
  }

  async branchHead(execution: CloudExecution, branch: string): Promise<{ state: 'found'; sha: string } | { state: 'missing' }> {
    if (!this.credentials.githubToken) throw new Error('The project GitHub token is not configured.');
    if (!/^agent-empire\/task-[a-f0-9-]{36}$/.test(branch)) throw new Error('Unexpected task branch name.');
    const { owner, name } = execution.repository;
    try {
      const ref = await this.github.request('GET', `/repos/${owner}/${name}/git/ref/heads/${branch}`);
      const sha = ref.data?.object?.sha;
      if (typeof sha !== 'string' || !COMMIT.test(sha)) throw new Error('GitHub returned an invalid branch head.');
      return { state: 'found', sha };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return { state: 'missing' };
      throw error;
    }
  }
}
