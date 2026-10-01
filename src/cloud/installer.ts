/**
 * CLOUD-02 installer: makes the user's private state repository ready for the coordinator workflow.
 *
 * Steps, each reported through `onStep` so the setup screen can show progress:
 *   repo      use or create the private `<login>/agent-empire-state` (a repository the user created on GitHub,
 *             with or without an initial commit, is reused when it is theirs and private)
 *   secrets   upload the chosen provider keys / project token as encrypted Actions secrets
 *   state     commit the coordinator bundle and the initial state (an existing Empire is never overwritten)
 *   workflow  commit the workflow YAML, last, so no scheduled run can start before the state exists
 *   verify    read the repository back and parse the state with the coordinator's own rules
 *
 * Idempotent and resumable: every step checks what is already there, so running it again after a partial failure
 * continues where it stopped. Commits use the Git Data API with `force: false`; a concurrent writer is retried.
 *
 * SEAM: `encryptSecret` must implement a libsodium sealed box (crypto_box_seal) to the repository's public key. The
 * client passes its tweetnacl + blakejs implementation (src/client/setup/sealed-box.ts). This module never encrypts,
 * logs or stores secret values itself.
 *
 * Setup never starts paid work: the initial state has no jobs, nothing is dispatched, and the workflow has no push
 * trigger, so committing it does not start a run.
 */
import { initialCloudState, parseStateFiles, serializeState, STATE_FILES, validateExecution, validateLimits, type CloudExecution, type CloudLimits } from './schema.js';
import { decodeBase64Utf8, defaultSleep, encodeBase64Utf8, GitHubClient, GitHubError, GitHubStateStore, validateRepoRef, type FileChange } from './store.js';
import { COORDINATOR_BUNDLE_PATH, coordinatorWorkflow, WORKFLOW_FILE, WORKFLOW_PATH, type WorkflowOptions } from './workflow.js';

/**
 * Shown by the setup UI next to the project-token field. The installer enforces the first point
 * (classic `ghp_` tokens are refused); the rest is guidance the user must follow on github.com.
 */
export const PROJECT_TOKEN_GUIDANCE = [
  'Use a fine-grained personal access token (github_pat_…), not a classic token.',
  'Repository access: only the project repositories you selected, never "All repositories".',
  'Permissions: Contents read/write and Pull requests read/write; nothing else. It is sent to Anthropic to mount the repository in the agent sandbox.',
  'Protect the default branch of each project repository (require a pull request before merging) so agent work can only arrive as reviewable branches.',
  'Set an expiry; re-run setup to replace it.',
] as const;

/** Returns base64 ciphertext of `value` sealed to `publicKeyBase64`. Implemented by the caller. */
export type EncryptSecret = (publicKeyBase64: string, value: string) => Promise<string>;
export const SECRET_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PROJECT_GITHUB_TOKEN'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export const DEFAULT_STATE_REPO = 'agent-empire-state';

export type InstallStep = 'repo' | 'secrets' | 'state' | 'workflow' | 'verify';
export const INSTALL_STEPS: readonly { step: InstallStep; label: string }[] = [
  { step: 'repo', label: 'Prepare your private state repository' },
  { step: 'secrets', label: 'Encrypt and store your keys as Actions secrets' },
  { step: 'state', label: 'Write your Empire’s starting state' },
  { step: 'workflow', label: 'Install the always-on coordinator' },
  { step: 'verify', label: 'Check everything is in place' },
];
export type StepStatus = 'running' | 'done' | 'skipped';
/** `detail` is a short, user-safe note (e.g. "already there"). Never contains a secret. */
export type OnStep = (step: InstallStep, status: StepStatus, detail?: string) => void;

export class InstallError extends Error {
  constructor(readonly step: InstallStep, readonly code: string, message: string, readonly status = 0) { super(message); this.name = 'InstallError'; }
}

export interface InstallOptions {
  repo?: string;
  secrets: Partial<Record<SecretName, string>>;
  limits: CloudLimits;
  execution?: CloudExecution;
  /** Contents of the built single-file coordinator (npm run build:cloud). */
  coordinatorBundle: string;
  workflow?: WorkflowOptions;
  now: number;
  onStep?: OnStep;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a just-created repository's first commit (GitHub creates it asynchronously). */
  branchWaitMs?: readonly number[];
}
export interface InstallResult {
  owner: string; repo: string; branch: string; created: boolean; secrets: SecretName[];
  /** Head commit after the installer ran. */
  commit?: string;
  /** The state files were already there; they were left untouched. */
  alreadyInstalled: boolean;
  steps: Record<InstallStep, 'done' | 'skipped'>;
}

