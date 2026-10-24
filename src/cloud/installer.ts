/**
 * CLOUD-02 installer: makes the user's private state repository ready for the coordinator workflow.
 *
 * Steps, each reported through `onStep` so the setup screen can show progress:
 *   repo      use or create the private `<login>/agent-empire-state` (a repository the user created on GitHub,
 *             with or without an initial commit, is reused when it is theirs and private). Any Empire state
 *             already there is read and parsed HERE, before anything is written: an incompatible one stops
 *             setup with nothing changed.
 *   secrets   upload the chosen provider keys / project token as encrypted Actions secrets
 *   state     commit the coordinator bundle and the initial state (an existing Empire is never overwritten)
 *   execution ask the coordinator to find or create the Anthropic agent and environment (src/cloud/provisioning.ts):
 *             a `provisioning` request in a new Empire's starting state, or a `provision` intent for an existing
 *             Empire without execution settings. Setup itself never calls Anthropic (api.anthropic.com refuses
 *             browser calls to these endpoints) and never starts a session.
 *   workflow  commit the workflow YAML, last, so no scheduled run can start before the state exists
 *   verify    read the repository back and parse the state with the coordinator's own rules
 *
 * Every error carries exactly what this run already wrote to GitHub (`InstallError.written`).
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
import { initialCloudState, parseStateFiles, serializeState, STATE_FILES, validateExecution, validateLimits, validateProvisionRepository, type CloudExecution, type CloudLimits, type CloudState } from './schema.js';
import { intentPath, parseIntent } from './intents.js';
import type { ExecutionConfig } from '../shared/execution.js';
import { uuidv7 } from './uuid.js';
import { DEFAULT_WORKER_MODEL, isWorkerModel, type WorkerModel } from './worker-spec.js';
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
  'For the free or Claude-subscription engine (GitHub Actions), it also needs Actions read/write so the coordinator can start and cancel job runs; it never leaves GitHub.',
  'Protect the default branch of each project repository (require a pull request before merging) so agent work can only arrive as reviewable branches.',
  'Set an expiry; re-run setup to replace it.',
] as const;

/** Returns base64 ciphertext of `value` sealed to `publicKeyBase64`. Implemented by the caller. */
export type EncryptSecret = (publicKeyBase64: string, value: string) => Promise<string>;
export const SECRET_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PROJECT_GITHUB_TOKEN'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export const DEFAULT_STATE_REPO = 'agent-empire-state';

export type InstallStep = 'repo' | 'secrets' | 'state' | 'execution' | 'workflow' | 'verify';
export const INSTALL_STEPS: readonly { step: InstallStep; label: string }[] = [
  { step: 'repo', label: 'Prepare your private state repository' },
  { step: 'secrets', label: 'Encrypt and store your keys as Actions secrets' },
  { step: 'state', label: 'Write your Empire’s starting state' },
  { step: 'execution', label: 'Request your Anthropic agent and environment' },
  { step: 'workflow', label: 'Install the always-on coordinator' },
  { step: 'verify', label: 'Check everything is in place' },
];
export type StepStatus = 'running' | 'done' | 'skipped';
/** `detail` is a short, user-safe note (e.g. "already there"). Never contains a secret. */
export type OnStep = (step: InstallStep, status: StepStatus, detail?: string) => void;

export class InstallError extends Error {
  /** What this run had already written to GitHub when it failed (user-safe phrases, no secret values). */
  written: readonly string[] = [];
  constructor(readonly step: InstallStep, readonly code: string, message: string, readonly status = 0) { super(message); this.name = 'InstallError'; }
}
/** One sentence saying exactly what a failed run already wrote, for the end of an error message. */
export function writtenSummary(written: readonly string[]): string {
  return written.length ? `Already done on GitHub: ${written.join('; ')}.` : 'Nothing was written to GitHub.';
}

