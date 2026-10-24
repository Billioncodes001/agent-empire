/**
 * FREE-01: worker engines, local models and linked accounts. Shared by server and client; pure data and functions only.
 *
 * An engine is the coding-agent CLI a worker runs in its terminal, plus where its model comes from:
 * - `claude-code` (premium): the user's own `/login` in the unmodified `claude` on this host, or their Anthropic API key;
 * - `qwen-code` (free, Apache-2.0): a local model served by Ollama on this host;
 * - `codex` (optional): the user's own `codex login`, or `--oss` with a local Ollama model.
 */

export type EngineId = 'claude-code' | 'qwen-code' | 'codex';
/** subscription = the user's own CLI sign-in on this host; api-key = their own key; local = a model on this computer. */
export type EngineAuth = 'subscription' | 'api-key' | 'local';

export interface WorkerEngine {
  id: EngineId;
  auth: EngineAuth;
  /** Local model tag (e.g. `gpt-oss:20b`) for local engines. */
  model?: string;
}

export const ENGINE_NAME: Record<EngineId, string> = { 'claude-code': 'Claude Code', 'qwen-code': 'Qwen Code', codex: 'Codex' };

/** The engine of a worker saved before FREE-01, and of any spawn that does not name one. */
export const LEGACY_ENGINE: WorkerEngine = { id: 'claude-code', auth: 'subscription' };

/** Stable key for a choice, e.g. `qwen-code/local/gpt-oss:20b`. */
export function engineKey(e: WorkerEngine): string {
  return [e.id, e.auth, e.model].filter(Boolean).join('/');
}

/** The honest label shown on the worker's card, name plate and terminal header (FREE_PLAN rule 4). */
export function engineLabel(e: WorkerEngine | undefined): string {
  const engine = e ?? LEGACY_ENGINE;
  const name = ENGINE_NAME[engine.id] ?? engine.id;
  if (engine.auth === 'local') return `${name} · ${engine.model ?? 'local model'} (local)`;
  if (engine.auth === 'api-key') return `${name} · ${engine.id === 'codex' ? 'OpenAI' : 'Anthropic'} API key`;
  return `${name} · your ${engine.id === 'codex' ? 'ChatGPT' : 'Claude'} account`;
}

/** A worker's label: an agent restored with an unrecognised engine says so instead of claiming Claude Code. */
export function workerEngineLabel(w: { engine?: WorkerEngine; statusKnown?: boolean }): string {
  return !w.engine && w.statusKnown === false ? 'Unknown engine' : engineLabel(w.engine);
}

/** Provider spend for a worker's engine: local models cost nothing; premium spend is tracked (and labelled) elsewhere. */
export function engineSpendLabel(e: WorkerEngine | undefined): string | undefined {
  return e?.auth === 'local' ? 'US$0 · local model' : undefined;
}

export function sanitizeEngine(v: unknown): WorkerEngine | undefined {
  const o = v as Partial<WorkerEngine> | undefined;
  if (!o || typeof o !== 'object') return undefined;
  if (o.id !== 'claude-code' && o.id !== 'qwen-code' && o.id !== 'codex') return undefined;
  if (o.auth !== 'subscription' && o.auth !== 'api-key' && o.auth !== 'local') return undefined;
  // Only combinations that exist: Qwen Code is local-only here; Codex has no key mode in the Empire.
  if (o.id === 'qwen-code' && o.auth !== 'local') return undefined;
  if (o.id === 'codex' && o.auth === 'api-key') return undefined;
  if (o.id === 'claude-code' && o.auth === 'local') return undefined;
  const model = typeof o.model === 'string' && MODEL_TAG.test(o.model) ? o.model : undefined;
  if (o.auth === 'local' && !model) return undefined;
  return { id: o.id, auth: o.auth, ...(o.auth === 'local' ? { model } : {}) };
}

/** An Ollama model tag: `name[:tag]`, optionally namespaced. Never a URL or a path traversal. */
export const MODEL_TAG = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?(:[a-zA-Z0-9][a-zA-Z0-9._-]{0,63})?$/;

// ---- Local model catalogue and RAM recommendations ---------------------------------------------------------------

export interface ModelInfo {
  tag: string;
  label: string;
  /** Download size in GB, from the Ollama library page as recorded in FREE_STACK.md §2 (2026-10-23). */
  sizeGb: number;
  licence: string;
  minRamGb: number;
  note: string;
}

/** Names and sizes from docs/team/FREE_STACK.md §2. Tags can change upstream: the UI says to verify they exist. */
export const MODEL_CATALOGUE: ModelInfo[] = [
  { tag: 'gpt-oss:20b', label: 'gpt-oss 20B', sizeGb: 14, licence: 'Apache-2.0', minRamGb: 16, note: 'Runs in 16 GB. General reasoning with tool calling; not a coding specialist.' },
  { tag: 'qwen3-coder:30b', label: 'Qwen3-Coder 30B-A3B', sizeGb: 19, licence: 'Apache-2.0', minRamGb: 32, note: 'Fast: a mixture of experts (about 3B active) trained for agentic coding.' },
  { tag: 'qwen3.8:27b', label: 'Qwen3.8 27B', sizeGb: 18, licence: 'Apache-2.0', minRamGb: 32, note: 'Quality: dense and slower (about 5 to 7 tokens a second reported on 32 GB).' },
];
export const MODEL_TAG_CAVEAT = 'Verify the tag exists in the Ollama library before downloading: tags can change.';
export const OLLAMA_INSTALL_URL = 'https://ollama.com/download';

