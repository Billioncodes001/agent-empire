/**
 * FREE-04: GitHub Actions as the job sandbox. Browser-safe (no server or Node imports), so the setup UI, the state
 * schema, the workflow generator and the coordinator adapter share one definition of engines, pins and limits.
 *
 * Claude subscription compliance (docs/team/FREE_PLAN.md rule 3, FREE_STACK.md §9b): the Empire never asks for, reads,
 * stores or relays a Claude OAuth token. The user runs `claude setup-token` and `gh secret set` in their own terminal;
 * the Empire checks only that the secret NAME exists in the project repository.
 */

/** Which engine a job runs with inside the Actions job. */
export const CLOUD_ENGINES = ['qwen-free', 'claude-subscription', 'claude-api-key'] as const;
export type CloudEngine = (typeof CLOUD_ENGINES)[number];
export const isCloudEngine = (value: unknown): value is CloudEngine => CLOUD_ENGINES.includes(value as CloudEngine);
/** Free engines cost US$0 in the Empire's ledger; a subscription run is billed to the user's Claude plan, not in USD. */
export const isMoneyEngine = (engine: CloudEngine) => engine === 'claude-api-key';

/** Where the free engine's model comes from, in order of preference. */
export const MODEL_SOURCES = ['self_hosted_ollama', 'hosted_free_key', 'cpu_small'] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

export const JOB_WORKFLOW_FILE = 'agent-empire-job.yml';
export const JOB_WORKFLOW_PATH = `.github/workflows/${JOB_WORKFLOW_FILE}`;
export const RESULT_ARTIFACT = 'agent-empire-result';
export const RESULT_FILE = 'result.json';
/** Hard caps on what the coordinator downloads and parses from a run. */
export const RESULT_MAX_BYTES = 4096;
export const ARTIFACT_MAX_BYTES = 16_384;
/**
 * workflow_dispatch inputs are limited to 65,535 characters in total. The task travels base64-encoded (never
 * interpolated into YAML or shell), so the encoded form must stay under this, leaving room for the other inputs.
 */
export const MAX_TASK_B64 = 60_000;

/** Secret names the job reads. Values are set by the user in their own terminal (or sealed, for API keys). */
export const SECRETS = {
  claudeOAuth: 'CLAUDE_CODE_OAUTH_TOKEN',
  anthropicKey: 'ANTHROPIC_API_KEY',
  freeKey: 'FREE_LLM_API_KEY',
} as const;
export type JobSecretName = (typeof SECRETS)[keyof typeof SECRETS];

/** The secret a configuration needs in the project repository, or null when none is needed. */
export function requiredSecret(settings: Pick<ActionsSettings, 'engine' | 'modelSource'>): JobSecretName | null {
  if (settings.engine === 'claude-subscription') return SECRETS.claudeOAuth;
  if (settings.engine === 'claude-api-key') return SECRETS.anthropicKey;
  return settings.modelSource === 'hosted_free_key' ? SECRETS.freeKey : null;
}

/**
 * Pinned third-party code. Every SHA and digest below was read with read-only `gh api` / `npm view` on 2026-10-24 and
 * is at least two weeks old except where noted. Update deliberately, never to a moving tag.
 */
