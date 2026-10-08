// ORG-04a: email outreach, the marketing & sales executive's first channel. Rule-based: it coordinates, it doesn't
// write. A worker drafts each campaign as an internal consultancy job (client "Internal", estimate, CEO approval). The
// draft is imported from the worker's artifact, frozen into a snapshot, and sent only after the CEO approves that exact
// snapshot as an external_action. One message per recipient, rate-limited and capped, with durable per-recipient
// results in outreach.json. Leads and the suppression list live in leads.json.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Approval, OutreachApproval } from '../shared/approvals.js';
import type { ConsultancyJob, ConsultancySnapshot } from '../shared/consultancy.js';
import type { QueueState } from '../shared/protocol.js';
import {
  STOP_LINE, type CampaignCounts, type CampaignState, type CampaignView, type Lead, type OutreachExcluded, type OutreachState, type OutreachStatus,
  type OutreachSummary, type SendStatus, type Suppression, type SuppressionReason,
} from '../shared/outreach.js';
import { ApprovalError } from './approvals.js';
import { artifactPath, readArtifact, type Frontmatter } from './artifacts.js';
import { SmtpError, isEmailAddress, smtpConfigFromUrl, type MailMessage, type MailTransport, type SmtpConfig } from './email.js';
import { writeJsonAtomic } from './persistence.js';

const LEADS_FILE = 'leads.json';
const OUTREACH_FILE = 'outreach.json';
export const MAX_LEADS = 5000;
export const MAX_RECIPIENTS = 2000;
const MAX_CSV_BYTES = 1024 * 1024;
const MAX_SUBJECT = 150;
const MAX_BODY = 20_000;
const MAX_PROPOSED = 200;
const MAX_CAMPAIGNS = 200;
const MAX_TRANSIENT_ATTEMPTS = 3;
const PAUSE_AFTER_FAILURES = 5;
export const DEFAULT_DAILY_CAP = 200;
export const DEFAULT_INTERVAL_MS = 10_000;
const TAG = /^[A-Za-z0-9_.-]{1,40}$/;
const LEAD_ID = /^L[1-9]\d{0,8}$/;
const CAMPAIGN_ID = /^C[1-9]\d{0,8}$/;
const MERGE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const ACTOR = 'Jordan · Marketing & sales (rule-based)';
/** RCPT refusals in a row that look like a server or policy problem rather than bad addresses (review fix 2). */
const PAUSE_AFTER_REFUSALS = 3;
/** RCPT TO codes that mean this one mailbox does not exist or will not take mail. Others (554 relay, policy) never suppress. */
const RECIPIENT_CODES = new Set(['550', '551', '553']);
/** Each body line at most this many UTF-8 bytes (SMTP allows 998; leave room for merge values). */
const MAX_LINE_BYTES = 900;

/** One address as stored and compared: trimmed, Unicode NFC, lowercase. C0 controls are refused. Plus-addressing is distinct. */
export function normalizeEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const email = raw.trim().normalize('NFC').toLowerCase();
  if (!email || email.length > 254 || /[\u0000-\u001f\u007f]/.test(email) || !isEmailAddress(email)) return undefined;
  return email;
}

export class OutreachError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'OutreachError';
  }
}

// ---- Configuration -------------------------------------------------------------------------------

export interface OutreachConfig {
  from?: string;
  fromName?: string;
  /** Sender identity and physical postal address, printed in every footer. */
  address?: string;
  dailyCap: number;
  intervalMs: number;
  smtp?: SmtpConfig;
  /** What stops sending; empty when sending is enabled. */
  problems: string[];
}

/** Never throws, never echoes the SMTP URL. Sending is disabled while any problem remains. */
export function outreachConfig(env: NodeJS.ProcessEnv): OutreachConfig {
  const problems: string[] = [];
  const from = env.AGENT_EMPIRE_OUTREACH_FROM?.trim();
  const address = env.AGENT_EMPIRE_OUTREACH_ADDRESS?.trim();
  const name = env.AGENT_EMPIRE_OUTREACH_NAME?.trim();
  const capRaw = env.AGENT_EMPIRE_OUTREACH_DAILY_CAP?.trim();
  const intervalRaw = env.AGENT_EMPIRE_OUTREACH_INTERVAL_SEC?.trim();
  let dailyCap = DEFAULT_DAILY_CAP;
  if (capRaw) {
    const n = Number(capRaw);
    if (Number.isSafeInteger(n) && n >= 1 && n <= 10_000) dailyCap = n;
    else problems.push('AGENT_EMPIRE_OUTREACH_DAILY_CAP must be a whole number from 1 to 10000.');
  }
  let intervalMs = DEFAULT_INTERVAL_MS;
  if (intervalRaw) {
    const n = Number(intervalRaw);
    if (Number.isFinite(n) && n >= 2 && n <= 3600) intervalMs = Math.round(n * 1000);
    else problems.push('AGENT_EMPIRE_OUTREACH_INTERVAL_SEC must be from 2 to 3600 seconds.');
  }
  if (!from) problems.push('Set AGENT_EMPIRE_OUTREACH_FROM to the sender address.');
  else if (!isEmailAddress(from)) problems.push('AGENT_EMPIRE_OUTREACH_FROM must be a single email address.');
  if (!address) problems.push('Set AGENT_EMPIRE_OUTREACH_ADDRESS to your sender identity and postal address (it is printed in every email).');
  else if (address.length > 300 || /[\u0000-\u001f\u007f]/.test(address)) problems.push('AGENT_EMPIRE_OUTREACH_ADDRESS must be one line of at most 300 characters.');
  let smtp: SmtpConfig | undefined;
  const raw = env.AGENT_EMPIRE_SMTP_URL?.trim();
  if (!raw) problems.push('Set AGENT_EMPIRE_SMTP_URL (the same SMTP server as email notifications).');
  else { try { smtp = smtpConfigFromUrl(raw); } catch (error) { problems.push((error as Error).message); } }
  return {
    ...(from && isEmailAddress(from) ? { from } : {}),
    ...(name ? { fromName: clean(name, 80) } : {}),
    ...(address && !problems.some((p) => p.startsWith('AGENT_EMPIRE_OUTREACH_ADDRESS')) ? { address } : {}),
    dailyCap, intervalMs, ...(smtp ? { smtp } : {}), problems,
  };
}

// ---- Rendering ----------------------------------------------------------------------------------

/** One merge-field value: no control characters (so no CR/LF), collapsed spaces, at most 100 characters. */
export function mergeValue(value: string): string {
  return clean(value, 100);
}

