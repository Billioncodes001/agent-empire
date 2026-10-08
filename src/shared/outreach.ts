// ORG-04a: email outreach, the marketing & sales executive's first channel. Shared by server and client.
// Leads come only from the CEO (CSV import) or, unconfirmed, from a worker's campaign draft. Nothing here is city
// credits, and every count is a real per-recipient result from outreach.json.

export type LeadStatus = 'confirmed' | 'proposed';
export interface Lead {
  /** Short and stable, e.g. "L12". */
  id: string;
  /** Lowercase; leads are de-duplicated on it. */
  email: string;
  name: string;
  company: string;
  /** Where the address came from, e.g. "inbound inquiry". Required. */
  source: string;
  /** The lawful basis the CEO records for emailing this contact, e.g. "existing customer". Required. */
  basis: string;
  tags: string[];
  /** A worker-proposed lead is never emailed until the CEO accepts it. */
  status: LeadStatus;
  addedAt: number;
  addedBy: string;
  /** The campaign whose draft proposed it. */
  proposedBy?: string;
}

export type SuppressionReason = 'opt_out' | 'bounce' | 'blocked';
export interface Suppression {
  email: string;
  reason: SuppressionReason;
  at: number;
  by: string;
  note?: string;
}

export type CampaignState = 'drafting' | 'needs_attention' | 'ready' | 'awaiting_approval' | 'sending' | 'paused' | 'completed' | 'cancelled' | 'rejected';
export type SendStatus = 'in_flight' | 'sent' | 'refused' | 'failed' | 'suppressed' | 'unknown';

export interface CampaignCounts {
  recipients: number;
  sent: number;
  refused: number;
  failed: number;
  suppressed: number;
  /** Uncertain after a restart or a lost reply: never re-sent automatically. */
  unknown: number;
  inFlight: number;
  pending: number;
}

export interface CampaignDraft {
  subject: string;
  audience: string[];
  body: string;
  /** The worker that drafted it. Shown as "Drafted by <worker> — not verified". */
  draftedBy: string;
  importedAt: number;
  proposedLeads: number;
}

export interface OutreachExcluded {
  suppressed: number;
  invalid: number;
  /** Worker-proposed leads that match the audience but are not confirmed. */
  unconfirmed: number;
}

export interface CampaignView {
  id: string;
  title: string;
  brief: string;
  state: CampaignState;
  createdAt: number;
  createdBy: string;
  /** The internal consultancy job that drafts it (client "Internal"). */
  jobId: string;
  draft?: CampaignDraft;
  /** Why the draft needs attention (a missing or invalid artifact). */
  issue?: string;
  /** Why sending waits or stopped (paused by the CEO, sign-in failed, daily cap, …). */
  note?: string;
  approvalId?: string;
  snapshot?: { hash: string; from: string; dailyCap: number; recipientCount: number; excluded: OutreachExcluded; createdAt: number; footer: string };
  counts?: CampaignCounts;
  /** Most recent per-recipient results first (at most 50). */
  results?: { email: string; status: SendStatus; at: number; detail?: string }[];
}

export interface OutreachStatus {
  sendingEnabled: boolean;
  /** "Outreach sending: enabled" or what is missing. */
  label: string;
  problems: string[];
  from?: string;
  dailyCap: number;
  intervalSec: number;
  /** UTC day the daily count belongs to. */
  day: string;
  sentToday: number;
}

export interface OutreachState {
  schemaVersion: 1;
  status: OutreachStatus;
  leads: Lead[];
  suppression: Suppression[];
  campaigns: CampaignView[];
  storageError?: string;
}

/** What the marketing & sales executive summarises (OrgInput.outreach). */
export interface OutreachSummary {
  campaigns: number;
  sending: number;
  drafting: number;
  confirmedLeads: number;
  proposedLeads: number;
  suppressed: number;
  sendingEnabled: boolean;
}

export const STOP_LINE = 'Reply STOP to stop receiving these emails.';
export const LAWFUL_BASIS_NOTE = 'You, the CEO, are responsible for having a lawful basis to email each contact. Record where each address came from and that basis.';
export const NO_SCRAPING_NOTE = 'The Empire never scrapes or buys addresses. Leads come only from your own import; worker-proposed leads wait for you to accept them.';
export const NO_IMAP_NOTE = "The Empire doesn't read replies (there is no IMAP). When someone replies STOP, add them as an opt-out here or with /optout <email> in Telegram.";
export const unverifiedLabel = (worker: string) => `Drafted by ${worker} — not verified`;
