import test from 'node:test';
import assert from 'node:assert/strict';
import { holdsSlot } from '../src/cloud/schema';
import { FakeProvider, harness, intent, job, makeStore, newJob, push, T0, uuid } from './cloud-fixtures';

const TICK = 10 * 60_000;

test('cloud scenario: the Empire progresses across coordinator runs with no client connected, and a returning client sees the current snapshot', async () => {
  const provider = new FakeProvider();
  const h = harness(makeStore({ limits: { maxConcurrent: 2, perTaskBudgetCents: 100, dailyBudgetCents: 2000 } }), provider);

  // A client connects once: founds the city, submits manager startup briefs and two project jobs, then leaves.
  push(h.store,
    intent(1, { kind: 'empire_action', action: { kind: 'found', sites: ['cafe', 'school'] } }),
    newJob(2, 1, { site: 'hq', title: 'Chief of staff brief' }),
    newJob(3, 2, { site: 'cafe', title: 'Café brief' }),
    newJob(4, 3, { site: 'school', title: 'Academy brief' }),
    newJob(5, 4, { title: 'Fix flaky test' }),
    newJob(6, 5, { title: 'Update docs' }));

  // Sessions finish one run after they start. No client writes anything during these runs.
  const startedAt = new Map<string, number>();
  let maxActive = 0;
  const original = provider.dispatch.bind(provider);
  provider.dispatch = async request => {
    const created = await original(request);
    startedAt.set(created.observation.sessionId, h.now);
    maxActive = Math.max(maxActive, [...provider.sessions.values()].filter(s => !s.archived && s.status !== 'terminated').length);
    return created;
  };
  const revisions: number[] = [];
  for (let run = 0; run < 12; run++) {
    for (const [session, at] of startedAt) {
      const s = provider.sessions.get(session)!;
      if (s.status === 'running' && h.now - at >= TICK) provider.finish(s.jobId, 'end_turn', 25);
    }
    const report = await h.tick();
    revisions.push(report.revision);
    h.advance(TICK);
  }

  const state = await h.state();
  assert.ok(revisions.every((revision, i) => i === 0 || revision > revisions[i - 1]), 'every run commits a newer revision');
  assert.equal(provider.calls.filter(c => c.startsWith('dispatch')).length, 5, 'each job dispatched exactly once');
  assert.ok(maxActive <= 2, `never more than the configured concurrency (saw ${maxActive})`);
  assert.deepEqual([1, 2, 3, 4, 5].map(n => job(state, n).status), Array(5).fill('awaiting_review'));
  assert.equal(state.jobs.jobs.filter(holdsSlot).length, 0);
  // City time advanced with coordinator uptime (1 s = 1 city minute), and managers whose briefs finished earn.
  assert.equal(state.empire.minutes, 480 + 11 * 600);
  for (const site of ['hq', 'cafe', 'school']) assert.equal(state.empire.sectors.find(s => s.id === site)!.manager!.status, 'ready', site);
  assert.ok(state.empire.economy.revenue > 0 && state.empire.economy.wages > 0);
  assert.equal(state.empire.economy.rewardedTasks.length, 0, 'no task reward until the user reviews');
  const identity = 100_000 + state.empire.economy.revenue - state.empire.economy.wages - state.empire.economy.upkeep - state.empire.economy.dividends - state.empire.economy.capital;
  assert.equal(state.empire.funds, identity, 'ECONOMY.md accounting identity holds');
  assert.equal(state.ledger.days['2026-09-30'].reservedCents, 500);
  assert.equal(state.ledger.days['2026-09-30'].observedCostCents, 125);

  // The client returns: it reads exactly the last committed snapshot and its age, not a live claim.
  const view = await h.view();
  assert.equal(view.sha, h.store.head.sha);
  assert.equal(view.state.meta.revision, revisions[revisions.length - 1]);
  assert.equal(view.snapshotAgeMs, TICK, 'age since the last coordinator commit');
  assert.deepEqual(view.pendingIntents, []);
  assert.ok(view.state.journal.entries.length > 0);

  // Reviewing one job credits the city once on the next run.
  push(h.store, intent(7, { kind: 'review', jobId: uuid(4), decision: 'accept' }), intent(8, { kind: 'review', jobId: uuid(5), decision: 'reject', note: 'Wrong file' }));
  await h.tick();
  const after = await h.state();
  assert.equal(job(after, 4).status, 'accepted');
  assert.equal(job(after, 5).status, 'rejected');
  assert.deepEqual(after.empire.economy.rewardedTasks, [uuid(4)]);
  assert.ok(T0 > 0);
});
