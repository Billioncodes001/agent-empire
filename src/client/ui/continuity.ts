import type { ContinuityStatus } from '../../shared/continuity';
import { ageLabel, STALE_MS, type StatusView } from './status';

/** Accepts only a well-formed schema-1 status; anything else is treated as absent. */
export function parseContinuity(value: unknown): ContinuityStatus | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  const int = (k: string) => Number.isSafeInteger(s[k]) && (s[k] as number) >= 0;
  if (s.schemaVersion !== 1 || s.mode !== 'single_owner' || (s.durability !== 'ok' && s.durability !== 'error')) return null;
  if (typeof s.serverId !== 'string' || !s.serverId || typeof s.serverRunId !== 'string' || !s.serverRunId) return null;
  if (!['revision', 'checkpointRevision', 'oldestRevision'].every(int) || !Number.isFinite(s.observedAt)) return null;
  if (s.error !== undefined && typeof s.error !== 'string') return null;
  return value as ContinuityStatus;
}

export interface ConnectionInput {
  online: boolean;
  connected: boolean;
}

export function connectionView({ online, connected }: ConnectionInput): StatusView {
  if (!online) return { tone: 'attention', label: 'This device is offline', detail: 'Reconnect this device to reach the office host. Nothing is sent or queued from here while offline.' };
  if (!connected) return { tone: 'unknown', label: 'Reconnecting to the office host', detail: 'The host may be restarting, asleep or unreachable. Work continues there only while it stays running.' };
  return { tone: 'active', label: 'Connected to the office host', detail: 'Live updates are arriving from the host that runs your agents.' };
}

/** Host persistence as reported by the host itself; receipt age is measured on this device's clock. */
export function continuityView(status: ContinuityStatus | null, receivedAt: number, connected: boolean, now: number): StatusView {
  if (!status) return { tone: 'unknown', label: 'Host persistence not reported', detail: 'This host has not reported continuity status.' };
  const age = receivedAt > 0 ? Math.max(0, now - receivedAt) : Infinity;
  if (!connected || age > STALE_MS)
    return {
      tone: 'unknown',
      label: 'Host persistence unknown',
      detail: `Last report received ${ageLabel(age)}${!connected ? ' before the connection dropped' : ''}; it may no longer be current.`,
    };
  if (status.durability === 'error')
    return { tone: 'attention', label: 'Host could not save state', detail: status.error || 'The host reported a persistence error. Recent changes may be lost if it stops.' };
  return {
    tone: 'idle',
    label: 'Host is saving state',
    detail: `Single host owns execution. Revision ${status.revision.toLocaleString()} observed; checkpoint ${status.checkpointRevision.toLocaleString()}. Report received ${ageLabel(age)}.`,
  };
}
