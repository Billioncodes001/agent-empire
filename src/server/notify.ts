/**
 * FREE-08: notification channels configured in onboarding (Telegram, ntfy, email) and the worker budget, with the
 * precedence between the host's environment and the saved settings.
 *
 * Precedence, per channel (all of a channel's variables together, never mixed with saved values):
 *   test injection (ServerRuntime) > environment variables > saved settings (onboarding / Settings) > off.
 * The worker budget: --budget / --budget-pause > AGENT_OFFICE_BUDGET / AGENT_OFFICE_BUDGET_PAUSE > saved > none.
 * See docs/team/reports/free-08.md for the full table.
 */
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { emailConfig, isLoopbackHost, type EmailConfig, type MailTransport } from './email.js';
import { telegramConfig, type TelegramConfig } from './telegram.js';
import type { SecretStore } from './secrets.js';
import { NTFY_TOPIC, TELEGRAM_OWNER, isAddress, type SavedSettings, type Source } from '../shared/onboarding.js';

export interface Resolved<T> { source: Source; config?: T; error?: string }
export interface NtfyConfig { server: string; topic: string; token?: string }

const has = (env: NodeJS.ProcessEnv, names: string[]) => names.some((n) => env[n] !== undefined && env[n] !== '');

export function resolveTelegram(env: NodeJS.ProcessEnv, saved: SavedSettings, secrets: SecretStore): Resolved<TelegramConfig> {
  if (has(env, ['AGENT_EMPIRE_TELEGRAM_TOKEN', 'AGENT_EMPIRE_TELEGRAM_OWNER_ID'])) {
    try { return { source: 'env', config: telegramConfig(env) }; } catch (error) { return { source: 'env', error: (error as Error).message }; }
  }
  const token = secrets.get('telegramToken');
  const owner = saved.notifications.telegram.ownerId;
  if (!token || !owner) return { source: 'off' };
  if (!TELEGRAM_OWNER.test(owner)) return { source: 'saved', error: 'The saved Telegram user ID is not a number.' };
  try { return { source: 'saved', config: telegramConfig({ AGENT_EMPIRE_TELEGRAM_TOKEN: token, AGENT_EMPIRE_TELEGRAM_OWNER_ID: owner }) }; }
  catch { return { source: 'saved', error: 'The saved Telegram bot token or user ID is not valid.' }; }
}

export function resolveEmail(env: NodeJS.ProcessEnv, saved: SavedSettings, secrets: SecretStore): Resolved<EmailConfig> {
  // Review 5: a sender on its own cannot be combined with saved settings (never mixed), so it is reported, not ignored.
  if (has(env, ['AGENT_EMPIRE_NOTIFY_FROM']) && !has(env, ['AGENT_EMPIRE_SMTP_URL', 'AGENT_EMPIRE_NOTIFY_EMAIL']))
    return { source: 'env', error: 'AGENT_EMPIRE_NOTIFY_FROM is set on the host without AGENT_EMPIRE_SMTP_URL and AGENT_EMPIRE_NOTIFY_EMAIL. Set those too, or remove it: saved email settings are not used while it is set.' };
  if (has(env, ['AGENT_EMPIRE_SMTP_URL', 'AGENT_EMPIRE_NOTIFY_EMAIL'])) {
    try { const config = emailConfig(env); return config ? { source: 'env', config } : { source: 'off' }; }
    catch (error) { return { source: 'env', error: (error as Error).message }; }
  }
  const e = saved.notifications.email;
  if (!e.host || !e.to) return { source: 'off' };
  if (!isAddress(e.to) || (e.from && !isAddress(e.from))) return { source: 'saved', error: 'The saved email addresses are not valid.' };
  const pass = secrets.get('smtpPassword');
  const secure = e.security === 'tls';
  const smtp = { secure, host: e.host, port: e.port ?? (secure ? 465 : 587), ...(e.user ? { user: e.user } : {}), ...(e.user && pass ? { pass } : {}) };
  const from = e.from || (e.user && isAddress(e.user) ? e.user : e.to);
  return { source: 'saved', config: { smtp, to: e.to, from } };
}

/** Why an ntfy server URL is refused, or undefined. https anywhere; http only to this computer (loopback). */
export function validNtfyServer(raw: string, withToken: boolean): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return 'The ntfy server must be a URL such as https://ntfy.sh.'; }
  if (url.username || url.password) return 'Put no credentials in the ntfy server address; use the access token field.';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && isLoopbackHost(host)) return undefined;
  return `The ntfy server must use https:// (plain http only for a server on this computer)${withToken ? ', so the access token is never sent unencrypted' : ''}.`;
}

