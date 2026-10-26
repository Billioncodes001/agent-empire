/**
 * FREE-12: email outreach in cloud mode, kept in `state/outreach.json` of the user's private state repository.
 *
 * Pure and browser-safe. The coordinator (tick job) is the only writer of this file; it never holds the SMTP secret. A
 * separate send job (src/cloud/outreach-send.ts) holds only `AGENT_EMPIRE_SMTP_URL`, sends the batch the tick job claimed
 * for its own run, and writes a receipt the next tick consumes.
 *
 * - Every send needs the CEO's approval of the exact message and recipients: a frozen snapshot becomes one
 *   `external_action` inbox item; any change resolves it and raises a new one.
 * - Compliance as on the server: the fixed footer (postal address, honest sender, STOP line), one message per recipient,
 *   suppression checked at freeze, at claim and again in the send job, and caps per coordinator run and per UTC day.
 * - At most once: a claim without a receipt becomes `uncertain` and is never re-sent.
 * - Privacy: leads hold only email, name, company and tags; opt-outs are salted SHA-256 hashes; a suppressed or finished
 *   recipient's address is removed; "delete lead data" removes every lead and stored address in one commit. Git history
 *   keeps old versions unless the user rewrites it.
 */
import { isEmailAddress, normalizeEmail } from '../shared/email-address.js';
import { checkCampaignText, clean, mergeValue, outreachFooter, renderOutreach, type OutreachRecipient } from '../shared/outreach-render.js';
import { sha256Hex } from '../shared/sha256.js';
import type { OutreachApproval } from '../shared/approvals.js';
import { raiseApproval, type CloudOrg } from './org.js';

export const OUTREACH_FILE = 'state/outreach.json';
export const OUTREACH_LIMITS = { leads: 5000, leadsPerIntent: 200, suppression: 20_000, campaigns: 100, recipients: 500, maxDailyCap: 2000, maxPerRunCap: 100, sentDays: 40, note: 300 } as const;
export const DEFAULT_OUTREACH = { dailyCap: 50, perRunCap: 20 } as const;
export const SUPPRESSION_REASONS = ['unsubscribed', 'bounced', 'complaint', 'manual'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];
const TAG = /^[A-Za-z0-9_.-]{1,40}$/;
const HASH = /^[a-f0-9]{64}$/;
export const PRIVACY_WARNING = 'Leads and opt-outs are personal data. In cloud mode they live in your private GitHub state repository, and git history keeps every version: “Delete lead data” removes them from the current files in a new commit, but old commits still contain them unless you rewrite the repository’s history yourself. Opt-outs are stored only as salted hashes. Only add people who agreed to hear from you; cold outreach breaks most email providers’ terms.';

export interface OutreachSettings { from: string; fromName?: string; address: string; dailyCap: number; perRunCap: number; acknowledgedAt: number }
export interface CloudLead { id: string; email: string; name: string; company: string; tags: string[]; addedAt: number }
export interface CloudSuppression { hash: string; reason: SuppressionReason; at: number }
export interface CampaignSnapshot {
  hash: string; subject: string; body: string; footer: string; from: string; fromName?: string; dailyCap: number; perRunCap: number;
  /** `null` once the address was removed (suppressed, finished, cancelled or deleted). */
  recipients: (OutreachRecipient | null)[];
  excluded: { suppressed: number; invalid: number; unconfirmed: number };
}
export type SendStatus = 'pending' | 'claimed' | 'sent' | 'failed' | 'uncertain' | 'suppressed' | 'cancelled';
export interface CampaignSend { status: SendStatus; runId?: string; at?: number; error?: string }
export type CampaignState = 'draft' | 'awaiting_approval' | 'sending' | 'done' | 'cancelled' | 'rejected';
export interface CloudCampaign {
  id: string; title: string; subject: string; body: string; audience: string[]; createdAt: number; state: CampaignState;
  note?: string; approvalId?: string; snapshot?: CampaignSnapshot; sends?: CampaignSend[];
}
export interface CloudOutreach {
  schemaVersion: 1;
  /** Per-Empire salt for opt-out hashes (set with the first settings). */
  salt: string;
  settings?: OutreachSettings;
  nextLead: number;
  nextCampaign: number;
  leads: CloudLead[];
  suppression: CloudSuppression[];
  campaigns: CloudCampaign[];
  /** Messages claimed per UTC day (sent, failed, uncertain or waiting), for the daily cap. */
  sent: Record<string, number>;
}

export const emptyOutreach = (): CloudOutreach => ({ schemaVersion: 1, salt: '', nextLead: 1, nextCampaign: 1, leads: [], suppression: [], campaigns: [], sent: {} });
export const isEmptyOutreach = (o: CloudOutreach) => JSON.stringify(o) === JSON.stringify(emptyOutreach());

