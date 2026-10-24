import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './persistence.js';

export interface TelegramConfig { token: string; ownerId: number }
export interface TelegramUpdate {
  update_id: number;
  message?: { date: number; text?: string; from?: { id: number; is_bot?: boolean }; chat: { id: number; type: string } };
}
export interface TelegramTransport {
  call(method: 'getUpdates' | 'sendMessage', body: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export interface TelegramCommands {
  /** Must be idempotent for this stable requestId, including after a process restart. */
  execute(text: string, requestId: string): string;
  /** Compact status without task briefs, credentials, paths or worker terminal output. */
  summary(): { fingerprint: string; text: string };
  /** ORG-03: one message per key, sent once each; keys pending before the first poll are a silent baseline. */
  notifications?(): { key: string; text: string; silent?: boolean }[];
}
interface Checkpoint { version: 1; binding: string; offset: number; fingerprint?: string; notified?: string[] }
/** Announced approval keys kept for de-duplication; older ones are long decided. */
const MAX_NOTIFIED = 500;
const HELP = '/new Client | Job title | Brief\n/plan Client | Job title | Brief — the chief’s model proposes a plan for your approval\n/jobs — current jobs\n/job ID — review a plan\n/approvals — what waits for your approval\n/approve ID [budget] — approve an inbox item (A3) or a reviewed plan (job id)\n/reject ID — decline an inbox item or an unstarted plan\n/research QUESTION — ask the research executive (needs your approval before work starts)\n/optout EMAIL — never email this address again (outreach)\n/status — chief report';
export { HELP as TELEGRAM_HELP };

export function telegramConfig(env: NodeJS.ProcessEnv): TelegramConfig | undefined {
  const token = env.AGENT_EMPIRE_TELEGRAM_TOKEN;
  const owner = env.AGENT_EMPIRE_TELEGRAM_OWNER_ID;
  if (!token && !owner) return;
  if (!token || !/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(token) || !owner || !/^[1-9]\d{0,15}$/.test(owner) || !Number.isSafeInteger(Number(owner)))
    throw new Error('Set both AGENT_EMPIRE_TELEGRAM_TOKEN and a valid numeric AGENT_EMPIRE_TELEGRAM_OWNER_ID on the execution host.');
  return { token, ownerId: Number(owner) };
}

/**
 * Fixed official destination (`base` is only ever changed by test injection, never by settings). Never return Telegram
 * URLs/errors, which can contain the bot token.
 */
export function telegramTransport(token: string, base = 'https://api.telegram.org'): TelegramTransport {
  return {
    async call(method, body, signal) {
      let response: Response;
      try {
        response = await fetch(`${base}/bot${token}/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]), redirect: 'error',
        });
      } catch { throw new Error('Telegram connection failed; check connectivity and bot configuration.'); }
      const value = await response.json().catch(() => null) as { ok?: boolean; result?: unknown } | null;
      if (!response.ok || !value?.ok) throw new Error(`Telegram request failed (HTTP ${response.status}); check bot configuration, webhook conflicts and rate limits.`);
      return value.result;
    },
  };
}

/** One host owns this bot. Only the configured owner in their private chat can issue commands. */
export class TelegramBridge {
  private file: string;
  private saved: Checkpoint;
  private storageError?: string;
  private error?: string;
  private timer?: NodeJS.Timeout;
  private controller = new AbortController();
  private running = false;
  private busy = false;
  private generation = 0;
  private lastPollAt?: number;
  constructor(dataDir: string, private config: TelegramConfig, private commands: TelegramCommands,
    private transport: TelegramTransport = telegramTransport(config.token), private now = Date.now) {
    this.file = path.join(dataDir, 'telegram.json');
    // Cursor belongs to one bot and one owner. Token rotation keeps the numeric bot identity.
    const binding = createHash('sha256').update(`${config.token.split(':')[0]}:${config.ownerId}`).digest('hex');
    this.saved = { version: 1, binding, offset: 0 };
    if (existsSync(this.file)) {
      try {
        const data = JSON.parse(readFileSync(this.file, 'utf8')) as Checkpoint;
        if (data.version !== 1 || data.binding !== binding || !Number.isSafeInteger(data.offset) || data.offset < 0 ||
          (data.fingerprint !== undefined && typeof data.fingerprint !== 'string') ||
          (data.notified !== undefined && (!Array.isArray(data.notified) || data.notified.length > MAX_NOTIFIED || data.notified.some((k) => typeof k !== 'string')))) throw new Error();
        this.saved = data;
      } catch { this.storageError = 'Telegram checkpoint is invalid or belongs to another bot/owner. Preserve it and reconcile before connecting.'; }
    }
  }
  status() {
    return { configured: true, running: this.running, lastPollAt: this.lastPollAt, error: this.storageError ?? this.error };
  }
  start() {
    if (this.running || this.storageError) return;
    this.running = true;
    this.controller = new AbortController();
    this.generation++;
    void this.loop(this.generation);
  }
  stop() { this.running = false; this.generation++; clearTimeout(this.timer); this.controller.abort(); }
  private async loop(generation: number) {
    await this.tick();
    if (this.running && generation === this.generation && !this.storageError) this.timer = setTimeout(() => void this.loop(generation), this.error ? 15_000 : 1_000);
  }
  private save(next: Checkpoint) {
    try { writeJsonAtomic(this.file, next); this.saved = next; }
    catch { this.storageError = 'Telegram checkpoint could not be saved. Commands are paused to prevent replay.'; throw new Error(this.storageError); }
  }
  /** Exposed for deterministic fake-transport tests; never overlaps polls. */
  async tick() {
    if (this.busy || this.storageError || this.controller.signal.aborted) return;
    this.busy = true;
    const generation = this.generation, signal = this.controller.signal;
    const assertCurrent = () => { if (generation !== this.generation || signal.aborted) throw new Error('Telegram poll stopped'); };
    try {
      const updates = await this.transport.call('getUpdates', {
        offset: this.saved.offset, limit: 25, timeout: 20, allowed_updates: ['message'],
      }, signal);
      assertCurrent();
      if (!Array.isArray(updates)) throw new Error('Invalid Telegram update response.');
      for (const raw of updates.slice(0, 25)) {
        const u = raw as TelegramUpdate;
        if (!Number.isSafeInteger(u?.update_id) || u.update_id < 0) throw new Error('Invalid Telegram update identity.');
        if (u.update_id < this.saved.offset) continue;
        const m = u.message;
        if (m?.chat?.type === 'private' && m.chat.id === this.config.ownerId && m.from?.id === this.config.ownerId && !m.from.is_bot && typeof m.text === 'string') {
          const text = m.text.trim();
          let reply: string;
          if (!Number.isFinite(m.date) || m.date * 1000 < this.now() - 10 * 60_000 || m.date * 1000 > this.now() + 60_000)
            reply = 'This command is too old to act on safely. Please send it again.';
          else if (text.length > 4000) reply = 'Please keep the command under 4,000 characters.';
          else if (/^\/(start|help)(?:@\w+)?$/.test(text)) reply = HELP;
          else reply = this.commands.execute(text, `telegram-${this.config.token.split(':')[0]}-${u.update_id}`);
          assertCurrent();
          await this.send(reply, signal);
          assertCurrent();
        }
        // Persist only after command and reply. Replays use the same durable domain idempotency key.
        this.save({ ...this.saved, offset: u.update_id + 1 });
      }
      const report = this.commands.summary();
      if (report.fingerprint !== this.saved.fingerprint) {
        // Baseline is remembered silently. Subsequent job transitions produce one compact update.
        if (this.saved.fingerprint !== undefined) await this.send(report.text, signal);
        assertCurrent();
        this.save({ ...this.saved, fingerprint: report.fingerprint });
      }
      const notes = this.commands.notifications?.() ?? [];
      if (this.saved.notified === undefined) this.save({ ...this.saved, notified: notes.map((n) => n.key).slice(-MAX_NOTIFIED) });
      else for (const note of notes) {
        if (this.saved.notified!.includes(note.key)) continue;
        // Silent: the command reply already told the owner (a plan created with /new).
        if (!note.silent) await this.send(note.text, signal);
        assertCurrent();
        // Saved per message, so a failed send retries only what was not sent.
        this.save({ ...this.saved, notified: [...this.saved.notified!, note.key].slice(-MAX_NOTIFIED) });
      }
      this.lastPollAt = this.now();
      this.error = undefined;
    } catch {
      if (generation === this.generation && !signal.aborted) this.error = 'Telegram could not complete its poll or command. It will retry; check host logs/configuration without sharing the bot token.';
    } finally { this.busy = false; }
  }
  private send(text: string, signal: AbortSignal) {
    return this.transport.call('sendMessage', {
      chat_id: this.config.ownerId, text: text.slice(0, 4000), link_preview_options: { is_disabled: true },
    }, signal);
  }
}
