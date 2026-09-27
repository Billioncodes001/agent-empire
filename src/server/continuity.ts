import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ContinuityEvent, ContinuityFeed, ContinuitySnapshot, ContinuityStatus } from '../shared/continuity.js';
import { writeJsonAtomic } from './persistence.js';

type Observation = Omit<ContinuitySnapshot, 'revision'>;
interface Checkpoint {
  schemaVersion: 1;
  serverId: string;
  revision: number;
  observedAt: number;
  snapshot?: ContinuitySnapshot;
  events: ContinuityEvent[];
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** A bounded, atomic observation journal. Execution always restores from its own guarded saves. */
export class Continuity {
  private file: string;
  private saved: Checkpoint;
  private error?: string;
  private observedAt = 0;
  private serverRunId: string = randomUUID();

  constructor(dataDir: string, private retention = 128) {
    if (!Number.isSafeInteger(retention) || retention < 1) throw new Error('Invalid continuity retention');
    this.file = path.join(dataDir, 'continuity.json');
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Checkpoint;
      if (saved.schemaVersion !== 1 || typeof saved.serverId !== 'string' || !/^[\da-f-]{36}$/.test(saved.serverId)
        || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || !Array.isArray(saved.events)
        || (saved.revision > 0 && (!saved.snapshot || saved.snapshot.revision !== saved.revision))
        || saved.events.some((event, index) => !Number.isSafeInteger(event.revision)
          || event.revision !== saved.revision - saved.events.length + index + 1
          || !['empire', 'queue', 'workers'].includes(event.topic) || !event.state)) {
        throw new Error('Invalid continuity checkpoint; preserve it and diagnose before restarting');
      }
      this.saved = saved;
    } else {
      this.saved = { schemaVersion: 1, serverId: randomUUID(), revision: 0, observedAt: 0, events: [] };
      // Never advertise an identity that was not successfully saved.
      writeJsonAtomic(this.file, this.saved);
    }
  }

  get serverId() { return this.saved.serverId; }

  observe(value: Observation): void {
    this.observedAt = Date.now();
    this.serverRunId = value.empire.supervision?.serverRunId ?? this.serverRunId;
    const observation = copy(value);
    const events: ContinuityEvent[] = [];
    let revision = this.saved.revision;
    for (const topic of ['empire', 'queue', 'workers'] as const) {
      if (JSON.stringify(observation[topic]) !== JSON.stringify(this.saved.snapshot?.[topic])) {
        events.push({ revision: ++revision, at: this.observedAt, topic, state: observation[topic] } as ContinuityEvent);
      }
    }
    if (!events.length && !this.error) return;
    const next: Checkpoint = {
      schemaVersion: 1, serverId: this.serverId, revision, observedAt: this.observedAt,
      snapshot: { ...observation, revision }, events: [...this.saved.events, ...events].slice(-this.retention),
    };
    try {
      writeJsonAtomic(this.file, next);
      this.saved = next;
      this.error = undefined;
    } catch (error) {
      this.error = `Continuity checkpoint could not be saved: ${(error as Error).message}. Replay remains at the last saved revision.`;
    }
  }

  status(storageError?: string): ContinuityStatus {
    const error = [this.error, storageError].filter(Boolean).join(' ') || undefined;
    return {
      schemaVersion: 1, serverId: this.serverId, serverRunId: this.serverRunId,
      revision: this.saved.revision, checkpointRevision: this.saved.revision,
      oldestRevision: this.saved.events[0]?.revision ?? this.saved.revision + 1,
      observedAt: this.observedAt, mode: 'single_owner', durability: error ? 'error' : 'ok', ...(error ? { error } : {}),
    };
  }

  feed(serverId?: string, after?: number, storageError?: string): ContinuityFeed {
    const status = this.status(storageError);
    const reset = serverId !== this.serverId || !Number.isSafeInteger(after) || after! < status.oldestRevision - 1 || after! > status.revision;
    return copy({ status, reset, ...(reset ? { snapshot: this.saved.snapshot } : {}), events: reset ? [] : this.saved.events.filter(event => event.revision > after!) });
  }
}
