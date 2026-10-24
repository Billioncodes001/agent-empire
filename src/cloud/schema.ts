/**
 * CLOUD-01 state repository schema.
 *
 * The state repository holds versioned JSON files under `state/` that only the coordinator writes,
 * and one file per client intent under `intents/`. Everything here is pure and browser-safe so the
 * client cloud adapter (CLOUD-04) can parse the same snapshot the coordinator commits.
 *
 * Size discipline: the files read every run stay bounded. Full prompts live in `state/jobs.json`
 * only while a job still needs dispatching; finished jobs move to write-only `archive/` files that
 * the coordinator never reads.
 */
import { initialEmpire, newSector, SITES, type EmpireState, type SectorState, type SiteId } from '../shared/empire.js';
import { DESKS_PER_FLOOR } from '../shared/layout.js';
import type { ExecutionConfig, ExecutionTask } from '../shared/execution.js';
import { COMMIT, PROVIDER_ID, TASK_ID, validateConfig } from '../server/execution-validation.js';
import { DEFAULT_WORKER_MODEL, isWorkerModel, WORKER_ENVIRONMENT, type WorkerModel } from './worker-spec.js';
import { ActionsSettingsError, isCloudEngine, RUN_CAPS, validateActionsSettings, type ActionsSettings, type CloudEngine } from './actions-spec.js';

export const CLOUD_SCHEMA_VERSION = 1;
export const STATE_FILES = {
  meta: 'state/meta.json',
  empire: 'state/empire.json',
  jobs: 'state/jobs.json',
  ledger: 'state/ledger.json',
  journal: 'state/journal.json',
  /** Small file with the last committing run; separated so meta.json is not rewritten every run. */
  heartbeat: 'state/heartbeat.json',
  /** Recently processed intent ids (idempotency); changes only when intents are consumed. */
  processed: 'state/processed-intents.json',
  /**
   * Every job id ever moved to the archive (~39 bytes each; about 100,000 fit the 4 MB read limit).
   * Changes only when jobs are archived; prevents a replayed submission from paying twice.
   */
  archivedJobIds: 'state/archived-job-ids.json',
} as const;
export const INTENT_DIR = 'intents/';
export const INTENT_PATH = /^intents\/([A-Za-z0-9._-]{1,80})\.json$/;
export const ARCHIVE_DIR = 'archive/';

export const LIMITS = {
  journal: 500, spendEntries: 1000, spendDays: 90, processedIntents: 2000, reports: 80,
  /** Queued jobs keep their full prompt (≤ 20,000 chars), so the queue is capped. */
  queuedJobs: 50,
  /** Finished turns the user has not reviewed yet. */
  unreviewedJobs: 200,
  /** Final jobs retained in the hot file for display, newest first, before archiving. */
  finalRetained: 200,
  finalRetentionMs: 14 * 24 * 3600_000,
  /** Hard ceiling on hot-file jobs (queued + active + unreviewed + retained final). */
  hotJobs: 600,
} as const;

/** Same ranges as the host execution ledger (execution-validation.ts). */
export type CloudLimits = ExecutionConfig['limits'];
/** Provider references only. Credentials live in encrypted Actions secrets, never in state. */
export type CloudExecution = AnthropicExecution | ActionsExecution;
export interface AnthropicExecution {
  provider: 'anthropic';
  repository: ExecutionConfig['repository'];
  anthropic: ExecutionConfig['anthropic'];
}
/** FREE-04: jobs run as workflow_dispatch runs of the job workflow in the project repository. No credentials here. */
export interface ActionsExecution {
  provider: 'github-actions';
  repository: ExecutionConfig['repository'];
  actions: ActionsSettings;
}
export type ProviderId = CloudExecution['provider'];
export const PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'github-actions'];
/** GitHub Actions run references in the job cursor: ids, caps and the engine only. */
export interface ActionsCursor { owner: string; name: string; runId: number; jobId: string; engine: CloudEngine; budgetCents: number; maxTurns: number }
/**
 * How a job's cost was established. `free_run` and `claude_plan` always carry 0 cents: a free run costs nothing and a
 * Claude-subscription run is billed to the user's plan, never as a US$ figure. `engine_reported_estimate` is Claude
 * Code's own total for an API-key run in GitHub Actions, kept apart from provider-reported list costs.
 */
export type CostBasis = 'provider_reported_list_cost' | 'engine_reported_estimate' | 'free_run' | 'claude_plan';
export const COST_BASES: readonly CostBasis[] = ['provider_reported_list_cost', 'engine_reported_estimate', 'free_run', 'claude_plan'];
/** Money reservation (per-job allowance) or, for free and subscription runs, a zero-money reservation of run caps. */
export type ReservationBasis = 'per_job_allowance_estimate' | 'run_caps';

/**
 * A request for the coordinator to find or create the Anthropic agent and environment for `repository`
 * (src/cloud/provisioning.ts). Present only until it succeeds; it then becomes `execution`. No secrets.
 */