function clean(value: string, max: number): string {
  return String(value).replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The fixed footer the server appends to every email. The worker's draft cannot change it. */
export function outreachFooter(cfg: Pick<OutreachConfig, 'address' | 'from' | 'fromName'>): string {
  return `--\n${cfg.address}\nSent by ${cfg.fromName ? `${cfg.fromName} <${cfg.from}>` : cfg.from}.\n${STOP_LINE}`;
}

interface Recipient { email: string; name: string; company: string }

interface Snapshot {
  hash: string;
  subject: string;
  body: string;
  footer: string;
  from: string;
  fromName?: string;
  dailyCap: number;
  intervalSec: number;
  recipients: Recipient[];
  excluded: OutreachExcluded;
  createdAt: number;
}

const fill = (template: string, r: Recipient, header = false) => template.replace(MERGE, (_m, field: string) => {
  const value = mergeValue(field === 'name' ? r.name : r.company);
  // In the Subject, a literal "=?…?=" would be decoded by mail clients; break it so the preview equals what is shown.
  return header ? value.replace(/=\?/g, '= ?').replace(/\?=/g, '? =') : value;
});

/** Exactly what one recipient receives: one message, one To address, the fixed footer always last. */
export function renderOutreach(s: Pick<Snapshot, 'subject' | 'body' | 'footer' | 'from' | 'fromName'>, r: Recipient): MailMessage {
  return {
    from: s.from,
    ...(s.fromName ? { fromName: s.fromName } : {}),
    to: r.email,
    subject: clean(fill(s.subject, r, true), 200),
    text: `${fill(s.body, r)}\n\n${s.footer}\n`,
  };
}

// ---- CSV ----------------------------------------------------------------------------------------

/** RFC 4180-style CSV: quoted fields, "" escapes, CRLF or LF rows. Returns rows of fields with their line numbers. */
export function parseCsv(text: string): { rows: { line: number; fields: string[] }[] } | { error: string } {
  const input = text.replace(/^﻿/, '');
  const rows: { line: number; fields: string[] }[] = [];
  let field = '';
  let fields: string[] = [];
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (field.trim()) return { error: `line ${line}: a quote inside an unquoted field` };
      quoted = true;
      field = '';
    } else if (c === ',') { fields.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      fields.push(field);
      if (fields.some((f) => f.trim())) rows.push({ line: rowLine, fields });
      fields = []; field = '';
      line++; rowLine = line;
    } else field += c;
  }
  if (quoted) return { error: `line ${rowLine}: an unterminated quoted field` };
  fields.push(field);
  if (fields.some((f) => f.trim())) rows.push({ line: rowLine, fields });
  return { rows };
}

interface LeadInput { name: string; email: string; company: string; source: string; basis: string; tags?: string }

/** Validates one lead. Returns the clean fields or why it is refused. */
export function validateLead(input: LeadInput): { ok: true; lead: Pick<Lead, 'email' | 'name' | 'company' | 'source' | 'basis' | 'tags'> } | { ok: false; reason: string } {
  const bad = (s: string) => /[\u0000-\u001f\u007f\u2028\u2029]/.test(s);
  const raw = String(input.email ?? '').trim();
  if (!raw) return { ok: false, reason: 'email is missing' };
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, reason: `"${raw.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 80)}" is not a valid email address` };
  const fields = { name: String(input.name ?? '').trim(), company: String(input.company ?? '').trim(), source: String(input.source ?? '').trim(), basis: String(input.basis ?? '').trim() };
  for (const [k, v] of Object.entries(fields)) if (bad(v)) return { ok: false, reason: `${k} contains a line break or control character` };
  if (fields.name.length > 120) return { ok: false, reason: 'name is longer than 120 characters' };
  if (fields.company.length > 160) return { ok: false, reason: 'company is longer than 160 characters' };
  if (!fields.source) return { ok: false, reason: 'source is required (where the address came from)' };
  if (!fields.basis) return { ok: false, reason: 'basis is required (your lawful basis to email this contact)' };
  if (fields.source.length > 200 || fields.basis.length > 200) return { ok: false, reason: 'source and basis must each be at most 200 characters' };
  const tags = String(input.tags ?? '').split(/[;\s]+/).filter(Boolean);
  if (tags.length > 10 || tags.some((t) => !TAG.test(t))) return { ok: false, reason: 'tags must be up to 10 words of letters, digits, _ . or -' };
  return { ok: true, lead: { email, ...fields, tags: [...new Set(tags.map((t) => t.toLowerCase()))] } };
}

// ---- Draft validation ---------------------------------------------------------------------------

export interface ValidDraft { subject: string; audience: string[]; body: string; proposedLeads: Pick<Lead, 'email' | 'name' | 'company' | 'source' | 'basis' | 'tags'>[] }

/** The campaign contract: subject, audience, optional proposedLeads; a plain-text body with only {{name}}/{{company}}. */
export function validateDraft(frontmatter: Frontmatter, body: string): { ok: true; draft: ValidDraft } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  for (const key of Object.keys(frontmatter)) if (!['subject', 'audience', 'proposedLeads'].includes(key)) return fail(`unknown frontmatter key "${key}" (allowed: subject, audience, proposedLeads)`);
  const subject = frontmatter.subject;
  if (typeof subject !== 'string' || !subject.trim()) return fail('subject is required (one line)');
  if (subject.length > MAX_SUBJECT) return fail(`subject is longer than ${MAX_SUBJECT} characters`);
  if (subject.includes('=?')) return fail('subject contains "=?", which mail clients read as an encoded word; rephrase it');
  const audience = frontmatter.audience;
  if (!Array.isArray(audience) || !audience.length) return fail('audience is required: a list of lead tags or ids, or [all]');
  if (audience.length > 50 || audience.some((a) => !TAG.test(a))) return fail('audience entries must be lead tags, lead ids (L3) or "all"');
  if (!body.trim()) return fail('the body is empty');
  if (body.length > MAX_BODY) return fail(`the body is longer than ${MAX_BODY} characters`);
  if (/<\/?[a-z][^>]*>/i.test(body)) return fail('the body must be plain text, without HTML');
  for (const [label, text] of [['subject', subject], ['body', body]] as const) {
    for (const m of text.matchAll(MERGE)) if (m[1] !== 'name' && m[1] !== 'company') return fail(`${label} uses {{${m[1].slice(0, 30)}}}; only {{name}} and {{company}} are allowed`);
    if (/\{\{|\}\}/.test(text.replace(MERGE, ''))) return fail(`${label} has an unmatched {{ or }}`);
  }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(body)) return fail('the body contains control characters');
  const longLine = body.split('\n').findIndex((line) => Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES);
  if (longLine >= 0) return fail(`body line ${longLine + 1} is longer than ${MAX_LINE_BYTES} bytes; break it into shorter lines`);
  const proposed: ValidDraft['proposedLeads'] = [];
  const raw = frontmatter.proposedLeads;
  if (raw !== undefined) {
    if (!Array.isArray(raw)) return fail('proposedLeads must be a list of "Name | email | Company | source | basis"');
    if (raw.length > MAX_PROPOSED) return fail(`proposedLeads has more than ${MAX_PROPOSED} entries`);
    for (const [i, entry] of raw.entries()) {
      const parts = entry.split('|').map((p) => p.trim());
      if (parts.length !== 5) return fail(`proposedLeads #${i + 1} must be "Name | email | Company | source | basis"`);
      const v = validateLead({ name: parts[0], email: parts[1], company: parts[2], source: parts[3], basis: parts[4] });
      if (!v.ok) return fail(`proposedLeads #${i + 1}: ${v.reason}`);
      proposed.push(v.lead);
    }
  }
  return { ok: true, draft: { subject: subject.trim(), audience: audience.map((a) => a.toLowerCase()), body, proposedLeads: proposed } };
}

