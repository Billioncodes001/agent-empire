/**
 * Anthropic Managed Agents adapter for the cloud coordinator. Reuses the host client
 * (src/server/providers/anthropic-managed.ts) unchanged: same wire shapes, no SDK retries, and a
 * lost creation response is treated as possibly accepted.
 */
import type { ExecutionConfig, ExecutionTask } from '../shared/execution.js';
import { safeExecutionError } from '../server/execution-errors.js';
import { COMMIT } from '../server/execution-validation.js';
import { GitHubClient, GitHubError } from './store.js';
import { AnthropicManaged, type ProviderCredentials } from '../server/providers/anthropic-managed.js';
import { provisionAnthropicExecution, type ProvisionResult, type WorkerModel } from './provisioning.js';
import { DispatchFailure, type DispatchRequest, type ProviderAdapter, type ProviderObservation } from './provider.js';
import { utcDay, type AnthropicExecution, type CloudExecution, type EventCursorState } from './schema.js';

const MAX_EVENT_PAGES = 5;

export class AnthropicCloudAdapter implements ProviderAdapter {
  readonly provider = 'anthropic' as const;
  readonly canDispatch: boolean;
  readonly canProvision: boolean;
  private client: AnthropicManaged;
  private now: () => number;
  /** One read-only definition check per coordinator run and execution config. */
  private checked = new Map<string, Promise<{ agentVersion: number; sourceCommit: string }>>();

  private github: GitHubClient;

  constructor(private credentials: ProviderCredentials, options: { fetch?: typeof fetch; timeoutMs?: number; now?: () => number } = {}) {
    this.client = new AnthropicManaged(options.fetch ?? fetch, options.timeoutMs ?? 15_000);
    this.github = new GitHubClient(credentials.githubToken, { ...(options.fetch ? { fetch: options.fetch } : {}), timeoutMs: options.timeoutMs ?? 15_000 });
    this.canDispatch = !!credentials.apiKey && !!credentials.githubToken;
    this.canProvision = !!credentials.apiKey;
    this.now = options.now ?? Date.now;
  }

  private config(execution: AnthropicExecution, budgetCents: number): ExecutionConfig {
    return { schemaVersion: 1, completed: true, mode: 'anthropic_cloud', repository: execution.repository, anthropic: execution.anthropic, githubAuth: 'host_token', limits: { maxConcurrent: 1, perTaskBudgetCents: budgetCents, dailyBudgetCents: budgetCents } };
  }

  async dispatch(request: DispatchRequest): Promise<{ sourceCommit: string; observation: ProviderObservation }> {
    if (request.execution.provider !== 'anthropic') throw new DispatchFailure(false, 'This Empire does not run jobs on Anthropic Managed Agents.');
    if (!this.canDispatch) throw new DispatchFailure(false, 'Anthropic API key or project GitHub token is not configured in the state repository secrets.');
    const execution = request.execution;
    const config = this.config(execution, request.budgetCents);
    const key = JSON.stringify([execution.repository, execution.anthropic]);
    let prepared: { agentVersion: number; sourceCommit: string };
    try {
      let check = this.checked.get(key);
      if (!check) { check = this.client.check(config, this.credentials); this.checked.set(key, check); }
      prepared = await check;
    } catch (error) {
      this.checked.delete(key);
      throw new DispatchFailure(false, `${safeExecutionError(error).message} No paid session was requested.`);
    }
    const now = this.now();
    const task: ExecutionTask = {
      id: request.jobId, provider: 'anthropic', mode: 'anthropic_cloud', status: 'dispatch_uncertain', prompt: request.prompt,
      createdAt: now, updatedAt: now, repository: request.execution.repository, sourceCommit: prepared.sourceCommit, branch: request.branch,
      reservedCents: request.budgetCents, budgetDay: utcDay(now), message: '', outputs: 'unverified',
    };
    try {
      const observation = await this.client.create(config, this.credentials, task, prepared.agentVersion);
      return { sourceCommit: prepared.sourceCommit, observation };
    } catch (error) {
      throw new DispatchFailure(true, `${safeExecutionError(error).message} The session may have been accepted; inspect the provider Console for task ${request.jobId}.`);
    }
  }

  /** Control-plane lookups and creates only; no session. Needs only the Anthropic key. */
  provision(model: WorkerModel): Promise<ProvisionResult> { return provisionAnthropicExecution(this.client, this.credentials.apiKey, model); }

  async observe(sessionId: string, cursor: EventCursorState): Promise<{ observation: ProviderObservation; cursor: EventCursorState }> {
    let next = { ...cursor };
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      next = await this.client.events(sessionId, this.credentials.apiKey, next);
      if (!next.page) break;
    }
    const observation = await this.client.session(sessionId, this.credentials.apiKey);
    return { observation, cursor: next };
  }
  interrupt(sessionId: string) { return this.client.interrupt(sessionId, this.credentials.apiKey); }
  archive(sessionId: string) { return this.client.archive(sessionId, this.credentials.apiKey); }

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
