// Optional email notifications for the CEO approval inbox (ORG-03). One plain-text email per new pending approval:
// a notification only, with no secrets and no link that acts. A minimal SMTP client (no dependency) sits behind a
// transport interface; failures are logged without credentials and retried with backoff, never blocking the server.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { APPROVAL_KIND_LABEL, type Approval } from '../shared/approvals.js';
import { approvalText } from './approvals.js';
import { writeJsonAtomic } from './persistence.js';

/** `fromName` (optional, sanitised and encoded) is the sender's display name; it defaults to "Agent Empire". */
export interface MailMessage { from: string; to: string; subject: string; text: string; fromName?: string }
export interface MailTransport { send(message: MailMessage): Promise<void> }
export interface SmtpConfig { secure: boolean; host: string; port: number; user?: string; pass?: string }
export interface EmailConfig { smtp: SmtpConfig; to: string; from: string }
export interface EmailStatus { state: 'not_configured' | 'configured' | 'failed'; label: string; lastSentAt?: number; lastFailedAt?: number; gaveUp?: number }

const ADDRESS = /^[^\s<>@"',;]{1,64}@[A-Za-z0-9.-]{1,253}$/;
const USAGE = 'Set AGENT_EMPIRE_SMTP_URL (smtp:// or smtps://user:pass@host:port) and AGENT_EMPIRE_NOTIFY_EMAIL (one address) together to enable email notifications.';

export const NOT_CONFIGURED: EmailStatus = { state: 'not_configured', label: 'Email: not configured' };

/** Reads the email settings. Errors name the variables but never echo their values, which hold a password. */
export function emailConfig(env: NodeJS.ProcessEnv): EmailConfig | undefined {
  const raw = env.AGENT_EMPIRE_SMTP_URL?.trim();
  const to = env.AGENT_EMPIRE_NOTIFY_EMAIL?.trim();
  if (!raw && !to) return undefined;
  if (!raw || !to) throw new Error(USAGE);
  if (!ADDRESS.test(to)) throw new Error('AGENT_EMPIRE_NOTIFY_EMAIL must be a single email address.');
  const smtp = smtpConfigFromUrl(raw, USAGE);
  const fromEnv = env.AGENT_EMPIRE_NOTIFY_FROM?.trim();
  if (fromEnv && !ADDRESS.test(fromEnv)) throw new Error('AGENT_EMPIRE_NOTIFY_FROM must be a single email address.');
  const from = fromEnv || (smtp.user && ADDRESS.test(smtp.user) ? smtp.user : to);
  return { smtp, to, from };
}

/** Whether a string is one plain email address (no display name, no list, no CR/LF). */
export const isEmailAddress = (s: string) => ADDRESS.test(s) && /\.[A-Za-z]{2,}$/.test(s);

/** Parses AGENT_EMPIRE_SMTP_URL (ORG-03; reused by ORG-04a outreach). Errors never echo the URL, which holds a password. */
export function smtpConfigFromUrl(raw: string, usage = USAGE): SmtpConfig {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`AGENT_EMPIRE_SMTP_URL is not a valid URL. ${usage}`); }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') throw new Error(`AGENT_EMPIRE_SMTP_URL must start with smtp:// or smtps://. ${usage}`);
  if (!url.hostname) throw new Error(`AGENT_EMPIRE_SMTP_URL has no host. ${usage}`);
  const secure = url.protocol === 'smtps:';
  const port = url.port ? Number(url.port) : secure ? 465 : 587;
  let user: string | undefined;
  let pass: string | undefined;
  try {
    user = url.username ? decodeURIComponent(url.username) : undefined;
    pass = url.password ? decodeURIComponent(url.password) : undefined;
  } catch { throw new Error(`AGENT_EMPIRE_SMTP_URL has badly encoded credentials. ${usage}`); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return { secure, host, port, ...(user ? { user } : {}), ...(pass ? { pass } : {}) };
}

export const isLoopbackHost = (host: string) => host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

// ---- Message ------------------------------------------------------------------------------------