export interface ModelRecommendation extends ModelInfo { role: 'default' | 'fast' | 'quality' | 'option' }

/** FREE_PLAN owner decision: 16 GB floor uses gpt-oss:20b; 32 GB or more offers qwen3-coder:30b (fast) and qwen3.8:27b (quality). */
export function recommendModels(totalMemBytes: number): { ramGb: number; models: ModelRecommendation[]; note: string } {
  const ramGb = Math.round((totalMemBytes / 2 ** 30) * 10) / 10;
  const by = (tag: string) => MODEL_CATALOGUE.find((m) => m.tag === tag)!;
  // Reported totals sit a little under the nominal size on some machines (firmware reservations).
  if (ramGb >= 31) return { ramGb, note: '32 GB or more: Qwen3-Coder for speed, Qwen3.8 for quality.', models: [{ ...by('qwen3-coder:30b'), role: 'fast' }, { ...by('qwen3.8:27b'), role: 'quality' }, { ...by('gpt-oss:20b'), role: 'option' }] };
  if (ramGb >= 15) return { ramGb, note: '16 GB: gpt-oss 20B is the model that fits.', models: [{ ...by('gpt-oss:20b'), role: 'default' }] };
  return { ramGb, models: [], note: `${ramGb} GB is below the 16 GB floor for local coding models. Use an opt-in free hosted key, or a premium engine.` };
}

// ---- Linked accounts state (server → client) ---------------------------------------------------------------------

export interface CliAccount {
  installed: boolean;
  /** null when the CLI could not say (no output we understand). */
  loggedIn: boolean | null;
  /** How it is signed in, as the CLI reported it (never a credential): e.g. "claude.ai", "ChatGPT", "API key". */
  method?: string;
  plan?: string;
  /** ISO time the sign-in expires, if the CLI reported one. */
  expiresAt?: string;
  expired?: boolean;
  /** Within 7 days of expiry. */
  expiringSoon?: boolean;
  /** A short, credential-free explanation for the panel. */
  detail: string;
}

export interface PullState {
  model: string;
  status: string;
  completed: number;
  total: number;
  done: boolean;
  error?: string;
  cancelled?: boolean;
}

export interface OllamaState {
  running: boolean;
  version?: string;
  models: { name: string; sizeBytes: number }[];
  url: string;
  installUrl: string;
  pull?: PullState;
  detail: string;
}

export type KeyName = 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'OPENROUTER_API_KEY' | 'GEMINI_API_KEY' | 'GROQ_API_KEY';
export const KEY_NAMES: KeyName[] = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY'];

export interface HostedProvider {
  id: 'openrouter' | 'gemini' | 'groq';
  name: string;
  key: KeyName;
  baseUrl: string;
  termsUrl: string;
  /** Shown before a key is saved. A summary only: the provider's own page is authoritative. */
  terms: string;
}

export const HOSTED_FREE: HostedProvider[] = [
  { id: 'openrouter', name: 'OpenRouter (free models)', key: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', termsUrl: 'https://openrouter.ai/terms',
    terms: 'Free models are served by third-party providers, and some of them log prompts or may train on them. OpenRouter lets you exclude providers that train on your data in its privacy settings. Free use is rate-limited.' },
  { id: 'gemini', name: 'Google Gemini API (free tier)', key: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', termsUrl: 'https://ai.google.dev/gemini-api/terms',
    terms: 'On the unpaid tier, Google may use your prompts and responses to improve its products, and human reviewers may read them. Do not send confidential code or personal data. Free use is rate-limited.' },
  { id: 'groq', name: 'Groq (free plan)', key: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', termsUrl: 'https://groq.com/terms-of-use',
    terms: 'Read Groq’s terms and privacy policy for how prompts are retained. Free-plan limits are low (thousands of tokens a minute), which is too little for long agentic coding sessions.' },
];
export const HOSTED_TERMS_CAVEAT = 'Agent Empire summarises these terms but has not verified them; the provider’s page is authoritative and can change.';

export interface EngineOption {
  engine: WorkerEngine;
  label: string;
  premium: boolean;
  usable: boolean;
  /** Why it is (not) usable, or what to install. */
  reason: string;
}

export interface EnginesState {
  claude: CliAccount;
  codex: CliAccount;
  qwen: { installed: boolean; detail: string };
  ollama: OllamaState;
  ram: { totalGb: number; note: string; models: ModelRecommendation[] };
  keys: { name: KeyName; present: boolean }[];
  hosted: HostedProvider[];
  /** 'auto' prefers a healthy premium engine and falls back to a free one. */
  defaultEngine: 'auto' | WorkerEngine;
  options: EngineOption[];
  /** The engine a new hire gets by default, or null with `help` saying what to install. */
  recommended: WorkerEngine | null;
  help: string[];
  checkedAt: number;
}

