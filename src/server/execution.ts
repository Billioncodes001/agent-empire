import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ExecutionConfig, ExecutionSetup, ExecutionSubmit, ExecutionTask } from '../shared/execution.js';
import { writeJsonAtomic } from './persistence.js';
import { ExecutionError, safeExecutionError } from './execution-errors.js';
import { COMMIT, object, PROVIDER_ID, TASK_ID, validateConfig, validateSubmit } from './execution-validation.js';
import { AnthropicManaged, type EventCursor, type ProviderCredentials, type ProviderObservation } from './providers/anthropic-managed.js';
export { ExecutionError } from './execution-errors.js';

export interface ExecutionOptions {
  apiKey?: () => string | undefined;
  githubToken?: () => string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  pollIntervalMs?: number;
  /** Internal test boundary; production requests use a 15-second deadline. */
  requestTimeoutMs?: number;
}
interface TaskRecord { task: ExecutionTask; config: ExecutionConfig; configRevision: number; cursor: EventCursor; stopRequested?: boolean }
interface SavedExecution { schemaVersion: 1; config: ExecutionConfig; configRevision: number; records: TaskRecord[] }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const terminal = (task: ExecutionTask) => ['cancelled', 'failed', 'completed'].includes(task.status);
const NOTICES = [
  'Only an explicitly confirmed submission creates a paid cloud session. Saving setup or checking the connection never starts work.',
  'On explicit submission, the host GitHub token is sent to Anthropic to mount the selected repository in its cloud sandbox. Use a fine-grained token limited to that repository.',
  'Per-task budgets are Anthropic list-cost caps enforced between model requests. An in-flight request can exceed the cap; this is not an exact billing ceiling.',
  'The daily allowance reserves each submitted task’s full budget (or higher reported cost) by UTC day, carrying nonterminal reservations forward. It is a local admission limit, not an account-wide billing meter.',
  'Idle, approval-paused, budget-paused and uncertain sessions keep a concurrency slot. Explicitly stop/archive a known session to release its slot; daily reservations remain.',
  'Connection checks verify readable agent/environment/repository references, not GitHub write access, MCP authentication, successful code, or a pull request.',
  'Provider tool approvals, exact wall-clock limits, account-wide spending controls, multiagent definitions and automatic artifact import are not implemented here. Use provider controls for pending approvals.',
  'Closing the game does not stop accepted cloud sessions. The local host must be running to refresh their status. Do not delete this ledger to recover an uncertain submission.',
];

/** One manager per already locked host data directory. The ledger is never an automatic job queue. */
export class ExecutionManager {
  private file: string;
  private saved: SavedExecution;
  private storageError?: string;
  private checkState: ExecutionSetup['check'] = { status: 'unchecked' };
  private readyCheck?: { revision: number; fingerprint: string; agentVersion: number; at: number };
  private checking?: Promise<ExecutionSetup>;
  private submitting = new Map<string, { input: ExecutionSubmit; promise: Promise<ExecutionTask> }>();
  private taskOperations = new Map<string, Promise<ExecutionTask>>();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private closed = false;
  private provider: AnthropicManaged;
  private now: () => number;
  private apiKey: () => string | undefined;
  private githubToken: () => string | undefined;
  private pollInterval: number;

  constructor(dataDir: string, options: ExecutionOptions = {}) {
    this.file = path.join(dataDir, 'execution.json');
    this.now = options.now ?? Date.now;
    this.apiKey = options.apiKey ?? (() => process.env.ANTHROPIC_API_KEY);
    this.githubToken = options.githubToken ?? (() => process.env.AGENT_EMPIRE_GITHUB_TOKEN);
    this.pollInterval = Math.max(1000, options.pollIntervalMs ?? 30_000);
    this.provider = new AnthropicManaged(options.fetch, options.requestTimeoutMs);
    this.saved = { schemaVersion: 1, configRevision: 0, config: { schemaVersion: 1, completed: false, mode: 'local', repository: { owner: '', name: '', baseBranch: '' }, anthropic: { agentId: '', environmentId: '' }, githubAuth: 'host_token', limits: { maxConcurrent: 1, perTaskBudgetCents: 100, dailyBudgetCents: 500 } }, records: [] };
    if (existsSync(this.file)) {
      try { this.saved = this.restore(JSON.parse(readFileSync(this.file, 'utf8'))); }
      catch { throw new ExecutionError(503, 'execution_storage_invalid', 'Execution ledger is invalid. Preserve the file and diagnose it; creating a replacement could duplicate paid work.'); }
    }
  }

