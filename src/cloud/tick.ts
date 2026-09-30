/**
 * CLOUD-01 coordinator tick.
 *
 * Every phase that decides anything is a pure function of (state, inputs, ctx) with an injected
 * clock and run id. Provider calls happen only between two commits:
 *
 *   read → reconcile stale dispatches → apply intents → poll/stop sessions (provider)
 *        → record outcomes → plan dispatch (reserve budget, mark `dispatching`) → lifecycle → economy
 *        → COMMIT 1 (state + deletion of consumed intents)
 *   → create provider sessions for jobs marked in commit 1 (provider) → optional workflow disable
 *   → COMMIT 2 (session receipts)
 *
 * The dispatch intent is durable before the paid request, so a crashed run leaves `dispatching`,
 * which the next run turns into `dispatch_uncertain` rather than retrying. A commit conflict (a
 * client pushed an intent) re-reads and recomputes from already-fetched provider results; it never
 * repeats a provider side effect.
 */
import { advanceEconomy, applyEmpireAction, MAX_SETTLE_MS, rewardAcceptedJob, syncManagers, syncWorkforce } from './economy.js';
import { intentIdFromPath, parseIntent, sortIntents, IntentError, type CloudIntent } from './intents.js';
import { DispatchFailure, type ProviderAdapter, type ProviderObservation } from './provider.js';
import {
  clone, holdsSlot, LIMITS, parseStateFiles, serializeState, STATE_FILES, utcDay,
  type CloudJob, type CloudState, type EventCursorState, type JournalKind, type SpendEntry,
} from './schema.js';
import { updateWithRetry, type FileChange, type StateSnapshot, type StateStore, type WorkflowControl } from './store.js';

export interface TickContext { now: number; runId: string }

// ---------------------------------------------------------------- small helpers

export function journal(state: CloudState, ctx: TickContext, kind: JournalKind, message: string, ids: { intentId?: string; jobId?: string } = {}) {
  const seq = state.journal.seq + 1;
  state.journal.seq = seq;
  state.journal.entries.push({ seq, at: ctx.now, runId: ctx.runId, kind, message: message.slice(0, 2000), ...ids });
  state.journal.entries = state.journal.entries.slice(-LIMITS.journal);
}
function spend(state: CloudState, entry: SpendEntry) {
  state.ledger.entries.push(entry);
  state.ledger.entries = state.ledger.entries.slice(-LIMITS.spendEntries);
  const day = (state.ledger.days[entry.day] ??= { reservedCents: 0, observedCostCents: 0 });
  if (entry.kind === 'reserved') day.reservedCents += entry.cents;
  if (entry.kind === 'released') day.reservedCents = Math.max(0, day.reservedCents - entry.cents);
  if (entry.kind === 'cost_observed') day.observedCostCents += entry.cents;
  const days = Object.keys(state.ledger.days).sort();
  for (const old of days.slice(0, Math.max(0, days.length - LIMITS.spendDays))) delete state.ledger.days[old];
}
function releaseReservation(state: CloudState, job: CloudJob, now: number) {
  if (!job.reservation) return;
  spend(state, { at: now, jobId: job.id, kind: 'released', cents: job.reservation.cents, day: job.reservation.day, basis: 'per_job_allowance_estimate' });
  delete job.reservation;
}
function setStatus(state: CloudState, ctx: TickContext, job: CloudJob, status: CloudJob['status'], message: string) {
  const changed = job.status !== status;
  job.status = status; job.message = message.slice(0, 2000); job.updatedAt = ctx.now;
  if (changed) journal(state, ctx, 'job', `${job.title}: ${status.replace(/_/g, ' ')}. ${message}`, { jobId: job.id });
}
/** Admission-control totals: the full allowance of every job reserved today or still holding a slot. */
export function reservedToday(state: CloudState, now: number): number {
  const today = utcDay(now);
  return state.jobs.jobs.filter(job => job.reservation && (job.reservation.day === today || holdsSlot(job)))
    .reduce((total, job) => total + Math.max(job.reservation!.cents, job.cost?.amountCents ?? 0), 0);
}

// ---------------------------------------------------------------- phase: stale dispatches

