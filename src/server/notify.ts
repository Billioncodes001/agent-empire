/**
 * FREE-08: notification channels configured in onboarding (Telegram, ntfy, email) and the worker budget, with the
 * precedence between the host's environment and the saved settings.
 *
 * Precedence, per channel (all of a channel's variables together, never mixed with saved values):
 *   test injection (ServerRuntime) > environment variables > saved settings (onboarding / Settings) > off.
 * The worker budget: --budget / --budget-pause > AGENT_OFFICE_BUDGET / AGENT_OFFICE_BUDGET_PAUSE > saved > none.
 * See docs/team/reports/free-08.md for the full table.
 */
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

export interface HostBudget { usd?: number; pause: boolean; source?: 'cli' | 'env' }
export function resolveBudget(host: HostBudget, saved: SavedSettings): { source: Source; usd?: number; pause: boolean } {
  if (host.usd !== undefined) return { source: host.source ?? 'cli', usd: host.usd, pause: host.pause };
  const usd = saved.approvals.dailyBudgetUsd;
  if (usd === null) return { source: 'off', usd: undefined, pause: false };
  return { source: 'saved', usd, pause: saved.approvals.pauseHiring };
}

/** Errors from a channel transport: `signIn` pauses the notifier; `permanent` gives up that one message. */
export class ChannelError extends Error {
  signIn?: true;
  permanent?: true;
}

/**
 * ntfy publishing as JSON to the server root (https://docs.ntfy.sh/publish/#publish-as-json). Fixed destination: the
 * configured server only, no redirects. Errors name an HTTP status at most, never the URL or the token.
 */
export function ntfyTransport(cfg: NtfyConfig, fetchImpl: typeof fetch = fetch): MailTransport {
  return {
    async send(m) {
      let res: Response;
      try {
        res = await fetchImpl(`${cfg.server}/`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { 'content-type': 'application/json', ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
          body: JSON.stringify({ topic: cfg.topic, title: m.subject.slice(0, 250), message: m.text.slice(0, 4000), tags: ['office'] }),
        });
      } catch { throw new ChannelError('ntfy connection failed; check the server address and connectivity.'); }
      await res.arrayBuffer().catch(() => undefined);
      if (res.ok) return;
      const error = new ChannelError(`ntfy answered HTTP ${res.status}`);
      if (res.status === 401 || res.status === 403) error.signIn = true;
      else if (res.status >= 400 && res.status < 500 && res.status !== 429) error.permanent = true;
      throw error;
    },
  };
}