  setup(): ExecutionSetup {
    const credentials = this.credentials(false);
    const current = this.readyCheck;
    const ready = !this.storageError && this.saved.config.completed && (this.saved.config.mode !== 'anthropic_cloud'
      || !!current && current.revision === this.saved.configRevision && current.fingerprint === this.fingerprint(credentials) && this.now() - current.at < 5 * 60_000);
    const check = this.saved.config.mode === 'anthropic_cloud' && this.checkState.status === 'ready' && !ready
      ? { status: 'unchecked' as const, message: 'Connection evidence expired or credentials changed. Run the read-only check again.' } : this.checkState;
    return clone({ config: this.saved.config, configRevision: this.saved.configRevision, credentials: { anthropic: !!credentials.apiKey, github: !!credentials.githubToken }, check, ready, notices: NOTICES, ...(this.storageError ? { storageError: this.storageError } : {}) });
  }

  updateSetup(input: unknown): ExecutionSetup {
    this.writable();
    const config = validateConfig(input);
    const identity = (value: ExecutionConfig) => JSON.stringify({ mode: value.mode, repository: value.repository, anthropic: value.anthropic });
    if ((this.submitting.size || this.saved.records.some(record => !terminal(record.task))) && identity(config) !== identity(this.saved.config)) {
      throw new ExecutionError(409, 'active_cloud_tasks', 'Stop and reconcile existing cloud sessions before changing executor, repository or provider references.');
    }
    this.commit({ ...this.saved, config, configRevision: this.saved.configRevision + 1 });
    this.readyCheck = undefined; this.checkState = { status: 'unchecked' };
    return this.setup();
  }

  check(): Promise<ExecutionSetup> {
    if (this.checking) return this.checking;
    const promise = this.performCheck(); this.checking = promise;
    void promise.finally(() => { this.checking = undefined; }).catch(() => {});
    return promise;
  }
  private async performCheck(): Promise<ExecutionSetup> {
    this.writable();
    const config = clone(this.saved.config); const revision = this.saved.configRevision;
    this.readyCheck = undefined;
    if (config.mode !== 'anthropic_cloud') {
      this.checkState = { status: 'unchecked', message: 'This mode uses the running local or VPS host. No cloud connection was tested.' };
      return this.setup();
    }
    try {
      if (!config.completed) throw new ExecutionError(400, 'setup_incomplete', 'Complete and save execution setup before checking provider access.');
      const credentials = this.credentials(true);
      const result = await this.provider.check(config, credentials);
      if (this.saved.configRevision !== revision) throw new ExecutionError(409, 'setup_changed', 'Setup changed during the check. Check the current setup again.');
      this.readyCheck = { revision, fingerprint: this.fingerprint(credentials), agentVersion: result.agentVersion, at: this.now() };
      this.checkState = { status: 'ready', checkedAt: this.now(), message: 'Read-only access verified. No paid session was created; GitHub write permissions and outputs are not verified.' };
    } catch (error) {
      this.checkState = { status: 'blocked', checkedAt: this.now(), message: safeExecutionError(error).message };
    }
    return this.setup();
  }

  tasks(): ExecutionTask[] { return clone(this.saved.records.map(record => record.task)); }