/** A `dispatching` mark left by another run means that run may have sent the paid request. */
export function reconcileStaleDispatches(input: CloudState, ctx: TickContext): CloudState {
  const state = clone(input);
  for (const job of state.jobs.jobs) {
    if (job.status === 'dispatching' && job.dispatch?.runId !== ctx.runId && !job.sessionId) {
      setStatus(state, ctx, job, 'dispatch_uncertain', `Coordinator run ${job.dispatch?.runId ?? 'unknown'} did not record whether the provider accepted this job. It will not be retried. Inspect the provider Console for task ${job.id}, then resolve it.`);
    }
  }
  return state;
}

// ---------------------------------------------------------------- phase: intents

export interface IntentFile { path: string; content: string }
export interface IntentOutcome { path: string; id?: string; kind?: string; outcome: 'applied' | 'rejected' | 'duplicate'; reason?: string }

function settleEconomy(state: CloudState, ctx: TickContext) {
  if (state.meta.lifecycle.status !== 'running') return;
  const from = state.meta.coordinator.economyClockAt ?? ctx.now;
  const elapsed = Math.max(0, ctx.now - from);
  advanceEconomy(state.empire, elapsed, ctx.now);
  if (elapsed > MAX_SETTLE_MS) journal(state, ctx, 'economy', `${Math.round((elapsed - MAX_SETTLE_MS) / 60_000)} minute(s) since the previous coordinator run were not settled; missed schedules earn no catch-up revenue.`);
  state.meta.coordinator.economyClockAt = ctx.now;
}

