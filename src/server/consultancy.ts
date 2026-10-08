import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ConsultancyApproveOptions, ConsultancyCreateInput, ConsultancyDecision, ConsultancyItem, ConsultancyJob, ConsultancySnapshot, ConsultancyStatus, ConsultancyTaskInput } from '../shared/consultancy.js';
import { defaultApprovedBudget, isItemPhase, type BudgetHold, type ItemPhase, type JobEstimate } from '../shared/org.js';
import type { QueueState, QueueTask } from '../shared/protocol.js';
import type { PlannedItem } from './estimate.js';
import { writeJsonAtomic } from './persistence.js';

const JOURNAL_FILE = 'consultancy.json';
const MAX_REQUEST_ID = 120;
const MAX_ACTOR = 120;
const MAX_CLIENT = 160;
const MAX_TITLE = 200;
const MAX_BRIEF = 8_000;
const MAX_TASK_TITLE = 200;
const MAX_TASK_PROMPT = 8_000;
const MAX_TASKS = 8;
/** Approved budgets are USD and bounded; a typo should not authorise unlimited spend. */
const MAX_BUDGET_USD = 100_000;

interface StoredItem {
  id: string;
  title: string;
  prompt: string;
  jobKey: string;
  queueTaskId?: string;
  /** Absent in journals written before ORG-02; means build. */
  phase?: ItemPhase;
  /** Runs alongside the item before it (LIFE-04). Absent on items saved before LIFE-04: they run in order. */
  parallel?: true;
  /** Its queue task was observed finishing with outcome 'done' (so later items may start once it is cleared). */
  finishedOk?: true;
}

interface StoredJob {
  id: string;
  requestId: string;
  requestFingerprint: string;
  client: string;
  title: string;
  brief: string;
  decision: ConsultancyDecision;
  createdAt: number;
  createdBy: string;
  decidedAt?: number;
  decidedBy?: string;
  items: StoredItem[];
  /** ORG-02, all optional so older journals load unchanged: the estimate approved, the budget, and a reached budget. */
  estimate?: JobEstimate;
  approvedBudgetUsd?: number;
  budgetHold?: BudgetHold;
}

interface StoredJournal {
  revision: number;
  jobs: StoredJob[];
}

interface QueueRead {
  state?: QueueState;
  error?: string;
  queueStorageError?: string;
}

interface ItemProjection extends ConsultancyItem {
  _weight: number;
}

interface JobProjection {
  job: ConsultancyJob;
  _weight: number;
}

type QueuePort = {
  state(): QueueState;
  add(prompt: string, by: string, title?: string, issue?: number, jobKey?: string, dependsOn?: readonly string[]): string | undefined;
};

/** Optional ORG-02 inputs: an estimator over past spend, and each queue task's provider-reported list cost. */
export interface ConsultancyOrgPorts {
  estimate?(items: PlannedItem[]): JobEstimate;
  taskCost?(taskId: string): number | undefined;
  /** ORG-05: why a finished item still needs attention (an internal job's artifact was not accepted), or undefined. */
  itemIssue?(jobKey: string): string | undefined;
}

export class ConsultancyError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ConsultancyError';
  }
}

export class Consultancy {
  private readonly journalPath: string;
  private revision = 0;
  private jobs: StoredJob[] = [];
  private storageError?: string;
  private _recoveryError?: string;
  private readonly queueIssues = new Map<string, string>();

  constructor(dataDir: string, private readonly queue: QueuePort, private readonly onChange?: () => void, private readonly ports: ConsultancyOrgPorts = {}) {
    this.journalPath = path.join(dataDir, JOURNAL_FILE);
    this.restore();
    this.reconcile();
  }

  snapshot(): ConsultancySnapshot {
    const queue = this.readQueue();
    const jobs = this.jobs.map((job) => this.projectJob(job, queue).job);
    const storageError = [this.storageError, this._recoveryError, queue.error, queue.queueStorageError].filter(Boolean).join(' ') || undefined;
    return { revision: this.revision, jobs, storageError };
  }

  /** A fresh, unused job id. Internal jobs (Round 2) reserve one so the item prompt can name its artifact path. */
  newJobId(): string {
    return this.nextId('consultancy');
  }