export interface CloudProvisioning {
  provider: 'anthropic';
  repository: ExecutionConfig['repository'];
  /** `pending`: the next run tries. `failed`: `message` says why; retried hourly when `retryable`. */
  status: 'pending' | 'failed';
  /** Worker model for the agent (absent in states written before 2026-10-02: the default, Sonnet 5). */
  model?: WorkerModel;
  requestedAt: number;
  attempts: number;
  lastAttemptAt?: number;
  retryable?: boolean;
  message?: string;
}
export const PROVISION_RETRY_MS = 60 * 60_000;
export interface CloudExecutionProfile { model: WorkerModel; networking: typeof WORKER_ENVIRONMENT.config.networking.type }

/** Scheduled-run cost estimate shown by setup. Dispatch-triggered runs come on top. */
export interface ScheduleEstimate {
  intervalMinutes: number;
  runsPerMonth: number;
  /** GitHub bills each job rounded up to whole minutes; assumes each run finishes within one minute. */
  billedMinutesPerMonth: number;
  basis: 'estimate_scheduled_runs_only';
}
export const SCHEDULE_INTERVALS = [15, 20, 30, 60] as const;
export const DEFAULT_INTERVAL_MINUTES = 30;
export function scheduleEstimate(intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): ScheduleEstimate {
  if (!SCHEDULE_INTERVALS.includes(intervalMinutes as (typeof SCHEDULE_INTERVALS)[number])) throw new Error('The coordinator interval must be 15, 20, 30 or 60 minutes.');
  const runsPerMonth = Math.round((30 * 24 * 60) / intervalMinutes);
  return { intervalMinutes, runsPerMonth, billedMinutesPerMonth: runsPerMonth, basis: 'estimate_scheduled_runs_only' };
}

export type LifecycleStatus = 'running' | 'shutting_down' | 'shutdown';
export interface CloudMeta {
  schemaVersion: 1;
  createdAt: number;
  /** Incremented by every coordinator commit. */
  revision: number;
  /** Incremented by every limits/execution change; paid job submissions must name the current value. */
  configRevision: number;
  lifecycle: {
    status: LifecycleStatus;
    changedAt: number;
    /** `disable_requested` means the coordinator could not (or was not allowed to) disable itself yet. */
    workflow: 'enabled' | 'disable_requested' | 'disabled';
  };
  coordinator: {
    /** Wall-clock time up to which city time has been settled. Never advanced while shut down. */
    economyClockAt?: number;
  };
  schedule: ScheduleEstimate;
  limits: CloudLimits;
  execution?: CloudExecution;
  /** Automatic execution setup waiting for (or having failed in) a coordinator run. */
  provisioning?: CloudProvisioning;
  /** What automatic setup created, for display. Absent for manually entered IDs (unknown to the coordinator). */
  executionProfile?: CloudExecutionProfile;
}
export interface CloudHeartbeat { schemaVersion: 1; lastRunId?: string; lastRunAt?: number }
export interface ProcessedIntent { id: string; at: number; outcome: 'applied' | 'rejected' | 'duplicate'; kind?: string }
export interface CloudProcessedIntents { schemaVersion: 1; entries: ProcessedIntent[] }
export interface CloudArchivedJobIds { schemaVersion: 1; ids: string[] }

export type CloudJobStatus =
  | 'queued' | 'dispatching' | 'dispatch_uncertain' | 'running' | 'waiting_for_approval' | 'budget_paused' | 'idle' | 'unknown'
  | 'awaiting_review' | 'accepted' | 'rejected' | 'failed' | 'cancelled';
export const JOB_STATUSES: readonly CloudJobStatus[] = ['queued', 'dispatching', 'dispatch_uncertain', 'running', 'waiting_for_approval', 'budget_paused', 'idle', 'unknown', 'awaiting_review', 'accepted', 'rejected', 'failed', 'cancelled'];
/** A job in one of these states may have an accepted, working provider session. */
export const SLOT_STATUSES: readonly CloudJobStatus[] = ['dispatching', 'dispatch_uncertain', 'running', 'waiting_for_approval', 'budget_paused', 'idle', 'unknown'];
export const REVIEW_STATUSES: readonly CloudJobStatus[] = ['awaiting_review', 'accepted', 'rejected'];
export const FINAL_STATUSES: readonly CloudJobStatus[] = ['accepted', 'rejected', 'failed', 'cancelled'];
/** Only these states still need the full prompt (it is sent at dispatch). */
export const PROMPT_STATUSES: readonly CloudJobStatus[] = ['queued', 'dispatching'];
/** A session not yet archived or terminated by the provider. */
export const sessionLive = (job: CloudJob) => !!job.sessionId && job.providerStatus !== 'archived' && job.providerStatus !== 'terminated';
/**
 * Holds a concurrency slot: any active state, or a reviewable job whose session was deliberately
 * left open because its branch output could not be confirmed (so unpushed work is not archived).
 */
export const holdsSlot = (job: CloudJob) => SLOT_STATUSES.includes(job.status) || (REVIEW_STATUSES.includes(job.status) && sessionLive(job));

