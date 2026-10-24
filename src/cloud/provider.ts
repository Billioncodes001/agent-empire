/**
 * Provider boundary for the coordinator. Anthropic Managed Agents is implemented by
 * anthropic-adapter.ts (wrapping src/server/providers/anthropic-managed.ts); OpenAI (CLOUD-06) will
 * implement the same interface. Tests use an in-memory fake.
 */
import type { ExecutionTask } from '../shared/execution.js';
import type { CloudExecution, CostBasis, EventCursorState, ProviderId } from './schema.js';
import type { ProvisionResult, WorkerModel } from './provisioning.js';
export { ProvisionError, type ProvisionResult } from './provisioning.js';

export interface ProviderObservation {
  sessionId: string;
  status: ExecutionTask['status'];
  providerStatus?: ExecutionTask['providerStatus'];
  stopReason?: ExecutionTask['stopReason'];
  costCents?: number;
  /** Absent means `provider_reported_list_cost` (Anthropic). GitHub Actions runs report the other bases. */
  costBasis?: CostBasis;
  budgetCents?: number;
  message: string;
}
export interface DispatchRequest {
  jobId: string;
  prompt: string;
  branch: string;
  /** Budget sent to the provider as the session cap; equals the job's reservation. */
  budgetCents: number;
  execution: CloudExecution;
}
/**
 * `sent: false` means the paid creation request was provably never sent (safe to requeue).
 * `sent: true` means it may have been accepted: the job becomes dispatch_uncertain, never retried.
 */
export class DispatchFailure extends Error {
  /** `countsAsAttempt: false` (e.g. a rate limit): requeue without using up the attempt limit. */
  constructor(readonly sent: boolean, message: string, readonly countsAsAttempt = true) { super(message); this.name = 'DispatchFailure'; }
}
export interface ProviderAdapter {
  readonly provider: ProviderId;
  /** False when credentials are missing; the coordinator then dispatches nothing. */
  readonly canDispatch: boolean;
  /** True when the provider key is configured, so the agent and environment can be looked up or created. */
  readonly canProvision: boolean;
  /**
   * Finds or creates the agent and cloud environment jobs run on (src/cloud/provisioning.ts). Never
   * starts a session. Throws ProvisionError with a user-safe message.
   */
  provision(model: WorkerModel): Promise<ProvisionResult>;
  /** `cursor`: provider bookkeeping stored with the job from the start (GitHub Actions: the run's repository and caps). */
  dispatch(request: DispatchRequest): Promise<{ sourceCommit: string; observation: ProviderObservation; cursor?: EventCursorState }>;
  /** Whether jobs for this execution can be dispatched now. Defaults to `canDispatch`. */
  canDispatchFor?(execution: CloudExecution | undefined): boolean;
  /** Reads status/usage events after `cursor`, then the session. Never persists model text. */
  observe(sessionId: string, cursor: EventCursorState): Promise<{ observation: ProviderObservation; cursor: EventCursorState }>;
  interrupt(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
  /**
   * Read-only check of the task branch in the project repository (project token). Used before
   * archiving a finished turn: `found` with a head different from the source commit is evidence the
   * agent pushed; it does not verify the work. Throws when the answer is unknown.
   */
  branchHead(execution: CloudExecution, branch: string): Promise<{ state: 'found'; sha: string } | { state: 'missing' }>;
}

/** Used when no provider credential is configured: observation and dispatch both refuse safely. */
export class UnavailableProvider implements ProviderAdapter {
  readonly provider = 'anthropic' as const;
  readonly canDispatch = false;
  readonly canProvision = false;
  constructor(private reason = 'No provider API key is configured in the state repository secrets.') {}
  async dispatch(): Promise<never> { throw new DispatchFailure(false, this.reason); }
  async provision(): Promise<never> { throw new Error(this.reason); }
  async observe(): Promise<never> { throw new Error(this.reason); }
  async interrupt(): Promise<never> { throw new Error(this.reason); }
  async archive(): Promise<never> { throw new Error(this.reason); }
  async branchHead(): Promise<never> { throw new Error(this.reason); }
}

/**
 * FREE-04: one coordinator, two kinds of execution. Routes each call to the adapter for the Empire's execution
 * provider: dispatch and branch checks by `execution.provider`, session calls by session id (`ghrun_` runs belong to
 * GitHub Actions, `sesn_` sessions to Anthropic). Never picks an adapter from which keys happen to exist.
 */
export class ProviderRouter implements ProviderAdapter {
  readonly provider = 'anthropic' as const;
  constructor(private adapters: { anthropic: ProviderAdapter; 'github-actions': ProviderAdapter }) {}
  private bySession(sessionId: string) { return this.adapters[sessionId.startsWith('ghrun_') ? 'github-actions' : 'anthropic']; }
  get canDispatch() { return this.adapters.anthropic.canDispatch || this.adapters['github-actions'].canDispatch; }
  get canProvision() { return this.adapters.anthropic.canProvision; }
  canDispatchFor(execution: CloudExecution | undefined) { return execution ? this.adapters[execution.provider].canDispatch : false; }
  provision(model: WorkerModel) { return this.adapters.anthropic.provision(model); }
  dispatch(request: DispatchRequest) { return this.adapters[request.execution.provider].dispatch(request); }
  observe(sessionId: string, cursor: EventCursorState) { return this.bySession(sessionId).observe(sessionId, cursor); }
  interrupt(sessionId: string) { return this.bySession(sessionId).interrupt(sessionId); }
  archive(sessionId: string) { return this.bySession(sessionId).archive(sessionId); }
  branchHead(execution: CloudExecution, branch: string) { return this.adapters[execution.provider].branchHead(execution, branch); }
}
