/**
 * "Create my Empire" for cloud mode: the Empire's state lives in a private repository in the player's own GitHub
 * (docs/team/CLOUD_MODE_PLAN.md). Four steps, each a real api.github.com call through GitHubClient:
 *
 *   1. createStateRepo    private <login>/agent-empire-state (reused only if it already exists and is private)
 *   2. uploadSecret       provider API keys as encrypted Actions secrets (libsodium sealed box, sealed-box.ts)
 *   3. installWorkflow    the always-on coordinator workflow (owned by CLOUD-02)
 *   4. writeInitialState  a setup *intent* (clients write intents; only the coordinator writes state)
 *
 * Readiness is checked before any network call, so a build that lacks a piece creates nothing at all.
 * Provider keys leave the page only inside a sealed box addressed to the repository's Actions public key.
 */
import { GitHubClient, GitHubError, type RepoListing } from './github';
import { linkedProviders, parseCents, STATE_REPO_NAME, type Limits, type ProviderId, type RepoRef } from './model';
import { sealForGitHub } from './sealed-box';

export const SECRET_NAMES: Record<ProviderId, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
export const SETUP_INTENT_PATH = 'intents/setup.json';

export interface StateRepo {
  owner: string;
  name: string;
  created: boolean;
}

/** Seals a secret value for a repository's Actions public key. */
export interface Sealer {
  readonly available: boolean;
  readonly reason?: string;
  seal(publicKeyBase64: string, value: string): string;
}
export const sodiumSealer: Sealer = { available: true, seal: sealForGitHub };

/** The coordinator workflow committed to the state repository. Its content is owned by CLOUD-02. */
export interface WorkflowSource {
  readonly available: boolean;
  readonly reason?: string;
  readonly path: string;
  readonly content: string;
}
export const pendingWorkflow: WorkflowSource = {
  available: false,
  reason: 'The always-on coordinator (the GitHub Actions workflow) isn’t in this build yet.',
  path: '.github/workflows/agent-empire.yml',
  content: '',
};

export interface CloudPlan {
  login: string;
  projects: RepoRef[];
  providers: Record<ProviderId, string>;
  limits: Limits;
  platform: string;
}

export type CreateStep = 'repo' | 'secrets' | 'workflow' | 'state';
export const CREATE_STEPS: { step: CreateStep; label: string }[] = [
  { step: 'repo', label: 'Create your private state repository' },
  { step: 'secrets', label: 'Encrypt and store your API keys' },
  { step: 'workflow', label: 'Install the always-on coordinator' },
  { step: 'state', label: 'Record your setup' },
];

export class CloudSetupError extends Error {
  constructor(message: string, readonly code: 'not_ready' | 'repo_conflict' | 'github' | 'invalid', readonly step?: CreateStep, readonly reasons: string[] = []) {
    super(message);
    this.name = 'CloudSetupError';
  }
}

/** The four operations, as an interface so a fake can stand in during tests. */
export interface CloudSetup {
  createStateRepo(login: string): Promise<StateRepo>;
  uploadSecret(repo: StateRepo, name: string, value: string): Promise<void>;
  installWorkflow(repo: StateRepo): Promise<void>;
  writeInitialState(repo: StateRepo, plan: CloudPlan): Promise<void>;
}

/** What stops creation in this build (empty when everything is in place). */
export function readiness(sealer: Sealer, workflow: WorkflowSource): string[] {
  const reasons: string[] = [];
  if (!sealer.available) reasons.push(sealer.reason ?? 'The encryption library is not available.');
  if (!workflow.available || !workflow.content) reasons.push(workflow.reason ?? 'The coordinator workflow is not available.');
  return reasons;
}

/** The setup intent the coordinator applies on its first run. Names and limits only, never a key. */
export function setupIntent(plan: CloudPlan, now: Date): Record<string, unknown> {
  return {
    schemaVersion: 1,
    type: 'setup',
    createdAt: now.toISOString(),
    createdBy: { login: plan.login, platform: plan.platform },
    projects: plan.projects.map((r) => ({ owner: r.owner, name: r.name, defaultBranch: r.defaultBranch })),
    providers: linkedProviders(plan.providers),
    limits: {
      maxConcurrentJobs: plan.limits.maxConcurrent,
      perJobCents: parseCents(plan.limits.perJob),
      dailyCents: parseCents(plan.limits.daily),
      approveEachJob: plan.limits.approveEachJob,
    },
    changes: 'branches-and-pull-requests-only',
  };
}