function applyOne(state: CloudState, intent: CloudIntent, ctx: TickContext): { outcome: 'applied' | 'duplicate' } {
  const reject = (code: string, message: string): never => { throw new IntentError(code, message); };
  const findJob = (id: string) => state.jobs.jobs.find(job => job.id === id) ?? reject('job_not_found', 'No such cloud job.');
  const meta = state.meta;
  switch (intent.kind) {
    case 'new_job': {
      const input = intent.job;
      const existing = state.jobs.jobs.find(job => job.id === input.id);
      if (existing) {
        if (existing.prompt === input.prompt && existing.title === input.title) return { outcome: 'duplicate' };
        reject('task_id_conflict', 'That job ID already belongs to a different submission. Never replace an uncertain job with a new ID.');
      }
      if (input.configRevision !== meta.configRevision) reject('setup_changed', 'Limits or execution settings changed after this job was confirmed. Review the current limits and submit again.');
      if (!meta.execution) reject('execution_not_configured', 'Cloud execution is not configured for this Empire.');
      if (state.jobs.jobs.length >= LIMITS.jobs) reject('job_capacity', 'The retained job history is full.');
      const execution = meta.execution!;
      state.jobs.jobs.push({
        id: input.id, title: input.title, prompt: input.prompt, ...(input.site ? { site: input.site } : {}), intentId: intent.id,
        createdAt: ctx.now, updatedAt: ctx.now, configRevision: input.configRevision, authorizedCents: meta.limits.perTaskBudgetCents,
        status: 'queued', message: meta.lifecycle.status === 'running' ? 'Queued. The coordinator dispatches within your concurrency and daily limits.' : 'Queued while the Empire is shut down. Nothing is dispatched until you start it again.',
        provider: 'anthropic', repository: clone(execution.repository), branch: `agent-empire/task-${input.id}`, outputs: 'unverified',
      });
      journal(state, ctx, 'job', `${input.title}: queued (allowance ${meta.limits.perTaskBudgetCents} cents, estimate).`, { intentId: intent.id, jobId: input.id });
      return { outcome: 'applied' };
    }
    case 'review': {
      const job = findJob(intent.jobId);
      if (job.status !== 'awaiting_review') reject('not_reviewable', 'Only a finished turn awaiting review can be accepted or rejected.');
      job.review = { decision: intent.decision === 'accept' ? 'accepted' : 'rejected', at: ctx.now, intentId: intent.id, ...(intent.note ? { note: intent.note } : {}) };
      if (intent.decision === 'accept') {
        setStatus(state, ctx, job, 'accepted', 'Accepted by the user. Acceptance is a review decision, not automated verification of code or a pull request.');
        if (rewardAcceptedJob(state.empire, job, ctx.now)) job.rewarded = true;
      } else setStatus(state, ctx, job, 'rejected', 'Rejected by the user. No city reward.');
      return { outcome: 'applied' };
    }
    case 'cancel': {
      const job = findJob(intent.jobId);
      if (job.status === 'queued') { setStatus(state, ctx, job, 'cancelled', 'Cancelled before dispatch; no provider session was requested.'); return { outcome: 'applied' }; }
      if (holdsSlot(job) && job.sessionId) {
        if (!job.stopRequested) job.stopRequested = { at: ctx.now, reason: 'cancel' };
        job.message = 'Cancellation requested. The coordinator interrupts and archives the session; the slot and reservation stay held until the provider confirms.';
        journal(state, ctx, 'job', `${job.title}: cancellation requested.`, { intentId: intent.id, jobId: job.id });
        return { outcome: 'applied' };
      }
      if (holdsSlot(job)) reject('dispatch_unresolved', 'No provider session ID is confirmed for this job. Inspect the provider Console, then resolve the uncertain dispatch.');
      return reject('already_finished', 'This job has already finished.');
    }
    case 'resolve_uncertain': {
      const job = findJob(intent.jobId);
      if (job.sessionId || !['dispatch_uncertain', 'unknown'].includes(job.status)) reject('not_uncertain', 'Only an uncertain dispatch without a session ID can be resolved.');
      if (intent.resolution === 'not_dispatched') {
        releaseReservation(state, job, ctx.now);
        setStatus(state, ctx, job, 'failed', 'You confirmed the provider never created a session. Its reservation was released; submit a new job to try again.');
      } else {
        if (state.jobs.jobs.some(other => other.sessionId === intent.sessionId)) reject('session_in_use', 'That provider session is already linked to another job.');
        job.sessionId = intent.sessionId; job.cursor = {};
        setStatus(state, ctx, job, 'unknown', 'Provider session attached by the user. The next poll confirms its state and budget.');
      }
      return { outcome: 'applied' };
    }
    case 'shutdown': {
      if (meta.lifecycle.status !== 'running') return { outcome: 'duplicate' };
      settleEconomy(state, ctx); // Close the books up to now; nothing accrues while shut down.
      meta.lifecycle = { status: 'shutting_down', changedAt: ctx.now, workflow: meta.lifecycle.workflow };
      for (const job of state.jobs.jobs) {
        if (holdsSlot(job) && job.sessionId && !job.stopRequested) job.stopRequested = { at: ctx.now, reason: 'shutdown' };
      }
      journal(state, ctx, 'lifecycle', 'Shutdown requested. Active provider sessions are being interrupted and archived; nothing new will be dispatched.', { intentId: intent.id });
      return { outcome: 'applied' };
    }
    case 'start': {
      if (meta.lifecycle.status === 'running' && meta.lifecycle.workflow === 'enabled') return { outcome: 'duplicate' };
      const wasDown = meta.lifecycle.status !== 'running';
      meta.lifecycle = { status: 'running', changedAt: ctx.now, workflow: 'enabled' };
      if (wasDown) meta.coordinator.economyClockAt = ctx.now;
      journal(state, ctx, 'lifecycle', wasDown ? 'Empire started. Time while shut down earned no revenue.' : 'Coordinator workflow marked enabled.', { intentId: intent.id });
      return { outcome: 'applied' };
    }
    case 'limits': {
      if (intent.configRevision !== meta.configRevision) reject('setup_changed', 'Settings changed since you opened them. Review the current limits and try again.');
      meta.limits = intent.limits; meta.configRevision++;
      journal(state, ctx, 'limits', `Limits changed: ${intent.limits.maxConcurrent} concurrent, ${intent.limits.perTaskBudgetCents} cents per job, ${intent.limits.dailyBudgetCents} cents per UTC day (admission limits, not billing caps).`, { intentId: intent.id });
      return { outcome: 'applied' };
    }
    case 'configure': {
      if (intent.configRevision !== meta.configRevision) reject('setup_changed', 'Settings changed since you opened them. Review and try again.');
      if (state.jobs.jobs.some(job => job.status === 'queued' || holdsSlot(job))) reject('active_cloud_jobs', 'Cancel or finish queued and active jobs before changing the repository or provider references.');
      meta.execution = intent.execution; meta.configRevision++;
      journal(state, ctx, 'limits', `Execution set to ${intent.execution.repository.owner}/${intent.execution.repository.name} (${intent.execution.repository.baseBranch}) on Anthropic Managed Agents.`, { intentId: intent.id });
      return { outcome: 'applied' };
    }
    case 'empire_action': {
      const error = applyEmpireAction(state.empire, intent.action, ctx.now);
      if (error) reject('city_action_rejected', error);
      journal(state, ctx, 'intent_applied', `City action ${intent.action.kind} applied.`, { intentId: intent.id });
      return { outcome: 'applied' };
    }
  }
}