/**
 * Builds the hire choices from what is installed and signed in. Premium is preferred when healthy (FREE_PLAN rule 2);
 * otherwise the free engine is offered with its label; with nothing usable, `help` says what to install.
 */
export function engineOptions(s: Pick<EnginesState, 'claude' | 'codex' | 'qwen' | 'ollama' | 'keys' | 'ram'>): EngineOption[] {
  const key = (n: KeyName) => s.keys.some((k) => k.name === n && k.present);
  const out: EngineOption[] = [];
  const add = (engine: WorkerEngine, premium: boolean, usable: boolean, reason: string) => out.push({ engine, label: engineLabel(engine), premium, usable, reason });
  // Rules 4 and 6: an apiKeyHelper or ANTHROPIC_API_KEY in the user's or project's Claude settings makes `claude auth
  // status` report an API-key method; that is API billing, so it is never offered as "your Claude account".
  const subscription = isSubscriptionMethod(s.claude.method);
  const claudeOk = s.claude.installed && s.claude.loggedIn === true && !s.claude.expired && subscription;
  add({ id: 'claude-code', auth: 'subscription' }, true, claudeOk,
    !s.claude.installed ? 'Install Claude Code, then sign in inside it with /login.' : s.claude.expired ? 'Your Claude sign-in has expired: sign in again with /login.' : s.claude.loggedIn === false ? 'Not signed in: use “Sign in to Claude”, then complete /login yourself.' : s.claude.loggedIn === null ? 'Sign-in state unknown: `claude auth status` gave no answer we understand.'
      : !subscription ? `Claude Code reports the sign-in method “${s.claude.method ?? 'unknown'}”, which is not your Claude subscription (an API key or apiKeyHelper in your Claude settings bills the API). Remove it, or choose the API-key engine.` : 'Signed in on this computer.');
  add({ id: 'claude-code', auth: 'api-key' }, true, s.claude.installed && key('ANTHROPIC_API_KEY'),
    !s.claude.installed ? 'Install Claude Code.' : key('ANTHROPIC_API_KEY') ? 'Uses your Anthropic API key; billed by Anthropic at API rates.' : 'No Anthropic API key saved.');
  const codexOk = s.codex.installed && s.codex.loggedIn === true;
  add({ id: 'codex', auth: 'subscription' }, true, codexOk, !s.codex.installed ? 'Optional: install Codex CLI, then run `codex login` yourself.' : codexOk ? 'Signed in with your own `codex login`.' : 'Not signed in: run `codex login` in a terminal yourself.');
  const local = s.ollama.models.map((m) => m.name);
  const recommended = s.ram.models.map((m) => m.tag);
  const tags = [...new Set([...recommended.filter((t) => local.includes(t)), ...local.filter((t) => !t.endsWith('-cloud'))])];
  const freeReason = (installed: boolean, cli: string, tag: string) =>
    !installed ? `Install ${cli}.` : !s.ollama.running ? 'Start Ollama (or install it from ollama.com).' : !local.includes(tag) ? `Download ${tag} first (Linked accounts → Ollama).` : 'Free: runs on this computer, US$0 provider spend.';
  for (const tag of tags.length ? tags : recommended.slice(0, 1)) {
    add({ id: 'qwen-code', auth: 'local', model: tag }, false, s.qwen.installed && s.ollama.running && local.includes(tag), freeReason(s.qwen.installed, 'Qwen Code (npm install -g @qwen-code/qwen-code)', tag));
  }
  for (const tag of tags.length ? tags : []) {
    add({ id: 'codex', auth: 'local', model: tag }, false, s.codex.installed && s.ollama.running && local.includes(tag), freeReason(s.codex.installed, 'Codex CLI', tag));
  }
  return out;
}

/** A Claude sign-in method that is the user's subscription (claude.ai login or their own OAuth token), never a key or helper. */
export function isSubscriptionMethod(method: string | undefined): boolean {
  return !!method && /claude\.ai|oauth|subscription/i.test(method) && !/api|key|helper|console|bedrock|vertex|foundry/i.test(method);
}

export function pickEngine(options: EngineOption[], preference: 'auto' | WorkerEngine = 'auto'): { engine: WorkerEngine | null; help: string[] } {
  if (preference !== 'auto') {
    const chosen = options.find((o) => o.usable && engineKey(o.engine) === engineKey(preference));
    if (chosen) return { engine: chosen.engine, help: [] };
  }
  const premium = options.find((o) => o.usable && o.premium);
  if (premium) return { engine: premium.engine, help: [] };
  const free = options.find((o) => o.usable && !o.premium);
  if (free) return { engine: free.engine, help: [] };
  return {
    engine: null,
    help: [
      'No worker engine is ready yet. For the free path: install Ollama (ollama.com/download), download a recommended model in Linked accounts, and install Qwen Code (npm install -g @qwen-code/qwen-code).',
      'For premium: install Claude Code and sign in inside it with /login, or save an Anthropic API key.',
    ],
  };
}