  /** `options.id` (internal callers only, never HTTP): a job id from newJobId(), so prompts can name the artifact path. */
  create(input: unknown, actor: string, options: { id?: string } = {}): ConsultancyJob {
    this.assertMutable();
    const cleanActor = cleanBounded(actor, 'actor', MAX_ACTOR);
    const input0 = validateCreateInput(input);
    const known = this.jobs.find((job) => job.requestId === input0.requestId);
    if (known) {
      if (known.requestFingerprint === inputFingerprint(withJobId(input0, known.id))) return this.projectJob(known, this.readQueue()).job;
      throw new ConsultancyError(409, `Request ${input0.requestId} already exists with different content`);
    }
    const now = Date.now();
    // Internal jobs name their artifact path by job id, two ways: a reserved id (ORG-04a, options.id from newJobId()),
    // or the `{{jobId}}` token in a prompt (ORG-05), which becomes the id before the plan is saved.
    if (options.id !== undefined && (!/^consultancy-[a-f0-9]{12}$/.test(options.id) || this.jobs.some((job) => job.id === options.id))) throw new ConsultancyError(409, 'The reserved job id is invalid or already used');
    const jobId = options.id ?? this.nextId('consultancy');
    const clean = withJobId(input0, jobId);
    const fingerprint = inputFingerprint(clean);
    const items = clean.tasks.map((task, index) => {
      const itemId = `item-${index + 1}`;
      return { id: itemId, title: task.title, prompt: task.prompt, jobKey: `consultancy:${jobId}:${itemId}`, phase: task.phase ?? 'build', ...(task.parallel ? { parallel: true as const } : {}) };
    });
    const job: StoredJob = {
      id: jobId,
      requestId: clean.requestId,
      requestFingerprint: fingerprint,
      client: clean.client,
      title: clean.title,
      brief: clean.brief,
      decision: 'pending_approval',
      createdAt: now,
      createdBy: cleanActor,
      items,
    };
    this.commit(() => { this.jobs.push(job); return true; });
    return this.projectJob(job, this.readQueue()).job;
  }

  approve(id: string, actor: string, options: ConsultancyApproveOptions = {}): ConsultancyJob {
    this.assertMutable();
    const cleanActor = cleanBounded(actor, 'actor', MAX_ACTOR);
    const budget = options.budgetUsd === undefined ? undefined : validBudget(options.budgetUsd);
    const job = this.requireJob(id);
    if (job.decision === 'rejected') throw new ConsultancyError(409, 'Rejected jobs cannot be approved');
    if (job.decision === 'pending_approval') {
      // The estimate the CEO saw is frozen with the decision, so actuals are later compared with it.
      const estimate = this.estimateFor(job);
      this.commit(() => {
        job.decision = 'approved';
        job.decidedAt = Date.now();
        job.decidedBy = cleanActor;
        if (estimate) job.estimate = estimate;
        const approved = budget ?? (estimate ? defaultApprovedBudget(estimate) : undefined);
        if (approved !== undefined) job.approvedBudgetUsd = approved;
        return true;
      });
    }
    this.reconcile();
    return this.projectJob(job, this.readQueue()).job;
  }

  reject(id: string, actor: string): ConsultancyJob {
    this.assertMutable();
    const cleanActor = cleanBounded(actor, 'actor', MAX_ACTOR);
    const job = this.requireJob(id);
    if (job.decision === 'approved') throw new ConsultancyError(409, 'Approved jobs cannot be rejected');
    if (job.decision === 'pending_approval') {
      this.commit(() => {
        job.decision = 'rejected';
        job.decidedAt = Date.now();
        job.decidedBy = cleanActor;
        return true;
      });
    }
    return this.projectJob(job, this.readQueue()).job;
  }

  /**
   * Raises an approved job's budget and releases its held items. ORG-03 calls this when the CEO
   * approves finance's budget_increase; repeating the same raise is a no-op.
   */
  raiseBudget(id: string, budgetUsd: number, actor: string): ConsultancyJob {
    this.assertMutable();
    cleanBounded(actor, 'actor', MAX_ACTOR);
    const budget = validBudget(budgetUsd);
    const job = this.requireJob(id);
    if (job.decision !== 'approved') throw new ConsultancyError(409, 'Only approved jobs have a budget to raise');
    if (job.approvedBudgetUsd === budget && !job.budgetHold) return this.projectJob(job, this.readQueue()).job;
    if (job.approvedBudgetUsd !== undefined && budget <= job.approvedBudgetUsd) throw new ConsultancyError(409, `A raised budget must exceed the approved ${usd(job.approvedBudgetUsd)}`);
    this.commit(() => {
      job.approvedBudgetUsd = budget;
      delete job.budgetHold;
      return true;
    });
    return this.projectJob(job, this.readQueue()).job;
  }

  /** Why the queue must not start this task now: its job reached its approved budget. Running work is never affected. */
  holdReason(task: Pick<QueueTask, 'jobKey' | 'status'>): string | undefined {
    if (task.status !== 'queued' || !task.jobKey?.startsWith('consultancy:')) return undefined;
    const job = this.jobs.find((j) => j.decision === 'approved' && j.items.some((item) => item.jobKey === task.jobKey));
    const hold = job && this.activeHold(job, this.readQueue().state);
    return hold ? holdText(hold) : undefined;
  }

