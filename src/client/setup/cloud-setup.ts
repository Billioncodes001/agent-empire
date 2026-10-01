/**
 * "Create my Empire" for cloud mode (CLOUD-02 wiring). The Empire's state lives in a private repository in the
 * player's own GitHub (docs/team/CLOUD_MODE_PLAN.md). This runs the coordinator's installer (src/cloud/installer.ts)
 * against api.github.com with the player's token:
 *
 *   repo      use or create the private <login>/agent-empire-state
 *   secrets   provider keys and the project token as sealed-box encrypted Actions secrets (sealed-box.ts)
 *   state     the coordinator bundle (shipped with this build) and the initial state, never overwriting an Empire
 *   workflow  the always-on coordinator workflow, committed last
 *   verify    read back and parse with the coordinator's own rules
 *
 * Every step checks what is already there, so "Try again" after a failure continues where it stopped. Nothing paid
 * starts: no job is queued and no run is triggered. The bundle is loaded and checked before the first GitHub call.
 */
import { GitHubClient as CloudGitHubClient } from '../../cloud/store';
import { INSTALL_STEPS, InstallError, installStateRepository, type InstallStep, type SecretName, type StepStatus } from '../../cloud/installer';
import type { CloudLimits } from '../../cloud/schema';
import { linkedProviders, parseCents, STATE_REPO_NAME, type Interval, type Limits, type ProviderId, type RepoRef } from './model';
import { sealForGitHub } from './sealed-box';

export const SECRET_NAMES: Record<ProviderId, SecretName> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
/** Where the client build ships the coordinator (tools/ship-coordinator.mjs) and its integrity manifest. */
export const COORDINATOR_URL = 'cloud/agent-empire-coordinator.mjs';
export const COORDINATOR_MANIFEST_URL = 'cloud/coordinator.json';

export interface StateRepo {
  owner: string;
  name: string;
  created: boolean;
  /** The repository already held an Empire, which was kept as it is. */
  alreadyInstalled?: boolean;
}

export interface CloudPlan {
  login: string;
  projects: RepoRef[];
  providers: Record<ProviderId, string>;
  projectToken?: string;
  limits: Limits;
  interval: Interval;
  platform: string;
}

export type CreateStep = InstallStep;
export const CREATE_STEPS = INSTALL_STEPS;

export class CloudSetupError extends Error {
  constructor(message: string, readonly code: 'not_ready' | 'repo_conflict' | 'github' | 'invalid', readonly step?: CreateStep, readonly reasons: string[] = []) {
    super(message);
    this.name = 'CloudSetupError';
  }
}

/** Plan limits in the coordinator's units. */
export function planLimits(l: Limits): CloudLimits {
  const per = parseCents(l.perJob);
  const day = parseCents(l.daily);
  if (per === null || day === null) throw new CloudSetupError('The spending limits are invalid.', 'invalid', 'state');
  return { maxConcurrent: l.maxConcurrent, perTaskBudgetCents: per, dailyBudgetCents: day };
}

