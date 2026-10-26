/**
 * The first-launch setup as a pure state machine: which step is shown, what may advance, and what gets forgotten.
 * The DOM (view.ts) only renders a state and dispatches actions; everything here is unit-tested without a browser.
 */

import { chooseModelSource, requiredSecret, RUN_CAPS, validateActionsSettings, type ActionsSettings } from '../../cloud/actions-spec';

export type Mode = 'cloud' | 'server';
export type Step = 'welcome' | 'mode' | 'server' | 'github' | 'repos' | 'providers' | 'limits' | 'review' | 'create';
export const CLOUD_STEPS: readonly Step[] = ['github', 'repos', 'providers', 'limits', 'review', 'create'];
export const STATE_REPO_NAME = 'agent-empire-state';
export const MAX_REPOS = 20;

export interface RepoRef {
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
}
export const repoKey = (r: Pick<RepoRef, 'owner' | 'name'>) => `${r.owner}/${r.name}`.toLowerCase();

export type ProviderId = 'anthropic' | 'openai';
export const PROVIDER_NAMES: Record<ProviderId, string> = { anthropic: 'Claude (Anthropic API)', openai: 'OpenAI API' };

export interface Limits {
  maxConcurrent: number;
  perJob: string; // dollars as typed
  daily: string;
  approveEachJob: boolean;
}
/** How often the coordinator runs on its schedule (minutes). 30 is the default; see actionsEstimate. */
export const INTERVALS = [15, 20, 30, 60] as const;
export type Interval = (typeof INTERVALS)[number];
export const DEFAULT_INTERVAL: Interval = 30;

/**
 * GitHub's published included Actions minutes per month for private repositories, by plan. From the coordinator report
 * (written from memory, UNVERIFIED): recheck against github.com/pricing before release. Unknown plans show no figure.
 */
export const PLAN_MINUTES: Record<string, number> = { free: 2000, pro: 3000, team: 3000 };
export function actionsEstimate(interval: number, plan?: string | null) {
  const runs = Math.round((30 * 24 * 60) / interval);
  const included = plan ? PLAN_MINUTES[plan.toLowerCase()] : undefined;
  return { runs, minutes: runs, included, share: included ? runs / included : undefined };
}

export const LIMIT_BOUNDS = { maxConcurrent: 10, perJobCents: 100_000, dailyCents: 10_000_000 };
export const DEFAULT_LIMITS: Limits = { maxConcurrent: 1, perJob: '5.00', daily: '20.00', approveEachJob: true };

/**
 * FREE-04: where cloud jobs run. `api-keys` is today's Anthropic Managed Agents path (keys sealed in this UI).
 * `qwen-free` and `claude-subscription` run in the user's own GitHub Actions in the project repository.
 */
export type EngineChoice = 'api-keys' | 'qwen-free' | 'claude-subscription';
export const ENGINE_CHOICES: readonly EngineChoice[] = ['qwen-free', 'claude-subscription', 'api-keys'];
export interface FreeModelChoice { selfHostedLabel: string; selfHostedModel: string; hostedOptIn: boolean; hostedBaseUrl: string; hostedModel: string; cpuOptIn: boolean }
export const DEFAULT_FREE: FreeModelChoice = { selfHostedLabel: '', selfHostedModel: 'qwen3-coder:30b', hostedOptIn: false, hostedBaseUrl: 'https://openrouter.ai/api/v1', hostedModel: '', cpuOptIn: false };
/** Result of the secret-NAME check in the project repository (no value is ever read or accepted). */
export interface SecretCheckState { status: 'unchecked' | 'checking' | 'present' | 'missing' | 'error'; name?: string; updatedAt?: string; rotationDue?: boolean; error?: string }