  /**
   * The job's hold, checked live: the persisted budgetHold is the record, but the queue may seat the next item the
   * moment the previous one finishes, before reconcile() writes that record. Spend at or over budget holds at once.
   */
  private activeHold(job: StoredJob, state: QueueState | undefined): BudgetHold | undefined {
    if (job.budgetHold) return job.budgetHold;
    if (job.decision !== 'approved' || job.approvedBudgetUsd === undefined) return undefined;
    const spent = this.jobSpend(job, state);
    return spent !== undefined && spent >= job.approvedBudgetUsd ? { reachedAt: Date.now(), spentUsd: roundUsd(spent), approvedBudgetUsd: job.approvedBudgetUsd } : undefined;
  }

  reconcile(): void {
    if (this._recoveryError || this.storageError) return;
    const previousJobs = structuredClone(this.jobs);
    const previousRevision = this.revision;
    const initialQueue = this.readQueue();
    if (!initialQueue.state) return;
    if (initialQueue.queueStorageError) {
      for (const job of this.jobs) if (job.decision === 'approved') for (const item of job.items) this.queueIssues.set(this.itemKey(job.id, item.id), initialQueue.queueStorageError);
      return;
    }
    let queueState = initialQueue.state;
    let changed = false;
    try {
      // Budget first: a job that reached its budget is held before anything else of it is dispatched.
      for (const job of this.jobs) {
        if (job.decision !== 'approved' || job.approvedBudgetUsd === undefined || job.budgetHold) continue;
        const spent = this.jobSpend(job, queueState);
        if (spent === undefined || spent < job.approvedBudgetUsd) continue;
        job.budgetHold = { reachedAt: Date.now(), spentUsd: roundUsd(spent), approvedBudgetUsd: job.approvedBudgetUsd };
        changed = true;
      }
      for (const job of this.jobs) {
        if (job.decision !== 'approved') continue;
        for (const [index, item] of job.items.entries()) {
          const key = this.itemKey(job.id, item.id);
          if (item.queueTaskId) {
            const observed = queueState.tasks.find((task) => task.id === item.queueTaskId);
            if (!observed || observed.jobKey !== item.jobKey) {
              this.queueIssues.set(key, 'Previously observed queue task is missing; automatic requeue is blocked.');
              continue;
            }
            this.queueIssues.delete(key);
            // Remember a successful finish, so a later item still counts it once the queue forgets the task.
            if (observed.status === 'done' && observed.outcome === 'done' && !item.finishedOk) { item.finishedOk = true; changed = true; }
            continue;
          }
          const existing = queueState.tasks.find((task) => task.jobKey === item.jobKey);
          if (existing) {
            item.queueTaskId = existing.id;
            this.queueIssues.delete(key);
            changed = true;
            continue;
          }
          // Order within the job: never dispatch an item before the items it waits for are on the queue.
          const prerequisites = itemDependencies(job.items, index);
          const missing = prerequisites.find((dep) => !dep.queueTaskId);
          if (missing) {
            this.queueIssues.set(key, `Waiting for ${missing.id} to reach the queue first.`);
            continue;
          }
          // A prerequisite that finished successfully and was then cleared from the queue is satisfied. One that vanished
          // without ever being seen to finish needs the CEO: never wait on it forever.
          const gone = prerequisites.filter((dep) => !queueState.tasks.some((task) => task.id === dep.queueTaskId));
          const lost = gone.find((dep) => !dep.finishedOk);
          if (lost) {
            this.queueIssues.set(key, `${lost.id} (“${lost.title}”) left the queue without finishing, so this item will not start. Review the job and re-plan it.`);
            continue;
          }
          const waitFor = prerequisites.filter((dep) => !gone.includes(dep)).map((dep) => dep.queueTaskId!);
          let addError: string | undefined;
          try {
            addError = this.queue.add(item.prompt, job.decidedBy ?? job.createdBy, item.title, undefined, item.jobKey, waitFor);
          } catch (error) {
            addError = (error as Error).message;
          }
          if (addError) {
            this.queueIssues.set(key, `Queue refused dispatch: ${addError}`);
            continue;
          }
          const refreshed = this.readQueue();
          if (!refreshed.state) {
            this.queueIssues.set(key, refreshed.error ?? 'Queue state unavailable after dispatch');
            continue;
          }
          queueState = refreshed.state;
          const added = queueState.tasks.find((task) => task.jobKey === item.jobKey);
          if (!added) {
            this.queueIssues.set(key, 'Queue accepted dispatch but no matching task is visible.');
            continue;
          }
          item.queueTaskId = added.id;
          this.queueIssues.delete(key);
          changed = true;
        }
      }
      if (changed) {
        this.revision += 1;
        this.persist();
        this.notifyChange();
      }
    } catch {
      this.jobs = previousJobs;
      this.revision = previousRevision;
      // reconcile must stay non-throwing.
    }
  }

