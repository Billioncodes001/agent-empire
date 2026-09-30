/**
 * Provider boundary for the coordinator. Anthropic Managed Agents is implemented by
 * anthropic-adapter.ts (wrapping src/server/providers/anthropic-managed.ts); OpenAI (CLOUD-06) will
 * implement the same interface. Tests use an in-memory fake.
 */
import type { ExecutionTask } from '../shared/execution.js';
import type { CloudExecution, EventCursorState } from './schema.js';

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
  dispatch(request: DispatchRequest): Promise<{ sourceCommit: string; observation: ProviderObservation }>;
  /** Reads status/usage events after `cursor`, then the session. Never persists model text. */
  observe(sessionId: string, cursor: EventCursorState): Promise<{ observation: ProviderObservation; cursor: EventCursorState }>;
  interrupt(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
}

/** Used when no provider credential is configured: observation and dispatch both refuse safely. */
export class UnavailableProvider implements ProviderAdapter {
  readonly provider = 'anthropic' as const;
  readonly canDispatch = false;
  constructor(private reason = 'No provider API key is configured in the state repository secrets.') {}
  async dispatch(): Promise<never> { throw new DispatchFailure(false, this.reason); }
  async observe(): Promise<never> { throw new Error(this.reason); }
  async interrupt(): Promise<never> { throw new Error(this.reason); }
  async archive(): Promise<never> { throw new Error(this.reason); }
}
