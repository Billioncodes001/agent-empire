import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { GhPull, QueueState, QueueTask, WorkerInfo, WorkerStatus } from '../shared/protocol.js';
import type { Outfit } from '../shared/outfit.js';
import { DESKS, DESK_BY_ID } from '../shared/layout.js';
import { MAX_DEPENDENCIES, dependencyState, findCycle, heldDependencyError, validateDependencies } from '../shared/dependencies.js';
import { writeJsonAtomic } from './persistence.js';

/** What the queue needs from the worker manager. Narrow on purpose, so a smoke test can fake it. */
export interface QueueWorkers {
  list(): WorkerInfo[];
  workstationCapacity?(): number;
  deskOccupied(deskId: string): boolean;
  /**
   * `continues` starts the worktree from the dependency's branch; only then does `persona` (the name and look of the
   * worker that finished it) apply, because only then does the new worker really pick up that work.
   */
  spawn(deskId: string, by: string, prompt: string, worktree: boolean, kind?: 'agent', queueOwned?: boolean, outfit?: Outfit, persona?: Persona, continues?: { branch: string; title: string }): WorkerInfo | string;
  /** True while the worker is publishing, opening a PR or stopping: it must not be sent home. */
  workerBusy?(id: string): boolean;
  /** Whether a local branch exists, to start a continuing worktree from it. */
  branchExists?(branch: string): boolean;
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
  /** Why this queued task must wait (e.g. its client job reached its approved budget). It stays queued, unfailed. */
  taskHold?(task: QueueTask): string | undefined;
}

/** Who continues a project at a desk (LIFE-04 continuity). */
export interface Persona {
  name: string;
  color?: string;
}

/** A desk kept for a task that continues a dependency, while that dependency's finished worker is sent home. */
interface Reservation {
  desk: string;
  workerId: string;
}

