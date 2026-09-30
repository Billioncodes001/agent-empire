import test from 'node:test';
import assert from 'node:assert/strict';
import { intentPath } from '../src/cloud/intents';
import { reservedToday, runCoordinatorTick } from '../src/cloud/tick';
import { STATE_FILES } from '../src/cloud/schema';
import { ConflictRetriesExhausted } from '../src/cloud/store';
import { FakeProvider, harness, intent, job, makeStore, newJob, push, T0, uuid } from './cloud-fixtures';

const pending = (store: ReturnType<typeof makeStore>) => Object.keys(store.files).filter(path => path.startsWith('intents/'));

test('cloud tick: each intent is consumed once; replays and duplicates never create a second job', async () => {
  const h = harness(makeStore());
  const first = newJob(1, 1);
  push(h.store, first, newJob(2, 1)); // same job id and body from a retried client write
  const report = await h.tick();
  assert.deepEqual(report.intents.map(i => i.outcome), ['applied', 'duplicate']);
  assert.deepEqual(pending(h.store), [], 'consumed intent files are deleted in the same commit');
  let state = await h.state();
  assert.equal(state.jobs.jobs.length, 1);
  assert.equal(h.provider.calls.filter(c => c.startsWith('dispatch')).length, 1);
  // The same intent file re-appearing (e.g. a stale client re-push) is recognised and dropped.
  push(h.store, first);
  const replay = await h.tick();
  assert.deepEqual(replay.intents.map(i => i.outcome), ['duplicate']);
  state = await h.state();
  assert.equal(state.jobs.jobs.length, 1);
  assert.equal(h.provider.calls.filter(c => c.startsWith('dispatch')).length, 1);
  assert.deepEqual(state.meta.processedIntents.map(p => p.outcome), ['applied', 'duplicate'], 'an already-processed id is dropped without a second record');
});

test('cloud tick: invalid intents are consumed and journaled as rejected with a reason', async () => {
  const h = harness(makeStore());
  h.store.push([{ path: intentPath(uuid(100_001)), content: '{"broken"' }, { path: 'intents/not-a-uuid.json', content: '{}' }]);
  push(h.store, newJob(2, 5, { configRevision: 7 }), intent(3, { kind: 'review', jobId: uuid(9), decision: 'accept' }), newJob(4, 6), intent(5, { kind: 'new_job', job: { id: uuid(6), title: 'Other', prompt: 'Different', configRevision: 0, confirmPaid: true } } as any));
  const report = await h.tick();
  const rejected = report.intents.filter(i => i.outcome === 'rejected');
  assert.equal(rejected.length, 5);
  assert.match(rejected.find(i => i.id === uuid(100_002))!.reason!, /changed after this job was confirmed/);
  assert.match(rejected.find(i => i.id === uuid(100_003))!.reason!, /No such cloud job/);
  assert.match(rejected.find(i => i.id === uuid(100_005))!.reason!, /different submission/);
  assert.deepEqual(pending(h.store), []);
  const state = await h.state();
  assert.equal(state.jobs.jobs.length, 1);
  assert.equal(state.journal.entries.filter(e => e.kind === 'intent_rejected').length, 5);
});

test('cloud tick: concurrency, per-job and daily limits gate dispatch; nothing dispatches over budget', async () => {
  const h = harness(makeStore({ limits: { maxConcurrent: 2, perTaskBudgetCents: 100, dailyBudgetCents: 250 } }));
  push(h.store, newJob(1, 1), newJob(2, 2), newJob(3, 3));
  await h.tick();
  let state = await h.state();
  assert.deepEqual([1, 2, 3].map(n => job(state, n).status), ['running', 'running', 'queued']);
  assert.match(job(state, 3).message, /free slot/);
  assert.equal(job(state, 1).reservation!.basis, 'per_job_allowance_estimate');
  assert.equal(reservedToday(state, h.now), 200);
  // Finishing job 1 frees a slot, but 200 + 100 > 250: the daily admission limit blocks job 3.
  h.provider.finish(uuid(1)); h.advance(600_000);
  await h.tick();
  state = await h.state();
  assert.equal(job(state, 1).status, 'awaiting_review');
  assert.equal(job(state, 3).status, 'queued');
  assert.match(job(state, 3).message, /allowance is fully reserved/);
  // Next UTC day the allowance resets; the finished job's reservation no longer counts.
  h.advance(24 * 3600_000);
  await h.tick();
  state = await h.state();
  assert.equal(job(state, 3).status, 'running');
  assert.equal(h.provider.calls.filter(c => c.startsWith('dispatch')).length, 3);
  // Lowering the per-job allowance applies to later dispatches; a job never reserves more than confirmed.
  push(h.store, intent(10, { kind: 'limits', configRevision: 0, limits: { maxConcurrent: 3, perTaskBudgetCents: 60, dailyBudgetCents: 1000 } }));
  await h.tick();
  push(h.store, newJob(11, 4, { configRevision: 1 }));
  await h.tick();
  state = await h.state();
  assert.equal(job(state, 4).reservation!.cents, 60);
  assert.equal(state.ledger.days[job(state, 4).reservation!.day].reservedCents, 60 + 100 /* job 3 */);
});