/** Each intent is consumed exactly once: applied, recorded as a duplicate, or rejected with a reason. */
export function applyIntents(input: CloudState, files: IntentFile[], ctx: TickContext): { state: CloudState; consumed: string[]; outcomes: IntentOutcome[] } {
  const state = clone(input);
  const processed = new Set(state.meta.processedIntents.map(item => item.id));
  const parsed = sortIntents(files.map(file => {
    try { return { path: file.path, intent: parseIntent(file.path, file.content) as CloudIntent | undefined, error: undefined as IntentError | undefined }; }
    catch (error) { return { path: file.path, intent: undefined, error: error instanceof IntentError ? error : new IntentError('invalid_intent', 'Unreadable intent.') }; }
  }));
  const outcomes: IntentOutcome[] = [];
  const record = (id: string, outcome: IntentOutcome['outcome'], kind?: string) => {
    processed.add(id);
    state.meta.processedIntents.push({ id, at: ctx.now, outcome, ...(kind ? { kind } : {}) });
    state.meta.processedIntents = state.meta.processedIntents.slice(-LIMITS.processedIntents);
  };
  for (const item of parsed) {
    const id = item.intent?.id ?? intentIdFromPath(item.path)?.toLowerCase();
    if (id && processed.has(id)) { outcomes.push({ path: item.path, id, kind: item.intent?.kind, outcome: 'duplicate' }); continue; }
    if (!item.intent) {
      const reason = item.error!.message;
      if (id) record(id, 'rejected');
      journal(state, ctx, 'intent_rejected', `Intent ${id ?? item.path.slice(0, 100)} rejected: ${reason}`, id ? { intentId: id } : {});
      outcomes.push({ path: item.path, id, outcome: 'rejected', reason });
      continue;
    }
    const intent = item.intent;
    // Apply against a scratch copy so a rejected intent leaves no partial change behind.
    const scratch = clone(state);
    try {
      const { outcome } = applyOne(scratch, intent, ctx);
      Object.assign(state, scratch);
      record(intent.id, outcome, intent.kind);
      outcomes.push({ path: item.path, id: intent.id, kind: intent.kind, outcome });
    } catch (error) {
      const reason = error instanceof IntentError ? error.message : 'The intent could not be applied.';
      record(intent.id, 'rejected', intent.kind);
      journal(state, ctx, 'intent_rejected', `${intent.kind} intent rejected: ${reason}`, { intentId: intent.id, ...('jobId' in intent ? { jobId: intent.jobId } : {}) });
      outcomes.push({ path: item.path, id: intent.id, kind: intent.kind, outcome: 'rejected', reason });
    }
  }
  return { state, consumed: parsed.map(item => item.path), outcomes };
}

// ---------------------------------------------------------------- phase: provider sessions

export interface ProviderTask { jobId: string; sessionId: string; cursor: EventCursorState; mode: 'observe' | 'stop' }
export interface ProviderResult {
  jobId: string; sessionId: string; mode: ProviderTask['mode'];
  observation?: ProviderObservation; cursor?: EventCursorState;
  /** The coordinator saw a finished turn (idle, end_turn) this tick. */
  turnEnded?: boolean;
  error?: string;
}

export function collectProviderWork(state: CloudState): ProviderTask[] {
  return state.jobs.jobs.filter(job => job.sessionId && holdsSlot(job))
    .map(job => ({ jobId: job.id, sessionId: job.sessionId!, cursor: clone(job.cursor ?? {}), mode: job.stopRequested ? 'stop' as const : 'observe' as const }));
}

const safeMessage = (error: unknown) => (error instanceof Error && error.name === 'ExecutionError') || error instanceof DispatchFailure
  ? (error as Error).message : 'The provider request failed. No upstream details are exposed.';

