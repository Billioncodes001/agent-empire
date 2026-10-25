// The CEO approval inbox (ORG-03), shared by server and client. Every item is derived from real consultancy
// state: a plan waiting for approval, or a job held because its provider spend reached the approved budget.

import type { EstimateBasis, ExecutiveRole, Range } from './org.js';
import type { OutreachExcluded } from './outreach.js';
import type { LessonScope, LessonSource } from './memory.js';

/**
 * `external_action` (ORG-04a): something leaves the Empire, e.g. a campaign send; approving acts on a frozen snapshot.
 * `tool_proposal` (ORG-05): a researched tool; approving only records the decision.
 */
export type ApprovalKind = 'job_plan' | 'budget_increase' | 'external_action' | 'tool_proposal' | 'chief_proposal' | 'lesson';

/**
 * FREE-10 `lesson`: a proposed organizational-memory lesson (decision only). Approving makes it planning context for the
 * chief; declining retires it. Nothing else happens either way.
 */
export interface LessonApproval {
  lessonId: string;
  text: string;
  scope: LessonScope;
  scopeValue?: string;
  source: LessonSource;
  proposedBy: string;
  /** An edit: the lesson it replaces once approved, and that lesson's current text. */
  supersedes?: string;
  supersedesText?: string;
  /**
   * Review fix 1: the proposal's random nonce. Lesson ids repeat if lessons.json is reset, so a decision applies only to
   * the exact proposal (id, text, scope and nonce) it was raised for.
   */
  nonce?: string;
}

/**
 * FREE-02 `chief_proposal`: the chief's model suggests how to unblock stalled work. Deciding records the decision; an
 * optional action (retry a held chain) runs through the queue's normal retry only after an approval is saved.
 */
export interface ChiefProposal {
  situation: string;
  /** The model's suggestion, shown as text. */
  text: string;
  model: string;
  action?: { kind: 'retry_held'; taskId: string; dependencyId: string; label: string };
}

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
  /** FREE-02 chief_proposal: the chief's suggestion and its optional one-click action. */
  proposal?: ChiefProposal;
  /** FREE-10 lesson: the proposed lesson, its scope and provenance. */
  lesson?: LessonApproval;
  /** FREE-02 job_plan: set when the chief's model proposed the plan, e.g. "Model-backed · gpt-oss:20b · proposals only". */
  proposedBy?: string;
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
  chief_proposal: 'Chief proposal',
  lesson: 'Lesson',
};

export const MAX_APPROVAL_BUDGET_USD = 100_000;

/** Which executive raises each kind (server inbox and cloud coordinator alike). */
export const RAISED_BY: Record<ApprovalKind, ExecutiveRole> = { job_plan: 'chief_of_staff', budget_increase: 'finance', external_action: 'marketing_sales', tool_proposal: 'research', chief_proposal: 'chief_of_staff', lesson: 'chief_of_staff' };

/** 64-bit FNV-1a over UTF-16 code units, hex. Browser-safe and deterministic; not a security hash. */
function fnv64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) { hash ^= BigInt(text.charCodeAt(i)); hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn; }
  return hash.toString(16).padStart(16, '0');
}

/**
 * FREE-07: a fingerprint of everything the CEO is shown about a pending item and that a decision acts on (id, kind,
 * title, detail, money, the tool, the lesson with its nonce, the chief's proposal, the campaign snapshot). A cloud
 * decision carries the fingerprint of the item as displayed; the coordinator refuses it if the item changed since, so
 * a decision can only ever apply to content the CEO saw. It guards against stale views, not forgery: anyone who could
 * forge an intent can already write the state repository.
 */
export function approvalFingerprint(item: Approval): string {
  const seen = {
    id: item.id, kind: item.kind, title: item.title, detail: item.detail, jobId: item.jobId, createdAt: item.createdAt,
    estimate: item.estimate ?? null, spentUsd: item.spentUsd ?? null, approvedBudgetUsd: item.approvedBudgetUsd ?? null,
    tool: item.tool ?? null, lesson: item.lesson ?? null, proposal: item.proposal ?? null, outreach: item.outreach?.snapshotHash ?? null,
  };
  return fnv64(JSON.stringify(seen));
}
export const FINGERPRINT_RE = /^[a-f0-9]{16}$/;

export const CLOUD_INBOX_NOTE = "The approval inbox isn't available in cloud mode yet.";

/** How to act on an approval anywhere it is announced. */
export const approveHint = (id: string) => `Approve in the game, on the founder desk, or with /approve ${id} in Telegram.`;
