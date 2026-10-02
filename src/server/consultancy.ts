import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ConsultancyCreateInput, ConsultancyDecision, ConsultancyItem, ConsultancyJob, ConsultancySnapshot, ConsultancyStatus, ConsultancyTaskInput } from '../shared/consultancy.js';
import type { QueueState, QueueTask } from '../shared/protocol.js';
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

interface StoredItem {
  id: string;
  title: string;
  prompt: string;
  jobKey: string;
  queueTaskId?: string;
  /** Runs alongside the item before it (LIFE-04). Absent on items saved before LIFE-04: they run in order. */
  parallel?: true;
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

  constructor(dataDir: string, private readonly queue: QueuePort, private readonly onChange?: () => void) {
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

  create(input: unknown, actor: string): ConsultancyJob {
    this.assertMutable();
    const cleanActor = cleanBounded(actor, 'actor', MAX_ACTOR);
    const clean = validateCreateInput(input);
    const fingerprint = inputFingerprint(clean);
    const known = this.jobs.find((job) => job.requestId === clean.requestId);
    if (known) {
      if (known.requestFingerprint === fingerprint) return this.projectJob(known, this.readQueue()).job;
      throw new ConsultancyError(409, `Request ${clean.requestId} already exists with different content`);
    }
    const now = Date.now();
    const jobId = this.nextId('consultancy');
    const items = clean.tasks.map((task, index) => {
      const itemId = `item-${index + 1}`;
      return { id: itemId, title: task.title, prompt: task.prompt, jobKey: `consultancy:${jobId}:${itemId}`, ...(task.parallel ? { parallel: true as const } : {}) };
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

  approve(id: string, actor: string): ConsultancyJob {
    this.assertMutable();
    const cleanActor = cleanBounded(actor, 'actor', MAX_ACTOR);
    const job = this.requireJob(id);
    if (job.decision === 'rejected') throw new ConsultancyError(409, 'Rejected jobs cannot be approved');
    if (job.decision === 'pending_approval') {
      this.commit(() => {
        job.decision = 'approved';
        job.decidedAt = Date.now();
        job.decidedBy = cleanActor;
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
          let addError: string | undefined;
          try {
            addError = this.queue.add(item.prompt, job.decidedBy ?? job.createdBy, item.title, undefined, item.jobKey, prerequisites.map((dep) => dep.queueTaskId!));
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
    const items = job.items.map((item) => this.projectItem(job, item, queue));
    const weight = Math.max(...items.map((item) => item._weight));
    const status = statusFromWeight(weight);
    const attention = items.find((item) => item.status === 'needs_attention')?.attention;
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
      },
    };
  }

  private projectItem(job: StoredJob, item: StoredItem, queue: QueueRead): ItemProjection {
    if (job.decision === 'pending_approval') return { ...item, status: 'awaiting_approval', _weight: statusWeight('awaiting_approval') };
    if (job.decision === 'rejected') return { ...item, status: 'rejected', _weight: statusWeight('rejected') };
    const state = queue.state;
    const queueFailure = queue.error ?? queue.queueStorageError;
    if (queueFailure) return { ...item, status: 'needs_attention', attention: queueFailure, _weight: statusWeight('needs_attention') };
    const task = findTask(state?.tasks ?? [], item);
    const key = this.itemKey(job.id, item.id);
    if (!task) {
      const reason = this.queueIssues.get(key) ?? (item.queueTaskId ? 'Previously observed queue task is missing; automatic requeue is blocked.' : 'Task is not visible in the queue.');
      return { ...item, status: 'needs_attention', attention: reason, _weight: statusWeight('needs_attention') };
    }
    if (task.status === 'running') return { ...item, status: 'running', _weight: statusWeight('running') };
    if (task.status === 'queued') return { ...item, status: 'queued', _weight: statusWeight('queued') };
    if (task.outcome === 'done') return { ...item, status: 'awaiting_review', _weight: statusWeight('awaiting_review') };
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
  rejectUnknownKeys(raw, ['id', 'requestId', 'requestFingerprint', 'client', 'title', 'brief', 'decision', 'createdAt', 'createdBy', 'decidedAt', 'decidedBy', 'items'], label);
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
  rejectUnknownKeys(raw, ['id', 'title', 'prompt', 'jobKey', 'queueTaskId', 'parallel'], label);
  if (raw.parallel !== undefined && raw.parallel !== true) throw new Error(`${label} parallel must be true when present`);
  return {
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
      rejectUnknownKeys(raw, ['title', 'prompt', 'parallel'], `tasks[${index}]`);
      if (raw.parallel !== undefined && typeof raw.parallel !== 'boolean') throw new ConsultancyError(400, `tasks[${index}].parallel must be a boolean`);
      return canonicalTask({
        title: cleanBounded(raw.title, `tasks[${index}].title`, MAX_TASK_TITLE),
        prompt: cleanBounded(raw.prompt, `tasks[${index}].prompt`, MAX_TASK_PROMPT),
        parallel: raw.parallel === true,
      });
    });
  }
  return { requestId, client, title, brief, tasks };
}

/** A plan task as fingerprinted: `parallel` only when set, so plans saved before LIFE-04 keep their fingerprint. */
function canonicalTask(task: { title: string; prompt: string; parallel?: boolean }): ConsultancyTaskInput {
  return task.parallel ? { title: task.title, prompt: task.prompt, parallel: true } : { title: task.title, prompt: task.prompt };
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

function inputFingerprint(input: Required<ConsultancyCreateInput>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
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