export interface SetupState {
  step: Step;
  mode?: Mode;
  /** A one-line explanation carried into the setup, e.g. why the device was signed out. */
  notice?: string;
  server: { address: string };
  github: { login?: string; token?: string; via?: 'device' | 'token'; plan?: string | null };
  repos: RepoRef[];
  /** In memory only, on their way to sealed-box encryption. Cleared whenever the cloud path is left. */
  providers: Record<ProviderId, string>;
  /** Fine-grained token for the project repositories (PROJECT_GITHUB_TOKEN). In memory only, like the API keys. */
  projectToken: string;
  limits: Limits;
  interval: Interval;
  acceptedCosts: boolean;
  engine: EngineChoice;
  free: FreeModelChoice;
  /** Claude in GitHub Actions: the user's plan (CLAUDE_CODE_OAUTH_TOKEN) or an API key secret (ANTHROPIC_API_KEY). */
  claudeAuth: 'subscription' | 'api-key';
  secretCheck: SecretCheckState;
}

export type Action =
  | { type: 'begin' }
  | { type: 'chooseMode'; mode: Mode }
  | { type: 'back' }
  | { type: 'next' }
  | { type: 'setAddress'; address: string }
  | { type: 'githubLinked'; login: string; token: string; via: 'device' | 'token'; plan?: string | null }
  | { type: 'githubUnlinked' }
  | { type: 'toggleRepo'; repo: RepoRef }
  | { type: 'setProvider'; id: ProviderId; value: string }
  | { type: 'setLimits'; patch: Partial<Limits> }
  | { type: 'setProjectToken'; value: string }
  | { type: 'setInterval'; interval: number }
  | { type: 'acceptCosts'; value: boolean }
  | { type: 'setEngine'; engine: EngineChoice }
  | { type: 'setFree'; patch: Partial<FreeModelChoice> }
  | { type: 'setClaudeAuth'; value: 'subscription' | 'api-key' }
  | { type: 'setSecretCheck'; value: SecretCheckState }
  | { type: 'forgetSecrets' }
  /** Back to the mode choice from anywhere, forgetting what the cloud path collected. */
  | { type: 'changeMode' };

export function initialState(opts: { step?: Step; mode?: Mode; notice?: string; address?: string } = {}): SetupState {
  return {
    step: opts.step ?? 'welcome',
    mode: opts.mode,
    notice: opts.notice,
    server: { address: opts.address ?? '' },
    github: {},
    repos: [],
    providers: { anthropic: '', openai: '' },
    projectToken: '',
    limits: { ...DEFAULT_LIMITS },
    interval: DEFAULT_INTERVAL,
    acceptedCosts: false,
    engine: 'api-keys',
    free: { ...DEFAULT_FREE },
    claudeAuth: 'subscription',
    secretCheck: { status: 'unchecked' },
  };
}

// ---- Validation -------------------------------------------------------------------------------------

/** Whole cents from a typed dollar amount, or null when it is not a plain non-negative number. */
export function parseCents(text: string): number | null {
  const t = text.trim().replace(/^\$/, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
export const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function validateLimits(l: Limits): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(l.maxConcurrent) || l.maxConcurrent < 1 || l.maxConcurrent > LIMIT_BOUNDS.maxConcurrent)
    errors.push(`Jobs at once must be a whole number from 1 to ${LIMIT_BOUNDS.maxConcurrent}.`);
  const per = parseCents(l.perJob);
  const day = parseCents(l.daily);
  if (per === null || per < 1 || per > LIMIT_BOUNDS.perJobCents) errors.push(`The allowance per job must be from $0.01 to ${dollars(LIMIT_BOUNDS.perJobCents)}.`);
  if (day === null || day < 1 || day > LIMIT_BOUNDS.dailyCents) errors.push(`The daily allowance must be from $0.01 to ${dollars(LIMIT_BOUNDS.dailyCents)}.`);
  else if (per !== null && day < per) errors.push('The daily allowance must be at least the allowance per job.');
  return errors;
}

const KEY_SHAPE: Record<ProviderId, RegExp> = {
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,500}$/,
  openai: /^sk-(?!ant-)[A-Za-z0-9_-]{20,500}$/,
};

