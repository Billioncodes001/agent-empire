/**
 * Anthropic Managed Agents adapter for the cloud coordinator. Reuses the host client
 * (src/server/providers/anthropic-managed.ts) unchanged: same wire shapes, no SDK retries, and a
 * lost creation response is treated as possibly accepted.
 */
import type { ExecutionConfig, ExecutionTask } from '../shared/execution.js';
import { safeExecutionError } from '../server/execution-errors.js';
import { AnthropicManaged, type ProviderCredentials } from '../server/providers/anthropic-managed.js';
import { DispatchFailure, type DispatchRequest, type ProviderAdapter, type ProviderObservation } from './provider.js';
import { utcDay, type CloudExecution, type EventCursorState } from './schema.js';

const MAX_EVENT_PAGES = 5;

export class AnthropicCloudAdapter implements ProviderAdapter {
  readonly provider = 'anthropic' as const;
  readonly canDispatch: boolean;
  private client: AnthropicManaged;
  private now: () => number;
  /** One read-only definition check per coordinator run and execution config. */
  private checked = new Map<string, Promise<{ agentVersion: number; sourceCommit: string }>>();

  constructor(private credentials: ProviderCredentials, options: { fetch?: typeof fetch; timeoutMs?: number; now?: () => number } = {}) {
    this.client = new AnthropicManaged(options.fetch ?? fetch, options.timeoutMs ?? 15_000);
    this.canDispatch = !!credentials.apiKey && !!credentials.githubToken;
    this.now = options.now ?? Date.now;
  }

  private config(execution: CloudExecution, budgetCents: number): ExecutionConfig {
    return { schemaVersion: 1, completed: true, mode: 'anthropic_cloud', repository: execution.repository, anthropic: execution.anthropic, githubAuth: 'host_token', limits: { maxConcurrent: 1, perTaskBudgetCents: budgetCents, dailyBudgetCents: budgetCents } };
  }

  async dispatch(request: DispatchRequest): Promise<{ sourceCommit: string; observation: ProviderObservation }> {
    if (!this.canDispatch) throw new DispatchFailure(false, 'Anthropic API key or project GitHub token is not configured in the state repository secrets.');
    const config = this.config(request.execution, request.budgetCents);
    const key = JSON.stringify([request.execution.repository, request.execution.anthropic]);
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
}
