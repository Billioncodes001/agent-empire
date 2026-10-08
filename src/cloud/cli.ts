/**
 * Coordinator entry point, bundled to one file by `npm run build:cloud` and run by the workflow as
 * `node coordinator/agent-empire-coordinator.mjs tick`. Reads configuration from the Actions
 * environment; prints only non-secret progress lines.
 */
import { AnthropicCloudAdapter } from './anthropic-adapter.js';
import { OpenAICloudAdapter } from './openai-adapter.js';
import { OPENAI_VERIFIED_DEFAULT, OPENAI_VERIFIED_ENV } from './openai-spec.js';
import { UnavailableProvider, type ProviderAdapter, type ProviderSet } from './provider.js';
import { GitHubClient, GitHubStateStore } from './store.js';
import { runCoordinatorTick } from './tick.js';
import { readCloudView } from './client.js';

export interface CliEnv { [key: string]: string | undefined }

export function providerFromEnv(env: CliEnv, transport?: typeof fetch): ProviderAdapter {
  const apiKey = env.ANTHROPIC_API_KEY?.trim() ?? '';
  const githubToken = env.PROJECT_GITHUB_TOKEN?.trim() ?? '';
  if (!apiKey) return new UnavailableProvider();
  return new AnthropicCloudAdapter({ apiKey, githubToken }, transport ? { fetch: transport } : {});
}

/**
 * The owner's verification flag (decision 12): OpenAI work is refused unless this build ships verified, or the owner set
 * the Actions variable AGENT_EMPIRE_OPENAI_VERIFIED=true in their state repository for the first real run.
 */
export const openaiVerified = (env: CliEnv) => OPENAI_VERIFIED_DEFAULT || env[OPENAI_VERIFIED_ENV]?.trim() === 'true';

/** Both adapters; the coordinator uses the one the Empire's execution names (one provider per Empire). */
export function providersFromEnv(env: CliEnv, transport?: typeof fetch): ProviderSet {
  const apiKey = env.OPENAI_API_KEY?.trim() ?? '';
  return {
    anthropic: providerFromEnv(env, transport),
    ...(apiKey ? { openai: new OpenAICloudAdapter({ apiKey, githubToken: env.PROJECT_GITHUB_TOKEN?.trim() ?? '' }, { verified: openaiVerified(env), ...(transport ? { fetch: transport } : {}) }) } : {}),
  };
}

/** The state lives on the repository's default branch (AGENT_EMPIRE_STATE_BRANCH, set by the workflow). */
export function stateBranch(env: CliEnv): string | undefined {
  return env.AGENT_EMPIRE_STATE_BRANCH?.trim() || env.GITHUB_REF_NAME?.trim() || undefined;
}

export function storeFromEnv(env: CliEnv, transport?: typeof fetch): GitHubStateStore {
  const token = env.GITHUB_TOKEN?.trim();
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? '').split('/');
  const branch = stateBranch(env);
  if (!token || !owner || !repo || !branch) throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY and AGENT_EMPIRE_STATE_BRANCH (or GITHUB_REF_NAME) are required.');
  return new GitHubStateStore(new GitHubClient(token, transport ? { fetch: transport } : {}), { owner, repo, branch, workflowFile: env.AGENT_EMPIRE_WORKFLOW ?? 'agent-empire.yml' });
}

export async function main(argv: string[], env: CliEnv, out: (line: string) => void = console.log, transport?: typeof fetch): Promise<number> {
  const command = argv[0];
  if (command !== 'tick' && command !== 'status') { out('usage: agent-empire-coordinator <tick|status>'); return 2; }
  // A run started from another branch (workflow_dispatch on a feature branch) would be a second
  // coordinator acting on the same state: skip it rather than risk a double dispatch.
  const branch = stateBranch(env);
  if (command === 'tick' && env.GITHUB_REF_NAME && branch && env.GITHUB_REF_NAME !== branch) {
    out(`skipped: this run is on ${env.GITHUB_REF_NAME.slice(0, 100)}, but the Empire state lives on ${branch.slice(0, 100)}. Only runs on the default branch coordinate.`);
    return 0;
  }
  try {
    const store = storeFromEnv(env, transport);
    if (command === 'status') {
      const view = await readCloudView(store, Date.now());
      out(JSON.stringify({ revision: view.state.meta.revision, lifecycle: view.state.meta.lifecycle, schedule: view.state.meta.schedule, snapshotAgeMs: view.snapshotAgeMs, jobs: view.state.jobs.jobs.map(job => ({ id: job.id, status: job.status })), pendingIntents: view.pendingIntents.length }));
      return 0;
    }
    const runId = `${env.GITHUB_RUN_ID ?? 'local'}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) || 'local-1';
    const report = await runCoordinatorTick({
      store, provider: providersFromEnv(env, transport), now: Date.now, runId,
      allowSelfDisable: env.AGENT_EMPIRE_SELF_DISABLE === 'true', log: out,
    });
    out(JSON.stringify({ runId: report.runId, revision: report.revision, intents: report.intents.map(i => ({ id: i.id, kind: i.kind, outcome: i.outcome, reason: i.reason })), observed: report.observed, stopped: report.stopped, commits: report.commits, dispatched: report.dispatched, lifecycle: report.lifecycle, migrated: report.migrated, intentsTruncated: report.intentsTruncated, provisioning: report.provisioning }));
    return 0;
  } catch (error) {
    out(`coordinator failed: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}`);
    return 1;
  }
}

const invokedDirectly = typeof process !== 'undefined' && process.argv[1] && /agent-empire-coordinator\.m?js$|cloud[\\/]cli\.ts$/.test(process.argv[1]);
if (invokedDirectly) void main(process.argv.slice(2), process.env).then(code => { process.exitCode = code; });