export class OutreachRuleError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'OutreachRuleError'; }
}
const refuse = (code: string, message: string): never => { throw new OutreachRuleError(code, message); };
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** An opt-out as stored: SHA-256 of the per-Empire salt and the normalized address. The game computes it too. */
export const suppressionHash = (salt: string, email: string) => sha256Hex(`${salt}:${normalizeEmail(email) ?? email.trim().toLowerCase()}`);
export const isSuppressed = (o: CloudOutreach, email: string) => { const h = suppressionHash(o.salt, email); return o.suppression.some((s) => s.hash === h); };

// ---------------------------------------------------------------- intent checks

const ONE_LINE_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
export function checkOutreachSettings(raw: Record<string, unknown>): Omit<OutreachSettings, 'acknowledgedAt'> {
  const extra = Object.keys(raw).find((k) => !['from', 'fromName', 'address', 'dailyCap', 'perRunCap'].includes(k));
  if (extra) refuse('invalid_intent', `Unexpected intent field "${extra.slice(0, 40)}".`);
  if (typeof raw.from !== 'string' || ONE_LINE_UNSAFE.test(raw.from) || !isEmailAddress(raw.from.trim())) refuse('invalid_settings', 'The sender must be one plain email address.');
  let fromName: string | undefined;
  if (raw.fromName !== undefined) {
    if (typeof raw.fromName !== 'string' || ONE_LINE_UNSAFE.test(raw.fromName) || raw.fromName.trim().length > 80 || /[<>"]/.test(raw.fromName)) refuse('invalid_settings', 'The sender name is one line of at most 80 characters, without < > or ".');
    fromName = (raw.fromName as string).trim() || undefined;
  }
  if (typeof raw.address !== 'string' || !raw.address.trim() || ONE_LINE_UNSAFE.test(raw.address) || raw.address.length > 300) refuse('invalid_settings', 'Your sender identity and postal address is required: one line of at most 300 characters (it is printed in every email).');
  const n = (v: unknown, max: number, what: string) => { if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > max) refuse('invalid_settings', `${what} must be a whole number from 1 to ${max}.`); return v as number; };
  const dailyCap = n(raw.dailyCap, OUTREACH_LIMITS.maxDailyCap, 'The daily cap');
  const perRunCap = n(raw.perRunCap, OUTREACH_LIMITS.maxPerRunCap, 'The cap per run');
  if (perRunCap > dailyCap) refuse('invalid_settings', 'The cap per run cannot exceed the daily cap.');
  return { from: (raw.from as string).trim().toLowerCase(), ...(fromName ? { fromName } : {}), address: (raw.address as string).trim(), dailyCap, perRunCap };
}

export function checkLeads(raw: unknown): Omit<CloudLead, 'id' | 'addedAt'>[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > OUTREACH_LIMITS.leadsPerIntent) refuse('invalid_intent', `Send 1–${OUTREACH_LIMITS.leadsPerIntent} leads at a time.`);
  return (raw as unknown[]).map((l, i) => {
    if (!l || typeof l !== 'object' || Array.isArray(l)) refuse('invalid_intent', `lead ${i + 1} must be an object`);
    const x = l as Record<string, unknown>;
    const extra = Object.keys(x).find((k) => !['email', 'name', 'company', 'tags'].includes(k));
    if (extra) refuse('invalid_intent', `Unexpected intent field "${extra.slice(0, 40)}".`);
    const email = normalizeEmail(x.email);
    if (!email) refuse('invalid_intent', `lead ${i + 1}: not a plain email address`);
    const textOf = (v: unknown, what: string) => { if (v === undefined) return ''; if (typeof v !== 'string' || v.length > 100) refuse('invalid_intent', `lead ${i + 1}: ${what} is at most 100 characters`); return mergeValue(v as string); };
    const tags = x.tags === undefined ? [] : x.tags;
    if (!Array.isArray(tags) || tags.length > 10 || tags.some((t) => typeof t !== 'string' || !TAG.test(t) || t.toLowerCase() === 'all')) refuse('invalid_intent', `lead ${i + 1}: tags are up to 10 words of letters, digits and . _ -`);
    return { email: email!, name: textOf(x.name, 'the name'), company: textOf(x.company, 'the company'), tags: [...new Set((tags as string[]).map((t) => t.toLowerCase()))] };
  });
}

