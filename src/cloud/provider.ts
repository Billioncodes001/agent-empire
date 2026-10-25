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
  /**
   * FREE-07, read-only: one small file from a task branch (project token), e.g. a research report. `missing` when the
   * branch or file does not exist; refuses symlinks, directories and anything over 256 KB. Throws when unknown.
   */
  readBranchFile?(execution: CloudExecution, branch: string, path: string): Promise<{ state: 'found'; text: string; bytes: number } | { state: 'missing' }>;
}

/** GitHub contents API read of one regular file on a task branch, shared by both adapters. */
export async function readTaskBranchFile(
  request: (method: 'GET', path: string) => Promise<{ data: any }>, isNotFound: (error: unknown) => boolean,
  execution: CloudExecution, branch: string, path: string,
): Promise<{ state: 'found'; text: string; bytes: number } | { state: 'missing' }> {
  if (!/^agent-empire\/task-[a-f0-9-]{36}$/.test(branch)) throw new Error('Unexpected task branch name.');
  if (!/^docs\/empire\/[a-z]+\/[a-f0-9-]{36}\.md$/.test(path)) throw new Error('Unexpected artifact path.');
  const { owner, name } = execution.repository;
  let data: any;
  try { ({ data } = await request('GET', `/repos/${owner}/${name}/contents/${path}?ref=${encodeURIComponent(branch)}`)); }
  catch (error) { if (isNotFound(error)) return { state: 'missing' }; throw error; }
  if (!data || Array.isArray(data) || data.type !== 'file' || typeof data.size !== 'number') throw new Error('The report is not a regular file (a symlink or folder is refused).');
  if (data.size > 256 * 1024) return { state: 'found', text: '', bytes: data.size };
  if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error('GitHub returned the report in an unexpected form.');
  const bin = atob(data.content.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { state: 'found', text: '\u0000', bytes: bytes.length }; }
  return { state: 'found', text, bytes: bytes.length };
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
  async readBranchFile(execution: CloudExecution, branch: string, path: string) {
    const adapter = this.adapters[execution.provider];
    if (!adapter.readBranchFile) throw new Error('This execution cannot read task branch files.');
    return adapter.readBranchFile(execution, branch, path);
  }
}
