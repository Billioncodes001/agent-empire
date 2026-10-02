import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ITEM_ESTIMATE, estimateJob, historyFromTaskCosts, percentile, type CostSample } from '../src/server/estimate.js';
import { defaultApprovedBudget } from '../src/shared/org.js';

const MIN = 60_000;
const sample = (costUsd: number, minutes: number, phase?: CostSample['phase']): CostSample => ({ costUsd, durationMs: minutes * MIN, phase });

test('percentile interpolates between ranks', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.25), 2);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.75), 4);
  assert.equal(percentile([10, 20], 0.25), 12.5);
  assert.equal(percentile([7], 0.75), 7);
});

test('fewer than three samples fall back to the stated default', () => {
  const est = estimateJob([{}], [sample(1, 10), sample(2, 20)], { maxWorkers: 2, now: 5 });
  assert.equal(est.basis.source, 'default');
  assert.equal(est.items[0].basis.source, 'default');
  assert.equal(est.items[0].basis.samples, 2, 'the basis still says how many samples exist');
  assert.deepEqual(est.items[0].costUsd, DEFAULT_ITEM_ESTIMATE.costUsd);
  assert.deepEqual(est.items[0].durationMs, DEFAULT_ITEM_ESTIMATE.durationMs);
  assert.equal(est.items[0].phase, 'build');
  assert.equal(est.estimatedAt, 5);
});

test('history gives a p25–p75 cost and duration per item', () => {
  const history = [sample(1, 10), sample(2, 20), sample(3, 30), sample(4, 40), sample(5, 50)];
  const est = estimateJob([{ phase: 'build' }], history, { maxWorkers: 1 });
  assert.equal(est.basis.source, 'history');
  assert.deepEqual(est.basis, { samples: 5, source: 'history' });
  assert.deepEqual(est.items[0].costUsd, { low: 2, high: 4 });
  assert.deepEqual(est.items[0].durationMs, { low: 20 * MIN, high: 40 * MIN });
});

test('items of a phase use that phase when it has enough history, else all history', () => {
  const history = [sample(10, 60, 'testing'), sample(10, 60, 'testing'), sample(10, 60, 'testing'), sample(1, 10), sample(1, 10), sample(1, 10)];
  const est = estimateJob([{ phase: 'testing' }, { phase: 'iteration' }], history, { maxWorkers: 2 });
  assert.deepEqual(est.items[0].costUsd, { low: 10, high: 10 });
  assert.equal(est.items[0].basis.samples, 3);
  // Iteration has no history of its own: the whole pool stands in, and says so by its sample count.
  assert.equal(est.items[1].basis.samples, 6);
  assert.equal(est.items[1].basis.source, 'history');
  assert.equal(est.items[1].phase, 'iteration');
});

test('the job sums its items and sequential items add up in calendar time', () => {
  const history = [sample(1, 10), sample(1, 10), sample(1, 10)];
  const est = estimateJob([{}, {}, {}], history, { maxWorkers: 3 });
  assert.deepEqual(est.costUsd, { low: 3, high: 3 });
  // Item N depends on N−1: three workers do not help.
  assert.deepEqual(est.calendarMs, { low: 30 * MIN, high: 30 * MIN });
});

test('parallel items overlap, limited by maxWorkers', () => {
  const history = [sample(1, 10), sample(1, 10), sample(1, 10)];
  const items = [{}, { parallel: true }, { parallel: true }, { parallel: true }];
  assert.deepEqual(estimateJob(items, history, { maxWorkers: 4 }).calendarMs, { low: 10 * MIN, high: 10 * MIN });
  assert.deepEqual(estimateJob(items, history, { maxWorkers: 2 }).calendarMs, { low: 20 * MIN, high: 20 * MIN });
  assert.deepEqual(estimateJob(items, history, { maxWorkers: 1 }).calendarMs, { low: 40 * MIN, high: 40 * MIN });
  // A paused queue (0) still estimates as if one worker were allowed.
  assert.deepEqual(estimateJob(items, history, { maxWorkers: 0 }).calendarMs, { low: 40 * MIN, high: 40 * MIN });
  // A sequential item after parallel ones waits only for its predecessor.
  const mixed = estimateJob([{}, { parallel: true }, {}], history, { maxWorkers: 2 });
  assert.deepEqual(mixed.calendarMs, { low: 20 * MIN, high: 20 * MIN });
});

test('approved budget defaults to the top of the range, rounded up', () => {
  assert.equal(defaultApprovedBudget({ costUsd: { low: 1, high: 7.01 } }), 8);
  assert.equal(defaultApprovedBudget({ costUsd: { low: 1, high: 7 } }), 7);
  assert.equal(defaultApprovedBudget({ costUsd: { low: 0, high: 0.2 } }), 1);
});

test('history comes only from finished, successful tasks with recorded spend', () => {
  const samples = historyFromTaskCosts(
    [
      { taskId: 'a', costUsd: 2, startedAt: 0, finishedAt: 10 * MIN, outcome: 'done', jobKey: 'consultancy:consultancy-aaaaaaaaaaaa:item-1' },
      { taskId: 'b', costUsd: 2, startedAt: 0, finishedAt: 10 * MIN, outcome: 'exited' },
      { taskId: 'c', costUsd: 0, startedAt: 0, finishedAt: 10 * MIN, outcome: 'done' },
      { taskId: 'd', costUsd: 3, startedAt: 0, outcome: undefined },
    ],
    (jobKey) => (jobKey?.startsWith('consultancy:') ? 'testing' : undefined),
  );
  assert.deepEqual(samples, [{ costUsd: 2, durationMs: 10 * MIN, phase: 'testing' }]);
});
