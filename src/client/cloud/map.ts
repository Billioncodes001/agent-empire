/**
 * Pure mapping from a state-repository snapshot to what the game shows. Nothing here claims liveness: every value is
 * "as recorded by the coordinator at the snapshot time", and the status view says how old that is.
 */
import { holdsSlot, REVIEW_STATUSES, utcDay, type CloudJob, type CloudJobStatus, type CloudState } from '../../cloud/schema';
import { defaultModelFor, PROVIDER_LABELS, workerModelLabel } from '../../cloud/worker-spec';
import { OPENAI_DISCLOSURES } from '../../cloud/openai-spec';

/** Owner decision 2026-10-02, shown wherever execution is described. */
export const SANDBOX_NOTE = 'Workers run in an Anthropic cloud sandbox with full internet access: they can install packages and can also fetch untrusted content. They approve their own tool use inside the sandbox; your keys never enter it.';
/** CLOUD-06: the OpenAI equivalent, with the vault disclosure and the owner verification gate. */
export const OPENAI_SANDBOX_NOTE = `Workers run in a medium OpenAI-hosted sandbox (2 vCPU, 4 GB) with network access: they can install packages and can also fetch untrusted content. Your OpenAI key never enters it. ${OPENAI_DISCLOSURES.join(' ')}`;
export const OPENAI_GATE_NOTE = `OpenAI support is new and has been tested only against simulated responses, so the coordinator refuses OpenAI jobs until the integration's first verified real run (owner flag openaiVerified). Until then, jobs you submit wait and nothing is charged.`;
import type { SectorState } from '../../shared/empire';
import type { QueueState, QueueTask, Usage, UsageState } from '../../shared/protocol';
import type { Snapshot } from './repo';

export type Tone = 'idle' | 'active' | 'attention' | 'unknown';