  get recoveryError(): string | undefined {
    return this._recoveryError ?? this.storageError;
  }

  private projectJob(job: StoredJob, queue: QueueRead): JobProjection {
    const estimate = job.decision === 'pending_approval' ? this.estimateFor(job) : job.estimate;
    const hold = this.activeHold(job, queue.state);
    const items = job.items.map((item, index) => {
      const projected = this.projectItem(job, item, queue);
      const cost = this.itemCost(item, queue.state);
      if (estimate?.items[index]) projected.estimate = estimate.items[index];
      if (cost !== undefined) projected.actualSpendUsd = roundUsd(cost);
      if (hold && projected.status === 'queued') projected.held = true;
      return projected;
    });
    const weight = Math.max(...items.map((item) => item._weight));
    const status = statusFromWeight(weight);
    const attention = items.find((item) => item.status === 'needs_attention')?.attention
      ?? (hold && items.some((item) => item.held) ? holdText(hold) : undefined);
    const spent = this.jobSpend(job, queue.state);
    return {
      _weight: weight,
      job: {
        id: job.id,
        requestId: job.requestId,
        client: job.client,
        title: job.title,
        brief: job.brief,
        decision: job.decision,
        status,
        createdAt: job.createdAt,
        createdBy: job.createdBy,
        decidedAt: job.decidedAt,
        decidedBy: job.decidedBy,
        items: items.map(({ _weight: _drop, ...publicItem }) => publicItem),
        attention,
        ...(estimate ? { estimate } : {}),
        ...(job.approvedBudgetUsd !== undefined ? { approvedBudgetUsd: job.approvedBudgetUsd } : {}),
        ...(spent !== undefined ? { actualSpendUsd: roundUsd(spent) } : {}),
        ...(job.budgetHold ? { budgetHold: { ...job.budgetHold } } : {}),
      },
    };
  }

  private estimateFor(job: StoredJob): JobEstimate | undefined {
    if (!this.ports.estimate) return undefined;
    try {
      return this.ports.estimate(job.items.map((item) => ({ phase: item.phase ?? 'build', ...(item.parallel ? { parallel: true } : {}) })));
    } catch {
      return undefined; // An estimate is advisory; a failing estimator never blocks the plan.
    }
  }

  private itemCost(item: StoredItem, state: QueueState | undefined): number | undefined {
    if (!this.ports.taskCost) return undefined;
    const taskId = item.queueTaskId ?? state?.tasks.find((task) => task.jobKey === item.jobKey)?.id;
    if (!taskId) return undefined;
    try {
      const cost = this.ports.taskCost(taskId);
      return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
    } catch {
      return undefined;
    }
  }

  /** Provider-reported list cost of the workers that ran this job's items; undefined while nothing is recorded. */
  private jobSpend(job: StoredJob, state: QueueState | undefined): number | undefined {
    const costs = job.items.map((item) => this.itemCost(item, state)).filter((cost): cost is number => cost !== undefined);
    return costs.length ? costs.reduce((total, cost) => total + cost, 0) : undefined;
  }

  private projectItem(job: StoredJob, stored: StoredItem, queue: QueueRead): ItemProjection {
    const item = { ...stored, phase: stored.phase ?? 'build' };
    if (job.decision === 'pending_approval') return { ...item, status: 'awaiting_approval', _weight: statusWeight('awaiting_approval') };
    if (job.decision === 'rejected') return { ...item, status: 'rejected', _weight: statusWeight('rejected') };
    const state = queue.state;
    const queueFailure = queue.error ?? queue.queueStorageError;
    if (queueFailure) return { ...item, status: 'needs_attention', attention: queueFailure, _weight: statusWeight('needs_attention') };
    const task = findTask(state?.tasks ?? [], item);
    const key = this.itemKey(job.id, item.id);
    // Finished successfully, then cleared from the queue: still delivered work, not a problem.
    const issue = this.ports.itemIssue?.(item.jobKey);
    if (!task && item.finishedOk) return issue ? { ...item, status: 'needs_attention', attention: issue, _weight: statusWeight('needs_attention') } : { ...item, status: 'awaiting_review', _weight: statusWeight('awaiting_review') };
    if (!task) {
      const reason = this.queueIssues.get(key) ?? (item.queueTaskId ? 'Previously observed queue task is missing; automatic requeue is blocked.' : 'Task is not visible in the queue.');
      return { ...item, status: 'needs_attention', attention: reason, _weight: statusWeight('needs_attention') };
    }
    if (task.status === 'running') return { ...item, status: 'running', _weight: statusWeight('running') };
    if (task.status === 'queued') return { ...item, status: 'queued', _weight: statusWeight('queued') };
    if (task.outcome === 'done') return issue ? { ...item, status: 'needs_attention', attention: issue, _weight: statusWeight('needs_attention') } : { ...item, status: 'awaiting_review', _weight: statusWeight('awaiting_review') };
    const reason = task.interruption ? `Queue interruption: ${task.interruption.reason}` : task.error ?? (task.outcome ? `Queue task ended with ${task.outcome}` : 'Queue task ended without success');
    return { ...item, status: 'needs_attention', attention: reason, _weight: statusWeight('needs_attention') };
  }

