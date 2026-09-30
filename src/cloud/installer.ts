/**
 * CLOUD-02 installer core: creates the private state repository, uploads encrypted Actions secrets,
 * and commits the workflow, coordinator bundle and initial state in one commit.
 *
 * SEAM: `encryptSecret` must implement a libsodium sealed box (crypto_box_seal) to the repository's
 * public key. It is injected by the client setup flow (CLOUD-03, which owns the approved tweetnacl +
 * blakejs dependencies). This module never encrypts, logs or stores secret values itself.
 *
 * Setup never starts paid work: the initial state has no jobs, and installing does not trigger a run.
 */
import { initialCloudState, serializeState, validateExecution, validateLimits, type CloudExecution, type CloudLimits } from './schema.js';
import { GitHubClient, GitHubError, GitHubStateStore, validateRepoRef, type FileChange } from './store.js';
import { COORDINATOR_BUNDLE_PATH, coordinatorWorkflow, WORKFLOW_FILE, WORKFLOW_PATH, type WorkflowOptions } from './workflow.js';

/** Returns base64 ciphertext of `value` sealed to `publicKeyBase64`. Implemented by the caller. */
export type EncryptSecret = (publicKeyBase64: string, value: string) => Promise<string>;
export const SECRET_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PROJECT_GITHUB_TOKEN'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export interface InstallOptions {
  repo?: string;
  secrets: Partial<Record<SecretName, string>>;
  limits: CloudLimits;
  execution?: CloudExecution;
  /** Contents of the built single-file coordinator (npm run build:cloud). */
  coordinatorBundle: string;
  workflow?: WorkflowOptions;
  now: number;
}
export interface InstallResult { owner: string; repo: string; branch: string; created: boolean; secrets: SecretName[]; commit?: string; alreadyInstalled: boolean }

export async function installStateRepository(client: GitHubClient, options: InstallOptions, encryptSecret: EncryptSecret): Promise<InstallResult> {
  const repoName = options.repo ?? 'agent-empire-state';
  const limits = validateLimits(options.limits);
  const execution = options.execution ? validateExecution(options.execution) : undefined;
  if (!options.coordinatorBundle || options.coordinatorBundle.length > 5 * 1024 * 1024) throw new GitHubError(400, 'bundle_invalid', 'A coordinator bundle is required.');
  for (const name of Object.keys(options.secrets)) if (!SECRET_NAMES.includes(name as SecretName)) throw new GitHubError(400, 'secret_name_invalid', 'Unsupported secret name.');

  const user = await client.request('GET', '/user');
  const owner = user.data?.login;
  if (typeof owner !== 'string') throw new GitHubError(502, 'github_invalid', 'GitHub did not return the signed-in account.');

  let repo: any; let created = false;
  try { repo = (await client.request('GET', `/repos/${owner}/${repoName}`)).data; }
  catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
    repo = (await client.request('POST', '/user/repos', { name: repoName, private: true, auto_init: true, description: 'Agent Empire state (written by the coordinator workflow).', has_issues: false, has_wiki: false, has_projects: false })).data;
    created = true;
  }
  if (repo?.private !== true) throw new GitHubError(409, 'state_repository_public', 'The state repository must be private. Choose another name or make it private first.');
  const branch = typeof repo.default_branch === 'string' ? repo.default_branch : 'main';
  const ref = validateRepoRef({ owner, repo: repoName, branch, workflowFile: WORKFLOW_FILE });
  const store = new GitHubStateStore(client, ref);

  // Upload secrets before the workflow exists so the first scheduled run already has them.
  const uploaded: SecretName[] = [];
  const entries = Object.entries(options.secrets).filter(([, value]) => typeof value === 'string' && value.length > 0) as [SecretName, string][];
  if (entries.length) {
    const key = (await client.request('GET', `/repos/${owner}/${repoName}/actions/secrets/public-key`)).data;
    if (typeof key?.key !== 'string' || typeof key?.key_id !== 'string') throw new GitHubError(502, 'github_invalid', 'GitHub did not return the repository public key.');
    for (const [name, value] of entries) {
      const encrypted = await encryptSecret(key.key, value);
      if (typeof encrypted !== 'string' || !encrypted || encrypted === value) throw new GitHubError(500, 'secret_encryption_invalid', 'Secret encryption did not produce ciphertext.');
      await client.request('PUT', `/repos/${owner}/${repoName}/actions/secrets/${name}`, { encrypted_value: encrypted, key_id: key.key_id });
      uploaded.push(name);
    }
  }

  const snapshot = await store.read();
  const alreadyInstalled = snapshot.files['state/meta.json'] !== undefined;
  const changes: FileChange[] = [
    { path: WORKFLOW_PATH, content: coordinatorWorkflow(options.workflow) },
    { path: COORDINATOR_BUNDLE_PATH, content: options.coordinatorBundle },
  ];
  // Never overwrite an existing Empire: re-running setup updates the workflow and coordinator only.
  if (!alreadyInstalled) {
    for (const [path, content] of Object.entries(serializeState(initialCloudState(options.now, { limits, ...(execution ? { execution } : {}) })))) changes.push({ path, content });
  }
  const result = await store.commit(snapshot, changes, alreadyInstalled ? 'Agent Empire: update coordinator' : 'Agent Empire: initial state and coordinator');
  if (!result.ok) throw new GitHubError(409, 'state_repository_busy', 'The state repository changed during setup. Run setup again.');
  return { owner, repo: repoName, branch, created, secrets: uploaded, commit: result.sha, alreadyInstalled };
}