const serverOf = (raw: string) => { const u = new URL(raw); return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`; };

/** AGENT_EMPIRE_NTFY_URL is the full topic URL (https://ntfy.sh/my-topic); AGENT_EMPIRE_NTFY_TOKEN is optional. */
export function ntfyConfig(env: NodeJS.ProcessEnv): NtfyConfig | undefined {
  const raw = env.AGENT_EMPIRE_NTFY_URL?.trim();
  const token = env.AGENT_EMPIRE_NTFY_TOKEN?.trim();
  if (!raw && !token) return undefined;
  if (!raw) throw new Error('Set AGENT_EMPIRE_NTFY_URL (for example https://ntfy.sh/your-topic) to use AGENT_EMPIRE_NTFY_TOKEN.');
  const problem = validNtfyServer(raw, !!token);
  if (problem) throw new Error(`AGENT_EMPIRE_NTFY_URL: ${problem}`);
  const url = new URL(raw);
  const parts = url.pathname.split('/').filter(Boolean);
  const topic = parts.pop() ?? '';
  if (!NTFY_TOPIC.test(topic)) throw new Error('AGENT_EMPIRE_NTFY_URL must end with the topic name (letters, digits, - and _).');
  return { server: `${url.protocol}//${url.host}${parts.length ? `/${parts.join('/')}` : ''}`, topic, ...(token ? { token } : {}) };
}

export function resolveNtfy(env: NodeJS.ProcessEnv, saved: SavedSettings, secrets: SecretStore): Resolved<NtfyConfig> {
  if (has(env, ['AGENT_EMPIRE_NTFY_URL', 'AGENT_EMPIRE_NTFY_TOKEN'])) {
    try { const config = ntfyConfig(env); return config ? { source: 'env', config } : { source: 'off' }; }
    catch (error) { return { source: 'env', error: (error as Error).message }; }
  }
  const n = saved.notifications.ntfy;
  if (!n.topic || !n.server) return { source: 'off' };
  const token = secrets.get('ntfyToken');
  const problem = validNtfyServer(n.server, !!token) ?? (NTFY_TOPIC.test(n.topic) ? undefined : 'The saved ntfy topic is not valid.');
  if (problem) return { source: 'saved', error: problem };
  return { source: 'saved', config: { server: serverOf(n.server), topic: n.topic, ...(token ? { token } : {}) } };
}

export interface HostBudget { usd?: number; pause: boolean; source?: 'cli' | 'env'; pauseSource?: 'cli' | 'env' }
/** Amount and pause are each taken from the host when the host sets them (review 4), else from the saved settings. */
export function resolveBudget(host: HostBudget, saved: SavedSettings): { source: Source; usd?: number; pause: boolean } {
  if (host.usd !== undefined) return { source: host.source ?? 'cli', usd: host.usd, pause: host.pause };
  const usd = saved.approvals.dailyBudgetUsd;
  if (usd === null) return { source: 'off', usd: undefined, pause: false };
  return { source: 'saved', usd, pause: host.pauseSource ? host.pause : saved.approvals.pauseHiring };
}

// ---- Where notifications may go (review 7, re-review 2) ---------------------------------------------------------

const V4_PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const V4_LOOPBACK = /^127\./;
const DOTTED_QUAD = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** IPv6 text to 16 bytes, or undefined when it is not IPv6 (handles `::` and a trailing dotted quad). */
function ipv6Bytes(host: string): number[] | undefined {
  if (!isIP(host) || !host.includes(':')) return undefined;
  let text = host;
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (quad) { const p = quad[1].split('.').map(Number); text = `${text.slice(0, -quad[1].length)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`; }
  const [head, tail] = text.split('::');
  const part = (s?: string) => (s ? s.split(':').filter(Boolean) : []);
  const h = part(head), t = part(tail);
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return undefined;
  return groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; });
}

/**
 * Why a target host must not be used, or undefined. On a server install (`allowLoopback` false) loopback is refused
 * too; the desktop may use loopback for a self-hosted ntfy or mail relay. Private, link-local, CGNAT, unique-local,
 * NAT64-mapped and IPv4-compatible forms are refused everywhere, as are numeric host forms other than a plain dotted
 * quad (`2130706433`, `0x7f000001`, `0177.0.0.1`) and `localhost`/`.local`/`.internal` names, with or without a
 * trailing dot. Host names are also resolved and every answer checked (checkResolvedTarget, guardedLookup).
 */
