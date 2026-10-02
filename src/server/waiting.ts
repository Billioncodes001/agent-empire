/**
 * LIFE-04 `WorkerInfo.waitingOn`, projected purely from the queue and the workers (nothing is stored).
 *
 * An idle or finished worker is waiting on someone when its LAST finished task has a dependent task that is still
 * queued because a dependency is RUNNING on another worker. The projection names that blocking worker. It clears as
 * soon as the dependent task is seated (no longer queued) or the blocking task finishes (no longer running).
 */
import type { QueueTask, WaitingOn, WorkerInfo } from '../shared/protocol.js';
import { dependencyState } from '../shared/dependencies.js';

const RESTING = new Set<WorkerInfo['status']>(['idle', 'done']);

export function projectWaitingOn(tasks: readonly QueueTask[], workers: readonly WorkerInfo[]): Map<string, WaitingOn> {
  const out = new Map<string, WaitingOn>();
  const byId = new Map(workers.map((w) => [w.id, w]));
  const lastFinished = new Map<string, QueueTask>();
  for (const t of tasks) {
    if (t.status !== 'done' || !t.workerId) continue;
    const prev = lastFinished.get(t.workerId);
    if (!prev || (t.finishedAt ?? 0) >= (prev.finishedAt ?? 0)) lastFinished.set(t.workerId, t);
  }
  for (const w of workers) {
    if (!RESTING.has(w.status)) continue;
    const last = lastFinished.get(w.id);
    if (!last) continue;
    for (const dependent of tasks) {
      if (dependent.status !== 'queued' || !dependent.dependsOn?.includes(last.id)) continue;
      const state = dependencyState(dependent, tasks);
      if (state.kind !== 'blocked') continue;
      const blocker = state.blockedBy
        .map((id) => tasks.find((t) => t.id === id))
        .map((t) => (t?.status === 'running' && t.workerId && t.workerId !== w.id ? byId.get(t.workerId) : undefined))
        .find((b): b is WorkerInfo => !!b);
      if (!blocker) continue;
      out.set(w.id, { id: blocker.id, name: blocker.name, taskId: dependent.id });
      break;
    }
  }
  return out;
}

/** The worker as sent to clients: with its projected waitingOn, or without the field when it is not waiting. */
export function withWaitingOn(worker: WorkerInfo, waits: ReadonlyMap<string, WaitingOn>): WorkerInfo {
  const on = waits.get(worker.id);
  if (on) return { ...worker, waitingOn: on };
  if (!('waitingOn' in worker)) return worker;
  const { waitingOn: _drop, ...rest } = worker;
  return rest;
}