/** The notification for one approval: plain text, title, kind, money and where to act. No links. */
export function approvalEmail(item: Approval, addresses: { to: string; from: string }): MailMessage {
  return {
    from: addresses.from,
    to: addresses.to,
    subject: `Agent Empire approval ${item.id}: ${APPROVAL_KIND_LABEL[item.kind]} · ${item.title}`.slice(0, 200),
    text: `${approvalText(item)}\n\nThis is a notification only. Nothing can be approved from this email.\n`,
  };
}

const headerSafe = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

/** A display name as one safe phrase: CR/LF and quoting characters removed, quoted when ASCII, else an encoded word. */
function displayName(name?: string): string {
  if (name === undefined) return 'Agent Empire';
  const clean = headerSafe(name).replace(/[\u0000-\u001f\u007f<>"\\]/g, '').trim().slice(0, 80) || 'Agent Empire';
  return /^[\x20-\x7e]*$/.test(clean) ? `"${clean}"` : encodeHeader(clean);
}

/** RFC 5322 text with CRLF line endings, dot-stuffed for DATA (a line starting with "." gets one more). */
export function renderMessage(m: MailMessage, now = new Date()): string {
  const domain = m.from.split('@')[1] ?? 'agent-empire.local';
  const headers = [
    `From: ${displayName(m.fromName)} <${m.from}>`,
    `To: <${m.to}>`,
    `Subject: ${encodeHeader(headerSafe(m.subject))}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  const body = m.text.replace(/\r?\n/g, '\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`.replace(/(^|\r\n)\./g, '$1..');
}

// ---- SMTP client --------------------------------------------------------------------------------

/**
 * `uncertain`: the message text was written after DATA but no final reply arrived, so the server may have accepted
 * it. Callers that must never send twice (ORG-04a outreach) treat that as "unknown", never as "not sent".
 */
export class SmtpError extends Error {
  uncertain?: true;
}

/** Line-oriented reader over the current socket; swapped to the TLS socket after STARTTLS. */
class Session {
  private buffer = '';
  private lines: string[] = [];
  private waiter?: { resolve: (r: { code: number; lines: string[] }) => void; reject: (e: Error) => void };
  private failure?: Error;
  private socket!: net.Socket;
  private readonly onData = (chunk: Buffer) => { this.buffer += chunk.toString('utf8'); this.pump(); };
  private readonly onError = (error: Error) => this.fail(new SmtpError(`SMTP connection failed (${(error as NodeJS.ErrnoException).code ?? 'error'})`));
  private readonly onClose = () => this.fail(new SmtpError('SMTP server closed the connection'));
  private readonly onTimeout = () => { this.fail(new SmtpError('SMTP timed out')); this.socket.destroy(); };

  constructor(socket: net.Socket, private readonly timeoutMs: number) { this.attach(socket); }

  /** Whether the server sent anything not yet read (after STARTTLS that is an injection attempt). */
  get hasUnread() { return this.lines.length > 0 || this.buffer.length > 0; }

  attach(socket: net.Socket) {
    // Nothing read in plaintext may be taken as a reply on the encrypted connection.
    this.lines = [];
    this.buffer = '';
    if (this.socket) for (const [event, fn] of [['data', this.onData], ['error', this.onError], ['close', this.onClose], ['timeout', this.onTimeout]] as const) this.socket.off(event, fn as never);
    this.socket = socket;
    socket.setTimeout(this.timeoutMs);
    socket.on('data', this.onData).on('error', this.onError).on('close', this.onClose).on('timeout', this.onTimeout);
  }

  get current() { return this.socket; }

  private fail(error: Error) {
    this.failure ??= error;
    const w = this.waiter;
    this.waiter = undefined;
    w?.reject(this.failure);
  }

  private pump() {
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      this.lines.push(this.buffer.slice(0, i).replace(/\r$/, ''));
      this.buffer = this.buffer.slice(i + 1);
    }
    if (!this.waiter) return;
    const end = this.lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
    if (end < 0) return;
    const lines = this.lines.splice(0, end + 1);
    const w = this.waiter;
    this.waiter = undefined;
    w.resolve({ code: Number(lines[end].slice(0, 3)), lines: lines.map((l) => l.slice(4)) });
  }

  read(): Promise<{ code: number; lines: string[] }> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; this.pump(); });
  }

  async command(line: string, expect: number[], label = line.split(' ')[0]): Promise<string[]> {
    if (this.failure) throw this.failure;
    this.socket.write(`${line}\r\n`);
    const reply = await this.read();
    // Only the verb and the status code are reported: never the line, which may carry credentials.
    if (!expect.includes(reply.code)) throw new SmtpError(`SMTP server answered ${reply.code} to ${label}`);
    return reply.lines;
  }
}