export interface EventCursorState { after?: string; page?: string; newest?: string; lastEventId?: string; stopReason?: ExecutionTask['stopReason']; actions?: ActionsCursor }
export interface CloudJob {
  id: string;
  title: string;
  /** Full prompt; present only while the job is queued or dispatching. */
  prompt?: string;
  promptPreview: string;
  /** FNV-1a fingerprint for duplicate-submission checks; not a security hash. */
  promptHash: string;
  /** Write-only archive path holding the full prompt after it left the hot file. */
  promptArchive?: string;
  /** Optional sector link: a manager startup brief or sector work. Rewards default to headquarters. */
  site?: SiteId;
  intentId: string;
  createdAt: number;
  updatedAt: number;
  configRevision: number;
  /** Per-job allowance the user confirmed at submission. Dispatch never reserves more than this. */
  authorizedCents: number;
  status: CloudJobStatus;
  message: string;
  provider: ProviderId;
  repository: ExecutionConfig['repository'];
  branch: string;
  sourceCommit?: string;
  sessionId?: string;
  cursor?: EventCursorState;
  providerStatus?: ExecutionTask['providerStatus'];
  stopReason?: ExecutionTask['stopReason'];
  /** Task branch head observed with the project token: evidence of a push, not verification. */
  branchHead?: { sha: string; observedAt: number };
  /** Admission-control estimate: the full per-job budget, not an observed charge. */
  reservation?: { cents: number; day: string; basis: ReservationBasis };
  cost?: { amountCents: number; currency: 'USD'; observedAt: number; basis: CostBasis };
  dispatch?: { runId: string; preparedAt: number; attempts: number };
  stopRequested?: { at: number; reason: StopReason };
  review?: { decision: 'accepted' | 'rejected'; at: number; intentId: string; note?: string };
  /** Provider state never verifies code, a branch or a pull request. Review is a user decision. */
  outputs: 'unverified';
  rewarded?: boolean;
}
export type StopReason = 'cancel' | 'shutdown' | 'turn_ended' | 'review';
export interface CloudJobs { schemaVersion: 1; jobs: CloudJob[] }

/** Real-money evidence, kept apart from the city's simulation-credit ledger in empire.json. */
export interface SpendEntry {
  at: number;
  jobId: string;
  /** `cost_estimated`: an engine-reported estimate (API-key Actions runs), never added into observed costs. */
  kind: 'reserved' | 'released' | 'cost_observed' | 'cost_estimated';
  cents: number;
  day: string;
  basis: 'per_job_allowance_estimate' | CostBasis;
}
export interface CloudLedger {
  schemaVersion: 1;
  currency: 'USD';
  entries: SpendEntry[];
  days: Record<string, { reservedCents: number; observedCostCents: number; estimatedCostCents?: number }>;
}

export type JournalKind = 'intent_applied' | 'intent_rejected' | 'job' | 'dispatch' | 'lifecycle' | 'limits' | 'economy' | 'warning';
export interface JournalEntry { seq: number; at: number; runId: string; kind: JournalKind; message: string; intentId?: string; jobId?: string }
export interface CloudJournal { schemaVersion: 1; seq: number; entries: JournalEntry[] }

export interface CloudState {
  meta: CloudMeta;
  empire: EmpireState;
  jobs: CloudJobs;
  ledger: CloudLedger;
  journal: CloudJournal;
  heartbeat: CloudHeartbeat;
  processed: CloudProcessedIntents;
  archivedJobIds: CloudArchivedJobIds;
}

export class SchemaError extends Error {
  constructor(readonly file: string, message: string) { super(`${file}: ${message}`); this.name = 'SchemaError'; }
}

export const DEFAULT_LIMITS: CloudLimits = { maxConcurrent: 1, perTaskBudgetCents: 100, dailyBudgetCents: 500 };
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** 64-bit FNV-1a over UTF-16 code units, hex. Deterministic and browser-safe; not cryptographic. */
export function promptHash(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) { hash ^= BigInt(text.charCodeAt(i)); hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn; }
  return hash.toString(16).padStart(16, '0');
}
export const promptPreview = (text: string) => text.length > 200 ? text.slice(0, 199) + '…' : text;

export function initialCloudState(now: number, options: { limits?: CloudLimits; execution?: CloudExecution; intervalMinutes?: number; provision?: ExecutionConfig['repository']; model?: WorkerModel } = {}): CloudState {
  const limits = validateLimits(options.limits ?? DEFAULT_LIMITS);
  const empire = initialEmpire(now);
  empire.reports[0].text = 'Cloud mode: the coordinator in your GitHub state repository keeps the city running. City credits are simulation credits; provider usage is billed by your provider.';
  return {
    meta: {
      schemaVersion: 1, createdAt: now, revision: 0, configRevision: 0,
      lifecycle: { status: 'running', changedAt: now, workflow: 'enabled' },
      coordinator: {}, schedule: scheduleEstimate(options.intervalMinutes), limits,
      ...(options.execution ? { execution: validateExecution(options.execution) } : {}),
      ...(options.provision && !options.execution ? { provisioning: { provider: 'anthropic' as const, repository: validateProvisionRepository(options.provision), status: 'pending' as const, model: options.model ?? DEFAULT_WORKER_MODEL, requestedAt: now, attempts: 0 } } : {}),
    },
    empire,
    jobs: { schemaVersion: 1, jobs: [] },
    ledger: { schemaVersion: 1, currency: 'USD', entries: [], days: {} },
    journal: { schemaVersion: 1, seq: 0, entries: [] },
    heartbeat: { schemaVersion: 1 },
    processed: { schemaVersion: 1, entries: [] },
    archivedJobIds: { schemaVersion: 1, ids: [] },
  };
}

