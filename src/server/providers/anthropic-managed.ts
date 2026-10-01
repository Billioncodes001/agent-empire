import type { ExecutionConfig, ExecutionTask } from '../../shared/execution.js';
import { ExecutionError, safeExecutionError } from '../execution-errors.js';
import { COMMIT, object, PROVIDER_ID } from '../execution-validation.js';

/** Wire shapes verified against official Managed Agents docs on 2026-09-27.
 * https://platform.claude.com/docs/en/managed-agents/{sessions,budgets,github,events-and-streaming}
 * No SDK retries: a lost create response can represent an accepted paid session.
 */
export interface ProviderCredentials { apiKey: string; githubToken: string }
export interface EventCursor { after?: string; page?: string; newest?: string; lastEventId?: string; stopReason?: ExecutionTask['stopReason'] }
export interface ProviderObservation {
  sessionId: string;
  status: ExecutionTask['status'];
  providerStatus?: ExecutionTask['providerStatus'];
  stopReason?: ExecutionTask['stopReason'];
  costCents?: number;
  budgetCents?: number;
  message: string;
}
export class AnthropicManaged {
  constructor(private transport: typeof fetch = fetch, private timeoutMs = 15_000) {}

  private async request(origin: 'https://api.anthropic.com' | 'https://api.github.com', route: string, token: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new ExecutionError(504, 'provider_timeout', 'The provider response timed out; do not assume a submitted operation failed.')); }, this.timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await this.transport(origin + route, {
          method, redirect: 'error', signal: controller.signal,
          headers: origin === 'https://api.anthropic.com'
            ? { 'x-api-key': token, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'managed-agents-2026-04-01', 'content-type': 'application/json' }
            : { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Agent-Empire' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new ExecutionError(response.status === 429 ? 429 : 502, 'provider_rejected', `The ${origin.endsWith('github.com') ? 'GitHub' : 'Anthropic'} API rejected the request (HTTP ${response.status}). Check account access and configured references.`);
        }
        if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) { void response.body?.cancel().catch(() => {}); throw new ExecutionError(502, 'provider_response_large', 'The provider response exceeded the supported size.'); }
        reader = response.body?.getReader();
        if (!reader) throw new ExecutionError(502, 'provider_response_invalid', 'The provider returned an empty response.');
        const chunks: Uint8Array[] = []; let bytes = 0;
        while (true) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new ExecutionError(502, 'provider_response_large', 'The provider response exceeded the supported size.'); }
          chunks.push(next.value);
        }
        try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { throw new ExecutionError(502, 'provider_response_invalid', 'The provider returned an invalid response.'); }
      })()]);
    } catch (error) { throw safeExecutionError(error); }
    finally { clearTimeout(timer); }
  }

  /**
   * One Managed Agents control-plane request (agents/environments lookup and creation for cloud setup,
   * src/cloud/provisioning.ts). Same transport rules as everything else here: no retries, bounded
   * response, user-safe errors. Never used for sessions.
   */
  async controlPlane(route: `/v1/agents${string}` | `/v1/environments${string}`, apiKey: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<Record<string, unknown>> {
    return this.request('https://api.anthropic.com', route, apiKey, method, body);
  }

  async check(config: ExecutionConfig, credentials: ProviderCredentials): Promise<{ agentVersion: number; sourceCommit: string }> {
    const agent = await this.request('https://api.anthropic.com', `/v1/agents/${config.anthropic.agentId}`, credentials.apiKey);
    if (agent.id !== config.anthropic.agentId || agent.type !== 'agent' || agent.archived_at !== null || !Number.isSafeInteger(agent.version) || Number(agent.version) < 1) throw new ExecutionError(400, 'agent_unavailable', 'The configured agent is unavailable, archived, or returned an unsupported definition.');
    // This milestone deliberately budgets one primary agent, without an unbounded child roster.
    if (agent.multiagent != null) throw new ExecutionError(400, 'multiagent_unsupported', 'Choose a single-agent definition; multiagent spend and approval controls are not supported by this adapter yet.');
    if (!Array.isArray(agent.tools) || !agent.tools.some((tool: any) => tool?.type === 'agent_toolset_20260401')) throw new ExecutionError(400, 'agent_tools_missing', 'The configured agent must include the Managed Agents built-in toolset.');
    const environment = await this.request('https://api.anthropic.com', `/v1/environments/${config.anthropic.environmentId}`, credentials.apiKey);
    if (environment.id !== config.anthropic.environmentId || environment.archived_at !== null || (environment.config as any)?.type !== 'cloud') throw new ExecutionError(400, 'environment_unavailable', 'Choose an active Anthropic cloud environment; a self-hosted environment does not prove provider-hosted execution.');
    if (config.anthropic.vaultId) {
      const vault = await this.request('https://api.anthropic.com', `/v1/vaults/${config.anthropic.vaultId}`, credentials.apiKey);
      if (vault.id !== config.anthropic.vaultId || vault.archived_at !== null) throw new ExecutionError(400, 'vault_unavailable', 'The configured provider vault is unavailable or archived.');
    }
    return { agentVersion: agent.version as number, sourceCommit: await this.sourceCommit(config, credentials) };
  }

  async sourceCommit(config: ExecutionConfig, credentials: ProviderCredentials): Promise<string> {
    const repo = `${config.repository.owner}/${config.repository.name}`;
    const metadata = await this.request('https://api.github.com', `/repos/${repo}`, credentials.githubToken);
    if (typeof metadata.full_name !== 'string' || metadata.full_name.toLowerCase() !== repo.toLowerCase() || metadata.archived === true || metadata.disabled === true) throw new ExecutionError(400, 'repository_unavailable', 'The selected GitHub repository is unavailable, archived, disabled, or has moved.');
    const commit = await this.request('https://api.github.com', `/repos/${repo}/commits/${encodeURIComponent(config.repository.baseBranch)}`, credentials.githubToken);
    if (typeof commit.sha !== 'string' || !COMMIT.test(commit.sha)) throw new ExecutionError(502, 'repository_commit_invalid', 'GitHub did not return a supported source commit.');
    return commit.sha;
  }

  async create(config: ExecutionConfig, credentials: ProviderCredentials, task: ExecutionTask, agentVersion: number): Promise<ProviderObservation> {
    const response = await this.request('https://api.anthropic.com', '/v1/sessions', credentials.apiKey, 'POST', {
      agent: { type: 'agent', id: config.anthropic.agentId, version: agentVersion }, environment_id: config.anthropic.environmentId,
      ...(config.anthropic.vaultId ? { vault_ids: [config.anthropic.vaultId] } : {}),
      budget: { type: 'limit', max_list_cost: { amount: String(task.reservedCents), currency: 'USD' } },
      metadata: { agent_empire_task_id: task.id },
      resources: [{ type: 'github_repository', url: `https://github.com/${config.repository.owner}/${config.repository.name}`, authorization_token: credentials.githubToken, mount_path: '/workspace/repo', checkout: { type: 'commit', sha: task.sourceCommit } }],
      initial_events: [{ type: 'user.message', content: [{ type: 'text', text: `Task ID: ${task.id}\nRepository: ${config.repository.owner}/${config.repository.name}\nPinned source commit: ${task.sourceCommit}\nWork in /workspace/repo. Create and use branch ${task.branch}; do not modify or merge into the default branch. Commit requested changes on that branch. If configured GitHub permissions permit, push that branch and open a pull request for review; otherwise report the limitation. Never claim a commit or PR exists without verifying it.\n\nUser task:\n${task.prompt}` }] }],
    });
    return this.observation(response);
  }

  async session(sessionId: string, apiKey: string): Promise<ProviderObservation> {
    if (!PROVIDER_ID.session.test(sessionId)) throw new ExecutionError(400, 'session_invalid', 'Invalid provider session reference.');
    const response = await this.request('https://api.anthropic.com', `/v1/sessions/${sessionId}`, apiKey);
    if (response.id !== sessionId) throw new ExecutionError(502, 'session_mismatch', 'Provider returned a different session; the saved task was preserved.');
    return this.observation(response);
  }

  async events(sessionId: string, apiKey: string, previous: EventCursor): Promise<EventCursor> {
    if (!PROVIDER_ID.session.test(sessionId)) throw new ExecutionError(400, 'session_invalid', 'Invalid provider session reference.');
    const cursor = { ...previous };
    const query = new URLSearchParams({ order: 'asc', limit: '100' });
    if (cursor.after) query.set('created_at[gte]', cursor.after);
    if (cursor.page) query.set('page', cursor.page);
    // Status/usage only: never persist model text, tool input, output, or credentials from events.
    for (const type of ['session.status_idle', 'session.status_running', 'session.usage']) query.append('types[]', type);
    const response = await this.request('https://api.anthropic.com', `/v1/sessions/${sessionId}/events?${query}`, apiKey);
    if (!Array.isArray(response.data) || response.data.length > 100 || (response.next_page != null && (typeof response.next_page !== 'string' || response.next_page.length > 2048))) throw new ExecutionError(502, 'events_invalid', 'The provider returned an unsupported event page.');
    for (const event of response.data) {
      if (!event || !PROVIDER_ID.event.test(event.id) || typeof event.processed_at !== 'string' || !Number.isFinite(Date.parse(event.processed_at))) continue;
      if (cursor.newest && Date.parse(event.processed_at) < Date.parse(cursor.newest)) continue;
      cursor.newest = event.processed_at; cursor.lastEventId = event.id;
      if (event.type === 'session.status_running') cursor.stopReason = undefined;
      if (event.type === 'session.status_idle') cursor.stopReason = ['end_turn', 'requires_action', 'budget_reached', 'error'].includes(event.stop_reason?.type) ? event.stop_reason.type : 'unknown';
    }
    cursor.page = response.next_page as string | undefined || undefined;
    if (!cursor.page) cursor.after = cursor.newest;
    return cursor;
  }

  async interrupt(sessionId: string, apiKey: string): Promise<void> {
    if (!PROVIDER_ID.session.test(sessionId)) throw new ExecutionError(400, 'session_invalid', 'Invalid provider session reference.');
    await this.request('https://api.anthropic.com', `/v1/sessions/${sessionId}/events`, apiKey, 'POST', { events: [{ type: 'user.interrupt' }] });
  }
  async archive(sessionId: string, apiKey: string): Promise<void> {
    if (!PROVIDER_ID.session.test(sessionId)) throw new ExecutionError(400, 'session_invalid', 'Invalid provider session reference.');
    await this.request('https://api.anthropic.com', `/v1/sessions/${sessionId}/archive`, apiKey, 'POST');
  }

  private observation(response: Record<string, unknown>): ProviderObservation {
    if (typeof response.id !== 'string' || !PROVIDER_ID.session.test(response.id)) throw new ExecutionError(502, 'session_response_invalid', 'Provider session identity was not confirmed. Dispatch may have succeeded; do not submit another task.');
    const raw = response.status;
    // A set archived_at means archived whatever the status field says, so a slot can never be held
    // forever by an archived session still reported as idle.
    const archived = typeof response.archived_at === 'string' && Number.isFinite(Date.parse(response.archived_at));
    const providerStatus = archived ? 'archived' : ['running', 'rescheduling', 'idle', 'terminated'].includes(String(raw)) ? raw as ExecutionTask['providerStatus'] : undefined;
    const cost = (response.usage as any)?.list_cost;
    const costCents = cost?.currency === 'USD' && typeof cost.amount === 'string' && /^(0|[1-9]\d{0,12})$/.test(cost.amount) ? Number(cost.amount) : undefined;
    const budget = response.budget as any;
    const budgetCents = budget?.type === 'limit' && budget.max_list_cost?.currency === 'USD' && typeof budget.max_list_cost.amount === 'string' && /^[1-9]\d{0,12}$/.test(budget.max_list_cost.amount) ? Number(budget.max_list_cost.amount) : undefined;
    const status = providerStatus === 'archived' ? 'cancelled' : providerStatus === 'terminated' ? 'failed' : providerStatus === 'running' || providerStatus === 'rescheduling' ? 'running' : providerStatus === 'idle' ? 'idle' : 'unknown';
    const message = status === 'cancelled' ? 'Provider session archived. Code and pull-request outputs remain unverified.' : status === 'failed' ? 'Provider session terminated. Termination does not prove the task succeeded.' : status === 'running' ? 'Provider reports this session running or rescheduling.' : status === 'idle' ? 'Provider session is idle. A finished turn does not verify code or a pull request.' : 'Provider execution state could not be confirmed.';
    return { sessionId: response.id, status, providerStatus, costCents, budgetCents, message };
  }
}