export function checkCampaign(raw: unknown): Pick<CloudCampaign, 'title' | 'subject' | 'body' | 'audience'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('invalid_intent', 'A campaign is an object.');
  const c = raw as Record<string, unknown>;
  const extra = Object.keys(c).find((k) => !['title', 'subject', 'body', 'audience'].includes(k));
  if (extra) refuse('invalid_intent', `Unexpected intent field "${extra.slice(0, 40)}".`);
  if (typeof c.title !== 'string' || !c.title.trim() || c.title.length > 120 || ONE_LINE_UNSAFE.test(c.title)) refuse('invalid_intent', 'The campaign title is 1–120 printable characters.');
  const text = checkCampaignText(c.subject, c.body);
  if ('error' in text) refuse('invalid_campaign', `Campaign refused: ${text.error}.`);
  const audience = c.audience;
  if (!Array.isArray(audience) || !audience.length || audience.length > 20 || audience.some((a) => typeof a !== 'string' || !TAG.test(a))) refuse('invalid_intent', 'The audience is 1–20 lead tags, or ["all"].');
  const ok = (text as { ok: { subject: string; body: string } }).ok;
  return { title: (c.title as string).trim(), subject: ok.subject, body: ok.body, audience: [...new Set((audience as string[]).map((a) => a.toLowerCase()))] };
}

// ---------------------------------------------------------------- rules (coordinator)

export interface OutreachCtx { now: number; intentId: string }
const needSetup = (o: CloudOutreach) => { if (!o.settings) refuse('outreach_not_set_up', 'Set up outreach first: the sender, postal address and caps, and acknowledge the privacy warning.'); };

export function applyOutreachSettings(o: CloudOutreach, s: Omit<OutreachSettings, 'acknowledgedAt'>, ctx: OutreachCtx) {
  if (!o.salt) o.salt = sha256Hex(`agent-empire-suppression:${ctx.intentId}`).slice(0, 32);
  o.settings = { ...s, acknowledgedAt: o.settings?.acknowledgedAt ?? ctx.now };
}

export function addLeads(o: CloudOutreach, leads: Omit<CloudLead, 'id' | 'addedAt'>[], ctx: OutreachCtx): { added: number; skipped: number } {
  needSetup(o);
  let added = 0; let skipped = 0;
  for (const l of leads) {
    if (o.leads.some((x) => x.email === l.email) || isSuppressed(o, l.email)) { skipped++; continue; }
    if (o.leads.length >= OUTREACH_LIMITS.leads) refuse('leads_full', `At most ${OUTREACH_LIMITS.leads} leads are kept.`);
    o.leads.push({ id: `P${o.nextLead++}`, ...l, addedAt: ctx.now });
    added++;
  }
  return { added, skipped };
}

/** Re-review C: a campaign-send item that is resolved keeps no recipient or rendered sample. */
export function resolveSendItem(item: CloudOrg['approvals'][number], now: number, note: string) {
  Object.assign(item, { status: 'resolved', decidedAt: now, note });
  if (item.outreach) { item.outreach.recipients = []; item.outreach.samples = []; }
}

/** Removes stored addresses from campaign-send inbox items (`all`, or a set of addresses); a pending one is resolved. */
export function scrubOrgAddresses(org: CloudOrg, emails: Set<string> | 'all', now: number, note: string) {
  for (const a of org.approvals) {
    if (a.kind !== 'external_action' || !a.outreach) continue;
    const hit = emails === 'all' ? a.outreach.recipients.length > 0 : a.outreach.recipients.some((r) => emails.has(r));
    if (!hit) continue;
    a.outreach.recipients = emails === 'all' ? [] : a.outreach.recipients.filter((r) => !emails.has(r));
    a.outreach.samples = emails === 'all' ? [] : a.outreach.samples.filter((s) => !emails.has(s.to));
    if (a.status === 'pending') resolveSendItem(a, now, note);
  }
}

const finishCampaign = (c: CloudCampaign) => { if (c.snapshot) c.snapshot.recipients = c.snapshot.recipients.map(() => null); };

/**
 * Review 3: a finished, declined or cancelled campaign's inbox item keeps no recipient or rendered sample (the item, its
 * snapshot hash and the counts stay). Run every tick after the outreach steps.
 */
export function scrubFinished(o: CloudOutreach, org: CloudOrg) {
  for (const c of o.campaigns) {
    if (!['done', 'rejected', 'cancelled'].includes(c.state) || !c.approvalId) continue;
    const item = org.approvals.find((a) => a.id === c.approvalId);
    if (item?.outreach && (item.outreach.recipients.length || item.outreach.samples.length)) { item.outreach.recipients = []; item.outreach.samples = []; }
  }
}