function waitConnected(socket: net.Socket, secure: boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new SmtpError('SMTP timed out while connecting')); }, timeoutMs);
    socket.once(secure ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(new SmtpError(`SMTP connection failed (${(error as NodeJS.ErrnoException).code ?? 'error'})`)); });
  });
}

export interface SmtpOptions {
  timeoutMs?: number;
  /** Tests route the plain connection to a local fake server. */
  connect?: (cfg: SmtpConfig) => net.Socket;
  tls?: tls.ConnectionOptions;
}

export function smtpTransport(cfg: SmtpConfig, opts: SmtpOptions = {}): MailTransport {
  return { send: (message) => smtpSend(cfg, message, opts) };
}

async function smtpSend(cfg: SmtpConfig, m: MailMessage, opts: SmtpOptions): Promise<void> {
  if (!ADDRESS.test(m.from) || !ADDRESS.test(m.to)) throw new SmtpError('Email addresses are invalid');
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const servername = net.isIP(cfg.host) ? undefined : cfg.host;
  let socket: net.Socket = cfg.secure ? tls.connect({ host: cfg.host, port: cfg.port, servername, ...opts.tls }) : opts.connect?.(cfg) ?? net.connect({ host: cfg.host, port: cfg.port });
  // A deadline for the whole conversation as well as for each silence.
  const deadline = setTimeout(() => socket.destroy(new SmtpError('SMTP timed out')), timeoutMs * 3);
  let dataWritten = false;
  try {
    const session = new Session(socket, timeoutMs);
    await waitConnected(socket, cfg.secure, timeoutMs);
    const greeting = await session.read();
    if (greeting.code !== 220) throw new SmtpError(`SMTP server answered ${greeting.code} on connect`);
    const name = 'agent-empire.local';
    let caps = await session.command(`EHLO ${name}`, [250], 'EHLO');
    let encrypted = cfg.secure;
    if (!encrypted && caps.some((c) => /^STARTTLS\b/i.test(c))) {
      await session.command('STARTTLS', [220]);
      if (session.hasUnread) throw new SmtpError('SMTP server sent data after STARTTLS before the TLS handshake; refusing to continue');
      const upgraded = tls.connect({ socket, servername, ...opts.tls });
      session.attach(upgraded);
      await waitConnected(upgraded, true, timeoutMs);
      socket = upgraded;
      encrypted = true;
      caps = await session.command(`EHLO ${name}`, [250], 'EHLO');
    }
    if (cfg.user) {
      if (!encrypted && !isLoopbackHost(cfg.host)) throw new SmtpError('The SMTP server does not offer STARTTLS; credentials are never sent unencrypted. Use smtps:// or a server with STARTTLS.');
      const mechs = caps.find((c) => /^AUTH\b/i.test(c))?.toUpperCase().split(/\s+/).slice(1) ?? [];
      const pass = cfg.pass ?? '';
      if (mechs.includes('PLAIN')) await session.command(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${pass}`, 'utf8').toString('base64')}`, [235], 'AUTH PLAIN');
      else if (mechs.includes('LOGIN')) {
        await session.command('AUTH LOGIN', [334]);
        await session.command(Buffer.from(cfg.user, 'utf8').toString('base64'), [334], 'AUTH LOGIN username');
        await session.command(Buffer.from(pass, 'utf8').toString('base64'), [235], 'AUTH LOGIN password');
      } else throw new SmtpError('The SMTP server offers neither AUTH PLAIN nor AUTH LOGIN');
    }
    await session.command(`MAIL FROM:<${m.from}>`, [250], 'MAIL FROM');
    await session.command(`RCPT TO:<${m.to}>`, [250, 251], 'RCPT TO');
    await session.command('DATA', [354]);
    dataWritten = true;
    await session.command(`${renderMessage(m)}\r\n.`, [250], 'end of DATA');
    dataWritten = false;
    await session.command('QUIT', [221]).catch(() => undefined);
  } catch (error) {
    const out = error instanceof SmtpError ? error : new SmtpError('SMTP send failed');
    // A definite reply to the end of DATA (4xx/5xx) means not accepted; anything else after the text went out is unknown.
    if (dataWritten && !/answered \d{3} to end of DATA/.test(out.message)) out.uncertain = true;
    throw out;
  } finally {
    clearTimeout(deadline);
    socket.destroy();
  }
}