  private readQueue(): QueueRead {
    try {
      const state = this.queue.state();
      return { state, queueStorageError: extractQueueStorageError(state) };
    } catch (error) {
      return { error: `Queue state is unavailable: ${(error as Error).message}` };
    }
  }

  private commit(mutation: () => boolean, skipGuard = false): void {
    if (!skipGuard) this.assertMutable();
    const previousJobs = structuredClone(this.jobs);
    const previousRevision = this.revision;
    const changed = mutation();
    if (!changed) return;
    try {
      this.revision += 1;
      this.persist();
      this.notifyChange();
    } catch (error) {
      this.jobs = previousJobs;
      this.revision = previousRevision;
      throw error;
    }
  }

  private notifyChange() {
    try { this.onChange?.(); } catch { /* Observers cannot undo a committed journal. */ }
  }

  private persist() {
    try {
      writeJsonAtomic(this.journalPath, { revision: this.revision, jobs: this.jobs } satisfies StoredJournal);
    } catch (error) {
      this.storageError = `Consultancy journal could not be saved; preserve consultancy.json, repair storage and restart. ${(error as Error).message}`;
      throw new ConsultancyError(503, this.storageError);
    }
  }

  private restore() {
    if (!existsSync(this.journalPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.journalPath, 'utf8')) as unknown;
      const journal = parseJournal(parsed);
      this.revision = journal.revision;
      this.jobs = journal.jobs;
    } catch (error) {
      this._recoveryError = `Cannot restore consultancy.json; preserve the file and recover a valid backup. ${(error as Error).message}`;
    }
  }

  private assertMutable() {
    if (this._recoveryError) throw new ConsultancyError(503, this._recoveryError);
    if (this.storageError) throw new ConsultancyError(503, this.storageError);
  }

  private requireJob(id: string): StoredJob {
    const job = this.jobs.find((entry) => entry.id === id);
    if (!job) throw new ConsultancyError(404, `Unknown consultancy job: ${id}`);
    return job;
  }

  private nextId(prefix: string): string {
    let next = '';
    do next = `${prefix}-${randomBytes(6).toString('hex')}`;
    while (this.jobs.some((job) => job.id === next));
    return next;
  }

  private itemKey(jobId: string, itemId: string): string {
    return `${jobId}:${itemId}`;
  }
}

function parseJournal(value: unknown): StoredJournal {
  const root = asObject(value, 'consultancy journal');
  rejectUnknownKeys(root, ['revision', 'jobs'], 'consultancy journal');
  const revision = asSafeInteger(root.revision, 'consultancy revision');
  if (revision < 0) throw new Error('consultancy revision cannot be negative');
  if (!Array.isArray(root.jobs)) throw new Error('consultancy jobs must be an array');
  const jobs = root.jobs.map((entry, index) => parseStoredJob(entry, index));
  const ids = new Set<string>();
  const requests = new Set<string>();
  for (const job of jobs) {
    if (ids.has(job.id)) throw new Error(`duplicate job id: ${job.id}`);
    if (requests.has(job.requestId)) throw new Error(`duplicate requestId: ${job.requestId}`);
    ids.add(job.id); requests.add(job.requestId);
  }
  return { revision, jobs };
}