/** Secrets to upload: only what the player gave. Values exist only in memory until they are sealed. */
export function planSecrets(plan: CloudPlan): Partial<Record<SecretName, string>> {
  const out: Partial<Record<SecretName, string>> = {};
  for (const id of linkedProviders(plan.providers)) out[SECRET_NAMES[id]] = plan.providers[id].trim();
  if (plan.projectToken?.trim()) out.PROJECT_GITHUB_TOKEN = plan.projectToken.trim();
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Loads the coordinator bundle shipped with this build and checks it against its manifest, so an HTML fallback page or
 * a truncated download is never committed as the coordinator. Throws a not_ready CloudSetupError otherwise.
 */
export async function loadCoordinatorBundle(fetchImpl: typeof fetch = (...a) => fetch(...a), base = ''): Promise<string> {
  const fail = (why: string) => new CloudSetupError('This build can’t create your Empire: its coordinator is missing. Nothing was created in your GitHub.', 'not_ready', undefined, [why]);
  let manifest: { file?: unknown; bytes?: unknown; sha256?: unknown };
  let text: string;
  try {
    const m = await fetchImpl(`${base}${COORDINATOR_MANIFEST_URL}`, { cache: 'no-store' });
    if (!m.ok) throw fail(`The coordinator manifest could not be loaded (${m.status}).`);
    manifest = await m.json();
    const r = await fetchImpl(`${base}${COORDINATOR_URL}`, { cache: 'no-store' });
    if (!r.ok) throw fail(`The coordinator could not be loaded (${r.status}).`);
    text = await r.text();
  } catch (error) {
    if (error instanceof CloudSetupError) throw error;
    throw fail('The coordinator could not be loaded from this app.');
  }
  if (typeof manifest.sha256 !== 'string' || typeof manifest.bytes !== 'number') throw fail('The coordinator manifest is malformed.');
  if (new TextEncoder().encode(text).length !== manifest.bytes || (await sha256Hex(text)) !== manifest.sha256) throw fail('The coordinator file does not match its manifest.');
  return text;
}

const httpMessage = (status: number, message: string, step: CreateStep): string => {
  if (status === 0) return 'Can’t reach GitHub. Check your connection and try again.';
  if (status === 401) return 'GitHub didn’t accept this sign-in. It may have expired or been revoked; link GitHub again.';
  if ((status === 403 || status === 429) && /rate limit/i.test(message)) return 'GitHub’s rate limit was reached. Wait a few minutes and try again.';
  if (status === 403 || status === 404)
    return step === 'secrets'
      ? 'GitHub refused to store the secrets. The token needs Secrets read and write on agent-empire-state.'
      : step === 'workflow'
        ? 'GitHub refused to install the workflow. The token needs Workflows read and write on agent-empire-state.'
        : 'GitHub refused this step. The token needs Contents, Secrets, Workflows and Actions read and write on agent-empire-state.';
  if (status >= 500) return 'GitHub is having trouble. Try again shortly.';
  return `GitHub answered with an error (${status}). Try again.`;
};

export interface CreateDeps {
  fetch?: typeof fetch;
  /** The coordinator bundle; defaults to the copy shipped with this build. */
  bundle?: () => Promise<string>;
  seal?: (publicKeyBase64: string, value: string) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  apiBase?: string;
}

/**
 * Runs the installer, reporting progress. On a failure it says which step failed and why; steps already done stay
 * done, and running it again resumes (the repository is reused, existing state kept, unchanged files skipped).
 */
export async function createEmpire(plan: CloudPlan, token: string, deps: CreateDeps = {}, onStep: (step: CreateStep, state: StepStatus | 'failed', detail?: string) => void = () => {}): Promise<StateRepo> {
  if (!linkedProviders(plan.providers).length) throw new CloudSetupError('Add at least one API key.', 'invalid', 'secrets');
  if (!plan.projects.length) throw new CloudSetupError('Choose at least one project repository.', 'invalid', 'repo');
  const limits = planLimits(plan.limits);
  // Before any GitHub call: a build without its coordinator creates nothing at all.
  const bundle = await (deps.bundle ?? (() => loadCoordinatorBundle(deps.fetch)))();
  const seal = deps.seal ?? sealForGitHub;
  const client = new CloudGitHubClient(token, { browser: true, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.apiBase ? { apiBase: deps.apiBase } : {}), timeoutMs: 30_000 });
  try {
    const result = await installStateRepository(
      client,
      {
        repo: STATE_REPO_NAME,
        secrets: planSecrets(plan),
        limits,
        coordinatorBundle: bundle,
        workflow: { intervalMinutes: plan.interval },
        now: (deps.now ?? Date.now)(),
        onStep,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      },
      async (key, value) => seal(key, value),
    );
    return { owner: result.owner, name: result.repo, created: result.created, alreadyInstalled: result.alreadyInstalled };
  } catch (error) {
    if (error instanceof InstallError) {
      const ours = !['github_http', 'github_unreachable', 'github_timeout', 'github_response_large'].includes(error.code);
      const code = ['state_repository_public', 'repo_conflict', 'repo_create_forbidden', 'state_invalid'].includes(error.code) ? 'repo_conflict' : ['invalid', 'bundle_invalid', 'secret_name_invalid', 'project_token_not_fine_grained'].includes(error.code) ? 'invalid' : 'github';
      throw new CloudSetupError(ours ? error.message : httpMessage(error.status, error.message, error.step), code, error.step);
    }
    throw new CloudSetupError('Something went wrong while setting up your Empire. Try again.', 'github');
  }
}
