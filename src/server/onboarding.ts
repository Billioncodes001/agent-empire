/**
 * FREE-08 (ORG-06): onboarding progress and the settings it collects, on the office host.
 *
 * - onboarding.json: the step model (src/shared/onboarding.ts). Written on first start, so an install that was already
 *   founded then is recorded as legacy for good and never pushed through onboarding.
 * - settings.json: non-secret settings (company profile, channel addresses, budget). Secrets go to the SecretStore.
 * An unreadable file is never overwritten: the host keeps defaults in memory, says why, and refuses changes.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './persistence.js';
import { invalidSecret, type SecretStore } from './secrets.js';
import { refusedTarget } from './notify.js';
import {
  DEFAULT_SETTINGS, ONBOARDING_STEPS, SECRET_NAMES, advance, dismiss, goTo, initialProgress, isStep, reopen,
  validateApprovals, validateNotifications, validateProfile,
  type OnboardingProgress, type SavedSettings, type SecretName,
} from '../shared/onboarding.js';

export class OnboardingError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'OnboardingError'; }
}

export type SettingsChange = 'profile' | 'telegram' | 'ntfy' | 'email' | 'budget';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function only(v: unknown, keys: string[], what: string): Record<string, unknown> {
  if (!isObj(v)) throw new OnboardingError(400, `Expected ${what} as a JSON object.`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw new OnboardingError(400, `Unknown setting: ${what}.${k}`);
  return v;
}
const text = (v: unknown, name: string, max: number) => {
  if (typeof v !== 'string') throw new OnboardingError(400, `${name} must be text.`);
  if (v.length > max) throw new OnboardingError(400, `${name} is too long.`);
  return v.trim();
};

function validProgress(v: unknown): v is OnboardingProgress {
  if (!isObj(v) || v.version !== 1 || typeof v.legacy !== 'boolean' || !isStep(v.current)) return false;
  if (!['not_started', 'in_progress', 'done', 'dismissed'].includes(v.status as string)) return false;
  return isObj(v.steps) && ONBOARDING_STEPS.every((s) => ['pending', 'done', 'skipped'].includes((v.steps as Record<string, unknown>)[s] as string));
}

export class OnboardingService {
  private readonly progressFile: string;
  private readonly settingsFile: string;
  private state: OnboardingProgress;
  private saved: SavedSettings = structuredClone(DEFAULT_SETTINGS);
  readonly storageError?: string;

  private readonly allowLocalTargets: boolean;

  /** `allowLocalTargets`: the desktop app, where ntfy/SMTP on this computer (loopback) is a normal self-hosted setup. */
  constructor(dataDir: string, private readonly secrets: SecretStore, opts: { legacy: boolean; now?: () => number; allowLocalTargets?: boolean }) {
    this.now = opts.now ?? Date.now;
    this.allowLocalTargets = !!opts.allowLocalTargets;
    this.progressFile = path.join(dataDir, 'onboarding.json');
    this.settingsFile = path.join(dataDir, 'settings.json');
    const problems: string[] = [];
    if (existsSync(this.progressFile)) {
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(this.progressFile, 'utf8')); } catch { parsed = undefined; }
      if (validProgress(parsed)) this.state = parsed;
      else { this.state = initialProgress(true); problems.push('onboarding.json is unreadable; preserve it and fix or remove it.'); }
    } else {
      this.state = initialProgress(opts.legacy);
      writeJsonAtomic(this.progressFile, this.state);
    }
    if (existsSync(this.settingsFile)) {
      try { this.saved = this.merge(structuredClone(DEFAULT_SETTINGS), JSON.parse(readFileSync(this.settingsFile, 'utf8')), true); }
      catch { problems.push('settings.json is unreadable; preserve it and fix or remove it. Saved settings are not in effect.'); }
    }
    if (problems.length) this.storageError = problems.join(' ');
  }
  private readonly now: () => number;

  progress(): OnboardingProgress { return structuredClone(this.state); }
  settings(): SavedSettings { return structuredClone(this.saved); }

  private writable() { if (this.storageError) throw new OnboardingError(409, this.storageError); }

  updateProgress(body: unknown): OnboardingProgress {
    this.writable();
    const b = only(body, ['action', 'step', 'result'], 'progress');
    const now = this.now();
    let next: OnboardingProgress;
    switch (b.action) {
      case 'step':
        if (!isStep(b.step) || (b.result !== 'done' && b.result !== 'skipped')) throw new OnboardingError(400, 'A step needs a step name and result done or skipped.');
        next = advance(this.state, b.step, b.result, now);
        break;
      case 'goto':
        if (!isStep(b.step)) throw new OnboardingError(400, 'Unknown step.');
        next = goTo(this.state, b.step, now);
        break;
      case 'dismiss': next = dismiss(this.state, now); break;
      case 'reopen': next = reopen(this.state, now); break;
      default: throw new OnboardingError(400, 'action must be step, goto, dismiss or reopen.');
    }
    writeJsonAtomic(this.progressFile, next);
    this.state = next;
    return this.progress();
  }

  /** Strict merge of a partial body into settings; `trusted` (our own file) tolerates nothing extra either. */
  private merge(base: SavedSettings, body: unknown, trusted = false): SavedSettings {
    const b = only(body, trusted ? ['version', 'profile', 'notifications', 'approvals'] : ['profile', 'notifications', 'approvals', 'secrets'], 'settings');
    if (b.profile !== undefined) {
      const p = only(b.profile, ['name', 'mission', 'industry', 'website'], 'profile');
      for (const k of Object.keys(p) as (keyof SavedSettings['profile'])[]) base.profile[k] = text(p[k], `profile.${k}`, 1000);
      const errors = validateProfile(base.profile);
      if (errors.length) throw new OnboardingError(400, errors.join(' '));
    }
    if (b.notifications !== undefined) {
      const n = only(b.notifications, ['telegram', 'ntfy', 'email'], 'notifications');
      if (n.telegram !== undefined) base.notifications.telegram.ownerId = text(only(n.telegram, ['ownerId'], 'telegram').ownerId ?? base.notifications.telegram.ownerId, 'telegram.ownerId', 20);
      if (n.ntfy !== undefined) {
        const x = only(n.ntfy, ['server', 'topic'], 'ntfy');
        if (x.server !== undefined) base.notifications.ntfy.server = text(x.server, 'ntfy.server', 300).replace(/\/+$/, '');
        if (x.topic !== undefined) base.notifications.ntfy.topic = text(x.topic, 'ntfy.topic', 64);
      }
      if (n.email !== undefined) {
        const e = only(n.email, ['host', 'port', 'security', 'user', 'to', 'from'], 'email');
        const t = base.notifications.email;
        for (const k of ['host', 'user', 'to', 'from'] as const) if (e[k] !== undefined) t[k] = text(e[k], `email.${k}`, 254);
        if (e.port !== undefined) {
          if (e.port !== null && typeof e.port !== 'number') throw new OnboardingError(400, 'email.port must be a number or null.');
          t.port = e.port as number | null;
        }
        if (e.security !== undefined) t.security = e.security as 'tls' | 'starttls';
      }
      const errors = validateNotifications(base.notifications);
      if (errors.length) throw new OnboardingError(400, errors.join(' '));
    }
    if (b.approvals !== undefined) {
      const a = only(b.approvals, ['dailyBudgetUsd', 'pauseHiring'], 'approvals');
      if (a.dailyBudgetUsd !== undefined) base.approvals.dailyBudgetUsd = a.dailyBudgetUsd === null ? null : Math.round(Number(a.dailyBudgetUsd) * 100) / 100;
      if (a.dailyBudgetUsd !== undefined && a.dailyBudgetUsd !== null && typeof a.dailyBudgetUsd !== 'number') throw new OnboardingError(400, 'approvals.dailyBudgetUsd must be a number or null.');
      if (a.pauseHiring !== undefined) base.approvals.pauseHiring = a.pauseHiring as boolean;
      const errors = validateApprovals(base.approvals);
      if (errors.length) throw new OnboardingError(400, errors.join(' '));
    }
    return base;
  }

  /**
   * Applies a partial update. `secrets` maps a name to a new value, or null to remove it; absent names are kept.
   * Everything is validated before anything is written. Returns which parts changed so the host re-applies only those.
   */
  updateSettings(body: unknown): Set<SettingsChange> {
    this.writable();
    const before = this.saved;
    const next = this.merge(structuredClone(before), body);
    const secretOps: [SecretName, string | null][] = [];
    if (isObj(body) && body.secrets !== undefined) {
      const s = only(body.secrets, [...SECRET_NAMES], 'secrets');
      for (const name of SECRET_NAMES) {
        if (s[name] === undefined) continue;
        if (s[name] !== null) { const problem = invalidSecret(name, s[name]); if (problem) throw new OnboardingError(400, problem); }
        secretOps.push([name, s[name] as string | null]);
      }
    }
    // Review 7: where notifications may go from this host.
    const nb = next.notifications, bb = before.notifications;
    if (nb.ntfy.server && nb.ntfy.server !== bb.ntfy.server) {
      let host = '';
      try { host = new URL(nb.ntfy.server).hostname; } catch { /* validNtfyServer reports it */ }
      const refused = host && refusedTarget(host, this.allowLocalTargets);
      if (refused) throw new OnboardingError(400, `ntfy server: ${refused}`);
    }
    if (nb.email.host && nb.email.host !== bb.email.host) {
      const refused = refusedTarget(nb.email.host, this.allowLocalTargets);
      if (refused) throw new OnboardingError(400, `SMTP server: ${refused}`);
    }
    // Review 2: a stored token or password never follows a changed destination. It must be entered again (or removed)
    // in the same request; otherwise nothing is saved.
    const supplied = (n: SecretName) => secretOps.some(([name]) => name === n);
    const present = this.secrets.names();
    if (present.ntfyToken && !supplied('ntfyToken') && nb.ntfy.server !== bb.ntfy.server)
      throw new OnboardingError(400, 'You changed the ntfy server. Enter its access token again (or remove the saved one) so it is never sent to a new server.');
    if (present.smtpPassword && !supplied('smtpPassword') && (nb.email.host !== bb.email.host || nb.email.port !== bb.email.port || nb.email.security !== bb.email.security))
      throw new OnboardingError(400, 'You changed the SMTP server, port or security. Enter the SMTP password again (or remove the saved one) so it is never sent to a new server.');
    // Review 10: all-or-nothing. Earlier secret writes are undone when a later one, or settings.json, fails.
    const undo: (() => void)[] = [];
    try {
      for (const [name, value] of secretOps) {
        const previous = this.secrets.get(name);
        if (value === null) this.secrets.delete(name); else this.secrets.set(name, value);
        undo.push(() => { if (previous === undefined) this.secrets.delete(name); else this.secrets.set(name, previous); });
      }
      writeJsonAtomic(this.settingsFile, next);
    } catch (error) {
      for (const restore of undo.reverse()) { try { restore(); } catch { /* best effort; the store reports its own state */ } }
      throw new OnboardingError(409, `Nothing was saved: ${(error as Error).message}`);
    }
    this.saved = next;
    const changed = new Set<SettingsChange>();
    const diff = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
    if (diff(before.profile, next.profile)) changed.add('profile');
    if (diff(before.approvals, next.approvals)) changed.add('budget');
    for (const c of ['telegram', 'ntfy', 'email'] as const) if (diff(before.notifications[c], next.notifications[c])) changed.add(c);
    for (const [name] of secretOps) changed.add(name === 'telegramToken' ? 'telegram' : name === 'ntfyToken' ? 'ntfy' : 'email');
    return changed;
  }
}