export interface InstallOptions {
  repo?: string;
  secrets: Partial<Record<SecretName, string>>;
  limits: CloudLimits;
  execution?: CloudExecution;
  /**
   * The project repository jobs run on. When given (setup passes it only with an Anthropic key), the coordinator
   * is asked to find or create the Anthropic agent and environment for it. Ignored when `execution` is given.
   */
  provision?: ExecutionConfig['repository'];
  /** Worker model for automatic setup (default Sonnet 5; owner decision 2026-10-02). */
  provisionModel?: WorkerModel;
  /** UUIDv7 source for the intent id (tests); defaults to uuidv7(now). */
  uuid?: () => string;
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
  /** What the execution step did: `requested` (the coordinator sets it up on its next run) or why it did not. */
  execution: 'requested' | 'already_configured' | 'already_requested' | 'no_anthropic_key';
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
  let provision: ExecutionConfig['repository'] | undefined;
  try { provision = options.provision && !execution ? validateProvisionRepository(options.provision) : undefined; } catch { throw new InstallError('execution', 'invalid', 'The project repository for jobs is invalid.'); }
  if (!options.coordinatorBundle || options.coordinatorBundle.length > 5 * 1024 * 1024) throw new InstallError('state', 'bundle_invalid', 'A coordinator bundle is required.');
  for (const name of Object.keys(options.secrets)) if (!SECRET_NAMES.includes(name as SecretName)) throw new InstallError('secrets', 'secret_name_invalid', 'Unsupported secret name.');
  const projectToken = options.secrets.PROJECT_GITHUB_TOKEN?.trim();
  if (projectToken && !projectToken.startsWith('github_pat_')) throw new InstallError('secrets', 'project_token_not_fine_grained', 'The project token must be a fine-grained personal access token scoped to the selected repositories (github_pat_…). Classic and OAuth tokens grant too much access.');
  const workflow = coordinatorWorkflow(options.workflow); // validates the interval
  if (options.provisionModel !== undefined && !isWorkerModel(options.provisionModel)) throw new InstallError('execution', 'invalid', 'Unsupported worker model.');
  const provisionModel = options.provisionModel ?? DEFAULT_WORKER_MODEL;
  return { repoName, limits, execution, provision, provisionModel, workflow };
}

/** Parses an existing Empire's state files with the coordinator's rules; an InstallError says why it is unusable. */
function parseExisting(step: InstallStep, files: Record<string, string>, now: number, where: string): CloudState {
  try { return parseStateFiles(files, now).state; }
  catch (error) { throw new InstallError(step, 'state_invalid', `${where} holds files that are not a valid Empire state this app can use (${error instanceof Error ? error.message.slice(0, 160) : 'invalid'}). Use an empty private repository instead, or update this app.`); }
}

