import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { APPROVAL_ID_RE, MAX_APPROVAL_BUDGET_USD, type Approval, type ApprovalKind, type ApprovalsState, type ApprovalStatus } from '../shared/approvals.js';
import type { ConsultancyApproveOptions, ConsultancyJob, ConsultancySnapshot } from '../shared/consultancy.js';
import { ACTUAL_SPEND_LABEL, basisLabel, fmtUsdRange, type ExecutiveRole } from '../shared/org.js';
import { ConsultancyError } from './consultancy.js';
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

const RAISED_BY: Record<ApprovalKind, ExecutiveRole> = { job_plan: 'chief_of_staff', budget_increase: 'finance' };
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

  private decide(id: string, actor: string, decision: Exclude<ApprovalStatus, 'pending'>, options: DecisionOptions): Approval {
    if (this.storageError) throw new ApprovalError(503, this.storageError);
    const who = cleanActor(actor);
    const requestId = cleanRequestId(options.requestId);
    this.reconcile();
    const item = this.data.items.find((i) => i.id === id);
    if (!item) throw new ApprovalError(404, `Unknown approval: ${id}`);
    // Idempotent: a decided item answers with the decision it already has, whatever is asked now.
    if (item.status !== 'pending') return publicItem(item);
    const budget = decision === 'approved' && options.budgetUsd !== undefined && options.budgetUsd !== null ? validBudget(options.budgetUsd) : undefined;
    this.deciding = true;
    try {
      if (item.kind === 'job_plan') {
        try {
          if (decision === 'approved') this.office.approve(item.jobId, who, budget === undefined ? {} : { budgetUsd: budget });
          else this.office.reject(item.jobId, who);
        } catch (error) {
          // The plan was decided the other way meanwhile: the consultancy decision stands and is reconciled below.
          if (!(error instanceof ConsultancyError && error.status === 409)) throw error;
        }
      } else if (decision === 'approved') {
        const job = this.office.snapshot().jobs.find((j) => j.id === item.jobId);
        if (!job) throw new ApprovalError(404, `Unknown consultancy job: ${item.jobId}`);
        const spent = job.actualSpendUsd ?? item.spentUsd ?? 0;
        const raised = budget ?? suggestBudget(job);
        if (raised <= spent) throw new ApprovalError(400, `The new budget must exceed the ${usd(spent)} already spent`);
        if (job.approvedBudgetUsd !== undefined && raised <= job.approvedBudgetUsd) throw new ApprovalError(400, `The new budget must exceed the approved ${usd(job.approvedBudgetUsd)}`);
        this.office.raiseBudget(item.jobId, raised, who);
        this.record(item, 'approved', who, requestId, raised);
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
    if (!this.reconcile() && item.kind === 'budget_increase') this.save();
    return publicItem(item);
  }

  private record(item: Stored, status: Exclude<ApprovalStatus, 'pending'>, who: string, requestId?: string, budgetUsd?: number) {
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
        this.add({ source, kind: 'job_plan', jobId: job.id, title: `${job.client} · ${job.title}`, detail: planDetail(job), createdAt: at,
          ...(job.estimate ? { estimate: { costUsd: job.estimate.costUsd, calendarMs: job.estimate.calendarMs, basis: job.estimate.basis } } : {}) });
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
      // The hold this item was raised for is gone, so its budget was raised some other way.
      item.status = 'approved';
      item.decidedAt = at;
      item.decidedBy = 'Budget raised outside the inbox';
      if (job.approvedBudgetUsd !== undefined) item.budgetUsd = job.approvedBudgetUsd;
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
    if (item.kind !== 'job_plan' && item.kind !== 'budget_increase') throw new Error(`${label} kind is invalid`);
    if (!['pending', 'approved', 'rejected'].includes(item.status)) throw new Error(`${label} status is invalid`);
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