test('cloud tick: poll outcomes map to review, approval, budget, failure and unknown without claiming success', async () => {
  const h = harness(makeStore({ limits: { maxConcurrent: 6, perTaskBudgetCents: 100, dailyBudgetCents: 10_000 } }));
  push(h.store, ...[1, 2, 3, 4, 5, 6].map(n => newJob(n, n)));
  h.provider.wrongBudget.add(uuid(6));
  await h.tick();
  let state = await h.state();
  assert.equal(job(state, 6).status, 'unknown', 'an unconfirmed session budget is never treated as running normally');
  h.provider.finish(uuid(1), 'end_turn', 55);
  h.provider.finish(uuid(2), 'requires_action');
  h.provider.finish(uuid(3), 'budget_reached', 100);
  h.provider.terminate(uuid(4));
  h.provider.failObserve.add(h.provider.sessionFor(uuid(5))!);
  h.advance(600_000);
  await h.tick();
  state = await h.state();
  assert.equal(job(state, 1).status, 'awaiting_review');
  assert.equal(job(state, 1).outputs, 'unverified');
  assert.ok(h.provider.calls.includes(`archive:${h.provider.sessionFor(uuid(1))}`), 'a finished turn is archived to release its slot');
  assert.deepEqual(job(state, 1).cost, { amountCents: 55, currency: 'USD', observedAt: h.now, basis: 'provider_reported_list_cost' });
  assert.equal(job(state, 2).status, 'waiting_for_approval');
  assert.equal(job(state, 3).status, 'budget_paused');
  assert.equal(job(state, 4).status, 'failed');
  assert.equal(job(state, 5).status, 'unknown');
  assert.match(job(state, 5).message, /reservations were kept/);
  assert.ok(job(state, 5).reservation && job(state, 5).sessionId);
  assert.equal(state.empire.economy.rewardedTasks.length, 0, 'no reward before the user reviews');
  assert.equal(state.ledger.days['2026-09-30'].observedCostCents, 55 + 40 + 100);
});

test('cloud tick: review accepts once for city credits; cancel stops sessions or unqueued work', async () => {
  const h = harness(makeStore({ limits: { maxConcurrent: 1, perTaskBudgetCents: 100, dailyBudgetCents: 1000 } }));
  push(h.store, intent(1, { kind: 'empire_action', action: { kind: 'found', sites: ['cafe'] } }), newJob(2, 1), newJob(3, 2), newJob(4, 3));
  await h.tick();
  push(h.store, intent(5, { kind: 'cancel', jobId: uuid(2) }), intent(6, { kind: 'cancel', jobId: uuid(1) }), intent(7, { kind: 'review', jobId: uuid(3), decision: 'accept' }));
  await h.tick();
  let state = await h.state();
  assert.equal(job(state, 2).status, 'cancelled');
  assert.ok(!job(state, 2).reservation, 'unqueued cancellation never reserved or spent anything');
  assert.equal(job(state, 1).status, 'cancelled');
  assert.ok(h.provider.calls.includes(`interrupt:${h.provider.sessionFor(uuid(1))}`));
  assert.match(state.journal.entries.find(e => e.intentId === uuid(100_007))!.message, /awaiting review/);
  assert.equal(job(state, 3).status, 'running', 'the freed slot is reused in the same tick');
  const fundsBefore = state.empire.funds;
  h.provider.finish(uuid(3));
  await h.tick();
  push(h.store, intent(8, { kind: 'review', jobId: uuid(3), decision: 'accept' }), intent(9, { kind: 'review', jobId: uuid(3), decision: 'accept' }));
  const report = await h.tick();
  assert.deepEqual(report.intents.map(i => i.outcome), ['applied', 'rejected']);
  state = await h.state();
  assert.equal(job(state, 3).status, 'accepted');
  assert.deepEqual(state.empire.economy.rewardedTasks, [uuid(3)]);
  assert.equal(state.empire.economy.revenue >= 500, true);
  assert.ok(state.empire.funds > fundsBefore - 1000, 'accepted work is credited in simulation credits');
  assert.equal(state.empire.economy.ledger.filter(e => e.label.startsWith('Accepted AI task')).length, 1);
});

