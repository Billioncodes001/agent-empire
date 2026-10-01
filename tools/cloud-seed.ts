/**
 * A state repository as a coordinator leaves it, for UI checks: the real installer and real coordinator ticks with a
 * fake provider write it into an in-memory api.github.com. Founded city, jobs in several states, spend and journal;
 * the last commit is 12 minutes old. No network, no paid calls.
 */
import { GitHubClient, GitHubStateStore } from '../src/cloud/store';
import { installStateRepository } from '../src/cloud/installer';
import { runCoordinatorTick } from '../src/cloud/tick';
import { CloudRepo } from '../src/client/cloud/repo';
import { uuidv7 } from '../src/client/cloud/uuid';
import { FakeGitHub } from '../tests/fake-github';
import { EXECUTION, FakeProvider } from '../tests/cloud-fixtures';

export const FULL = 'founder/agent-empire-state';
export const TOKEN = 'gho_FAKEFIXTURETOKEN000000000000000000';

/** A state repository as a coordinator leaves it: founded city, jobs in several states, spend, journal. */
export async function seed() {
  const gh = new FakeGitHub();
  const now = Date.now();
  const t0 = now - 3 * 3600_000;
  await installStateRepository(new GitHubClient(TOKEN, { fetch: gh.fetch }), {
    secrets: { ANTHROPIC_API_KEY: 'sk-ant-fixture' }, limits: { maxConcurrent: 3, perTaskBudgetCents: 500, dailyBudgetCents: 2000 },
    execution: EXECUTION, coordinatorBundle: '// bundle\n', now: t0, sleep: async () => {},
  }, async (k, v) => `sealed(${k}):${Buffer.from(v).toString('base64').split('').reverse().join('')}`);
  const store = new GitHubStateStore(new GitHubClient('ghs_actions', { fetch: gh.fetch }), { owner: 'founder', repo: 'agent-empire-state', branch: 'main', workflowFile: 'agent-empire.yml' });
  const provider = new FakeProvider();
  let run = 0;
  const tick = (at: number) => runCoordinatorTick({ store, provider, now: () => at, runId: `seed-${++run}`, allowSelfDisable: true, retry: { sleep: async () => {} } });
  const client = new CloudRepo({ owner: 'founder', name: 'agent-empire-state' }, TOKEN, gh.fetch);
  await client.submit({ kind: 'empire_action', action: { kind: 'found', sites: ['hospital', 'cafe'] } }, 'agent-empire-intent', t0 + 1000);
  await tick(t0 + 60_000);
  const snap = await client.poll();
  const rev = snap.changed ? snap.snapshot.state.meta.configRevision : 0;
  const titles = ['Fix the checkout total rounding', 'Write the clinic intake form', 'Draft the café menu page', 'Add a status badge to the README', 'Translate the onboarding emails'];
  const ids = titles.map((_, i) => uuidv7(t0 + 120_000 + i));
  for (const [i, title] of titles.entries())
    await client.submit({ kind: 'new_job', job: { id: ids[i], title, prompt: `${title}. Work on a branch and open a pull request.`, ...(i === 1 ? { site: 'hospital' as const } : i === 2 ? { site: 'cafe' as const } : {}), configRevision: rev, confirmPaid: true } }, 'agent-empire-intent', t0 + 120_000 + i);
  await tick(t0 + 180_000); // dispatches 3 (maxConcurrent)
  provider.finish(ids[0], 'end_turn', 180);
  provider.finish(ids[1], 'end_turn', 95);
  await tick(t0 + 40 * 60_000);
  await client.submit({ kind: 'review', jobId: ids[1], decision: 'accept' }, 'agent-empire-intent', t0 + 41 * 60_000);
  await tick(t0 + 50 * 60_000);
  await tick(now - 12 * 60_000); // the last committed snapshot: 12 minutes old
  return { gh, provider, ids, titles };
}