/** Format checks only: keys are never sent anywhere to be "tested"; they go straight into sealed-box secrets. */
export function validateProviderKey(id: ProviderId, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (/\s/.test(v)) return 'A key has no spaces or line breaks.';
  if (!KEY_SHAPE[id].test(v))
    return id === 'anthropic' ? 'An Anthropic API key starts with sk-ant-. Copy it from the Claude Console.' : 'An OpenAI API key starts with sk-. Copy it from the OpenAI dashboard.';
  return null;
}

export function validateProviders(p: Record<ProviderId, string>, projectToken = ''): string[] {
  const errors = (Object.keys(p) as ProviderId[]).map((id) => validateProviderKey(id, p[id])).filter((e): e is string => !!e);
  if (!p.anthropic.trim() && !p.openai.trim()) errors.unshift('Add at least one API key: Anthropic, OpenAI or both.');
  const pt = validateProjectToken(projectToken);
  if (pt) errors.push(pt);
  return errors;
}

/** The project token is optional at setup, but when given it must be a fine-grained token (the installer refuses others). */
export function validateProjectToken(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (/\s/.test(v)) return 'A token has no spaces or line breaks.';
  if (!/^github_pat_[A-Za-z0-9_]{20,300}$/.test(v)) return 'Use a fine-grained token (it starts with github_pat_). Classic tokens grant too much access.';
  return null;
}
export const linkedProviders = (p: Record<ProviderId, string>) => (Object.keys(p) as ProviderId[]).filter((id) => p[id].trim());

/** The publish job's own cap (job-workflow.ts), added to the agent job's time cap for the per-job minutes figure. */
export const PUBLISH_JOB_MINUTES = 15;
export const jobMinutesCap = (settings: Pick<ActionsSettings, 'timeoutMinutes'>) => settings.timeoutMinutes + PUBLISH_JOB_MINUTES;
/** Honest cost line for a GitHub Actions engine: free runners only on public repositories. */
export const jobMinutesNote = (settings: Pick<ActionsSettings, 'timeoutMinutes'>) =>
  `US$0 on public repositories; private repositories use GitHub Actions minutes (up to ${jobMinutesCap(settings)} minutes per job)`;

/** GitHub Actions settings for the chosen engine, or the reason they are incomplete. */
export function actionsSettingsFor(s: Pick<SetupState, 'engine' | 'free' | 'claudeAuth'>): { settings: ActionsSettings | null; error?: string } {
  if (s.engine === 'api-keys') return { settings: null };
  const base = { maxTurns: RUN_CAPS.turns.default, timeoutMinutes: RUN_CAPS.minutes.default, openPullRequest: true };
  try {
    if (s.engine === 'claude-subscription') return { settings: validateActionsSettings({ engine: s.claudeAuth === 'api-key' ? 'claude-api-key' : 'claude-subscription', ...base }) };
    const f = s.free;
    const source = chooseModelSource({ selfHostedLabel: f.selfHostedLabel.trim(), hostedKeyOptIn: f.hostedOptIn, cpuOptIn: f.cpuOptIn });
    if (!source) return { settings: null, error: 'Choose where the free model runs: your own runner, a free hosted key, or the small CPU model.' };
    const model = source === 'self_hosted_ollama' ? { runnerLabel: f.selfHostedLabel.trim(), model: f.selfHostedModel.trim() } : source === 'hosted_free_key' ? { hostedBaseUrl: f.hostedBaseUrl.trim(), model: f.hostedModel.trim() } : {};
    return { settings: validateActionsSettings({ engine: 'qwen-free', modelSource: source, ...model, ...base, ...(source === 'cpu_small' ? { timeoutMinutes: RUN_CAPS.minutes.max } : {}) }) };
  } catch (error) {
    return { settings: null, error: error instanceof Error ? error.message : 'These settings are incomplete.' };
  }
}

