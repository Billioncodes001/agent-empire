/**
 * Provider boundary for the coordinator. Anthropic Managed Agents is implemented by anthropic-adapter.ts (wrapping
 * src/server/providers/anthropic-managed.ts); the OpenAI Agents API by openai-adapter.ts (CLOUD-06). Tests use
 * in-memory fakes. One provider per Empire: the coordinator picks the adapter from `meta.execution.provider` (or the
 * pending provisioning request), never from which keys happen to exist.
 */
import type { ExecutionTask } from '../shared/execution.js';
import type { CloudExecution, CostBasis, EventCursorState, ProviderId } from './schema.js';
import type { ProvisionResult } from './provisioning.js';
import type { AnyWorkerModel } from './worker-spec.js';
export { ProvisionError, type ProvisionResult } from './provisioning.js';

export interface ProviderObservation {
  sessionId: string;
  status: ExecutionTask['status'];
  providerStatus?: ExecutionTask['providerStatus'];
  stopReason?: ExecutionTask['stopReason'];
  costCents?: number;
  /** Absent means `provider_reported_list_cost` (Anthropic). OpenAI reports `estimate_from_reported_usage`. */
  costBasis?: CostBasis;
  budgetCents?: number;
  message: string;
}
export interface DispatchRequest {
  jobId: string;
  prompt: string;
  branch: string;
  /** The job's reservation. Anthropic sends it as the provider-enforced session cap; OpenAI has no such cap. */
  budgetCents: number;
  execution: CloudExecution;
}
/**
 * `sent: false` means the paid creation request was provably never sent (safe to requeue).
 * `sent: true` means it may have been accepted: the job becomes dispatch_uncertain, never retried.
 */
export class DispatchFailure extends Error {
  constructor(readonly sent: boolean, message: string) { super(message); this.name = 'DispatchFailure'; }
}
export interface ProviderAdapter {
  readonly provider: ProviderId;
  /**
   * `provider_enforced` (default): the provider stops the session at `budgetCents` and echoes it (Anthropic).
   * `coordinator_estimate`: no provider cap; the coordinator cancels when its own estimate reaches the reservation (OpenAI).
   */
  readonly budget?: 'provider_enforced' | 'coordinator_estimate';
  /** False when credentials are missing (or the provider is not enabled); the coordinator then dispatches nothing. */
  readonly canDispatch: boolean;
  /** True when the provider key is configured, so the provider resources can be looked up or created. */
  readonly canProvision: boolean;
  /** Why `canDispatch`/`canProvision` is false, when the adapter knows more than "a key is missing". User-safe. */
  readonly blockedReason?: string;
  /**
   * Finds or creates what jobs run on (Anthropic: agent and environment; OpenAI: vault and credential). Never starts a
   * session. Throws ProvisionError with a user-safe message.
   */
  provision(model: AnyWorkerModel): Promise<ProvisionResult>;
  /** `cursor`: provider bookkeeping stored with the job from the start (OpenAI: creation time, model, container size). */
  dispatch(request: DispatchRequest): Promise<{ sourceCommit: string; observation: ProviderObservation; cursor?: EventCursorState }>;
  /** Reads status/usage after `cursor`, then the session. Never persists model text. */
  observe(sessionId: string, cursor: EventCursorState): Promise<{ observation: ProviderObservation; cursor: EventCursorState }>;
  /** `idempotencyKey` is stable for one stop request, so a repeated run never sends a second, different cancel. */
  interrupt(sessionId: string, idempotencyKey?: string): Promise<void>;
  /**
   * Anthropic: soft archive. OpenAI: DELETE. May return the cursor to observe with afterwards (OpenAI records `deletedAt`
   * only after a confirmed delete, so a later 404 can be told apart from an error).
   */
  archive(sessionId: string, cursor?: EventCursorState): Promise<void | EventCursorState>;
  /**
   * Read-only check of the task branch in the project repository (project token). Used before
   * archiving a finished turn: `found` with a head different from the source commit is evidence the
   * agent pushed; it does not verify the work. Throws when the answer is unknown.
   */
  branchHead(execution: CloudExecution, branch: string): Promise<{ state: 'found'; sha: string } | { state: 'missing' }>;
}

/** Used when no provider credential is configured: observation and dispatch both refuse safely. */
export class UnavailableProvider implements ProviderAdapter {
  readonly canDispatch = false;
  readonly canProvision = false;
  constructor(private reason = 'No provider API key is configured in the state repository secrets.', readonly provider: ProviderId = 'anthropic') {}
  get blockedReason() { return this.reason; }
  async dispatch(): Promise<never> { throw new DispatchFailure(false, this.reason); }
  async provision(): Promise<never> { throw new Error(this.reason); }
  async observe(): Promise<never> { throw new Error(this.reason); }
  async interrupt(): Promise<never> { throw new Error(this.reason); }
  async archive(): Promise<never> { throw new Error(this.reason); }
  async branchHead(): Promise<never> { throw new Error(this.reason); }
}

/** The adapters a coordinator run can use, by provider. A missing entry behaves as an UnavailableProvider. */
export type ProviderSet = Partial<Record<ProviderId, ProviderAdapter>>;
export function providerOf(set: ProviderSet, id: ProviderId): ProviderAdapter {
  return set[id] ?? new UnavailableProvider(id === 'openai'
    ? 'Waiting for an OpenAI API key: the OPENAI_API_KEY Actions secret is not set in the state repository. Run setup again with an OpenAI key.'
    : undefined, id);
}