// ---------------------------------------------------------------- validation helpers

type Rec = Record<string, unknown>;
function rec(file: string, value: unknown, keys?: readonly string[]): Rec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SchemaError(file, 'expected an object');
  if (keys) { const extra = Object.keys(value).filter(key => !keys.includes(key)); if (extra.length) throw new SchemaError(file, `unexpected field ${extra[0]}`); }
  return value as Rec;
}
function int(file: string, value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new SchemaError(file, `invalid integer ${String(value)}`);
  return value as number;
}
function time(file: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new SchemaError(file, 'invalid timestamp');
  return value;
}
function str(file: string, value: unknown, max: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length > max || (pattern && !pattern.test(value))) throw new SchemaError(file, 'invalid text field');
  return value;
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RUN_ID = /^[A-Za-z0-9._-]{1,80}$/;
const ACTIONS_RUN = /^ghrun_[1-9][0-9]{0,19}$/;

/** Reuses the host ranges: 1–10 concurrent, per-task 1–100,000 cents, daily ≥ per-task and ≤ 10,000,000. */
export function validateLimits(value: unknown): CloudLimits {
  return validateConfig({ schemaVersion: 1, completed: false, mode: 'local', repository: { owner: '', name: '', baseBranch: '' }, anthropic: { agentId: '', environmentId: '' }, githubAuth: 'host_token', limits: value }).limits;
}
/** Reuses the host repository/provider-reference validation for a completed Anthropic cloud config. */
export function validateExecution(value: unknown): CloudExecution {
  if ((value as Rec | null)?.provider === 'github-actions') {
    const input = rec('execution', value, ['provider', 'repository', 'actions']);
    const repository = validateProvisionRepository(input.repository);
    try { return { provider: 'github-actions', repository, actions: validateActionsSettings(input.actions) }; }
    catch (error) { throw new SchemaError('execution', error instanceof ActionsSettingsError ? error.message : 'invalid GitHub Actions settings'); }
  }
  const input = rec('execution', value, ['provider', 'repository', 'anthropic']);
  if (input.provider !== 'anthropic') throw new SchemaError('execution', 'only the anthropic provider is implemented');
  const config = validateConfig({ schemaVersion: 1, completed: true, mode: 'anthropic_cloud', repository: input.repository, anthropic: input.anthropic, githubAuth: 'host_token', limits: DEFAULT_LIMITS });
  return { provider: 'anthropic', repository: config.repository, anthropic: config.anthropic };
}

/** A complete project repository reference (owner, name, base branch), validated like execution settings. */
export function validateProvisionRepository(value: unknown): ExecutionConfig['repository'] {
  const config = validateConfig({ schemaVersion: 1, completed: true, mode: 'anthropic_cloud', repository: value, anthropic: { agentId: 'agent_placeholder0', environmentId: 'env_placeholder0' }, githubAuth: 'host_token', limits: DEFAULT_LIMITS });
  return config.repository;
}

export function validateProvisioning(file: string, value: unknown): CloudProvisioning {
  const p = rec(file, value, ['provider', 'repository', 'status', 'model', 'requestedAt', 'attempts', 'lastAttemptAt', 'retryable', 'message']);
  if (p.model !== undefined && !isWorkerModel(p.model)) throw new SchemaError(file, 'invalid provisioning model');
  if (p.provider !== 'anthropic' || (p.status !== 'pending' && p.status !== 'failed')) throw new SchemaError(file, 'invalid provisioning');
  let repository: ExecutionConfig['repository'];
  try { repository = validateProvisionRepository(p.repository); } catch { throw new SchemaError(file, 'invalid provisioning repository'); }
  time(file, p.requestedAt); int(file, p.attempts, 0, 1_000_000);
  if (p.lastAttemptAt !== undefined) time(file, p.lastAttemptAt);
  if (p.retryable !== undefined && typeof p.retryable !== 'boolean') throw new SchemaError(file, 'invalid provisioning');
  if (p.message !== undefined) str(file, p.message, 2000);
  return { ...(clone(p) as unknown as CloudProvisioning), repository };
}