function parseStoredJob(value: unknown, index: number): StoredJob {
  const label = `job #${index + 1}`;
  const raw = asObject(value, label);
  rejectUnknownKeys(raw, ['id', 'requestId', 'requestFingerprint', 'client', 'title', 'brief', 'decision', 'createdAt', 'createdBy', 'decidedAt', 'decidedBy', 'items', 'estimate', 'approvedBudgetUsd', 'budgetHold'], label);
  const decision = asDecision(raw.decision, `${label} decision`);
  if (!Array.isArray(raw.items)) throw new Error(`${label} items must be an array`);
  if (raw.items.length === 0 || raw.items.length > MAX_TASKS) throw new Error(`${label} items must contain 1-${MAX_TASKS} entries`);
  const items = raw.items.map((entry, itemIndex) => parseStoredItem(entry, `${label} item #${itemIndex + 1}`));
  const job: StoredJob = {
    id: cleanBounded(raw.id, `${label} id`, 200),
    requestId: cleanBounded(raw.requestId, `${label} requestId`, MAX_REQUEST_ID),
    requestFingerprint: cleanBounded(raw.requestFingerprint, `${label} fingerprint`, 500_000),
    client: cleanBounded(raw.client, `${label} client`, MAX_CLIENT),
    title: cleanBounded(raw.title, `${label} title`, MAX_TITLE),
    brief: cleanBounded(raw.brief, `${label} brief`, MAX_BRIEF),
    decision,
    createdAt: asSafeInteger(raw.createdAt, `${label} createdAt`),
    createdBy: cleanBounded(raw.createdBy, `${label} createdBy`, MAX_ACTOR),
    decidedAt: raw.decidedAt === undefined ? undefined : asSafeInteger(raw.decidedAt, `${label} decidedAt`),
    decidedBy: raw.decidedBy === undefined ? undefined : cleanBounded(raw.decidedBy, `${label} decidedBy`, MAX_ACTOR),
    items,
  };
  if (raw.estimate !== undefined) job.estimate = parseEstimate(raw.estimate, `${label} estimate`);
  if (raw.approvedBudgetUsd !== undefined) job.approvedBudgetUsd = parseBudget(raw.approvedBudgetUsd, `${label} approvedBudgetUsd`);
  if (raw.budgetHold !== undefined) job.budgetHold = parseHold(raw.budgetHold, `${label} budgetHold`);
  if (job.decision !== 'approved' && (job.estimate || job.approvedBudgetUsd !== undefined || job.budgetHold)) throw new Error(`${label} budget evidence requires approval`);
  if (!/^consultancy-[a-f0-9]{12}$/.test(job.id) || job.createdAt < 0) throw new Error(`${label} identity is invalid`);
  const taskIds = new Set<string>();
  job.items.forEach((item, i) => {
    if (item.id !== `item-${i + 1}` || item.jobKey !== `consultancy:${job.id}:${item.id}`) throw new Error(`${label} work identity is invalid`);
    if (item.queueTaskId) {
      if (job.decision !== 'approved' || taskIds.has(item.queueTaskId)) throw new Error(`${label} queue binding is invalid`);
      taskIds.add(item.queueTaskId);
    }
  });
  if (job.decision === 'pending_approval' ? job.decidedAt !== undefined || job.decidedBy !== undefined : job.decidedAt === undefined || job.decidedAt < 0 || !job.decidedBy)
    throw new Error(`${label} decision evidence is invalid`);
  const canonical = {requestId: job.requestId, client: job.client, title: job.title, brief: job.brief, tasks: job.items.map(item => canonicalTask(item))};
  const fingerprint = inputFingerprint(canonical);
  // Accept the pre-release JSON fingerprint only when it matches the complete saved plan.
  if (job.requestFingerprint !== fingerprint && job.requestFingerprint !== JSON.stringify(canonical)) throw new Error(`${label} plan fingerprint does not match`);
  job.requestFingerprint = fingerprint;
  return job;
}

function parseStoredItem(value: unknown, label: string): StoredItem {
  const raw = asObject(value, label);
  rejectUnknownKeys(raw, ['id', 'title', 'prompt', 'jobKey', 'queueTaskId', 'phase', 'parallel', 'finishedOk'], label);
  if (raw.phase !== undefined && !isItemPhase(raw.phase)) throw new Error(`${label} phase is invalid`);
  if (raw.parallel !== undefined && raw.parallel !== true) throw new Error(`${label} parallel must be true when present`);
  if (raw.finishedOk !== undefined && (raw.finishedOk !== true || raw.queueTaskId === undefined)) throw new Error(`${label} finishedOk is invalid`);
  return {
    ...(raw.phase !== undefined ? { phase: raw.phase as ItemPhase } : {}),
    ...(raw.finishedOk === true ? { finishedOk: true as const } : {}),
    ...(raw.parallel === true ? { parallel: true as const } : {}),
    id: cleanBounded(raw.id, `${label} id`, 100),
    title: cleanBounded(raw.title, `${label} title`, MAX_TASK_TITLE),
    prompt: cleanBounded(raw.prompt, `${label} prompt`, MAX_TASK_PROMPT),
    jobKey: cleanBounded(raw.jobKey, `${label} jobKey`, 240),
    queueTaskId: raw.queueTaskId === undefined ? undefined : cleanBounded(raw.queueTaskId, `${label} queueTaskId`, 120),
  };
}