export const JOB_PINS = {
  /** anthropics/claude-code-action tag v1.0.245 (2026-10-07). `gh api repos/anthropics/claude-code-action/commits/v1.0.245`. */
  claudeCodeAction: { repo: 'anthropics/claude-code-action', sha: '6fed3ca145920b639991cb756090506e1bcaf515', version: 'v1.0.245' },
  /** actions/upload-artifact tag v7.0.2 (2026-10-07). */
  uploadArtifact: { repo: 'actions/upload-artifact', sha: 'cf430e030ddbb5b0abf93d22962f4752f3646cd9', version: 'v7.0.2' },
  /** actions/download-artifact tag v8.0.2 (2026-10-07). Used only by the publish job. */
  downloadArtifact: { repo: 'actions/download-artifact', sha: '9000827ccba6bdab643e8b6fd33ac0654aef8333', version: 'v8.0.2' },
  /** @qwen-code/qwen-code 0.25.0 (2026-10-05), Apache-2.0, no runtime dependencies; npm `dist.integrity`. */
  qwen: { version: '0.25.0', integrity: 'sha512-XlqtxN7UKEkXLpuKioorDTBoIR/rWMdNHMtO/aPuQb7HDsTswMPqkEMYsVY56wuF3xSaI9PKgh9Q2NU/CSTkAQ==' },
  /** ollama v0.40.10 linux amd64 release asset and its GitHub-reported sha256 (1.5 GB download). */
  ollama: {
    version: 'v0.40.10', asset: 'ollama-linux-amd64.tar.zst', bytes: 1_509_264_197,
    sha256: '1e8ad2d2a394efdd235bee74deec237badd95142ffba77588140ab2a9ecec227',
  },
} as const;

/** The small CPU model for trivial tasks on a GitHub-hosted runner. Shown with its size and licence before opt-in. */
/**
 * `digest`: sha256 of the registry manifest (registry.ollama.ai, read 2026-10-24). The job compares it with the digest
 * Ollama reports after the pull and stops on a mismatch. UNVERIFIED until a real run that both use the same bytes.
 */
export const CPU_MODEL = { name: 'qwen2.5-coder:1.5b', approxBytes: 986_000_000, licence: 'Apache-2.0', digest: 'd7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668' } as const;
/** Hard cap on the change one job may publish (the `git diff --binary` patch). */
export const PATCH_MAX_BYTES = 5_000_000;
export const CHANGE_ARTIFACT = 'agent-empire-change';

/** Run caps: the free engines' budget is wall time and turns, never money. */
export const RUN_CAPS = { turns: { min: 1, max: 200, default: 30 }, minutes: { min: 5, max: 360, default: 60 } } as const;

export interface ActionsSettings {
  engine: CloudEngine;
  /** Required for `qwen-free`; absent otherwise. */
  modelSource?: ModelSource;
  /** Self-hosted runner label (with Ollama on 127.0.0.1:11434). Only with `self_hosted_ollama`. */
  runnerLabel?: string;
  /** Model name for Ollama or the hosted endpoint. Fixed to CPU_MODEL for `cpu_small`. */
  model?: string;
  /** OpenAI-compatible endpoint of the user-opted free hosted tier. Only with `hosted_free_key`. */
  hostedBaseUrl?: string;
  maxTurns: number;
  timeoutMinutes: number;
  /** Open a draft pull request for the task branch (adds `pull-requests: write`). */
  openPullRequest: boolean;
}

export class ActionsSettingsError extends Error {
  constructor(message: string) { super(message); this.name = 'ActionsSettingsError'; }
}
/** Values interpolated into YAML must match these, so no generated line can carry an expression or a shell token. */
export const RUNNER_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
export const HOSTED_URL = /^https:\/\/[a-z0-9]([a-z0-9-]{0,62}\.)+[a-z]{2,24}(:\d{2,5})?(\/[A-Za-z0-9._~-]+){0,6}\/?$/;
const SETTINGS_KEYS = ['engine', 'modelSource', 'runnerLabel', 'model', 'hostedBaseUrl', 'maxTurns', 'timeoutMinutes', 'openPullRequest'];

const intIn = (value: unknown, min: number, max: number, what: string) => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new ActionsSettingsError(`${what} must be a whole number from ${min} to ${max}.`);
  return value as number;
};

