/**
 * Provider boundary for the coordinator. Anthropic Managed Agents is implemented by
 * anthropic-adapter.ts (wrapping src/server/providers/anthropic-managed.ts); OpenAI (CLOUD-06) will
 * implement the same interface. Tests use an in-memory fake.
 */
import type { ExecutionTask } from '../shared/execution.js';
import type { CloudExecution, EventCursorState } from './schema.js';
import type { ProvisionResult } from './provisioning.js';
export { ProvisionError, type ProvisionResult } from './provisioning.js';

export interface ProviderObservation {
  sessionId: string;
  status: ExecutionTask['status'];
  providerStatus?: ExecutionTask['providerStatus'];
  stopReason?: ExecutionTask['stopReason'];
  costCents?: number;
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
  constructor(readonly sent: boolean, message: string) { super(message); this.name = 'DispatchFailure'; }
}
export interface ProviderAdapter {
  readonly provider: 'anthropic';
  /** False when credentials are missing; the coordinator then dispatches nothing. */
  readonly canDispatch: boolean;
  /** True when the provider key is configured, so the agent and environment can be looked up or created. */
  readonly canProvision: boolean;
  /**
   * Finds or creates the agent and cloud environment jobs run on (src/cloud/provisioning.ts). Never
   * starts a session. Throws ProvisionError with a user-safe message.
   */
  provision(): Promise<ProvisionResult>;
  dispatch(request: DispatchRequest): Promise<{ sourceCommit: string; observation: ProviderObservation }>;
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