function validateCreateInput(input: unknown): Required<ConsultancyCreateInput> {
  const root = asObject(input, 'consultancy request');
  rejectUnknownKeys(root, ['requestId', 'client', 'title', 'brief', 'tasks'], 'consultancy request');
  const requestId = cleanBounded(root.requestId, 'requestId', MAX_REQUEST_ID);
  const client = cleanBounded(root.client, 'client', MAX_CLIENT);
  const title = cleanBounded(root.title, 'title', MAX_TITLE);
  const brief = cleanBounded(root.brief, 'brief', MAX_BRIEF);
  let tasks: ConsultancyTaskInput[];
  if (root.tasks === undefined) tasks = [{ title, prompt: brief }];
  else {
    if (!Array.isArray(root.tasks)) throw new ConsultancyError(400, 'tasks must be an array');
    if (root.tasks.length === 0) throw new ConsultancyError(400, 'tasks must include at least one item');
    if (root.tasks.length > MAX_TASKS) throw new ConsultancyError(400, `tasks may include at most ${MAX_TASKS} items`);
    tasks = root.tasks.map((entry, index) => {
      const raw = asObject(entry, `tasks[${index}]`);
      rejectUnknownKeys(raw, ['title', 'prompt', 'parallel', 'phase'], `tasks[${index}]`);
      if (raw.parallel !== undefined && typeof raw.parallel !== 'boolean') throw new ConsultancyError(400, `tasks[${index}].parallel must be a boolean`);
      if (raw.phase !== undefined && !isItemPhase(raw.phase)) throw new ConsultancyError(400, `tasks[${index}].phase must be build, iteration, testing or field_testing`);
      return canonicalTask({
        title: cleanBounded(raw.title, `tasks[${index}].title`, MAX_TASK_TITLE),
        prompt: cleanBounded(raw.prompt, `tasks[${index}].prompt`, MAX_TASK_PROMPT),
        parallel: raw.parallel === true,
        phase: raw.phase as ItemPhase | undefined,
      });
    });
  }
  return { requestId, client, title, brief, tasks };
}

/**
 * A plan task as fingerprinted: `parallel` only when set (LIFE-04) and `phase` only when not the default build
 * (ORG-02), so plans saved before either keep their fingerprint.
 */
function canonicalTask(task: { title: string; prompt: string; parallel?: boolean; phase?: ItemPhase }): ConsultancyTaskInput {
  return {
    title: task.title,
    prompt: task.prompt,
    ...(task.parallel ? { parallel: true } : {}),
    ...(task.phase && task.phase !== 'build' ? { phase: task.phase } : {}),
  };
}

/**
 * The items item `index` waits for. An ordered item waits for the item before it and, when that one runs in
 * parallel, for the whole parallel run back to (and including) the ordered item it started beside. A parallel item
 * shares the dependencies of the item before it, so it runs alongside that item. The first item waits for nothing.
 */
export function itemDependencies<T extends { parallel?: true }>(items: readonly T[], index: number): T[] {
  if (index <= 0) return [];
  if (items[index].parallel) return itemDependencies(items, index - 1);
  const out: T[] = [];
  for (let i = index - 1; i >= 0; i--) {
    out.unshift(items[i]);
    if (!items[i].parallel) break;
  }
  return out;
}

/** Replaces the `{{jobId}}` token in task prompts (ORG-05 internal jobs); plans without it are unchanged. */
function withJobId(input: Required<ConsultancyCreateInput>, jobId: string): Required<ConsultancyCreateInput> {
  if (!input.tasks.some((task) => task.prompt.includes('{{jobId}}'))) return input;
  return { ...input, tasks: input.tasks.map((task) => ({ ...task, prompt: task.prompt.replaceAll('{{jobId}}', jobId) })) };
}

function inputFingerprint(input: Required<ConsultancyCreateInput>): string {
  return createHash('sha256').update(JSON.stringify({ ...input, tasks: input.tasks.map(canonicalTask) })).digest('hex');
}

const roundUsd = (n: number) => Math.round(n * 1e6) / 1e6;
const usd = (n: number) => `$${n.toFixed(2)}`;

function holdText(hold: BudgetHold): string {
  return `Held: the approved ${usd(hold.approvedBudgetUsd)} budget was reached (${usd(hold.spentUsd)} provider-reported list cost). Running work continues; unstarted items wait for a budget increase.`;
}