/** The item prompt for a campaign draft: the exact artifact path and format, and what the worker must never do. */
export function campaignPrompt(jobId: string, title: string, brief: string, tags: string[]): string {
  return [
    `Draft an email campaign for the Empire's marketing & sales executive. Campaign: ${title}.`,
    `Brief from the CEO:\n${brief}`,
    `Write exactly one file, ${artifactPath('campaigns', jobId)}, and commit it on your branch. It must start with this frontmatter (strict; nothing else is read):`,
    '---\nsubject: One line, at most 150 characters\naudience: [all]\nproposedLeads:\n  - Name | email@example.com | Company | source | lawful basis\n---',
    `audience lists lead tags or lead ids (for example [customers, L3]) or [all]. Tags in use: ${tags.length ? tags.join(', ') : 'none yet'}.`,
    'proposedLeads is optional: only people with a real lawful basis whose address you were given. Never scrape, guess or buy addresses. The CEO must accept each proposed lead before it is emailed.',
    'After the frontmatter, write the plain-text body. Use only the merge fields {{name}} and {{company}}. No HTML, no tracking links, no signature block and no unsubscribe text: the server appends the sender\'s postal address and "Reply STOP to stop receiving these emails" itself.',
    'Do not send any email or contact anyone yourself. Sending happens only after the CEO approves the exact message.',
  ].join('\n\n');
}

// ---- Storage ------------------------------------------------------------------------------------

/** `bounce`: a recipient-specific RCPT refusal; suppressed as a bounce once a later send succeeds ('confirmed'). */
interface Send { status: SendStatus; at: number; detail?: string; bounce?: 'pending' | 'confirmed' }

interface StoredCampaign {
  id: string;
  requestId: string;
  title: string;
  brief: string;
  createdAt: number;
  createdBy: string;
  jobId: string;
  state: CampaignState;
  issue?: string;
  note?: string;
  draft?: { subject: string; audience: string[]; body: string; draftedBy: string; importedAt: number; taskId: string; proposedLeads: number };
  /**
   * The drafting queue task as first seen (and updated per attempt), so a draft can still be read from the committed
   * branch if the queue forgets the task before the import. `done`: it was seen finishing with outcome 'done'.
   */
  task?: { id: string; attempt: number; branch?: string; workerName?: string; done?: true };
  snapshot?: Snapshot;
  approvalId?: string;
  decidedBy?: string;
  decidedAt?: number;
  /** Per recipient, keyed by lowercase address. Absent means not attempted yet. */
  sends: Record<string, Send>;
  /** Transient (definitely not sent) failures per address. */
  attempts?: Record<string, number>;
}

interface LeadsFile { version: 1; nextLead: number; leads: Lead[]; suppression: Suppression[] }
interface OutreachFile { version: 1; nextCampaign: number; campaigns: StoredCampaign[]; daily: { day: string; count: number }; lastSendAt?: number }

/** The consultancy operations outreach uses: reserve a job id, create the internal job, read jobs. */
export interface OutreachConsultancy {
  newJobId(): string;
  create(input: unknown, actor: string, options?: { id?: string }): ConsultancyJob;
  snapshot(): ConsultancySnapshot;
}

/** The approval inbox operations outreach uses. */
export interface OutreachInbox {
  raiseExternal(fields: { source: string; title: string; detail: string; jobId: string; outreach: OutreachApproval }): Approval;
  resolveExternal(id: string, note: string): void;
  get(id: string): Approval | undefined;
}

