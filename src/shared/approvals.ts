// The CEO approval inbox (ORG-03), shared by server and client. Every item is derived from real consultancy
// state: a plan waiting for approval, or a job held because its provider spend reached the approved budget.

import type { EstimateBasis, ExecutiveRole, Range } from './org.js';
import type { OutreachExcluded } from './outreach.js';

/**
 * `external_action` (ORG-04a): something leaves the Empire, e.g. a campaign send; approving acts on a frozen snapshot.
 * `tool_proposal` (ORG-05): a researched tool; approving only records the decision.
 */
export type ApprovalKind = 'job_plan' | 'budget_increase' | 'external_action' | 'tool_proposal';

/** The frozen campaign send an external_action approves: exactly this is sent, to exactly these recipients. */
export interface OutreachApproval {
  campaignId: string;
  /** sha256 of the snapshot; any change raises a new item instead. */
  snapshotHash: string;
  channel: 'email';
  from: string;
  dailyCap: number;
  intervalSec: number;
  /** The exact message rendered for (at most) 2 sample recipients, footer included. */
  samples: { to: string; subject: string; text: string }[];
  recipients: string[];
  excluded: OutreachExcluded;
  draftedBy: string;
}
/** `resolved`: the hold an increase was raised for cleared without any recorded budget raise (no decision is implied). */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'resolved';

export interface ApprovalEstimate {
  costUsd: Range;
  calendarMs?: Range;
  basis?: EstimateBasis;
}

export interface Approval {
  /** Short and typable, e.g. "A3"; distinct from consultancy job ids. */
  id: string;
  kind: ApprovalKind;
  /** The executive that raised it: plans come from the chief of staff, budget increases from finance. */
  raisedBy: ExecutiveRole;
  title: string;
  /** One plain line. Never a brief, prompt, credential or path. */
  detail: string;
  jobId: string;
  estimate?: ApprovalEstimate;
  /** Provider-reported list cost of the job so far, in USD. */
  spentUsd?: number;
  /** The job's approved budget when this was raised (budget_increase). */
  approvedBudgetUsd?: number;
  /** What approving without a budget records: spend plus the remaining estimate top, rounded up (budget_increase). */
  suggestedBudgetUsd?: number;
  createdAt: number;
  status: ApprovalStatus;
  decidedAt?: number;
  decidedBy?: string;
  /** The budget the decision recorded, in USD. */
  budgetUsd?: number;
  /** A plain note on the decision, e.g. "Reopened after decline on …". */
  note?: string;
  /** ORG-05 tool_proposal: the tool a research report proposes. Deciding only records the decision. */
  tool?: { name: string; url: string; licence: string; enables: string; risk: string };
  /** A declined budget increase whose hold still stands: it can still be approved (review fix 1). */
  reopenable?: true;
  /** external_action: the campaign send being approved. */
  outreach?: OutreachApproval;
}

export interface ApprovalsState {
  schemaVersion: 1;
  revision: number;
  /** Pending first, then the most recent decisions. */
  items: Approval[];
  pending: number;
  storageError?: string;
}

export const APPROVAL_ID_RE = /^A[1-9]\d{0,8}$/;

export const APPROVAL_KIND_LABEL: Record<ApprovalKind, string> = {
  job_plan: 'Client plan',
  budget_increase: 'Budget increase',
  external_action: 'Campaign send',
  tool_proposal: 'Tool proposal',
};

export const MAX_APPROVAL_BUDGET_USD = 100_000;

export const CLOUD_INBOX_NOTE = "The approval inbox isn't available in cloud mode yet.";

/** How to act on an approval anywhere it is announced. */
export const approveHint = (id: string) => `Approve in the game, on the founder desk, or with /approve ${id} in Telegram.`;