export const JOB_LABEL: Record<CloudJobStatus, string> = {
  queued: 'Queued',
  dispatching: 'Starting',
  dispatch_uncertain: 'Start uncertain',
  running: 'Running',
  waiting_for_approval: 'Waiting for approval',
  budget_paused: 'Budget reached',
  idle: 'Turn ended',
  unknown: 'Status unknown',
  awaiting_review: 'Ready for review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
export const JOB_TONE: Record<CloudJobStatus, Tone> = {
  queued: 'idle', dispatching: 'active', dispatch_uncertain: 'attention', running: 'active', waiting_for_approval: 'attention',
  budget_paused: 'attention', idle: 'idle', unknown: 'unknown', awaiting_review: 'attention', accepted: 'idle', rejected: 'idle', failed: 'attention', cancelled: 'idle',
};
/** Jobs the user can still cancel: anything not final and not waiting for review. */
export const CANCELLABLE: readonly CloudJobStatus[] = ['queued', 'dispatching', 'dispatch_uncertain', 'running', 'waiting_for_approval', 'budget_paused', 'idle', 'unknown'];

/** Short ages: "40 s", "12 min", "3 h", "2 d". */
export function shortAge(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

export const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** When the coordinator last committed, or (before its first run) when setup wrote the state. */
export function snapshotTime(state: CloudState): { at: number; firstRunPending: boolean } {
  const at = state.heartbeat.lastRunAt;
  return at !== undefined ? { at, firstRunPending: false } : { at: state.meta.createdAt, firstRunPending: true };
}

/** Coordinator commits come at least hourly while running (idle runs skip their commit). Beyond this it is overdue. */
export function overdueAfterMs(state: CloudState): number {
  return (60 + 2 * state.meta.schedule.intervalMinutes) * 60_000;
}

export interface JobCounts { active: number; attention: number; queued: number; review: number }
export function jobCounts(state: CloudState): JobCounts {
  const c: JobCounts = { active: 0, attention: 0, queued: 0, review: 0 };
  for (const job of state.jobs.jobs) {
    if (job.status === 'queued') c.queued++;
    else if (job.status === 'awaiting_review') c.review++;
    else if (JOB_TONE[job.status] === 'attention' || job.status === 'unknown') c.attention++;
    else if (holdsSlot(job)) c.active++;
  }
  return c;
}

export interface CloudStatusInput {
  snapshot: Snapshot | null;
  /** Where the shown snapshot came from: read from GitHub in this session, or saved on this device earlier. */
  source: 'github' | 'saved' | null;
  /** Device clock of the last successful check with GitHub (even an unchanged one). */
  checkedAt?: number;
  error?: { code: string; message: string } | null;
  now: number;
}
export interface CloudStatusView { tone: Tone; label: string; detail: string; age: string; lifecycle: CloudState['meta']['lifecycle']['status'] | 'unknown' }

export function cloudStatus({ snapshot, source, checkedAt, error, now }: CloudStatusInput): CloudStatusView {
  if (!snapshot) {
    if (error) return { tone: 'unknown', label: 'Empire not loaded', detail: error.message, age: '', lifecycle: 'unknown' };
    return { tone: 'unknown', label: 'Loading your Empire', detail: 'Reading the last snapshot from your GitHub state repository…', age: '', lifecycle: 'unknown' };
  }
  const state = snapshot.state;
  const { at, firstRunPending } = snapshotTime(state);
  const age = shortAge(now - at);
  const checked = checkedAt !== undefined ? ` Checked with GitHub ${shortAge(now - checkedAt)} ago.` : '';
  const savedNote = source === 'saved' ? ` Saved on this device ${shortAge(now - snapshot.readAt)} ago; not yet re-read from GitHub.` : '';
  const errorNote = error ? ` ${error.message}` : '';
  const lifecycle = state.meta.lifecycle.status;
  if (lifecycle === 'shutdown')
    return { tone: 'idle', label: 'Empire shut down', detail: `The coordinator is stopped: no runs, no provider spending, no city time. Start it from the menu.${checked}${savedNote}${errorNote}`, age, lifecycle };
  if (lifecycle === 'shutting_down')
    return { tone: 'attention', label: 'Shutting down', detail: `The coordinator is stopping active sessions, then disables itself. Recorded ${age} ago.${checked}${savedNote}${errorNote}`, age, lifecycle };
  if (firstRunPending)
    return { tone: 'idle', label: 'Waiting for first run', detail: `Set up ${age} ago. The coordinator hasn’t committed yet; scheduled runs can be delayed by GitHub.${checked}${savedNote}${errorNote}`, age, lifecycle };
  if (now - at > overdueAfterMs(state))
    return { tone: 'attention', label: 'Coordinator overdue', detail: `Its last commit was ${age} ago (it commits at least hourly while running). GitHub may be delaying scheduled runs, or the workflow is disabled.${checked}${savedNote}${errorNote}`, age, lifecycle };
  return { tone: 'idle', label: `Snapshot ${age} ago`, detail: `Last coordinator commit ${age} ago. Not live: it runs every ${state.meta.schedule.intervalMinutes} minutes or when the app wakes it.${checked}${savedNote}${errorNote}`, age, lifecycle };
}

/** Jobs as tasks on the office queue board. Prompts are only previews; nothing here is live. */
export function toQueue(state: CloudState): QueueState {
  const order = (j: CloudJob) => j.createdAt;
  const tasks: QueueTask[] = [...state.jobs.jobs].sort((a, b) => order(a) - order(b)).map((job) => {
    const finished = ['accepted', 'rejected', 'failed', 'cancelled', 'awaiting_review'].includes(job.status);
    const task: QueueTask = {
      id: job.id,
      title: job.title,
      prompt: job.promptPreview,
      addedBy: 'You (cloud)',
      addedAt: job.createdAt,
      status: job.status === 'queued' ? 'queued' : finished ? 'done' : 'running',
      branch: job.branch,
      ...(job.dispatch ? { startedAt: job.dispatch.preparedAt } : {}),
      ...(finished ? { finishedAt: job.updatedAt, outcome: job.status === 'failed' ? 'failed' : job.status === 'cancelled' ? 'killed' : 'done' } : {}),
      ...(job.status === 'failed' ? { error: job.message } : {}),
    };
    return task;
  });
  return { tasks, maxWorkers: state.meta.limits.maxConcurrent };
}

const zero = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, calls: 0 });
/** Provider spend recorded by the coordinator (USD). "Total" covers the ledger's 90-day window. */
export function toUsage(state: CloudState, now: number): UsageState {
  const day = utcDay(now);
  const today = zero();
  const total = zero();
  today.cost = (state.ledger.days[day]?.observedCostCents ?? 0) / 100;
  total.cost = Object.values(state.ledger.days).reduce((sum, d) => sum + d.observedCostCents, 0) / 100;
  return { total, today, day, budget: state.meta.limits.dailyBudgetCents / 100, pauseHiring: false };
}

/** Real-money admission figures for today (UTC), in cents. */
export function todaySpend(state: CloudState, now: number) {
  const d = state.ledger.days[utcDay(now)];
  // OpenAI estimates are kept apart from provider-reported costs and never added to them (CLOUD-06).
  return { reservedCents: d?.reservedCents ?? 0, observedCents: d?.observedCostCents ?? 0, estimatedCents: d?.estimatedCostCents ?? 0, dailyCents: state.meta.limits.dailyBudgetCents, perJobCents: state.meta.limits.perTaskBudgetCents };
}