export interface OutreachOptions {
  projectDir: string;
  office: OutreachConsultancy;
  queue: () => QueueState;
  config: OutreachConfig;
  /** The SMTP transport (ORG-03 client). Absent when sending is not configured. */
  transport?: MailTransport;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
  onChange?: () => void;
  log?: (line: string) => void;
}

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export class Outreach {
  private readonly leadsFile: string;
  private readonly outreachFile: string;
  private leads: LeadsFile = { version: 1, nextLead: 1, leads: [], suppression: [] };
  private data: OutreachFile = { version: 1, nextCampaign: 1, campaigns: [], daily: { day: '', count: 0 } };
  private storageError?: string;
  private inbox?: OutreachInbox;
  private sending = false;
  private cancelTimer?: () => void;
  private consecutiveFailures = 0;
  private refusalStreak = 0;
  /** The recipients refused in the current RCPT streak (any code); cleared on success, resume and pause. */
  private streakEmails: { campaign: string; email: string }[] = [];
  private stopped = false;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly log: (line: string) => void;

  constructor(dataDir: string, private readonly opts: OutreachOptions) {
    this.leadsFile = path.join(dataDir, LEADS_FILE);
    this.outreachFile = path.join(dataDir, OUTREACH_FILE);
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
    this.log = opts.log ?? ((line) => console.warn(line));
    this.restore();
  }

  setInbox(inbox: OutreachInbox) { this.inbox = inbox; }

  get recoveryError() { return this.storageError; }

  get sendingEnabled() { return !this.opts.config.problems.length && !!this.opts.transport; }

  stop() {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  // ---- Leads and suppression ----

  importCsv(csv: unknown, actor: string): { added: number; confirmed: number; duplicates: number; errors: { line: number; reason: string }[] } {
    this.assertMutable();
    if (typeof csv !== 'string' || !csv.trim()) throw new OutreachError(400, 'Paste or choose a CSV file with a header row: name,email,company,source,basis');
    if (Buffer.byteLength(csv) > MAX_CSV_BYTES) throw new OutreachError(400, 'The CSV is larger than 1 MB.');
    const parsed = parseCsv(csv);
    if ('error' in parsed) throw new OutreachError(400, `The CSV could not be read: ${parsed.error}`);
    const [header, ...rows] = parsed.rows;
    if (!header) throw new OutreachError(400, 'The CSV is empty.');
    const cols = header.fields.map((f) => f.trim().toLowerCase());
    const missing = ['name', 'email', 'company', 'source', 'basis'].filter((c) => !cols.includes(c));
    if (missing.length) throw new OutreachError(400, `The header row must name the columns name,email,company,source,basis (missing: ${missing.join(', ')}). An optional tags column takes words separated by ; or spaces.`);
    const unknown = cols.filter((c) => !['name', 'email', 'company', 'source', 'basis', 'tags'].includes(c));
    if (unknown.length) throw new OutreachError(400, `Unknown column${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
    if (rows.length > MAX_LEADS) throw new OutreachError(400, `At most ${MAX_LEADS} rows per import.`);
    const at = (row: string[], c: string) => (cols.indexOf(c) >= 0 ? row[cols.indexOf(c)] ?? '' : '');
    const report = { added: 0, confirmed: 0, duplicates: 0, errors: [] as { line: number; reason: string }[] };
    const who = clean(actor, 120) || 'CEO';
    const seen = new Set<string>();
    const changes: (() => void)[] = [];
    let total = this.leads.leads.length;
    for (const row of rows) {
      if (row.fields.length !== cols.length) { report.errors.push({ line: row.line, reason: `expected ${cols.length} fields, found ${row.fields.length}` }); continue; }
      const v = validateLead({ name: at(row.fields, 'name'), email: at(row.fields, 'email'), company: at(row.fields, 'company'), source: at(row.fields, 'source'), basis: at(row.fields, 'basis'), tags: at(row.fields, 'tags') });
      if (!v.ok) { report.errors.push({ line: row.line, reason: v.reason }); continue; }
      if (seen.has(v.lead.email)) { report.duplicates++; continue; }
      seen.add(v.lead.email);
      const existing = this.leads.leads.find((l) => l.email === v.lead.email);
      if (existing?.status === 'confirmed') { report.duplicates++; continue; }
      if (existing) {
        // The CEO's own import confirms a worker-proposed lead, with the CEO's recorded source and basis.
        changes.push(() => Object.assign(existing, v.lead, { status: 'confirmed', addedBy: who, addedAt: this.now() }));
        report.confirmed++;
        continue;
      }
      if (total >= MAX_LEADS) { report.errors.push({ line: row.line, reason: `the lead list is full (${MAX_LEADS})` }); continue; }
      total++;
      changes.push(() => this.leads.leads.push({ id: `L${this.leads.nextLead++}`, ...v.lead, status: 'confirmed', addedAt: this.now(), addedBy: who }));
      report.added++;
    }
    if (changes.length) this.commitLeads(() => { for (const c of changes) c(); });
    return report;
  }

  acceptLead(id: string, actor: string): Lead {
    this.assertMutable();
    const lead = this.requireLead(id);
    if (lead.status === 'confirmed') return { ...lead };
    this.commitLeads(() => { lead.status = 'confirmed'; lead.addedBy = clean(actor, 120) || 'CEO'; lead.addedAt = this.now(); });
    return { ...lead };
  }

  /** Drops a worker-proposed lead. Confirmed leads are never deleted here (add an opt-out or block instead). */
  rejectLead(id: string): void {
    this.assertMutable();
    const lead = this.requireLead(id);
    if (lead.status !== 'proposed') throw new OutreachError(409, 'Only proposed leads can be declined. Block a confirmed lead instead.');
    this.commitLeads(() => { this.leads.leads = this.leads.leads.filter((l) => l !== lead); });
  }

  isSuppressed(email: string) { const e = normalizeEmail(email) ?? email.toLowerCase(); return this.leads.suppression.some((s) => s.email === e); }

  /** Adds an address to the suppression list. Idempotent; the first reason recorded stays. */
  suppress(emailInput: unknown, reason: SuppressionReason, actor: string, note?: string): Suppression {
    this.assertMutable();
    const email = normalizeEmail(emailInput) ?? '';
    if (!email) throw new OutreachError(400, 'Enter one valid email address.');
    if (!['opt_out', 'bounce', 'blocked'].includes(reason)) throw new OutreachError(400, 'reason must be opt_out or blocked');
    const existing = this.leads.suppression.find((s) => s.email === email);
    if (existing) return { ...existing };
    const entry: Suppression = { email, reason, at: this.now(), by: clean(actor, 120) || 'CEO', ...(note ? { note: clean(note, 200) } : {}) };
    this.commitLeads(() => { this.leads.suppression.push(entry); });
    this.reconcile();
    return { ...entry };
  }

  // ---- Campaigns ----

  /** Creates a campaign and its internal drafting job (client "Internal"), which waits for the CEO's approval. */
  createCampaign(input: unknown, actor: string, options: { jobId?: string } = {}): CampaignView {
    this.assertMutable();
    const raw = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
    const requestId = typeof raw.requestId === 'string' ? raw.requestId.trim() : '';
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const brief = typeof raw.brief === 'string' ? raw.brief.trim() : '';
    if (!requestId || requestId.length > 120) throw new OutreachError(400, 'requestId is required');
    if (!title || title.length > 120) throw new OutreachError(400, 'Give the campaign a title (at most 120 characters).');
    if (!brief || brief.length > 4000) throw new OutreachError(400, 'Describe the campaign in the brief (at most 4,000 characters).');
    const known = this.data.campaigns.find((c) => c.requestId === requestId);
    if (known) {
      if (known.title !== title || known.brief !== brief) throw new OutreachError(409, `Request ${requestId} already exists with different content`);
      return this.view(known);
    }
    if (this.data.campaigns.filter((c) => !['completed', 'cancelled', 'rejected'].includes(c.state)).length >= MAX_CAMPAIGNS) throw new OutreachError(409, 'Too many open campaigns.');
    const jobId = options.jobId ?? this.opts.office.newJobId();
    const tags = [...new Set(this.leads.leads.filter((l) => l.status === 'confirmed').flatMap((l) => l.tags))].slice(0, 30);
    const who = clean(actor, 120) || 'CEO';
    try {
      this.opts.office.create({
        requestId: `outreach-${requestId}`.slice(0, 120), client: 'Internal', title: `Campaign draft: ${title}`, brief,
        tasks: [{ title: `Draft the “${title}” campaign`, prompt: campaignPrompt(jobId, title, brief, tags) }],
      }, who, { id: jobId });
    } catch (error) {
      const status = (error as { status?: number }).status;
      throw new OutreachError(typeof status === 'number' ? status : 500, (error as Error).message);
    }
    const campaign: StoredCampaign = { id: `C${this.data.nextCampaign}`, requestId, title, brief, createdAt: this.now(), createdBy: who, jobId, state: 'drafting', sends: {} };
    this.commit(() => { this.data.nextCampaign++; this.data.campaigns.push(campaign); });
    return this.view(campaign);
  }

  pause(id: string, actor: string): CampaignView {
    this.assertMutable();
    const c = this.requireCampaign(id);
    if (c.state === 'paused') return this.view(c);
    if (c.state !== 'sending') throw new OutreachError(409, 'Only a sending campaign can be paused.');
    this.commit(() => { c.state = 'paused'; c.note = `Paused by ${clean(actor, 120) || 'CEO'}`; });
    return this.view(c);
  }

  resume(id: string, actor: string): CampaignView {
    this.assertMutable();
    const c = this.requireCampaign(id);
    if (c.state === 'sending') return this.view(c);
    if (c.state !== 'paused') throw new OutreachError(409, 'Only a paused campaign can be resumed.');
    this.consecutiveFailures = 0;
    this.refusalStreak = 0;
    this.streakEmails = [];
    this.commit(() => { c.state = 'sending'; c.note = `Resumed by ${clean(actor, 120) || 'CEO'}`; });
    this.pump();
    return this.view(c);
  }

  /** Stops a campaign for good. Nobody not yet sent to is emailed; a send already in flight finishes and is recorded. */
  cancel(id: string, actor: string): CampaignView {
    this.assertMutable();
    const c = this.requireCampaign(id);
    if (c.state === 'cancelled') return this.view(c);
    if (['completed', 'rejected'].includes(c.state)) throw new OutreachError(409, `The campaign is already ${c.state}.`);
    const pending = c.approvalId && c.state === 'awaiting_approval' ? c.approvalId : undefined;
    this.commit(() => { c.state = 'cancelled'; c.note = `Cancelled by ${clean(actor, 120) || 'CEO'}`; });
    if (pending) this.inbox?.resolveExternal(pending, 'The campaign was cancelled before approval.');
    return this.view(c);
  }

  /** ExternalActionPort.check: only the exact pending snapshot can be decided; anything else is out of date (409). */
  check(item: Approval, decision: 'approved' | 'rejected'): void {
    if (this.storageError) throw new ApprovalError(503, this.storageError);
    const o = item.outreach;
    const c = o && this.data.campaigns.find((x) => x.id === o.campaignId);
    if (!o || !c) throw new ApprovalError(404, 'The campaign for this approval no longer exists.');
    if (c.approvalId !== item.id || c.state !== 'awaiting_approval' || c.snapshot?.hash !== o.snapshotHash)
      throw new ApprovalError(409, 'This approval is out of date: the campaign changed, so a new approval item replaces it. Nothing was sent.');
    if (decision === 'approved') {
      // Any change since the item was raised (recipients, suppression, sender settings) makes a new item instead.
      const now = this.candidate(c);
      if (!('hash' in now) || now.hash !== o.snapshotHash) {
        queueMicrotask(() => this.reconcile());
        throw new ApprovalError(409, 'This approval is out of date: what would be sent changed, so a new approval item replaces it. Nothing was sent.');
      }
      if (!this.sendingEnabled) throw new ApprovalError(409, `Sending is disabled: ${this.opts.config.problems.join(' ') || 'no SMTP transport'}`);
    }
  }

  /** ExternalActionPort.apply: called only after the inbox saved the decision. Approving starts the send. */
  apply(item: Approval, decision: 'approved' | 'rejected', actor: string): void {
    const c = this.data.campaigns.find((x) => x.id === item.outreach?.campaignId);
    if (!c || c.state !== 'awaiting_approval' || c.approvalId !== item.id) return;
    this.commit(() => {
      c.state = decision === 'approved' ? 'sending' : 'rejected';
      c.decidedBy = actor;
      c.decidedAt = this.now();
      c.note = decision === 'approved' ? `Approved by ${actor}` : `Declined by ${actor}; nothing was sent.`;
    });
    if (decision === 'approved') queueMicrotask(() => this.pump());
  }

  /** Imports finished drafts, keeps each pending approval matching what would be sent, then sends. Never throws. */
  reconcile(): boolean {
    if (this.storageError || this.stopped) return false;
    const before = JSON.stringify(this.data.campaigns);
    try {
      let jobs: ConsultancyJob[] = [];
      try { jobs = this.opts.office.snapshot().jobs; } catch { jobs = []; }
      let tasks: QueueState['tasks'] = [];
      try { tasks = this.opts.queue().tasks; } catch { tasks = []; }
      for (const c of this.data.campaigns) {
        if (c.state === 'drafting' || c.state === 'needs_attention') this.reconcileDraft(c, jobs, tasks);
        if (c.state === 'ready' || c.state === 'awaiting_approval') this.reconcileApproval(c);
      }
      if (JSON.stringify(this.data.campaigns) !== before) { this.save(); this.changed(); }
    } catch (error) {
      this.log(`[outreach] reconcile failed: ${(error as Error).message}`);
    }
    this.pump();
    return JSON.stringify(this.data.campaigns) !== before;
  }

  /** Consultancy port: a finished draft item whose artifact is missing or invalid needs attention, with the reason. */
  itemAttention(jobId: string): string | undefined {
    const c = this.data.campaigns.find((x) => x.jobId === jobId);
    return c?.state === 'needs_attention' ? c.issue : undefined;
  }

  /** The consultancy itemIssue port, keyed by job key (consultancy:<jobId>:<itemId>). */
  itemIssue(jobKey: string): string | undefined {
    const m = /^consultancy:([^:]+):/.exec(jobKey);
    return m ? this.itemAttention(m[1]) : undefined;
  }

  private reconcileDraft(c: StoredCampaign, jobs: ConsultancyJob[], tasks: QueueState['tasks']) {
    const job = jobs.find((j) => j.id === c.jobId);
    if (!job) return;
    if (job.decision === 'rejected') { c.state = 'rejected'; c.note = 'The drafting plan was declined; nothing was drafted or sent.'; return; }
    const item = job.items[0];
    const live = item?.queueTaskId ? tasks.find((t) => t.id === item.queueTaskId) : undefined;
    if (live) {
      const attempt = live.attempt ?? 1;
      const done = live.status === 'done' && live.outcome === 'done';
      const seen = { id: live.id, attempt, ...(live.branch ? { branch: live.branch } : {}), ...(live.workerName ? { workerName: live.workerName } : {}), ...(done ? { done: true as const } : {}) };
      if (JSON.stringify(seen) !== JSON.stringify(c.task)) c.task = seen;
      if (live.status !== 'done') {
        // A retried task gets another chance to write a valid draft.
        if (c.state === 'needs_attention') { c.state = 'drafting'; delete c.issue; }
        return;
      }
      if (!done) return;
    } else if (!(c.task && c.task.id === item?.queueTaskId && (c.task.done || item.status === 'awaiting_review' || c.state === 'needs_attention'))) {
      // Consultancy remembers an item that finished with outcome done (finishedOk → awaiting_review) after the queue
      // forgets it; with the persisted binding, the draft is still read from the committed branch.
      if (item?.queueTaskId && item.status === 'awaiting_review' && c.state === 'drafting') { c.state = 'needs_attention'; c.issue = 'The drafting task left the queue before it was seen finishing, so its draft cannot be located.'; }
      return;
    }
    // The task finished with outcome done (seen live, or remembered): read its artifact from the worktree or branch.
    const bound = c.task!;
    const read = readArtifact(this.opts.projectDir, { status: 'done', outcome: 'done', ...(bound.branch ? { branch: bound.branch } : {}) }, 'campaigns', c.jobId);
    const result = read.ok ? validateDraft(read.frontmatter, read.body) : read;
    if (!result.ok) {
      c.state = 'needs_attention';
      c.issue = `${read.ok ? `${artifactPath('campaigns', c.jobId)}: ` : ''}${result.reason}`;
      return;
    }
    const draft = result.draft;
    c.draft = { subject: draft.subject, audience: draft.audience, body: draft.body, draftedBy: clean(bound.workerName ?? 'a worker', 80), importedAt: this.now(), taskId: bound.id, proposedLeads: draft.proposedLeads.length };
    delete c.issue;
    c.state = 'ready';
    if (draft.proposedLeads.length) {
      this.commitLeads(() => {
        for (const p of draft.proposedLeads) {
          if (this.leads.leads.length >= MAX_LEADS || this.leads.leads.some((l) => l.email === p.email)) continue;
          this.leads.leads.push({ id: `L${this.leads.nextLead++}`, ...p, status: 'proposed', addedAt: this.now(), addedBy: c.draft!.draftedBy, proposedBy: c.id });
        }
      });
    }
  }

  /** The snapshot that would be sent now, or why there is none. */
  private candidate(c: StoredCampaign): Snapshot | { reason: string } {
    const cfg = this.opts.config;
    if (!this.sendingEnabled || !cfg.from || !cfg.address) return { reason: `Sending is disabled: ${cfg.problems.join(' ') || 'no SMTP transport is configured.'}` };
    const draft = c.draft!;
    const all = draft.audience.includes('all');
    const matches = (l: Lead) => all || draft.audience.includes(l.id.toLowerCase()) || l.tags.some((t) => draft.audience.includes(t));
    const excluded: OutreachExcluded = { suppressed: 0, invalid: 0, unconfirmed: 0 };
    const recipients: Recipient[] = [];
    const seen = new Set<string>();
    for (const lead of this.leads.leads) {
      if (!matches(lead) || seen.has(lead.email)) continue;
      seen.add(lead.email);
      if (lead.status !== 'confirmed') { excluded.unconfirmed++; continue; }
      if (this.isSuppressed(lead.email)) { excluded.suppressed++; continue; }
      if (!isEmailAddress(lead.email)) { excluded.invalid++; continue; }
      recipients.push({ email: lead.email, name: mergeValue(lead.name), company: mergeValue(lead.company) });
    }
    if (!recipients.length) return { reason: `No confirmed, unsuppressed leads match the audience (${draft.audience.join(', ')}).` };
    if (recipients.length > MAX_RECIPIENTS) return { reason: `${recipients.length} recipients is more than the ${MAX_RECIPIENTS} one campaign may send; narrow the audience.` };
    const body: Omit<Snapshot, 'hash' | 'createdAt'> = {
      subject: draft.subject, body: draft.body, footer: outreachFooter(cfg), from: cfg.from, ...(cfg.fromName ? { fromName: cfg.fromName } : {}),
      dailyCap: cfg.dailyCap, intervalSec: Math.round(cfg.intervalMs / 1000), recipients, excluded,
    };
    return { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'), createdAt: this.now() };
  }

  private reconcileApproval(c: StoredCampaign) {
    if (!this.inbox || !c.draft) return;
    const next = this.candidate(c);
    if (c.state === 'awaiting_approval' && c.approvalId) {
      const item = this.inbox.get(c.approvalId);
      if (item && item.status === 'pending' && 'hash' in next && next.hash === c.snapshot?.hash) return;
      if (item?.status === 'pending') this.inbox.resolveExternal(c.approvalId, 'what would be sent changed (recipients, suppression or sender settings); a new approval item replaces this one');
      else if (item?.status === 'rejected') { c.state = 'rejected'; return; }
      delete c.approvalId;
      delete c.snapshot;
      c.state = 'ready';
    }
    if (!('hash' in next)) { c.note = next.reason; return; }
    const samples = next.recipients.slice(0, 2).map((r) => { const m = renderOutreach(next, r); return { to: m.to, subject: m.subject, text: m.text }; });
    const item = this.inbox.raiseExternal({
      source: `outreach:${c.id}:${next.hash}`,
      title: `Send “${c.title}” to ${plural(next.recipients.length, 'recipient')}`,
      detail: `Email campaign ${c.id} · from ${next.from} · ${next.dailyCap} a day at most · ${next.excluded.suppressed} suppressed, ${next.excluded.invalid} invalid, ${next.excluded.unconfirmed} unconfirmed excluded`,
      jobId: c.jobId,
      outreach: {
        campaignId: c.id, snapshotHash: next.hash, channel: 'email', from: next.from, dailyCap: next.dailyCap, intervalSec: next.intervalSec,
        samples, recipients: next.recipients.map((r) => r.email), excluded: next.excluded, draftedBy: c.draft.draftedBy,
      },
    });
    if (item.status !== 'pending') { c.note = `The inbox returned ${item.id} as ${item.status}; it cannot be approved.`; return; }
    c.snapshot = next;
    c.approvalId = item.id;
    c.state = 'awaiting_approval';
    c.note = `Waiting for your approval (${item.id})`;
  }

  // ---- Sending ----

  /** Sends the next message when one is due. One at a time, one recipient per message, never faster than the interval. */
  pump() {
    if (this.sending || this.cancelTimer || this.storageError || this.stopped) return;
    const cfg = this.opts.config;
    for (;;) {
      const c = this.data.campaigns.find((x) => x.state === 'sending');
      if (!c || !c.snapshot) return;
      if (!this.sendingEnabled || !this.opts.transport) {
        const note = `Waiting: sending is disabled — ${cfg.problems.join(' ') || 'no SMTP transport'}`;
        if (c.note !== note) this.commit(() => { c.note = note; });
        return;
      }
      const now = this.now();
      const day = utcDay(now);
      if (this.data.daily.day !== day) this.data.daily = { day, count: 0 };
      const next = c.snapshot.recipients.find((r) => !c.sends[r.email]);
      if (!next) {
        if (!Object.values(c.sends).some((s) => s.status === 'in_flight')) this.commit(() => { c.state = 'completed'; c.note = 'Every recipient has a result.'; });
        continue;
      }
      // Suppression always wins, checked at the moment of sending, and costs no send slot.
      if (this.isSuppressed(next.email)) {
        this.commit(() => { c.sends[next.email] = { status: 'suppressed', at: now, detail: 'On the suppression list at send time' }; });
        continue;
      }
      if (this.data.daily.count >= cfg.dailyCap) {
        const note = `Daily cap of ${cfg.dailyCap} reached — resumes after midnight UTC`;
        if (c.note !== note) this.commit(() => { c.note = note; });
        const tomorrow = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
        this.wait(Math.min(Math.max(1_000, tomorrow - now), 3_600_000));
        return;
      }
      const due = (this.data.lastSendAt ?? 0) + cfg.intervalMs - now;
      if (due > 0) { this.wait(due); return; }
      this.sendOne(c, next);
      return;
    }
  }

  private wait(ms: number) {
    this.cancelTimer = this.schedule(() => { this.cancelTimer = undefined; this.pump(); }, ms);
  }

  private sendOne(c: StoredCampaign, r: Recipient) {
    const snapshot = c.snapshot!;
    // Durable before the send: after a crash this recipient is "unknown", never sent again automatically.
    this.commit(() => {
      c.sends[r.email] = { status: 'in_flight', at: this.now() };
      this.data.daily.count++;
      this.data.lastSendAt = this.now();
      if (c.note?.startsWith('Daily cap') || c.note?.startsWith('Waiting')) c.note = undefined;
    });
    this.sending = true;
    let message: MailMessage;
    try { message = renderOutreach(snapshot, r); } catch (error) { this.sending = false; this.finish(c, r, { status: 'failed', detail: (error as Error).message }); return; }
    void this.opts.transport!.send(message).then(
      () => { this.consecutiveFailures = 0; this.refusalStreak = 0; this.streakEmails = []; this.finish(c, r, { status: 'sent' }); this.confirmBounces(); },
      (error: unknown) => this.failed(c, r, error),
    ).finally(() => { this.sending = false; this.pump(); });
  }

  private finish(c: StoredCampaign, r: Recipient, result: { status: SendStatus; detail?: string; bounce?: 'pending' } | null, extra?: () => void) {
    this.commit(() => {
      if (result) c.sends[r.email] = { status: result.status, at: this.now(), ...(result.detail ? { detail: result.detail } : {}), ...(result.bounce ? { bounce: result.bounce } : {}) };
      else { delete c.sends[r.email]; this.data.daily.count = Math.max(0, this.data.daily.count - 1); }
      extra?.();
    });
  }

  /** Classifies a failed send. Only definite answers free the recipient for another try; anything uncertain is "unknown". */
  private failed(c: StoredCampaign, r: Recipient, error: unknown) {
    const message = error instanceof Error ? error.message : 'send failed';
    if (!(error instanceof SmtpError) || error.uncertain) {
      this.log(`[outreach] ${c.id}: the result for one recipient is unknown (${message}); it will not be re-sent automatically.`);
      this.finish(c, r, { status: 'unknown', detail: 'Unknown — the server may have accepted it; check before resending' });
      return;
    }
    // The message itself was refused (content, size, policy): the same would happen for everyone. Nobody is suppressed.
    const dataRefusal = /answered (5\d\d) to end of DATA/.exec(message);
    if (dataRefusal) return this.pauseFor(c, r, `The mail server refused the message itself (${dataRefusal[1]} at end of DATA) — usually its content, size or a sending policy. Nobody was suppressed. Check the draft and the SMTP account, then resume.`);
    const rcpt = /answered (5\d\d) to RCPT TO/.exec(message);
    if (rcpt) {
      this.refusalStreak++;
      if (this.refusalStreak >= PAUSE_AFTER_REFUSALS) {
        // Several refusals in a row look like a server or policy problem: revert them to pending, suppress nobody.
        const streak = this.refusalStreak;
        const refused = this.streakEmails.filter((x) => x.campaign === c.id).map((x) => x.email);
        this.refusalStreak = 0;
        this.streakEmails = [];
        // Every refusal in the streak goes back to pending, whatever its code, and its day-count slot is refunded.
        this.commit(() => {
          for (const email of refused) if (c.sends[email]?.status === 'refused') { delete c.sends[email]; this.data.daily.count = Math.max(0, this.data.daily.count - 1); }
        });
        return this.pauseFor(c, r, `Paused after ${streak} refusals in a row (last: ${rcpt[1]} to RCPT TO). This looks like a server or policy problem rather than bad addresses, so nobody was suppressed and they will be retried. Check the SMTP account, then resume.`);
      }
      this.streakEmails.push({ campaign: c.id, email: r.email });
      // A mailbox bounce needs a mailbox code and, when the server gives one, an enhanced status of 5.1.x (address)
      // or 5.2.x (mailbox). 5.7.x is policy or reputation and never suppresses.
      const enhanced = (error as SmtpError).enhanced;
      const specific = RECIPIENT_CODES.has(rcpt[1]) && (!enhanced || /^5\.[12]\./.test(enhanced));
      this.finish(c, r, { status: 'refused', detail: specific ? `Refused (${rcpt[1]} to RCPT TO); suppressed as a bounce once a later send succeeds` : `Refused (${rcpt[1]}${enhanced ? ` ${enhanced}` : ''} to RCPT TO); not suppressed (not a mailbox error)`, ...(specific ? { bounce: 'pending' as const } : {}) });
      return;
    }
    if (/answered 5\d\d to MAIL FROM/.test(message)) return this.pauseFor(c, r, 'The mail server refused the sender address (5xx to MAIL FROM). Check AGENT_EMPIRE_OUTREACH_FROM, then resume.');
    if (/answered 5\d\d to AUTH|neither AUTH PLAIN nor AUTH LOGIN/.test(message)) return this.pauseFor(c, r, 'Sign-in to the SMTP server failed — check AGENT_EMPIRE_SMTP_URL, then resume.');
    // Definitely not accepted (connection, TLS, timeout before DATA, 4xx): free the slot and retry a few times.
    this.consecutiveFailures++;
    const attempts = (c.attempts?.[r.email] ?? 0) + 1;
    this.log(`[outreach] ${c.id}: send attempt ${attempts} failed (${message}).`);
    if (attempts >= MAX_TRANSIENT_ATTEMPTS) this.finish(c, r, { status: 'failed', detail: `Not sent after ${attempts} attempts (${message})` });
    else this.finish(c, r, null, () => { c.attempts = { ...c.attempts, [r.email]: attempts }; });
    if (this.consecutiveFailures >= PAUSE_AFTER_FAILURES) this.pauseFor(c, undefined, `Paused after ${this.consecutiveFailures} failed sends in a row (last: ${message}). Check the SMTP server, then resume.`);
  }

  /**
   * A send succeeded, so earlier recipient-specific refusals were about those mailboxes, not the server: confirm them as
   * bounces. outreach.json records the confirmation first; leads.json follows, and restore() repairs any gap.
   */
  private confirmBounces() {
    let any = false;
    for (const c of this.data.campaigns) for (const s of Object.values(c.sends)) if (s.bounce === 'pending') { s.bounce = 'confirmed'; any = true; }
    if (!any) return;
    this.save();
    this.applyBounces();
  }

  /** Every confirmed bounce in outreach.json is on the suppression list (idempotent). */
  private applyBounces(): boolean {
    let added = false;
    for (const c of this.data.campaigns) for (const [email, s] of Object.entries(c.sends)) {
      if (s.bounce !== 'confirmed' || this.leads.suppression.some((x) => x.email === email)) continue;
      this.leads.suppression.push({ email, reason: 'bounce', at: s.at, by: ACTOR, note: `SMTP ${/\((\d{3})/.exec(s.detail ?? '')?.[1] ?? '5xx'}` });
      added = true;
    }
    if (added) { this.saveLeads(); this.changed(); }
    return added;
  }

  private pauseFor(c: StoredCampaign, r: Recipient | undefined, note: string) {
    this.log(`[outreach] ${c.id}: ${note}`);
    this.commit(() => {
      if (r && c.sends[r.email]?.status === 'in_flight') { delete c.sends[r.email]; this.data.daily.count = Math.max(0, this.data.daily.count - 1); }
      if (c.state === 'sending') c.state = 'paused';
      c.note = note;
    });
    this.consecutiveFailures = 0;
    this.refusalStreak = 0;
    this.streakEmails = [];
  }

  // ---- Views ----

  status(): OutreachStatus {
    const cfg = this.opts.config;
    const day = utcDay(this.now());
    const enabled = this.sendingEnabled;
    return {
      sendingEnabled: enabled,
      label: enabled ? 'Outreach sending: enabled' : `Outreach sending: disabled — ${cfg.problems[0] ?? 'no SMTP transport'}`,
      problems: [...cfg.problems],
      ...(cfg.from ? { from: cfg.from } : {}),
      dailyCap: cfg.dailyCap,
      intervalSec: Math.round(cfg.intervalMs / 1000),
      day,
      sentToday: this.data.daily.day === day ? this.data.daily.count : 0,
    };
  }

  state(): OutreachState {
    return {
      schemaVersion: 1,
      status: this.status(),
      leads: this.leads.leads.map((l) => ({ ...l, tags: [...l.tags] })),
      suppression: this.leads.suppression.map((s) => ({ ...s })),
      campaigns: [...this.data.campaigns].reverse().map((c) => this.view(c)),
      ...(this.storageError ? { storageError: this.storageError } : {}),
    };
  }

  summary(): OutreachSummary {
    const cs = this.data.campaigns;
    return {
      campaigns: cs.filter((c) => !['cancelled', 'rejected'].includes(c.state)).length,
      sending: cs.filter((c) => c.state === 'sending').length,
      drafting: cs.filter((c) => c.state === 'drafting' || c.state === 'needs_attention').length,
      confirmedLeads: this.leads.leads.filter((l) => l.status === 'confirmed').length,
      proposedLeads: this.leads.leads.filter((l) => l.status === 'proposed').length,
      suppressed: this.leads.suppression.length,
      sendingEnabled: this.sendingEnabled,
    };
  }

  /** Telegram /optout: a plain reply, never a throw for bad input. */
  optOutCommand(email: string, actor: string): string {
    try {
      const entry = this.suppress(email, 'opt_out', actor, 'Added from Telegram');
      return `${entry.email} is on the suppression list (${entry.reason.replace('_', '-')}). It will never be emailed again.`;
    } catch (error) {
      if (error instanceof OutreachError && error.status < 500) return `${error.message} Use /optout name@example.com`;
      throw error;
    }
  }

  private view(c: StoredCampaign): CampaignView {
    const counts = c.snapshot ? this.counts(c) : undefined;
    const results = Object.entries(c.sends).sort((a, b) => b[1].at - a[1].at).slice(0, 50).map(([email, s]) => ({ email, status: s.status, at: s.at, ...(s.detail ? { detail: s.detail } : {}) }));
    return {
      id: c.id, title: c.title, brief: c.brief, state: c.state, createdAt: c.createdAt, createdBy: c.createdBy, jobId: c.jobId,
      ...(c.draft ? { draft: { subject: c.draft.subject, audience: [...c.draft.audience], body: c.draft.body, draftedBy: c.draft.draftedBy, importedAt: c.draft.importedAt, proposedLeads: c.draft.proposedLeads } } : {}),
      ...(c.issue ? { issue: c.issue } : {}),
      ...(c.note ? { note: c.note } : {}),
      ...(c.approvalId ? { approvalId: c.approvalId } : {}),
      ...(c.snapshot ? { snapshot: { hash: c.snapshot.hash, from: c.snapshot.from, dailyCap: c.snapshot.dailyCap, recipientCount: c.snapshot.recipients.length, excluded: { ...c.snapshot.excluded }, createdAt: c.snapshot.createdAt, footer: c.snapshot.footer } } : {}),
      ...(counts ? { counts } : {}),
      ...(results.length ? { results } : {}),
    };
  }

  private counts(c: StoredCampaign): CampaignCounts {
    const n: CampaignCounts = { recipients: c.snapshot!.recipients.length, sent: 0, refused: 0, failed: 0, suppressed: 0, unknown: 0, inFlight: 0, pending: 0 };
    for (const r of c.snapshot!.recipients) {
      const s = c.sends[r.email]?.status;
      if (!s) n.pending++;
      else if (s === 'in_flight') n.inFlight++;
      else n[s]++;
    }
    return n;
  }

  // ---- Persistence ----

  private requireLead(id: string): Lead {
    const lead = LEAD_ID.test(id) ? this.leads.leads.find((l) => l.id === id) : undefined;
    if (!lead) throw new OutreachError(404, `Unknown lead: ${String(id).slice(0, 20)}`);
    return lead;
  }

  private requireCampaign(id: string): StoredCampaign {
    const c = CAMPAIGN_ID.test(id) ? this.data.campaigns.find((x) => x.id === id) : undefined;
    if (!c) throw new OutreachError(404, `Unknown campaign: ${String(id).slice(0, 20)}`);
    return c;
  }

  private assertMutable() {
    if (this.storageError) throw new OutreachError(503, this.storageError);
  }

  private commit(mutation: () => void) {
    mutation();
    this.save();
    this.changed();
  }

  private commitLeads(mutation: () => void) {
    mutation();
    this.saveLeads();
    this.changed();
  }

  private changed() {
    try { this.opts.onChange?.(); } catch { /* observers cannot undo a saved file */ }
  }

  private save() {
    try { writeJsonAtomic(this.outreachFile, this.data); } catch (error) {
      this.storageError = `outreach.json could not be saved; sending is stopped. Preserve the file, repair storage and restart. ${(error as Error).message}`;
      throw new OutreachError(503, this.storageError);
    }
  }

  private saveLeads() {
    try { writeJsonAtomic(this.leadsFile, this.leads); } catch (error) {
      this.storageError = `leads.json could not be saved; sending is stopped. Preserve the file, repair storage and restart. ${(error as Error).message}`;
      throw new OutreachError(503, this.storageError);
    }
  }

  private restore() {
    try {
      if (existsSync(this.leadsFile)) this.leads = parseLeads(JSON.parse(readFileSync(this.leadsFile, 'utf8')));
    } catch (error) {
      this.storageError = `Cannot restore leads.json; preserve the file and recover a valid backup. ${(error as Error).message}`;
      return;
    }
    try {
      if (existsSync(this.outreachFile)) this.data = parseOutreach(JSON.parse(readFileSync(this.outreachFile, 'utf8')));
    } catch (error) {
      this.storageError = `Cannot restore outreach.json; preserve the file and recover a valid backup. ${(error as Error).message}`;
      return;
    }
    // A send that was in flight when the server stopped may or may not have been accepted. Never send it again.
    let changed = false;
    for (const c of this.data.campaigns) for (const s of Object.values(c.sends)) if (s.status === 'in_flight') {
      s.status = 'unknown';
      s.detail = 'Unknown — the server stopped during this send; check before resending';
      changed = true;
    }
    if (changed) {
      try { writeJsonAtomic(this.outreachFile, this.data); } catch (error) { this.storageError = `outreach.json could not be saved after restart. ${(error as Error).message}`; }
    }
    // A bounce confirmed in outreach.json whose suppression entry was not saved (a crash in between) is repaired here.
    try { this.applyBounces(); } catch { /* saveLeads sets storageError */ }
  }
}

function parseLeads(value: unknown): LeadsFile {
  const raw = value as LeadsFile;
  if (!raw || typeof raw !== 'object' || raw.version !== 1) throw new Error('unsupported leads.json version');
  if (!Number.isSafeInteger(raw.nextLead) || raw.nextLead < 1 || !Array.isArray(raw.leads) || !Array.isArray(raw.suppression)) throw new Error('leads.json is incomplete');
  const emails = new Set<string>();
  for (const l of raw.leads) {
    if (!l || !LEAD_ID.test(l.id) || typeof l.email !== 'string' || !isEmailAddress(l.email) || emails.has(l.email) || !['confirmed', 'proposed'].includes(l.status) || !Array.isArray(l.tags)) throw new Error('a lead is invalid or duplicated');
    emails.add(l.email);
  }
  for (const s of raw.suppression) if (!s || typeof s.email !== 'string' || !['opt_out', 'bounce', 'blocked'].includes(s.reason)) throw new Error('a suppression entry is invalid');
  return raw;
}

function parseOutreach(value: unknown): OutreachFile {
  const raw = value as OutreachFile;
  if (!raw || typeof raw !== 'object' || raw.version !== 1) throw new Error('unsupported outreach.json version');
  if (!Number.isSafeInteger(raw.nextCampaign) || !Array.isArray(raw.campaigns) || !raw.daily || typeof raw.daily.day !== 'string' || !Number.isSafeInteger(raw.daily.count)) throw new Error('outreach.json is incomplete');
  for (const c of raw.campaigns) {
    if (!c || !CAMPAIGN_ID.test(c.id) || typeof c.jobId !== 'string' || !c.sends || typeof c.sends !== 'object') throw new Error('a campaign is invalid');
    if (['sending', 'paused', 'completed', 'awaiting_approval'].includes(c.state) && (!c.snapshot || !Array.isArray(c.snapshot.recipients))) throw new Error(`campaign ${c.id} has no snapshot`);
  }
  return raw;
}