export async function installStateRepository(client: GitHubClient, options: InstallOptions, encryptSecret: EncryptSecret): Promise<InstallResult> {
  const { repoName, limits, execution, provision, provisionModel, workflow } = checkInstallOptions(options);
  const onStep: OnStep = options.onStep ?? (() => {});
  const sleep = options.sleep ?? defaultSleep;
  const steps = {} as InstallResult['steps'];
  const written: string[] = [];
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
        written.push(`created the private repository ${owner}/${repoName}`);
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
    // An Empire already in a reused repository is read and checked before anything is written (no secret, no
    // README): a state this app cannot use stops setup here, with nothing changed.
    let existing: CloudState | undefined;
    const empty = !created && !(await branchExists(client, base, branch));
    if (!created && !empty) {
      const head = await readHead(client, base, branch);
      const stateFiles = Object.values(STATE_FILES) as string[];
      if (stateFiles.some(path => head.entries.has(path))) {
        const files: Record<string, string> = {};
        for (const path of stateFiles) { const t = await blobText(client, base, head, path); if (t !== undefined) files[path] = t; }
        existing = parseExisting('repo', files, options.now, `${owner}/${repoName}`);
      }
    }
    // The Git Data API needs one commit: only an empty repository the user created gets a README.md first commit.
    if (await ensureBranch(client, base, branch, created, options.branchWaitMs ?? BRANCH_WAIT, sleep)) written.push(`added README.md as the first commit of the empty repository ${owner}/${repoName}`);
    finish('repo', 'done', created ? 'created' : empty ? 'already there (empty, so README.md was added)' : existing ? 'already there, with your Empire' : 'already there');

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
        catch { throw new InstallError('secrets', 'secret_encryption_failed', `This app could not encrypt your ${name} with the repository’s public key from GitHub, so it was not stored. Try again.`); }
        if (typeof encrypted !== 'string' || !encrypted || encrypted === value || encrypted.includes(value.trim())) throw new InstallError('secrets', 'secret_encryption_invalid', 'Secret encryption did not produce ciphertext.');
        await client.request('PUT', `${base}/actions/secrets/${name}`, { encrypted_value: encrypted, key_id: key.key_id });
        uploaded.push(name);
        written.push(`stored the encrypted Actions secret ${name}`);
      }
      finish('secrets', 'done', uploaded.join(', '));
    } else finish('secrets', 'skipped', 'no keys given');

    // ---- state (+ coordinator bundle) ---------------------------------------------------------------------
    begin('state');
    const store = new GitHubStateStore(client, ref);
    let alreadyInstalled = false;
    let current: CloudState | undefined = existing;
    let wroteInitial = false;
    const stateCommit = await commitIfNeeded(client, store, base, branch, sleep, async (files, text) => {
      alreadyInstalled = files.has(STATE_FILES.meta);
      wroteInitial = false;
      if (alreadyInstalled) {
        // Checked again at commit time (another device may have written meanwhile): nothing is installed on top
        // of a state the coordinator would refuse, so no run burns minutes failing.
        const found: Record<string, string> = {};
        for (const path of Object.values(STATE_FILES)) { const t = await text(path); if (t !== undefined) found[path] = t; }
        current = parseExisting('state', found, options.now, `${owner}/${repoName}`);
      }
      const changes: FileChange[] = [];
      if ((await text(COORDINATOR_BUNDLE_PATH)) !== options.coordinatorBundle) changes.push({ path: COORDINATOR_BUNDLE_PATH, content: options.coordinatorBundle });
      // Never overwrite an existing Empire: re-running setup updates the coordinator only.
      if (!alreadyInstalled) {
        const initial = initialCloudState(options.now, { limits, ...(execution ? { execution } : {}), ...(provision ? { provision, model: provisionModel } : {}), ...(options.workflow?.intervalMinutes ? { intervalMinutes: options.workflow.intervalMinutes } : {}) });
        for (const [path, content] of Object.entries(serializeState(initial))) changes.push({ path, content });
        current = initial; wroteInitial = true;
      }
      return { changes, message: alreadyInstalled ? 'Agent Empire: update coordinator' : 'Agent Empire: initial state and coordinator' };
    });
    if (stateCommit.changed) written.push(wroteInitial ? 'committed the starting state and the coordinator' : 'updated the coordinator (your Empire’s state was kept)');
    finish('state', stateCommit.changed || !alreadyInstalled ? 'done' : 'skipped', alreadyInstalled ? 'existing Empire kept' : 'initial state written');

    // ---- execution --------------------------------------------------------------------------------------
    begin('execution');
    let executionStep: InstallResult['execution'];
    if (wroteInitial) {
      executionStep = execution ? 'already_configured' : provision ? 'requested' : 'no_anthropic_key';
    } else if (current?.meta.provisioning?.status === 'pending') executionStep = 'already_requested';
    else if (current?.meta.execution && !current.meta.provisioning) executionStep = 'already_configured';
    else if (!provision) executionStep = current?.meta.execution ? 'already_configured' : 'no_anthropic_key';
    else {
      // An existing Empire without execution settings, or whose automatic setup failed: running setup again asks its
      // coordinator through a fresh intent, like any client (a failed request is only retried on its own when it is
      // retryable, so this is how the user retries after fixing the cause).
      let found = false;
      const intentCommit = await commitIfNeeded(client, store, base, branch, sleep, async (files, text) => {
        found = false;
        for (const path of files.keys()) {
          if (!path.startsWith('intents/')) continue;
          const t = await text(path);
          try { if (t && parseIntent(path, t).kind === 'provision') { found = true; return { changes: [], message: '' }; } } catch { /* the coordinator rejects it */ }
        }
        const metaText = await text(STATE_FILES.meta);
        const configRevision = metaText ? Number(JSON.parse(metaText).configRevision) : 0;
        const id = (options.uuid ?? (() => uuidv7(options.now)))();
        const content = `${JSON.stringify({ schemaVersion: 1, id, createdAt: options.now, kind: 'provision', repository: provision, model: provisionModel, configRevision }, null, 2)}\n`;
        parseIntent(intentPath(id), content); // never commit an intent the coordinator could not parse
        return { changes: [{ path: intentPath(id), content }], message: `Agent Empire intent provision ${id}` };
      });
      if (intentCommit.changed) written.push('added a request for your coordinator to set up the Anthropic agent and environment');
      executionStep = found ? 'already_requested' : 'requested';
    }
    const executionDetail: Record<InstallResult['execution'], string> = {
      requested: 'requested: your coordinator creates or reuses them on its first run',
      already_configured: 'already set up',
      already_requested: 'already requested',
      no_anthropic_key: options.secrets.OPENAI_API_KEY?.trim() && !options.secrets.ANTHROPIC_API_KEY?.trim() ? 'OpenAI only: jobs can’t run until the OpenAI adapter exists' : 'no Anthropic key given',
    };
    finish('execution', executionStep === 'requested' ? 'done' : 'skipped', executionDetail[executionStep]);

    // ---- workflow ---------------------------------------------------------------------------------------
    begin('workflow');
    const workflowCommit = await commitIfNeeded(client, store, base, branch, sleep, async (_files, text) =>
      (await text(WORKFLOW_PATH)) === workflow ? { changes: [], message: '' } : { changes: [{ path: WORKFLOW_PATH, content: workflow }], message: 'Agent Empire: install the coordinator workflow' });
    if (workflowCommit.changed) written.push('committed the coordinator workflow');
    finish('workflow', workflowCommit.changed ? 'done' : 'skipped', workflowCommit.changed ? undefined : 'already installed');

    // ---- verify -----------------------------------------------------------------------------------------
    begin('verify');
    const head = await readHead(client, base, branch);
    for (const path of [WORKFLOW_PATH, COORDINATOR_BUNDLE_PATH]) if (!head.entries.has(path)) throw new InstallError('verify', 'verify_missing', `${path} is missing from the state repository.`);
    const snapshot = await store.read();
    try { parseStateFiles(Object.fromEntries(Object.entries(snapshot.files).filter(([path]) => !path.startsWith('intents/'))), options.now); }
    catch (error) { throw new InstallError('verify', 'state_invalid', `${owner}/${repoName} holds files that are not a valid Empire state (${error instanceof Error ? error.message.slice(0, 160) : 'invalid'}). Use an empty private repository instead.`); }
    finish('verify', 'done');
    return { owner, repo: repoName, branch, created, secrets: uploaded, commit: snapshot.sha, alreadyInstalled, execution: executionStep, steps };
  } catch (error) {
    const failure = error instanceof InstallError ? error
      : error instanceof GitHubError ? new InstallError(step, error.code, error.message, error.status)
        : new InstallError(step, 'unexpected', 'Something went wrong while setting up the state repository.');
    failure.written = [...written];
    throw failure;
  }
}