test('cloud tick: lost creation responses become uncertain; not-sent failures requeue and release', async () => {
  const h = harness(makeStore());
  h.provider.failNext = ['sent', 'not_sent'];
  push(h.store, newJob(1, 1), newJob(2, 2));
  const report = await h.tick();
  assert.deepEqual(report.dispatched.map(d => d.outcome), ['uncertain', 'requeued']);
  let state = await h.state();
  assert.equal(job(state, 1).status, 'dispatch_uncertain');
  assert.ok(job(state, 1).reservation, 'an uncertain dispatch keeps its slot and reservation');
  assert.equal(job(state, 2).status, 'queued');
  assert.ok(!job(state, 2).reservation);
  await h.tick();
  state = await h.state();
  assert.equal(job(state, 1).status, 'dispatch_uncertain', 'never retried blindly');
  assert.equal(job(state, 2).status, 'running');
  assert.equal(h.provider.calls.filter(c => c === `dispatch:${uuid(1)}`).length, 1);
  push(h.store, intent(3, { kind: 'cancel', jobId: uuid(1) }), intent(4, { kind: 'resolve_uncertain', jobId: uuid(1), resolution: 'not_dispatched' }));
  const resolved = await h.tick();
  assert.deepEqual(resolved.intents.map(i => i.outcome), ['rejected', 'applied']);
  state = await h.state();
  assert.equal(job(state, 1).status, 'failed');
  assert.ok(!job(state, 1).reservation);
});

test('cloud tick: a run that died after marking dispatch leaves the job uncertain for the next run', async () => {
  const store = makeStore();
  push(store, newJob(1, 1));
  // Simulate a run that dies between the paid request and its receipt: every receipt commit fails.
  const commitsBefore = store.commits.length;
  const original = store.commit.bind(store);
  let calls = 0;
  store.commit = async (...args) => (++calls >= 2 ? { ok: false, reason: 'conflict' } as const : original(...args));
  const lines: string[] = [];
  await assert.rejects(runCoordinatorTick({ store, provider: new FakeProvider(), now: () => T0, runId: 'run-crashed', log: line => lines.push(line) }), ConflictRetriesExhausted);
  store.commit = original;
  assert.equal(store.commits.length, commitsBefore + 1);
  assert.ok(lines.some(line => line.startsWith(`UNSAVED dispatch receipt job=${uuid(1)} session=sesn_fake0001`)), 'the Actions log preserves the session id');
  const h = harness(store);
  let state = await h.state();
  assert.equal(job(state, 1).status, 'dispatching');
  await h.tick();
  state = await h.state();
  assert.equal(job(state, 1).status, 'dispatch_uncertain');
  assert.equal(h.provider.calls.filter(c => c.startsWith('dispatch')).length, 0);
});