/** Free or subscription engines in GitHub Actions: no API key; the project token and (when needed) the secret name. */
export function validateActionsChoice(s: SetupState): string[] {
  const errors: string[] = [];
  const { settings, error } = actionsSettingsFor(s);
  if (!settings) errors.push(error ?? 'Choose an engine.');
  if (!s.projectToken.trim()) errors.push('Add the project access token: the coordinator needs it to start job runs in your project.');
  const pt = validateProjectToken(s.projectToken);
  if (pt) errors.push(pt);
  // Security review M4: a yolo agent on a persistent machine can leave things behind; GitHub also warns against
  // self-hosted runners on public repositories, where anyone can propose workflow changes.
  // Unknown visibility is treated as public.
  if (settings?.modelSource === 'self_hosted_ollama' && s.repos[0] && s.repos[0].private !== true) errors.push(`${s.repos[0].owner}/${s.repos[0].name} is ${s.repos[0].private === false ? 'a public repository' : 'not known to be private'}: don’t run agents on your own runner there. Use a private repository, or another free model source.`);
  if (settings && requiredSecret(settings) && s.secretCheck.status !== 'present') errors.push(`Set ${requiredSecret(settings)} in your project repository from your own terminal, then check it here.`);
  return errors;
}

/** What blocks the current step from advancing (empty when it may). */
export function blockers(s: SetupState): string[] {
  switch (s.step) {
    case 'welcome':
      return [];
    case 'mode':
      return s.mode ? [] : ['Choose how your Empire runs.'];
    case 'github':
      return s.github.login && s.github.token ? [] : ['Link your GitHub account first.'];
    case 'repos':
      if (!s.repos.length) return ['Choose at least one project repository.'];
      return s.repos.length > MAX_REPOS ? [`Choose at most ${MAX_REPOS} repositories.`] : [];
    case 'providers':
      return s.engine === 'api-keys' ? validateProviders(s.providers, s.projectToken) : validateActionsChoice(s);
    case 'limits':
      return validateLimits(s.limits);
    case 'review':
      return s.acceptedCosts ? [] : ['Confirm that the costs are billed to your own accounts.'];
    default:
      return []; // server and create advance through their own async actions
  }
}

// ---- Transitions ------------------------------------------------------------------------------------

const cloudIndex = (step: Step) => CLOUD_STEPS.indexOf(step);

/** Leaving the cloud path forgets everything sensitive it collected. */
function withoutCloudSecrets(s: SetupState): SetupState {
  return { ...s, github: {}, repos: [], providers: { anthropic: '', openai: '' }, projectToken: '', acceptedCosts: false };
}