/** Side effects only here: GET status/events; interrupt/archive for stop requests and finished turns. */
export async function performProviderWork(tasks: ProviderTask[], provider: ProviderAdapter): Promise<ProviderResult[]> {
  const results: ProviderResult[] = [];
  for (const task of tasks) {
    const result: ProviderResult = { jobId: task.jobId, sessionId: task.sessionId, mode: task.mode };
    try {
      let seen = await provider.observe(task.sessionId, task.cursor);
      result.observation = seen.observation; result.cursor = seen.cursor;
      const turnEnded = seen.observation.status === 'idle' && !seen.cursor.page && seen.cursor.stopReason === 'end_turn';
      if (turnEnded) result.turnEnded = true;
      if (task.mode === 'stop' && (seen.observation.providerStatus === 'running' || seen.observation.providerStatus === 'rescheduling')) {
        await provider.interrupt(task.sessionId);
        seen = await provider.observe(task.sessionId, seen.cursor);
        result.observation = seen.observation; result.cursor = seen.cursor;
      }
      // A finished turn is archived to release its slot; the branch/PR is the output and stays unverified.
      if ((task.mode === 'stop' || turnEnded) && seen.observation.providerStatus === 'idle') {
        await provider.archive(task.sessionId);
        seen = await provider.observe(task.sessionId, seen.cursor);
        result.observation = seen.observation; result.cursor = seen.cursor;
      }
    } catch (error) {
      result.error = safeMessage(error);
    }
    results.push(result);
  }
  return results;
}

function applyObservation(state: CloudState, ctx: TickContext, job: CloudJob, observation: ProviderObservation, cursor: EventCursorState | undefined, turnEnded: boolean) {
  job.sessionId = observation.sessionId;
  job.providerStatus = observation.providerStatus;
  if (cursor) job.cursor = cursor;
  if (observation.costCents !== undefined) {
    const previous = job.cost?.amountCents ?? 0;
    const amount = Math.max(previous, observation.costCents);
    if (amount > previous) spend(state, { at: ctx.now, jobId: job.id, kind: 'cost_observed', cents: amount - previous, day: utcDay(ctx.now), basis: 'provider_reported_list_cost' });
    job.cost = { amountCents: amount, currency: 'USD', observedAt: ctx.now, basis: 'provider_reported_list_cost' };
  }
  if (turnEnded && !job.stopRequested) job.stopRequested = { at: ctx.now, reason: 'turn_ended' };
  const reason = job.stopRequested?.reason;
  let status: CloudJob['status']; let message = observation.message;
  if (observation.status === 'cancelled') {
    // Archived. A finished turn becomes reviewable; a cancel/shutdown stays cancelled.
    status = reason === 'turn_ended' ? 'awaiting_review' : 'cancelled';
    message = status === 'awaiting_review'
      ? 'The agent finished its turn and the session was archived to release its slot. The branch or pull request is unverified: review it, then accept or reject.'
      : 'Provider session archived after your stop request. Outputs remain unverified.';
  } else if (observation.status === 'failed') status = 'failed';
  else if (observation.status === 'idle') {
    job.stopReason = cursor?.page ? job.stopReason : (cursor?.stopReason ?? 'unknown');
    if (job.stopReason === 'requires_action') { status = 'waiting_for_approval'; message = 'Provider is waiting for tool approval or a tool result. Resolve it in provider controls; the coordinator never approves automatically.'; }
    else if (job.stopReason === 'budget_reached') { status = 'budget_paused'; message = 'Provider paused at the session budget. The coordinator will not raise the budget or resume paid work.'; }
    else if (reason === 'turn_ended') { status = 'idle'; message = 'The agent finished its turn; archiving to release the slot did not complete and will be retried next run.'; }
    else if (reason) { status = 'idle'; message = 'Stop requested; archival is not yet confirmed and will be retried next run. The slot and reservation stay held.'; }
    else { status = 'idle'; message = `Provider session is idle (stop reason ${job.stopReason}). Review it in provider controls; its slot stays held.`; }
  } else if (observation.status === 'running') status = 'running';
  else status = 'unknown';
  const slotStatus = ['running', 'idle', 'waiting_for_approval', 'budget_paused', 'unknown'].includes(status);
  if (slotStatus && job.reservation && observation.budgetCents !== job.reservation.cents) {
    status = 'unknown';
    message = 'The provider did not confirm the reserved session budget. The reservation is kept; review or stop this session in provider controls.';
  }
  if (!slotStatus) delete job.stopRequested;
  setStatus(state, ctx, job, status, message);
}

/** Records poll/stop results for jobs whose session identity has not changed meanwhile. */
export function recordObservations(input: CloudState, results: ProviderResult[], ctx: TickContext): CloudState {
  const state = clone(input);
  for (const result of results) {
    const job = state.jobs.jobs.find(item => item.id === result.jobId);
    if (!job || job.sessionId !== result.sessionId || !holdsSlot(job)) continue;
    if (!result.observation) {
      job.status = 'unknown'; job.updatedAt = ctx.now;
      job.message = `${result.error ?? 'Provider state could not be read.'} Last-known session identity and reservations were kept.`;
      continue;
    }
    applyObservation(state, ctx, job, result.observation, result.cursor, !!result.turnEnded);
  }
  return state;
}

