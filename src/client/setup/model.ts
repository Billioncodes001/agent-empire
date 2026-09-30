/**
 * The first-launch setup as a pure state machine: which step is shown, what may advance, and what gets forgotten.
 * The DOM (view.ts) only renders a state and dispatches actions; everything here is unit-tested without a browser.
 */

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
export const LIMIT_BOUNDS = { maxConcurrent: 10, perJobCents: 100_000, dailyCents: 10_000_000 };
export const DEFAULT_LIMITS: Limits = { maxConcurrent: 1, perJob: '5.00', daily: '20.00', approveEachJob: true };

export interface SetupState {
  step: Step;
  mode?: Mode;
  /** A one-line explanation carried into the setup, e.g. why the device was signed out. */
  notice?: string;
  server: { address: string };
  github: { login?: string; token?: string; via?: 'device' | 'token' };
  repos: RepoRef[];
  /** In memory only, on their way to sealed-box encryption. Cleared whenever the cloud path is left. */
  providers: Record<ProviderId, string>;
  limits: Limits;
  acceptedCosts: boolean;
}

export type Action =
  | { type: 'begin' }
  | { type: 'chooseMode'; mode: Mode }
  | { type: 'back' }
  | { type: 'next' }
  | { type: 'setAddress'; address: string }
  | { type: 'githubLinked'; login: string; token: string; via: 'device' | 'token' }
  | { type: 'githubUnlinked' }
  | { type: 'toggleRepo'; repo: RepoRef }
  | { type: 'setProvider'; id: ProviderId; value: string }
  | { type: 'setLimits'; patch: Partial<Limits> }
  | { type: 'acceptCosts'; value: boolean }
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
    limits: { ...DEFAULT_LIMITS },
    acceptedCosts: false,
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

export function validateProviders(p: Record<ProviderId, string>): string[] {
  const errors = (Object.keys(p) as ProviderId[]).map((id) => validateProviderKey(id, p[id])).filter((e): e is string => !!e);
  if (!p.anthropic.trim() && !p.openai.trim()) errors.unshift('Add at least one API key: Anthropic, OpenAI or both.');
  return errors;
}
export const linkedProviders = (p: Record<ProviderId, string>) => (Object.keys(p) as ProviderId[]).filter((id) => p[id].trim());

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
      return validateProviders(s.providers);
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
  return { ...s, github: {}, repos: [], providers: { anthropic: '', openai: '' }, acceptedCosts: false };
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
      return { ...s, github: { login: a.login, token: a.token, via: a.via }, repos: s.github.login === a.login ? s.repos : [] };
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
    case 'acceptCosts':
      return { ...s, acceptedCosts: a.value };
    case 'forgetSecrets':
      return { ...s, providers: { anthropic: '', openai: '' } };
    case 'changeMode':
      return s.step === 'welcome' || s.step === 'mode' ? s : { ...withoutCloudSecrets(s), step: 'mode', notice: undefined };
  }
}

/** Plain progress for the rail: which steps of the chosen path are done, current or ahead. */
export function progress(s: SetupState): { step: Step; label: string; state: 'done' | 'current' | 'ahead' }[] {
  const labels: Partial<Record<Step, string>> = {
    github: 'GitHub', repos: 'Projects', providers: 'AI keys', limits: 'Limits', review: 'Review', create: 'Create', server: 'Sign in',
  };
  const path: Step[] = s.mode === 'server' ? ['mode', 'server'] : s.mode === 'cloud' ? ['mode', ...CLOUD_STEPS] : ['mode'];
  const at = s.step === 'welcome' ? -1 : path.indexOf(s.step);
  return path.map((step, i) => ({ step, label: step === 'mode' ? 'Choose' : labels[step]!, state: i < at ? 'done' : i === at ? 'current' : 'ahead' }));
}
