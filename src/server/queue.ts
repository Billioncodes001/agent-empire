import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { GhPull, QueueState, QueueTask, WorkerInfo, WorkerStatus } from '../shared/protocol.js';
import { DESKS, DESK_BY_ID } from '../shared/layout.js';
import { writeJsonAtomic } from './persistence.js';

/** What the queue needs from the worker manager. Narrow on purpose, so a smoke test can fake it. */
export interface QueueWorkers {
  list(): WorkerInfo[];
  workstationCapacity?(): number;
  deskOccupied(deskId: string): boolean;
  spawn(deskId: string, by: string, prompt: string, worktree: boolean, kind?: 'agent', queueOwned?: boolean): WorkerInfo | string;
  claimQueueWorker?(id: string): void;
  /** Resolves with a line about what became of the worker's worktree. */
  kill(id: string): Promise<{ note?: string; error?: string }>;
}

export interface QueueEvents {
  update(state: QueueState): void;
  toast(text: string, level: 'info' | 'warn' | 'error'): void;
  /** Mark the issue as taken on GitHub, so the board moves it to In progress. Resolves to an error message when it can't. */
  claimIssue(issue: number): Promise<string | undefined>;
  /** Ask GitHub for fresh pull requests, to pick up the one a worker just opened. */
  refreshGitHub(): void;
  /** Why no workers may be hired right now (today's budget is spent), if that's so. */
  hiringPaused(): string | undefined;
  /** Current manager ownership can reject superseded startup tasks, including legacy keys. */
  retryAllowed?(task: QueueTask): string | undefined;
}

export const DEFAULT_MAX_WORKERS = 3;
const MAX_TASKS = 100;
const PUMP_MS = 10_000;
/** A worker in one of these states holds a slot under the worker limit. */
const BUSY = new Set<WorkerStatus>(['starting', 'idle', 'working', 'needs_input']);
/** A worker in one of these states is finished with its task (and can make room for the next one). */
const FINISHED = new Set<WorkerStatus>(['done', 'exited', 'offline']);

const WORKTREE_NOTE = "\n\nYou're in your own git worktree, on a fresh branch made for this task. Commit there, push it, and open the pull request from it.";

/**
 * The 📋 task queue. Tasks (GitHub issues or free text) wait in order; whenever a desk is free and
 * fewer than `maxWorkers` workers are busy, the next one is seated as a worktree worker. A running
 * task finishes when its worker ends its turn, stops, or is sent home. Finished workers stay at
 * their desks to be looked at, until the queue needs the desk for the next task.
 */
export class TaskQueue {
  private tasks: QueueTask[] = [];
  private maxWorkers = DEFAULT_MAX_WORKERS;
  private statePath: string;
  private timer: NodeJS.Timeout;
  private pumping = false;
  private again = false;
  /** Set on shutdown: the workers' exit events must not seat anyone into a dying office. */
  private stopped = false;
  private lastStatus = new Map<string, WorkerStatus>();
  private releasedWorkers = new Set<string>();
  private recycling = new Set<string>();
  private storageError?: string;

  constructor(
    dataDir: string,
    private workers: QueueWorkers,
    /** Seat workers in their own git worktree (only when the project is a git repo). */
    private useWorktree: boolean,
    private events: QueueEvents,
    /** Startup approval is transient; retain the user's saved concurrency preference. */
    private pauseOnStart = false,
  ) {
    this.statePath = path.join(dataDir, 'queue.json');
    this.restore();
    for (const task of this.tasks) if (task.workerId) this.workers.claimQueueWorker?.(task.workerId);
    this.timer = setInterval(() => this.pump(), PUMP_MS);
  }

  state(): QueueState {
    return { tasks: this.tasks.map((t) => ({ ...t })), maxWorkers: this.limit };
  }

  get limit(): number {
    return this.pauseOnStart ? 0 : this.maxWorkers;
  }
  get recoveryError() { return this.storageError; }