// ---------------------------------------------------------------- phase: dispatch planning

/** FIFO admission within concurrency and daily limits. Marks jobs `dispatching` with a full reservation. */
export function planDispatch(input: CloudState, ctx: TickContext, canDispatch: boolean): { state: CloudState; planned: string[] } {
  const state = clone(input);
  const planned: string[] = [];
  const queued = state.jobs.jobs.filter(job => job.status === 'queued').sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (!queued.length) return { state, planned };
  const wait = (job: CloudJob, message: string) => { if (job.message !== message) { job.message = message; job.updatedAt = ctx.now; } };
  const { meta } = state;
  if (meta.lifecycle.status !== 'running') { queued.forEach(job => wait(job, 'Queued while the Empire is shut down. Nothing is dispatched until you start it again.')); return { state, planned }; }
  if (!meta.execution) { queued.forEach(job => wait(job, 'Waiting: cloud execution is not configured.')); return { state, planned }; }
  if (!canDispatch) { queued.forEach(job => wait(job, 'Waiting: the provider API key or project GitHub token is missing from the state repository secrets.')); return { state, planned }; }
  let active = state.jobs.jobs.filter(holdsSlot).length;
  let reserved = reservedToday(state, ctx.now);
  for (const job of queued) {
    if (active >= meta.limits.maxConcurrent) { wait(job, `Waiting for a free slot (${meta.limits.maxConcurrent} concurrent).`); continue; }
    const cents = Math.min(meta.limits.perTaskBudgetCents, job.authorizedCents);
    if (reserved + cents > meta.limits.dailyBudgetCents) { wait(job, 'Waiting: today\'s allowance is fully reserved (UTC day). This is an admission limit, not a billing meter.'); continue; }
    const day = utcDay(ctx.now);
    job.reservation = { cents, day, basis: 'per_job_allowance_estimate' };
    job.dispatch = { runId: ctx.runId, preparedAt: ctx.now, attempts: (job.dispatch?.attempts ?? 0) + 1 };
    spend(state, { at: ctx.now, jobId: job.id, kind: 'reserved', cents, day, basis: 'per_job_allowance_estimate' });
    setStatus(state, ctx, job, 'dispatching', `Dispatch recorded before the paid request (reserved ${cents} cents, estimate). If this run stops, the job becomes dispatch uncertain and is never retried blindly.`);
    active++; reserved += cents; planned.push(job.id);
  }
  return { state, planned };
}

// ---------------------------------------------------------------- phase: dispatch receipts

export type DispatchResult = { jobId: string; sourceCommit: string; observation: ProviderObservation } | { jobId: string; failure: { sent: boolean; message: string } };
export const MAX_DISPATCH_ATTEMPTS = 3;

export function recordDispatches(input: CloudState, results: DispatchResult[], ctx: TickContext): CloudState {
  const state = clone(input);
  for (const result of results) {
    const job = state.jobs.jobs.find(item => item.id === result.jobId);
    if (!job || job.dispatch?.runId !== ctx.runId || job.sessionId || !['dispatching', 'dispatch_uncertain'].includes(job.status)) continue;
    if ('failure' in result) {
      if (result.failure.sent) { setStatus(state, ctx, job, 'dispatch_uncertain', `${result.failure.message} It will not be retried.`); continue; }
      releaseReservation(state, job, ctx.now);
      if ((job.dispatch?.attempts ?? 0) >= MAX_DISPATCH_ATTEMPTS) setStatus(state, ctx, job, 'failed', `${result.failure.message} Gave up after ${MAX_DISPATCH_ATTEMPTS} attempts; no paid session was requested.`);
      else setStatus(state, ctx, job, 'queued', `${result.failure.message} Requeued; the reservation was released.`);
      continue;
    }
    if (state.jobs.jobs.some(other => other !== job && other.sessionId === result.observation.sessionId)) {
      setStatus(state, ctx, job, 'dispatch_uncertain', 'The provider returned a session already linked to another job. Inspect the provider Console.');
      continue;
    }
    job.sourceCommit = result.sourceCommit;
    job.cursor = {};
    journal(state, ctx, 'dispatch', `${job.title}: provider session ${result.observation.sessionId} created from ${result.sourceCommit.slice(0, 12)} on branch ${job.branch}.`, { jobId: job.id });
    applyObservation(state, ctx, job, result.observation, undefined, false);
  }
  return state;
}

