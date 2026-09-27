import type { SectorState, SupervisionState } from '../../shared/empire';
import type { QueueTask, WorkerInfo } from '../../shared/protocol';

export type Tone = 'idle' | 'active' | 'attention' | 'unknown';
export interface StatusView {
  tone: Tone;
  label: string;
  detail: string;
}
export interface Evidence {
  fresh: boolean;
  reason?: 'connecting' | 'disconnected' | 'missing' | 'stale';
  /** Milliseconds since the last empire message was received, by the client's own clock. */
  age: number;
}

export const STALE_MS = 15_000;

export function evidence(supervision: SupervisionState | undefined, connected: boolean, receivedAt: number, now: number): Evidence {
  const age = receivedAt > 0 ? Math.max(0, now - receivedAt) : Infinity;
  // Nothing received yet means we're still joining (e.g. behind the founder picker), not that we lost the server.
  if (!connected) return { fresh: false, reason: receivedAt > 0 ? 'disconnected' : 'connecting', age };
  if (!supervision || supervision.schemaVersion !== 1 || receivedAt <= 0) return { fresh: false, reason: 'missing', age };
  if (age > STALE_MS) return { fresh: false, reason: 'stale', age };
  return { fresh: true, age };
}

export function ageLabel(ms: number): string {
  if (!Number.isFinite(ms)) return 'never';
  const s = Math.round(ms / 1000);
  if (s < 2) return 'just now';
  if (s < 90) return `${s} s ago`;
  return `${Math.round(s / 60)} min ago`;
}

export function unknownView(ev: Evidence): StatusView {
  const detail =
    ev.reason === 'connecting'
      ? 'Connecting to the office server…'
      : ev.reason === 'disconnected'
      ? 'Disconnected from the office server. Reconnecting…'
      : ev.reason === 'missing'
        ? 'The server has not reported supervision evidence.'
        : `No update received for ${ageLabel(ev.age).replace(' ago', '')}.`;
  return { tone: 'unknown', label: 'Status unknown', detail };
}

type Phase = SupervisionState['chief']['phase'];
const CHIEF: Record<Phase, StatusView> = {
  unassigned: { tone: 'idle', label: 'Not appointed', detail: 'Complete founding setup to appoint a chief of staff.' },
  pending: { tone: 'idle', label: 'Startup pending', detail: 'The startup brief has not been queued yet.' },
  queued: { tone: 'idle', label: 'Startup queued', detail: 'Waiting for a free worker seat in the task queue.' },
  starting: { tone: 'active', label: 'Agent starting', detail: 'An agent process is launching for the chief’s job.' },
  idle: { tone: 'idle', label: 'Idle', detail: 'Assigned, with no agent turn in progress.' },
  working: { tone: 'active', label: 'Agent turn in progress', detail: 'The linked agent is working on the chief’s job.' },
  needs_input: { tone: 'attention', label: 'Needs your input', detail: 'The agent is blocked on a question or permission prompt.' },
  turn_ended: { tone: 'idle', label: 'Turn ended', detail: 'The agent finished its turn. Its output has not been verified.' },
  interrupted: { tone: 'attention', label: 'Interrupted', detail: 'The job stopped when the server restarted. Retry it explicitly.' },
  failed: { tone: 'attention', label: 'Failed', detail: 'The chief’s job did not complete.' },
  unknown: { tone: 'unknown', label: 'Status unknown', detail: 'Evidence is missing or conflicting.' },
};

export function chiefView(supervision: SupervisionState | undefined, ev: Evidence): StatusView {
  if (!ev.fresh || !supervision) return unknownView(ev);
  const base = CHIEF[supervision.chief.phase] ?? CHIEF.unknown;
  return supervision.chief.reason ? { ...base, detail: supervision.chief.reason } : base;
}