export function suppress(o: CloudOutreach, org: CloudOrg, hash: string, reason: SuppressionReason, ctx: OutreachCtx): 'applied' | 'duplicate' {
  if (!o.salt) refuse('outreach_not_set_up', 'Set up outreach first.');
  if (o.suppression.some((s) => s.hash === hash)) return 'duplicate';
  if (o.suppression.length >= OUTREACH_LIMITS.suppression) refuse('suppression_full', 'The suppression list is full.');
  o.suppression.push({ hash, reason, at: ctx.now });
  const removed = new Set<string>();
  o.leads = o.leads.filter((l) => { const hit = suppressionHash(o.salt, l.email) === hash; if (hit) removed.add(l.email); return !hit; });
  for (const c of o.campaigns) {
    c.snapshot?.recipients.forEach((r, i) => {
      if (!r || suppressionHash(o.salt, r.email) !== hash) return;
      removed.add(r.email);
      c.snapshot!.recipients[i] = null;
      const send = c.sends?.[i];
      if (send && send.status === 'pending') c.sends![i] = { status: 'suppressed', at: ctx.now };
    });
  }
  if (removed.size) scrubOrgAddresses(org, removed, ctx.now, 'A recipient opted out; what would be sent changed.');
  return 'applied';
}

export function addCampaign(o: CloudOutreach, c: Pick<CloudCampaign, 'title' | 'subject' | 'body' | 'audience'>, ctx: OutreachCtx): CloudCampaign {
  needSetup(o);
  if (o.campaigns.length >= OUTREACH_LIMITS.campaigns) {
    const old = o.campaigns.filter((x) => ['done', 'cancelled', 'rejected'].includes(x.state)).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!old) refuse('campaigns_full', `${OUTREACH_LIMITS.campaigns} campaigns are open. Finish or cancel some first.`);
    o.campaigns = o.campaigns.filter((x) => x !== old);
  }
  const campaign: CloudCampaign = { id: `C${o.nextCampaign++}`, ...c, createdAt: ctx.now, state: 'draft' };
  o.campaigns.push(campaign);
  return campaign;
}

export function cancelCampaign(o: CloudOutreach, org: CloudOrg, id: string, ctx: OutreachCtx): 'applied' | 'duplicate' {
  const c = o.campaigns.find((x) => x.id === id) ?? refuse('campaign_not_found', `There is no campaign ${id}.`);
  if (['done', 'cancelled', 'rejected'].includes(c.state)) return 'duplicate';
  const item = c.approvalId ? org.approvals.find((a) => a.id === c.approvalId) : undefined;
  if (item?.status === 'pending') resolveSendItem(item, ctx.now, 'The campaign was cancelled.');
  c.sends?.forEach((s, i) => { if (s.status === 'pending') c.sends![i] = { status: 'cancelled', at: ctx.now }; });
  c.state = c.sends?.some((s) => s.status === 'claimed') ? c.state : 'cancelled';
  if (c.state === 'cancelled') finishCampaign(c);
  c.note = 'Cancelled by the CEO. Nothing more is sent.';
  return 'applied';
}

export function deleteLeadData(o: CloudOutreach, org: CloudOrg, ctx: OutreachCtx) {
  o.leads = [];
  for (const c of o.campaigns) {
    if (c.state === 'awaiting_approval') { delete c.approvalId; delete c.snapshot; c.state = 'draft'; }
    c.sends?.forEach((s, i) => { if (s.status === 'pending') c.sends![i] = { status: 'cancelled', at: ctx.now }; });
    finishCampaign(c);
    if (c.state === 'sending' && !c.sends?.some((s) => s.status === 'claimed')) c.state = 'done';
    if (c.state !== 'draft') c.note = 'Lead data was deleted; unsent messages were cancelled.';
  }
  scrubOrgAddresses(org, 'all', ctx.now, 'Lead data was deleted.');
}

/** A campaign-send decision applies only to the snapshot it was raised for. */
export function checkCampaignDecision(o: CloudOutreach, item: { id: string; outreach?: OutreachApproval }) {
  const c = o.campaigns.find((x) => x.id === item.outreach?.campaignId);
  if (!c || c.state !== 'awaiting_approval' || c.approvalId !== item.id || !c.snapshot || c.snapshot.hash !== item.outreach?.snapshotHash) refuse('campaign_mismatch', `${item.id} no longer matches its campaign, so nothing was decided.`);
}
export function applyCampaignDecision(o: CloudOutreach, item: { outreach?: OutreachApproval }, approved: boolean) {
  const c = o.campaigns.find((x) => x.id === item.outreach?.campaignId)!;
  if (approved) { c.state = 'sending'; c.sends = c.snapshot!.recipients.map(() => ({ status: 'pending' as const })); c.note = 'Approved. Your coordinator sends it in batches on its next runs.'; }
  else { c.state = 'rejected'; finishCampaign(c); c.note = 'Declined by the CEO. Nothing was sent.'; }
}