// ---------------------------------------------------------------- phase: lifecycle + economy

/** Shutdown completes once no known session still needs stopping. Returns whether to disable the workflow. */
export function lifecycleStep(state: CloudState, ctx: TickContext): { disableWorkflow: boolean } {
  const meta = state.meta;
  if (meta.lifecycle.status === 'shutting_down') {
    const stopping = state.jobs.jobs.filter(job => holdsSlot(job) && job.sessionId);
    if (!stopping.length) {
      meta.lifecycle = { status: 'shutdown', changedAt: ctx.now, workflow: meta.lifecycle.workflow === 'disabled' ? 'disabled' : 'disable_requested' };
      const unresolved = state.jobs.jobs.filter(job => holdsSlot(job) && !job.sessionId);
      journal(state, ctx, 'lifecycle', `Empire shut down. State recorded; the coordinator workflow will be disabled.${unresolved.length ? ` ${unresolved.length} uncertain dispatch(es) have no session ID and could not be stopped; check the provider Console.` : ''}`);
    }
  }
  return { disableWorkflow: meta.lifecycle.status === 'shutdown' && meta.lifecycle.workflow === 'disable_requested' };
}

export function economyStep(state: CloudState, ctx: TickContext) {
  settleEconomy(state, ctx);
  syncManagers(state.empire, state.jobs.jobs, ctx.now);
  syncWorkforce(state.empire, state.jobs.jobs);
  state.empire.updatedAt = ctx.now;
}

// ---------------------------------------------------------------- orchestration

export function stateChanges(state: CloudState, snapshot: StateSnapshot, consumedIntents: string[] = []): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, content] of Object.entries(serializeState(state))) if (snapshot.files[path] !== content) changes.push({ path, content });
  for (const path of consumedIntents) if (snapshot.files[path] !== undefined) changes.push({ path, content: null });
  return changes;
}
const stateFilesOf = (snapshot: StateSnapshot) => Object.fromEntries(Object.entries(snapshot.files).filter(([path]) => !path.startsWith('intents/')));
const intentFilesOf = (snapshot: StateSnapshot): IntentFile[] => Object.entries(snapshot.files).filter(([path]) => path.startsWith('intents/')).map(([path, content]) => ({ path, content }));
function stamp(state: CloudState, ctx: TickContext) {
  state.meta.revision++;
  state.meta.coordinator.lastRunId = ctx.runId;
  state.meta.coordinator.lastRunAt = ctx.now;
}

export interface CoordinatorDeps {
  store: StateStore & Partial<WorkflowControl>;
  provider: ProviderAdapter;
  now: () => number;
  runId: string;
  /** The workflow grants `actions: write`, so the coordinator may disable itself on shutdown. */
  allowSelfDisable?: boolean;
  maxCommitAttempts?: number;
  log?: (line: string) => void;
}
export interface TickReport {
  runId: string;
  revision: number;
  intents: IntentOutcome[];
  observed: number;
  dispatched: { jobId: string; outcome: 'session' | 'uncertain' | 'requeued' | 'failed' }[];
  lifecycle: CloudState['meta']['lifecycle'];
  migrated: string[];
  commits: number;
  intentsTruncated: boolean;
}