export function monitorView(supervision: SupervisionState | undefined, ev: Evidence): StatusView {
  if (!ev.fresh || !supervision) return { ...unknownView(ev), label: 'Monitoring unknown' };
  return {
    tone: 'idle',
    label: 'Rule-based monitoring',
    detail: `Deterministic server checks, not an autonomous agent. Last update received ${ageLabel(ev.age)}.`,
  };
}

export function delegationLabel(requested: boolean): string {
  return requested ? 'Delegation requested · rule-based reports only' : 'CEO oversight';
}

/** Counts are shown only while evidence is fresh; otherwise the HUD must not repeat old numbers. */
export function workforceView(supervision: SupervisionState | undefined, ev: Evidence) {
  return ev.fresh && supervision ? supervision.workforce : null;
}

/** Sector managers have no projection of their own, so this stays conservative about linked evidence. */
export function managerView(sector: SectorState, tasks: QueueTask[], workers: Map<string, WorkerInfo>, ev: Evidence): StatusView {
  if (!ev.fresh) return unknownView(ev);
  const m = sector.manager;
  if (!m) return { tone: 'idle', label: 'No manager', detail: 'Build this site to appoint a manager.' };
  const task = tasks.find((t) => t.jobKey === m.jobKey);
  if (task?.interruption) return { tone: 'attention', label: 'Interrupted', detail: 'Stopped by a server restart. Retry explicitly.' };
  if ((task && m.taskId && task.id !== m.taskId) || (task?.workerId && m.workerId && task.workerId !== m.workerId))
    return { tone: 'unknown', label: 'Status unknown', detail: 'Manager, task and worker links disagree.' };
  const worker = m.workerId ? workers.get(m.workerId) : undefined;
  switch (m.status) {
    case 'pending':
      return m.error
        ? { tone: 'attention', label: 'Startup not dispatched', detail: m.error }
        : { tone: 'idle', label: 'Startup pending', detail: 'Not yet queued.' };
    case 'queued':
      return { tone: 'idle', label: 'Startup queued', detail: 'Waiting for a free worker seat.' };
    case 'working':
      if (task?.status === 'running' && worker?.kind === 'agent' && worker.processState === 'running') {
        if (worker.status === 'starting') return { tone: 'active', label: 'Agent starting', detail: worker.name };
        if (worker.status === 'working') return { tone: 'active', label: 'Agent turn in progress', detail: worker.name };
      }
      return { tone: 'unknown', label: 'Status unknown', detail: 'No running agent process is linked to this job.' };
    case 'needs_input':
      return { tone: 'attention', label: 'Needs your input', detail: worker ? `${worker.name} is waiting in its terminal.` : 'Open the worker terminal.' };
    case 'ready':
      return { tone: 'idle', label: 'Assigned · turn ended', detail: 'Startup turn ended. Output not verified.' };
    case 'offline':
      return { tone: 'attention', label: 'Offline', detail: m.error ?? 'Startup needs attention. Retry below.' };
  }
  return { tone: 'unknown', label: 'Status unknown', detail: 'Unrecognized manager state.' };
}

/** Worker list pill: without fresh evidence, the cached status is only a last-known value. */
export function workerPill(status: string, label: string, fresh: boolean) {
  return fresh
    ? { text: label, tone: status, spoken: label }
    : { text: `last: ${label}`, tone: 'stale', spoken: `status unknown, last known ${label}` };
}

/** Only a fresh, running agent in an active turn may be drawn typing. */
export function typingPose(worker: WorkerInfo | undefined, fresh: boolean): boolean {
  return fresh && worker?.kind === 'agent' && worker.status === 'working' && worker.processState === 'running';
}

export function managerTyping(sector: SectorState, tasks: QueueTask[], workers: Map<string, WorkerInfo>, ev: Evidence): boolean {
  const id = sector.manager?.workerId;
  return managerView(sector, tasks, workers, ev).tone === 'active' && typingPose(id ? workers.get(id) : undefined, ev.fresh);
}