export function validateMeta(value: unknown): CloudMeta {
  const f = STATE_FILES.meta;
  const m = rec(f, value, ['schemaVersion', 'createdAt', 'revision', 'configRevision', 'lifecycle', 'coordinator', 'schedule', 'limits', 'execution', 'provisioning', 'executionProfile']);
  if (m.executionProfile !== undefined) {
    const x = rec(f, m.executionProfile, ['model', 'networking']);
    if (!isWorkerModel(x.model) || x.networking !== WORKER_ENVIRONMENT.config.networking.type) throw new SchemaError(f, 'invalid execution profile');
  }
  if (m.schemaVersion !== CLOUD_SCHEMA_VERSION) throw new SchemaError(f, 'unsupported schemaVersion');
  const lifecycle = rec(f, m.lifecycle, ['status', 'changedAt', 'workflow']);
  if (!['running', 'shutting_down', 'shutdown'].includes(String(lifecycle.status)) || !['enabled', 'disable_requested', 'disabled'].includes(String(lifecycle.workflow))) throw new SchemaError(f, 'invalid lifecycle');
  const coordinator = rec(f, m.coordinator, ['economyClockAt']);
  if (coordinator.economyClockAt !== undefined) time(f, coordinator.economyClockAt);
  const schedule = rec(f, m.schedule, ['intervalMinutes', 'runsPerMonth', 'billedMinutesPerMonth', 'basis']);
  let expected: ScheduleEstimate;
  try { expected = scheduleEstimate(schedule.intervalMinutes as number); } catch { throw new SchemaError(f, 'invalid schedule'); }
  if (JSON.stringify(expected) !== JSON.stringify({ intervalMinutes: schedule.intervalMinutes, runsPerMonth: schedule.runsPerMonth, billedMinutesPerMonth: schedule.billedMinutesPerMonth, basis: schedule.basis })) throw new SchemaError(f, 'inconsistent schedule estimate');
  let limits: CloudLimits;
  try { limits = validateLimits(m.limits); } catch { throw new SchemaError(f, 'invalid limits'); }
  let execution: CloudExecution | undefined;
  if (m.execution !== undefined) { try { execution = validateExecution(m.execution); } catch { throw new SchemaError(f, 'invalid execution references'); } }
  const provisioning = m.provisioning === undefined ? undefined : validateProvisioning(f, m.provisioning);
  time(f, m.createdAt); int(f, m.revision); int(f, m.configRevision); time(f, lifecycle.changedAt);
  return { ...(clone(m) as unknown as CloudMeta), schedule: expected, limits, ...(execution ? { execution } : {}), ...(provisioning ? { provisioning } : {}) };
}

export function validateHeartbeat(value: unknown): CloudHeartbeat {
  const f = STATE_FILES.heartbeat;
  const h = rec(f, value, ['schemaVersion', 'lastRunId', 'lastRunAt']);
  if (h.schemaVersion !== 1) throw new SchemaError(f, 'unsupported schemaVersion');
  if (h.lastRunId !== undefined) str(f, h.lastRunId, 80, RUN_ID);
  if (h.lastRunAt !== undefined) time(f, h.lastRunAt);
  return clone(h) as unknown as CloudHeartbeat;
}

export function validateProcessed(value: unknown): CloudProcessedIntents {
  const f = STATE_FILES.processed;
  const data = rec(f, value, ['schemaVersion', 'entries']);
  if (data.schemaVersion !== 1 || !Array.isArray(data.entries) || data.entries.length > LIMITS.processedIntents) throw new SchemaError(f, 'invalid processed intents');
  for (const item of data.entries) {
    const p = rec(f, item, ['id', 'at', 'outcome', 'kind']);
    str(f, p.id, 80); time(f, p.at);
    if (!['applied', 'rejected', 'duplicate'].includes(String(p.outcome))) throw new SchemaError(f, 'invalid intent outcome');
    if (p.kind !== undefined) str(f, p.kind, 40);
  }
  return clone(data) as unknown as CloudProcessedIntents;
}

export function validateArchivedJobIds(value: unknown): CloudArchivedJobIds {
  const f = STATE_FILES.archivedJobIds;
  const data = rec(f, value, ['schemaVersion', 'ids']);
  if (data.schemaVersion !== 1 || !Array.isArray(data.ids)) throw new SchemaError(f, 'invalid archived job ids');
  const seen = new Set<string>();
  for (const id of data.ids) { str(f, id, 36, TASK_ID); if (seen.has(id)) throw new SchemaError(f, 'duplicate archived job id'); seen.add(id); }
  return clone(data) as unknown as CloudArchivedJobIds;
}

