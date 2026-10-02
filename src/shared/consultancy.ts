import type { BudgetHold, ItemEstimate, ItemPhase, JobEstimate } from './org.js';

export type ConsultancyDecision = 'pending_approval' | 'approved' | 'rejected';

export type ConsultancyStatus =
  | 'awaiting_approval'
  | 'queued'
  | 'running'
  | 'needs_attention'
  | 'awaiting_review'
  | 'rejected';

export interface ConsultancyTaskInput {
  title: string;
  prompt: string;
  /** Plan phase (ORG-02); absent means build. */
  phase?: ItemPhase;
}

export interface ConsultancyCreateInput {
  requestId: string;
  client: string;
  title: string;
  brief: string;
  tasks?: ConsultancyTaskInput[];
}

export interface ConsultancyItem {
  id: string;
  title: string;
  prompt: string;
  jobKey: string;
  queueTaskId?: string;
  status: ConsultancyStatus;
  attention?: string;
  /** Plan phase; saved plans without one are build. */
  phase: ItemPhase;
  /** This item's share of the job estimate (live while pending, frozen at approval). */
  estimate?: ItemEstimate;
  /** An unstarted item waiting because the job's budget was reached. */
  held?: boolean;
  /** Provider-reported list cost of the worker(s) that ran this item, in USD. */
  actualSpendUsd?: number;
}

export interface ConsultancyJob {
  id: string;
  requestId: string;
  client: string;
  title: string;
  brief: string;
  decision: ConsultancyDecision;
  status: ConsultancyStatus;
  createdAt: number;
  createdBy: string;
  decidedAt?: number;
  decidedBy?: string;
  items: ConsultancyItem[];
  attention?: string;
  /** Live estimate while pending; the estimate the CEO approved afterwards. Absent when no estimator is wired. */
  estimate?: JobEstimate;
  /** Recorded at approval: the top of the estimate rounded up unless the CEO set it. */
  approvedBudgetUsd?: number;
  /** Sum of the provider-reported list cost of the workers that ran its items, in USD. */
  actualSpendUsd?: number;
  /** Set when actual spend reached the approved budget; unstarted items are held. */
  budgetHold?: BudgetHold;
}

export interface ConsultancyApproveOptions {
  /** The CEO's edited budget in USD; defaults to the top of the estimate, rounded up. */
  budgetUsd?: number;
}

export interface ConsultancySnapshot {
  revision: number;
  jobs: ConsultancyJob[];
  storageError?: string;
}