  submit(value: unknown): Promise<ExecutionTask> {
    const input = validateSubmit(value);
    const existing = this.saved.records.find(record => record.task.id === input.id);
    if (existing) {
      this.sameSubmission(input, existing.task.prompt, existing.configRevision);
      return Promise.resolve(clone(existing.task));
    }
    const pending = this.submitting.get(input.id);
    if (pending) { this.sameSubmission(input, pending.input.prompt, pending.input.configRevision); return pending.promise; }
    const promise = this.performSubmit(input); this.submitting.set(input.id, { input, promise });
    void promise.finally(() => this.submitting.delete(input.id)).catch(() => {});
    return promise;
  }
  private async performSubmit(input: ExecutionSubmit): Promise<ExecutionTask> {
    this.writable();
    this.admit(input.configRevision);
    const config = clone(this.saved.config); const checked = this.readyCheck!;
    const credentials = this.credentials(true);
    const sourceCommit = await this.provider.sourceCommit(config, credentials);
    // No await between the final admission check and the durable reservation/dispatch intent.
    this.writable(); this.admit(input.configRevision);
    if (this.fingerprint(credentials) !== this.fingerprint(this.credentials(true))) throw new ExecutionError(409, 'credentials_changed', 'Credentials changed while preparing the task. Check the connection again.');
    const task: ExecutionTask = {
      id: input.id, provider: 'anthropic', mode: 'anthropic_cloud', status: 'dispatch_uncertain', prompt: input.prompt,
      createdAt: this.now(), updatedAt: this.now(), repository: config.repository, sourceCommit, branch: `agent-empire/task-${input.id}`,
      reservedCents: config.limits.perTaskBudgetCents, budgetDay: this.day(), message: 'Dispatch intent saved. Provider acceptance is not confirmed; never retry this as a new task.', outputs: 'unverified',
    };
    const record: TaskRecord = { task, config, configRevision: input.configRevision, cursor: {} };
    this.commit({ ...this.saved, records: [...this.saved.records, record] });
    let next: TaskRecord;
    try {
      const observation = await this.provider.create(config, credentials, task, checked.agentVersion);
      next = this.apply(record, observation);
    } catch (error) {
      next = { ...record, task: { ...task, updatedAt: this.now(), message: `${safeExecutionError(error).message} Dispatch remains uncertain. Inspect the provider Console using the task ID; no automatic retry will occur.` } };
    }
    try { this.replace(next); }
    catch (error) {
      // Retain a known provider ID in memory even when the receipt could not be saved.
      next.task.status = 'unknown'; next.task.message = 'Provider dispatch may have succeeded, but its receipt could not be saved. Preserve the task/session IDs and do not resubmit.';
      this.saved.records = this.saved.records.map(item => item.task.id === next.task.id ? next : item);
      throw error;
    }
    return clone(next.task);
  }

  refresh(id: string): Promise<ExecutionTask> {
    const record = this.record(id);
    const pending = this.taskOperations.get(id); if (pending) return pending;
    const promise = this.performRefresh(record); this.taskOperations.set(id, promise);
    void promise.finally(() => this.taskOperations.delete(id)).catch(() => {});
    return promise;
  }
  private async performRefresh(record: TaskRecord): Promise<ExecutionTask> {
    this.writable();
    if (!record.task.sessionId) return clone(record.task); // Never scan/create a substitute for an uncertain dispatch.
    let next = clone(record);
    try {
      const apiKey = this.requireApiKey();
      next.cursor = await this.provider.events(record.task.sessionId, apiKey, record.cursor);
      this.writable();
      const observation = await this.provider.session(record.task.sessionId, apiKey);
      next = this.apply(next, observation);
      if (next.task.status === 'idle' && !next.cursor.page) {
        next.task.stopReason = next.cursor.stopReason ?? 'unknown';
        if (next.task.stopReason === 'requires_action') { next.task.status = 'waiting_for_approval'; next.task.message = 'Provider is waiting for tool approval or a tool result. Resolve it in supported provider controls; the app never approves automatically.'; }
        if (next.task.stopReason === 'budget_reached') { next.task.status = 'budget_paused'; next.task.message = 'Provider paused at the session budget. This app will not increase the budget or resume paid work automatically.'; }
      }
      if (next.cursor.lastEventId) next.task.eventCursor = next.cursor.lastEventId;
      if (record.stopRequested && !terminal(next.task)) next.task.message += ' Stop was requested; when idle, use Stop again to archive the session.';
    } catch (error) {
      next.task.status = 'unknown'; next.task.updatedAt = this.now(); next.task.message = `${safeExecutionError(error).message} Last-known session identity and reservations were kept.`;
    }
    this.replace(next); return clone(next.task);
  }

