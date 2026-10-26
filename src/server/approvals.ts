import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { APPROVAL_ID_RE, APPROVAL_KIND_LABEL, MAX_APPROVAL_BUDGET_USD, RAISED_BY, approveHint, type Approval, type ApprovalKind, type ApprovalsState, type ApprovalStatus } from '../shared/approvals.js';
import type { ConsultancyApproveOptions, ConsultancyJob, ConsultancySnapshot } from '../shared/consultancy.js';
import { ACTUAL_SPEND_LABEL, EXECUTIVES, basisLabel, fmtDurationRange, fmtUsdRange, type ExecutiveRole } from '../shared/org.js';
import { ConsultancyError } from './consultancy.js';
import { LESSON_DECISION_NOTE, SOURCE_LABEL, scopeText } from '../shared/memory.js';
import { writeJsonAtomic } from './persistence.js';

const FILE = 'approvals.json';
/** Decided items kept for the record; pending items are never dropped. */
const MAX_DECIDED = 200;
const MAX_ACTOR = 120;
const MAX_REQUEST_ID = 120;

/** The consultancy operations the inbox uses. Consultancy stays the source of truth for every plan and budget. */
export interface InboxConsultancy {
  snapshot(): ConsultancySnapshot;
  approve(id: string, actor: string, options?: ConsultancyApproveOptions): ConsultancyJob;
  reject(id: string, actor: string): ConsultancyJob;
  raiseBudget(id: string, budgetUsd: number, actor: string): ConsultancyJob;
}

/**
 * ORG-04a: the owner of an external_action (outreach). `check` throws an ApprovalError (409) when the item no longer
 * matches what it would act on, and the inbox records nothing. Otherwise the inbox saves the decision first and only
 * then calls `apply`, so nothing is ever sent without a durable approval.
 */
export interface ExternalActionPort {
  check(item: Approval, decision: 'approved' | 'rejected'): void;
  apply(item: Approval, decision: 'approved' | 'rejected', actor: string): void;
}

export interface DecisionOptions {
  budgetUsd?: unknown;
  /** Optional caller idempotency key, recorded with the decision. */
  requestId?: unknown;
}

interface Stored extends Approval {
  /** What raised it: `plan:<jobId>` or `budget:<jobId>:<hold reachedAt>`. Unique; the inbox never raises one twice. */
  source: string;
  requestId?: string;
}

interface StoredFile {
  version: 1;
  revision: number;
  nextSeq: number;
  items: Stored[];
}

export class ApprovalError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

// RAISED_BY is shared with the cloud coordinator (src/shared/approvals.ts, FREE-07).

/**
 * FREE-02: the owner of chief_proposal actions. `check` answers why the action no longer applies (the inbox answers 409
 * and records nothing); `apply` runs after the approval is saved and answers a note for the record.
 */
export interface ChiefActionPort {
  check(item: Approval): string | undefined;
  apply(item: Approval): string;
}

/**
 * FREE-10: the owner of `lesson` items (organizational memory). `check` answers why approving no longer applies (409,
 * nothing recorded); `apply` runs after the decision is saved and answers a note for the record.
 */
export interface LessonActionPort {
  check(item: Approval): string | undefined;
  apply(item: Approval, decision: 'approved' | 'rejected', actor: string): string;
}
const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * The default for a budget increase: what was spent plus the top of the estimate for the work not yet done, rounded
 * up to whole dollars. Always above both the spend and the current budget, and never above the global cap.
 */
export function suggestBudget(job: ConsultancyJob): number {
  const spent = job.actualSpendUsd ?? job.budgetHold?.spentUsd ?? 0;
  let remaining = 0;
  for (const item of job.items) {
    const high = item.estimate?.costUsd.high;
    if (high === undefined) continue;
    if (item.status === 'running') remaining += Math.max(0, high - (item.actualSpendUsd ?? 0));
    else if (item.status === 'queued' || item.held || (item.status === 'needs_attention' && !item.queueTaskId)) remaining += high;
  }
  if (remaining <= 0) remaining = Math.max(1, spent * 0.5);
  let next = Math.ceil(spent + remaining - 1e-9);
  const floor = Math.max(job.approvedBudgetUsd ?? 0, spent);
  if (next <= floor) next = Math.floor(floor) + 1;
  return Math.min(MAX_APPROVAL_BUDGET_USD, next);
}

function validBudget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_APPROVAL_BUDGET_USD)
    throw new ApprovalError(400, `budgetUsd must be a number above 0 and at most ${MAX_APPROVAL_BUDGET_USD}`);
  return Math.round(value * 100) / 100;
}

