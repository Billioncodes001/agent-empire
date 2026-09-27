import type { EmpireState } from './empire.js';
import type { QueueState, WorkerInfo } from './protocol.js';

/** One host owns execution. Revisions describe observations, never instructions to run work. */
export interface ContinuityStatus {
  schemaVersion: 1;
  serverId: string;
  serverRunId: string;
  revision: number;
  checkpointRevision: number;
  oldestRevision: number;
  observedAt: number;
  mode: 'single_owner';
  durability: 'ok' | 'error';
  error?: string;
}

export interface ContinuitySnapshot {
  revision: number;
  empire: EmpireState;
  queue: QueueState;
  workers: WorkerInfo[];
}

export type ContinuityEvent = { revision: number; at: number } & (
  | { topic: 'empire'; state: EmpireState }
  | { topic: 'queue'; state: QueueState }
  | { topic: 'workers'; state: WorkerInfo[] }
);

export interface ContinuityFeed {
  status: ContinuityStatus;
  reset: boolean;
  snapshot?: ContinuitySnapshot;
  events: ContinuityEvent[];
}

/** Authenticated metadata for an immutable, self-contained Git bundle (no prerequisites). */
export interface SyncArtifactManifest {
  schemaVersion: 1;
  serverId: string;
  /** SHA-256 of the bundle bytes, also the immutable artifact identifier. */
  artifactId: string;
  createdAt: number;
  workerId: string;
  branch: string;
  commit: string;
  base: string;
  bundle: { sha256: string; bytes: number; ref: 'HEAD'; url: string };
}

export interface SyncArtifactList {
  serverId: string;
  artifacts: SyncArtifactManifest[];
}