  stopTask(id: string): Promise<ExecutionTask> {
    const record = this.record(id);
    if (this.taskOperations.has(id)) throw new ExecutionError(409, 'task_busy', 'Wait for the current task refresh or stop operation.');
    const promise = this.performStop(record); this.taskOperations.set(id, promise);
    void promise.finally(() => this.taskOperations.delete(id)).catch(() => {});
    return promise;
  }
  private async performStop(record: TaskRecord): Promise<ExecutionTask> {
    this.writable();
    if (!record.task.sessionId) throw new ExecutionError(409, 'dispatch_unresolved', 'No provider session ID is confirmed. Inspect the provider Console; this app cannot safely find or stop a possibly accepted session.');
    let next = clone(record);
    try {
      const apiKey = this.requireApiKey();
      let observed = await this.provider.session(record.task.sessionId, apiKey);
      next = this.apply(next, observed);
      if (terminal(next.task)) { this.replace(next); return clone(next.task); }
      next.stopRequested = true; next.task.status = 'unknown'; next.task.message = 'Stop requested; provider termination is not yet confirmed.';
      this.replace(next); // Durable intent precedes both external mutations.
      if (observed.providerStatus === 'running' || observed.providerStatus === 'rescheduling') {
        await this.provider.interrupt(record.task.sessionId, apiKey);
        this.writable();
        observed = await this.provider.session(record.task.sessionId, apiKey);
      }
      if (observed.providerStatus === 'idle') {
        this.writable();
        await this.provider.archive(record.task.sessionId, apiKey);
        this.writable();
        observed = await this.provider.session(record.task.sessionId, apiKey);
      }
      next = this.apply(next, observed);
      if (!terminal(next.task)) next.task.message = 'Stop was requested but archival is not confirmed. Refresh and use Stop again when the session is idle. Its slot and budget reservation remain held.';
    } catch (error) {
      if (this.storageError) throw error;
      next.task.status = 'unknown'; next.task.updatedAt = this.now(); next.task.message = `${safeExecutionError(error).message} Stop/archival was not confirmed; the slot and reservation remain held.`;
    }
    this.replace(next); return clone(next.task);
  }

  /** GET-only reconciliation of already recorded provider session IDs, including after restart. */
  start(): void {
    if (this.timer) return; this.closed = false;
    this.timer = setInterval(() => void this.poll(), this.pollInterval); this.timer.unref();
    void this.poll();
  }
  stop(): void { this.closed = true; clearInterval(this.timer); this.timer = undefined; }
  private async poll(): Promise<void> {
    if (this.polling || this.closed || this.storageError) return;
    this.polling = true;
    try {
      for (const record of [...this.saved.records]) {
        if (this.closed) break;
        if (!record.task.sessionId || terminal(record.task)) continue;
        try { await this.refresh(record.task.id); } catch { /* surfaced by task state or setup.storageError */ }
      }
    } finally { this.polling = false; }
  }