/** Freezes each draft into a snapshot and raises (or re-raises) its campaign-send item. */
export function reconcileCampaigns(o: CloudOutreach, org: CloudOrg, now: number, intervalMinutes: number) {
  const s = o.settings;
  for (const c of o.campaigns) {
    if (c.state !== 'draft' && c.state !== 'awaiting_approval') continue;
    const item = c.approvalId ? org.approvals.find((a) => a.id === c.approvalId) : undefined;
    if (item?.status === 'rejected') { c.state = 'rejected'; finishCampaign(c); c.note = 'Declined by the CEO. Nothing was sent.'; continue; }
    const drop = (note: string) => {
      if (item?.status === 'pending') resolveSendItem(item, now, note);
      delete c.approvalId; delete c.snapshot; c.state = 'draft';
    };
    if (!s) { drop('Outreach is not set up.'); c.note = 'Set up the sender first.'; continue; }
    const all = c.audience.includes('all');
    const excluded = { suppressed: 0, invalid: 0, unconfirmed: 0 };
    const recipients: OutreachRecipient[] = [];
    for (const l of o.leads) {
      if (!all && !l.tags.some((t) => c.audience.includes(t))) continue;
      if (isSuppressed(o, l.email)) { excluded.suppressed++; continue; }
      if (!isEmailAddress(l.email)) { excluded.invalid++; continue; }
      recipients.push({ email: l.email, name: l.name, company: l.company });
    }
    const text = checkCampaignText(c.subject, c.body);
    if ('error' in text) { drop('The message is no longer valid.'); c.note = short(`Not sendable: ${text.error}.`, OUTREACH_LIMITS.note); continue; }
    if (!recipients.length) { drop('No recipients match any more.'); c.note = `No leads match the audience (${c.audience.join(', ')}).`; continue; }
    if (recipients.length > OUTREACH_LIMITS.recipients) { drop('Too many recipients.'); c.note = `${recipients.length} recipients is more than the ${OUTREACH_LIMITS.recipients} one cloud campaign may send; narrow the audience.`; continue; }
    const body = { subject: c.subject, body: c.body, footer: outreachFooter(s), from: s.from, ...(s.fromName ? { fromName: s.fromName } : {}), dailyCap: s.dailyCap, perRunCap: s.perRunCap, recipients, excluded };
    const hash = sha256Hex(JSON.stringify(body));
    if (item?.status === 'pending' && c.snapshot?.hash === hash) continue;
    if (item?.status === 'pending') resolveSendItem(item, now, 'What would be sent changed (recipients, suppression or sender settings); a new item replaces this one.');
    const samples = recipients.slice(0, 2).map((r) => { const m = renderOutreach(body, r); return { to: m.to, subject: m.subject, text: m.text }; });
    const est = deliveryEstimate(recipients.length, s, intervalMinutes);
    const raised = raiseApproval(org, {
      kind: 'external_action', jobId: '', createdAt: now,
      title: short(`Send “${c.title}” to ${plural(recipients.length, 'recipient')}`, 200),
      detail: short(`Email campaign ${c.id} · from ${s.from} · at most ${s.perRunCap} per coordinator run and ${s.dailyCap} a day · ${excluded.suppressed} suppressed, ${excluded.invalid} invalid excluded. ${est.text}`, 600),
      outreach: { campaignId: c.id, snapshotHash: hash, channel: 'email', from: s.from, dailyCap: s.dailyCap, intervalSec: intervalMinutes * 60, perRun: s.perRunCap, samples, recipients: recipients.map((r) => r.email), excluded, draftedBy: 'the CEO (written in the game)' },
    });
    c.snapshot = { hash, ...body };
    c.approvalId = raised.id;
    c.state = 'awaiting_approval';
    c.note = `Waiting for your approval (${raised.id}).`;
  }
}

export interface Receipt { schemaVersion: 1; runId: string; at: number; unavailable?: string; results: { campaignId: string; index: number; status: 'sent' | 'failed' | 'uncertain' | 'refused'; error?: string }[] }
export const RECEIPT_RE = /^outbox\/receipts\/([A-Za-z0-9._-]{1,80})\.json$/;

export function parseReceipt(text: string): Receipt | undefined {
  try {
    const r = JSON.parse(text);
    if (r?.schemaVersion !== 1 || typeof r.runId !== 'string' || !Array.isArray(r.results) || r.results.length > 1000) return undefined;
    if (r.unavailable !== undefined && typeof r.unavailable !== 'string') return undefined;
    for (const x of r.results) if (typeof x?.campaignId !== 'string' || !Number.isSafeInteger(x.index) || !['sent', 'failed', 'uncertain', 'refused'].includes(x.status)) return undefined;
    return r as Receipt;
  } catch { return undefined; }
}

const settleDone = (c: CloudCampaign) => {
  if (c.state === 'sending' && c.sends && !c.sends.some((s) => s.status === 'pending' || s.status === 'claimed')) {
    c.state = 'done'; finishCampaign(c);
    const n = (st: SendStatus) => c.sends!.filter((s) => s.status === st).length;
    c.note = `Finished: ${n('sent')} sent, ${n('failed')} failed, ${n('uncertain')} uncertain (never re-sent), ${n('suppressed')} suppressed, ${n('cancelled')} cancelled.`;
  }
};

