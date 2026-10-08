// The research executive (ORG-05), shared by server and client. A research report is a worker's markdown artifact,
// imported strictly when its task finishes. Nothing here is verified: every report is labelled as the worker's work.

export type Feasibility = 'feasible' | 'partial' | 'not_yet' | 'unknown';
export type Confidence = 'low' | 'medium' | 'high';

export const FEASIBILITIES: readonly Feasibility[] = ['feasible', 'partial', 'not_yet', 'unknown'];
export const CONFIDENCES: readonly Confidence[] = ['low', 'medium', 'high'];

export const FEASIBILITY_LABEL: Record<Feasibility, string> = { feasible: 'Feasible', partial: 'Partly feasible', not_yet: 'Not yet', unknown: 'Unknown' };
export const CONFIDENCE_LABEL: Record<Confidence, string> = { low: 'Low confidence', medium: 'Medium confidence', high: 'High confidence' };

/** One tool a report proposes. Approving it only records the decision; nothing is installed or adopted. */
export interface ToolProposal {
  name: string;
  /** https only. */
  url: string;
  licence: string;
  enables: string;
  risk: string;
  /** The inbox item raised for it, e.g. "A7". */
  approvalId?: string;
  decision: 'pending' | 'approved' | 'rejected';
  decidedAt?: number;
  decidedBy?: string;
}

export interface ResearchSections {
  findings: string;
  canDoNow: string;
  cannotYet: string;
  proposedTools: string;
}

export type ResearchStatus = 'awaiting_approval' | 'queued' | 'running' | 'imported' | 'needs_attention' | 'rejected';

export interface ResearchReportSummary {
  jobId: string;
  question: string;
  askedAt: number;
  askedBy: string;
  status: ResearchStatus;
  /** Why the report needs attention (missing file, invalid frontmatter, no source URL…). */
  reason?: string;
  feasibility?: Feasibility;
  confidence?: Confidence;
  /** The worker that wrote it. */
  worker?: string;
  importedAt?: number;
  /** Provider-reported list cost of the job, USD. */
  costUsd?: number;
  /** Source URLs cited in Findings. */
  sources?: number;
  tools: ToolProposal[];
}

export interface ResearchReport extends ResearchReportSummary {
  sections?: ResearchSections;
}

export interface ResearchState {
  schemaVersion: 1;
  reports: ResearchReportSummary[];
  /** Tool proposals still waiting for the CEO. */
  openProposals: number;
  storageError?: string;
}

export const RESEARCH_DIR = 'docs/empire/research';
export const MAX_QUESTION = 500;
export const researchedBy = (worker: string) => `Researched by ${worker} — not verified`;
export const TOOL_DECISION_NOTE = 'Approving records your decision only. Nothing is installed or adopted automatically; adopting a tool is later work through the normal reviewed flow.';

/** A URL safe to show as a link: https with a host, nothing else. */
export function safeHttpsUrl(value: string): string | undefined {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/** http(s) URLs in a piece of text (for counting citations). */
export const URL_RE = /https?:\/\/[^\s<>()\[\]"'`|]+/g;
