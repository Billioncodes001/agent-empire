/**
 * Coordinator entry point, bundled to one file by `npm run build:cloud` and run by the workflow as
 * `node coordinator/agent-empire-coordinator.mjs tick`. Reads configuration from the Actions
 * environment; prints only non-secret progress lines.
 */
import { AnthropicCloudAdapter } from './anthropic-adapter.js';
import { GitHubActionsAdapter } from './actions-adapter.js';
import { ProviderRouter, UnavailableProvider, type ProviderAdapter } from './provider.js';
import { GitHubClient, GitHubStateStore } from './store.js';
import { runCoordinatorTick } from './tick.js';
import { readCloudView } from './client.js';
import { brainKeysFromEnv, openAiCompatibleCaller } from './brain-call.js';
import { runSendJob } from './outreach-send.js';
import { smtpConfigFromUrl, smtpTransport } from '../server/email.js';

export interface CliEnv { [key: string]: string | undefined }

export function providerFromEnv(env: CliEnv, transport?: typeof fetch): ProviderAdapter {
  const apiKey = env.ANTHROPIC_API_KEY?.trim() ?? '';
  const githubToken = env.PROJECT_GITHUB_TOKEN?.trim() ?? '';
  if (!apiKey) return new UnavailableProvider();
  return new AnthropicCloudAdapter({ apiKey, githubToken }, transport ? { fetch: transport } : {});
}

/**
 * FREE-04: the coordinator's adapters by execution provider. Anthropic Managed Agents needs ANTHROPIC_API_KEY; GitHub
 * Actions needs only PROJECT_GITHUB_TOKEN (Actions read/write on the project). Engine secrets such as
 * CLAUDE_CODE_OAUTH_TOKEN live in the project repository and are read only by the job workflow, never here.
 */
export function providersFromEnv(env: CliEnv, transport?: typeof fetch): ProviderRouter {
  const githubToken = env.PROJECT_GITHUB_TOKEN?.trim() ?? '';
  return new ProviderRouter({
    anthropic: providerFromEnv(env, transport),
    'github-actions': githubToken
      ? new GitHubActionsAdapter(githubToken, transport ? { fetch: transport } : {})
      : new UnavailableProvider('The project GitHub token (PROJECT_GITHUB_TOKEN) is not configured in the state repository secrets.'),
  });
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

/**
 * FREE-11/12: GitHub's time for this run: the run's own `run_started_at` from the Actions API (a re-run attempt has its
 * own). Undefined when it can't be read, so no paid call or send is made.
 */
export function githubTimeFromEnv(env: CliEnv, transport?: typeof fetch): () => Promise<number | undefined> {
  return async () => {
    const token = env.GITHUB_TOKEN?.trim(); const repo = env.GITHUB_REPOSITORY ?? ''; const runId = env.GITHUB_RUN_ID ?? '';
    if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d{1,20}$/.test(runId)) return undefined;
    try {
      const { data } = await new GitHubClient(token, transport ? { fetch: transport } : {}).request('GET', `/repos/${repo}/actions/runs/${runId}`);
      const at = Date.parse(String(data?.run_started_at ?? ''));
      return Number.isFinite(at) ? at : undefined;
    } catch { return undefined; }
  };
}

export async function main(argv: string[], env: CliEnv, out: (line: string) => void = console.log, transport?: typeof fetch): Promise<number> {
  const command = argv[0];
  if (command !== 'tick' && command !== 'status' && command !== 'send') { out('usage: agent-empire-coordinator <tick|status|send>'); return 2; }
  // A run started from another branch (workflow_dispatch on a feature branch) would be a second
  // coordinator acting on the same state: skip it rather than risk a double dispatch.
  const branch = stateBranch(env);
  if ((command === 'tick' || command === 'send') && env.GITHUB_REF_NAME && branch && env.GITHUB_REF_NAME !== branch) {
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
    if (command === 'send') {
      // FREE-12: the send job. It holds only AGENT_EMPIRE_SMTP_URL; the URL (which carries a password) is never printed.
      const raw = env.AGENT_EMPIRE_SMTP_URL?.trim();
      let transport = { send: async () => { throw new Error('no SMTP transport'); } } as { send: (m: import('../shared/outreach-render.js').MailMessage) => Promise<void> };
      let configured = false;
      if (raw) { try { transport = smtpTransport(smtpConfigFromUrl(raw)); configured = true; } catch { out('send: AGENT_EMPIRE_SMTP_URL is not a valid smtp:// or smtps:// URL; nothing sent'); } }
      const result = await runSendJob({ store, transport, smtpConfigured: configured, runId, now: Date.now, log: out });
      out(JSON.stringify({ runId, ...result }));
      return 0;
    }
    const report = await runCoordinatorTick({
      store, provider: providersFromEnv(env, transport), now: Date.now, runId,
      brain: openAiCompatibleCaller(brainKeysFromEnv(env), transport), githubTime: githubTimeFromEnv(env, transport),
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
