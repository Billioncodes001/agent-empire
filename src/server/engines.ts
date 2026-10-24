/**
 * FREE-01 engines and linked accounts (server side).
 *
 * Claude subscription compliance (FREE_PLAN rule 3, FREE_STACK §9): the Empire never offers its own Claude sign-in and
 * never reads Claude credential files or the Keychain. Sign-in state comes only from the OUTPUT of `claude auth status`
 * (and `codex login status`), run as child processes with a provider-key-free environment.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import path from 'node:path';
import {
  HOSTED_FREE, KEY_NAMES, LEGACY_ENGINE, engineOptions, pickEngine, recommendModels, sanitizeEngine,
  type CliAccount, type EnginesState, type KeyName, type WorkerEngine,
} from '../shared/engines.js';
import { writeJsonAtomic } from './persistence.js';
import type { OllamaRuntime } from './ollama.js';

export type ProviderKeys = Partial<Record<KeyName, string>>;

/** Every provider credential a worker could inherit from the office's environment. */
export const PROVIDER_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'CODEX_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY',
  'DASHSCOPE_API_KEY', 'QWEN_MODEL', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_FOUNDRY_API_KEY', 'AZURE_OPENAI_API_KEY',
];

/**
 * The provider part of a worker's environment (FREE_PLAN rule 6). Every provider credential is removed first, then
 * only the engine's own is added back:
 * - Claude subscription: no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (a stray key silently beats `/login`, FREE_STACK §9);
 *   the user's own CLAUDE_CODE_OAUTH_TOKEN is kept because it *is* their subscription.
 * - Claude API key: only ANTHROPIC_API_KEY.
 * - Codex account: no OPENAI_API_KEY / CODEX_API_KEY, so the user's own `codex login` is used.
 * - Local engines: no provider keys at all; Qwen Code gets Ollama's OpenAI-compatible endpoint with a placeholder key.
 * `apiKeyHelper` is a Claude *settings* key, not an environment variable, and the Empire does not edit the user's Claude
 * settings. Instead the linked-accounts panel warns when `claude auth status` reports an API-key or helper method.
 */
export function engineEnv(base: Record<string, string>, engine: WorkerEngine, keys: ProviderKeys, ollamaUrl: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (!PROVIDER_ENV.includes(k)) env[k] = v;
  if (engine.id === 'claude-code' && engine.auth === 'subscription' && base.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = base.CLAUDE_CODE_OAUTH_TOKEN;
  if (engine.id === 'claude-code' && engine.auth === 'api-key' && keys.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = keys.ANTHROPIC_API_KEY;
  if (engine.id === 'qwen-code') {
    // Qwen Code's OpenAI-compatible auth (https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/):
    // OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL. Ollama ignores the key; its OpenAI API lives under /v1.
    Object.assign(env, { OPENAI_API_KEY: 'ollama-local', OPENAI_BASE_URL: `${ollamaUrl}/v1`, OPENAI_MODEL: engine.model ?? '' });
  }
  return env;
}

export interface LaunchSpec {
  cmd: string;
  args: string[];
  /** Which hook endpoint reports its status; 'none' means the UI shows "status unknown". */
  hooks: 'claude' | 'qwen' | 'none';
}

/**
 * The command line for a non-Claude engine (Claude keeps the office's configured agent command, unchanged).
 * - Qwen Code: `--model` (auth docs above); `-i/--prompt-interactive` runs the first prompt and stays interactive
 *   (inherited from Gemini CLI, which Qwen Code forks — verify on upgrade).
 * - Codex: `--oss` uses a local provider; `oss_provider="ollama"` avoids the interactive provider prompt
 *   (https://learn.chatgpt.com/docs/config-file/config-reference, `oss_provider`); `-m` picks the model.
 */
export function launchSpec(engine: WorkerEngine, prompt: string | undefined): LaunchSpec {
  // One argv element, `--prompt-interactive=<prompt>`: Qwen Code parses its CLI with yargs (inherited from Gemini CLI's
  // packages/cli/src/config/config.ts), and yargs takes everything after `=` as the value, so a prompt such as `--yolo`
  // or `--approval-mode=yolo` can never become an option (https://github.com/yargs/yargs-parser#readme).
  if (engine.id === 'qwen-code') return { cmd: 'qwen', args: ['--model', engine.model ?? '', ...(prompt ? [`--prompt-interactive=${prompt}`] : [])], hooks: 'qwen' };
  if (engine.id === 'codex') {
    const local = engine.auth === 'local' ? ['--oss', '-c', 'oss_provider="ollama"', '-m', engine.model ?? ''] : [];
    return { cmd: 'codex', args: [...local, ...(prompt ? ['--', prompt] : [])], hooks: 'none' };
  }
  return { cmd: 'claude', args: [], hooks: 'claude' };
}

// ---- CLI output parsers (output only; never credential files) ----------------------------------------------------

const WEEK = 7 * 24 * 3600 * 1000;

function expiry(at: string | undefined, now: number): Pick<CliAccount, 'expiresAt' | 'expired' | 'expiringSoon'> {
  if (!at) return {};
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return {};
  return { expiresAt: new Date(t).toISOString(), expired: t <= now, expiringSoon: t > now && t - now < WEEK };
}

/**
 * `claude auth status` prints JSON (`{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max", ...}`)
 * in current versions, and text in others. Both are accepted; emails and org names are deliberately dropped.
 */
export function parseClaudeAuthStatus(stdout: string, exitCode: number, now = Date.now()): CliAccount {
  const text = stdout.trim();
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      const j = JSON.parse(text.slice(start));
      const exp = expiry(typeof j.expiresAt === 'string' ? j.expiresAt : typeof j.expires_at === 'string' ? j.expires_at : undefined, now);
      const loggedIn = typeof j.loggedIn === 'boolean' ? j.loggedIn && !exp.expired : null;
      const method = typeof j.authMethod === 'string' ? j.authMethod.slice(0, 40) : undefined;
      const plan = typeof j.subscriptionType === 'string' ? j.subscriptionType.slice(0, 40) : undefined;
      return { installed: true, loggedIn, method, plan, ...exp, detail: describe(loggedIn, method, plan, exp) };
    } catch { /* fall through to text */ }
  }
  const expiredText = /\bexpired\b/i.test(text);
  const out = /not (logged|signed) in|logged out|please run \/login|no credentials/i.test(text);
  const inn = /\b(logged|signed) in\b/i.test(text);
  const atMatch = /expir\w*\s*(?:on|at)?:?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[^\s,;]*)/i.exec(text);
  const exp = expiredText ? { expired: true } : expiry(atMatch?.[1], now);
  const loggedIn = exp.expired ? false : out ? false : inn ? true : exitCode !== 0 ? false : null;
  const method = /claude\.ai|subscription/i.test(text) ? 'claude.ai' : /api key/i.test(text) ? 'API key' : undefined;
  return { installed: true, loggedIn, method, ...exp, detail: describe(loggedIn, method, undefined, exp) };
}