test('cloud tick: shutdown stops sessions, halts dispatch and economy, disables the workflow; start resumes without catch-up', async () => {
  const h = harness(makeStore({ limits: { maxConcurrent: 1, perTaskBudgetCents: 100, dailyBudgetCents: 1000 } }));
  push(h.store, intent(1, { kind: 'empire_action', action: { kind: 'found', sites: ['cafe'] } }), newJob(2, 1, { site: 'cafe' }), newJob(3, 2));
  await h.tick();
  h.advance(300_000);
  push(h.store, intent(4, { kind: 'shutdown' }));
  await h.tick();
  let state = await h.state();
  const session = h.provider.sessionFor(uuid(1))!;
  assert.ok(h.provider.calls.includes(`interrupt:${session}`) && h.provider.calls.includes(`archive:${session}`));
  assert.equal(job(state, 1).status, 'cancelled');
  assert.equal(job(state, 2).status, 'queued');
  assert.equal(state.meta.lifecycle.status, 'shutdown');
  assert.equal(state.meta.lifecycle.workflow, 'disabled');
  assert.deepEqual(h.store.workflowCalls, [false]);
  const minutes = state.empire.minutes; const funds = state.empire.funds;
  // While shut down (e.g. a manual run), nothing is dispatched and the city clock does not move.
  h.advance(6 * 3600_000);
  await h.tick();
  state = await h.state();
  assert.equal(state.empire.minutes, minutes);
  assert.equal(state.empire.funds, funds);
  assert.equal(job(state, 2).status, 'queued');
  assert.equal(h.provider.calls.filter(c => c.startsWith('dispatch')).length, 1);
  push(h.store, intent(5, { kind: 'start' }));
  await h.tick();
  state = await h.state();
  assert.equal(state.meta.lifecycle.status, 'running');
  assert.equal(state.empire.minutes, minutes, 'six hours offline earned no catch-up time');
  assert.equal(job(state, 2).status, 'running');
  assert.ok(state.journal.entries.some(e => /earned no revenue/.test(e.message)));
});

test('cloud tick: if the workflow cannot disable itself the shutdown is recorded for the app to finish', async () => {
  const h = harness(makeStore());
  h.store.failWorkflowControl = true;
  push(h.store, intent(1, { kind: 'shutdown' }));
  await h.tick();
  const state = await h.state();
  assert.equal(state.meta.lifecycle.status, 'shutdown');
  assert.equal(state.meta.lifecycle.workflow, 'disable_requested');
  assert.ok(state.journal.entries.some(e => e.kind === 'warning'));
});

test('cloud tick: a client push during commit is retried from a fresh read without repeating provider calls', async () => {
  const h = harness(makeStore());
  push(h.store, newJob(1, 1));
  await h.tick();
  h.provider.finish(uuid(1));
  // A client writes a new intent after the coordinator read but before it commits.
  h.store.beforeNextCommit = () => push(h.store, newJob(2, 2));
  const reads = h.store.reads;
  const report = await h.tick();
  assert.ok(h.store.reads - reads >= 3, 'phase 1 re-read after the conflict');
  assert.equal(h.provider.calls.filter(c => c.startsWith('archive')).length, 1, 'provider stop/archive ran once');
  assert.deepEqual(report.intents.map(i => i.id), [uuid(100_002)], 'the concurrently pushed intent is applied in the retry');
  const state = await h.state();
  assert.equal(job(state, 1).status, 'awaiting_review');
  assert.equal(job(state, 2).status, 'running');
  assert.deepEqual(pending(h.store), []);
  assert.ok(!h.store.files[STATE_FILES.meta].includes('"revision": 0'));
});

test('cloud tick: missing credentials or execution config never dispatch', async () => {
  const provider = new FakeProvider(); provider.canDispatch = false;
  const h = harness(makeStore(), provider);
  push(h.store, newJob(1, 1));
  await h.tick();
  let state = await h.state();
  assert.equal(job(state, 1).status, 'queued');
  assert.match(job(state, 1).message, /missing/);
  const unconfigured = harness(makeStore({ execution: null }));
  push(unconfigured.store, newJob(1, 1));
  const report = await unconfigured.tick();
  assert.match(report.intents[0].reason!, /not configured/);
  state = await unconfigured.state();
  assert.equal(state.jobs.jobs.length, 0);
  assert.equal(provider.calls.length + unconfigured.provider.calls.length, 0);
});

test('cloud tick: identical inputs produce identical commits (deterministic)', async () => {
  const run = async () => {
    const h = harness(makeStore());
    push(h.store, intent(1, { kind: 'empire_action', action: { kind: 'found', sites: ['cafe', 'school'] } }), newJob(2, 1));
    await h.tick(); h.advance(900_000); h.provider.finish(uuid(1)); await h.tick();
    return h.store.files;
  };
  assert.deepEqual(await run(), await run());
  assert.ok(T0);
});
