/** Regression tests for the independent review of 675677e (each failed before its fix). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicCloudAdapter } from '../src/cloud/anthropic-adapter';
import { coordinatorWorkflow, PINNED_ACTIONS } from '../src/cloud/workflow';
import { holdsSlot, initialCloudState, LIMITS, promptHash, serializeState, STATE_FILES, type CloudJob, type CloudState } from '../src/cloud/schema';
import { MemoryStateStore, updateWithRetry } from '../src/cloud/store';
import { intentPath } from '../src/cloud/intents';
import { EXECUTION, FakeProvider, harness, intent, job, makeStore, newJob, push, T0, uuid } from './cloud-fixtures';

const DAY = 24 * 3600_000;
function finalJob(n: number, updatedAt: number, status: CloudJob['status'] = 'accepted'): CloudJob {
  return {
    id: uuid(n), title: `Old ${n}`, promptPreview: 'old', promptHash: promptHash('old'), intentId: uuid(500_000 + n),
    createdAt: updatedAt - 1000, updatedAt, configRevision: 0, authorizedCents: 100, status, message: 'done',
    provider: 'anthropic', repository: EXECUTION.repository, branch: `agent-empire/task-${uuid(n)}`, outputs: 'unverified',
    sessionId: `sesn_old${n.toString().padStart(6, '0')}`, providerStatus: 'archived', reservation: { cents: 100, day: '2026-09-01', basis: 'per_job_allowance_estimate' },
  };
}

// ---- 2. bounded hot state

test('review fix 2: finished jobs and dispatched prompts leave the hot file; queue and review backlog are capped', async () => {
  const h = harness(makeStore({ mutate: state => {
    for (let n = 1; n <= 230; n++) state.jobs.jobs.push(finalJob(n, T0 - 3600_000 + n));
    state.jobs.jobs.push(finalJob(900, T0 - 15 * DAY, 'rejected')); // older than 14 days
  } }));
  const prompt = 'Implement the feature. '.repeat(800); // ~18 KB
  push(h.store, newJob(1, 1000, { prompt }));
  await h.tick();
  let state = await h.state();
  const finals = state.jobs.jobs.filter(j => ['accepted', 'rejected'].includes(j.status));
  assert.equal(finals.length, LIMITS.finalRetained);
  assert.ok(!finals.some(j => j.id === uuid(900)), 'jobs older than 14 days are archived');
  const archives = Object.keys(h.store.files).filter(p => p.startsWith('archive/jobs/'));
  assert.equal(archives.length, 1);
  assert.equal(JSON.parse(h.store.files[archives[0]]).jobs.length, 31);
  const dispatched = job(state, 1000);
  assert.equal(dispatched.status, 'running');
  assert.equal(dispatched.prompt, undefined, 'the full prompt leaves the hot file once dispatched');
  assert.equal(h.store.files[dispatched.promptArchive!], prompt.trim());
  assert.ok(!h.store.files[STATE_FILES.jobs].includes(prompt.trim()), 'only the 200-character preview stays');

  // Queue cap: the 51st waiting job is rejected with a reason instead of growing the file.
  const full = harness(makeStore({ limits: { maxConcurrent: 1, perTaskBudgetCents: 100, dailyBudgetCents: 100 }, mutate: state => {
    for (let n = 1; n <= LIMITS.queuedJobs; n++) state.jobs.jobs.push({ ...finalJob(n, T0), status: 'queued', prompt: `p${n}`, providerStatus: undefined, sessionId: undefined, reservation: undefined });
  } }));
  push(full.store, newJob(1, 2000));
  const report = await full.tick();
  assert.equal(report.intents[0].outcome, 'rejected');
  assert.match(report.intents[0].reason!, /At most 50 jobs/);
});

test('review fix 2: worst-case hot jobs file stays far below the 4 MB read limit', () => {
  const state: CloudState = initialCloudState(T0, { execution: EXECUTION });
  const big = 'x'.repeat(20_000);
  let n = 0;
  for (let i = 0; i < LIMITS.queuedJobs; i++) state.jobs.jobs.push({ ...finalJob(++n, T0), status: 'queued', prompt: big, providerStatus: undefined, sessionId: undefined, reservation: undefined });
  for (let i = 0; i < 10; i++) state.jobs.jobs.push({ ...finalJob(++n, T0), status: 'running', providerStatus: 'running', message: 'm'.repeat(2000) });
  for (let i = 0; i < LIMITS.unreviewedJobs; i++) state.jobs.jobs.push({ ...finalJob(++n, T0), status: 'awaiting_review', message: 'm'.repeat(2000) });
  for (let i = 0; i < LIMITS.finalRetained; i++) state.jobs.jobs.push({ ...finalJob(++n, T0), message: 'm'.repeat(2000) });
  assert.ok(state.jobs.jobs.length <= LIMITS.hotJobs);
  const bytes = new TextEncoder().encode(serializeState(state)[STATE_FILES.jobs]).length;
  assert.ok(bytes < 3 * 1024 * 1024, `jobs.json worst case ${bytes} bytes`);
});

// ---- 3. finished turns are archived only with a pushed branch, and only after commit 1

test('review fix 3a: a finished turn without a pushed branch keeps its session and slot until the user decides', async () => {
  const h = harness(makeStore({ limits: { maxConcurrent: 1, perTaskBudgetCents: 100, dailyBudgetCents: 1000 } }));
  push(h.store, newJob(1, 1), newJob(2, 2));
  await h.tick();
  h.provider.branches.set(uuid(1), 'missing');
  h.provider.finish(uuid(1));
  await h.tick(); await h.tick();
  let state = await h.state();
  assert.equal(job(state, 1).status, 'awaiting_review');
  assert.match(job(state, 1).message, /not found.*left open/);
  assert.ok(!h.provider.calls.some(c => c.startsWith('archive')), 'no archive while the branch is missing');
  assert.ok(holdsSlot(job(state, 1)));
  assert.equal(job(state, 2).status, 'queued', 'the open session keeps its slot');
  h.provider.branches.set(uuid(1), 'unchanged');
  await h.tick();
  assert.ok(!h.provider.calls.some(c => c.startsWith('archive')), 'a branch still at the source commit is not a push');
  h.provider.branches.set(uuid(1), 'e'.repeat(40));
  await h.tick();
  state = await h.state();
  assert.ok(h.provider.calls.includes(`archive:${h.provider.sessionFor(uuid(1))}`));
  assert.equal(job(state, 1).status, 'awaiting_review');
  assert.deepEqual(job(state, 1).branchHead, { sha: 'e'.repeat(40), observedAt: h.now });
  await h.tick();
  state = await h.state();
  assert.equal(job(state, 2).status, 'running');

  // The user can also decide on an open session: accepting archives it.
  h.provider.branches.set(uuid(2), 'missing');
  h.provider.finish(uuid(2));
  await h.tick();
  push(h.store, intent(9, { kind: 'review', jobId: uuid(2), decision: 'accept' }));
  await h.tick();
  state = await h.state();
  assert.equal(job(state, 2).status, 'accepted');
  assert.ok(h.provider.calls.includes(`archive:${h.provider.sessionFor(uuid(2))}`));
  assert.equal(job(state, 2).providerStatus, 'archived');
});

test('review fix 3b: archive happens only after the finished turn is committed; a failed commit archives nothing', async () => {
  const store = makeStore();
  const h = harness(store);
  push(store, newJob(1, 1));
  await h.tick();
  h.provider.finish(uuid(1));
  const original = store.commit.bind(store);
  store.commit = async () => ({ ok: false, reason: 'conflict' } as const);
  await assert.rejects(h.tick());
  assert.ok(!h.provider.calls.some(c => c.startsWith('archive')), 'nothing is archived when commit 1 fails');
  store.commit = original;
  await h.tick();
  const state = await h.state();
  assert.equal(job(state, 1).status, 'awaiting_review');
  assert.ok(h.provider.calls.some(c => c.startsWith('archive')));
});

test('review fix 3b: an archived session whose saved cursor shows end_turn is reviewable, not cancelled', async () => {
  const h = harness(makeStore());
  push(h.store, newJob(1, 1));
  await h.tick();
  const session = h.provider.sessionFor(uuid(1))!;
  // Simulate a previous run that archived after observing end_turn but whose receipt was lost.
  const files = h.store.files;
  const jobs = JSON.parse(files[STATE_FILES.jobs]);
  jobs.jobs[0].cursor = { stopReason: 'end_turn' };
  h.store.push([{ path: STATE_FILES.jobs, content: JSON.stringify(jobs) }], 'simulated earlier observation');
  const s = h.provider.sessions.get(session)!; s.status = 'terminated'; s.archived = true;
  await h.tick();
  const state = await h.state();
  assert.equal(job(state, 1).status, 'awaiting_review');
});

test('review fix 3c: archived_at marks a session archived even when its status still reads idle', async () => {
  const fetchFake = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/events')) return new Response(JSON.stringify({ data: [], next_page: null }), { status: 200 });
    return new Response(JSON.stringify({ id: 'sesn_fixture1', status: 'idle', archived_at: '2026-09-30T12:00:00Z', budget: { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } } }), { status: 200 });
  }) as typeof fetch;
  const adapter = new AnthropicCloudAdapter({ apiKey: 'k', githubToken: 'github_pat_x' }, { fetch: fetchFake });
  const { observation } = await adapter.observe('sesn_fixture1', {});
  assert.equal(observation.providerStatus, 'archived');
  assert.equal(observation.status, 'cancelled');
});

// ---- 4. schedule cost

test('review fix 4: default schedule is every 30 minutes and the monthly estimate is recorded for setup', () => {
  assert.match(coordinatorWorkflow(), /- cron: '\*\/30 \* \* \* \*'/);
  assert.match(coordinatorWorkflow({ intervalMinutes: 15 }), /- cron: '\*\/15 \* \* \* \*'/);
  assert.match(coordinatorWorkflow({ intervalMinutes: 60 }), /- cron: '7 \* \* \* \*'/);
  assert.throws(() => coordinatorWorkflow({ intervalMinutes: 5 }));
  assert.deepEqual(initialCloudState(T0).meta.schedule, { intervalMinutes: 30, runsPerMonth: 1440, billedMinutesPerMonth: 1440, basis: 'estimate_scheduled_runs_only' });
  assert.equal(initialCloudState(T0, { intervalMinutes: 60 }).meta.schedule.runsPerMonth, 720);
  const yaml = coordinatorWorkflow();
  assert.ok(yaml.includes(`actions/checkout@${PINNED_ACTIONS.checkout.sha} # v4`) && yaml.includes(`actions/setup-node@${PINNED_ACTIONS.setupNode.sha} # v4`));
  assert.ok(!/uses: [^\n]*@v\d/.test(yaml), 'no floating tags');
  assert.ok(/^[a-f0-9]{40}$/.test(PINNED_ACTIONS.checkout.sha) && /^[a-f0-9]{40}$/.test(PINNED_ACTIONS.setupNode.sha));
});

// ---- 5. no commit per run

test('review fix 5: idle runs do not commit; a heartbeat is written at most hourly into its own small file', async () => {
  const h = harness(makeStore());
  push(h.store, newJob(1, 1));
  await h.tick();
  h.provider.finish(uuid(1)); h.advance(60_000);
  await h.tick(); // records the finished turn and archives it
  const commits = h.store.commits.length;
  h.advance(30 * 60_000);
  const quiet = await h.tick();
  assert.equal(quiet.commits, 0);
  assert.equal(h.store.commits.length, commits, 'nothing changed: no commit');
  const processedBefore = h.store.files[STATE_FILES.processed];
  h.advance(31 * 60_000);
  await h.tick();
  assert.equal(h.store.commits.length, commits + 1, 'hourly heartbeat');
  const heartbeat = JSON.parse(h.store.files[STATE_FILES.heartbeat]);
  assert.equal(heartbeat.lastRunAt, h.now);
  assert.equal(h.store.files[STATE_FILES.processed], processedBefore, 'processed intents are not rewritten by a heartbeat');
  assert.ok(!h.store.files[STATE_FILES.meta].includes('processedIntents') && !h.store.files[STATE_FILES.meta].includes('lastRunAt'));
  // City time missed by skipped commits is settled at the next commit (within the settlement cap).
  const state = await h.state();
  assert.equal(state.empire.minutes, 480 + (h.now - T0) / 1000);
});

// ---- 6. sticky manager readiness

test('review fix 6: a ready manager is not demoted by later sector jobs', async () => {
  const h = harness(makeStore({ limits: { maxConcurrent: 1, perTaskBudgetCents: 100, dailyBudgetCents: 1000 } }));
  push(h.store, intent(1, { kind: 'empire_action', action: { kind: 'found', sites: ['cafe'] } }), newJob(2, 1, { site: 'cafe' }));
  await h.tick();
  h.provider.finish(uuid(1));
  await h.tick(); await h.tick();
  let state = await h.state();
  const cafe = () => state.empire.sectors.find(s => s.id === 'cafe')!.manager!;
  assert.equal(cafe().status, 'ready');
  h.advance(60_000); // later jobs are newer than the startup brief
  h.provider.failNext = ['not_sent', 'not_sent', 'not_sent'];
  push(h.store, newJob(3, 2, { site: 'cafe' }), newJob(4, 3, { site: 'cafe' }));
  await h.tick();
  state = await h.state();
  assert.equal(cafe().status, 'ready', 'a queued later job does not demote');
  push(h.store, intent(5, { kind: 'cancel', jobId: uuid(3) }));
  await h.tick(); await h.tick(); await h.tick();
  state = await h.state();
  assert.equal(job(state, 2).status, 'failed', 'three not-sent dispatch failures');
  assert.equal(job(state, 3).status, 'cancelled');
  assert.equal(cafe().status, 'ready', 'cancelled/failed later jobs do not demote');
  assert.equal(cafe().taskId, uuid(1));
});

// ---- quick fixes

test('review quick fix: a truncated batch processes the oldest intents first, not the first paths', async () => {
  const state = initialCloudState(T0, { execution: EXECUTION });
  const store = new MemoryStateStore(serializeState(state), 2);
  const h = harness(store);
  // Path order: a < b < c. Creation order: c, b, a.
  const make = (id: string, createdAt: number, jobN: number) => ({ ...newJob(0, jobN), id, createdAt });
  const a = make('00000000-0000-4000-8000-00000000000a', T0 + 30, 1);
  const b = make('00000000-0000-4000-8000-00000000000b', T0 + 20, 2);
  const c = make('00000000-0000-4000-8000-00000000000c', T0 + 10, 3);
  push(store, a, b, c);
  const report = await h.tick();
  assert.deepEqual(report.intents.map(i => i.id), [c.id, b.id]);
  assert.equal(report.intentsTruncated, true);
  assert.deepEqual(Object.keys(store.files).filter(p => p.startsWith('intents/')), [intentPath(a.id)]);
});

test('review quick fix: commit retries back off exponentially', async () => {
  const store = new MemoryStateStore(serializeState(initialCloudState(T0)));
  store.commit = async () => ({ ok: false, reason: 'conflict' } as const);
  const delays: number[] = [];
  await assert.rejects(updateWithRetry(store, () => ({ changes: [{ path: 'state/x.json', content: '1' }], message: 'm', value: 1 }), { maxAttempts: 4, sleep: async ms => { delays.push(ms); } }));
  assert.deepEqual(delays, [250, 500, 1000]);
});

test('review fix 1: an oversized intent in the in-memory store is rejected and deleted without blocking others', async () => {
  const h = harness(makeStore());
  const huge = { ...newJob(1, 1), job: { ...(newJob(1, 1) as any).job, title: 'x'.repeat(70_000) } };
  push(h.store, huge, intent(2, { kind: 'shutdown' }));
  const report = await h.tick();
  assert.deepEqual(report.intents.map(i => [i.id, i.outcome]), [[huge.id, 'rejected'], [uuid(100_002), 'applied']]);
  assert.deepEqual(Object.keys(h.store.files).filter(p => p.startsWith('intents/')), []);
  assert.equal((await h.state()).meta.lifecycle.status, 'shutdown');
});

test('fixture sanity', () => { assert.ok(new FakeProvider().canDispatch); });
