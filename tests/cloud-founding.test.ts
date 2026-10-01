/**
 * followups-1: founding in cloud mode. The plan's paid startup jobs, their cost against the snapshot's limits, and the
 * intents the cloud adapter writes, applied by the real coordinator tick (FakeProvider; no network, no paid calls).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubStateStore } from '../src/cloud/store';
import { installStateRepository } from '../src/cloud/installer';
import { parseIntent } from '../src/cloud/intents';
import { runCoordinatorTick } from '../src/cloud/tick';
import { initialCloudState } from '../src/cloud/schema';
import { TASK_ID } from '../src/server/execution-validation';
import { initialEmpire, managerStartupPrompt, MANAGER_NAMES } from '../src/shared/empire';
import { CloudNet } from '../src/client/cloud/net';
import { foundingBriefs, foundingJobId, foundingSpend } from '../src/client/cloud/founding-plan';
import { EXECUTION, FakeProvider, T0 } from './cloud-fixtures';
import { FakeGitHub } from './fake-github';

const FULL = 'founder/agent-empire-state';
const REPO = { owner: 'founder', name: 'agent-empire-state' };
const encrypt = async (key: string, value: string) => `sealed(${key}):${Buffer.from(value).toString('base64').split('').reverse().join('')}`;

test('the server startup brief is unchanged by the shared prompt helper', () => {
  const name = MANAGER_NAMES.hospital;
  assert.equal(
    managerStartupPrompt('hospital', name, 'server'),
    `Sector: Healthcare / Harbour hospital\n\nYou are ${name}, an appointed manager in Agent Empire. This is a bounded startup task in the user's real project. Inspect the project and write a concise administrative brief to docs/empire/hospital-brief.md. Identify useful real AI tasks this sector could perform for this project, dependencies and questions for the founder. Coordinate your sector with the chief of staff. Do not invent completed work, actual revenue, medical services or external activity. Do not start background jobs or contact anyone. Finish after producing the brief; the server handles ongoing simulation monitoring.`,
  );
  assert.match(managerStartupPrompt('hq', MANAGER_NAMES.hq, 'coordinator'), /As chief of staff[\s\S]*the cloud coordinator in the user’s GitHub handles ongoing simulation monitoring\.$/);
});

test('founding briefs: chief of staff plus each selected or existing site, never the residence or a ready manager', () => {
  const empire = initialEmpire(T0);
  const briefs = foundingBriefs(empire, ['cafe', 'hospital']);
  assert.deepEqual(briefs.map((b) => b.site), ['hq', 'hospital', 'cafe'], 'one per appointed manager, in site order');
  assert.ok(briefs.every((b) => b.title.endsWith(': startup brief') && b.prompt.startsWith('Sector: ')));
  assert.equal(foundingBriefs(empire, []).length, 1, 'the chief of staff alone');
  empire.sectors.find((s) => s.id === 'hq')!.manager = { id: 'm', name: 'Alex', status: 'ready', attempt: 1, jobKey: 'k' };
  assert.deepEqual(foundingBriefs(empire, ['school']).map((b) => b.site), ['school']);
});

test('founding spend: per-job allowance times jobs, against what is left of the daily admission allowance', () => {
  const state = initialCloudState(T0, { limits: { maxConcurrent: 2, perTaskBudgetCents: 500, dailyBudgetCents: 1200 }, execution: EXECUTION });
  const s = foundingSpend(state, 3, T0);
  assert.equal(s.totalCents, 1500);
  assert.equal(s.leftTodayCents, 1200);
  assert.equal(s.fitsToday, false, 'the third job would wait for the next UTC day');
  assert.equal(s.maxConcurrent, 2);
  assert.equal(foundingSpend(state, 2, T0).fitsToday, true);
});

test('founding job ids are stable per Empire and site, and valid job ids for the coordinator', async () => {
  const state = initialCloudState(T0, { execution: EXECUTION });
  const a = await foundingJobId(FULL, state, 'hq');
  assert.equal(a, await foundingJobId('Founder/Agent-Empire-State', state, 'hq'));
  assert.notEqual(a, await foundingJobId(FULL, state, 'cafe'));
  assert.ok(TASK_ID.test(a));
  assert.equal(a[14], '8');
});

test('cloud founding writes the city action and one confirmed paid job per manager; a repeat never queues twice', async () => {
  const gh = new FakeGitHub();
  await installStateRepository(new GitHubClient('ghu_user', { fetch: gh.fetch }), {
    secrets: { ANTHROPIC_API_KEY: 'sk-ant-fixture' }, limits: { maxConcurrent: 1, perTaskBudgetCents: 100, dailyBudgetCents: 500 },
    execution: EXECUTION, coordinatorBundle: '// bundle\n', now: T0, sleep: async () => {},
  }, encrypt);
  const coordinator = new GitHubStateStore(new GitHubClient('ghs_actions', { fetch: gh.fetch }), { owner: 'founder', repo: 'agent-empire-state', branch: 'main', workflowFile: 'agent-empire.yml' });
  const provider = new FakeProvider();
  let run = 0, now = T0 + 1000;
  const tick = (at: number) => runCoordinatorTick({ store: coordinator, provider, now: () => at, runId: `run-${++run}`, allowSelfDisable: false, retry: { sleep: async () => {} } });
  const notes: string[] = [];
  const net = new CloudNet({ repo: REPO, token: 'ghu_user' }, () => ({ name: 'A', color: '#fff', look: {} as never }), { fetch: gh.fetch, now: () => now++, visible: () => true, notify: (t) => notes.push(t) });
  try {
    await net.pollNow();
    const state = net.info.snapshot!.state;
    const briefs = foundingBriefs(state.empire, ['hospital']);
    const result = await net.found(['hospital'], briefs, state.meta.configRevision);
    assert.deepEqual(result, { founded: true, queued: 2, failed: [] });
    assert.equal(notes.length, 1, 'one summary instead of a toast per intent');
    assert.match(notes[0], /Founding plan and 2 startup jobs sent/);
    const intents = Object.entries(gh.files(FULL)).filter(([p]) => p.startsWith('intents/')).map(([p, t]) => parseIntent(p, t));
    assert.equal(intents.length, 3);
    assert.deepEqual(intents.filter((i) => i.kind === 'empire_action').map((i) => i.kind === 'empire_action' && i.action), [{ kind: 'found', sites: ['hospital'] }]);
    const jobs = intents.flatMap((i) => (i.kind === 'new_job' ? [i.job] : []));
    assert.deepEqual(jobs.map((j) => j.site).sort(), ['hospital', 'hq']);
    assert.ok(jobs.every((j) => j.confirmPaid === true && j.configRevision === state.meta.configRevision));
    assert.equal(gh.repos.get(FULL)!.dispatches.length, 3);
    assert.equal(provider.sessions.size, 0, 'the app never calls the provider');

    await tick(T0 + 60_000);
    await net.pollNow();
    const after = net.info.snapshot!.state;
    assert.equal(after.empire.setup.completed, true);
    assert.deepEqual(after.jobs.jobs.map((j) => j.site).sort(), ['hospital', 'hq']);
    assert.ok(after.jobs.jobs.every((j) => j.authorizedCents === 100), 'each job holds the per-job allowance the user confirmed');
    assert.ok(['queued', 'working'].includes(after.empire.sectors.find((s) => s.id === 'hospital')!.manager!.status));

    // The same plan sent again (a second device, or a reload before the run): the jobs are duplicates.
    await net.found(['hospital'], briefs, state.meta.configRevision);
    await tick(T0 + 120_000);
    await net.pollNow();
    assert.equal(net.info.snapshot!.state.jobs.jobs.length, 2, 'no second payment for the same startup briefs');
  } finally {
    net.stop();
  }
});

test('cloud founding without execution settings records the plan only', async () => {
  const gh = new FakeGitHub();
  await installStateRepository(new GitHubClient('ghu_user', { fetch: gh.fetch }), {
    secrets: { ANTHROPIC_API_KEY: 'sk-ant-fixture' }, limits: { maxConcurrent: 1, perTaskBudgetCents: 100, dailyBudgetCents: 500 },
    coordinatorBundle: '// bundle\n', now: T0, sleep: async () => {},
  }, encrypt);
  const notes: string[] = [];
  const net = new CloudNet({ repo: REPO, token: 'ghu_user' }, () => ({ name: 'A', color: '#fff', look: {} as never }), { fetch: gh.fetch, now: () => T0 + 1000, visible: () => true, notify: (t) => notes.push(t) });
  try {
    await net.pollNow();
    const state = net.info.snapshot!.state;
    assert.equal(state.meta.execution, undefined);
    assert.deepEqual(await net.found(['cafe'], [], state.meta.configRevision), { founded: true, queued: 0, failed: [] });
    const kinds = Object.entries(gh.files(FULL)).filter(([p]) => p.startsWith('intents/')).map(([p, t]) => parseIntent(p, t).kind);
    assert.deepEqual(kinds, ['empire_action']);
    assert.match(notes[0], /Founding plan: sent/);
  } finally {
    net.stop();
  }
});