// ---- Notifier -----------------------------------------------------------------------------------

const FILE = 'email-notify.json';
const MAX_SENT = 500;
const BACKOFF_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
/**
 * Only a 5xx to the message itself (MAIL FROM, RCPT TO, DATA) is permanent: that item is given up at once. Connection
 * errors, timeouts, 4xx and TLS problems retry with backoff up to the 30-minute cap, and an item is given up only once
 * it has been failing for a day. A sign-in (AUTH) failure pauses the whole queue and gives nothing up.
 */
const PERMANENT = /answered 5\d\d to (MAIL FROM|RCPT TO|DATA|end of DATA)/;
const SIGN_IN_FAILED = /answered 5\d\d to AUTH|neither AUTH PLAIN nor AUTH LOGIN/;
const MAX_AGE_MS = 24 * 3_600_000;

export interface NotifierOptions {
  now?: () => number;
  log?: (line: string) => void;
  schedule?: (fn: () => void, ms: number) => () => void;
  backoffMs?: number[];
}

/**
 * Sends one email per approval that becomes pending after email was first set up. What was already pending is a
 * silent baseline. Sent ids are remembered in email-notify.json, so a restart never mails twice.
 */
export class EmailNotifier {
  private readonly file: string;
  private sent: string[] | undefined;
  private gaveUp: string[] = [];
  /** When each queued item was first tried, for the 24-hour cap. */
  private firstTried = new Map<string, number>();
  private signInFailed = false;
  private queue: Approval[] = [];
  private pendingIds = new Set<string>();
  private busy?: Promise<void>;
  private attempts = 0;
  private retry?: () => void;
  private stopped = false;
  private lastSentAt?: number;
  private lastFailedAt?: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly backoff: number[];