const REPO = (file: string, value: unknown) => {
  const r = rec(file, value, ['owner', 'name', 'baseBranch']);
  return { owner: str(file, r.owner, 39), name: str(file, r.name, 100), baseBranch: str(file, r.baseBranch, 200) };
};
export function validateJobs(value: unknown): CloudJobs {
  const f = STATE_FILES.jobs;
  const data = rec(f, value, ['schemaVersion', 'jobs']);
  if (data.schemaVersion !== 1 || !Array.isArray(data.jobs) || data.jobs.length > LIMITS.hotJobs) throw new SchemaError(f, 'invalid jobs file');
  const ids = new Set<string>();
  for (const item of data.jobs) {
    const j = rec(f, item, ['id', 'title', 'prompt', 'promptPreview', 'promptHash', 'promptArchive', 'site', 'intentId', 'createdAt', 'updatedAt', 'configRevision', 'authorizedCents', 'status', 'message', 'provider', 'repository', 'branch', 'sourceCommit', 'sessionId', 'cursor', 'providerStatus', 'stopReason', 'branchHead', 'reservation', 'cost', 'dispatch', 'stopRequested', 'review', 'outputs', 'rewarded']);
    const id = str(f, j.id, 36, TASK_ID);
    if (ids.has(id)) throw new SchemaError(f, `duplicate job ${id}`);
    ids.add(id);
    str(f, j.title, 120); str(f, j.intentId, 80); str(f, j.message, 2000); str(f, j.promptPreview, 200); str(f, j.promptHash, 16, /^[a-f0-9]{16}$/);
    if (!JOB_STATUSES.includes(j.status as CloudJobStatus)) throw new SchemaError(f, 'invalid job status');
    if (j.prompt !== undefined && !str(f, j.prompt, 20_000).trim()) throw new SchemaError(f, 'empty prompt');
    if (PROMPT_STATUSES.includes(j.status as CloudJobStatus) && j.prompt === undefined) throw new SchemaError(f, 'a job awaiting dispatch needs its prompt');
    if (j.promptArchive !== undefined) str(f, j.promptArchive, 120, /^archive\/prompts\/[a-f0-9-]{36}\.txt$/);
    if (j.site !== undefined && !SITES.some(s => s.id === j.site)) throw new SchemaError(f, 'invalid site');
    time(f, j.createdAt); time(f, j.updatedAt); int(f, j.configRevision); int(f, j.authorizedCents, 1, 100_000);
    if (!PROVIDER_IDS.includes(j.provider as ProviderId) || j.outputs !== 'unverified') throw new SchemaError(f, 'invalid provider/outputs');
    const actions = j.provider === 'github-actions';
    REPO(f, j.repository);
    if (j.branch !== `agent-empire/task-${id}`) throw new SchemaError(f, 'invalid branch');
    if (j.sourceCommit !== undefined) str(f, j.sourceCommit, 64, COMMIT);
    if (j.sessionId !== undefined) str(f, j.sessionId, 120, actions ? ACTIONS_RUN : PROVIDER_ID.session);
    if (j.providerStatus !== undefined && !['running', 'rescheduling', 'idle', 'terminated', 'archived'].includes(String(j.providerStatus))) throw new SchemaError(f, 'invalid providerStatus');
    const stops = ['end_turn', 'requires_action', 'budget_reached', 'error', 'unknown'];
    if (j.stopReason !== undefined && !stops.includes(String(j.stopReason))) throw new SchemaError(f, 'invalid stopReason');
    if (j.cursor !== undefined) {
      const c = rec(f, j.cursor, ['after', 'page', 'newest', 'lastEventId', 'stopReason', 'actions']);
      if (c.actions !== undefined) {
        if (!actions) throw new SchemaError(f, 'invalid cursor');
        const a = rec(f, c.actions, ['owner', 'name', 'runId', 'jobId', 'engine', 'budgetCents', 'maxTurns']);
        str(f, a.owner, 39); str(f, a.name, 100); int(f, a.runId, 1); int(f, a.budgetCents, 0, 100_000); int(f, a.maxTurns, RUN_CAPS.turns.min, RUN_CAPS.turns.max);
        if (a.jobId !== id || !isCloudEngine(a.engine)) throw new SchemaError(f, 'invalid cursor');
        if (j.sessionId !== undefined && j.sessionId !== `ghrun_${a.runId}`) throw new SchemaError(f, 'cursor does not match the run');
      }
      for (const key of ['after', 'newest']) if (c[key] !== undefined && !Number.isFinite(Date.parse(str(f, c[key], 64)))) throw new SchemaError(f, 'invalid cursor');
      if (c.page !== undefined) str(f, c.page, 2048);
      if (c.lastEventId !== undefined) str(f, c.lastEventId, 120, PROVIDER_ID.event);
      if (c.stopReason !== undefined && !stops.includes(String(c.stopReason))) throw new SchemaError(f, 'invalid cursor');
    }
    if (j.branchHead !== undefined) { const b = rec(f, j.branchHead, ['sha', 'observedAt']); str(f, b.sha, 64, COMMIT); time(f, b.observedAt); }
    if (j.reservation !== undefined) {
      const r = rec(f, j.reservation, ['cents', 'day', 'basis']);
      str(f, r.day, 10, DAY);
      if (r.basis === 'run_caps') { if (!actions) throw new SchemaError(f, 'invalid reservation basis'); int(f, r.cents, 0, 0); }
      else if (r.basis === 'per_job_allowance_estimate') int(f, r.cents, 1, 100_000);
      else throw new SchemaError(f, 'invalid reservation basis');
    }
    if (j.cost !== undefined) {
      const c = rec(f, j.cost, ['amountCents', 'currency', 'observedAt', 'basis']);
      int(f, c.amountCents); time(f, c.observedAt);
      if (c.currency !== 'USD' || !COST_BASES.includes(c.basis as CostBasis)) throw new SchemaError(f, 'invalid cost');
      if (c.basis !== 'provider_reported_list_cost' && !actions) throw new SchemaError(f, 'invalid cost');
      if ((c.basis === 'free_run' || c.basis === 'claude_plan') && c.amountCents !== 0) throw new SchemaError(f, 'invalid cost');
    }
    if (j.dispatch !== undefined) { const d = rec(f, j.dispatch, ['runId', 'preparedAt', 'attempts']); str(f, d.runId, 80, RUN_ID); time(f, d.preparedAt); int(f, d.attempts, 0, 100); }
    if (j.stopRequested !== undefined) { const s = rec(f, j.stopRequested, ['at', 'reason']); time(f, s.at); if (!['cancel', 'shutdown', 'turn_ended', 'review'].includes(String(s.reason))) throw new SchemaError(f, 'invalid stop reason'); }
    if (j.review !== undefined) { const r = rec(f, j.review, ['decision', 'at', 'intentId', 'note']); if (!['accepted', 'rejected'].includes(String(r.decision))) throw new SchemaError(f, 'invalid review'); time(f, r.at); str(f, r.intentId, 80); if (r.note !== undefined) str(f, r.note, 500); }
    if (j.rewarded !== undefined && typeof j.rewarded !== 'boolean') throw new SchemaError(f, 'invalid rewarded flag');
    if (holdsSlot(j as unknown as CloudJob) && !j.reservation) throw new SchemaError(f, 'active job without a budget reservation');
  }
  return clone(data) as unknown as CloudJobs;
}