  add(prompt: string, by: string, title?: string, issue?: number, jobKey?: string): string | undefined {
    if (this.storageError) return this.storageError;
    if (jobKey && this.tasks.some(t => t.jobKey === jobKey)) return;
    const clean = prompt.replace(/\r\n?/g, '\n').trim();
    if (!clean) return 'Empty task';
    if (issue !== undefined && this.tasks.some((t) => t.issue === issue && t.status !== 'done')) return `Issue #${issue} is already on the queue`;
    if (this.tasks.filter((t) => t.status !== 'done').length >= MAX_TASKS) return `The queue is full (${MAX_TASKS} tasks)`;
    const task: QueueTask = {
      id: randomBytes(6).toString('hex'),
      jobKey,
      issue,
      title: (title?.trim() || firstLine(clean)).slice(0, 120),
      prompt: clean,
      addedBy: by,
      addedAt: Date.now(),
      status: 'queued',
      attempt: 1,
    };
    this.tasks.push(task);
    if (!this.changed()) return this.storageError;
    this.pump();
    return undefined;
  }

  remove(taskId: string): string | undefined {
    if (this.storageError) return this.storageError;
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return 'No such task';
    if (t.status === 'running') return `${t.workerName ?? 'Its worker'} is on it — send the worker home to stop it`;
    const blocked = this.recoveryBlocker(t);
    if (blocked) return blocked;
    this.tasks.splice(this.tasks.indexOf(t), 1);
    if (!this.changed()) return this.storageError;
    this.pump();
    return undefined;
  }

  /** Moves a queued task one place up (-1) or down (+1) among the queued tasks. */
  move(taskId: string, delta: -1 | 1) {
    if (this.storageError) return;
    const queued = this.tasks.filter((t) => t.status === 'queued');
    const i = queued.findIndex((t) => t.id === taskId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= queued.length) return;
    const a = this.tasks.indexOf(queued[i]);
    const b = this.tasks.indexOf(queued[j]);
    [this.tasks[a], this.tasks[b]] = [this.tasks[b], this.tasks[a]];
    this.changed();
    this.pump();
  }

  /** Puts a finished task back at the end of the queue. */
  retry(taskId: string): string | undefined {
    if (this.storageError) return this.storageError;
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return 'No such task';
    if (t.status !== 'done') return 'That task is still on the queue';
    const authority = this.events.retryAllowed?.(t) ?? this.managerSiblingBlocker(t.jobKey, t.id);
    if (authority) return authority;
    const blocked = this.recoveryBlocker(t);
    if (blocked) return blocked;
    if (t.issue !== undefined && this.tasks.some((x) => x !== t && x.issue === t.issue && x.status !== 'done')) return `Issue #${t.issue} is already on the queue`;
    this.tasks.splice(this.tasks.indexOf(t), 1);
    const fresh: QueueTask = { id: t.id, jobKey: t.jobKey, issue: t.issue, title: t.title, prompt: t.prompt, addedBy: t.addedBy, addedAt: Date.now(), status: 'queued', attempt: (t.attempt ?? 1) + 1 };
    this.tasks.push(fresh);
    if (!this.changed()) return this.storageError;
    this.pump();
    return undefined;
  }

