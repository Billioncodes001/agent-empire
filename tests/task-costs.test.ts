import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Ledger, taskCostObservations } from '../src/server/usage.js';
import type { QueueTask, Usage, WorkerInfo } from '../src/shared/protocol.js';

const u = (cost: number): Usage => ({ input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cost, calls: 1 });
const task = (id: string, extra: Partial<QueueTask> = {}): QueueTask => ({ id, title: id, prompt: id, addedBy: 'CEO', addedAt: 1, status: 'running', ...extra });
const worker = (id: string, cost?: number): WorkerInfo =>
  ({ id, kind: 'agent', deskId: 'desk-1', name: id, color: '#fff', status: 'working', acked: false, createdBy: 'CEO', createdAt: 1, cols: 80, rows: 24, viewers: [], usage: cost === undefined ? undefined : u(cost) }) as WorkerInfo;

function ledgerIn(dir: string) {
  return new Ledger(dir, { pauseHiring: false }, () => {}, () => {});
}

test('queue tasks are costed by the worker that ran them', () => {
  const obs = taskCostObservations(
    [task('t1', { workerId: 'w1', startedAt: 5, jobKey: 'consultancy:x:item-1' }), task('t2'), task('t3', { workerId: 'gone' }), task('t4', { workerId: 'w2' })],
    [worker('w1', 1.5), worker('w2')],
  );
  assert.deepEqual(obs, [{ taskId: 't1', workerId: 'w1', costUsd: 1.5, startedAt: 5, finishedAt: undefined, outcome: undefined, jobKey: 'consultancy:x:item-1' }]);
});

test('the ledger keeps per-task spend durably, as a high-water mark, summed over retries', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'task-costs-'));
  try {
    const ledger = ledgerIn(dir);
    ledger.recordTaskCosts([{ taskId: 't1', workerId: 'w1', costUsd: 2, startedAt: 1 }]);
    ledger.recordTaskCosts([{ taskId: 't1', workerId: 'w1', costUsd: 1.5, startedAt: 1 }]);
    assert.equal(ledger.taskCost('t1'), 2, 'a session tally under the estimate never hands spend back');
    ledger.recordTaskCosts([{ taskId: 't1', workerId: 'w9', costUsd: 0.75, startedAt: 9, finishedAt: 20, outcome: 'done' }]);
    assert.equal(ledger.taskCost('t1'), 2.75, 'a retry by another worker adds to the task');
    assert.equal(ledger.taskCost('nope'), undefined);
    const [record] = ledger.taskCosts();
    assert.deepEqual({ ...record }, { taskId: 't1', costUsd: 2.75, startedAt: 1, finishedAt: 20, outcome: 'done', jobKey: undefined });
    ledger.flush();
    const reopened = ledgerIn(dir);
    assert.equal(reopened.taskCost('t1'), 2.75);
    reopened.flush();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a usage.json from before task costs loads unchanged and keeps its totals', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'task-costs-legacy-'));
  try {
    writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ total: u(4), days: { '2026-01-01': u(4) } }));
    const ledger = ledgerIn(dir);
    assert.equal(ledger.state().total.cost, 4);
    assert.deepEqual(ledger.taskCosts(), []);
    ledger.recordTaskCosts([{ taskId: 't', workerId: 'w', costUsd: 1 }]);
    ledger.flush();
    const saved = JSON.parse(readFileSync(path.join(dir, 'usage.json'), 'utf8'));
    assert.equal(saved.total.cost, 4, 'recording a task cost does not book spend twice');
    assert.equal(saved.tasks['t|w'].costUsd, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