const MANAGER: Record<NonNullable<SectorState['manager']>['status'], { tone: Tone; label: string }> = {
  pending: { tone: 'idle', label: 'Startup pending' },
  queued: { tone: 'idle', label: 'Startup queued' },
  working: { tone: 'active', label: 'Startup job running' },
  needs_input: { tone: 'attention', label: 'Needs your input' },
  ready: { tone: 'idle', label: 'Assigned · turn ended' },
  offline: { tone: 'attention', label: 'Offline' },
};
/** A sector manager as last recorded in the snapshot. Never "live". */
export function cloudManagerView(sector: SectorState, snapshotAge: string): { tone: Tone; label: string; detail: string } {
  const m = sector.manager;
  if (!m) return { tone: 'idle', label: 'No manager', detail: 'Build this site to appoint a manager.' };
  const base = MANAGER[m.status] ?? { tone: 'unknown' as Tone, label: 'Status unknown' };
  return { tone: base.tone, label: `Recorded: ${base.label}`, detail: `${m.error ? `${m.error} ` : ''}As of the cloud snapshot ${snapshotAge} ago; not live.` };
}

/** Outcome of an intent once the coordinator consumed it, from processed-intents and the journal. */
export function intentOutcome(state: CloudState, id: string): { outcome: 'applied' | 'rejected' | 'duplicate'; message?: string } | null {
  const done = state.processed.entries.find((e) => e.id === id);
  if (!done) return null;
  const entry = [...state.journal.entries].reverse().find((e) => e.intentId === id);
  return { outcome: done.outcome, ...(entry ? { message: entry.message } : {}) };
}

/**
 * Where jobs stand, from the snapshot: `ready` (execution settings recorded), `setting_up` (the coordinator was asked to
 * find or create the Anthropic agent and environment), `failed` (it tried and recorded why), or `none`. Only `ready`
 * lets a paid job be submitted: the coordinator refuses `new_job` without execution settings, so offering it otherwise
 * would only produce a rejection.
 */
export interface ExecutionStatus { kind: 'ready' | 'setting_up' | 'failed' | 'none'; tone: Tone; label: string; detail: string; canSubmit: boolean }
export function executionStatus(state: CloudState): ExecutionStatus {
  const ex = state.meta.execution;
  const p = state.meta.provisioning;
  if (p) {
    const repo = `${p.repository.owner}/${p.repository.name}`;
    const what = p.provider === 'openai' ? 'the OpenAI vault' : 'the Anthropic agent and environment';
    if (p.status === 'failed')
      return {
        kind: 'failed', tone: 'attention', label: 'Setup needs you', canSubmit: false,
        detail: `Setting up ${what} for ${repo} did not finish: ${p.message ?? 'no reason recorded'}${p.retryable ? ' The coordinator tries again within the hour.' : ' Fix it, then choose “Set up automatically” under Limits.'} New jobs are refused, not charged, until it is ready.`,
      };
    return {
      kind: 'setting_up', tone: 'active', label: 'Being set up', canSubmit: false,
      detail: `${p.provider === 'openai'
        ? `Your coordinator creates (or reuses) an OpenAI vault holding your project GitHub token for ${repo} on its next run; jobs will use ${workerModelLabel(p.model ?? defaultModelFor('openai'))}.`
        : `Your coordinator creates (or reuses) an Anthropic agent with ${workerModelLabel(p.model ?? defaultModelFor('anthropic'))} and a cloud environment for ${repo} on its next run.`} That is not a billed item and starts no session. New jobs are refused, not charged, until it is ready.${ex ? ` When it finishes it replaces the current settings (${ex.repository.owner}/${ex.repository.name}).` : ''}`,
    };
  }
  if (ex?.provider === 'openai')
    return {
      kind: 'ready', tone: 'idle', label: `${ex.repository.owner}/${ex.repository.name}`, canSubmit: true,
      detail: `${PROVIDER_LABELS.openai} on ${ex.repository.baseBranch} with ${workerModelLabel(ex.openai.model)} (unverified until first run), vault ${ex.openai.vaultId}. Costs are estimates, not provider-reported. ${OPENAI_GATE_NOTE} Work arrives as a task branch.`,
    };
  if (ex)
    return {
      kind: 'ready', tone: 'idle', label: `${ex.repository.owner}/${ex.repository.name}`, canSubmit: true,
      detail: `Anthropic Managed Agents (agent ${ex.anthropic.agentId}, environment ${ex.anthropic.environmentId}) on ${ex.repository.baseBranch}. ${state.meta.executionProfile ? `Set up automatically: ${workerModelLabel(state.meta.executionProfile.model)}, ${state.meta.executionProfile.networking} networking. ${SANDBOX_NOTE}` : 'IDs entered by hand: the model and networking are whatever that agent and environment use.'} Work arrives as branches and pull requests.`,
    };
  return {
    kind: 'none', tone: 'attention', label: 'Not set up', canSubmit: false,
    detail: 'No execution settings, so the coordinator refuses new jobs (nothing is charged). Choose “Set up automatically” under Limits with the provider whose key is in your secrets (Anthropic, or OpenAI once it is verified).',
  };
}

export const isReviewable = (job: CloudJob) => job.status === 'awaiting_review';
export const isReviewed = (job: CloudJob) => REVIEW_STATUSES.includes(job.status) && job.status !== 'awaiting_review';
