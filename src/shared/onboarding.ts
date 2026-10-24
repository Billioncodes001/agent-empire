/**
 * FREE-08 (ORG-06): first-run onboarding and the settings it collects. Shared by server and client; pure data only.
 *
 * Onboarding runs after founding, on the office host. Each step can be done or skipped, the dialog resumes at the
 * step it stopped on, and it can be re-opened from Settings. Installs founded before onboarding existed are marked
 * `legacy` and are never pushed through it.
 *
 * Secrets (Telegram bot token, ntfy access token, SMTP password) never appear here: the host reports them only as
 * present or not. There is deliberately no Claude credential of any kind (FREE_PLAN rule 3).
 */

export const ONBOARDING_STEPS = ['profile', 'engines', 'notifications', 'approvals'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type StepState = 'pending' | 'done' | 'skipped';
export type OnboardingStatus = 'not_started' | 'in_progress' | 'done' | 'dismissed';

export const STEP_LABEL: Record<OnboardingStep, string> = {
  profile: 'Company', engines: 'Workers', notifications: 'Notifications', approvals: 'Approvals',
};

export interface OnboardingProgress {
  version: 1;
  status: OnboardingStatus;
  /** Founded before onboarding existed: never offered automatically. */
  legacy: boolean;
  current: OnboardingStep;
  steps: Record<OnboardingStep, StepState>;
  updatedAt?: number;
}

export function initialProgress(legacy: boolean): OnboardingProgress {
  return { version: 1, status: 'not_started', legacy, current: 'profile', steps: { profile: 'pending', engines: 'pending', notifications: 'pending', approvals: 'pending' } };
}

export const isStep = (v: unknown): v is OnboardingStep => typeof v === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(v);

/** Offered automatically once the city is founded, until it is finished or dismissed; never for legacy installs. */
export function shouldOffer(p: OnboardingProgress, founded: boolean): boolean {
  return founded && !p.legacy && (p.status === 'not_started' || p.status === 'in_progress');
}

/** Marks a step done or skipped and moves to the next step still pending after it (or finishes). */
export function advance(p: OnboardingProgress, step: OnboardingStep, result: 'done' | 'skipped', now: number): OnboardingProgress {
  const steps = { ...p.steps, [step]: result };
  const i = ONBOARDING_STEPS.indexOf(step);
  const next = [...ONBOARDING_STEPS.slice(i + 1), ...ONBOARDING_STEPS.slice(0, i)].find((s) => steps[s] === 'pending');
  if (!next) return { ...p, steps, status: 'done', current: step, updatedAt: now };
  return { ...p, steps, status: 'in_progress', current: next, updatedAt: now };
}

export function goTo(p: OnboardingProgress, step: OnboardingStep, now?: number): OnboardingProgress {
  return { ...p, current: step, status: p.status === 'not_started' ? 'in_progress' : p.status, ...(now ? { updatedAt: now } : {}) };
}

export function dismiss(p: OnboardingProgress, now: number): OnboardingProgress {
  return { ...p, status: p.status === 'done' ? 'done' : 'dismissed', updatedAt: now };
}

/**
 * The Workers step contains "Where agents run", so the separate execution offer counts as answered only once that step
 * was done or skipped (security review 3: merely opening onboarding must not hide it).
 */
export function executionOfferAnswered(p: OnboardingProgress): boolean {
  return p.steps.engines !== 'pending';
}

/** From Settings: open again at the first step still pending (or the first step when all were answered). */
export function reopen(p: OnboardingProgress, now: number): OnboardingProgress {
  const pending = ONBOARDING_STEPS.find((s) => p.steps[s] === 'pending');
  return { ...p, status: 'in_progress', current: pending ?? 'profile', updatedAt: now };
}

// ---- Settings ----------------------------------------------------------------------------------------------------

export interface CompanyProfile { name: string; mission: string; industry: string; website: string }
export interface NotificationSettings {
  telegram: { ownerId: string };
  ntfy: { server: string; topic: string };
  email: { host: string; port: number | null; security: 'tls' | 'starttls'; user: string; to: string; from: string };
}
export interface ApprovalSettings {
  /** Daily spend budget for all workers together, USD; null = none. Overridden by --budget / AGENT_OFFICE_BUDGET. */
  dailyBudgetUsd: number | null;
  /** No new hires for the rest of the day once the budget is spent. */
  pauseHiring: boolean;
}
export interface SavedSettings { version: 1; profile: CompanyProfile; notifications: NotificationSettings; approvals: ApprovalSettings }

export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';
export const DEFAULT_SETTINGS: SavedSettings = {
  version: 1,
  profile: { name: '', mission: '', industry: '', website: '' },
  notifications: {
    telegram: { ownerId: '' },
    ntfy: { server: DEFAULT_NTFY_SERVER, topic: '' },
    email: { host: '', port: null, security: 'starttls', user: '', to: '', from: '' },
  },
  approvals: { dailyBudgetUsd: null, pauseHiring: false },
};

export const SECRET_NAMES = ['telegramToken', 'ntfyToken', 'smtpPassword'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export const SECRET_LABEL: Record<SecretName, string> = { telegramToken: 'Telegram bot token', ntfyToken: 'ntfy access token', smtpPassword: 'SMTP password' };

export const CHANNELS = ['telegram', 'ntfy', 'email'] as const;
export type ChannelId = (typeof CHANNELS)[number];
/** Where a value comes from. Precedence: runtime (tests) > cli > env > saved. */
export type Source = 'runtime' | 'cli' | 'env' | 'saved' | 'off';

export const CHANNEL_ENV: Record<ChannelId, string[]> = {
  telegram: ['AGENT_EMPIRE_TELEGRAM_TOKEN', 'AGENT_EMPIRE_TELEGRAM_OWNER_ID'],
  ntfy: ['AGENT_EMPIRE_NTFY_URL', 'AGENT_EMPIRE_NTFY_TOKEN'],
  email: ['AGENT_EMPIRE_SMTP_URL', 'AGENT_EMPIRE_NOTIFY_EMAIL', 'AGENT_EMPIRE_NOTIFY_FROM'],
};
export const BUDGET_ENV = ['AGENT_OFFICE_BUDGET', 'AGENT_OFFICE_BUDGET_PAUSE'];

export interface ChannelView {
  source: Source;
  /** A complete configuration is in effect (it may still be failing). */
  configured: boolean;
  /** Delivering now (false in previews and tests, or while stopped). */
  running: boolean;
  label: string;
  error?: string;
}

export interface SettingsView {
  profile: CompanyProfile;
  notifications: NotificationSettings;
  approvals: ApprovalSettings;
  /** Present or not. Never a value. */
  secrets: Record<SecretName, boolean>;
  /** How secrets are stored on this host, in plain words. */
  secretStorage: string;
  channels: Record<ChannelId, ChannelView>;
  budget: { source: Source; usd?: number; pause: boolean };
}

export interface OnboardingView { progress: OnboardingProgress; offer: boolean; settings: SettingsView; storageError?: string }

// ---- Validation (client prechecks; the host validates again) ------------------------------------------------------

export const PROFILE_MAX = { name: 80, mission: 400, industry: 80, website: 200 };
const ADDRESS = /^[^\s<>@"',;]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
export const isAddress = (s: string) => ADDRESS.test(s) && !/[\u0000-\u001f\u007f]/.test(s);
export const NTFY_TOPIC = /^[-_A-Za-z0-9]{1,64}$/;
export const TELEGRAM_OWNER = /^[1-9]\d{0,15}$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$|^\d{1,3}(\.\d{1,3}){3}$/;
export const isHostname = (s: string) => HOSTNAME.test(s);
const CONTROL = /[\u0000-\u001f\u007f]/;

export function validateProfile(p: CompanyProfile): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(PROFILE_MAX) as (keyof CompanyProfile)[]) {
    const v = p[k];
    if (typeof v !== 'string') { errors.push(`${k} must be text.`); continue; }
    if (v.length > PROFILE_MAX[k]) errors.push(`The ${k} is limited to ${PROFILE_MAX[k]} characters.`);
    if (k !== 'mission' && CONTROL.test(v)) errors.push(`The ${k} must be one line.`);
  }
  if (typeof p.website === 'string' && p.website && !/^https?:\/\/[^\s/@]+(\/[^\s]*)?$/i.test(p.website)) errors.push('The website must start with https:// or http://.');
  return errors;
}

export function validateNotifications(n: NotificationSettings): string[] {
  const errors: string[] = [];
  if (n.telegram.ownerId && !TELEGRAM_OWNER.test(n.telegram.ownerId)) errors.push('Your Telegram user ID is a number (ask @userinfobot).');
  if (n.ntfy.topic && !NTFY_TOPIC.test(n.ntfy.topic)) errors.push('An ntfy topic uses only letters, digits, - and _ (at most 64).');
  const e = n.email;
  if (e.host && !isHostname(e.host)) errors.push('The SMTP server must be a host name such as smtp.example.com.');
  if (e.port !== null && (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535)) errors.push('The SMTP port is a number from 1 to 65535.');
  if (e.security !== 'tls' && e.security !== 'starttls') errors.push('Choose TLS or STARTTLS for the SMTP connection.');
  if (e.user && (e.user.length > 254 || CONTROL.test(e.user))) errors.push('The SMTP user name must be one line.');
  if (e.to && !isAddress(e.to)) errors.push('Send notifications to one email address.');
  if (e.from && !isAddress(e.from)) errors.push('The sender must be one email address.');
  return errors;
}

export const MAX_DAILY_BUDGET_USD = 100_000;
export function validateApprovals(a: ApprovalSettings): string[] {
  const errors: string[] = [];
  if (a.dailyBudgetUsd !== null && (typeof a.dailyBudgetUsd !== 'number' || !Number.isFinite(a.dailyBudgetUsd) || a.dailyBudgetUsd <= 0 || a.dailyBudgetUsd > MAX_DAILY_BUDGET_USD))
    errors.push(`The daily budget must be above $0 and at most $${MAX_DAILY_BUDGET_USD.toLocaleString('en-US')}, or empty for none.`);
  if (typeof a.pauseHiring !== 'boolean') errors.push('Pause hiring is yes or no.');
  return errors;
}

/** A random, hard-to-guess topic: topics on the public ntfy.sh server are readable by anyone who knows the name. */
export function randomTopic(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  return `empire-${[...bytes].map((b) => alphabet[b % alphabet.length]).join('')}`;
}

// ---- Who approves what (read-only: not configurable, by design) ---------------------------------------------------

export const APPROVAL_RULES: { what: string; who: string }[] = [
  { what: 'Client job plans, and their budgets', who: 'You (the signed-in CEO). Nothing starts before you approve.' },
  { what: 'Budget increases for a running job', who: 'You. Held items wait until you decide.' },
  { what: 'Chief proposals and model-backed plans', who: 'You. The chief only proposes; it never auto-accepts.' },
  { what: 'Research questions and tool proposals', who: 'You. Approving a tool records your decision; nothing is installed.' },
  { what: 'Outreach campaigns', who: 'You, per campaign.' },
  { what: 'Lessons for organizational memory', who: 'You. Only approved lessons reach the chief.' },
  { what: 'Telegram /approve and /reject', who: 'Only your own Telegram account, in a private chat with your bot.' },
];

// ---- Cloud mode: what applies --------------------------------------------------------------------------------------

export const CLOUD_APPLIES: Record<OnboardingStep, { applies: 'yes' | 'partly' | 'no'; text: string }> = {
  profile: { applies: 'no', text: 'The company profile is stored on an office host. Cloud mode keeps its state in your GitHub repository and has no host to store it yet.' },
  engines: { applies: 'partly', text: 'Local models (Ollama, Qwen Code) and “Sign in to Claude” do not apply: cloud jobs run on GitHub, not on this computer. Cloud mode uses the API keys you sealed into your repository during setup.' },
  notifications: { applies: 'no', text: 'Telegram, ntfy and email are sent by an office host. In cloud mode there is no always-on host to send them yet.' },
  approvals: { applies: 'partly', text: 'Cloud mode has its own limits (jobs at once, per-job and daily allowance, approve each job), set during cloud setup. Every job still waits for your approval.' },
};
