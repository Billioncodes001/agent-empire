import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Consultancy, ConsultancyError } from '../src/server/consultancy.js';
import type { QueueState, QueueTask } from '../src/shared/protocol.js';

class FakeQueue {
  tasks: QueueTask[] = [];
  maxWorkers = 2;
  addCalls = 0;
  refuse?: string;
  addThrows?: string;
  omitInsert = false;
  stateThrows?: string;
  stateStorageError?: string;
  private nextTask = 1;

  state(): QueueState {
    if (this.stateThrows) throw new Error(this.stateThrows);
    const state = { tasks: this.tasks.map((task) => ({ ...task })), maxWorkers: this.maxWorkers } as QueueState & { storageError?: string };
    if (this.stateStorageError) state.storageError = this.stateStorageError;
    return state;
  }

  add(prompt: string, by: string, title?: string, _issue?: number, jobKey?: string): string | undefined {
    this.addCalls += 1;
    if (this.addThrows) throw new Error(this.addThrows);
    if (this.refuse) return this.refuse;
    if (jobKey && this.tasks.some((task) => task.jobKey === jobKey)) return undefined;
    if (!this.omitInsert) {
      this.tasks.push({
        id: `q-${this.nextTask++}`,
        jobKey,
        title: title ?? 'task',
        prompt,
        addedBy: by,
        addedAt: Date.now(),
        status: 'queued',
      });
    }
    return undefined;
  }
}

function makeDir(name: string): string {
  return mkdtempSync(path.join(tmpdir(), `${name}-`));
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    client: 'Acme',
    title: 'Market expansion',
    brief: 'Assess competitor positioning',
    ...overrides,
  };
}

