/**
 * Coordinator entry point, bundled to one file by `npm run build:cloud` and run by the workflow as
 * `node coordinator/agent-empire-coordinator.mjs tick`. Reads configuration from the Actions
 * environment; prints only non-secret progress lines.
 */
import { AnthropicCloudAdapter } from './anthropic-adapter.js';
import { UnavailableProvider, type ProviderAdapter } from './provider.js';
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

export function storeFromEnv(env: CliEnv, transport?: typeof fetch): GitHubStateStore {
  const token = env.GITHUB_TOKEN?.trim();
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? '').split('/');
  const branch = env.AGENT_EMPIRE_STATE_BRANCH ?? env.GITHUB_REF_NAME;
  if (!token || !owner || !repo || !branch) throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_REF_NAME are required.');
  return new GitHubStateStore(new GitHubClient(token, transport ? { fetch: transport } : {}), { owner, repo, branch, workflowFile: env.AGENT_EMPIRE_WORKFLOW ?? 'agent-empire.yml' });
}

export async function main(argv: string[], env: CliEnv, out: (line: string) => void = console.log, transport?: typeof fetch): Promise<number> {
  const command = argv[0];
  if (command !== 'tick' && command !== 'status') { out('usage: agent-empire-coordinator <tick|status>'); return 2; }
  try {
    const store = storeFromEnv(env, transport);
    if (command === 'status') {
      const view = await readCloudView(store, Date.now());
      out(JSON.stringify({ revision: view.state.meta.revision, lifecycle: view.state.meta.lifecycle, snapshotAgeMs: view.snapshotAgeMs, jobs: view.state.jobs.jobs.map(job => ({ id: job.id, status: job.status })), pendingIntents: view.pendingIntents.length }));
      return 0;
    }
    const runId = `${env.GITHUB_RUN_ID ?? 'local'}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) || 'local-1';
    const report = await runCoordinatorTick({
      store, provider: providerFromEnv(env, transport), now: Date.now, runId,
      allowSelfDisable: env.AGENT_EMPIRE_SELF_DISABLE === 'true', log: out,
    });
    out(JSON.stringify({ runId: report.runId, revision: report.revision, intents: report.intents.map(i => ({ id: i.id, kind: i.kind, outcome: i.outcome, reason: i.reason })), observed: report.observed, dispatched: report.dispatched, lifecycle: report.lifecycle, migrated: report.migrated, intentsTruncated: report.intentsTruncated }));
    return 0;
  } catch (error) {
    out(`coordinator failed: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}`);
    return 1;
  }
}

const invokedDirectly = typeof process !== 'undefined' && process.argv[1] && /agent-empire-coordinator\.m?js$|cloud[\\/]cli\.ts$/.test(process.argv[1]);
if (invokedDirectly) void main(process.argv.slice(2), process.env).then(code => { process.exitCode = code; });