const STATE_README = '# Agent Empire state\n\nWritten by the Agent Empire coordinator workflow. Keep this repository private.\n';
const BRANCH_WAIT = [500, 1000, 2000, 3000, 4000] as const;
const COMMIT_ATTEMPTS = 4;

/** Validates everything that can be checked before the first network call. Throws InstallError. */
export function checkInstallOptions(options: InstallOptions) {
  const repoName = options.repo ?? DEFAULT_STATE_REPO;
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repoName) || repoName === '.' || repoName === '..') throw new InstallError('repo', 'invalid', 'Invalid state repository name.');
  let limits: CloudLimits;
  try { limits = validateLimits(options.limits); } catch { throw new InstallError('state', 'invalid', 'The spending limits are invalid.'); }
  let execution: CloudExecution | undefined;
  try { execution = options.execution ? validateExecution(options.execution) : undefined; } catch { throw new InstallError('state', 'invalid', 'The execution settings are invalid.'); }
  if (!options.coordinatorBundle || options.coordinatorBundle.length > 5 * 1024 * 1024) throw new InstallError('state', 'bundle_invalid', 'A coordinator bundle is required.');
  for (const name of Object.keys(options.secrets)) if (!SECRET_NAMES.includes(name as SecretName)) throw new InstallError('secrets', 'secret_name_invalid', 'Unsupported secret name.');
  const projectToken = options.secrets.PROJECT_GITHUB_TOKEN?.trim();
  if (projectToken && !projectToken.startsWith('github_pat_')) throw new InstallError('secrets', 'project_token_not_fine_grained', 'The project token must be a fine-grained personal access token scoped to the selected repositories (github_pat_…). Classic and OAuth tokens grant too much access.');
  const workflow = coordinatorWorkflow(options.workflow); // validates the interval
  return { repoName, limits, execution, workflow };
}