function describe(loggedIn: boolean | null, method: string | undefined, plan: string | undefined, exp: Pick<CliAccount, 'expired' | 'expiringSoon' | 'expiresAt'>): string {
  if (exp.expired) return 'Your sign-in has expired. Sign in again with /login inside Claude Code.';
  if (loggedIn === null) return 'Sign-in state unknown: the CLI output was not recognised.';
  if (!loggedIn) return 'Not signed in on this computer.';
  const via = method && /api|key|helper/i.test(method) ? ` via ${method} — subscription workers scrub API keys, so check this is your subscription` : method ? ` via ${method}` : '';
  return `Signed in${via}${plan ? ` (${plan})` : ''}.${exp.expiringSoon ? ` Expires ${exp.expiresAt?.slice(0, 10)}: sign in again soon.` : ''}`;
}

/** `codex login status`: "Logged in using ChatGPT", "Logged in using an API key - sk-…", or "Not logged in". */
export function parseCodexLoginStatus(output: string, exitCode: number): CliAccount {
  const text = output.trim();
  if (/not logged in/i.test(text)) return { installed: true, loggedIn: false, detail: 'Not signed in. Run `codex login` yourself in a terminal.' };
  if (/logged in/i.test(text)) {
    // Never echo what follows (an API key prefix is printed there).
    const method = /chatgpt/i.test(text) ? 'ChatGPT' : /api key/i.test(text) ? 'API key' : undefined;
    return { installed: true, loggedIn: true, method, detail: `Signed in${method ? ` with ${method}` : ''}.` };
  }
  return { installed: true, loggedIn: exitCode === 0 ? null : false, detail: 'Sign-in state unknown: the CLI output was not recognised.' };
}

// ---- Linked accounts --------------------------------------------------------------------------------------------

export type Exec = (cmd: string, args: string[], env: Record<string, string>) => Promise<{ stdout: string; stderr: string; code: number }>;

const defaultExec: Exec = (cmd, args, env) => new Promise((resolve) => {
  execFile(cmd, args, { env, timeout: 8000, maxBuffer: 256 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
    resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
  });
});

export interface AccountsOptions {
  dataDir: string;
  ollama: OllamaRuntime;
  keys: () => ProviderKeys;
  /** PATH lookup for a CLI; tests pass a resolver over a temp directory of fake scripts. */
  resolve: (cmd: string) => string | null;
  exec?: Exec;
  env?: () => Record<string, string>;
  totalMem?: () => number;
  now?: () => number;
}