  /** Forgets the finished tasks. */
  clear() {
    if (this.storageError) return;
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.status !== 'done' || this.recoveryBlocker(t));
    if (this.tasks.some(t => t.status === 'done')) this.events.toast('Kept task history for running or unknown workers. Confirm their processes stopped before clearing.', 'warn');
    if (this.tasks.length !== before) this.changed();
  }

  setLimit(n: number) {
    if (this.storageError) return;
    const v = Math.max(0, Math.min(this.capacity(), Math.floor(n)));
    if (!Number.isFinite(v) || (v === this.maxWorkers && !this.pauseOnStart)) return;
    this.pauseOnStart = false;
    if (v !== this.maxWorkers) {
      this.maxWorkers = v;
      if (!this.changed()) return;
    } else this.events.update(this.state());
    this.pump();
  }

  /** A worker changed. Cheap unless its status moved, which can free a slot or finish a task. */
  onWorker(info: WorkerInfo) {
    if (this.lastStatus.get(info.id) === info.status) return;
    this.lastStatus.set(info.id, info.status);
    this.pump();
  }

  onWorkerGone(workerId: string) {
    // WorkerManager emits removal only after its process has been confirmed stopped.
    this.releasedWorkers.add(workerId);
    this.lastStatus.delete(workerId);
    this.changed();
    this.pump();
  }

  /** Shared by task retry/removal and manager retry; history must not erase uncertain work. */
  recoveryBlocker(task: QueueTask): string | undefined {
    if (this.storageError) return this.storageError;
    if (!task.workerId) return task.interruption ? 'Interrupted launch has no confirmed worker link. Inspect the original processes before recovery; task history has been preserved.' : undefined;
    if (this.releasedWorkers.has(task.workerId)) return undefined;
    const worker = this.workers.list().find(w => w.id === task.workerId);
    if (worker?.processState === 'stopped') return undefined;
    return worker?.processState === 'running'
      ? `${worker.name ?? 'The previous worker'} is still running. Send it home and wait for it to stop before retrying or removing this task.`
      : `Previous worker ${task.workerId} has unknown process state. ${worker?.activity ?? 'Inspect and stop the original process before recovery.'} Task history has been preserved.`;
  }

  managerRetryBlocker(jobKey: string, workerId?: string): string | undefined {
    const task = this.tasks.find(t => t.jobKey === jobKey);
    if (task?.status === 'running' || task?.status === 'queued') return 'Manager startup is already queued or running';
    return this.managerSiblingBlocker(jobKey, task?.id) ?? this.recoveryBlocker(task ?? { workerId } as QueueTask);
  }

  private managerSiblingBlocker(jobKey?: string, taskId?: string): string | undefined {
    const family = managerFamily(jobKey);
    if (!family) return;
    for (const task of this.tasks) {
      if (task.id === taskId || managerFamily(task.jobKey) !== family) continue;
      if (task.status !== 'done') return 'Another startup attempt for this manager is queued or running. Review that attempt before recovery.';
      const blocked = this.recoveryBlocker(task);
      if (blocked) return blocked;
    }
  }

  /** Fresh pull requests from GitHub: link each task to the PR that closes its issue (or came from its branch). */
  onPulls(pulls: GhPull[]) {
    let changed = false;
    for (const t of this.tasks) {
      if (t.status === 'queued') continue;
      const since = (t.startedAt ?? t.addedAt) - 60_000;
      const match = pulls
        .filter((p) => (t.branch && p.headRefName === t.branch) || (t.issue !== undefined && p.closes.includes(t.issue) && Date.parse(p.createdAt) >= since))
        .sort((a, b) => Number(b.headRefName === t.branch) - Number(a.headRefName === t.branch) || b.createdAt.localeCompare(a.createdAt))[0];
      if (!match) continue;
      const pr = { number: match.number, url: match.url, state: match.isDraft ? 'DRAFT' : match.state, title: match.title };
      if (t.pr && t.pr.number === pr.number && t.pr.state === pr.state && t.pr.title === pr.title) continue;
      t.pr = pr;
      changed = true;
    }
    if (changed) this.changed();
  }

  /** Finishes tasks whose worker stopped, then seats queued tasks while there's room. */
  pump() {
    if (this.stopped || this.storageError) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        this.reconcile();
        if (!this.storageError && !this.pauseOnStart) this.seat();
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }

  shutdown() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  // ---------------------------------------------------------------------------

  private reconcile() {
    const byId = new Map(this.workers.list().map((w) => [w.id, w]));
    let changed = false;
    for (const t of this.tasks) {
      if (t.status !== 'running' || !t.workerId) continue;
      const w = byId.get(t.workerId);
      if (!w) this.finish(t, 'killed');
      else if (FINISHED.has(w.status)) this.finish(t, w.status === 'done' ? 'done' : 'exited');
      else continue;
      changed = true;
    }
    if (changed) this.changed();
  }

  private finish(t: QueueTask, outcome: NonNullable<QueueTask['outcome']>) {
    t.status = 'done';
    t.outcome = outcome;
    t.finishedAt = Date.now();
    const who = t.workerName ?? 'Its worker';
    if (outcome === 'done') {
      this.events.toast(`📋 ${who} finished ${label(t)}`, 'info');
      // The worker most likely just opened the PR; go and link it.
      this.events.refreshGitHub();
    } else if (outcome === 'exited') this.events.toast(`📋 ${who} stopped before finishing ${label(t)} — requeue it from the queue board`, 'warn');
  }

  private busy(): number {
    return this.workers.list().filter((w) => w.kind === 'agent' && BUSY.has(w.status)).length;
  }

  private capacity() { return this.workers.workstationCapacity?.() ?? DESKS.length; }
  private freeDesk(): string | undefined {
    for (let i = 1; i <= this.capacity(); i++) if (!this.workers.deskOccupied(`desk-${i}`)) return `desk-${i}`;
    return undefined;
  }

  /**
   * No desk is free: send home a worker the queue hired whose task is finished (nobody is looking at
   * its terminal), and return its desk. Workers with a linked PR go first — their work is delivered.
   */
  private recycleDesk(): string | undefined {
    const byId = new Map(this.workers.list().map((w) => [w.id, w]));
    const candidates = this.tasks
      .filter((t) => t.status === 'done' && t.workerId && byId.has(t.workerId))
      .map((t) => ({ t, w: byId.get(t.workerId!)! }))
      .filter(({ w }) => FINISHED.has(w.status) && w.viewers.length === 0 && (w.processState === 'running' || w.processState === 'stopped') && !this.recycling.has(w.id))
      .sort((a, b) => Number(!!b.t.pr) - Number(!!a.t.pr) || (a.t.finishedAt ?? 0) - (b.t.finishedAt ?? 0));
    const pick = candidates[0];
    if (!pick) return undefined;
    this.recycling.add(pick.w.id);
    const done = this.workers.kill(pick.w.id);
    void done.then(({ note, error }) => {
      this.recycling.delete(pick.w.id);
      if (note) this.events.toast(note, 'info');
      if (error) this.events.toast(error, 'warn');
    });
    return this.freeDesk();
  }

  private seat() {
    let changed = false;
    for (const t of this.tasks) {
      if (this.storageError) break;
      if (t.status !== 'queued') continue;
      const authority = this.events.retryAllowed?.(t);
      if (authority) {
        t.status = 'done'; t.outcome = 'failed'; t.error = authority; t.finishedAt = Date.now();
        if (!this.changed()) break;
        continue;
      }
      const sibling = this.managerSiblingBlocker(t.jobKey, t.id);
      if (sibling) {
        if (t.error !== sibling) { t.error = sibling; if (!this.changed()) break; }
        continue;
      }
      if (this.busy() >= this.maxWorkers) break;
      // A spent budget holds the queue instead of failing every task; the pump seats them once hiring resumes.
      if (this.events.hiringPaused()) break;
      const desk = this.freeDesk() ?? this.recycleDesk();
      if (!desk) break;
      // Journal the launch before entering WorkerManager. An interrupted unlinked launch is
      // unknown, never automatically queued again, even if the second file was never written.
      t.status = 'running';
      t.startedAt = Date.now();
      if (!this.changed()) break;
      const r = this.workers.spawn(desk, `${t.addedBy} (queue)`, t.prompt + (this.useWorktree ? WORKTREE_NOTE : ''), this.useWorktree, 'agent', true);
      changed = true;
      if (typeof r === 'string') {
        t.status = 'done';
        t.outcome = 'failed';
        t.error = r;
        t.finishedAt = Date.now();
        this.events.toast(`📋 Couldn't start ${label(t)}: ${r}`, 'error');
        continue;
      }
      t.status = 'running';
      t.workerId = r.id;
      t.workerName = r.name;
      t.branch = r.worktree?.branch;
      t.startedAt = Date.now();
      t.error = undefined;
      if (!this.changed()) break;
      this.lastStatus.set(r.id, r.status);
      this.events.toast(`📋 ${r.name} sat down at ${DESK_BY_ID.get(desk)?.label ?? 'a desk'} to work on ${label(t)}`, 'info');
      if (t.issue !== undefined) {
        const issue = t.issue;
        void this.events.claimIssue(issue).then((err) => {
          if (err) this.events.toast(`Couldn't assign issue #${issue} on GitHub: ${err}`, 'warn');
        });
      }
    }
    if (changed) this.changed();
  }

  private changed() {
    if (!this.persist()) return false;
    this.events.update(this.state());
    return true;
  }

  private persist() {
    if (this.storageError) return false;
    try {
      writeJsonAtomic(this.statePath, { maxWorkers: this.maxWorkers, tasks: this.tasks, releasedWorkers: [...this.releasedWorkers] });
      return true;
    } catch (error) {
      this.storageError = `Queue could not be saved; scheduling and recovery are paused. Preserve queue.json, repair storage and restart. ${(error as Error).message}`;
      this.events.toast(this.storageError, 'error');
      return false;
    }
  }

  private restore() {
    if (!existsSync(this.statePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as { maxWorkers?: number; tasks?: Partial<QueueTask>[]; releasedWorkers?: string[] };
      if (!saved || !Array.isArray(saved.tasks)) throw new Error('Invalid queue task list');
      this.releasedWorkers = new Set((saved.releasedWorkers ?? []).filter(id => typeof id === 'string'));
      if (typeof saved.maxWorkers === 'number' && Number.isFinite(saved.maxWorkers)) this.maxWorkers = Math.max(0, Math.min(this.capacity(), Math.floor(saved.maxWorkers)));
      for (const s of saved.tasks ?? []) {
        if (typeof s.id !== 'string' || typeof s.prompt !== 'string' || typeof s.title !== 'string' || this.tasks.some(t => t.id === s.id)) throw new Error('Invalid or duplicate saved task');
        const t: QueueTask = {
          id: s.id,
          jobKey: typeof s.jobKey === 'string' ? s.jobKey : undefined,
          issue: typeof s.issue === 'number' ? s.issue : undefined,
          title: s.title,
          prompt: s.prompt,
          addedBy: s.addedBy ?? '?',
          addedAt: s.addedAt ?? Date.now(),
          status: s.status === 'running' || s.status === 'done' ? s.status : 'queued',
          attempt: Number.isSafeInteger(s.attempt) && s.attempt! > 0 ? s.attempt : 1,
          interruption: s.interruption?.reason === 'server_restart' && Number.isFinite(s.interruption.at) ? s.interruption : undefined,
          workerId: s.workerId,
          workerName: s.workerName,
          branch: s.branch,
          startedAt: s.startedAt,
          finishedAt: s.finishedAt,
          outcome: s.outcome,
          error: s.error,
          pr: s.pr,
        };
        // A restart interrupts queue ownership; the old process may still exist and must be checked.
        if (t.status === 'running') {
          t.status = 'done';
          t.outcome = 'exited';
          t.finishedAt = Date.now();
          t.error = 'The office restarted while it was running';
          t.interruption = { reason: 'server_restart', at: t.finishedAt };
        }
        this.tasks.push(t);
      }
      this.persist();
    } catch (error) {
      throw new Error(`Cannot restore queue.json; preserve the file and restore a valid backup. ${(error as Error).message}`);
    }
  }
}

function label(t: QueueTask): string {
  return t.issue !== undefined ? `#${t.issue}` : `“${t.title.length > 40 ? `${t.title.slice(0, 39)}…` : t.title}”`;
}

function firstLine(s: string): string {
  return s.split('\n')[0].trim();
}

function managerFamily(jobKey?: string): string | undefined {
  return jobKey?.match(/^(empire-manager-.+)-\d+$/)?.[1];
}