  private admit(revision: number): void {
    if (revision !== this.saved.configRevision) throw new ExecutionError(409, 'setup_changed', 'Execution settings changed. Review the current settings and confirm again.');
    if (this.saved.config.mode !== 'anthropic_cloud' || !this.setup().ready) throw new ExecutionError(409, 'cloud_not_ready', 'Save and check Anthropic cloud setup before explicitly submitting paid work.');
    if (this.saved.records.length >= 10_000) throw new ExecutionError(409, 'ledger_capacity', 'The retained cloud task ledger is full. Preserve task history and plan a migration before submitting more work.');
    if (this.saved.records.filter(record => !terminal(record.task)).length >= this.saved.config.limits.maxConcurrent) throw new ExecutionError(409, 'concurrency_limit', 'All configured cloud session slots are reserved. Reconcile or explicitly stop existing sessions first.');
    const reserved = this.saved.records.filter(record => record.task.budgetDay === this.day() || !terminal(record.task)).reduce((total, record) => total + Math.max(record.task.reservedCents, record.task.cost?.amountCents ?? 0), 0);
    if (reserved + this.saved.config.limits.perTaskBudgetCents > this.saved.config.limits.dailyBudgetCents) throw new ExecutionError(409, 'daily_allowance', 'The daily submission allowance is already reserved. This is an admission limit, not a billing meter.');
  }
  private apply(record: TaskRecord, observation: ProviderObservation): TaskRecord {
    const task: ExecutionTask = { ...record.task, sessionId: observation.sessionId, status: observation.status, providerStatus: observation.providerStatus, stopReason: undefined, updatedAt: this.now(), message: observation.message };
    if (!terminal(task) && observation.budgetCents !== record.task.reservedCents) {
      task.status = 'unknown'; task.message = 'The provider did not confirm the saved session budget. Keep this session’s reservation; review or stop it in provider controls before submitting more work.';
    }
    if (observation.costCents !== undefined) task.cost = { amountCents: Math.max(record.task.cost?.amountCents ?? 0, observation.costCents), currency: 'USD', observedAt: this.now() };
    return { ...record, task };
  }
  private record(id: string): TaskRecord {
    const record = this.saved.records.find(record => record.task.id === id);
    if (!record) throw new ExecutionError(404, 'task_not_found', 'No such managed execution task.');
    return record;
  }
  private sameSubmission(input: ExecutionSubmit, prompt: string, revision: number): void {
    if (input.prompt !== prompt || input.configRevision !== revision) throw new ExecutionError(409, 'task_id_conflict', 'That task ID already belongs to a different submission. Do not replace an uncertain task with a new ID.');
  }
  private day(): string { return new Date(this.now()).toISOString().slice(0, 10); }
  private fingerprint(credentials: ProviderCredentials): string { return createHash('sha256').update(JSON.stringify(credentials)).digest('hex'); }
  private credentials(required: boolean): ProviderCredentials {
    let apiKey = ''; let githubToken = '';
    try { apiKey = this.apiKey()?.trim() ?? ''; githubToken = this.githubToken()?.trim() ?? ''; }
    catch { if (required) throw new ExecutionError(503, 'credential_store_unavailable', 'Protected credential storage is unavailable. Unlock or configure it on the host.'); }
    if (required && (!apiKey || !githubToken)) throw new ExecutionError(409, 'credentials_missing', 'Configure Anthropic and GitHub credentials in protected host storage before checking cloud execution.');
    return { apiKey, githubToken };
  }
  private requireApiKey(): string {
    try { const key = this.apiKey()?.trim(); if (key) return key; }
    catch { throw new ExecutionError(503, 'credential_store_unavailable', 'Protected credential storage is unavailable.'); }
    throw new ExecutionError(409, 'credentials_missing', 'The host Anthropic API credential is not configured.');
  }
  private writable(): void {
    if (this.closed) throw new ExecutionError(503, 'execution_stopped', 'The execution manager is shutting down.');
    if (this.storageError) throw new ExecutionError(503, 'execution_storage_failed', this.storageError);
  }
  private replace(record: TaskRecord): void { this.commit({ ...this.saved, records: this.saved.records.map(item => item.task.id === record.task.id ? record : item) }); }
  private commit(next: SavedExecution): void {
    this.writable();
    try { writeJsonAtomic(this.file, next); this.saved = next; }
    catch { this.storageError = 'Execution ledger could not be saved. New dispatch is blocked; preserve existing task/session IDs and repair storage before restarting.'; throw new ExecutionError(503, 'execution_storage_failed', this.storageError); }
  }
  private restore(value: unknown): SavedExecution {
    const data = object(value, ['schemaVersion', 'config', 'configRevision', 'records']);
    if (data.schemaVersion !== 1 || !Number.isSafeInteger(data.configRevision) || Number(data.configRevision) < 0 || !Array.isArray(data.records) || data.records.length > 10_000) throw new Error('Invalid ledger');
    const ids = new Set<string>();
    for (const record of data.records) {
      object(record, ['task', 'config', 'configRevision', 'cursor', 'stopRequested']);
      validateConfig(record.config);
      const task = object(record.task, ['id', 'provider', 'mode', 'status', 'prompt', 'createdAt', 'updatedAt', 'repository', 'sourceCommit', 'branch', 'sessionId', 'eventCursor', 'reservedCents', 'budgetDay', 'cost', 'providerStatus', 'stopReason', 'message', 'outputs']);
      if (typeof task.id !== 'string' || !TASK_ID.test(task.id) || ids.has(task.id) || task.provider !== 'anthropic' || task.mode !== 'anthropic_cloud' || task.outputs !== 'unverified'
        || !['dispatch_uncertain', 'running', 'waiting_for_approval', 'budget_paused', 'idle', 'unknown', 'completed', 'failed', 'cancelled'].includes(String(task.status))
        || typeof task.prompt !== 'string' || !task.prompt || task.prompt.length > 20_000 || !COMMIT.test(String(task.sourceCommit))
        || task.branch !== `agent-empire/task-${task.id}` || !Number.isSafeInteger(task.reservedCents) || Number(task.reservedCents) < 1 || Number(task.reservedCents) > 100_000
        || typeof task.budgetDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(task.budgetDay) || !Number.isFinite(task.createdAt) || !Number.isFinite(task.updatedAt)
        || (task.sessionId !== undefined && !PROVIDER_ID.session.test(String(task.sessionId))) || typeof task.message !== 'string' || task.message.length > 2000
        || !Number.isSafeInteger(record.configRevision) || record.configRevision < 0) throw new Error('Invalid task');
      if (JSON.stringify(task.repository) !== JSON.stringify(record.config.repository)) throw new Error('Repository mismatch');
      if (task.cost !== undefined) { const cost = object(task.cost, ['amountCents', 'currency', 'observedAt']); if (!Number.isSafeInteger(cost.amountCents) || Number(cost.amountCents) < 0 || cost.currency !== 'USD' || !Number.isFinite(cost.observedAt)) throw new Error('Invalid cost'); }
      if (task.providerStatus !== undefined && !['running', 'rescheduling', 'idle', 'terminated', 'archived'].includes(String(task.providerStatus))) throw new Error('Invalid provider status');
      if (task.stopReason !== undefined && !['end_turn', 'requires_action', 'budget_reached', 'error', 'unknown'].includes(String(task.stopReason))) throw new Error('Invalid stop reason');
      if (record.stopRequested !== undefined && typeof record.stopRequested !== 'boolean') throw new Error('Invalid stop intent');
      if (task.eventCursor !== undefined && !PROVIDER_ID.event.test(String(task.eventCursor))) throw new Error('Invalid event ID');
      const cursor = object(record.cursor, ['after', 'page', 'newest', 'lastEventId', 'stopReason']);
      for (const key of ['after', 'newest']) if (cursor[key] !== undefined && (typeof cursor[key] !== 'string' || !Number.isFinite(Date.parse(cursor[key] as string)))) throw new Error('Invalid cursor');
      if (cursor.page !== undefined && (typeof cursor.page !== 'string' || cursor.page.length > 2048)) throw new Error('Invalid cursor');
      if (cursor.lastEventId !== undefined && !PROVIDER_ID.event.test(String(cursor.lastEventId))) throw new Error('Invalid cursor');
      if (cursor.stopReason !== undefined && !['end_turn', 'requires_action', 'budget_reached', 'error', 'unknown'].includes(String(cursor.stopReason))) throw new Error('Invalid cursor');
      ids.add(task.id);
    }
    return { schemaVersion: 1, config: validateConfig(data.config), configRevision: data.configRevision as number, records: clone(data.records) };
  }
}