function validBudget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_BUDGET_USD) throw new ConsultancyError(400, `budgetUsd must be a number above 0 and at most ${MAX_BUDGET_USD}`);
  return Math.round(value * 100) / 100;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

function parseBudget(value: unknown, label: string): number {
  const n = finiteNumber(value, label);
  if (n <= 0 || n > MAX_BUDGET_USD) throw new Error(`${label} is out of range`);
  return n;
}

function parseHold(value: unknown, label: string): BudgetHold {
  const raw = asObject(value, label);
  rejectUnknownKeys(raw, ['reachedAt', 'spentUsd', 'approvedBudgetUsd'], label);
  return { reachedAt: asSafeInteger(raw.reachedAt, `${label} reachedAt`), spentUsd: finiteNumber(raw.spentUsd, `${label} spentUsd`), approvedBudgetUsd: parseBudget(raw.approvedBudgetUsd, `${label} approvedBudgetUsd`) };
}

/** The frozen estimate is evidence of what the CEO approved; it must be well formed, never re-derived. */
function parseEstimate(value: unknown, label: string): JobEstimate {
  const raw = asObject(value, label);
  const range = (v: unknown, l: string) => {
    const r = asObject(v, l);
    const low = finiteNumber(r.low, `${l} low`);
    const high = finiteNumber(r.high, `${l} high`);
    if (high < low) throw new Error(`${l} is inverted`);
    return { low, high };
  };
  const basis = (v: unknown, l: string) => {
    const b = asObject(v, l);
    if (b.source !== 'history' && b.source !== 'default') throw new Error(`${l} source is invalid`);
    return { samples: asSafeInteger(b.samples, `${l} samples`), source: b.source as 'history' | 'default' };
  };
  if (!Array.isArray(raw.items)) throw new Error(`${label} items must be an array`);
  return {
    costUsd: range(raw.costUsd, `${label} costUsd`),
    calendarMs: range(raw.calendarMs, `${label} calendarMs`),
    items: raw.items.map((entry, i) => {
      const item = asObject(entry, `${label} item #${i + 1}`);
      if (!isItemPhase(item.phase)) throw new Error(`${label} item #${i + 1} phase is invalid`);
      return { phase: item.phase, costUsd: range(item.costUsd, `${label} item cost`), durationMs: range(item.durationMs, `${label} item duration`), basis: basis(item.basis, `${label} item basis`) };
    }),
    basis: basis(raw.basis, `${label} basis`),
    maxWorkers: asSafeInteger(raw.maxWorkers, `${label} maxWorkers`),
    estimatedAt: asSafeInteger(raw.estimatedAt, `${label} estimatedAt`),
  };
}

function findTask(tasks: QueueTask[], item: StoredItem): QueueTask | undefined {
  if (item.queueTaskId) {
    const byId = tasks.find((task) => task.id === item.queueTaskId);
    return byId?.jobKey === item.jobKey ? byId : undefined;
  }
  return tasks.find((task) => task.jobKey === item.jobKey);
}

function statusWeight(status: ConsultancyStatus): number {
  switch (status) {
    case 'needs_attention': return 5;
    case 'running': return 4;
    case 'queued': return 3;
    case 'awaiting_review': return 2;
    case 'awaiting_approval': return 1;
    case 'rejected': return 0;
  }
}

function statusFromWeight(weight: number): ConsultancyStatus {
  if (weight >= 5) return 'needs_attention';
  if (weight >= 4) return 'running';
  if (weight >= 3) return 'queued';
  if (weight >= 2) return 'awaiting_review';
  if (weight >= 1) return 'awaiting_approval';
  return 'rejected';
}

function asDecision(value: unknown, label: string): ConsultancyDecision {
  if (value === 'pending_approval' || value === 'approved' || value === 'rejected') return value;
  throw new Error(`${label} is invalid`);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConsultancyError(400, `${label} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, known: string[], label: string) {
  const set = new Set(known);
  for (const key of Object.keys(value)) if (!set.has(key)) throw new ConsultancyError(400, `${label} includes an unknown key: ${key}`);
}

function cleanBounded(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new ConsultancyError(400, `${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new ConsultancyError(400, `${label} cannot be empty`);
  if (trimmed.length > maxLength) throw new ConsultancyError(400, `${label} exceeds max length ${maxLength}`);
  return trimmed;
}

function asSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value as number;
}

function extractQueueStorageError(state: QueueState): string | undefined {
  const raw = state as QueueState & { storageError?: unknown; recoveryError?: unknown; error?: unknown };
  for (const candidate of [raw.storageError, raw.recoveryError, raw.error]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}
