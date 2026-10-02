import type { EmpireState, SupervisionState } from '../shared/empire.js';
import type { QueueState, WorkerInfo } from '../shared/protocol.js';

export function chiefLinksConflict(state: EmpireState, queue: QueueState) {
  const manager = state.sectors.find(s => s.id === 'hq')?.manager;
  if (!manager) return false;
  const matches = queue.tasks.filter(t => t.jobKey === manager.jobKey);
  const task = matches[0];
  return matches.length > 1 || !!(task && (
    (manager.taskId && task.id !== manager.taskId) ||
    (!task.interruption && manager.workerId && task.workerId !== manager.workerId)
  ));
}

/** Project only joined runtime evidence. Historical appointment readiness is a separate policy. */
export function projectSupervision(state: EmpireState, workers: WorkerInfo[], queue: QueueState, serverRunId: string, now: number): SupervisionState {
  const chief: SupervisionState['chief'] = { phase: 'unassigned' };
  const manager = state.sectors.find(s => s.id === 'hq')?.manager;
  if (manager) {
    Object.assign(chief, { managerId: manager.id, taskId: manager.taskId, workerId: manager.workerId });
    const matches = queue.tasks.filter(t => t.jobKey === manager.jobKey);
    const task = matches[0];
    if (chiefLinksConflict(state, queue)) {
      Object.assign(chief, { phase: 'unknown', reason: 'Chief assignment and queue links conflict.' });
    } else if (!task) {
      Object.assign(chief, manager.status === 'pending'
        ? { phase: 'pending', reason: manager.error }
        : { phase: 'unknown', reason: 'No queue evidence for this chief assignment.' });
    } else {
      Object.assign(chief, { taskId: task.id, workerId: task.workerId });
      const worker = workers.find(w => w.id === task.workerId);
      if (task.interruption) Object.assign(chief, { phase: 'interrupted', reason: [task.error ?? 'The server restarted.', worker?.processState === 'unknown' ? worker.activity : 'Review the previous worker before retrying.'].filter(Boolean).join(' ') });
      else if (task.status === 'queued') chief.phase = 'queued';
      else if (task.status === 'done') Object.assign(chief, task.outcome === 'done'
        ? { phase: 'turn_ended', reason: 'The startup turn ended; its brief has not been verified.' }
        : { phase: 'failed', reason: task.error ?? 'The startup task stopped without an accepted result.' });
      else {
        if (!worker || worker.kind !== 'agent' || worker.processState !== 'running' || !['starting', 'idle', 'working', 'needs_input'].includes(worker.status)) {
          Object.assign(chief, { phase: 'unknown', reason: worker?.activity ?? 'No current process evidence for the startup task.' });
        } else {
          chief.phase = worker.status as 'starting' | 'idle' | 'working' | 'needs_input';
          if (worker.status === 'needs_input') chief.reason = worker.activity ?? 'Open the worker terminal; human input is required.';
        }
      }
    }
  }
  const agents = workers.filter(w => w.kind === 'agent' && w.processState === 'running');
  return {
    schemaVersion: 1, serverRunId, observedAt: now, delegationRequested: state.delegated,
    monitor: { mode: 'rule_based', lastCheckAt: now }, chief,
    workforce: {
      active: agents.filter(w => w.status === 'working').length,
      attention: agents.filter(w => w.status === 'needs_input').length,
      queued: queue.tasks.filter(t => t.status === 'queued').length,
    },
  };
}