function cleanActor(actor: string): string {
  const trimmed = typeof actor === 'string' ? actor.trim() : '';
  if (!trimmed || trimmed.length > MAX_ACTOR) throw new ApprovalError(400, 'actor is invalid');
  return trimmed;
}

function cleanRequestId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_REQUEST_ID) throw new ApprovalError(400, 'requestId must be a short string');
  return value.trim();
}

function planDetail(job: ConsultancyJob): string {
  const parts = [job.client, `${job.items.length} item${job.items.length === 1 ? '' : 's'}`];
  if (job.estimate) parts.push(`estimate ${fmtUsdRange(job.estimate.costUsd)} (${basisLabel(job.estimate.basis)})`);
  return parts.join(' · ');
}

function budgetDetail(job: ConsultancyJob, spent: number, approved: number): string {
  const held = job.items.filter((i) => i.held).length;
  return `Spent ${usd(spent)} of the approved ${usd(approved)} (${ACTUAL_SPEND_LABEL}). ${held} unstarted item${held === 1 ? ' is' : 's are'} held; running work continues.`;
}

/** Public shape: the storage-only fields stay on the server. */
function publicItem({ source: _s, requestId: _r, ...item }: Stored): Approval {
  return { ...item, ...(item.estimate ? { estimate: structuredClone(item.estimate) } : {}) };
}

/**
 * The CEO's approval inbox, durable in approvals.json. Items are reconciled from consultancy state, so a plan decided
 * on the founder desk or in Telegram resolves here too, and a decision here goes through the same consultancy call.
 */
export class ApprovalInbox {
  private readonly file: string;
  private data: StoredFile = { version: 1, revision: 0, nextSeq: 1, items: [] };
  private storageError?: string;
  /** Set while a decision runs, so the consultancy change it causes does not reconcile half-way through it. */
  private deciding = false;
  private reconciling = false;
  private external?: ExternalActionPort;
  private chief?: ChiefActionPort;
  private planOrigin?: (jobId: string) => string | undefined;
  private lessons?: LessonActionPort;
  private architect?: { revert(runId: string, actor: string): string };

  constructor(dataDir: string, private readonly office: InboxConsultancy, private readonly onChange?: () => void, private readonly now = Date.now) {
    this.file = path.join(dataDir, FILE);
    this.restore();
    this.reconcile();
  }