/**
 * Applies the send jobs' receipts, then marks every claim of an earlier run that has no result as uncertain (its send job
 * stopped or never ran): it is never sent again. Returns the receipt paths to delete in the same commit.
 */
export function consumeReceipts(o: CloudOutreach, files: { path: string; content: string }[], now: number, org?: CloudOrg): string[] {
  const consumed: string[] = [];
  for (const f of files) {
    consumed.push(f.path);
    const r = parseReceipt(f.content);
    if (!r) continue;
    if (r.unavailable !== undefined) {
      // The send job proved it attempted nothing: its claims go back to pending, and the day's count is given back.
      for (const c of o.campaigns) c.sends?.forEach((s, i) => {
        if (s.status === 'claimed' && s.runId === r.runId) { const day = utcDay(s.at ?? now); o.sent[day] = Math.max(0, (o.sent[day] ?? 0) - 1); c.sends![i] = { status: 'pending' }; c.note = short(`Waiting: ${r.unavailable}`, OUTREACH_LIMITS.note); }
      });
      continue;
    }
    for (const x of r.results) {
      const c = o.campaigns.find((k) => k.id === x.campaignId);
      const s = c?.sends?.[x.index];
      if (!c || !s || s.status !== 'claimed' || s.runId !== r.runId) continue;
      if (c.note?.startsWith('Waiting:')) c.note = 'Sending: the last run’s send job reported its results.';
      c.sends![x.index] = { status: x.status === 'refused' ? 'failed' : x.status, runId: r.runId, at: r.at, ...(x.error ? { error: short(clean(x.error, 200), 200) } : {}) };
      if (c.snapshot) c.snapshot.recipients[x.index] = null;
    }
  }
  for (const c of o.campaigns) {
    const before = c.sends?.filter((s) => s.status === 'claimed').length ?? 0;
    c.sends?.forEach((s, i) => {
      if (s.status !== 'claimed') return;
      c.sends![i] = { status: 'uncertain', ...(s.runId ? { runId: s.runId } : {}), at: now, error: 'The send job for this run did not report; it may have been sent, so it is never re-sent.' };
      if (c.snapshot) c.snapshot.recipients[i] = null;
    });
    // Review: dropped claims (the run that claimed them stopped before its send job reported) are surfaced on the
    // campaign and on its inbox item, never lost silently.
    if (before) {
      const total = c.sends!.filter((s) => s.status === 'uncertain').length;
      const text = `${plural(total, 'message')} uncertain: a coordinator run claimed ${total === 1 ? 'it' : 'them'} but its send job did not report, so ${total === 1 ? 'it' : 'they'} may or may not have been sent and ${total === 1 ? 'is' : 'are'} never re-sent.`;
      c.note = short(text, OUTREACH_LIMITS.note);
      const item = org && c.approvalId ? org.approvals.find((a) => a.id === c.approvalId) : undefined;
      if (item) item.note = short(text, 300);
    }
    settleDone(c);
  }
  return consumed;
}

/** Claims this run's batch: at most perRunCap, and within the daily cap; suppression is checked again here. */
export function claimSends(o: CloudOutreach, org: CloudOrg, ctx: { now: number; runId: string }, clock: { at: number } | { reason: string }, running: boolean): number {
  const s = o.settings;
  if (!s || !running || 'reason' in clock) return 0;
  const day = utcDay(clock.at);
  let used = o.sent[day] ?? 0;
  let runLeft = Math.min(s.perRunCap, s.dailyCap - used);
  let claimed = 0;
  const removed = new Set<string>();
  for (const c of [...o.campaigns].sort((a, b) => a.createdAt - b.createdAt)) {
    if (c.state !== 'sending' || !c.sends || !c.snapshot) continue;
    // Review 5: an approved campaign keeps the pace it was approved with: the smaller of its snapshot caps and today's.
    let budget = Math.max(0, Math.min(runLeft, c.snapshot.perRunCap, c.snapshot.dailyCap - used));
    const start = budget;
    c.sends.forEach((send, i) => {
      if (send.status !== 'pending') return;
      const r = c.snapshot!.recipients[i];
      if (!r) { c.sends![i] = { status: 'cancelled', at: ctx.now }; return; }
      if (isSuppressed(o, r.email)) { removed.add(r.email); c.snapshot!.recipients[i] = null; c.sends![i] = { status: 'suppressed', at: ctx.now }; return; }
      if (budget <= 0) return;
      c.sends![i] = { status: 'claimed', runId: ctx.runId, at: clock.at };
      budget--; used++; claimed++;
    });
    runLeft -= start - budget;
    const left = c.sends.filter((x) => x.status === 'pending').length;
    if (left && budget <= 0 && !c.note?.startsWith('Waiting:')) c.note = short(`${plural(left, 'message')} still to send. ${deliveryEstimate(left, s, 0).text}`, OUTREACH_LIMITS.note);
    settleDone(c);
  }
  if (removed.size) scrubOrgAddresses(org, removed, ctx.now, 'A recipient opted out.');
  o.sent[day] = used;
  for (const d of Object.keys(o.sent).sort().slice(0, Math.max(0, Object.keys(o.sent).length - OUTREACH_LIMITS.sentDays))) delete o.sent[d];
  return claimed;
}