export async function installStateRepository(client: GitHubClient, options: InstallOptions, encryptSecret: EncryptSecret): Promise<InstallResult> {
  const { repoName, limits, execution, workflow } = checkInstallOptions(options);
  const onStep: OnStep = options.onStep ?? (() => {});
  const sleep = options.sleep ?? defaultSleep;
  const steps = {} as InstallResult['steps'];
  let step: InstallStep = 'repo';
  const finish = (s: InstallStep, status: 'done' | 'skipped', detail?: string) => { steps[s] = status; onStep(s, status, detail); };
  const begin = (s: InstallStep) => { step = s; onStep(s, 'running'); };

  try {
    // ---- repo -------------------------------------------------------------------------------------------
    begin('repo');
    const user = await client.request('GET', '/user');
    const owner = user.data?.login;
    if (typeof owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) throw new InstallError('repo', 'github_invalid', 'GitHub did not return the signed-in account.');
    let repo = await getRepo(client, owner, repoName);
    let created = false;
    if (!repo) {
      try {
        repo = (await client.request('POST', '/user/repos', { name: repoName, private: true, auto_init: true, description: 'Agent Empire state (written by the coordinator workflow). Keep this repository private.', has_issues: false, has_wiki: false, has_projects: false })).data;
        created = true;
      } catch (error) {
        if (error instanceof GitHubError && error.status === 422) repo = await getRepo(client, owner, repoName); // created meanwhile
        else if (error instanceof GitHubError && (error.status === 403 || error.status === 404))
          throw new InstallError('repo', 'repo_create_forbidden', `This token can’t create repositories. Create a private repository named ${repoName} in your GitHub account, then try again.`, error.status);
        else throw error;
      }
    }
    if (!repo || repo.private !== true) throw new InstallError('repo', 'state_repository_public', `${owner}/${repoName} is public. The state repository must be private: make it private on GitHub or rename it, then try again.`);
    const repoOwner = typeof repo.owner?.login === 'string' ? repo.owner.login : owner;
    if (repoOwner.toLowerCase() !== owner.toLowerCase()) throw new InstallError('repo', 'repo_conflict', `${owner}/${repoName} belongs to another account and can’t be used.`);
    const branch = typeof repo.default_branch === 'string' && repo.default_branch ? repo.default_branch : 'main';
    const ref = validateRepoRef({ owner, repo: repoName, branch, workflowFile: WORKFLOW_FILE });
    const base = `/repos/${owner}/${repoName}`;
    await ensureBranch(client, base, branch, created, options.branchWaitMs ?? BRANCH_WAIT, sleep);
    finish('repo', 'done', created ? 'created' : 'already there');

    // ---- secrets ----------------------------------------------------------------------------------------
    begin('secrets');
    const uploaded: SecretName[] = [];
    const entries = Object.entries(options.secrets).filter(([, value]) => typeof value === 'string' && value.trim().length > 0) as [SecretName, string][];
    if (entries.length) {
      const key = (await client.request('GET', `${base}/actions/secrets/public-key`)).data;
      if (typeof key?.key !== 'string' || typeof key?.key_id !== 'string') throw new InstallError('secrets', 'github_invalid', 'GitHub did not return the repository public key.');
      for (const [name, value] of entries) {
        let encrypted: string;
        // A key GitHub sent that cannot be used (wrong length or encoding) must not surface as "something went wrong".
        try { encrypted = await encryptSecret(key.key, value.trim()); }
        catch { throw new InstallError('secrets', 'secret_encryption_failed', 'This app could not encrypt your keys with the repository’s public key from GitHub. Nothing was stored; try again.'); }
        if (typeof encrypted !== 'string' || !encrypted || encrypted === value || encrypted.includes(value.trim())) throw new InstallError('secrets', 'secret_encryption_invalid', 'Secret encryption did not produce ciphertext.');
        await client.request('PUT', `${base}/actions/secrets/${name}`, { encrypted_value: encrypted, key_id: key.key_id });
        uploaded.push(name);
      }
      finish('secrets', 'done', uploaded.join(', '));
    } else finish('secrets', 'skipped', 'no keys given');

    // ---- state (+ coordinator bundle) ---------------------------------------------------------------------
    begin('state');
    const store = new GitHubStateStore(client, ref);
    let alreadyInstalled = false;
    const stateCommit = await commitIfNeeded(client, store, base, branch, sleep, async (files, text) => {
      alreadyInstalled = files.has(STATE_FILES.meta);
      if (alreadyInstalled) {
        // An existing Empire is kept, but only if the coordinator can read it: nothing is installed on top of a
        // state it would refuse (a newer schema, or files that are not an Empire), so no run burns minutes failing.
        const existing: Record<string, string> = {};
        for (const path of Object.values(STATE_FILES)) { const t = await text(path); if (t !== undefined) existing[path] = t; }
        try { parseStateFiles(existing, options.now); }
        catch (error) { throw new InstallError('state', 'state_invalid', `${owner}/${repoName} holds files that are not a valid Empire state (${error instanceof Error ? error.message.slice(0, 160) : 'invalid'}). Nothing was changed; use an empty private repository instead.`); }
      }
      const changes: FileChange[] = [];
      if ((await text(COORDINATOR_BUNDLE_PATH)) !== options.coordinatorBundle) changes.push({ path: COORDINATOR_BUNDLE_PATH, content: options.coordinatorBundle });
      // Never overwrite an existing Empire: re-running setup updates the coordinator only.
      if (!alreadyInstalled) {
        const initial = initialCloudState(options.now, { limits, ...(execution ? { execution } : {}), ...(options.workflow?.intervalMinutes ? { intervalMinutes: options.workflow.intervalMinutes } : {}) });
        for (const [path, content] of Object.entries(serializeState(initial))) changes.push({ path, content });
      }
      return { changes, message: alreadyInstalled ? 'Agent Empire: update coordinator' : 'Agent Empire: initial state and coordinator' };
    });
    finish('state', stateCommit.changed || !alreadyInstalled ? 'done' : 'skipped', alreadyInstalled ? 'existing Empire kept' : 'initial state written');

    // ---- workflow ---------------------------------------------------------------------------------------
    begin('workflow');
    const workflowCommit = await commitIfNeeded(client, store, base, branch, sleep, async (_files, text) =>
      (await text(WORKFLOW_PATH)) === workflow ? { changes: [], message: '' } : { changes: [{ path: WORKFLOW_PATH, content: workflow }], message: 'Agent Empire: install the coordinator workflow' });
    finish('workflow', workflowCommit.changed ? 'done' : 'skipped', workflowCommit.changed ? undefined : 'already installed');

    // ---- verify -----------------------------------------------------------------------------------------
    begin('verify');
    const head = await readHead(client, base, branch);
    for (const path of [WORKFLOW_PATH, COORDINATOR_BUNDLE_PATH]) if (!head.entries.has(path)) throw new InstallError('verify', 'verify_missing', `${path} is missing from the state repository.`);
    const snapshot = await store.read();
    try { parseStateFiles(Object.fromEntries(Object.entries(snapshot.files).filter(([path]) => !path.startsWith('intents/'))), options.now); }
    catch (error) { throw new InstallError('verify', 'state_invalid', `${owner}/${repoName} holds files that are not a valid Empire state (${error instanceof Error ? error.message.slice(0, 160) : 'invalid'}). Use an empty private repository instead.`); }
    finish('verify', 'done');
    return { owner, repo: repoName, branch, created, secrets: uploaded, commit: snapshot.sha, alreadyInstalled, steps };
  } catch (error) {
    if (error instanceof InstallError) throw error;
    if (error instanceof GitHubError) throw new InstallError(step, error.code, error.message, error.status);
    throw new InstallError(step, 'unexpected', 'Something went wrong while setting up the state repository.');
  }
}