export function reduce(s: SetupState, a: Action): SetupState {
  switch (a.type) {
    case 'begin':
      return s.step === 'welcome' ? { ...s, step: 'mode' } : s;
    case 'chooseMode':
      if (s.step !== 'mode') return s;
      return a.mode === 'server' ? { ...withoutCloudSecrets(s), mode: 'server', step: 'server' } : { ...s, mode: 'cloud', step: 'github' };
    case 'back': {
      if (s.step === 'mode') return { ...s, step: 'welcome' };
      if (s.step === 'server') return { ...s, step: 'mode', notice: undefined };
      if (s.step === 'github') return { ...withoutCloudSecrets(s), step: 'mode' };
      const i = cloudIndex(s.step);
      return i > 0 ? { ...s, step: CLOUD_STEPS[i - 1] } : s;
    }
    case 'next': {
      if (blockers(s).length) return s;
      if (s.step === 'welcome') return { ...s, step: 'mode' };
      const i = cloudIndex(s.step);
      // 'create' is reached from review; 'server' and 'create' finish through their own async work.
      if (i >= 0 && i < CLOUD_STEPS.length - 1) return { ...s, step: CLOUD_STEPS[i + 1] };
      return s;
    }
    case 'setAddress':
      return { ...s, server: { address: a.address.slice(0, 300) } };
    case 'githubLinked':
      if (!a.login || !a.token) return s;
      // A different account invalidates the repositories chosen for the previous one.
      return { ...s, github: { login: a.login, token: a.token, via: a.via, plan: a.plan ?? null }, repos: s.github.login === a.login ? s.repos : [] };
    case 'githubUnlinked':
      return { ...s, github: {}, repos: [] };
    case 'toggleRepo': {
      const key = repoKey(a.repo);
      if (a.repo.name.toLowerCase() === STATE_REPO_NAME) return s; // the Empire's own state repo is not a project
      const has = s.repos.some((r) => repoKey(r) === key);
      if (!has && s.repos.length >= MAX_REPOS) return s;
      return { ...s, repos: has ? s.repos.filter((r) => repoKey(r) !== key) : [...s.repos, a.repo] };
    }
    case 'setProvider':
      return { ...s, providers: { ...s.providers, [a.id]: a.value.slice(0, 600) } };
    case 'setLimits': {
      const limits = { ...s.limits, ...a.patch };
      limits.maxConcurrent = Math.max(1, Math.min(LIMIT_BOUNDS.maxConcurrent, Math.round(Number(limits.maxConcurrent) || 1)));
      return { ...s, limits };
    }
    case 'setProjectToken':
      return { ...s, projectToken: a.value.slice(0, 400) };
    case 'setInterval':
      return (INTERVALS as readonly number[]).includes(a.interval) ? { ...s, interval: a.interval as Interval } : s;
    case 'acceptCosts':
      return { ...s, acceptedCosts: a.value };
    case 'setEngine':
      return ENGINE_CHOICES.includes(a.engine) ? { ...s, engine: a.engine, secretCheck: { status: 'unchecked' } } : s;
    case 'setFree':
      return { ...s, free: { ...s.free, ...a.patch }, secretCheck: { status: 'unchecked' } };
    case 'setClaudeAuth':
      return { ...s, claudeAuth: a.value, secretCheck: { status: 'unchecked' } };
    case 'setSecretCheck':
      return { ...s, secretCheck: a.value };
    case 'forgetSecrets':
      return { ...s, providers: { anthropic: '', openai: '' }, projectToken: '' };
    case 'changeMode':
      return s.step === 'welcome' || s.step === 'mode' ? s : { ...withoutCloudSecrets(s), step: 'mode', notice: undefined };
  }
}

/** Plain progress for the rail: which steps of the chosen path are done, current or ahead. */
export function progress(s: SetupState): { step: Step; label: string; state: 'done' | 'current' | 'ahead' }[] {
  const labels: Partial<Record<Step, string>> = {
    github: 'GitHub', repos: 'Projects', providers: 'Engine', limits: 'Limits', review: 'Review', create: 'Create', server: 'Sign in',
  };
  const path: Step[] = s.mode === 'server' ? ['mode', 'server'] : s.mode === 'cloud' ? ['mode', ...CLOUD_STEPS] : ['mode'];
  const at = s.step === 'welcome' ? -1 : path.indexOf(s.step);
  return path.map((step, i) => ({ step, label: step === 'mode' ? 'Choose' : labels[step]!, state: i < at ? 'done' : i === at ? 'current' : 'ahead' }));
}

// ---- Progress across reloads (DEVICE-BUGS-03) ----------------------------------------------------------

/** localStorage key for the setup's non-secret progress (view.ts writes it, boot.ts restores it). */
export const PROGRESS_KEY = 'agent-empire.setup.progress';

/** What survives a reload: choices only. Never the GitHub token, API keys, project token or the cost confirmation. */
export function progressSnapshot(s: SetupState) {
  return {
    v: 1 as const,
    step: s.step,
    mode: s.mode,
    server: { address: s.server.address },
    github: { login: s.github.login, via: s.github.via, plan: s.github.plan },
    repos: s.repos.map((r) => ({ owner: r.owner, name: r.name, private: r.private, defaultBranch: r.defaultBranch })),
    limits: { ...s.limits },
    interval: s.interval,
    engine: s.engine,
    free: { ...s.free },
    claudeAuth: s.claudeAuth,
  };
}

const str = (v: unknown, max = 300) => (typeof v === 'string' && v.length <= max ? v : undefined);
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Rebuilds a setup state from a snapshot. Starting at the first step of the chosen path, it moves forward only while
 * each step's requirements hold again (the token from secure storage, in-memory keys, the cost confirmation), and never
 * past the saved step or onto "create". Anything malformed gives `base` back unchanged.
 */