/**
 * FREE-12 review 1: the extra GitHub Actions minutes outreach can bill. The send job runs only on runs that send email, so
 * the scheduled estimate is unchanged when nothing is sent; each sending run bills at least one more minute.
 */
export function outreachMinutesNote(runsPerMonth: number, outreachOn: boolean): string {
  if (!outreachOn) return '';
  return `Outreach runs its send job only on runs that send email: each of those runs bills at least one more minute, up to about ${runsPerMonth.toLocaleString('en-US')} more a month if every run sends.`;
}

/** An honest delivery estimate: runs at the schedule, and the daily cap. Runs can start late on GitHub. */
export function deliveryEstimate(remaining: number, caps: { perRunCap: number; dailyCap: number }, intervalMinutes: number): { runs: number; days: number; text: string } {
  const perRun = Math.max(1, Math.min(caps.perRunCap, caps.dailyCap));
  const runs = Math.ceil(remaining / perRun);
  const days = Math.ceil(remaining / caps.dailyCap);
  const every = intervalMinutes > 0 ? ` (every ${intervalMinutes} minutes)` : '';
  if (runs <= 1) return { runs, days, text: `${plural(remaining, 'message')} go out on the next coordinator run${intervalMinutes > 0 ? ` (within about ${intervalMinutes} minutes)` : ''}, at most ${caps.perRunCap} per coordinator run.` };
  const span = days > 1 ? `about ${days} days` : `about ${Math.max(1, Math.ceil((runs * Math.max(intervalMinutes, 15)) / 60))} hours`;
  return { runs, days, text: `${plural(remaining, 'message')}: at most ${caps.perRunCap} per coordinator run${every} and ${caps.dailyCap} a day, so about ${runs} runs over ${span}. Scheduled runs can start late; a send that is not confirmed is never re-sent.` };
}

// ---------------------------------------------------------------- validation (structural; text is rechecked before sending)

export class OutreachSchemaError extends Error {
  constructor(message: string) { super(`${OUTREACH_FILE}: ${message}`); this.name = 'OutreachSchemaError'; }
}
type Rec = Record<string, unknown>;
function obj(value: unknown, keys: readonly string[], what: string): Rec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OutreachSchemaError(`${what} must be an object`);
  const extra = Object.keys(value).find((k) => !keys.includes(k));
  if (extra) throw new OutreachSchemaError(`unexpected ${what} field ${extra.slice(0, 40)}`);
  return value as Rec;
}
const str = (v: unknown, max: number, what: string) => { if (typeof v !== 'string' || v.length > max) throw new OutreachSchemaError(`invalid ${what}`); return v; };
const num = (v: unknown, what: string) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new OutreachSchemaError(`invalid ${what}`); return v; };
const recipient = (v: unknown) => { if (v === null) return; const r = obj(v, ['email', 'name', 'company'], 'recipient'); str(r.email, 254, 'recipient'); str(r.name, 100, 'recipient'); str(r.company, 100, 'recipient'); };

