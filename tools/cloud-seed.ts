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

/** A new Empire whose coordinator has run once and whose city is not founded yet (execution configured). */
export async function seedUnfounded() {
  const gh = new FakeGitHub();
  const now = Date.now();
  await installStateRepository(new GitHubClient(TOKEN, { fetch: gh.fetch }), {
    secrets: { ANTHROPIC_API_KEY: 'sk-ant-fixture' }, limits: { maxConcurrent: 3, perTaskBudgetCents: 500, dailyBudgetCents: 2000 },
    execution: EXECUTION, coordinatorBundle: '// bundle\n', now: now - 20 * 60_000, sleep: async () => {},
  }, async (k, v) => `sealed(${k}):${Buffer.from(v).toString('base64').split('').reverse().join('')}`);
  const store = new GitHubStateStore(new GitHubClient('ghs_actions', { fetch: gh.fetch }), { owner: 'founder', repo: 'agent-empire-state', branch: 'main', workflowFile: 'agent-empire.yml' });
  const provider = new FakeProvider();
  let run = 0;
  const tick = (at: number) => runCoordinatorTick({ store, provider, now: () => at, runId: `seed-unfounded-${++run}`, allowSelfDisable: true, retry: { sleep: async () => {} } });
  await tick(now - 5 * 60_000);
  return { gh, provider, tick };
}

/**
 * A brand-new Empire as setup leaves it with an Anthropic key: execution is only requested (`provisioning`), and the
 * coordinator has not run yet. `tick` runs it once with a fake provider whose setup succeeds (no network).
 */
export async function seedProvisioning(opts: { provision?: boolean } = {}) {
  const gh = new FakeGitHub();
  const now = Date.now();
  await installStateRepository(new GitHubClient(TOKEN, { fetch: gh.fetch }), {
    secrets: { ANTHROPIC_API_KEY: 'sk-ant-fixture' }, limits: { maxConcurrent: 3, perTaskBudgetCents: 500, dailyBudgetCents: 2000 },
    ...(opts.provision === false ? {} : { provision: EXECUTION.repository }), coordinatorBundle: '// bundle\n', now: now - 2 * 60_000, sleep: async () => {},
  }, async (k, v) => `sealed(${k}):${Buffer.from(v).toString('base64').split('').reverse().join('')}`);
  const store = new GitHubStateStore(new GitHubClient('ghs_actions', { fetch: gh.fetch }), { owner: 'founder', repo: 'agent-empire-state', branch: 'main', workflowFile: 'agent-empire.yml' });
  const provider = new FakeProvider();
  let run = 0;
  const tick = (at: number) => runCoordinatorTick({ store, provider, now: () => at, runId: `seed-provision-${++run}`, allowSelfDisable: true, retry: { sleep: async () => {} } });
  return { gh, provider, tick };
}

/**
 * The seed's coordinator times: normally 3 hours back to 12 minutes ago, but always inside one UTC day (the day of the
 * last snapshot), so daily allowances never reset mid-seed and the checks don't depend on the time of day. Early in a
 * UTC day the steps are compressed proportionally; their order never changes.
 */
export function seedTimeline(now: number) {
  const last = now - 12 * 60_000;
  const dayStart = Date.parse(new Date(last).toISOString().slice(0, 10) + "T00:00:00Z");
  const t0 = Math.max(now - 3 * 3600_000, dayStart + 1);
  const span = 51 * 60_000; // the latest step offset (50 min) plus a margin
  const scale = Math.min(1, Math.max(0, last - t0 - 2) / span);
  // Re-review note: the checks' own later ticks use after(ms) (ms after the last seeded tick), which stays inside the
  // same UTC day: near midnight the offsets are compressed into what is left of the day.
  const dayEnd = dayStart + 24 * 3600_000 - 1;
  const afterSpan = 10 * 60_000;
  const afterScale = Math.min(1, Math.max(0, dayEnd - last - 1) / afterSpan);
  return { t0, last, at: (offset: number) => t0 + 1 + Math.floor(offset * scale), after: (ms: number) => last + Math.floor(ms * afterScale) + (ms > 0 && afterScale < 1 ? 1 : 0) };
}

/** A state repository as a coordinator leaves it: founded city, jobs in several states, spend, journal. */
export async function seed() {
  const gh = new FakeGitHub();
  const now = Date.now();
  const tl = seedTimeline(now);
  const t0 = tl.t0;
  await installStateRepository(new GitHubClient(TOKEN, { fetch: gh.fetch }), {
    secrets: { ANTHROPIC_API_KEY: 'sk-ant-fixture' }, limits: { maxConcurrent: 3, perTaskBudgetCents: 500, dailyBudgetCents: 2000 },
    execution: EXECUTION, coordinatorBundle: '// bundle\n', now: t0, sleep: async () => {},
  }, async (k, v) => `sealed(${k}):${Buffer.from(v).toString('base64').split('').reverse().join('')}`);
  const store = new GitHubStateStore(new GitHubClient('ghs_actions', { fetch: gh.fetch }), { owner: 'founder', repo: 'agent-empire-state', branch: 'main', workflowFile: 'agent-empire.yml' });
  const provider = new FakeProvider();
  let run = 0;
  const tick = (at: number) => runCoordinatorTick({ store, provider, now: () => at, runId: `seed-${++run}`, allowSelfDisable: true, retry: { sleep: async () => {} } });
  const client = new CloudRepo({ owner: 'founder', name: 'agent-empire-state' }, TOKEN, gh.fetch);
  await client.submit({ kind: 'empire_action', action: { kind: 'found', sites: ['hospital', 'cafe'] } }, 'agent-empire-intent', tl.at(1000));
  await tick(tl.at(60_000));
  const snap = await client.poll();
  const rev = snap.changed ? snap.snapshot.state.meta.configRevision : 0;
  const titles = ['Fix the checkout total rounding', 'Write the clinic intake form', 'Draft the café menu page', 'Add a status badge to the README', 'Translate the onboarding emails'];
  const ids = titles.map((_, i) => uuidv7(tl.at(120_000) + i));
  for (const [i, title] of titles.entries())
    await client.submit({ kind: 'new_job', job: { id: ids[i], title, prompt: `${title}. Work on a branch and open a pull request.`, ...(i === 1 ? { site: 'hospital' as const } : i === 2 ? { site: 'cafe' as const } : {}), configRevision: rev, confirmPaid: true } }, 'agent-empire-intent', tl.at(120_000) + i);
  await tick(tl.at(180_000)); // dispatches 3 (maxConcurrent)
  provider.finish(ids[0], 'end_turn', 180);
  provider.finish(ids[1], 'end_turn', 95);
  await tick(tl.at(40 * 60_000));
  await client.submit({ kind: 'review', jobId: ids[1], decision: 'accept' }, 'agent-empire-intent', tl.at(41 * 60_000));
  await tick(tl.at(50 * 60_000));
  await tick(tl.last); // the last committed snapshot: 12 minutes old
  return { gh, provider, ids, titles, clock: tl };
}

