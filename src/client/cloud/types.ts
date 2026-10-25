import type { Snapshot } from './repo';

/** An action this device sent that the coordinator has not consumed yet (or just did). */
export interface SentIntent {
  id: string;
  kind: string;
  label: string;
  at: number;
  /** The job a review / cancel / new job intent is about. */
  jobId?: string;
  /** FREE-07: the inbox item (A3) or lesson (L2) an organization intent is about. */
  ref?: string;
}

/** Everything the game knows about the cloud Empire. Shown with its age; never presented as live. */
export interface CloudInfo {
  repo: string;
  snapshot: Snapshot | null;
  source: 'github' | 'saved' | null;
  /** Device clock of the last successful check with GitHub (an unchanged head counts). */
  checkedAt?: number;
  error: { code: string; message: string } | null;
  sent: SentIntent[];
  /** A write to GitHub is in flight. */
  busy: boolean;
}