export function validateOutreach(value: unknown): CloudOutreach {
  const o = obj(value, ['schemaVersion', 'salt', 'settings', 'nextLead', 'nextCampaign', 'leads', 'suppression', 'campaigns', 'sent'], 'outreach');
  if (o.schemaVersion !== 1) throw new OutreachSchemaError('unsupported schemaVersion');
  if (typeof o.salt !== 'string' || !/^([a-f0-9]{32})?$/.test(o.salt)) throw new OutreachSchemaError('invalid salt');
  for (const k of ['nextLead', 'nextCampaign']) if (!Number.isSafeInteger(o[k]) || (o[k] as number) < 1) throw new OutreachSchemaError(`invalid ${k}`);
  if (o.settings !== undefined) {
    const s = obj(o.settings, ['from', 'fromName', 'address', 'dailyCap', 'perRunCap', 'acknowledgedAt'], 'settings');
    str(s.from, 254, 'sender'); if (s.fromName !== undefined) str(s.fromName, 80, 'sender name'); str(s.address, 300, 'address'); num(s.acknowledgedAt, 'acknowledgement');
    if (!Number.isSafeInteger(s.dailyCap) || !Number.isSafeInteger(s.perRunCap) || (s.perRunCap as number) < 1 || (s.perRunCap as number) > (s.dailyCap as number) || (s.dailyCap as number) > OUTREACH_LIMITS.maxDailyCap) throw new OutreachSchemaError('invalid caps');
  }
  if (!Array.isArray(o.leads) || o.leads.length > OUTREACH_LIMITS.leads) throw new OutreachSchemaError('invalid leads');
  for (const l of o.leads) { const x = obj(l, ['id', 'email', 'name', 'company', 'tags', 'addedAt'], 'lead'); str(x.id, 12, 'lead id'); str(x.email, 254, 'lead email'); str(x.name, 100, 'lead'); str(x.company, 100, 'lead'); num(x.addedAt, 'lead'); if (!Array.isArray(x.tags) || x.tags.length > 10 || x.tags.some((t) => typeof t !== 'string' || !TAG.test(t))) throw new OutreachSchemaError('invalid lead tags'); }
  if (!Array.isArray(o.suppression) || o.suppression.length > OUTREACH_LIMITS.suppression) throw new OutreachSchemaError('invalid suppression');
  for (const sp of o.suppression) { const x = obj(sp, ['hash', 'reason', 'at'], 'suppression'); if (!HASH.test(String(x.hash)) || !SUPPRESSION_REASONS.includes(x.reason as SuppressionReason)) throw new OutreachSchemaError('invalid suppression entry'); num(x.at, 'suppression'); }
  if (!Array.isArray(o.campaigns) || o.campaigns.length > OUTREACH_LIMITS.campaigns) throw new OutreachSchemaError('invalid campaigns');
  for (const cv of o.campaigns) {
    const c = obj(cv, ['id', 'title', 'subject', 'body', 'audience', 'createdAt', 'state', 'note', 'approvalId', 'snapshot', 'sends'], 'campaign');
    str(c.id, 12, 'campaign id'); str(c.title, 120, 'campaign title'); str(c.subject, 150, 'campaign subject'); str(c.body, 20_000, 'campaign body'); num(c.createdAt, 'campaign');
    if (!['draft', 'awaiting_approval', 'sending', 'done', 'cancelled', 'rejected'].includes(String(c.state))) throw new OutreachSchemaError('invalid campaign state');
    if (!Array.isArray(c.audience) || c.audience.some((a) => typeof a !== 'string' || !TAG.test(a))) throw new OutreachSchemaError('invalid audience');
    if (c.note !== undefined) str(c.note, OUTREACH_LIMITS.note, 'campaign note');
    if (c.approvalId !== undefined) str(c.approvalId, 12, 'campaign approval');
    if (c.snapshot !== undefined) {
      const s = obj(c.snapshot, ['hash', 'subject', 'body', 'footer', 'from', 'fromName', 'dailyCap', 'perRunCap', 'recipients', 'excluded'], 'snapshot');
      if (!HASH.test(String(s.hash))) throw new OutreachSchemaError('invalid snapshot hash');
      str(s.subject, 1000, 'snapshot'); str(s.body, 20_000, 'snapshot'); str(s.footer, 1000, 'snapshot'); str(s.from, 1000, 'snapshot'); if (s.fromName !== undefined) str(s.fromName, 1000, 'snapshot');
      num(s.dailyCap, 'snapshot'); num(s.perRunCap, 'snapshot');
      if (!Array.isArray(s.recipients) || s.recipients.length > OUTREACH_LIMITS.recipients) throw new OutreachSchemaError('invalid snapshot recipients');
      s.recipients.forEach(recipient);
      const e = obj(s.excluded, ['suppressed', 'invalid', 'unconfirmed'], 'excluded'); for (const k of Object.keys(e)) num(e[k], 'excluded');
    }
    if (c.sends !== undefined) {
      if (!Array.isArray(c.sends) || c.sends.length > OUTREACH_LIMITS.recipients) throw new OutreachSchemaError('invalid sends');
      for (const sv of c.sends) { const x = obj(sv, ['status', 'runId', 'at', 'error'], 'send'); if (!['pending', 'claimed', 'sent', 'failed', 'uncertain', 'suppressed', 'cancelled'].includes(String(x.status))) throw new OutreachSchemaError('invalid send'); if (x.runId !== undefined) str(x.runId, 80, 'send run'); if (x.at !== undefined) num(x.at, 'send'); if (x.error !== undefined) str(x.error, 200, 'send error'); }
    }
  }
  const sent = obj(o.sent, Object.keys(o.sent ?? {}), 'sent');
  for (const [d, n] of Object.entries(sent)) { if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isSafeInteger(n) || (n as number) < 0) throw new OutreachSchemaError('invalid sent count'); }
  return JSON.parse(JSON.stringify(o)) as CloudOutreach;
}
