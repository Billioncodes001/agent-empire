/**
 * CLOUD-01 coordinator tick.
 *
 * Every phase that decides anything is a pure function of (state, inputs, ctx) with an injected
 * clock and run id. Provider calls happen only around two commits:
 *
 *   read → reconcile stale dispatches → apply intents → OBSERVE sessions (read-only provider GETs,
 *        plus a read-only task-branch check for finished turns) → record outcomes → plan dispatch
 *        (reserve budget, mark `dispatching`) → lifecycle → economy → compact
 *        → COMMIT 1 (state + deletion of consumed intents)          [skipped when nothing changed,
 *                                                                     except an hourly heartbeat]
 *   → STOP sessions marked in state (interrupt/archive) and CREATE sessions marked `dispatching`
 *   → optional workflow disable → COMMIT 2 (receipts)
 *
 * Every mutating provider call acts only on intentions already durable in the state branch: a stop
 * or an archive of a finished turn is committed before it is sent, and a dispatch is committed as
 * `dispatching` before the paid request. A crashed run therefore leaves `dispatching` (turned into
 * `dispatch_uncertain` next run) or a pending stop (retried next run), never an unexplained change.
 * A commit conflict re-reads and recomputes from already-fetched provider results; it never repeats
 * a provider call.
 */
import { advanceEconomy, applyEmpireAction, rewardAcceptedJob, settleCapMs, syncManagers, syncWorkforce } from './economy.js';
import { intentIdFromPath, parseIntent, sortIntents, IntentError, type CloudIntent } from './intents.js';
import { DispatchFailure, ProvisionError, type ProviderAdapter, type ProviderObservation, type ProvisionResult } from './provider.js';
import { SITES, type SiteId } from '../shared/empire.js';
import { addResearch, checkOrg, ORG_FILE, cloudResearchPrompt, decideApproval, OrgRuleError, proposeLesson, recordResearch, researchDue, researchPath, researchTitle, retireLesson, type BranchFile } from './org.js';
import { isMoneyEngine } from './actions-spec.js';
import { BRAIN_FILE, BrainRuleError, applyBrainSettings, chargeBrain, queueBrainRequest, recordBrainResults, trustedClock, type BrainResult, type PlannedCall } from './brain.js';
import { OUTREACH_FILE, OutreachRuleError, RECEIPT_RE, addCampaign, addLeads, applyCampaignDecision, applyOutreachSettings, cancelCampaign, checkCampaignDecision, claimSends, consumeReceipts, deleteLeadData, reconcileCampaigns, suppress } from './outreach.js';
import { DEFAULT_WORKER_MODEL, WORKER_ENVIRONMENT, workerModelLabel } from './worker-spec.js';
import {
  clone, PROVISION_RETRY_MS, FINAL_STATUSES, holdsSlot, LIMITS, parseStateFiles, promptHash, promptPreview, PROMPT_STATUSES, REVIEW_STATUSES, serializeState, sessionLive, SLOT_STATUSES, STATE_FILES, utcDay,
  type CloudJob, type CloudState, type EventCursorState, type JournalKind, type SpendEntry, type StopReason,
} from './schema.js';
import { updateWithRetry, type FileChange, type RetryOptions, type StateSnapshot, type StateStore, type WorkflowControl } from './store.js';

export interface TickContext { now: number; runId: string }
/** FREE-11: one call to the chief's model (an OpenAI-compatible API with the user's own key). Tests inject a fake. */
export type BrainCaller = (call: { provider: import('./brain.js').BrainProvider; model: string; messages: { role: 'system' | 'user' | 'assistant'; content: string }[]; maxTokens: number }) => Promise<{ text: string; model?: string; usage: { input: number; output: number } }>;

/** FREE-07: at most this many research reports are read per run (read-only GitHub calls with the project token). */
export const RESEARCH_READS_PER_TICK = 5;
/** Intents that change state/org.json; their result must pass checkOrg before it is kept. */
const ORG_INTENTS = new Set<string>(['approval_decision', 'lesson_propose', 'lesson_retire', 'research', 'outreach_suppress', 'outreach_cancel', 'outreach_delete_leads']);
/** FREE-11/12: outreach intents can change the inbox too, so their result must pass checkOrg. */
const OUTREACH_INTENTS = new Set<string>(['outreach_settings', 'outreach_leads', 'outreach_suppress', 'outreach_campaign', 'outreach_cancel', 'outreach_delete_leads']);
/**
 * Reads finished research reports from their task branches (read-only). A provider that cannot read branch files gives
 * `unsupported`; a failed read gives `unknown` and is retried next run. Never sends model text anywhere.
 */