  constructor(dataDir: string, private readonly transport: MailTransport, private readonly addresses: { to: string; from: string }, opts: NotifierOptions = {}) {
    this.file = path.join(dataDir, FILE);
    this.log = opts.log ?? ((line) => console.warn(line));
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
    this.backoff = opts.backoffMs ?? BACKOFF_MS;
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: number; sent?: unknown; gaveUp?: unknown };
        if (data.version === 1 && Array.isArray(data.sent) && data.sent.every((s) => typeof s === 'string')) this.sent = data.sent as string[];
        if (Array.isArray(data.gaveUp) && data.gaveUp.every((s) => typeof s === 'string')) this.gaveUp = data.gaveUp as string[];
      }
    } catch { /* an unreadable record starts a fresh silent baseline rather than mailing everything */ }
  }

  status(): EmailStatus {
    // A later successful send clears the failed state; the last failure time stays visible.
    const failed = this.signInFailed || (this.lastFailedAt !== undefined && (this.lastSentAt === undefined || this.lastFailedAt > this.lastSentAt));
    const label = this.signInFailed ? 'Email: sign-in failed — check AGENT_EMPIRE_SMTP_URL' : failed ? 'Email: last send failed' : 'Email: configured';
    return { state: failed ? 'failed' : 'configured', label,
      ...(this.gaveUp.length ? { gaveUp: this.gaveUp.length } : {}),
      ...(this.lastSentAt ? { lastSentAt: this.lastSentAt } : {}), ...(this.lastFailedAt ? { lastFailedAt: this.lastFailedAt } : {}) };
  }

  /** Called with the inbox whenever it changes. Never throws, never waits for SMTP. */
  observe(items: Approval[]) {
    if (this.stopped) return;
    const pending = items.filter((i) => i.status === 'pending');
    this.pendingIds = new Set(pending.map((i) => i.id));
    if (this.sent === undefined) {
      this.sent = pending.map((i) => i.id);
      this.save();
      return;
    }
    for (const item of pending) if (!this.sent.includes(item.id) && !this.gaveUp.includes(item.id) && !this.queue.some((q) => q.id === item.id)) this.queue.push(item);
    this.kick();
  }

  /** Resolves once nothing is being sent (tests). */
  async idle() {
    while (this.busy) await this.busy;
  }

  stop() {
    this.stopped = true;
    this.retry?.();
    this.retry = undefined;
  }

  private kick() {
    if (this.busy || this.retry || this.stopped) return;
    this.busy = this.drain().finally(() => { this.busy = undefined; });
  }

  private async drain() {
    while (!this.stopped) {
      this.queue = this.queue.filter((q) => this.pendingIds.has(q.id) && !this.sent!.includes(q.id) && !this.gaveUp.includes(q.id));
      const item = this.queue[0];
      if (!item) return;
      if (!this.firstTried.has(item.id)) this.firstTried.set(item.id, this.now());
      try {
        await this.transport.send(approvalEmail(item, this.addresses));
      } catch (error) {
        this.attempts += 1;
        const now = this.now();
        this.lastFailedAt = now;
        const message = (error as Error).message;
        const signIn = SIGN_IN_FAILED.test(message);
        const tooOld = !signIn && now - (this.firstTried.get(item.id) ?? now) >= MAX_AGE_MS;
        if (PERMANENT.test(message) || tooOld) {
          // Refused for this message, or failing for a day: give up on it so it never blocks the ones behind it.
          this.log(`[email] Gave up on the notification for approval ${item.id} after ${this.attempts} attempt${this.attempts === 1 ? '' : 's'}: ${message}.`);
          this.gaveUp = [...this.gaveUp, item.id].slice(-MAX_SENT);
          this.firstTried.delete(item.id);
          this.attempts = 0;
          this.queue.shift();
          this.save();
          continue;
        }
        // Sign-in failures pause everything without giving up; the next attempt (or a restart) resumes the queue.
        this.signInFailed = signIn;
        const wait = this.backoff[Math.min(this.attempts - 1, this.backoff.length - 1)];
        // The transport's errors carry a status code at most; the URL and password are never logged.
        this.log(signIn
          ? `[email] Sign-in to the SMTP server failed (${message}); notifications are paused. Check AGENT_EMPIRE_SMTP_URL. Retrying in ${Math.round(wait / 1000)} s.`
          : `[email] Could not send the notification for approval ${item.id} (attempt ${this.attempts}): ${message}. Retrying in ${Math.round(wait / 1000)} s.`);
        const cancel = this.schedule(() => { this.retry = undefined; this.kick(); }, wait);
        this.retry = cancel;
        return;
      }
      this.attempts = 0;
      this.signInFailed = false;
      this.firstTried.delete(item.id);
      this.lastSentAt = this.now();
      this.sent!.push(item.id);
      this.sent = this.sent!.slice(-MAX_SENT);
      this.queue.shift();
      this.save();
    }
  }

  private save() {
    try { writeJsonAtomic(this.file, { version: 1, sent: this.sent, gaveUp: this.gaveUp }); }
    catch (error) { this.log(`[email] Could not save ${FILE}: ${(error as Error).message}`); }
  }
}