export function validateLedger(value: unknown): CloudLedger {
  const f = STATE_FILES.ledger;
  const data = rec(f, value, ['schemaVersion', 'currency', 'entries', 'days']);
  if (data.schemaVersion !== 1 || data.currency !== 'USD' || !Array.isArray(data.entries) || data.entries.length > LIMITS.spendEntries) throw new SchemaError(f, 'invalid ledger');
  for (const item of data.entries) {
    const e = rec(f, item, ['at', 'jobId', 'kind', 'cents', 'day', 'basis']);
    time(f, e.at); str(f, e.jobId, 36, TASK_ID); int(f, e.cents); str(f, e.day, 10, DAY);
    if (!['reserved', 'released', 'cost_observed', 'cost_estimated'].includes(String(e.kind)) || !['per_job_allowance_estimate', ...COST_BASES].includes(String(e.basis))) throw new SchemaError(f, 'invalid spend entry');
  }
  const days = rec(f, data.days);
  if (Object.keys(days).length > LIMITS.spendDays) throw new SchemaError(f, 'too many ledger days');
  for (const [day, totals] of Object.entries(days)) {
    str(f, day, 10, DAY);
    const t = rec(f, totals, ['reservedCents', 'observedCostCents', 'estimatedCostCents']);
    int(f, t.reservedCents); int(f, t.observedCostCents);
    if (t.estimatedCostCents !== undefined) int(f, t.estimatedCostCents);
  }
  return clone(data) as unknown as CloudLedger;
}

export function validateJournal(value: unknown): CloudJournal {
  const f = STATE_FILES.journal;
  const data = rec(f, value, ['schemaVersion', 'seq', 'entries']);
  if (data.schemaVersion !== 1 || !Array.isArray(data.entries) || data.entries.length > LIMITS.journal) throw new SchemaError(f, 'invalid journal');
  const seq = int(f, data.seq);
  const entries = data.entries as unknown[];
  entries.forEach((item, index) => {
    const e = rec(f, item, ['seq', 'at', 'runId', 'kind', 'message', 'intentId', 'jobId']);
    if (e.seq !== seq - entries.length + 1 + index) throw new SchemaError(f, 'journal sequence gap');
    time(f, e.at); str(f, e.runId, 80); str(f, e.message, 2000);
    if (!['intent_applied', 'intent_rejected', 'job', 'dispatch', 'lifecycle', 'limits', 'economy', 'warning'].includes(String(e.kind))) throw new SchemaError(f, 'invalid journal kind');
  });
  return clone(data) as unknown as CloudJournal;
}

/** Mirrors the server's empire.json load checks (src/server/empire.ts) without touching the filesystem. */
export function validateEmpire(value: unknown): EmpireState {
  const f = STATE_FILES.empire;
  const saved = rec(f, value) as any;
  if (saved.version !== 2 || !Array.isArray(saved.sectors) || !Number.isFinite(saved.funds) || saved.funds < 0 || !Number.isFinite(saved.minutes)) throw new SchemaError(f, 'invalid empire save');
  for (const site of SITES) {
    if (!saved.sectors.some((s: any) => s.id === site.id && typeof s.built === 'boolean' && Number.isInteger(s.staff) && s.staff >= 0 && s.staff <= site.capacity)) throw new SchemaError(f, `invalid sector ${site.id}`);
  }
  const e = saved.economy;
  if (!saved.setup || typeof saved.setup.completed !== 'boolean' || !e || !Array.isArray(e.rewardedTasks) || !Array.isArray(e.ledger) || !e.employees || Array.isArray(e.employees)
    || !['startedAt', 'lastHour', 'revenue', 'wages', 'upkeep', 'dividends', 'ownerBalance'].every(key => Number.isFinite(e[key]) && e[key] >= 0) || !Number.isFinite(e.capital)
    || !saved.sectors.every((s: any) => typeof s.owned === 'boolean' && Number.isInteger(s.level) && s.level >= 1 && s.level <= 3 && ['revenue', 'wages', 'upkeep'].every(key => Number.isFinite(s[key]) && s[key] >= 0))) throw new SchemaError(f, 'invalid economy');
  const office = saved.office;
  if (!office || !Number.isSafeInteger(office.floors) || office.floors < 1 || !Number.isSafeInteger(office.workstations) || office.workstations < 1 || office.workstations > office.floors * DESKS_PER_FLOOR) throw new SchemaError(f, 'invalid headquarters capacity');
  const state = clone(saved) as EmpireState;
  delete state.supervision;
  return state;
}