async function getRepo(client: GitHubClient, owner: string, name: string): Promise<any | null> {
  try { return (await client.request('GET', `/repos/${owner}/${name}`)).data; }
  catch (error) { if (error instanceof GitHubError && error.status === 404) return null; throw error; }
}

/**
 * The Git Data API needs at least one commit. GitHub creates the `auto_init` commit asynchronously, and a repository
 * the user created without a README is empty (HTTP 409 "Git Repository is empty"): give it a first commit through the
 * Contents API, which works on empty repositories.
 */
async function ensureBranch(client: GitHubClient, base: string, branch: string, created: boolean, waits: readonly number[], sleep: (ms: number) => Promise<void>) {
  const head = async () => {
    try { await client.request('GET', `${base}/git/ref/heads/${branch}`); return true; }
    catch (error) { if (error instanceof GitHubError && (error.status === 404 || error.status === 409)) return false; throw error; }
  };
  if (await head()) return;
  if (!created) {
    await client.request('PUT', `${base}/contents/README.md`, { message: 'Agent Empire state repository', content: encodeBase64Utf8(STATE_README), branch });
    if (await head()) return;
  }
  for (const ms of waits) { await sleep(ms); if (await head()) return; }
  throw new InstallError('repo', 'repo_not_ready', 'GitHub hasn’t finished creating the repository yet. Try again in a moment.');
}

interface Head { sha: string; treeSha: string; entries: Map<string, { sha: string; size?: number }> }
async function readHead(client: GitHubClient, base: string, branch: string): Promise<Head> {
  const ref = await client.request('GET', `${base}/git/ref/heads/${branch}`);
  const sha = ref.data?.object?.sha;
  if (typeof sha !== 'string') throw new GitHubError(502, 'github_invalid', 'GitHub returned an invalid branch head.');
  const commit = await client.request('GET', `${base}/git/commits/${sha}`);
  const treeSha = commit.data?.tree?.sha;
  if (typeof treeSha !== 'string') throw new GitHubError(502, 'github_invalid', 'GitHub returned an invalid commit.');
  const tree = await client.request('GET', `${base}/git/trees/${treeSha}?recursive=1`);
  const entries = new Map<string, { sha: string; size?: number }>();
  for (const e of Array.isArray(tree.data?.tree) ? tree.data.tree : []) if (e?.type === 'blob' && typeof e.path === 'string' && typeof e.sha === 'string') entries.set(e.path, { sha: e.sha, size: e.size });
  return { sha, treeSha, entries };
}

/** Reads the head, asks `plan` what to change, commits it; a moved branch (422/409) is re-read and re-planned. */
async function commitIfNeeded(
  client: GitHubClient, store: GitHubStateStore, base: string, branch: string, sleep: (ms: number) => Promise<void>,
  plan: (files: Map<string, { sha: string }>, text: (path: string) => Promise<string | undefined>) => Promise<{ changes: FileChange[]; message: string }>,
): Promise<{ changed: boolean; sha: string }> {
  for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt++) {
    const head = await readHead(client, base, branch);
    const text = async (path: string) => {
      const entry = head.entries.get(path);
      if (!entry) return undefined;
      const blob = await client.request('GET', `${base}/git/blobs/${entry.sha}`);
      if (blob.data?.encoding !== 'base64' || typeof blob.data?.content !== 'string') return undefined;
      try { return decodeBase64Utf8(blob.data.content); } catch { return undefined; }
    };
    const next = await plan(head.entries, text);
    if (!next.changes.length) return { changed: false, sha: head.sha };
    const result = await store.commit(head, next.changes, next.message);
    if (result.ok) return { changed: result.changed, sha: result.sha };
    await sleep(250 * 2 ** (attempt - 1));
  }
  throw new GitHubError(409, 'state_repository_busy', 'The state repository kept changing during setup. Try again.');
}
