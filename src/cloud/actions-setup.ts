/**
 * FREE-04 setup helpers, run by the app with the user's own GitHub sign-in (browser-safe):
 *
 *   checkJobSecret     GET /repos/{o}/{r}/actions/secrets — names and dates only. GitHub never returns values, and
 *                      this module has no way to accept one: there is no parameter for a token.
 *   installJobWorkflow commit .github/workflows/agent-empire-job.yml to the project's default branch (unchanged files
 *                      are skipped), so the coordinator can dispatch it.
 */
import { JOB_WORKFLOW_PATH, requiredSecret, rotationStatus, type ActionsSettings, type JobSecretName } from './actions-spec.js';
import { jobWorkflow, type JobWorkflowTarget } from './job-workflow.js';
import { decodeBase64Utf8, encodeBase64Utf8, GitHubClient, GitHubError } from './store.js';

export interface SecretCheck {
  name: JobSecretName | null;
  /** True when no secret is needed, or the named secret exists. */
  present: boolean;
  updatedAt?: string;
  /** The 11-month rotation reminder for a Claude setup-token. */
  rotationDue?: boolean;
  rotationDueAt?: number;
  /** User-safe reason when the check could not be made. */
  error?: string;
}

export async function checkJobSecret(client: GitHubClient, repo: { owner: string; name: string }, settings: Pick<ActionsSettings, 'engine' | 'modelSource'>, now: number): Promise<SecretCheck> {
  const name = requiredSecret(settings);
  if (!name) return { name, present: true };
  try {
    const { data } = await client.request('GET', `/repos/${repo.owner}/${repo.name}/actions/secrets?per_page=100`);
    const list: unknown[] = Array.isArray(data?.secrets) ? data.secrets : [];
    const found = list.find((s: any) => s?.name === name) as { updated_at?: unknown } | undefined;
    if (!found) return { name, present: false };
    const updatedAt = typeof found.updated_at === 'string' ? found.updated_at : undefined;
    const rotation = name === 'CLAUDE_CODE_OAUTH_TOKEN' ? rotationStatus(updatedAt, now) : { due: false };
    return { name, present: true, ...(updatedAt ? { updatedAt } : {}), ...(name === 'CLAUDE_CODE_OAUTH_TOKEN' ? { rotationDue: rotation.due, ...(rotation.dueAt ? { rotationDueAt: rotation.dueAt } : {}) } : {}) };
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 0;
    return { name, present: false, error: status === 403 || status === 404 ? `Your GitHub sign-in can’t list secret names on ${repo.owner}/${repo.name} (it needs Secrets: read).` : 'GitHub could not be reached to check the secret name. Try again.' };
  }
}

export async function installJobWorkflow(client: GitHubClient, target: JobWorkflowTarget, settings: ActionsSettings): Promise<'installed' | 'unchanged'> {
  const yaml = jobWorkflow(target, settings);
  const base = `/repos/${target.owner}/${target.name}/contents/${JOB_WORKFLOW_PATH}`;
  let sha: string | undefined;
  try {
    const { data } = await client.request('GET', `${base}?ref=${encodeURIComponent(target.baseBranch)}`);
    if (typeof data?.sha === 'string') sha = data.sha;
    if (typeof data?.content === 'string' && decodeBase64Utf8(data.content.replace(/\n/g, '')) === yaml) return 'unchanged';
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) throw error;
  }
  await client.request('PUT', base, { message: 'Agent Empire: install the job workflow', content: encodeBase64Utf8(yaml), branch: target.baseBranch, ...(sha ? { sha } : {}) });
  return 'installed';
}

/**
 * FREE-11/12: which of these Actions secret names exist in the state repository (for the brain's key and the outreach
 * SMTP URL). Names and dates only: GitHub never returns values, and there is no parameter that could take one.
 */
export async function checkStateSecrets(client: GitHubClient, repo: { owner: string; name: string }, names: readonly string[]): Promise<{ present: Record<string, boolean>; error?: string }> {
  const present = Object.fromEntries(names.map((n) => [n, false]));
  try {
    const { data } = await client.request('GET', `/repos/${repo.owner}/${repo.name}/actions/secrets?per_page=100`);
    const list: unknown[] = Array.isArray(data?.secrets) ? data.secrets : [];
    for (const s of list) { const n = (s as { name?: unknown })?.name; if (typeof n === 'string' && n in present) present[n] = true; }
    return { present };
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 0;
    return { present, error: status === 403 || status === 404 ? `Your GitHub sign-in can’t list secret names on ${repo.owner}/${repo.name} (it needs Secrets: read). Check the secret under the repository’s Settings → Secrets and variables → Actions instead.` : 'GitHub could not be reached to check the secret names. Try again.' };
  }
}