// ---------------------------------------------------------------- migrations

export type StateFiles = Record<string, string>;
/**
 * Registry of whole-snapshot migrations keyed by the meta schemaVersion they upgrade FROM.
 * Schema version 1 is the first cloud release, so the registry is empty; add `1: files => ...` when v2 ships.
 * A snapshot written by a newer coordinator is refused rather than downgraded.
 */
export const SNAPSHOT_MIGRATIONS: Record<number, (files: Record<string, unknown>) => Record<string, unknown>> = {};

/** City-save migration shared with the host format: version 1 saves become version 2 (see ECONOMY.md). */
export function migrateEmpire(value: unknown, now: number): { empire: unknown; migrated: boolean } {
  const saved = value as any;
  if (!saved || saved.version !== 1 || !Array.isArray(saved.sectors)) return { empire: value, migrated: false };
  const fresh = initialEmpire(now);
  const empire: EmpireState = {
    ...fresh, ...saved,
    version: 2,
    office: { floors: 1, workstations: 16 },
    delegated: true,
    setup: fresh.setup,
    economy: fresh.economy,
    sectors: SITES.map(s => ({ ...newSector(s.id), ...saved.sectors.find((old: SectorState) => old.id === s.id) })),
  };
  empire.economy.lastHour = Math.floor(empire.minutes / 60);
  empire.reports = [{ at: now, sector: 'Chief of staff', text: 'Your existing district and treasury have been preserved. Complete founding setup to appoint your sector managers.' }, ...(Array.isArray(saved.reports) ? saved.reports : [])].slice(0, LIMITS.reports);
  return { empire, migrated: true };
}

export function parseStateFiles(files: StateFiles, now: number): { state: CloudState; migrated: string[] } {
  const raw: Record<string, unknown> = {};
  for (const [key, file] of Object.entries(STATE_FILES)) {
    const text = files[file];
    if (text === undefined) throw new SchemaError(file, 'missing; the state repository is not initialized');
    try { raw[key] = JSON.parse(text); } catch { throw new SchemaError(file, 'invalid JSON'); }
  }
  const migrated: string[] = [];
  let version = (raw.meta as any)?.schemaVersion;
  if (!Number.isSafeInteger(version) || version < 1) throw new SchemaError(STATE_FILES.meta, 'missing schemaVersion');
  if (version > CLOUD_SCHEMA_VERSION) throw new SchemaError(STATE_FILES.meta, `written by a newer coordinator (schema ${version}); upgrade the coordinator instead of downgrading state`);
  while (version < CLOUD_SCHEMA_VERSION) {
    const step = SNAPSHOT_MIGRATIONS[version];
    if (!step) throw new SchemaError(STATE_FILES.meta, `no migration from schema ${version}`);
    Object.assign(raw, step(raw)); version++; migrated.push(`schema ${version - 1}→${version}`);
  }
  const empire = migrateEmpire(raw.empire, now);
  if (empire.migrated) migrated.push('empire version 1→2');
  return {
    state: {
      meta: validateMeta(raw.meta), empire: validateEmpire(empire.empire), jobs: validateJobs(raw.jobs), ledger: validateLedger(raw.ledger),
      journal: validateJournal(raw.journal), heartbeat: validateHeartbeat(raw.heartbeat), processed: validateProcessed(raw.processed),
      archivedJobIds: validateArchivedJobIds(raw.archivedJobIds),
    },
    migrated,
  };
}

/** Stable serialization: identical state produces identical bytes, so unchanged files are not rewritten. */
export function serializeState(state: CloudState): StateFiles {
  const { supervision: _ephemeral, ...empire } = state.empire;
  const text = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  return {
    [STATE_FILES.meta]: text(state.meta),
    [STATE_FILES.empire]: text(empire),
    [STATE_FILES.jobs]: text(state.jobs),
    [STATE_FILES.ledger]: text(state.ledger),
    [STATE_FILES.journal]: text(state.journal),
    [STATE_FILES.heartbeat]: text(state.heartbeat),
    [STATE_FILES.processed]: text(state.processed),
    [STATE_FILES.archivedJobIds]: JSON.stringify(state.archivedJobIds) + '\n',
  };
}