export function restoreProgress(base: SetupState, saved: unknown, secure: { token?: string | null; login?: string | null }): SetupState {
  if (!saved || typeof saved !== 'object') return base;
  const p = saved as Record<string, unknown>;
  const steps: Step[] = ['mode', 'server', ...CLOUD_STEPS];
  if (p.v !== 1 || typeof p.step !== 'string' || !steps.includes(p.step as Step)) return base;
  const mode = p.mode === 'cloud' || p.mode === 'server' ? p.mode : undefined;
  const step = p.step as Step;
  if (step !== 'mode' && !mode) return base;
  if (step !== 'mode' && (step === 'server') !== (mode === 'server')) return base;
  let s: SetupState = { ...base, mode };
  const server = p.server as Record<string, unknown> | undefined;
  if (server && str(server.address) !== undefined) s.server = { address: str(server.address)! };
  if (mode !== 'cloud') return { ...s, step: step === 'server' ? 'server' : 'mode' };

  const gh = (p.github ?? {}) as Record<string, unknown>;
  const savedLogin = str(gh.login, 100);
  const repos = Array.isArray(p.repos) ? (p.repos as unknown[]) : null;
  const limits = p.limits as Record<string, unknown> | undefined;
  if (repos === null || !limits || typeof limits !== 'object') return base;
  const okRepos = repos.filter((r): r is RepoRef => {
    const x = r as Partial<RepoRef> | null;
    return !!x && typeof x === 'object' && NAME.test(String(x.owner)) && NAME.test(String(x.name)) && typeof x.private === 'boolean' && typeof x.defaultBranch === 'string';
  }).slice(0, MAX_REPOS);
  if (okRepos.length !== repos.length || typeof limits.perJob !== 'string' || typeof limits.daily !== 'string' || typeof limits.approveEachJob !== 'boolean' || !Number.isInteger(limits.maxConcurrent)) return base;
  const sameAccount = !secure.login || !savedLogin || secure.login === savedLogin;
  s = {
    ...s,
    repos: sameAccount ? okRepos.map((r) => ({ owner: r.owner, name: r.name, private: r.private, defaultBranch: r.defaultBranch.slice(0, 200) })) : [],
    limits: { maxConcurrent: Math.max(1, Math.min(LIMIT_BOUNDS.maxConcurrent, limits.maxConcurrent as number)), perJob: limits.perJob.slice(0, 20), daily: limits.daily.slice(0, 20), approveEachJob: limits.approveEachJob },
    interval: (INTERVALS as readonly number[]).includes(p.interval as number) ? (p.interval as Interval) : base.interval,
    engine: (ENGINE_CHOICES as readonly string[]).includes(p.engine as string) ? (p.engine as EngineChoice) : base.engine,
    claudeAuth: p.claudeAuth === 'api-key' ? 'api-key' : 'subscription',
  };
  const free = p.free as Record<string, unknown> | undefined;
  if (free && typeof free === 'object') {
    s.free = {
      selfHostedLabel: str(free.selfHostedLabel, 100) ?? base.free.selfHostedLabel,
      selfHostedModel: str(free.selfHostedModel, 200) ?? base.free.selfHostedModel,
      hostedOptIn: free.hostedOptIn === true,
      hostedBaseUrl: str(free.hostedBaseUrl, 300) ?? base.free.hostedBaseUrl,
      hostedModel: str(free.hostedModel, 200) ?? base.free.hostedModel,
      cpuOptIn: free.cpuOptIn === true,
    };
  }
  if (secure.token && secure.login && sameAccount) s.github = { login: secure.login, token: secure.token, via: gh.via === 'token' ? 'token' : 'device', plan: str(gh.plan, 40) ?? null };
  s.step = 'github';
  const target = Math.min(CLOUD_STEPS.indexOf(step === 'mode' ? 'github' : step), CLOUD_STEPS.indexOf('review'));
  while (CLOUD_STEPS.indexOf(s.step) < target && !blockers(s).length) s = { ...s, step: CLOUD_STEPS[CLOUD_STEPS.indexOf(s.step) + 1] };
  return s;
}