test('creates jobs for multiple clients and defaults tasks from the brief', () => {
  const dir = makeDir('consultancy-create');
  const queue = new FakeQueue();
  try {
    const consultancy = new Consultancy(dir, queue);
    const a = consultancy.create(baseInput({ requestId: 'req-a' }), 'CEO');
    const b = consultancy.create(baseInput({ requestId: 'req-b', client: 'Globex', brief: 'Audit support workflows' }), 'CEO');
    assert.equal(a.items.length, 1);
    assert.equal(a.items[0].prompt, 'Assess competitor positioning');
    assert.equal(b.client, 'Globex');
    assert.equal(consultancy.snapshot().jobs.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requestId idempotency returns existing job and conflicts on different content', () => {
  const dir = makeDir('consultancy-idempotency');
  const queue = new FakeQueue();
  try {
    const consultancy = new Consultancy(dir, queue);
    const first = consultancy.create(baseInput(), 'CEO');
    const replay = consultancy.create(baseInput(), 'CEO');
    assert.equal(replay.id, first.id);
    assert.equal(consultancy.snapshot().jobs.length, 1);
    assert.throws(
      () => consultancy.create(baseInput({ brief: 'Changed brief' }), 'CEO'),
      (error: unknown) => error instanceof ConsultancyError && error.status === 409,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects invalid payloads including unknown keys and too many tasks', () => {
  const dir = makeDir('consultancy-validation');
  const queue = new FakeQueue();
  try {
    const consultancy = new Consultancy(dir, queue);
    assert.throws(
      () => consultancy.create({ ...baseInput(), extra: true }, 'CEO'),
      (error: unknown) => error instanceof ConsultancyError && error.status === 400,
    );
    assert.throws(
      () => consultancy.create({ ...baseInput(), tasks: [{ title: 'A', prompt: 'B', extra: true }] }, 'CEO'),
      (error: unknown) => error instanceof ConsultancyError && error.status === 400,
    );
    assert.throws(
      () => consultancy.create({ ...baseInput(), tasks: Array.from({ length: 9 }, (_, i) => ({ title: `Task ${i}`, prompt: 'Do work' })) }, 'CEO'),
      (error: unknown) => error instanceof ConsultancyError && error.status === 400,
    );
    assert.throws(
      () => consultancy.create({ ...baseInput(), client: '   ' }, 'CEO'),
      (error: unknown) => error instanceof ConsultancyError && error.status === 400,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate approval does not create duplicate queue tasks', () => {
  const dir = makeDir('consultancy-approve');
  const queue = new FakeQueue();
  try {
    const consultancy = new Consultancy(dir, queue);
    const created = consultancy.create(baseInput(), 'CEO');
    consultancy.approve(created.id, 'Chief');
    consultancy.approve(created.id, 'Chief');
    assert.equal(queue.tasks.length, 1);
    assert.equal(consultancy.snapshot().jobs[0].status, 'queued');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reject and approve transitions enforce decision rules', () => {
  const dir = makeDir('consultancy-rules');
  const queue = new FakeQueue();
  try {
    const consultancy = new Consultancy(dir, queue);
    const rejected = consultancy.create(baseInput({ requestId: 'req-reject' }), 'CEO');
    assert.equal(consultancy.reject(rejected.id, 'Chief').status, 'rejected');
    assert.throws(
      () => consultancy.approve(rejected.id, 'Chief'),
      (error: unknown) => error instanceof ConsultancyError && error.status === 409,
    );
    const approved = consultancy.create(baseInput({ requestId: 'req-approve' }), 'CEO');
    consultancy.approve(approved.id, 'Chief');
    assert.throws(
      () => consultancy.reject(approved.id, 'Chief'),
      (error: unknown) => error instanceof ConsultancyError && error.status === 409,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart reconciliation enqueues once after approval persisted before dispatch', () => {
  const dir = makeDir('consultancy-restart');
  const queue1 = new FakeQueue();
  queue1.addThrows = 'transient queue outage';
  try {
    const first = new Consultancy(dir, queue1);
    const job = first.create(baseInput(), 'CEO');
    first.approve(job.id, 'Chief');
    assert.equal(queue1.tasks.length, 0);
    const queue2 = new FakeQueue();
    const second = new Consultancy(dir, queue2);
    assert.equal(queue2.tasks.length, 1);
    second.reconcile();
    assert.equal(queue2.tasks.length, 1);
    assert.equal(second.snapshot().jobs[0].items[0].queueTaskId, 'q-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing previously observed queue task becomes needs_attention and is not requeued', () => {
  const dir = makeDir('consultancy-missing-task');
  const queue = new FakeQueue();
  try {
    const consultancy = new Consultancy(dir, queue);
    const created = consultancy.create(baseInput(), 'CEO');
    consultancy.approve(created.id, 'Chief');
    assert.equal(queue.tasks.length, 1);
    const calls = queue.addCalls;
    queue.tasks = [];
    consultancy.reconcile();
    const item = consultancy.snapshot().jobs[0].items[0];
    assert.equal(item.status, 'needs_attention');
    assert.match(item.attention ?? '', /missing/i);
    assert.equal(queue.addCalls, calls);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatch refusal and missing queue state evidence are surfaced', () => {
  const refuseDir = makeDir('consultancy-refuse');
  try {
    const refusedQueue = new FakeQueue();
    refusedQueue.refuse = 'Queue is paused';
    const refused = new Consultancy(refuseDir, refusedQueue);
    const job = refused.create(baseInput(), 'CEO');
    refused.approve(job.id, 'Chief');
    const refusedItem = refused.snapshot().jobs[0].items[0];
    assert.equal(refusedItem.status, 'needs_attention');
    assert.match(refusedItem.attention ?? '', /refused dispatch/i);
  } finally {
    rmSync(refuseDir, { recursive: true, force: true });
  }

  const noStateDir = makeDir('consultancy-no-state');
  try {
    const queue = new FakeQueue();
    queue.omitInsert = true;
    const consultancy = new Consultancy(noStateDir, queue);
    const job = consultancy.create(baseInput(), 'CEO');
    consultancy.approve(job.id, 'Chief');
    const item = consultancy.snapshot().jobs[0].items[0];
    assert.equal(item.status, 'needs_attention');
    assert.match(item.attention ?? '', /no matching task is visible/i);
  } finally {
    rmSync(noStateDir, { recursive: true, force: true });
  }
});

test('corrupt journal fails closed and keeps original bytes', () => {
  const dir = makeDir('consultancy-corrupt');
  const file = path.join(dir, 'consultancy.json');
  writeFileSync(file, '{broken');
  const queue = new FakeQueue();
  try {
    const consultancy = new Consultancy(dir, queue);
    assert.ok(consultancy.recoveryError);
    assert.throws(
      () => consultancy.create(baseInput(), 'CEO'),
      (error: unknown) => error instanceof ConsultancyError && error.status === 503,
    );
    assert.equal(readFileSync(file, 'utf8'), '{broken');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistence failure is reported and prevents false success', () => {
  const dir = makeDir('consultancy-persist');
  const queue = new FakeQueue();
  const file = path.join(dir, 'consultancy.json');
  try {
    const consultancy = new Consultancy(dir, queue);
    consultancy.create(baseInput({ requestId: 'req-a' }), 'CEO');
    renameSync(file, `${file}.backup`);
    mkdirSync(file);
    assert.throws(
      () => consultancy.create(baseInput({ requestId: 'req-b' }), 'CEO'),
      (error: unknown) => error instanceof ConsultancyError && error.status === 503,
    );
    const snapshot = consultancy.snapshot();
    assert.ok(snapshot.storageError);
    assert.equal(snapshot.jobs.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed work outcomes surface needs_attention while done maps to awaiting_review', () => {
  const failedDir = makeDir('consultancy-failed-outcome');
  try {
    const queue = new FakeQueue();
    const consultancy = new Consultancy(failedDir, queue);
    const job = consultancy.create(baseInput(), 'CEO');
    consultancy.approve(job.id, 'Chief');
    queue.tasks[0].status = 'done';
    queue.tasks[0].outcome = 'failed';
    queue.tasks[0].error = 'worker interrupted';
    const failed = consultancy.snapshot().jobs[0];
    assert.equal(failed.status, 'needs_attention');
  } finally {
    rmSync(failedDir, { recursive: true, force: true });
  }

  const doneDir = makeDir('consultancy-awaiting-review');
  try {
    const queue = new FakeQueue();
    const consultancy = new Consultancy(doneDir, queue);
    const job = consultancy.create(baseInput(), 'CEO');
    consultancy.approve(job.id, 'Chief');
    queue.tasks[0].status = 'done';
    queue.tasks[0].outcome = 'done';
    const done = consultancy.snapshot().jobs[0];
    assert.equal(done.status, 'awaiting_review');
  } finally {
    rmSync(doneDir, { recursive: true, force: true });
  }
});

test('queue storage errors are visible without any game client', () => {
  const dir = makeDir('consultancy-headless');
  const queue = new FakeQueue();
  queue.stateStorageError = 'queue journal is read-only';
  try {
    const consultancy = new Consultancy(dir, queue);
    const job = consultancy.create(baseInput(), 'CEO');
    consultancy.approve(job.id, 'Chief');
    const snapshot = consultancy.snapshot();
    assert.match(snapshot.storageError ?? '', /read-only/);
    assert.equal(snapshot.jobs[0].status, 'needs_attention');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
