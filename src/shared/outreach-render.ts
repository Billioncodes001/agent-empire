// FREE-12: what one recipient of a campaign receives, shared by the office server (src/server/outreach.ts re-exports these
// unchanged) and the cloud coordinator and send job (src/cloud/outreach.ts). Pure and browser-safe: one message, one To
// address, merge values without control characters, and the fixed footer (postal address, sender, STOP line) always last.
import { STOP_LINE } from './outreach.js';

export interface MailMessage { from: string; to: string; subject: string; text: string; fromName?: string }
export interface OutreachRecipient { email: string; name: string; company: string }
export interface OutreachSender { address?: string; from?: string; fromName?: string }

export const MERGE = /\{\{\s*([^{}]*?)\s*\}\}/g;
export const MAX_SUBJECT = 150;
export const MAX_BODY = 20_000;
/** Each body line at most this many UTF-8 bytes (SMTP allows 998; leave room for merge values). */
export const MAX_LINE_BYTES = 900;

export function clean(value: string, max: number): string {
  return String(value).replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** One merge-field value: no control characters (so no CR/LF), collapsed spaces, at most 100 characters. */
export function mergeValue(value: string): string {
  return clean(value, 100);
}

/** The fixed footer appended to every email. A draft cannot change it. */
export function outreachFooter(cfg: OutreachSender): string {
  return `--\n${cfg.address}\nSent by ${cfg.fromName ? `${cfg.fromName} <${cfg.from}>` : cfg.from}.\n${STOP_LINE}`;
}

const fill = (template: string, r: OutreachRecipient, header = false) => template.replace(MERGE, (_m, field: string) => {
  const value = mergeValue(field === 'name' ? r.name : r.company);
  // In the Subject, a literal "=?…?=" would be decoded by mail clients; break it so the preview equals what is shown.
  return header ? value.replace(/=\?/g, '= ?').replace(/\?=/g, '? =') : value;
});

/** Exactly what one recipient receives: one message, one To address, the fixed footer always last. */
export function renderOutreach(s: { subject: string; body: string; footer: string; from: string; fromName?: string }, r: OutreachRecipient): MailMessage {
  return {
    from: s.from,
    ...(s.fromName ? { fromName: s.fromName } : {}),
    to: r.email,
    subject: clean(fill(s.subject, r, true), 200),
    text: `${fill(s.body, r)}\n\n${s.footer}\n`,
  };
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
/** Any character a mail header must never carry: C0/C1 controls (CR, LF, NEL), DEL and the Unicode line separators. */
const HEADER_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** Hidden format characters (zero-width, bidi overrides), private-use and unassigned code points. */
const HIDDEN = /[\p{Cf}\p{Co}\p{Cn}\u{E0000}-\u{E007F}]/u;

/**
 * FREE-12: a subject and plain-text body the CEO wrote, checked before it is stored, again when it is frozen for
 * approval, and again right before each send. Refuses header injection (CR/LF and other controls in the subject), encoded
 * words, HTML, merge fields other than {{name}} and {{company}}, hidden characters, and oversized bodies or lines.
 */
export function checkCampaignText(subject: unknown, body: unknown): { ok: { subject: string; body: string } } | { error: string } {
  if (typeof subject !== 'string' || !subject.trim()) return { error: 'the subject is required (one line)' };
  if (HEADER_UNSAFE.test(subject)) return { error: 'the subject must be one line without control characters' };
  if (subject.length > MAX_SUBJECT) return { error: `the subject is longer than ${MAX_SUBJECT} characters` };
  if (subject.includes('=?')) return { error: 'the subject contains "=?", which mail clients read as an encoded word; rephrase it' };
  if (typeof body !== 'string' || !body.trim()) return { error: 'the body is empty' };
  if (body.length > MAX_BODY) return { error: `the body is longer than ${MAX_BODY} characters` };
  if (/<\/?[a-z][^>]*>/i.test(body)) return { error: 'the body must be plain text, without HTML' };
  for (const [label, text] of [['subject', subject], ['body', body]] as const) {
    if (HIDDEN.test(text)) return { error: `the ${label} contains invisible or format characters` };
    for (const m of text.matchAll(MERGE)) if (m[1] !== 'name' && m[1] !== 'company') return { error: `the ${label} uses {{${m[1].slice(0, 30)}}}; only the merge fields {{name}} and {{company}} are allowed` };
    if (/\{\{|\}\}/.test(text.replace(MERGE, ''))) return { error: `the ${label} has an unmatched {{ or }}` };
  }
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(body)) return { error: 'the body contains control characters' };
  const longLine = body.split('\n').findIndex((line) => utf8Bytes(line) > MAX_LINE_BYTES);
  if (longLine >= 0) return { error: `body line ${longLine + 1} is longer than ${MAX_LINE_BYTES} bytes; break it into shorter lines` };
  return { ok: { subject: subject.trim(), body } };
}
