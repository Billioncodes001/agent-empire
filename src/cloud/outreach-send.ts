/**
 * FREE-12: the outreach send job. It runs as its own job of the coordinator workflow (`needs: tick`), on a fresh runner,
 * holding only `AGENT_EMPIRE_SMTP_URL` and the workflow's GITHUB_TOKEN. It runs no model and no agent code.
 *
 * It reads the committed state, sends only the messages the tick job claimed for THIS run id (a re-run attempt has a
 * different id, so it sends nothing), revalidates each one (message text, sender, recipient, suppression) right before
 * sending, and records a receipt under outbox/receipts/ that the next tick consumes. Without the SMTP secret it records
 * that it attempted nothing, so the claims are released instead of left uncertain.
 */
import { isEmailAddress } from '../shared/email-address.js';
import { checkCampaignText, renderOutreach, type MailMessage } from '../shared/outreach-render.js';
import { STOP_LINE } from '../shared/outreach.js';
import { isSuppressed, OUTREACH_FILE, validateOutreach, type Receipt } from './outreach.js';
import { receiptPath } from './schema.js';
import { updateWithRetry, type RetryOptions, type StateStore } from './store.js';

export interface SendTransport { send(message: MailMessage): Promise<void> }
export interface SendJobDeps {
  store: StateStore;
  transport: SendTransport;
  /** Whether AGENT_EMPIRE_SMTP_URL is present (the transport is never built without it). */
  smtpConfigured: boolean;
  runId: string;
  now: () => number;
  /** Pause between messages, so one run never bursts. */
  pauseMs?: number;
  retry?: RetryOptions;
  log?: (line: string) => void;
}
const HEADER_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export async function runSendJob(deps: SendJobDeps): Promise<{ sent: number; failed: number; refused: number; uncertain: number; skipped?: string }> {
  const log = deps.log ?? (() => {});
  const empty = { sent: 0, failed: 0, refused: 0, uncertain: 0 };
  const snapshot = await deps.store.read();
  const path = receiptPath(deps.runId);
  if (snapshot.files[path] !== undefined) { log(`send: a receipt for ${deps.runId} already exists; nothing sent`); return { ...empty, skipped: 'receipt_exists' }; }
  const text = snapshot.files[OUTREACH_FILE];
  if (text === undefined) return { ...empty, skipped: 'no_outreach' };
  let o;
  try { o = validateOutreach(JSON.parse(text)); } catch (error) { log(`send: ${OUTREACH_FILE} is unreadable (${(error as Error).message.slice(0, 120)}); nothing sent`); return { ...empty, skipped: 'unreadable' }; }
  const claims = o.campaigns.flatMap((c) => (c.state === 'sending' && c.sends ? c.sends.map((s, index) => ({ c, s, index })).filter((x) => x.s.status === 'claimed' && x.s.runId === deps.runId) : []));
  if (!claims.length) { log('send: nothing claimed for this run'); return { ...empty, skipped: 'no_claims' }; }
  const receipt: Receipt = { schemaVersion: 1, runId: deps.runId, at: deps.now(), results: [] };
  const counts = { ...empty };
  if (!deps.smtpConfigured) {
    receipt.unavailable = 'the send job has no AGENT_EMPIRE_SMTP_URL secret in the state repository, so nothing was sent. Add it, and the next run sends these.';
  } else {
    for (const [n, { c, index }] of claims.entries()) {
      const refuse = (error: string) => { receipt.results.push({ campaignId: c.id, index, status: 'refused', error }); counts.refused++; };
      const snap = c.snapshot;
      const r = snap?.recipients[index];
      if (!snap || !r) { refuse('the recipient’s address was removed'); continue; }
      const checked = checkCampaignText(snap.subject, snap.body);
      if ('error' in checked) { refuse(`not sent: ${checked.error}`); continue; }
      if (HEADER_UNSAFE.test(snap.from) || !isEmailAddress(snap.from) || (snap.fromName !== undefined && (HEADER_UNSAFE.test(snap.fromName) || /[<>"]/.test(snap.fromName)))) { refuse('not sent: the sender is not one plain address and name'); continue; }
      if (HEADER_UNSAFE.test(r.email) || !isEmailAddress(r.email)) { refuse('not sent: the recipient is not one plain address'); continue; }
      // Review 5: the footer is checked against the snapshot's own frozen sender, not today's settings, so fixing the
      // postal address mid-campaign never fails the messages already approved.
      const lines = snap.footer.split('\n');
      const sentBy = `Sent by ${snap.fromName ? `${snap.fromName} <${snap.from}>` : snap.from}.`;
      if (lines.length !== 4 || lines[0] !== '--' || !lines[1].trim() || lines[1].length > 300 || HEADER_UNSAFE.test(lines[1]) || lines[2] !== sentBy || lines[3] !== STOP_LINE) { refuse('not sent: the compliance footer (postal address, sender, STOP line) is not intact'); continue; }
      if (isSuppressed(o, r.email)) { refuse('not sent: the recipient opted out'); continue; }
      const message = renderOutreach(snap, r);
      if (HEADER_UNSAFE.test(message.subject) || message.text.length > 30_000) { refuse('not sent: the rendered message failed the final check'); continue; }
      // Review: SMTP allows 998 bytes per line; merge values can lengthen a line past it.
      if (message.text.split('\n').some((line) => new TextEncoder().encode(line).length > 998)) { refuse('not sent: a line is longer than 998 bytes after merging the name and company'); continue; }
      if (n > 0 && (deps.pauseMs ?? 1500) > 0) await new Promise((res) => setTimeout(res, deps.pauseMs ?? 1500));
      try { await deps.transport.send(message); receipt.results.push({ campaignId: c.id, index, status: 'sent' }); counts.sent++; }
      catch (error) {
        const uncertain = (error as { uncertain?: boolean }).uncertain === true;
        receipt.results.push({ campaignId: c.id, index, status: uncertain ? 'uncertain' : 'failed', error: String((error as Error).message ?? 'send failed').replace(/\b[\w.+-]+@[\w.-]+\b/g, '[address]').slice(0, 200) });
        if (uncertain) counts.uncertain++; else counts.failed++;
      }
    }
  }
  await updateWithRetry(deps.store, (snap) => ({ changes: snap.files[path] === undefined ? [{ path, content: JSON.stringify(receipt, null, 2) + '\n' }] : [], message: `Agent Empire send job ${deps.runId}: ${counts.sent} sent, ${counts.failed} failed, ${counts.refused} refused, ${counts.uncertain} uncertain`, value: null }), deps.retry);
  log(`send: ${counts.sent} sent, ${counts.failed} failed, ${counts.refused} refused, ${counts.uncertain} uncertain${receipt.unavailable ? ' (no SMTP secret; claims released)' : ''}`);
  return counts;
}