export function githubCloudSetup(gh: GitHubClient, sealer: Sealer, workflow: WorkflowSource, now: () => Date = () => new Date()): CloudSetup {
  return {
    async createStateRepo(login) {
      const created = await gh.createPrivateRepo(STATE_REPO_NAME, 'Agent Empire state. Written by the Empire coordinator; keep this repository private.');
      if (created) return { owner: created.owner, name: created.name, created: true };
      // The name is taken: reuse it only when it is this account's own private repository (a resumed setup).
      const existing: RepoListing | null = await gh.getRepo(login, STATE_REPO_NAME);
      if (existing && existing.private && existing.owner.toLowerCase() === login.toLowerCase()) return { owner: existing.owner, name: existing.name, created: false };
      throw new CloudSetupError(
        existing && !existing.private
          ? `${login}/${STATE_REPO_NAME} already exists and is public. Make it private or rename it on GitHub, then try again.`
          : `A repository named ${login}/${STATE_REPO_NAME} already exists and can’t be used. Rename it on GitHub, then try again.`,
        'repo_conflict',
        'repo',
      );
    },
    async uploadSecret(repo, name, value) {
      if (!Object.values(SECRET_NAMES).includes(name)) throw new CloudSetupError('Unknown secret.', 'invalid', 'secrets');
      if (!sealer.available) throw new CloudSetupError(sealer.reason ?? 'Encryption unavailable.', 'not_ready', 'secrets');
      const { keyId, key } = await gh.actionsPublicKey(repo.owner, repo.name);
      await gh.putSecret(repo.owner, repo.name, name, sealer.seal(key, value.trim()), keyId);
    },
    async installWorkflow(repo) {
      if (!workflow.available || !workflow.content) throw new CloudSetupError(workflow.reason ?? 'Workflow unavailable.', 'not_ready', 'workflow');
      await gh.putFile(repo.owner, repo.name, workflow.path, workflow.content, 'Install the Agent Empire coordinator');
    },
    async writeInitialState(repo, plan) {
      await gh.putFile(repo.owner, repo.name, SETUP_INTENT_PATH, `${JSON.stringify(setupIntent(plan, now()), null, 2)}\n`, 'Agent Empire setup');
    },
  };
}

/**
 * Runs the four steps in order, reporting progress. On any failure it stops and says which step failed; steps
 * already done stay done, and running again resumes (the repository is reused, secrets and files are replaced).
 */
export async function createEmpire(
  plan: CloudPlan,
  setup: CloudSetup,
  ready: string[],
  onStep: (step: CreateStep, state: 'running' | 'done') => void = () => {},
): Promise<StateRepo> {
  if (ready.length) throw new CloudSetupError('This build can’t create your Empire yet. Nothing was created in your GitHub.', 'not_ready', undefined, ready);
  const providers = linkedProviders(plan.providers);
  if (!providers.length) throw new CloudSetupError('Add at least one API key.', 'invalid', 'secrets');
  if (!plan.projects.length) throw new CloudSetupError('Choose at least one project repository.', 'invalid', 'repo');
  let step: CreateStep = 'repo';
  try {
    onStep(step, 'running');
    const repo = await setup.createStateRepo(plan.login);
    onStep(step, 'done');
    step = 'secrets';
    onStep(step, 'running');
    for (const id of providers) await setup.uploadSecret(repo, SECRET_NAMES[id], plan.providers[id]);
    onStep(step, 'done');
    step = 'workflow';
    onStep(step, 'running');
    await setup.installWorkflow(repo);
    onStep(step, 'done');
    step = 'state';
    onStep(step, 'running');
    await setup.writeInitialState(repo, plan);
    onStep(step, 'done');
    return repo;
  } catch (err) {
    if (err instanceof CloudSetupError) throw err.step ? err : new CloudSetupError(err.message, err.code, step, err.reasons);
    const message = err instanceof GitHubError ? err.message : 'Something went wrong while setting up your Empire.';
    throw new CloudSetupError(message, 'github', step);
  }
}