  state(): ApprovalsState {
    const items = this.data.items.map(publicItem);
    const pendingItems = items.filter((i) => i.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    const decided = items.filter((i) => i.status !== 'pending').sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
    return {
      schemaVersion: 1,
      revision: this.data.revision,
      items: [...pendingItems, ...decided],
      pending: pendingItems.length,
      ...(this.storageError ? { storageError: this.storageError } : {}),
    };
  }

  get(id: string): Approval | undefined {
    const item = this.data.items.find((i) => i.id === id);
    return item && publicItem(item);
  }

  pending(): Approval[] {
    return this.state().items.filter((i) => i.status === 'pending');
  }

  get recoveryError(): string | undefined { return this.storageError; }

  /** ORG-04a: the owner of external_action items (outreach). */
  setExternal(port: ExternalActionPort) { this.external = port; }

  /** FREE-02: the chief's action owner, and who proposed a plan (the label on a model-proposed job_plan). */
  setChief(port: ChiefActionPort, planOrigin: (jobId: string) => string | undefined) { this.chief = port; this.planOrigin = planOrigin; }

  /** FREE-10: the owner of lesson items (organizational memory). */
  setLessons(port: LessonActionPort) { this.lessons = port; }

  /** CITY-10: the city architect, which reverts a run when its summary is declined. */
  setArchitect(port: { revert(runId: string, actor: string): string }) { this.architect = port; }

  /** CITY-10: raises a run's daily summary. Idempotent by `source`; answers the id, or undefined while storage is broken. */
  raiseArchitect(fields: { source: string; title: string; detail: string; architect: NonNullable<Approval['architect']> }): string | undefined {
    if (this.storageError) return undefined;
    const existing = this.data.items.find((i) => i.source === fields.source);
    if (existing) return existing.id;
    this.add({ kind: 'architect_summary', jobId: 'city-architect', createdAt: this.now(), ...structuredClone(fields) });
    this.trim();
    try { this.save(); } catch { return undefined; }
    return this.data.items.find((i) => i.source === fields.source)?.id;
  }

  /** CITY-10: a pending summary whose run was undone elsewhere (Settings): resolved with a note. */
  resolveArchitect(id: string, note: string) {
    if (this.storageError) return;
    const item = this.data.items.find((i) => i.id === id);
    if (!item || item.kind !== 'architect_summary' || item.status !== 'pending') return;
    Object.assign(item, { status: 'resolved', decidedAt: this.now(), decidedBy: 'City architect', note: note.slice(0, 300) });
    this.save();
  }

  /** FREE-10: raises a lesson item. Idempotent by `source`; answers the id, or undefined while storage is broken. */
  raiseLesson(fields: { source: string; jobId: string; title: string; detail: string; lesson: NonNullable<Approval['lesson']> }): string | undefined {
    if (this.storageError) return undefined;
    const existing = this.data.items.find((i) => i.source === fields.source);
    // Review fix 1: reuse an item only when it is this very proposal (same lesson id, text, scope and nonce).
    if (existing) {
      const a = existing.lesson, b = fields.lesson;
      const same = existing.kind === 'lesson' && !!a && a.lessonId === b.lessonId && a.text === b.text && a.scope === b.scope && (a.scopeValue ?? '') === (b.scopeValue ?? '') && !!b.nonce && a.nonce === b.nonce;
      return same ? existing.id : undefined;
    }
    this.add({ kind: 'lesson', createdAt: this.now(), ...structuredClone(fields) });
    this.trim();
    try { this.save(); } catch { return undefined; }
    return this.data.items.find((i) => i.source === fields.source)?.id;
  }

  /** FREE-10: a pending lesson item whose lesson was retired or replaced elsewhere: resolved with a note, never approved. */
  resolveLesson(id: string, note: string) {
    if (this.storageError) return;
    const item = this.data.items.find((i) => i.id === id);
    if (!item || item.kind !== 'lesson' || item.status !== 'pending') return;
    item.status = 'resolved';
    item.decidedAt = this.now();
    item.decidedBy = 'Organizational memory';
    item.note = note.slice(0, 300);
    this.save();
  }

  /** FREE-02: raises a chief_proposal. Idempotent by `source`; answers the id, or undefined while storage is broken. */
  raiseChief(fields: { source: string; jobId: string; title: string; detail: string; proposal: NonNullable<Approval['proposal']> }): string | undefined {
    if (this.storageError) return undefined;
    const existing = this.data.items.find((i) => i.source === fields.source);
    if (existing) return existing.id;
    this.add({ kind: 'chief_proposal', createdAt: this.now(), ...structuredClone(fields) });
    this.trim();
    try { this.save(); } catch { return undefined; }
    return this.data.items.find((i) => i.source === fields.source)?.id;
  }

  /**
   * Raises an external_action item for `source` (a campaign id plus its snapshot hash). A still-pending item for the
   * same source is returned rather than asked twice; a decided or resolved one never is (review fix 1): a snapshot
   * that changes A→B→A gets a fresh item, its stored source suffixed with the item sequence to stay unique.
   */
  raiseExternal(fields: { source: string; title: string; detail: string; jobId: string; outreach: NonNullable<Approval['outreach']> }): Approval {
    if (this.storageError) throw new ApprovalError(503, this.storageError);
    const existing = this.data.items.find((i) => i.status === 'pending' && (i.source === fields.source || i.source.startsWith(`${fields.source}#`)));
    if (existing) return publicItem(existing);
    const taken = this.data.items.some((i) => i.source === fields.source);
    this.add({ kind: 'external_action', createdAt: this.now(), ...structuredClone(fields), ...(taken ? { source: `${fields.source}#${this.data.nextSeq}` } : {}) });
    const item = this.data.items[this.data.items.length - 1];
    this.trim();
    this.save();
    return publicItem(item);
  }

  /** A pending external_action that no longer matches what would be sent: resolved with a note, never approved. */
  resolveExternal(id: string, note: string) {
    if (this.storageError) return;
    const item = this.data.items.find((i) => i.id === id);
    if (!item || item.kind !== 'external_action' || item.status !== 'pending') return;
    item.status = 'resolved';
    item.decidedAt = this.now();
    item.decidedBy = 'Marketing & sales (rule-based)';
    item.note = note.slice(0, 300);
    this.save();
  }

  /** Brings the inbox in line with consultancy state. Never throws; returns whether anything changed. */
  reconcile(): boolean {
    if (this.storageError || this.deciding || this.reconciling) return false;
    this.reconciling = true;
    try {
      let snapshot: ConsultancySnapshot;
      try { snapshot = this.office.snapshot(); } catch { return false; }
      const before = JSON.stringify(this.data.items);
      const at = this.now();
      for (const job of snapshot.jobs) {
        this.reconcilePlan(job, at);
        this.reconcileBudget(job, at);
      }
      if (JSON.stringify(this.data.items) === before) return false;
      this.trim();
      this.save();
      return true;
    } catch {
      return false;
    } finally {
      this.reconciling = false;
    }
  }

  approve(id: string, actor: string, options: DecisionOptions = {}): Approval {
    return this.decide(id, actor, 'approved', options);
  }

  reject(id: string, actor: string, options: DecisionOptions = {}): Approval {
    return this.decide(id, actor, 'rejected', options);
  }

  private decide(id: string, actor: string, decision: 'approved' | 'rejected', options: DecisionOptions): Approval {
    if (this.storageError) throw new ApprovalError(503, this.storageError);
    const who = cleanActor(actor);
    const requestId = cleanRequestId(options.requestId);
    this.reconcile();
    const item = this.data.items.find((i) => i.id === id);
    if (!item) throw new ApprovalError(404, `Unknown approval: ${id}`);
    // A declined budget increase stays approvable while its hold stands; otherwise its job would be held for good.
    const reopen = decision === 'approved' && item.kind === 'budget_increase' && item.status === 'rejected' && item.reopenable === true;
    // Idempotent: a decided item answers with the decision it already has, whatever is asked now.
    if (item.status !== 'pending' && !reopen) return publicItem(item);
    const declined = reopen ? { at: item.decidedAt ?? 0, by: item.decidedBy ?? 'CEO' } : undefined;
    if (item.kind === 'external_action' && options.budgetUsd !== undefined && options.budgetUsd !== null) throw new ApprovalError(400, 'No budget applies to a campaign send. Approve it without an amount.');
    if (item.kind === 'chief_proposal' && options.budgetUsd !== undefined && options.budgetUsd !== null) throw new ApprovalError(400, 'No budget applies to a chief proposal. Decide it without an amount.');
    if (item.kind === 'lesson' && options.budgetUsd !== undefined && options.budgetUsd !== null) throw new ApprovalError(400, 'No budget applies to a lesson. Decide it without an amount.');
    if (item.kind === 'architect_summary' && options.budgetUsd !== undefined && options.budgetUsd !== null) throw new ApprovalError(400, 'No budget applies to a city architect summary. Keep it or revert the day without an amount.');
    const budget = decision === 'approved' && options.budgetUsd !== undefined && options.budgetUsd !== null ? validBudget(options.budgetUsd) : undefined;
    let externalApply: (() => void) | undefined;
    let chiefApply: (() => void) | undefined;
    let lessonApply: (() => void) | undefined;
    this.deciding = true;
    try {
      if (item.kind === 'external_action') {
        if (!this.external) throw new ApprovalError(503, 'Outreach is not available on this host, so this item cannot be decided here.');
        // The owner checks the frozen snapshot still stands (409 otherwise); the decision is saved before anything acts.
        this.external.check(publicItem(item), decision);
        this.record(item, decision, who, requestId);
        this.save();
        externalApply = () => this.external!.apply(publicItem(item), decision, who);
      } else if (item.kind === 'job_plan') {
        try {
          if (decision === 'approved') this.office.approve(item.jobId, who, budget === undefined ? {} : { budgetUsd: budget });
          else this.office.reject(item.jobId, who);
        } catch (error) {
          // The plan was decided the other way meanwhile: the consultancy decision stands and is reconciled below.
          if (!(error instanceof ConsultancyError && error.status === 409)) throw error;
        }
      } else if (item.kind === 'chief_proposal') {
        // FREE-02: the decision is the record. An action runs only after an approval is saved, through the queue.
        if (decision === 'approved' && item.proposal?.action) {
          if (!this.chief) throw new ApprovalError(503, 'The chief is not available on this host, so this action cannot run here.');
          const stale = this.chief.check(publicItem(item));
          if (stale) throw new ApprovalError(409, stale);
          this.record(item, decision, who, requestId);
          this.save();
          chiefApply = () => {
            try { item.note = this.chief!.apply(publicItem(item)).slice(0, 300); } catch (error) { item.note = `Approved, but the action failed: ${(error as Error).message}`.slice(0, 300); }
            this.save();
          };
        } else this.record(item, decision, who, requestId);
      } else if (item.kind === 'lesson') {
        // FREE-10: the decision is saved first; only then does memory activate (or retire) the lesson.
        if (!this.lessons) throw new ApprovalError(503, 'Organizational memory is not available on this host, so this lesson cannot be decided here.');
        if (decision === 'approved') { const stale = this.lessons.check(publicItem(item)); if (stale) throw new ApprovalError(409, stale); }
        this.record(item, decision, who, requestId);
        this.save();
        lessonApply = () => {
          try { item.note = this.lessons!.apply(publicItem(item), decision, who).slice(0, 300) || undefined; } catch (error) { item.note = `Recorded, but memory could not be updated yet: ${(error as Error).message}`.slice(0, 300); }
          if (item.note === undefined) delete item.note;
          this.save();
        };
      } else if (item.kind === 'architect_summary') {
        // CITY-10: Keep records the acknowledgement; declining is saved first, then the architect reverts the run.
        if (decision === 'rejected' && !this.architect) throw new ApprovalError(503, 'The city architect is not available on this host, so this day cannot be reverted here.');
        this.record(item, decision, who, requestId);
        this.save();
        if (decision === 'rejected') lessonApply = () => {
          try { item.note = this.architect!.revert(item.architect!.runId, who).slice(0, 300); } catch (error) { item.note = `Recorded, but the day could not be reverted: ${(error as Error).message}`.slice(0, 300); }
          this.save();
        };
      } else if (item.kind === 'tool_proposal') {
        // ORG-05: the decision is the record. Nothing is installed or adopted.
        this.record(item, decision, who, requestId);
      } else if (decision === 'approved') {
        const job = this.office.snapshot().jobs.find((j) => j.id === item.jobId);
        if (!job) throw new ApprovalError(404, `Unknown consultancy job: ${item.jobId}`);
        const spent = job.actualSpendUsd ?? item.spentUsd ?? 0;
        const raised = budget ?? suggestBudget(job);
        if (raised <= spent) throw new ApprovalError(400, `The new budget must exceed the ${usd(spent)} already spent`);
        if (job.approvedBudgetUsd !== undefined && raised <= job.approvedBudgetUsd) throw new ApprovalError(400, `The new budget must exceed the approved ${usd(job.approvedBudgetUsd)}`);
        this.office.raiseBudget(item.jobId, raised, who);
        this.record(item, 'approved', who, requestId, raised);
        if (declined) {
          item.note = `Reopened after decline on ${new Date(declined.at).toISOString().slice(0, 16).replace('T', ' ')} UTC by ${declined.by}`;
          delete item.reopenable;
        }
      } else {
        // The job stays held; the decision is the record.
        this.record(item, 'rejected', who, requestId);
      }
    } catch (error) {
      if (error instanceof ConsultancyError) throw new ApprovalError(error.status, error.message);
      throw error;
    } finally {
      this.deciding = false;
    }
    if (item.kind === 'job_plan' && requestId) item.requestId = requestId;
    if (externalApply) externalApply();
    else if (chiefApply) chiefApply();
    else if (lessonApply) lessonApply();
    else if (!this.reconcile() && item.kind !== 'job_plan') this.save();
    return publicItem(item);
  }

  private record(item: Stored, status: 'approved' | 'rejected', who: string, requestId?: string, budgetUsd?: number) {
    item.status = status;
    item.decidedAt = this.now();
    item.decidedBy = who;
    if (budgetUsd !== undefined) item.budgetUsd = budgetUsd;
    if (requestId) item.requestId = requestId;
  }

  private reconcilePlan(job: ConsultancyJob, at: number) {
    const source = `plan:${job.id}`;
    const existing = this.data.items.find((i) => i.source === source);
    if (job.decision === 'pending_approval') {
      if (!existing) {
        const proposedBy = this.planOrigin?.(job.id);
        this.add({ source, kind: 'job_plan', jobId: job.id, title: `${job.client} · ${job.title}`, detail: planDetail(job), createdAt: at,
          ...(job.estimate ? { estimate: { costUsd: job.estimate.costUsd, calendarMs: job.estimate.calendarMs, basis: job.estimate.basis } } : {}),
          ...(proposedBy ? { proposedBy } : {}) });
      } else if (existing.status === 'pending') {
        existing.detail = planDetail(job);
        if (job.estimate) existing.estimate = { costUsd: job.estimate.costUsd, calendarMs: job.estimate.calendarMs, basis: job.estimate.basis };
      }
      return;
    }
    // Decided elsewhere (founder desk, Telegram, or this inbox through consultancy): take consultancy's decision.
    if (existing?.status === 'pending') {
      existing.status = job.decision === 'approved' ? 'approved' : 'rejected';
      existing.decidedAt = job.decidedAt ?? at;
      existing.decidedBy = job.decidedBy ?? 'CEO';
      if (job.approvedBudgetUsd !== undefined) existing.budgetUsd = job.approvedBudgetUsd;
    }
  }

  private reconcileBudget(job: ConsultancyJob, at: number) {
    const open = this.data.items.filter((i) => i.kind === 'budget_increase' && i.jobId === job.id && i.status === 'pending');
    const hold = job.decision === 'approved' ? job.budgetHold : undefined;
    const source = hold && `budget:${job.id}:${hold.reachedAt}`;
    for (const item of open) {
      if (item.source === source) continue;
      // The hold this item was raised for is gone. Only Consultancy.raiseBudget clears a hold today, but an approval is
      // recorded only with evidence of a raise: a budget above the one the hold was reached at. Anything else is
      // "resolved", so a future path that clears holds can never produce a fabricated approval.
      item.decidedAt = at;
      if (job.approvedBudgetUsd !== undefined && item.approvedBudgetUsd !== undefined && job.approvedBudgetUsd > item.approvedBudgetUsd) {
        item.status = 'approved';
        item.decidedBy = 'Budget raised outside the inbox';
        item.budgetUsd = job.approvedBudgetUsd;
      } else {
        item.status = 'resolved';
        item.decidedBy = 'Hold cleared without a budget decision';
      }
    }
    // A declined increase can be approved later only while the very hold it was raised for still stands.
    for (const item of this.data.items) {
      if (item.kind !== 'budget_increase' || item.jobId !== job.id || item.status !== 'rejected') continue;
      if (item.source === source) item.reopenable = true;
      else delete item.reopenable;
    }
    if (!hold || !source) return;
    const spent = job.actualSpendUsd ?? hold.spentUsd;
    const existing = this.data.items.find((i) => i.source === source);
    if (!existing) {
      this.add({ source, kind: 'budget_increase', jobId: job.id, title: `${job.client} · ${job.title} reached its budget`, detail: budgetDetail(job, spent, hold.approvedBudgetUsd),
        createdAt: at, spentUsd: spent, approvedBudgetUsd: hold.approvedBudgetUsd, suggestedBudgetUsd: suggestBudget(job),
        ...(job.estimate ? { estimate: { costUsd: job.estimate.costUsd, calendarMs: job.estimate.calendarMs, basis: job.estimate.basis } } : {}) });
    } else if (existing.status === 'pending') {
      existing.spentUsd = spent;
      existing.suggestedBudgetUsd = suggestBudget(job);
      existing.detail = budgetDetail(job, spent, hold.approvedBudgetUsd);
    }
  }

  /**
   * ORG-05: raises an item that does not come from consultancy state (a research tool proposal). Idempotent by
   * `source`: raising the same source again answers the existing id. Answers undefined while storage is broken.
   */
  raise(fields: { source: string; kind: 'tool_proposal'; jobId: string; title: string; detail: string; tool: NonNullable<Approval['tool']> }): string | undefined {
    if (this.storageError) return undefined;
    const existing = this.data.items.find((i) => i.source === fields.source);
    if (existing) return existing.id;
    this.add({ ...fields, createdAt: this.now() });
    this.trim();
    try { this.save(); } catch { return undefined; }
    return this.data.items.find((i) => i.source === fields.source)?.id;
  }

  private add(fields: Omit<Stored, 'id' | 'raisedBy' | 'status'>) {
    const id = `A${this.data.nextSeq++}`;
    this.data.items.push({ id, raisedBy: RAISED_BY[fields.kind], status: 'pending', ...fields });
  }

  private trim() {
    const decided = this.data.items.filter((i) => i.status !== 'pending').sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
    if (decided.length <= MAX_DECIDED) return;
    // Old decisions drop off. A declined budget increase stays: its job is still held, and dropping it would raise it again.
    const drop = new Set(decided.slice(MAX_DECIDED).filter((i) => !(i.kind === 'budget_increase' && i.status === 'rejected')).map((i) => i.id));
    this.data.items = this.data.items.filter((i) => !drop.has(i.id));
  }

  private save() {
    this.data.revision += 1;
    try {
      writeJsonAtomic(this.file, this.data);
    } catch (error) {
      this.storageError = `The approval inbox could not be saved; preserve approvals.json, repair storage and restart. ${(error as Error).message}`;
      throw new ApprovalError(503, this.storageError);
    }
    try { this.onChange?.(); } catch { /* observers cannot undo a saved inbox */ }
  }

  private restore() {
    if (!existsSync(this.file)) return;
    try {
      this.data = parseFile(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch (error) {
      this.storageError = `Cannot restore approvals.json; preserve the file and recover a valid backup. ${(error as Error).message}`;
    }
  }
}

function parseFile(value: unknown): StoredFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('approvals.json must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error('unsupported approvals.json version');
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) throw new Error('revision is invalid');
  if (!Number.isSafeInteger(raw.nextSeq) || (raw.nextSeq as number) < 1) throw new Error('nextSeq is invalid');
  if (!Array.isArray(raw.items)) throw new Error('items must be an array');
  const ids = new Set<string>();
  const sources = new Set<string>();
  const items = raw.items.map((entry, index) => {
    const item = entry as Stored;
    const label = `item #${index + 1}`;
    if (!item || typeof item !== 'object') throw new Error(`${label} must be an object`);
    if (typeof item.id !== 'string' || !APPROVAL_ID_RE.test(item.id) || Number(item.id.slice(1)) >= (raw.nextSeq as number)) throw new Error(`${label} id is invalid`);
    if (item.kind !== 'job_plan' && item.kind !== 'budget_increase' && item.kind !== 'external_action' && item.kind !== 'tool_proposal' && item.kind !== 'chief_proposal' && item.kind !== 'lesson' && item.kind !== 'architect_summary') throw new Error(`${label} kind is invalid`);
    if (item.kind === 'architect_summary') {
      const a = item.architect as unknown as Record<string, unknown> | undefined;
      if (!a || typeof a.runId !== 'string' || typeof a.day !== 'string' || typeof a.engineLabel !== 'string' || !Array.isArray(a.changes)) throw new Error(`${label} architect summary is invalid`);
    }
    if (item.kind === 'lesson') {
      const l = item.lesson as unknown as Record<string, unknown> | undefined;
      if (!l || typeof l !== 'object' || ['lessonId', 'text', 'scope', 'proposedBy'].some((k) => typeof l[k] !== 'string' || (l[k] as string).length > 2000) || !l.source || typeof l.source !== 'object') throw new Error(`${label} lesson is invalid`);
    }
    if (item.kind === 'chief_proposal') {
      const p = item.proposal as unknown as Record<string, unknown> | undefined;
      if (!p || typeof p !== 'object' || ['situation', 'text', 'model'].some((k) => typeof p[k] !== 'string' || (p[k] as string).length > 2000)) throw new Error(`${label} proposal is invalid`);
      const a = p.action as Record<string, unknown> | undefined;
      if (a !== undefined && (!a || a.kind !== 'retry_held' || typeof a.taskId !== 'string' || typeof a.dependencyId !== 'string' || typeof a.label !== 'string')) throw new Error(`${label} proposal action is invalid`);
    }
    if (item.kind === 'tool_proposal') {
      const t = item.tool as Record<string, unknown> | undefined;
      if (!t || typeof t !== 'object' || ['name', 'url', 'licence', 'enables', 'risk'].some((k) => typeof t[k] !== 'string' || (t[k] as string).length > 2000) || !/^https:\/\//.test(t.url as string)) throw new Error(`${label} tool is invalid`);
    }
    if (item.kind === 'external_action' && (!item.outreach || typeof item.outreach.campaignId !== 'string' || !Array.isArray(item.outreach.recipients))) throw new Error(`${label} outreach snapshot is invalid`);
    if (!['pending', 'approved', 'rejected', 'resolved'].includes(item.status)) throw new Error(`${label} status is invalid`);
    if (item.reopenable !== undefined && (item.reopenable !== true || item.status !== 'rejected' || item.kind !== 'budget_increase')) throw new Error(`${label} reopenable is invalid`);
    if (typeof item.source !== 'string' || typeof item.jobId !== 'string' || typeof item.title !== 'string' || typeof item.detail !== 'string') throw new Error(`${label} is incomplete`);
    if (!Number.isSafeInteger(item.createdAt)) throw new Error(`${label} createdAt is invalid`);
    if (item.status !== 'pending' && (!Number.isSafeInteger(item.decidedAt) || typeof item.decidedBy !== 'string')) throw new Error(`${label} decision evidence is invalid`);
    if (ids.has(item.id) || sources.has(item.source)) throw new Error(`${label} is a duplicate`);
    ids.add(item.id);
    sources.add(item.source);
    return { ...item, raisedBy: RAISED_BY[item.kind] };
  });
  return { version: 1, revision: raw.revision as number, nextSeq: raw.nextSeq as number, items };
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** One line for lists (Telegram /approvals): id, kind, title and the money that matters. Never a brief. */
export function approvalLine(item: Approval): string {
  const parts = [item.id, APPROVAL_KIND_LABEL[item.kind], item.title];
  if (item.kind === 'budget_increase') {
    if (item.spentUsd !== undefined && item.approvedBudgetUsd !== undefined) parts.push(`spent ${money(item.spentUsd)} of ${money(item.approvedBudgetUsd)}`);
    if (item.suggestedBudgetUsd !== undefined) parts.push(`suggested ${money(item.suggestedBudgetUsd)}`);
  } else if (item.outreach) parts.push(`${item.outreach.recipients.length} recipient${item.outreach.recipients.length === 1 ? '' : 's'} from ${item.outreach.from}`);
  else if (item.tool) parts.push(item.tool.url, item.tool.licence);
  else if (item.proposal) parts.push(item.proposal.action ? `action: ${item.proposal.action.label}` : 'decision only');
  // Review fix 2: Telegram /approvals shows the whole lesson (and the text an edit replaces), so /approve never decides unseen text.
  else if (item.lesson) parts.push(scopeText(item.lesson), `lesson: ${item.lesson.text}`, ...(item.lesson.supersedes ? [`replaces ${item.lesson.supersedes}: ${item.lesson.supersedesText ?? ''}`] : []), 'decision only');
  else if (item.estimate) parts.push(`estimate ${fmtUsdRange(item.estimate.costUsd)}`);
  return parts.join(' · ');
}

/** The plain-text notification for a new pending item (Telegram and email): no secrets, no action links. */
export function approvalText(item: Approval): string {
  const by = item.kind === 'chief_proposal' ? `model-backed · ${item.proposal?.model ?? 'model'} · proposal only` : item.kind === 'lesson' ? (item.lesson?.proposedBy ?? 'CEO') : item.proposedBy ?? 'rule-based';
  const lines = [`Approval ${item.id} · ${APPROVAL_KIND_LABEL[item.kind]} · raised by ${EXECUTIVES[item.raisedBy].name} (${by})`, item.title, item.detail];
  if (item.proposedBy) lines.push('The chief’s model proposed this plan. Read every item prompt and approve it in the game inbox or on the founder desk; Telegram can only decline it.');
  if (item.proposal) lines.push(`${item.proposal.situation}: ${item.proposal.text}`, item.proposal.action ? `Approving also runs: ${item.proposal.action.label}` : 'Approving records your decision only.');
  if (item.lesson) {
    const l = item.lesson;
    lines.push(`Lesson (${scopeText(l)}): ${l.text}`, `Source: ${SOURCE_LABEL[l.source.kind]} · ${l.source.label}`, ...(l.supersedes ? [`Replaces ${l.supersedes}: ${l.supersedesText ?? ''}`] : []), LESSON_DECISION_NOTE);
  }
  if (item.estimate) lines.push(`Estimate (not a quote): ${fmtUsdRange(item.estimate.costUsd)}${item.estimate.calendarMs ? ` · ${fmtDurationRange(item.estimate.calendarMs)} calendar time` : ''}`);
  if (item.outreach) {
    const o = item.outreach;
    const ex = o.excluded;
    lines.push(`Subject: ${o.samples[0]?.subject ?? '(none)'}`, `${o.recipients.length} recipient${o.recipients.length === 1 ? '' : 's'} · from ${o.from} · at most ${o.dailyCap} a day, one every ${o.intervalSec} s`,
      `Excluded: ${ex.suppressed} suppressed, ${ex.invalid} invalid, ${ex.unconfirmed} unconfirmed`, 'Review the exact message and full recipient list in the game inbox before approving.');
  }
  if (item.kind === 'budget_increase' && item.spentUsd !== undefined) lines.push(`Spend so far: ${money(item.spentUsd)} (${ACTUAL_SPEND_LABEL})${item.suggestedBudgetUsd !== undefined ? ` · suggested new budget ${money(item.suggestedBudgetUsd)}` : ''}`);
  if (item.tool) lines.push(`Tool: ${item.tool.name} · ${item.tool.url} · licence ${item.tool.licence}`, `Enables: ${item.tool.enables}`, `Risk: ${item.tool.risk}`, 'Approving records your decision only; nothing is installed.');
  lines.push(item.proposedBy ? `Review and approve in the game or on the founder desk. /reject ${item.id} declines.` : approveHint(item.id));
  return lines.join('\n');
}