/** Validates and normalises settings; throws ActionsSettingsError with a user-safe message. */
export function validateActionsSettings(value: unknown): ActionsSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ActionsSettingsError('Actions settings are missing.');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!SETTINGS_KEYS.includes(key)) throw new ActionsSettingsError(`Unexpected setting ${key.slice(0, 40)}.`);
  if (!isCloudEngine(v.engine)) throw new ActionsSettingsError('Unknown cloud engine.');
  if (typeof v.openPullRequest !== 'boolean') throw new ActionsSettingsError('Choose whether to open a pull request.');
  const out: ActionsSettings = {
    engine: v.engine,
    maxTurns: intIn(v.maxTurns, RUN_CAPS.turns.min, RUN_CAPS.turns.max, 'The turn cap'),
    timeoutMinutes: intIn(v.timeoutMinutes, RUN_CAPS.minutes.min, RUN_CAPS.minutes.max, 'The time cap (minutes)'),
    openPullRequest: v.openPullRequest,
  };
  if (v.engine !== 'qwen-free') {
    if (v.modelSource !== undefined || v.runnerLabel !== undefined || v.model !== undefined || v.hostedBaseUrl !== undefined) throw new ActionsSettingsError('Model settings apply only to the free engine.');
    return out;
  }
  if (!MODEL_SOURCES.includes(v.modelSource as ModelSource)) throw new ActionsSettingsError('Choose where the free model runs.');
  out.modelSource = v.modelSource as ModelSource;
  if (out.modelSource === 'cpu_small') {
    if (v.runnerLabel !== undefined || v.hostedBaseUrl !== undefined || (v.model !== undefined && v.model !== CPU_MODEL.name)) throw new ActionsSettingsError('The CPU model is fixed.');
    out.model = CPU_MODEL.name;
    return out;
  }
  if (typeof v.model !== 'string' || !MODEL_NAME.test(v.model)) throw new ActionsSettingsError('Enter a model name (letters, digits, . _ : / -).');
  out.model = v.model;
  if (out.modelSource === 'self_hosted_ollama') {
    if (v.hostedBaseUrl !== undefined) throw new ActionsSettingsError('A self-hosted runner uses its own Ollama.');
    if (typeof v.runnerLabel !== 'string' || !RUNNER_LABEL.test(v.runnerLabel) || v.runnerLabel === 'self-hosted') throw new ActionsSettingsError('Enter your self-hosted runner’s label (letters, digits, . _ -).');
    out.runnerLabel = v.runnerLabel;
  } else {
    if (v.runnerLabel !== undefined) throw new ActionsSettingsError('A hosted key runs on a GitHub-hosted runner.');
    if (typeof v.hostedBaseUrl !== 'string' || !HOSTED_URL.test(v.hostedBaseUrl)) throw new ActionsSettingsError('Enter the provider’s https:// API address (no keys or query strings).');
    out.hostedBaseUrl = v.hostedBaseUrl;
  }
  return out;
}

/**
 * The free model source, in the plan's order: the owner's self-hosted runner, then a user-opted free hosted key, then
 * the small CPU model. Null when the user enabled none of them.
 */
export function chooseModelSource(options: { selfHostedLabel?: string; hostedKeyOptIn?: boolean; cpuOptIn?: boolean }): ModelSource | null {
  if (options.selfHostedLabel && RUNNER_LABEL.test(options.selfHostedLabel)) return 'self_hosted_ollama';
  if (options.hostedKeyOptIn) return 'hosted_free_key';
  if (options.cpuOptIn) return 'cpu_small';
  return null;
}

/** Honest worker label (rule 4), e.g. "Qwen Code · qwen2.5-coder:1.5b (CPU, slow)". */
export function engineLabel(settings: Pick<ActionsSettings, 'engine' | 'modelSource' | 'model'>): string {
  if (settings.engine === 'claude-subscription') return 'Claude Code · your Claude account';
  if (settings.engine === 'claude-api-key') return 'Claude Code · your Anthropic API key';
  const where = settings.modelSource === 'self_hosted_ollama' ? 'your runner' : settings.modelSource === 'hosted_free_key' ? 'free hosted tier' : 'CPU, slow';
  return `Qwen Code · ${settings.model ?? CPU_MODEL.name} (${where})`;
}

/** How a run is paid for, in words the UI can show next to a job. Never a USD figure for subscription runs. */
export function billingNote(engine: CloudEngine): string {
  if (engine === 'qwen-free') return 'free run (US$0; uses GitHub Actions minutes)';
  if (engine === 'claude-subscription') return 'billed to your Claude plan (no US$ figure)';
  return 'Anthropic API usage, estimated by Claude Code';
}