export async function readResearchReports(due: { jobId: string; branch: string }[], provider: ProviderAdapter, state: CloudState): Promise<Record<string, BranchFile>> {
  const out: Record<string, BranchFile> = {};
  for (const item of due.slice(0, RESEARCH_READS_PER_TICK)) {
    const job = state.jobs.jobs.find(j => j.id === item.jobId);
    const execution = state.meta.execution;
    if (!job || !execution || !provider.readBranchFile) { out[item.jobId] = { state: 'unsupported' }; continue; }
    try { out[item.jobId] = await provider.readBranchFile({ ...execution, repository: clone(job.repository) } as typeof execution, item.branch, researchPath(item.jobId)); }
    catch { out[item.jobId] = { state: 'unknown', reason: 'GitHub could not be read with the project token' }; }
  }
  return out;
}
export const HEARTBEAT_MS = 60 * 60_000;

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
  if (entry.kind === 'cost_estimated') day.estimatedCostCents = (day.estimatedCostCents ?? 0) + entry.cents;
  const days = Object.keys(state.ledger.days).sort();
  for (const old of days.slice(0, Math.max(0, days.length - LIMITS.spendDays))) delete state.ledger.days[old];
}
function releaseReservation(state: CloudState, job: CloudJob, now: number) {
  if (!job.reservation) return;
  // A run-caps reservation (free and subscription GitHub Actions runs) holds no money and never entered the ledger.
  if (job.reservation.basis === 'run_caps') { delete job.reservation; return; }
  spend(state, { at: now, jobId: job.id, kind: 'released', cents: job.reservation.cents, day: job.reservation.day, basis: 'per_job_allowance_estimate' });
  delete job.reservation;
}
function setStatus(state: CloudState, ctx: TickContext, job: CloudJob, status: CloudJob['status'], message: string) {
  const changed = job.status !== status;
  const text = message.slice(0, 2000);
  if (changed || job.message !== text) job.updatedAt = ctx.now; // an unchanged observation must not force a commit
  job.status = status; job.message = text;
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

/** A readable intent file, or one the store could not read (with the reason). */
export interface IntentFile { path: string; content?: string; unreadable?: string }
export interface IntentOutcome { path: string; id?: string; kind?: string; outcome: 'applied' | 'rejected' | 'duplicate'; reason?: string }

function settleEconomy(state: CloudState, ctx: TickContext) {
  if (state.meta.lifecycle.status !== 'running') return;
  const from = state.meta.coordinator.economyClockAt ?? ctx.now;
  const elapsed = Math.max(0, ctx.now - from);
  const cap = settleCapMs(state.meta.schedule.intervalMinutes);
  advanceEconomy(state.empire, elapsed, ctx.now, cap);
  if (elapsed > cap) journal(state, ctx, 'economy', `${Math.round((elapsed - cap) / 60_000)} minute(s) since the previous settlement were not counted; missed schedules earn no catch-up revenue.`);
  state.meta.coordinator.economyClockAt = ctx.now;
}

function applyOne(state: CloudState, intent: CloudIntent, ctx: TickContext): { outcome: 'applied' | 'duplicate' } {
  const reject = (code: string, message: string): never => { throw new IntentError(code, message); };
  const findJob = (id: string) => state.jobs.jobs.find(job => job.id === id) ?? reject('job_not_found', 'No such cloud job in the current job list (finished jobs are archived after 14 days).');
  const meta = state.meta;
  // Paid work: a new job, or a research question (FREE-07) on exactly the same checks, limits and confirmation.
  const queueJob = (input: { id: string; title: string; prompt: string; site?: SiteId; configRevision: number }): { outcome: 'applied' | 'duplicate' } => {
      const hash = promptHash(input.prompt);
      // A job id that already reached the archive can never be dispatched (or paid) again.
      if (state.archivedJobIds.ids.includes(input.id)) return { outcome: 'duplicate' };
      const existing = state.jobs.jobs.find(job => job.id === input.id);
      if (existing) {
        if (existing.promptHash === hash && existing.title === input.title) return { outcome: 'duplicate' };
        reject('task_id_conflict', 'That job ID already belongs to a different submission. Never replace an uncertain job with a new ID.');
      }
      if (input.configRevision !== meta.configRevision) reject('setup_changed', 'Limits or execution settings changed after this job was confirmed. Review the current limits and submit again.');
      if (!meta.execution) reject('execution_not_configured', meta.provisioning
        ? 'Cloud execution is still being set up (the coordinator creates your Anthropic agent and environment first). Submit the job again once Cloud Empire shows execution as ready.'
        : 'Cloud execution is not configured for this Empire, so the job was not queued and nothing was charged. Set it up under Cloud Empire → Limits.');
      if (meta.provisioning) reject('execution_provisioning', 'Execution settings are being replaced. Submit the job again once Cloud Empire shows execution as ready.');
      if (input.site) {
        const sector = state.empire.sectors.find(s => s.id === input.site);
        // A job for a site that is not in the city would credit a building that does not exist.
        if (!sector?.built) reject('site_not_built', `${SITES.find(s => s.id === input.site)?.name ?? 'That sector'} is not built in your city, so its job was not queued and nothing was charged. Found or build it first.`);
      }
      if (state.jobs.jobs.filter(job => job.status === 'queued').length >= LIMITS.queuedJobs) reject('queue_full', `At most ${LIMITS.queuedJobs} jobs can wait in the queue. Let some start or cancel them first.`);
      if (state.jobs.jobs.filter(job => job.status === 'awaiting_review').length >= LIMITS.unreviewedJobs) reject('review_backlog', `${LIMITS.unreviewedJobs} finished jobs are waiting for your review. Review them before submitting more.`);
      const execution = meta.execution!;
      state.jobs.jobs.push({
        id: input.id, title: input.title, prompt: input.prompt, promptPreview: promptPreview(input.prompt), promptHash: hash,
        ...(input.site ? { site: input.site } : {}), intentId: intent.id,
        createdAt: ctx.now, updatedAt: ctx.now, configRevision: input.configRevision, authorizedCents: meta.limits.perTaskBudgetCents,
        status: 'queued', message: meta.lifecycle.status === 'running' ? 'Queued. The coordinator dispatches within your concurrency and daily limits.' : 'Queued while the Empire is shut down. Nothing is dispatched until you start it again.',
        provider: execution.provider, repository: clone(execution.repository), branch: `agent-empire/task-${input.id}`, outputs: 'unverified',
      });
      journal(state, ctx, 'job', `${input.title}: queued (allowance ${meta.limits.perTaskBudgetCents} cents, estimate).`, { intentId: intent.id, jobId: input.id });
      return { outcome: 'applied' };
  };
  const orgCtx = { now: ctx.now, intentId: intent.id };
  const orgRule = <T>(run: () => T): T => { try { return run(); } catch (error) { if (error instanceof OrgRuleError || error instanceof BrainRuleError || error instanceof OutreachRuleError) reject(error.code, error.message); throw error; } };
  switch (intent.kind) {
    case 'new_job': return queueJob(intent.job);
    case 'research': {
      const result = queueJob({ id: intent.job.id, title: researchTitle(intent.question), prompt: cloudResearchPrompt(intent.question, intent.job.id), configRevision: intent.job.configRevision });
      if (result.outcome === 'applied') orgRule(() => addResearch(state.org, intent.job.id, intent.question, ctx.now));
      return result;
    }
    case 'approval_decision': {
      // FREE-12: a campaign send applies only to the exact snapshot it was raised for, and starts sending after it.
      const target = state.org.approvals.find((a) => a.id === intent.approvalId);
      const campaign = target?.kind === 'external_action' && target.status === 'pending';
      if (campaign) {
        if (state.outreachError) reject('outreach_unreadable', `The outreach file could not be read (${state.outreachError}), so nothing was decided.`);
        orgRule(() => checkCampaignDecision(state.outreach, target!));
      }
      const outcome = orgRule(() => decideApproval(state.org, intent, orgCtx));
      if (campaign && outcome === 'applied') applyCampaignDecision(state.outreach, target!, intent.decision === 'approve');
      if (outcome === 'applied') journal(state, ctx, 'intent_applied', `Inbox ${intent.approvalId} ${intent.decision === 'approve' ? 'approved' : 'declined'} by the CEO.`, { intentId: intent.id });
      return { outcome };
    }
    case 'lesson_propose': {
      const lesson = orgRule(() => proposeLesson(state.org, intent.lesson, orgCtx, state.jobs.jobs));
      journal(state, ctx, 'intent_applied', `Lesson ${lesson.id} proposed; it waits in the inbox as ${lesson.approvalId}.`, { intentId: intent.id });
      return { outcome: 'applied' };
    }
    case 'lesson_retire': {
      const outcome = orgRule(() => retireLesson(state.org, intent.lessonId, orgCtx));
      if (outcome === 'applied') journal(state, ctx, 'intent_applied', `Lesson ${intent.lessonId} retired by the CEO.`, { intentId: intent.id });
      return { outcome };
    }
    case 'brain_settings': {
      if (state.brainError) reject('brain_unreadable', `The brain file could not be read (${state.brainError}), so nothing changed. Repair or remove ${BRAIN_FILE}.`);
      applyBrainSettings(state.brain, intent.settings, ctx.now);
      const st = state.brain.settings;
      journal(state, ctx, 'intent_applied', st.mode === 'off' ? 'Chief’s brain turned off; the chief is rule-based.' : `Chief’s brain set to ${st.mode} (${st.provider} · ${st.model}); caps ${st.dailyCapCents} cents a day and ${st.monthlyCapCents} cents per 30 days. Its output is proposals only.`, { intentId: intent.id });
      return { outcome: 'applied' };
    }
    case 'brain_request': {
      if (state.brainError) reject('brain_unreadable', `The brain file could not be read (${state.brainError}), so nothing was asked.`);
      const req = orgRule(() => queueBrainRequest(state.brain, intent.request, orgCtx, state.jobs.jobs));
      journal(state, ctx, 'intent_applied', `Chief asked for a ${req.kind}; the coordinator charges its worst case before calling the model.`, { intentId: intent.id });
      return { outcome: 'applied' };
    }
    case 'outreach_settings': case 'outreach_leads': case 'outreach_suppress': case 'outreach_campaign': case 'outreach_cancel': case 'outreach_delete_leads': {
      if (state.outreachError) reject('outreach_unreadable', `The outreach file could not be read (${state.outreachError}), so nothing changed. Repair or remove ${OUTREACH_FILE}.`);
      const o = state.outreach;
      let message = '';
      let outcome: 'applied' | 'duplicate' = 'applied';
      if (intent.kind === 'outreach_settings') { applyOutreachSettings(o, intent.settings, orgCtx); message = `Outreach sender set to ${intent.settings.from}: at most ${intent.settings.perRunCap} per run and ${intent.settings.dailyCap} a day.`; }
      else if (intent.kind === 'outreach_leads') { const r = orgRule(() => addLeads(o, intent.leads, orgCtx)); message = `${r.added} lead(s) added, ${r.skipped} skipped (duplicates or opted out).`; }
      else if (intent.kind === 'outreach_suppress') { outcome = orgRule(() => suppress(o, state.org, intent.hash, intent.reason, orgCtx)); message = `An address was suppressed (${intent.reason}); it is kept only as a salted hash.`; }
      else if (intent.kind === 'outreach_campaign') { const c = orgRule(() => addCampaign(o, intent.campaign, orgCtx)); message = `Campaign ${c.id} “${c.title}” written; it waits in the inbox for your approval of the exact message and recipients.`; }
      else if (intent.kind === 'outreach_cancel') { outcome = orgRule(() => cancelCampaign(o, state.org, intent.campaignId, orgCtx)); message = `Campaign ${intent.campaignId} cancelled.`; }
      else { deleteLeadData(o, state.org, orgCtx); message = 'Lead data deleted from the current files. Git history keeps old versions unless you rewrite it.'; }
      if (outcome === 'applied') journal(state, ctx, 'intent_applied', message, { intentId: intent.id });
      return { outcome };
    }
    case 'review': {
      const job = findJob(intent.jobId);
      if (job.status === 'running' && job.stopReason === 'end_turn') reject('session_running', 'The agent is working again in this session (continued from the provider Console). Review it once its turn finishes.');
      if (job.status !== 'awaiting_review') reject('not_reviewable', 'Only a finished turn awaiting review can be accepted or rejected.');
      job.review = { decision: intent.decision === 'accept' ? 'accepted' : 'rejected', at: ctx.now, intentId: intent.id, ...(intent.note ? { note: intent.note } : {}) };
      if (intent.decision === 'accept') {
        setStatus(state, ctx, job, 'accepted', 'Accepted by the user. Acceptance is a review decision, not automated verification of code or a pull request.');
        if (rewardAcceptedJob(state.empire, job, ctx.now)) job.rewarded = true;
      } else setStatus(state, ctx, job, 'rejected', 'Rejected by the user. No city reward.');
      // A session left open for review is archived now that the user has decided.
      if (sessionLive(job) && job.stopRequested?.reason !== 'turn_ended') job.stopRequested = { at: ctx.now, reason: 'review' };
      return { outcome: 'applied' };
    }
    case 'cancel': {
      const job = findJob(intent.jobId);
      if (job.status === 'queued') { setStatus(state, ctx, job, 'cancelled', 'Cancelled before dispatch; no provider session was requested.'); return { outcome: 'applied' }; }
      if (holdsSlot(job) && sessionLive(job)) {
        if (!job.stopRequested || job.stopRequested.reason === 'turn_ended') job.stopRequested = { at: ctx.now, reason: 'cancel' };
        job.message = job.status === 'awaiting_review'
          ? 'Archival requested. The session is archived; the finished turn stays available for review.'
          : 'Cancellation requested. The coordinator interrupts and archives the session; the slot and reservation stay held until the provider confirms.';
        journal(state, ctx, 'job', `${job.title}: ${job.status === 'awaiting_review' ? 'session archival' : 'cancellation'} requested.`, { intentId: intent.id, jobId: job.id });
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
        const sessionId = intent.sessionId ?? '';
        const runRef = sessionId.startsWith('ghrun_');
        if (runRef !== (job.provider === 'github-actions')) reject('wrong_session_kind', job.provider === 'github-actions' ? 'This job runs in GitHub Actions: attach its run as ghrun_<run id> (the number in the run’s URL).' : 'This job runs on Anthropic: attach its sesn_… session ID.');
        if (runRef) {
          // Rebuild the run reference from the job itself. The next poll trusts the run only if its title names this
          // job with the same budget and turn cap ("Agent Empire job <id> budget <n>c turns <t>"); otherwise it stays unknown.
          const ex = meta.execution;
          if (ex?.provider !== 'github-actions' || ex.repository.owner !== job.repository.owner || ex.repository.name !== job.repository.name) reject('execution_changed', 'The Empire no longer runs jobs in this job’s GitHub repository, so its run cannot be attached here.');
          const actions = (ex as Extract<typeof ex, { provider: 'github-actions' }>).actions;
          job.cursor = { actions: { owner: job.repository.owner, name: job.repository.name, runId: Number(sessionId.slice(6)), jobId: job.id, engine: actions.engine, budgetCents: job.reservation?.cents ?? 0, maxTurns: actions.maxTurns } };
        } else job.cursor = {};
        job.sessionId = intent.sessionId;
        setStatus(state, ctx, job, 'unknown', 'Provider session attached by the user. The next poll confirms its state and budget.');
      }
      return { outcome: 'applied' };
    }
    case 'shutdown': {
      if (meta.lifecycle.status !== 'running') return { outcome: 'duplicate' };
      settleEconomy(state, ctx); // Close the books up to now; nothing accrues while shut down.
      meta.lifecycle = { status: 'shutting_down', changedAt: ctx.now, workflow: meta.lifecycle.workflow };
      for (const job of state.jobs.jobs) {
        if (SLOT_STATUSES.includes(job.status) && sessionLive(job) && !job.stopRequested) job.stopRequested = { at: ctx.now, reason: 'shutdown' };
      }
      journal(state, ctx, 'lifecycle', 'Shutdown requested. Active provider sessions are being interrupted and archived; nothing new will be dispatched. Finished turns left open for review are not archived.', { intentId: intent.id });
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
      // Manually entered IDs win over automatic setup: a pending or failed request is withdrawn, so it can neither
      // keep new jobs blocked nor later overwrite these IDs.
      const withdrawn = meta.provisioning;
      delete meta.provisioning; delete meta.executionProfile;
      meta.execution = intent.execution; meta.configRevision++;
      journal(state, ctx, 'limits', `Execution set to ${intent.execution.repository.owner}/${intent.execution.repository.name} (${intent.execution.repository.baseBranch}) on Anthropic Managed Agents, with the IDs you entered.${withdrawn ? ` The ${withdrawn.status} automatic setup request was withdrawn.` : ''}`, { intentId: intent.id });
      return { outcome: 'applied' };
    }
    case 'provision': {
      if (intent.configRevision !== meta.configRevision) reject('setup_changed', 'Settings changed since you opened them. Review and try again.');
      if (state.jobs.jobs.some(job => job.status === 'queued' || holdsSlot(job))) reject('active_cloud_jobs', 'Cancel or finish queued and active jobs before changing where jobs run.');
      const model = intent.model ?? DEFAULT_WORKER_MODEL;
      meta.provisioning = { provider: 'anthropic', repository: clone(intent.repository), status: 'pending', model, requestedAt: ctx.now, attempts: 0 };
      journal(state, ctx, 'limits', `Automatic execution setup requested for ${intent.repository.owner}/${intent.repository.name} (${intent.repository.baseBranch}) with ${workerModelLabel(model)}. The coordinator finds or creates your Anthropic agent and environment; this starts no session.${meta.execution ? ' When it finishes it replaces the current execution settings.' : ''}`, { intentId: intent.id });
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
  const processed = new Set(state.processed.entries.map(item => item.id));
  const parsed = sortIntents(files.map(file => {
    if (file.unreadable !== undefined || file.content === undefined) return { path: file.path, intent: undefined as CloudIntent | undefined, error: new IntentError('unreadable_intent', file.unreadable ?? 'Unreadable intent.') };
    try { return { path: file.path, intent: parseIntent(file.path, file.content) as CloudIntent | undefined, error: undefined as IntentError | undefined }; }
    catch (error) { return { path: file.path, intent: undefined, error: error instanceof IntentError ? error : new IntentError('invalid_intent', 'Unreadable intent.') }; }
  }));
  const outcomes: IntentOutcome[] = [];
  const record = (id: string, outcome: IntentOutcome['outcome'], kind?: string) => {
    processed.add(id);
    state.processed.entries.push({ id, at: ctx.now, outcome, ...(kind ? { kind } : {}) });
    state.processed.entries = state.processed.entries.slice(-LIMITS.processedIntents);
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
      // FREE-07 review fix 1: an organization change is kept only if the result fits its budget and reads back.
      if (ORG_INTENTS.has(intent.kind) || OUTREACH_INTENTS.has(intent.kind)) {
        if (scratch.orgError) throw new IntentError('org_unreadable', `The organization file could not be read (${scratch.orgError}), so nothing was changed. Repair or remove state/org.json in the state repository.`);
        try { checkOrg(scratch.org); } catch (error) { throw new IntentError(error instanceof OrgRuleError ? error.code : 'org_invalid', error instanceof Error ? error.message : 'The organization change was refused.'); }
      }
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

// ---------------------------------------------------------------- phase: execution provisioning

export type ProvisionOutcome =
  | { key: string; ok: true; result: ProvisionResult }
  | { key: string; ok: false; attempted: boolean; retryable: boolean; message: string };
/** Identifies one request: a withdrawn or replaced request never receives an older outcome. */
const provisionKey = (state: CloudState) => { const p = state.meta.provisioning; return JSON.stringify(p ? [p.repository, p.model ?? DEFAULT_WORKER_MODEL, p.requestedAt] : null); };

/** A pending request is tried on the next run; a retryable failure again after an hour. */
export function provisioningDue(state: CloudState, now: number): boolean {
  const p = state.meta.provisioning;
  if (!p) return false;
  if (p.status === 'pending') return true;
  return !!p.retryable && (p.lastAttemptAt === undefined || now - p.lastAttemptAt >= PROVISION_RETRY_MS);
}

/** Control-plane calls only (lookups, and creation of an agent and environment); never a session. */
export async function attemptProvisioning(state: CloudState, provider: ProviderAdapter): Promise<ProvisionOutcome> {
  const key = provisionKey(state);
  if (!provider.canProvision) return { key, ok: false, attempted: false, retryable: true, message: 'Waiting for an Anthropic API key: the ANTHROPIC_API_KEY Actions secret is not set in the state repository. Run setup again with an Anthropic key. OpenAI-only Empires can’t run jobs until the OpenAI adapter exists.' };
  try { return { key, ok: true, result: await provider.provision(state.meta.provisioning?.model ?? DEFAULT_WORKER_MODEL) }; }
  catch (error) {
    return error instanceof ProvisionError
      ? { key, ok: false, attempted: true, retryable: error.retryable, message: error.message }
      : { key, ok: false, attempted: true, retryable: true, message: 'Execution setup failed unexpectedly. No agent session was started.' };
  }
}

export function recordProvisioning(input: CloudState, outcome: ProvisionOutcome, ctx: TickContext): CloudState {
  const state = clone(input);
  const p = state.meta.provisioning;
  if (!p || provisionKey(state) !== outcome.key) return state; // the request changed meanwhile
  const repo = `${p.repository.owner}/${p.repository.name} (${p.repository.baseBranch})`;
  if (outcome.ok) {
    const { agentId, environmentId, agentCreated, environmentCreated } = outcome.result;
    state.meta.execution = { provider: 'anthropic', repository: clone(p.repository), anthropic: { agentId, environmentId } };
    state.meta.executionProfile = { model: outcome.result.model, networking: WORKER_ENVIRONMENT.config.networking.type };
    delete state.meta.provisioning;
    state.meta.configRevision++;
    journal(state, ctx, 'limits', `Execution ready for ${repo}: Anthropic agent ${agentId} (${agentCreated ? 'created' : 'reused'}) (${workerModelLabel(outcome.result.model)}) and cloud environment ${environmentId} (${environmentCreated ? 'created' : 'reused'}, ${WORKER_ENVIRONMENT.config.networking.type} networking). No session was started and nothing was charged; jobs you submit now run there.`);
    return state;
  }
  const changed = p.status !== 'failed' || p.message !== outcome.message;
  p.status = 'failed'; p.message = outcome.message.slice(0, 2000); p.retryable = outcome.retryable;
  if (outcome.attempted) { p.attempts++; p.lastAttemptAt = ctx.now; }
  else p.lastAttemptAt ??= ctx.now;
  if (changed) journal(state, ctx, 'warning', `Execution setup for ${repo} did not finish: ${outcome.message}${outcome.retryable ? ' The coordinator tries again within the hour.' : ' Fix it, then choose “Set up automatically” under Cloud Empire → Limits.'}`);
  return state;
}

// ---------------------------------------------------------------- provider sessions

export interface ProviderTask { jobId: string; sessionId: string; cursor: EventCursorState; checkBranch: boolean; reason?: StopReason }
export type BranchEvidence = { state: 'found'; sha: string } | { state: 'missing' } | { state: 'unknown'; reason: string };
export interface ProviderResult {
  jobId: string; sessionId: string;
  observation?: ProviderObservation; cursor?: EventCursorState;
  /** The session is idle after a finished turn (end_turn). */
  turnEnded?: boolean;
  branch?: BranchEvidence;
  error?: string;
}

const safeMessage = (error: unknown) => (error instanceof Error && error.name === 'ExecutionError') || error instanceof DispatchFailure
  ? (error as Error).message : 'The provider request failed. No upstream details are exposed.';

/** Phase 1 (read-only): sessions that are still live and either hold a slot or await review. */
export function collectObservations(state: CloudState): ProviderTask[] {
  return state.jobs.jobs.filter(job => sessionLive(job) && holdsSlot(job) && !job.stopRequested)
    .map(job => ({ jobId: job.id, sessionId: job.sessionId!, cursor: clone(job.cursor ?? {}), checkBranch: true }));
}
/** Phase 2 (mutating): stops already committed to the state branch. */
export function collectStops(state: CloudState): ProviderTask[] {
  return state.jobs.jobs.filter(job => sessionLive(job) && job.stopRequested)
    .map(job => ({ jobId: job.id, sessionId: job.sessionId!, cursor: clone(job.cursor ?? {}), checkBranch: false, reason: job.stopRequested!.reason }));
}

/** GET status/events, and for a finished turn GET the task branch head. No provider mutation. */
export async function observeSessions(tasks: ProviderTask[], provider: ProviderAdapter, state: CloudState): Promise<ProviderResult[]> {
  const results: ProviderResult[] = [];
  for (const task of tasks) {
    const result: ProviderResult = { jobId: task.jobId, sessionId: task.sessionId };
    try {
      const seen = await provider.observe(task.sessionId, task.cursor);
      result.observation = seen.observation; result.cursor = seen.cursor;
      result.turnEnded = seen.observation.status === 'idle' && !seen.cursor.page && seen.cursor.stopReason === 'end_turn';
      const job = state.jobs.jobs.find(item => item.id === task.jobId)!;
      if (result.turnEnded && task.checkBranch && state.meta.execution) {
        try { result.branch = await provider.branchHead(state.meta.execution, job.branch); }
        catch { result.branch = { state: 'unknown', reason: 'The task branch could not be checked with the project token.' }; }
      }
    } catch (error) { result.error = safeMessage(error); }
    results.push(result);
  }
  return results;
}

/**
 * Interrupt if running, archive when idle, then observe. Only for stops durable in state. Archiving
 * after a finished turn or a review never interrupts: if the user resumed the session from the
 * provider Console, the work continues and archival waits until it is idle again.
 */
export async function performStops(tasks: ProviderTask[], provider: ProviderAdapter): Promise<ProviderResult[]> {
  const results: ProviderResult[] = [];
  for (const task of tasks) {
    const result: ProviderResult = { jobId: task.jobId, sessionId: task.sessionId };
    try {
      let seen = await provider.observe(task.sessionId, task.cursor);
      result.observation = seen.observation; result.cursor = seen.cursor;
      const interruptible = task.reason === 'cancel' || task.reason === 'shutdown';
      if (interruptible && (seen.observation.providerStatus === 'running' || seen.observation.providerStatus === 'rescheduling')) {
        await provider.interrupt(task.sessionId);
        seen = await provider.observe(task.sessionId, seen.cursor);
        result.observation = seen.observation; result.cursor = seen.cursor;
      }
      if (seen.observation.providerStatus === 'idle') {
        await provider.archive(task.sessionId);
        seen = await provider.observe(task.sessionId, seen.cursor);
        result.observation = seen.observation; result.cursor = seen.cursor;
      }
    } catch (error) { result.error = safeMessage(error); }
    results.push(result);
  }
  return results;
}

function applyObservation(state: CloudState, ctx: TickContext, job: CloudJob, observation: ProviderObservation, cursor: EventCursorState | undefined, info: { turnEnded?: boolean; branch?: BranchEvidence } = {}) {
  // updatedAt moves only when an observed field changes, so a steady live session does not force a commit.
  const { updatedAt: _u, ...before } = job;
  const fingerprint = JSON.stringify(before);
  observeInto(state, ctx, job, observation, cursor, info);
  const { updatedAt: _v, ...after } = job;
  if (JSON.stringify(after) !== fingerprint) job.updatedAt = ctx.now;
}

function observeInto(state: CloudState, ctx: TickContext, job: CloudJob, observation: ProviderObservation, cursor: EventCursorState | undefined, info: { turnEnded?: boolean; branch?: BranchEvidence }) {
  const savedStop = job.cursor?.stopReason; // evidence from an earlier observation, before this cursor replaces it
  job.sessionId = observation.sessionId;
  job.providerStatus = observation.providerStatus;
  if (cursor) job.cursor = cursor;
  // The cost basis follows the job's own reservation, not the provider's bookkeeping: a money-reserved run can never be
  // recorded as free or plan-billed, and a run-caps run never gains a dollar estimate.
  const free = observation.costBasis === 'free_run' || observation.costBasis === 'claude_plan';
  const consistent = job.provider !== 'github-actions' || !job.reservation || (job.reservation.basis === 'run_caps') === free;
  if (observation.costCents !== undefined && consistent) {
    const previous = job.cost?.amountCents ?? 0;
    const basis = observation.costBasis ?? 'provider_reported_list_cost';
    if (observation.costCents > previous || !job.cost || job.cost.basis !== basis) {
      // Free and Claude-plan runs always record 0 (never a US$ figure for a plan); estimates stay out of observed costs.
      const amount = basis === 'free_run' || basis === 'claude_plan' ? 0 : Math.max(previous, observation.costCents);
      if (amount > previous) spend(state, { at: ctx.now, jobId: job.id, kind: basis === 'engine_reported_estimate' ? 'cost_estimated' : 'cost_observed', cents: amount - previous, day: utcDay(ctx.now), basis });
      job.cost = { amountCents: amount, currency: 'USD', observedAt: ctx.now, basis };
    }
  }
  const closed = observation.status === 'cancelled' || observation.status === 'failed';
  // A reviewable turn the user continued from the provider Console is live work again: show it as
  // running (holding its slot), and make it reviewable only after its next finished turn.
  if (job.status === 'awaiting_review' && observation.status === 'running') {
    if (job.stopRequested?.reason === 'turn_ended') delete job.stopRequested;
    setStatus(state, ctx, job, 'running', 'The agent is working again in this session (continued from the provider Console). It becomes reviewable when this turn finishes.');
    return;
  }
  // Reviewed or reviewable jobs keep their status; only the session bookkeeping changes.
  if (REVIEW_STATUSES.includes(job.status)) {
    if (closed) { delete job.stopRequested; if (job.status === 'awaiting_review') job.message = 'The session is closed. The finished turn is unverified: review its branch or pull request, then accept or reject.'; }
    else if (job.status === 'awaiting_review' && info.turnEnded && !job.stopRequested) decideTurnArchive(state, ctx, job, info.branch);
    return;
  }
  const reason = job.stopRequested?.reason;
  let status: CloudJob['status']; let message = observation.message;
  if (observation.status === 'cancelled') {
    // Archived. A finished turn (marked before archiving, or visible in the saved cursor) stays reviewable.
    const finishedTurn = reason === 'turn_ended' || (reason !== 'cancel' && reason !== 'shutdown' && (savedStop === 'end_turn' || cursor?.stopReason === 'end_turn'));
    status = finishedTurn ? 'awaiting_review' : 'cancelled';
    message = finishedTurn
      ? 'The agent finished its turn and the session was archived. The branch or pull request is unverified: review it, then accept or reject.'
      : 'Provider session archived after your stop request. Outputs remain unverified.';
  } else if (observation.status === 'failed') status = 'failed';
  else if (observation.status === 'idle') {
    job.stopReason = cursor?.page ? job.stopReason : (cursor?.stopReason ?? 'unknown');
    if (info.turnEnded && !reason) { job.status = 'awaiting_review'; decideTurnArchive(state, ctx, job, info.branch); journal(state, ctx, 'job', `${job.title}: awaiting review. ${job.message}`, { jobId: job.id }); return; }
    if (job.stopReason === 'requires_action') { status = 'waiting_for_approval'; message = 'Provider is waiting for tool approval or a tool result. Resolve it in provider controls; the coordinator never approves automatically.'; }
    else if (job.stopReason === 'budget_reached') { status = 'budget_paused'; message = 'Provider paused at the session budget. The coordinator will not raise the budget or resume paid work.'; }
    else if (reason) { status = 'idle'; message = 'Stop requested; archival is not yet confirmed and will be retried next run. The slot and reservation stay held.'; }
    else if (job.provider === 'github-actions') { status = 'idle'; message = `${observation.message} Its slot stays held until you accept, reject or cancel.`; }
    else { status = 'idle'; message = `Provider session is idle (stop reason ${job.stopReason}). Review it in provider controls; its slot stays held.`; }
  } else if (observation.status === 'running') status = 'running';
  else status = 'unknown';
  if (SLOT_STATUSES.includes(status) && job.reservation && observation.budgetCents !== job.reservation.cents) {
    status = 'unknown';
    message = 'The provider did not confirm the reserved session budget. The reservation is kept; review or stop this session in provider controls.';
  }
  if (closed) delete job.stopRequested;
  setStatus(state, ctx, job, status, message);
}

/**
 * A finished turn is archived (to release its slot) only when the task branch exists and moved past
 * the source commit. Otherwise the session stays open, holding its slot, so unpushed work or a
 * question from the agent is not lost; the user decides (review, or cancel to archive).
 */
function decideTurnArchive(state: CloudState, ctx: TickContext, job: CloudJob, branch: BranchEvidence | undefined) {
  if (branch?.state === 'found' && branch.sha !== job.sourceCommit) {
    job.branchHead = { sha: branch.sha, observedAt: ctx.now };
    job.stopRequested = { at: ctx.now, reason: 'turn_ended' };
    job.message = `The agent finished its turn and branch ${job.branch} is at ${branch.sha.slice(0, 12)}. The session will be archived to release its slot. Outputs are unverified: review, then accept or reject.`;
    journal(state, ctx, 'job', `${job.title}: branch pushed; session will be archived.`, { jobId: job.id });
    return;
  }
  const why = branch?.state === 'missing' ? `branch ${job.branch} was not found` : branch?.state === 'found' ? `branch ${job.branch} has no commits beyond the source commit` : 'the task branch could not be checked';
  job.message = `The agent finished its turn, but ${why}. The session is left open and keeps its slot so unpushed work or a question is not lost. Check it in the provider Console, then accept, reject, or cancel to archive it.`;
}

/** Records observations for jobs whose session identity has not changed meanwhile. */
export function recordObservations(input: CloudState, results: ProviderResult[], ctx: TickContext): CloudState {
  const state = clone(input);
  for (const result of results) {
    const job = state.jobs.jobs.find(item => item.id === result.jobId);
    if (!job || job.sessionId !== result.sessionId || !sessionLive(job)) continue;
    if (!result.observation) {
      if (!SLOT_STATUSES.includes(job.status)) continue; // Reviewable jobs keep their status.
      setStatus(state, ctx, job, 'unknown', `${result.error ?? 'Provider state could not be read.'} Last-known session identity and reservations were kept.`);
      continue;
    }
    applyObservation(state, ctx, job, result.observation, result.cursor, { turnEnded: result.turnEnded, branch: result.branch });
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
  if (!canDispatch) { queued.forEach(job => wait(job, meta.execution?.provider === 'github-actions' ? 'Waiting: the project GitHub token (PROJECT_GITHUB_TOKEN, with Actions read and write on the project) is missing from the state repository secrets.' : 'Waiting: the provider API key or project GitHub token is missing from the state repository secrets.')); return { state, planned }; }
  // FREE-04: free and Claude-subscription runs in GitHub Actions reserve no money. Their budget is the job workflow's
  // time and turn caps, recorded as a zero-cent run-caps reservation that still holds the concurrency slot.
  const execution = meta.execution;
  const capsOnly = execution.provider === 'github-actions' && !isMoneyEngine(execution.actions.engine);
  let active = state.jobs.jobs.filter(holdsSlot).length;
  let reserved = reservedToday(state, ctx.now);
  for (const job of queued) {
    if (active >= meta.limits.maxConcurrent) { wait(job, `Waiting for a free slot (${meta.limits.maxConcurrent} concurrent).`); continue; }
    const cents = capsOnly ? 0 : Math.min(meta.limits.perTaskBudgetCents, job.authorizedCents);
    if (!capsOnly && reserved + cents > meta.limits.dailyBudgetCents) { wait(job, 'Waiting: today\'s allowance is fully reserved (UTC day). This is an admission limit, not a billing meter.'); continue; }
    const day = utcDay(ctx.now);
    job.reservation = { cents, day, basis: capsOnly ? 'run_caps' : 'per_job_allowance_estimate' };
    job.dispatch = { runId: ctx.runId, preparedAt: ctx.now, attempts: (job.dispatch?.attempts ?? 0) + 1 };
    if (!capsOnly) spend(state, { at: ctx.now, jobId: job.id, kind: 'reserved', cents, day, basis: 'per_job_allowance_estimate' });
    setStatus(state, ctx, job, 'dispatching', capsOnly
      ? `Dispatch recorded before the run starts (no money reserved: capped at ${execution.provider === 'github-actions' ? `${execution.actions.timeoutMinutes} minutes and ${execution.actions.maxTurns} turns` : ''}). If this run stops, the job becomes dispatch uncertain and is never retried blindly.`
      : `Dispatch recorded before the paid request (reserved ${cents} cents, estimate). If this run stops, the job becomes dispatch uncertain and is never retried blindly.`);
    active++; reserved += cents; planned.push(job.id);
  }
  return { state, planned };
}

// ---------------------------------------------------------------- phase: dispatch receipts

export type DispatchResult = { jobId: string; sourceCommit: string; observation: ProviderObservation; cursor?: EventCursorState } | { jobId: string; failure: { sent: boolean; message: string; countsAsAttempt?: boolean } };
export const MAX_DISPATCH_ATTEMPTS = 3;

export function recordDispatches(input: CloudState, results: DispatchResult[], ctx: TickContext): CloudState {
  const state = clone(input);
  for (const result of results) {
    const job = state.jobs.jobs.find(item => item.id === result.jobId);
    if (!job || job.dispatch?.runId !== ctx.runId || job.sessionId || !['dispatching', 'dispatch_uncertain'].includes(job.status)) continue;
    if ('failure' in result) {
      if (result.failure.sent) { setStatus(state, ctx, job, 'dispatch_uncertain', `${result.failure.message} It will not be retried.`); continue; }
      releaseReservation(state, job, ctx.now);
      // A rate limit is GitHub asking us to wait, not a failed attempt: give the attempt back.
      if (result.failure.countsAsAttempt === false && job.dispatch) job.dispatch.attempts = Math.max(0, job.dispatch.attempts - 1);
      if ((job.dispatch?.attempts ?? 0) >= MAX_DISPATCH_ATTEMPTS) setStatus(state, ctx, job, 'failed', `${result.failure.message} Gave up after ${MAX_DISPATCH_ATTEMPTS} attempts; no paid session was requested.`);
      else setStatus(state, ctx, job, 'queued', `${result.failure.message} Requeued; the reservation was released.`);
      continue;
    }
    if (state.jobs.jobs.some(other => other !== job && other.sessionId === result.observation.sessionId)) {
      setStatus(state, ctx, job, 'dispatch_uncertain', 'The provider returned a session already linked to another job. Inspect the provider Console.');
      continue;
    }
    job.sourceCommit = result.sourceCommit;
    job.cursor = result.cursor ? clone(result.cursor) : {};
    journal(state, ctx, 'dispatch', `${job.title}: provider session ${result.observation.sessionId} created from ${result.sourceCommit.slice(0, 12)} on branch ${job.branch}.`, { jobId: job.id });
    applyObservation(state, ctx, job, result.observation, undefined);
  }
  return state;
}

// ---------------------------------------------------------------- phase: lifecycle, economy, compaction

/** Shutdown completes once no active session still needs stopping. Returns whether to disable the workflow. */
export function lifecycleStep(state: CloudState, ctx: TickContext): { disableWorkflow: boolean } {
  const meta = state.meta;
  if (meta.lifecycle.status === 'shutting_down') {
    const stopping = state.jobs.jobs.filter(job => SLOT_STATUSES.includes(job.status) && sessionLive(job));
    if (!stopping.length) {
      meta.lifecycle = { status: 'shutdown', changedAt: ctx.now, workflow: meta.lifecycle.workflow === 'disabled' ? 'disabled' : 'disable_requested' };
      const unresolved = state.jobs.jobs.filter(job => SLOT_STATUSES.includes(job.status) && !job.sessionId);
      const openReview = state.jobs.jobs.filter(job => REVIEW_STATUSES.includes(job.status) && sessionLive(job));
      journal(state, ctx, 'lifecycle', `Empire shut down. State recorded; the coordinator workflow will be disabled.${unresolved.length ? ` ${unresolved.length} uncertain dispatch(es) have no session ID and could not be stopped; check the provider Console.` : ''}${openReview.length ? ` ${openReview.length} finished turn(s) left open for review remain idle in the provider.` : ''}`);
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

/**
 * Keeps the hot jobs file bounded. Prompts leave it once dispatch no longer needs them, and final
 * jobs with no reservation for today leave it after 14 days or beyond the newest 200. Both go to
 * write-only files under `archive/`, which the coordinator never reads back.
 */
export function compactJobs(state: CloudState, ctx: TickContext, tag: string): FileChange[] {
  const files: FileChange[] = [];
  for (const job of state.jobs.jobs) {
    if (job.prompt !== undefined && !PROMPT_STATUSES.includes(job.status)) {
      job.promptArchive = `archive/prompts/${job.id}.txt`;
      files.push({ path: job.promptArchive, content: job.prompt });
      delete job.prompt;
    }
  }
  const today = utcDay(ctx.now);
  const finals = state.jobs.jobs.filter(job => FINAL_STATUSES.includes(job.status) && !sessionLive(job) && job.reservation?.day !== today)
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  const archived = finals.filter((job, index) => index >= LIMITS.finalRetained || ctx.now - job.updatedAt > LIMITS.finalRetentionMs);
  if (archived.length) {
    const path = `archive/jobs/${today}-${ctx.runId}-${tag}.json`;
    files.push({ path, content: JSON.stringify({ schemaVersion: 1, archivedAt: ctx.now, runId: ctx.runId, jobs: archived }, null, 2) + '\n' });
    const ids = new Set(archived.map(job => job.id));
    const known = new Set(state.archivedJobIds.ids);
    for (const id of ids) if (!known.has(id)) state.archivedJobIds.ids.push(id);
    state.jobs.jobs = state.jobs.jobs.filter(job => !ids.has(job.id));
    journal(state, ctx, 'job', `${archived.length} finished job(s) moved to ${path}.`);
  }
  return files;
}

// ---------------------------------------------------------------- orchestration

export function stateChanges(state: CloudState, snapshot: StateSnapshot, consumedIntents: string[] = [], extra: FileChange[] = []): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, content] of Object.entries(serializeState(state))) if (snapshot.files[path] !== content) changes.push({ path, content });
  const present = new Set([...Object.keys(snapshot.files), ...snapshot.unreadableIntents.map(item => item.path)]);
  for (const path of consumedIntents) if (present.has(path)) changes.push({ path, content: null });
  return [...changes, ...extra];
}
const stateFilesOf = (snapshot: StateSnapshot) => Object.fromEntries(Object.entries(snapshot.files).filter(([path]) => !path.startsWith('intents/') && !RECEIPT_RE.test(path)));
const receiptFilesOf = (snapshot: StateSnapshot) => Object.entries(snapshot.files).filter(([path]) => RECEIPT_RE.test(path)).map(([path, content]) => ({ path, content }));
const intentFilesOf = (snapshot: StateSnapshot): IntentFile[] => [
  ...Object.entries(snapshot.files).filter(([path]) => path.startsWith('intents/')).map(([path, content]) => ({ path, content })),
  ...snapshot.unreadableIntents.map(item => ({ path: item.path, unreadable: item.reason })),
];
function stamp(state: CloudState, ctx: TickContext) {
  state.meta.revision++;
  state.heartbeat = { schemaVersion: 1, lastRunId: ctx.runId, lastRunAt: ctx.now };
}
/** True when a run changed anything beyond the city clock (which may wait for the next commit). */
function meaningful(state: CloudState, snapshot: StateSnapshot): boolean {
  const next = serializeState(state);
  for (const file of [STATE_FILES.jobs, STATE_FILES.ledger, STATE_FILES.journal, STATE_FILES.processed, ORG_FILE, BRAIN_FILE, OUTREACH_FILE]) if (next[file] !== undefined && next[file] !== snapshot.files[file]) return true;
  const core = (text: string | undefined) => { if (!text) return ''; const { coordinator: _c, revision: _r, ...rest } = JSON.parse(text); return JSON.stringify(rest); };
  return core(next[STATE_FILES.meta]) !== core(snapshot.files[STATE_FILES.meta]);
}

export interface CoordinatorDeps {
  store: StateStore & Partial<WorkflowControl>;
  provider: ProviderAdapter;
  now: () => number;
  runId: string;
  /** The workflow grants `actions: write`, so the coordinator may disable itself on shutdown. */
  allowSelfDisable?: boolean;
  retry?: RetryOptions;
  log?: (line: string) => void;
  /** FREE-11: the chief's model client (only called for charges already committed for this run). */
  brain?: BrainCaller;
  /** FREE-11/12: GitHub's time for this run (its run_started_at); without it no paid call or send is made. */
  githubTime?: () => Promise<number | undefined>;
}
export interface TickReport {
  runId: string;
  revision: number;
  intents: IntentOutcome[];
  observed: number;
  stopped: number;
  dispatched: { jobId: string; outcome: 'session' | 'uncertain' | 'requeued' | 'failed' }[];
  lifecycle: CloudState['meta']['lifecycle'];
  migrated: string[];
  commits: number;
  intentsTruncated: boolean;
  /** Automatic execution setup attempted this run. */
  provisioning?: 'ready' | 'failed' | 'waiting_for_key';
}

export async function runCoordinatorTick(deps: CoordinatorDeps): Promise<TickReport> {
  const log = deps.log ?? (() => {});
  const ctx1: TickContext = { now: deps.now(), runId: deps.runId };
  let observations: ProviderResult[] | undefined;
  let researchReads: Record<string, BranchFile> | undefined;
  let provisionOutcome: ProvisionOutcome | undefined;
  let migrated: string[] = [];
  let commits = 0;
  let planned: PlannedCall[] = [];
  let ghTime: { at: number | undefined } | undefined;

  const phase1 = await updateWithRetry(deps.store, async snapshot => {
    const parsed = parseStateFiles(stateFilesOf(snapshot), ctx1.now, snapshot.unreadableState);
    migrated = parsed.migrated;
    let state = reconcileStaleDispatches(parsed.state, ctx1);
    // Read-only provider calls run once per tick, before intents, so a review or cancel is judged
    // against the session's current state. A commit retry reuses these results.
    observations ??= await observeSessions(collectObservations(state), deps.provider, state);
    state = recordObservations(state, observations, ctx1);
    const intents = applyIntents(state, intentFilesOf(snapshot), ctx1);
    state = intents.state;
    // FREE-07 (review fix 2): research reports are imported AFTER intents, so decisions can always drain a full inbox,
    // and nothing in an untrusted report can stop cancel, shutdown or the stops below. Reads are read-only and reused
    // on a commit retry; any failure leaves the organization exactly as it was and is journaled.
    if (!state.orgError) {
      try {
        researchReads ??= await readResearchReports(researchDue(state.org, state.jobs.jobs), deps.provider, state);
        const org = clone(state.org);
        recordResearch(org, state.jobs.jobs, researchReads, ctx1.now);
        checkOrg(org);
        state.org = org;
      } catch (error) {
        journal(state, ctx1, 'warning', `Research reports were not imported this run (${error instanceof Error ? error.message.slice(0, 160) : 'unexpected error'}).`);
      }
    }
    // FREE-11/12: GitHub's time, read once per tick (a retry reuses it), is the clock for brain caps and the send day.
    ghTime ??= { at: await deps.githubTime?.().catch(() => undefined) };
    const clock = trustedClock(ghTime.at, ctx1.now, state.brain.clockAt);
    let receiptPaths: string[] = [];
    if (!state.outreachError && !state.orgError) {
      try {
        const outreach = clone(state.outreach); const org = clone(state.org);
        receiptPaths = consumeReceipts(outreach, receiptFilesOf(snapshot), ctx1.now);
        reconcileCampaigns(outreach, org, ctx1.now, state.meta.schedule.intervalMinutes);
        claimSends(outreach, org, ctx1, clock, state.meta.lifecycle.status === 'running');
        checkOrg(org);
        state.outreach = outreach; state.org = org;
      } catch (error) {
        receiptPaths = [];
        journal(state, ctx1, 'warning', `Outreach was not updated this run (${error instanceof Error ? error.message.slice(0, 160) : 'unexpected error'}).`);
      }
    }
    planned = !state.brainError && !state.orgError ? chargeBrain(state.brain, state.org, state.jobs.jobs, ctx1, clock) : [];
    // Free control-plane calls, once per tick (a commit retry reuses the outcome), before dispatch planning.
    if (provisioningDue(state, ctx1.now)) {
      if (!provisionOutcome || provisionOutcome.key !== provisionKey(state)) provisionOutcome = await attemptProvisioning(state, deps.provider);
      state = recordProvisioning(state, provisionOutcome, ctx1);
    }
    const plan = planDispatch(state, ctx1, deps.provider.canDispatchFor?.(state.meta.execution) ?? deps.provider.canDispatch);
    state = plan.state;
    const lifecycle = lifecycleStep(state, ctx1);
    economyStep(state, ctx1);
    const archives = compactJobs(state, ctx1, 'p1');
    const heartbeatDue = state.heartbeat.lastRunAt === undefined || ctx1.now - state.heartbeat.lastRunAt >= HEARTBEAT_MS;
    const consumed = [...intents.consumed, ...receiptPaths];
    const commit = consumed.length > 0 || planned.length > 0 || archives.length > 0 || migrated.length > 0 || heartbeatDue || meaningful(state, snapshot);
    if (commit) stamp(state, ctx1);
    const applied = intents.outcomes.filter(item => item.outcome === 'applied').length;
    return {
      changes: commit ? stateChanges(state, snapshot, consumed, archives) : [],
      message: `Agent Empire coordinator ${ctx1.runId}: ${intents.outcomes.length} intent(s), ${applied} applied, ${plan.planned.length} to dispatch`,
      value: { state, planned: plan.planned, outcomes: intents.outcomes, disableWorkflow: lifecycle.disableWorkflow, truncated: snapshot.intentsTruncated, committed: commit },
    };
  }, deps.retry);
  if (phase1.changed) commits++;
  let state = phase1.value.state;
  if (provisionOutcome) log(`execution setup: ${provisionOutcome.ok ? `ready (agent ${provisionOutcome.result.agentCreated ? 'created' : 'reused'}, environment ${provisionOutcome.result.environmentCreated ? 'created' : 'reused'})` : `not finished (${provisionOutcome.attempted ? 'provider refused or unreachable' : 'no Anthropic key'})`}`);
  log(`phase 1 ${phase1.changed ? `commit ${phase1.sha.slice(0, 12)} after ${phase1.attempts} attempt(s)` : 'nothing to commit'}: ${phase1.value.outcomes.length} intent(s), ${observations?.length ?? 0} session(s) observed, ${phase1.value.planned.length} planned`);

  // FREE-11: model calls only for charges now durable in the state branch and naming this run.
  const brainResults: BrainResult[] = [];
  for (const call of planned) {
    const req = state.brain.requests.find((r) => r.id === call.requestId);
    if (!phase1.changed || req?.status !== 'charged' || req.charge?.runId !== deps.runId) continue;
    if (!deps.brain) { brainResults.push({ requestId: call.requestId, lessonIds: call.lessonIds, error: 'this coordinator has no model client' }); continue; }
    try { brainResults.push({ requestId: call.requestId, lessonIds: call.lessonIds, ok: await deps.brain({ provider: call.provider, model: call.model, messages: call.messages, maxTokens: call.maxTokens }) }); }
    catch (error) { brainResults.push({ requestId: call.requestId, lessonIds: call.lessonIds, error: error instanceof Error ? error.message : 'unknown error' }); }
  }
  if (brainResults.length) log(`brain: ${brainResults.length} call(s) made`);

  // Mutating provider calls: only for intentions now durable in the state branch.
  const stopResults = await performStops(collectStops(state), deps.provider);
  const dispatchResults: DispatchResult[] = [];
  for (const jobId of phase1.value.planned) {
    const job = state.jobs.jobs.find(item => item.id === jobId)!;
    try {
      const created = await deps.provider.dispatch({ jobId, prompt: job.prompt!, branch: job.branch, budgetCents: job.reservation!.cents, execution: state.meta.execution! });
      dispatchResults.push({ jobId, ...created });
    } catch (error) {
      // Anything other than a proven not-sent failure may have created a paid session.
      dispatchResults.push({ jobId, failure: error instanceof DispatchFailure ? { sent: error.sent, message: error.message, ...(error.countsAsAttempt ? {} : { countsAsAttempt: false }) } : { sent: true, message: 'The provider request failed in an unexpected way; the session may have been accepted.' } });
    }
  }
  const ctx2: TickContext = { now: deps.now(), runId: deps.runId };
  const receipts = (input: CloudState) => {
    let next = recordObservations(input, stopResults, ctx2);
    if (brainResults.length && !next.brainError && !next.orgError) recordBrainResults(next.brain, next.org, next.jobs.jobs, brainResults, ctx2);
    next = recordDispatches(next, dispatchResults, ctx2);
    return { state: next, lifecycle: lifecycleStep(next, ctx2) };
  };

  let workflowDisabled = false;
  const preview = receipts(state);
  const wantDisable = preview.lifecycle.disableWorkflow;
  if (wantDisable && deps.allowSelfDisable && deps.store.setWorkflowEnabled) {
    try { await deps.store.setWorkflowEnabled(false); workflowDisabled = true; }
    catch (error) { log(`workflow disable failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
  }

  if (stopResults.length || dispatchResults.length || wantDisable || brainResults.length) {
    try {
      const phase2 = await updateWithRetry(deps.store, snapshot => {
        const { state: next } = receipts(parseStateFiles(stateFilesOf(snapshot), ctx2.now, snapshot.unreadableState).state);
        if (wantDisable && next.meta.lifecycle.status === 'shutdown' && next.meta.lifecycle.workflow === 'disable_requested') {
          if (workflowDisabled) { next.meta.lifecycle.workflow = 'disabled'; journal(next, ctx2, 'lifecycle', 'Coordinator workflow disabled. Start the Empire from the app to re-enable it.'); }
          else journal(next, ctx2, 'warning', 'The coordinator could not disable its own workflow. The app disables it with your GitHub sign-in; scheduled runs do nothing while shut down.');
        }
        const archives = compactJobs(next, ctx2, 'p2');
        stamp(next, ctx2);
        return { changes: stateChanges(next, snapshot, [], archives), message: `Agent Empire coordinator ${ctx2.runId}: ${stopResults.length} stop(s), ${dispatchResults.length} dispatch receipt(s), ${brainResults.length} brain answer(s)`, value: next };
      }, deps.retry);
      if (phase2.changed) commits++;
      state = phase2.value;
      log(`phase 2 commit ${phase2.sha.slice(0, 12)} after ${phase2.attempts} attempt(s)`);
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
    observed: observations?.length ?? 0,
    stopped: stopResults.length,
    dispatched: dispatchResults.map(result => ({
      jobId: result.jobId,
      outcome: 'observation' in result ? 'session' : result.failure.sent ? 'uncertain' : state.jobs.jobs.find(job => job.id === result.jobId)?.status === 'failed' ? 'failed' : 'requeued',
    })),
    lifecycle: state.meta.lifecycle,
    migrated,
    commits,
    intentsTruncated: phase1.value.truncated,
    ...(provisionOutcome ? { provisioning: provisionOutcome.ok ? 'ready' as const : provisionOutcome.attempted ? 'failed' as const : 'waiting_for_key' as const } : {}),
  };
}

export { STATE_FILES };