export function refusedTarget(rawHost: string, allowLoopback: boolean): string | undefined {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  const LOOP = 'On a server install, notifications cannot go to this computer (loopback). Use the desktop app for a server on this computer.';
  const PRIVATE = 'Notifications cannot go to a private, link-local or internal network address.';
  if (!host) return 'Enter a server name.';
  const v6 = ipv6Bytes(host);
  if (v6) {
    const zero = (n: number) => v6.slice(0, n).every((b) => b === 0);
    const v4 = (from: number) => v6.slice(from, from + 4).join('.');
    if (zero(15) && v6[15] === 1) return allowLoopback ? undefined : LOOP; // ::1
    if (zero(12)) return refusedTarget(v4(12), allowLoopback) ?? PRIVATE; // ::a.b.c.d (and ::), never a public route
    if (zero(10) && v6[10] === 255 && v6[11] === 255) return refusedTarget(v4(12), allowLoopback) ?? PRIVATE; // ::ffff:a.b.c.d
    if (v6[0] === 0x00 && v6[1] === 0x64 && v6[2] === 0xff && v6[3] === 0x9b) return PRIVATE; // NAT64 64:ff9b::/96 (and /48 local use)
    if ((v6[0] & 0xfe) === 0xfc || (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80)) return PRIVATE; // fc00::/7, fe80::/10
    return undefined;
  }
  if (/^[\d.x]+$/i.test(host) && /\d/.test(host)) {
    if (!DOTTED_QUAD.test(host)) return 'Use a server name or a plain IPv4 address (a.b.c.d).';
    if (V4_LOOPBACK.test(host)) return allowLoopback ? undefined : LOOP;
    return V4_PRIVATE.some((r) => r.test(host)) ? PRIVATE : undefined;
  }
  if (/^0x[0-9a-f]+$/i.test(host)) return 'Use a server name or a plain IPv4 address (a.b.c.d).';
  if (host === 'localhost' || host.endsWith('.localhost')) return allowLoopback ? undefined : LOOP;
  if (host.endsWith('.local') || host.endsWith('.internal') || host === 'local' || host === 'internal') return PRIVATE;
  return undefined;
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export const systemResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

/** Resolves a host name and checks every address it returns. Returns the first (checked) address to connect to. */
export async function checkResolvedTarget(host: string, allowLoopback: boolean, resolve: Resolver = systemResolver): Promise<{ address: string; family: number }> {
  const literal = refusedTarget(host, allowLoopback);
  if (literal) throw new ChannelError(literal);
  const bare = host.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (isIP(bare)) return { address: bare, family: isIP(bare) };
  let answers: { address: string; family: number }[];
  try { answers = await resolve(bare); } catch { throw new ChannelError('The server name could not be found.'); }
  if (!answers.length) throw new ChannelError('The server name could not be found.');
  for (const a of answers) {
    const problem = refusedTarget(a.address, allowLoopback);
    if (problem) throw new ChannelError(`That server name points to a refused address. ${problem}`);
  }
  return answers[0];
}

/**
 * A `lookup` for net/tls/http connections: resolves, checks every answer, and connects only to the checked address
 * (pinned), so a name cannot be re-pointed between the check and the connection. TLS still verifies the host name.
 */
export function guardedLookup(allowLoopback: boolean, resolve: Resolver = systemResolver): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => {
    checkResolvedTarget(hostname, allowLoopback, resolve).then(
      (a) => (options?.all ? callback(null, [a]) : callback(null, a.address, a.family)),
      (error) => callback(error as Error, '', 0),
    );
  }) as unknown as LookupFunction;
}

/** Errors from a channel transport: `signIn` pauses the notifier; `permanent` gives up that one message. */
export class ChannelError extends Error {
  signIn?: true;
  permanent?: true;
}

/**
 * ntfy publishing as JSON to the server root (https://docs.ntfy.sh/publish/#publish-as-json). Fixed destination: the
 * configured server only, no redirects followed. With `guard`, the host is resolved, every address checked and the
 * connection pinned to the checked address. The response body is never read (review 6). Errors name an HTTP status at
 * most, never the URL or the token.
 */
export function ntfyTransport(cfg: NtfyConfig, opts: { guard?: { allowLoopback: boolean; resolve?: Resolver } } = {}): MailTransport {
  return {
    async send(m) {
      const url = new URL(`${cfg.server}/`);
      if (opts.guard) {
        const literal = refusedTarget(url.hostname, opts.guard.allowLoopback);
        if (literal) throw new ChannelError(literal);
      }
      const body = JSON.stringify({ topic: cfg.topic, title: m.subject.slice(0, 250), message: m.text.slice(0, 4000), tags: ['office'] });
      const status = await new Promise<number>((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https.request : http.request)(url, {
          method: 'POST', timeout: 15_000,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
          ...(opts.guard ? { lookup: guardedLookup(opts.guard.allowLoopback, opts.guard.resolve) } : {}),
        }, (res) => { resolve(res.statusCode ?? 0); res.destroy(); });
        request.on('timeout', () => request.destroy(new Error('timeout')));
        request.on('error', (error) => reject(error instanceof ChannelError ? error : new ChannelError('ntfy connection failed; check the server address and connectivity.')));
        request.end(body);
      });
      if (status >= 200 && status < 300) return;
      const error = new ChannelError(`ntfy answered HTTP ${status}`);
      if (status === 401 || status === 403) error.signIn = true;
      else if (status >= 300 && status < 500 && status !== 429) error.permanent = true;
      throw error;
    },
  };
}