/** The result a job uploads as its artifact. Ids, statuses and numbers only: no model text. */
export interface RunResult {
  schemaVersion: 1;
  jobId: string;
  engine: CloudEngine;
  status: 'changes_pushed' | 'no_changes' | 'push_failed' | 'engine_failed';
  headSha?: string;
  pullRequest?: number;
  /** Claude Code's own `total_cost_usd` for API-key runs (an estimate); absent otherwise. */
  costUsdEstimate?: number;
}
const RESULT_STATUSES: RunResult['status'][] = ['changes_pushed', 'no_changes', 'push_failed', 'engine_failed'];

export class RunResultError extends Error {
  constructor(message: string) { super(message); this.name = 'RunResultError'; }
}
/** Strict schema check; anything unexpected is refused rather than guessed. */
export function parseRunResult(text: string, expected: { jobId: string; engine: CloudEngine }): RunResult {
  if (new TextEncoder().encode(text).length > RESULT_MAX_BYTES) throw new RunResultError('The result file is too large.');
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new RunResultError('The result file is not JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RunResultError('The result file is not an object.');
  const r = data as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!['schemaVersion', 'jobId', 'engine', 'status', 'headSha', 'pullRequest', 'costUsdEstimate'].includes(key)) throw new RunResultError('The result file has unexpected fields.');
  if (r.schemaVersion !== 1) throw new RunResultError('Unsupported result schema.');
  if (r.jobId !== expected.jobId) throw new RunResultError('The result belongs to a different job.');
  if (r.engine !== expected.engine) throw new RunResultError('The result names a different engine.');
  if (!RESULT_STATUSES.includes(r.status as RunResult['status'])) throw new RunResultError('Unknown result status.');
  const out: RunResult = { schemaVersion: 1, jobId: expected.jobId, engine: expected.engine, status: r.status as RunResult['status'] };
  if (r.headSha !== undefined) { if (typeof r.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(r.headSha)) throw new RunResultError('Invalid head commit.'); out.headSha = r.headSha; }
  if (r.pullRequest !== undefined) { if (!Number.isInteger(r.pullRequest) || (r.pullRequest as number) < 1 || (r.pullRequest as number) > 1e9) throw new RunResultError('Invalid pull request number.'); out.pullRequest = r.pullRequest as number; }
  if (r.costUsdEstimate !== undefined) {
    if (expected.engine !== 'claude-api-key') throw new RunResultError('Only API-key runs report a cost.');
    if (typeof r.costUsdEstimate !== 'number' || !Number.isFinite(r.costUsdEstimate) || r.costUsdEstimate < 0 || r.costUsdEstimate > 1000) throw new RunResultError('Invalid cost estimate.');
    out.costUsdEstimate = r.costUsdEstimate;
  }
  if (out.status === 'changes_pushed' && !out.headSha) throw new RunResultError('A pushed result needs its head commit.');
  return out;
}

/** `claude setup-token` tokens last a year; remind the user to rotate after 11 months. */
export const ROTATION_AFTER_MS = 335 * 24 * 60 * 60_000;
export function rotationStatus(secretUpdatedAt: string | undefined, now: number): { due: boolean; dueAt?: number } {
  const t = secretUpdatedAt ? Date.parse(secretUpdatedAt) : NaN;
  if (!Number.isFinite(t)) return { due: false };
  return { due: now >= t + ROTATION_AFTER_MS, dueAt: t + ROTATION_AFTER_MS };
}

/** Commands the user runs in their OWN terminal. The Empire shows them; it never runs them or sees their output. */
export function subscriptionChecklist(repo: { owner: string; name: string }): string[] {
  const full = `${repo.owner}/${repo.name}`;
  return [
    'claude setup-token',
    `gh secret set ${SECRETS.claudeOAuth} --repo ${full}`,
  ];
}