async function branchExists(client: GitHubClient, base: string, branch: string): Promise<boolean> {
  try { await client.request('GET', `${base}/git/ref/heads/${branch}`); return true; }
  catch (error) { if (error instanceof GitHubError && (error.status === 404 || error.status === 409)) return false; throw error; }
}

async function blobText(client: GitHubClient, base: string, head: Head, path: string): Promise<string | undefined> {
  const entry = head.entries.get(path);
  if (!entry) return undefined;
  const blob = await client.request('GET', `${base}/git/blobs/${entry.sha}`);
  if (blob.data?.encoding !== 'base64' || typeof blob.data?.content !== 'string') return undefined;
  try { return decodeBase64Utf8(blob.data.content); } catch { return undefined; }
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
/** Returns true when it gave an empty repository the user created a README.md first commit. */
async function ensureBranch(client: GitHubClient, base: string, branch: string, created: boolean, waits: readonly number[], sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const head = () => branchExists(client, base, branch);
  if (await head()) return false;
  let wroteReadme = false;
  if (!created) {
    await client.request('PUT', `${base}/contents/README.md`, { message: 'Agent Empire state repository', content: encodeBase64Utf8(STATE_README), branch });
    wroteReadme = true;
    if (await head()) return true;
  }
  for (const ms of waits) { await sleep(ms); if (await head()) return wroteReadme; }
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
    const text = (path: string) => blobText(client, base, head, path);
    const next = await plan(head.entries, text);
    if (!next.changes.length) return { changed: false, sha: head.sha };
    const result = await store.commit(head, next.changes, next.message);
    if (result.ok) return { changed: result.changed, sha: result.sha };
    await sleep(250 * 2 ** (attempt - 1));
  }
  throw new GitHubError(409, 'state_repository_busy', 'The state repository kept changing during setup. Try again.');
}