/** After a failed send-home, that worker is left alone this long (the pump timer retries; no toast storm). */
export const SEND_HOME_BACKOFF_MS = 60_000;

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
  /** Task id → the desk it continues at, kept while the desk's finished worker is sent home. In memory only. */
  private reserved = new Map<string, Reservation>();
  /** Worker id → when its last send-home failed (in memory; see SEND_HOME_BACKOFF_MS). */
  private sendHomeFailedAt = new Map<string, number>();
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

  /**
   * Adds a task. `dependsOn` names existing queue task ids (at most 8, no cycles) that must finish with outcome
   * 'done' first; until then the task stays queued with `blockedBy`.
   */
  add(prompt: string, by: string, title?: string, issue?: number, jobKey?: string, dependsOn?: readonly string[]): string | undefined {
    if (this.storageError) return this.storageError;
    if (jobKey && this.tasks.some(t => t.jobKey === jobKey)) return;
    const clean = prompt.replace(/\r\n?/g, '\n').trim();
    if (!clean) return 'Empty task';
    if (issue !== undefined && this.tasks.some((t) => t.issue === issue && t.status !== 'done')) return `Issue #${issue} is already on the queue`;
    if (this.tasks.filter((t) => t.status !== 'done').length >= MAX_TASKS) return `The queue is full (${MAX_TASKS} tasks)`;
    let id = randomBytes(6).toString('hex');
    while (this.tasks.some((t) => t.id === id)) id = randomBytes(6).toString('hex');
    const deps = validateDependencies(id, dependsOn, this.tasks);
    if ('error' in deps) return deps.error;
    const task: QueueTask = {
      id,
      jobKey,
      issue,
      title: (title?.trim() || firstLine(clean)).slice(0, 120),
      prompt: clean,
      addedBy: by,
      addedAt: Date.now(),
      status: 'queued',
      attempt: 1,
      ...(deps.ok.length ? { dependsOn: deps.ok } : {}),
    };
    this.tasks.push(task);
    this.refreshDependencies();
    if (!this.changed()) return this.storageError;
    this.pump();
    return undefined;
  }

  remove(taskId: string): string | undefined {
    if (this.storageError) return this.storageError;
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return 'No such task';
    if (t.status === 'running') return `${t.workerName ?? 'Its worker'} is on it — send the worker home to stop it`;
    const dependent = this.tasks.find((x) => x.status === 'queued' && x.dependsOn?.includes(t.id));
    if (dependent) return `${label(dependent)} is waiting on this task — remove that one first`;
    const blocked = this.recoveryBlocker(t);
    if (blocked) return blocked;
    this.tasks.splice(this.tasks.indexOf(t), 1);
    this.reserved.delete(t.id);
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
    // A dependency the CEO removed no longer gates the task; one that failed must be retried (or removed) first.
    const deps = (t.dependsOn ?? []).filter((id) => this.tasks.some((x) => x.id === id));
    const failed = deps.map((id) => this.tasks.find((x) => x.id === id)!).find((d) => d.status === 'done' && d.outcome !== 'done');
    if (failed) return `Dependency ${label(failed)} did not finish — retry or remove it first`;
    this.tasks.splice(this.tasks.indexOf(t), 1);
    const fresh: QueueTask = { id: t.id, jobKey: t.jobKey, issue: t.issue, title: t.title, prompt: t.prompt, addedBy: t.addedBy, addedAt: Date.now(), status: 'queued', attempt: (t.attempt ?? 1) + 1, ...(deps.length ? { dependsOn: deps } : {}) };
    this.tasks.push(fresh);
    this.refreshDependencies();
    if (!this.changed()) return this.storageError;
    this.pump();
    return undefined;
  }

  /** Forgets the finished tasks. */
  clear() {
    if (this.storageError) return;
    const before = this.tasks.length;
    // A finished dependency of a task still on the queue stays, so that task is not held for a missing dependency.
    const needed = new Set(this.tasks.filter((t) => t.status !== 'done').flatMap((t) => t.dependsOn ?? []));
    this.tasks = this.tasks.filter((t) => t.status !== 'done' || needed.has(t.id) || this.recoveryBlocker(t));
    if (this.tasks.some(t => t.status === 'done' && !needed.has(t.id))) this.events.toast('Kept task history for running or unknown workers. Confirm their processes stopped before clearing.', 'warn');
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
    this.sendHomeFailedAt.delete(workerId);
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
        if (!this.storageError && this.refreshDependencies()) this.changed();
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
  /** The first free funded desk that no other task has reserved for its continuation. */
  private freeDesk(forTask?: string): string | undefined {
    for (let i = 1; i <= this.capacity(); i++) {
      const desk = `desk-${i}`;
      if (!this.workers.deskOccupied(desk) && !this.reservedForOther(desk, forTask)) return desk;
    }
    return undefined;
  }

  private reservedForOther(desk: string, taskId?: string): boolean {
    for (const [id, r] of this.reserved) if (r.desk === desk && id !== taskId) return true;
    return false;
  }

  private fundedDesk(desk: string): boolean {
    const n = Number(/^desk-(\d+)$/.exec(desk)?.[1]);
    return Number.isInteger(n) && n >= 1 && n <= this.capacity();
  }

  /**
   * A worker the queue hired whose task is finished and whom nobody is watching: safe to send home for its desk. Never
   * one that is publishing, opening a PR or already stopping, nor one whose last send-home failed recently.
   */
  private recyclable(w: WorkerInfo): boolean {
    const failedAt = this.sendHomeFailedAt.get(w.id);
    if (failedAt !== undefined && Date.now() - failedAt < SEND_HOME_BACKOFF_MS) return false;
    return FINISHED.has(w.status) && w.viewers.length === 0 && (w.processState === 'running' || w.processState === 'stopped') && !this.recycling.has(w.id)
      && !this.workers.workerBusy?.(w.id) && this.tasks.some((t) => t.status === 'done' && t.workerId === w.id);
  }

  /**
   * Starts sending a finished queue worker home. Its desk frees once the process is confirmed stopped. A failure (an
   * error result or a rejection) backs that worker off for SEND_HOME_BACKOFF_MS. Nothing here pumps: the pump timer
   * retries, so a kill that fails without awaiting can never spin the event loop.
   */
  private sendHome(w: WorkerInfo, onFailed?: () => void) {
    this.recycling.add(w.id);
    let killing: Promise<{ note?: string; error?: string }>;
    try { killing = this.workers.kill(w.id); } catch (error) { killing = Promise.reject(error); }
    void killing
      .then((r) => r ?? {}, (error: unknown) => ({ error: `Couldn't send ${w.name} home: ${(error as Error)?.message ?? String(error)}` } as { note?: string; error?: string }))
      .then(({ note, error }) => {
        this.recycling.delete(w.id);
        if (note) this.events.toast(note, 'info');
        if (!error) { this.sendHomeFailedAt.delete(w.id); return; }
        this.sendHomeFailedAt.set(w.id, Date.now());
        this.events.toast(error, 'warn');
        onFailed?.();
      });
  }

  /**
   * LIFE-04 continuity: prefer the desk of the worker that finished the dependency, if that desk is free. When it isn't,
   * any free funded desk is taken at once. Only when NO desk is free may that worker be sent home for its desk, and only
   * if it is 'done' (never offline: that is a resumable session) and recyclable; the desk is then kept for this task
   * ('wait'). Returns undefined to use any desk.
   */
  private continuity(t: QueueTask): Reservation | 'wait' | undefined {
    const kept = this.reserved.get(t.id);
    if (kept) {
      if (!this.fundedDesk(kept.desk)) { this.reserved.delete(t.id); return undefined; }
      if (!this.workers.deskOccupied(kept.desk)) return kept;
      if (this.recycling.has(kept.workerId)) return 'wait';
      // The send-home failed or someone else sat down there: never hold a runnable task for it.
      this.reserved.delete(t.id);
      return undefined;
    }
    if (!t.dependsOn?.length) return undefined;
    const byId = new Map(this.workers.list().map((w) => [w.id, w]));
    const candidates: { desk: string; w?: WorkerInfo }[] = [];
    for (const depId of t.dependsOn) {
      const dep = this.tasks.find((x) => x.id === depId);
      if (!dep || dep.status !== 'done' || dep.outcome !== 'done') continue;
      const w = dep.workerId ? byId.get(dep.workerId) : undefined;
      const desk = w?.deskId ?? dep.deskId;
      if (!desk || !this.fundedDesk(desk) || this.reservedForOther(desk, t.id)) continue;
      if (!this.workers.deskOccupied(desk)) return { desk, workerId: w?.id ?? '' };
      candidates.push({ desk, w });
    }
    if (this.freeDesk(t.id)) return undefined;
    for (const { desk, w } of candidates) {
      if (!w || w.deskId !== desk || w.status !== 'done' || !this.recyclable(w)) continue;
      this.reserved.set(t.id, { desk, workerId: w.id });
      this.sendHome(w, () => this.reserved.delete(t.id));
      return 'wait';
    }
    return undefined;
  }

  /** Drops reservations whose send-home has finished, so a paused or full queue never keeps a desk to itself. */
  private releaseSettledReservations() {
    for (const [id, r] of this.reserved) if (!this.recycling.has(r.workerId)) this.reserved.delete(id);
  }

  /**
   * What the task continues: its finished dependencies. When the queue uses worktrees and a dependency's branch still
   * exists, the new worktree starts from that branch, and only then is the predecessor's name and colour reused.
   * The prompt gets one factual line either way.
   */
  private continuation(t: QueueTask): { note: string; base?: { branch: string; title: string }; persona?: Persona; outfit?: Outfit } | undefined {
    const deps = (t.dependsOn ?? []).map((id) => this.tasks.find((x) => x.id === id)).filter((d): d is QueueTask => !!d && d.outcome === 'done');
    if (!deps.length) return undefined;
    const describe = (d: QueueTask) => `“${d.title}”${d.branch ? ` (branch ${d.branch}${d.pr ? `, PR ${d.pr.url}` : ''})` : d.pr ? ` (PR ${d.pr.url})` : ''}`;
    const from = this.useWorktree ? deps.find((d) => d.branch && this.workers.branchExists?.(d.branch)) : undefined;
    if (!from) {
      const missing = this.useWorktree && deps.some((d) => d.branch) ? ' Its branch is no longer available, so your worktree starts from the project’s current HEAD.' : '';
      return { note: `\n\nThis task follows ${deps.map(describe).join(', ')}.${missing}` };
    }
    const others = deps.filter((d) => d !== from);
    const w = this.workers.list().find((x) => x.id === from.workerId);
    const persona = w ? { name: w.name, color: w.color } : from.workerName ? { name: from.workerName } : undefined;
    return {
      note: `\n\nThis task continues ${describe(from)}: your worktree starts from that branch.${others.length ? ` It also follows ${others.map(describe).join(', ')}.` : ''}`,
      base: { branch: from.branch!, title: from.title },
      persona,
      outfit: w?.outfit,
    };
  }

  /**
   * Keeps every queued task's `blockedBy` current and holds a task whose dependency finished without success (or
   * vanished). Repeats until stable so a hold propagates down a chain. Returns true when anything changed.
   */
  private refreshDependencies(): boolean {
    let changed = false;
    for (let pass = 0; pass <= this.tasks.length; pass++) {
      let again = false;
      for (const t of this.tasks) {
        if (t.status !== 'queued' || !t.dependsOn?.length) {
          if (t.blockedBy) { t.blockedBy = undefined; changed = true; }
          continue;
        }
        const s = dependencyState(t, this.tasks);
        if (s.kind === 'held') {
          t.status = 'done';
          t.outcome = 'failed';
          t.error = heldDependencyError(s.dependencyId);
          t.finishedAt = Date.now();
          t.blockedBy = undefined;
          this.reserved.delete(t.id);
          this.events.toast(`📋 ${label(t)} is held: ${t.error}. Retry or remove it from the queue.`, 'warn');
          changed = again = true;
          continue;
        }
        const next = s.kind === 'blocked' ? s.blockedBy : undefined;
        if ((t.blockedBy ?? []).join() !== (next ?? []).join()) { t.blockedBy = next; changed = true; }
      }
      if (!again) break;
    }
    return changed;
  }

  /**
   * No desk is free: send home a worker the queue hired whose task is finished (nobody is looking at
   * its terminal), and return its desk. Workers with a linked PR go first — their work is delivered.
   */
  private recycleDesk(forTask?: string): string | undefined {
    const byId = new Map(this.workers.list().map((w) => [w.id, w]));
    const candidates = this.tasks
      .filter((t) => t.status === 'done' && t.workerId && byId.has(t.workerId))
      .map((t) => ({ t, w: byId.get(t.workerId!)! }))
      // A desk kept for another task's continuation is not up for grabs.
      .filter(({ w }) => this.recyclable(w) && !this.reservedForOther(w.deskId, forTask))
      .sort((a, b) => Number(!!b.t.pr) - Number(!!a.t.pr) || (a.t.finishedAt ?? 0) - (b.t.finishedAt ?? 0));
    const pick = candidates[0];
    if (!pick) return undefined;
    this.sendHome(pick.w);
    return this.freeDesk(forTask);
  }

  private seat() {
    let changed = false;
    // A reservation lives only while its task can still be seated: one whose task finished, failed or was removed
    // before seating would otherwise keep its desk out of freeDesk for good.
    for (const [id] of this.reserved) if (this.tasks.find((x) => x.id === id)?.status !== 'queued') this.reserved.delete(id);
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
        this.reserved.delete(t.id);
        if (t.error !== sibling) { t.error = sibling; if (!this.changed()) break; }
        continue;
      }
      // An unfinished dependency keeps the task queued; it never takes a desk or a worker slot. Later tasks still run.
      if (t.blockedBy?.length || dependencyState(t, this.tasks).kind !== 'ready') continue;
      // A budget-held task (ORG-02) keeps its place, unfailed; later, unheld work may still be seated.
      if (this.events.taskHold?.(t)) continue;
      if (this.busy() >= this.maxWorkers) { this.releaseSettledReservations(); break; }
      // A spent budget holds the queue instead of failing every task; the pump seats them once hiring resumes.
      if (this.events.hiringPaused()) { this.releaseSettledReservations(); break; }
      const next = this.continuity(t);
      if (next === 'wait') continue;
      const desk = next?.desk ?? this.freeDesk(t.id) ?? this.recycleDesk(t.id);
      if (!desk) break;
      this.reserved.delete(t.id);
      const cont = this.continuation(t);
      // Journal the launch before entering WorkerManager. An interrupted unlinked launch is
      // unknown, never automatically queued again, even if the second file was never written.
      t.status = 'running';
      t.startedAt = Date.now();
      if (!this.changed()) break;
      const prompt = t.prompt + (cont?.note ?? '') + (this.useWorktree ? WORKTREE_NOTE : '');
      const r = cont?.base
        ? this.workers.spawn(desk, `${t.addedBy} (queue)`, prompt, this.useWorktree, 'agent', true, cont.outfit, cont.persona, cont.base)
        : this.workers.spawn(desk, `${t.addedBy} (queue)`, prompt, this.useWorktree, 'agent', true);
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
      t.deskId = r.deskId;
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
        const dependsOn = s.dependsOn === undefined ? undefined : savedIds(s.dependsOn, MAX_DEPENDENCIES);
        if (dependsOn === null || dependsOn?.includes(s.id)) throw new Error(`Invalid dependencies on saved task ${s.id}`);
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
          ...(dependsOn?.length ? { dependsOn } : {}),
          ...(typeof s.deskId === 'string' && /^desk-\d+$/.test(s.deskId) ? { deskId: s.deskId } : {}),
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
      const cycle = findCycle(new Map(this.tasks.map((t) => [t.id, t.dependsOn ?? []])));
      if (cycle) throw new Error(`Saved task dependencies form a cycle through ${cycle}`);
      // blockedBy is derived: recompute it (and any hold) from the restored graph rather than trusting the file.
      this.refreshDependencies();
      this.persist();
    } catch (error) {
      throw new Error(`Cannot restore queue.json; preserve the file and restore a valid backup. ${(error as Error).message}`);
    }
  }
}

function label(t: QueueTask): string {
  return t.issue !== undefined ? `#${t.issue}` : `“${t.title.length > 40 ? `${t.title.slice(0, 39)}…` : t.title}”`;
}

/** A saved id list: undefined when absent, null when malformed. */
function savedIds(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !id) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function firstLine(s: string): string {
  return s.split('\n')[0].trim();
}

function managerFamily(jobKey?: string): string | undefined {
  return jobKey?.match(/^(empire-manager-.+)-\d+$/)?.[1];
}