export async function runCoordinatorTick(deps: CoordinatorDeps): Promise<TickReport> {
  const log = deps.log ?? (() => {});
  const ctx1: TickContext = { now: deps.now(), runId: deps.runId };
  let providerResults: ProviderResult[] | undefined;
  let migrated: string[] = [];
  let commits = 0;

  const phase1 = await updateWithRetry(deps.store, async snapshot => {
    const parsed = parseStateFiles(stateFilesOf(snapshot), ctx1.now);
    migrated = parsed.migrated;
    let state = reconcileStaleDispatches(parsed.state, ctx1);
    const intents = applyIntents(state, intentFilesOf(snapshot), ctx1);
    state = intents.state;
    // Provider side effects run once per tick; a commit retry reuses these results.
    providerResults ??= await performProviderWork(collectProviderWork(state), deps.provider);
    state = recordObservations(state, providerResults, ctx1);
    const plan = planDispatch(state, ctx1, deps.provider.canDispatch);
    state = plan.state;
    const lifecycle = lifecycleStep(state, ctx1);
    economyStep(state, ctx1);
    stamp(state, ctx1);
    const accepted = intents.outcomes.filter(item => item.outcome === 'applied').length;
    return {
      changes: stateChanges(state, snapshot, intents.consumed),
      message: `Agent Empire coordinator ${ctx1.runId}: ${intents.outcomes.length} intent(s), ${accepted} applied, ${plan.planned.length} to dispatch`,
      value: { state, planned: plan.planned, outcomes: intents.outcomes, disableWorkflow: lifecycle.disableWorkflow, truncated: snapshot.intentsTruncated },
    };
  }, deps.maxCommitAttempts);
  commits++;
  let state = phase1.value.state;
  log(`commit 1 ${phase1.sha.slice(0, 12)} after ${phase1.attempts} attempt(s): ${phase1.value.outcomes.length} intent(s), ${providerResults?.length ?? 0} session(s) observed, ${phase1.value.planned.length} planned`);

  const dispatchResults: DispatchResult[] = [];
  for (const jobId of phase1.value.planned) {
    const job = state.jobs.jobs.find(item => item.id === jobId)!;
    try {
      const created = await deps.provider.dispatch({ jobId, prompt: job.prompt, branch: job.branch, budgetCents: job.reservation!.cents, execution: state.meta.execution! });
      dispatchResults.push({ jobId, ...created });
    } catch (error) {
      // Anything other than a proven not-sent failure may have created a paid session.
      dispatchResults.push({ jobId, failure: error instanceof DispatchFailure ? { sent: error.sent, message: error.message } : { sent: true, message: 'The provider request failed in an unexpected way; the session may have been accepted.' } });
    }
  }

  let workflowDisabled = false;
  if (phase1.value.disableWorkflow) {
    if (deps.allowSelfDisable && deps.store.setWorkflowEnabled) {
      try { await deps.store.setWorkflowEnabled(false); workflowDisabled = true; }
      catch (error) { log(`workflow disable failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
    }
  }

  if (dispatchResults.length || phase1.value.disableWorkflow) {
    const ctx2: TickContext = { now: deps.now(), runId: deps.runId };
    try {
      const phase2 = await updateWithRetry(deps.store, snapshot => {
        let next = parseStateFiles(stateFilesOf(snapshot), ctx2.now).state;
        next = recordDispatches(next, dispatchResults, ctx2);
        if (phase1.value.disableWorkflow && next.meta.lifecycle.status === 'shutdown' && next.meta.lifecycle.workflow === 'disable_requested') {
          if (workflowDisabled) { next.meta.lifecycle.workflow = 'disabled'; journal(next, ctx2, 'lifecycle', 'Coordinator workflow disabled. Start the Empire from the app to re-enable it.'); }
          else journal(next, ctx2, 'warning', 'The coordinator could not disable its own workflow. The app disables it with your GitHub sign-in; scheduled runs do nothing while shut down.');
        }
        stamp(next, ctx2);
        return { changes: stateChanges(next, snapshot), message: `Agent Empire coordinator ${ctx2.runId}: ${dispatchResults.length} dispatch receipt(s)`, value: next };
      }, deps.maxCommitAttempts);
      commits++;
      state = phase2.value;
      log(`commit 2 ${phase2.sha.slice(0, 12)} after ${phase2.attempts} attempt(s)`);
    } catch (error) {
      // Receipts could not be saved: print session IDs so the Actions log preserves them.
      for (const result of dispatchResults) log(`UNSAVED dispatch receipt job=${result.jobId} ${'observation' in result ? `session=${result.observation.sessionId}` : `failure sent=${result.failure.sent}`}`);
      throw error;
    }
  }

  return {
    runId: deps.runId,
    revision: state.meta.revision,
    intents: phase1.value.outcomes,
    observed: providerResults?.length ?? 0,
    dispatched: dispatchResults.map(result => ({
      jobId: result.jobId,
      outcome: 'observation' in result ? 'session' : result.failure.sent ? 'uncertain' : state.jobs.jobs.find(job => job.id === result.jobId)?.status === 'failed' ? 'failed' : 'requeued',
    })),
    lifecycle: state.meta.lifecycle,
    migrated,
    commits,
    intentsTruncated: phase1.value.truncated,
  };
}

export { STATE_FILES };