const CACHE_MS = 15_000;
const REFRESH_FLOOR_MS = 10_000;

export class LinkedAccounts {
  private cache?: { at: number; state: EnginesState };
  private inflight?: Promise<EnginesState>;
  private file: string;
  private preference: 'auto' | WorkerEngine = 'auto';

  constructor(private o: AccountsOptions) {
    this.file = path.join(o.dataDir, 'engines.json');
    try {
      if (existsSync(this.file)) {
        const saved = JSON.parse(readFileSync(this.file, 'utf8'));
        this.preference = saved?.defaultEngine === 'auto' ? 'auto' : sanitizeEngine(saved?.defaultEngine) ?? 'auto';
      }
    } catch { this.preference = 'auto'; }
  }

  get defaultEngine() { return this.preference; }

  setDefault(v: unknown): 'auto' | WorkerEngine {
    const next = v === 'auto' ? 'auto' : sanitizeEngine(v);
    if (!next) throw new Error('Unknown engine.');
    writeJsonAtomic(this.file, { defaultEngine: next });
    this.preference = next;
    if (this.cache) this.cache = { ...this.cache, state: this.finish(this.cache.state) };
    return next;
  }

  /** What a spawn without an explicit engine uses: the saved default when it names one, else the legacy Claude path. */
  spawnDefault(): WorkerEngine {
    return this.preference === 'auto' ? LEGACY_ENGINE : this.preference;
  }

  cached(): EnginesState | undefined { return this.cache?.state; }

  async state(refresh = false): Promise<EnginesState> {
    const now = (this.o.now ?? Date.now)();
    // "Check again" (refresh=1) runs the CLIs at most once per REFRESH_FLOOR_MS; faster requests get the last probe.
    if (this.cache && now - this.cache.at < (refresh ? REFRESH_FLOOR_MS : CACHE_MS)) {
      return { ...this.cache.state, ollama: { ...this.cache.state.ollama, pull: this.o.ollama.pull } };
    }
    this.inflight ??= this.probe().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async probe(): Promise<EnginesState> {
    const now = (this.o.now ?? Date.now)();
    const exec = this.o.exec ?? defaultExec;
    const base = this.o.env?.() ?? (Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>);
    // The probes see exactly what a subscription worker would: no provider keys.
    const clean = engineEnv(base, LEGACY_ENGINE, {}, '');
    const claudePath = this.o.resolve('claude');
    const codexPath = this.o.resolve('codex');
    const qwenPath = this.o.resolve('qwen');
    const [claude, codex, ollama] = await Promise.all([
      claudePath ? exec(claudePath, ['auth', 'status'], clean).then((r) => parseClaudeAuthStatus(r.stdout || r.stderr, r.code, now)) : Promise.resolve<CliAccount>({ installed: false, loggedIn: null, detail: 'Claude Code is not installed on this computer.' }),
      codexPath ? exec(codexPath, ['login', 'status'], clean).then((r) => parseCodexLoginStatus(`${r.stdout}\n${r.stderr}`, r.code)) : Promise.resolve<CliAccount>({ installed: false, loggedIn: null, detail: 'Optional: Codex CLI is not installed.' }),
      this.o.ollama.detect(),
    ]);
    const keys = this.o.keys();
    const rec = recommendModels((this.o.totalMem ?? totalmem)());
    const state: EnginesState = {
      claude, codex, ollama,
      qwen: { installed: !!qwenPath, detail: qwenPath ? 'Qwen Code is installed.' : 'Not installed. Free: npm install -g @qwen-code/qwen-code' },
      ram: { totalGb: rec.ramGb, note: rec.note, models: rec.models },
      keys: KEY_NAMES.map((name) => ({ name, present: !!keys[name] })),
      hosted: HOSTED_FREE,
      defaultEngine: this.preference,
      options: [], recommended: null, help: [], checkedAt: now,
    };
    const done = this.finish(state);
    this.cache = { at: now, state: done };
    return done;
  }

  private finish(s: EnginesState): EnginesState {
    const options = engineOptions(s);
    const { engine, help } = pickEngine(options, this.preference);
    return { ...s, defaultEngine: this.preference, options, recommended: engine, help };
  }
}

/** Provider keys from the office's environment (server/CLI mode). The desktop passes its sealed vault instead. */
export function envKeys(env: NodeJS.ProcessEnv = process.env): ProviderKeys {
  const out: ProviderKeys = {};
  for (const k of KEY_NAMES) if (env[k]) out[k] = env[k];
  return out;
}
