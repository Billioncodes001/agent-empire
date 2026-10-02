// LIFE-04: task dependencies, held failures, continuity desk, waitingOn projection, ordered consultancy items and the
// waiting routine. Fakes only: no worker process, no provider, no protected session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskQueue, type Persona } from '../src/server/queue';
import { Consultancy, itemDependencies } from '../src/server/consultancy';
import { projectWaitingOn, withWaitingOn } from '../src/server/waiting';
import { MAX_DEPENDENCIES, blockedLabel, heldLabel, validateDependencies, findCycle } from '../src/shared/dependencies';
import { planRoutine, amenityFor } from '../src/client/world/routines';
import type { QueueState, QueueTask, WorkerInfo } from '../src/shared/protocol';

interface Spawned { desk: string; persona?: Persona }

function office(opts: { desks?: number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'life04-'));
  const workers: WorkerInfo[] = [];
  const spawned: Spawned[] = [];
  const kills: string[] = [];
  let n = 0;
  let queue!: TaskQueue;
  const make = (deskId: string, name: string, color = '#5bc0eb'): WorkerInfo =>
    ({ id: `w${++n}`, kind: 'agent', deskId, name, color, status: 'working', processState: 'running', acked: true, createdBy: 't', createdAt: 0, cols: 80, rows: 24, viewers: [] });
  const fake = {
    workstationCapacity: () => opts.desks ?? 4,
    list: () => workers,
    deskOccupied: (id: string) => workers.some((w) => w.deskId === id),
    spawn: (desk: string, _by: string, _p: string, _wt: boolean, _k?: 'agent', _q?: boolean, _o?: unknown, persona?: Persona) => {
      spawned.push({ desk, persona });
      const w = make(desk, persona?.name ?? `Worker${n + 1}`, persona?.color);
      workers.push(w);
      return w;
    },
    kill: async (id: string) => {
      kills.push(id);
      const i = workers.findIndex((w) => w.id === id);
      if (i >= 0) workers.splice(i, 1);
      queue.onWorkerGone(id);
      return {};
    },
  };
  const toasts: string[] = [];
  queue = new TaskQueue(dir, fake, false, { update() {}, toast: (t) => { toasts.push(t); }, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined });
  const setStatus = (id: string, status: WorkerInfo['status']) => { const w = workers.find((x) => x.id === id)!; w.status = status; queue.onWorker({ ...w }); };
  const task = (title: string) => queue.state().tasks.find((t) => t.title === title)!;
  const close = () => { queue.shutdown(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, workers, spawned, kills, toasts, get queue() { return queue; }, setStatus, task, close };
}

const settle = () => new Promise((r) => setImmediate(r));

test('a task never starts before its dependency finishes, and later independent tasks still run', () => {
  const o = office();
  try {
    assert.equal(o.queue.add('a', 'ceo', 'A'), undefined);
    const a = o.task('A');
    assert.equal(o.queue.add('b', 'ceo', 'B', undefined, undefined, [a.id]), undefined);
    assert.equal(o.queue.add('c', 'ceo', 'C'), undefined);
    assert.equal(o.task('A').status, 'running');
    assert.equal(o.task('B').status, 'queued');
    assert.deepEqual(o.task('B').blockedBy, [a.id]);
    assert.equal(o.task('C').status, 'running', 'a blocked task does not hold up the tasks after it');
    assert.equal(o.spawned.length, 2);
    o.setStatus(o.task('A').workerId!, 'done');
    assert.equal(o.task('A').outcome, 'done');
    assert.equal(o.task('B').status, 'running');
    assert.equal(o.task('B').blockedBy, undefined);
  } finally { o.close(); }
});

test('dependency lists are validated: unknown ids, more than 8, self and cycles are rejected', () => {
  const o = office();
  try {
    assert.match(o.queue.add('x', 'ceo', 'X', undefined, undefined, ['nope']) ?? '', /Unknown dependency nope/);
    for (let i = 0; i < MAX_DEPENDENCIES + 1; i++) o.queue.add(`t${i}`, 'ceo', `T${i}`);
    const ids = o.queue.state().tasks.map((t) => t.id);
    assert.match(o.queue.add('x', 'ceo', 'X', undefined, undefined, ids) ?? '', /at most 8/);
    assert.equal(o.queue.add('x', 'ceo', 'X', undefined, undefined, ids.slice(0, 8)), undefined);
    assert.equal(o.queue.state().tasks.length, MAX_DEPENDENCIES + 2);
  } finally { o.close(); }
  assert.match((validateDependencies('n', ['a'], [{ id: 'a', dependsOn: ['n'] }]) as { error: string }).error, /cycle/);
  assert.match((validateDependencies('n', ['n'], []) as { error: string }).error, /itself/);
  assert.deepEqual(validateDependencies('n', ['a', 'a'], [{ id: 'a' }]), { ok: ['a'] });
  assert.equal(findCycle(new Map([['a', ['b']], ['b', ['c']], ['c', []]])), undefined);
  assert.ok(findCycle(new Map([['a', ['b']], ['b', ['a']]])));
});

test('a failed dependency holds its dependent: never auto-run, retry or remove by the CEO', () => {
  const o = office();
  try {
    o.queue.add('a', 'ceo', 'A');
    const a = o.task('A');
    o.queue.add('b', 'ceo', 'B', undefined, undefined, [a.id]);
    o.queue.add('c', 'ceo', 'C', undefined, undefined, [o.task('B').id]);
    o.setStatus(a.workerId!, 'exited');
    assert.equal(o.task('A').outcome, 'exited');
    for (const title of ['B', 'C']) {
      const t = o.task(title);
      assert.equal(t.status, 'done');
      assert.equal(t.outcome, 'failed');
    }
    assert.equal(o.task('B').error, `dependency ${a.id} did not finish`);
    assert.equal(o.task('C').error, `dependency ${o.task('B').id} did not finish`, 'the hold propagates down the chain');
    assert.equal(o.spawned.length, 1, 'held tasks never start');
    assert.match(heldLabel(o.task('B'), o.queue.state().tasks), /^Held — dependency “A” did not finish/);
    assert.match(o.queue.retry(o.task('B').id) ?? '', /Dependency .*A.* did not finish — retry or remove it first/);
    // Retry the dependency (its stopped worker is released first), then the dependent waits on it again.
    o.workers.splice(0, 1); o.queue.onWorkerGone(a.workerId!);
    o.queue.setLimit(0); // keep the retried dependency queued so removal can be checked
    assert.equal(o.queue.retry(a.id), undefined);
    assert.equal(o.queue.retry(o.task('B').id), undefined);
    assert.equal(o.task('B').status, 'queued');
    assert.deepEqual(o.task('B').blockedBy, [a.id]);
    assert.match(o.queue.remove(a.id) ?? '', /waiting on this task/, 'a dependency with a waiting task cannot be removed out from under it');
    assert.equal(o.queue.remove(o.task('C').id), undefined, 'a held task can be removed');
  } finally { o.close(); }
});

test('continuity: an unblocked task continues at the desk (and as the person) that finished its dependency', async () => {
  const o = office();
  try {
    o.queue.add('a', 'ceo', 'A');
    const a = o.task('A');
    o.queue.add('b', 'ceo', 'B', undefined, undefined, [a.id]);
    const first = o.workers[0];
    assert.equal(first.deskId, 'desk-1');
    first.name = 'Byte';
    o.setStatus(first.id, 'done');
    // desk-2..4 are free, but B waits for desk-1 while its finished worker is sent home.
    assert.deepEqual(o.kills, [first.id]);
    await settle();
    assert.equal(o.task('B').status, 'running');
    assert.deepEqual(o.spawned.at(-1), { desk: 'desk-1', persona: { name: 'Byte', color: '#5bc0eb' } });
    assert.equal(o.task('B').deskId, 'desk-1');
  } finally { o.close(); }
});

test('continuity never holds a runnable task when the dependency desk is being watched', () => {
  const o = office();
  try {
    o.queue.add('a', 'ceo', 'A');
    const a = o.task('A');
    o.queue.add('b', 'ceo', 'B', undefined, undefined, [a.id]);
    o.workers[0].viewers = ['CEO'];
    o.setStatus(o.workers[0].id, 'done');
    assert.deepEqual(o.kills, []);
    assert.equal(o.task('B').status, 'running');
    assert.equal(o.spawned.at(-1)?.desk, 'desk-2');
    assert.equal(o.spawned.at(-1)?.persona, undefined);
  } finally { o.close(); }
});

test('waitingOn: set for the idle/done worker whose dependent is blocked by another running worker, cleared after', () => {
  const w = (id: string, name: string, status: WorkerInfo['status']) => ({ id, name, status, kind: 'agent', deskId: 'desk-1' }) as WorkerInfo;
  const tasks: QueueTask[] = [
    { id: 't1', title: 'One', prompt: 'p', addedBy: 'c', addedAt: 0, status: 'done', outcome: 'done', workerId: 'cy', finishedAt: 5 },
    { id: 't2', title: 'Two', prompt: 'p', addedBy: 'c', addedAt: 0, status: 'running', workerId: 'bea' },
    { id: 't3', title: 'Three', prompt: 'p', addedBy: 'c', addedAt: 0, status: 'queued', dependsOn: ['t1', 't2'], blockedBy: ['t2'] },
  ];
  const workers = [w('cy', 'Cyrus', 'done'), w('bea', 'Bea', 'working')];
  const waits = projectWaitingOn(tasks, workers);
  assert.deepEqual(waits.get('cy'), { id: 'bea', name: 'Bea', taskId: 't3' });
  assert.equal(waits.has('bea'), false);
  assert.deepEqual(withWaitingOn(workers[0], waits).waitingOn, { id: 'bea', name: 'Bea', taskId: 't3' });
  // Blocker finishes: cleared.
  const finished = tasks.map((t) => (t.id === 't2' ? { ...t, status: 'done' as const, outcome: 'done' as const, finishedAt: 9 } : t));
  assert.equal(projectWaitingOn(finished, workers).size, 0);
  // Dependent seated: cleared.
  const seated = tasks.map((t) => (t.id === 't3' ? { ...t, status: 'running' as const, blockedBy: undefined } : t));
  assert.equal(projectWaitingOn(seated, workers).size, 0);
  assert.equal('waitingOn' in withWaitingOn({ ...workers[0], waitingOn: { id: 'bea', name: 'Bea', taskId: 't3' } }, new Map()), false);
  // A busy worker or one only blocked by a queued (not running) task is not waiting on anyone.
  assert.equal(projectWaitingOn(tasks, [w('cy', 'Cyrus', 'working'), workers[1]]).size, 0);
  const queuedBlocker = tasks.map((t) => (t.id === 't2' ? { ...t, status: 'queued' as const, workerId: undefined } : t));
  assert.equal(projectWaitingOn(queuedBlocker, workers).size, 0);
});

test('dependencies persist in queue.json, and an old queue file without them loads unchanged', () => {
  const o = office();
  let dir = '';
  try {
    o.queue.add('a', 'ceo', 'A');
    const a = o.task('A');
    o.queue.add('b', 'ceo', 'B', undefined, undefined, [a.id]);
    const saved = JSON.parse(readFileSync(path.join(o.dir, 'queue.json'), 'utf8')) as QueueState;
    assert.deepEqual(saved.tasks.find((t) => t.title === 'B')?.dependsOn, [a.id]);
    assert.equal(saved.tasks.find((t) => t.title === 'A')?.deskId, 'desk-1');
  } finally { o.close(); }
  dir = mkdtempSync(path.join(tmpdir(), 'life04-old-'));
  try {
    const old = { maxWorkers: 2, releasedWorkers: [], tasks: [
      { id: 'old1', title: 'Old', prompt: 'p', addedBy: 'ceo', addedAt: 1, status: 'queued', attempt: 1 },
      { id: 'old2', title: 'Older', prompt: 'p', addedBy: 'ceo', addedAt: 1, status: 'done', attempt: 1, outcome: 'done', finishedAt: 2, workerId: 'gone', workerName: 'Byte' },
    ] };
    writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(old));
    const q = new TaskQueue(dir, { list: () => [], deskOccupied: () => false, spawn() { throw new Error('must not spawn'); }, kill: async () => ({}) }, false,
      { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => 'paused for the test' });
    try {
      assert.deepEqual(q.state().tasks.map((t) => ({ ...t })), old.tasks.map((t) => ({ jobKey: undefined, issue: undefined, interruption: undefined, workerId: undefined, workerName: undefined, branch: undefined, startedAt: undefined, finishedAt: undefined, outcome: undefined, error: undefined, pr: undefined, ...t })));
      assert.ok(q.state().tasks.every((t) => !('dependsOn' in t) && !('blockedBy' in t)));
    } finally { q.shutdown(); }
    // A hand-edited cycle is refused like any other invalid queue file.
    writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ tasks: [
      { id: 'x', title: 'X', prompt: 'p', status: 'queued', dependsOn: ['y'] }, { id: 'y', title: 'Y', prompt: 'p', status: 'queued', dependsOn: ['x'] }] }));
    assert.throws(() => new TaskQueue(dir, { list: () => [], deskOccupied: () => false, spawn() { throw new Error('no'); }, kill: async () => ({}) }, false,
      { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined }), /cycle/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fakeQueuePort() {
  const tasks: QueueTask[] = [];
  const adds: { title?: string; dependsOn?: readonly string[] }[] = [];
  return {
    tasks, adds,
    state: (): QueueState => ({ tasks, maxWorkers: 1 }),
    add(prompt: string, by: string, title?: string, _issue?: number, jobKey?: string, dependsOn?: readonly string[]) {
      adds.push({ title, dependsOn });
      tasks.push({ id: `q${tasks.length + 1}`, jobKey, title: title ?? prompt, prompt, addedBy: by, addedAt: 0, status: 'queued', ...(dependsOn?.length ? { dependsOn: [...dependsOn], blockedBy: [...dependsOn] } : {}) });
      return undefined;
    },
  };
}

test('approved consultancy items run in order; `parallel: true` opts an item out', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'life04-job-'));
  try {
    const port = fakeQueuePort();
    const c = new Consultancy(dir, port);
    const job = c.create({ requestId: 'r1', client: 'Acme', title: 'Shop', brief: 'b', tasks: [
      { title: 'Schema', prompt: 'p' }, { title: 'API', prompt: 'p' }, { title: 'Docs', prompt: 'p', parallel: true }, { title: 'Wire', prompt: 'p' }] }, 'ceo');
    assert.equal(job.items[2].parallel, true);
    const approved = c.approve(job.id, 'ceo');
    assert.deepEqual(port.adds.map((a) => [a.title, a.dependsOn]), [['Schema', []], ['API', ['q1']], ['Docs', ['q1']], ['Wire', ['q2', 'q3']]]);
    // Blocked items are queued, never shown as needing attention.
    assert.deepEqual(approved.items.map((i) => i.status), ['queued', 'queued', 'queued', 'queued']);
    // The journal (with `parallel`) reloads, and the same request stays idempotent.
    const again = new Consultancy(dir, port);
    assert.equal(again.snapshot().jobs[0].items[2].parallel, true);
    assert.equal(again.create({ requestId: 'r1', client: 'Acme', title: 'Shop', brief: 'b', tasks: [
      { title: 'Schema', prompt: 'p' }, { title: 'API', prompt: 'p' }, { title: 'Docs', prompt: 'p', parallel: true }, { title: 'Wire', prompt: 'p' }] }, 'ceo').id, job.id);
    assert.throws(() => c.create({ requestId: 'r2', client: 'A', title: 'T', brief: 'b', tasks: [{ title: 't', prompt: 'p', parallel: 'yes' }] }, 'ceo'), /parallel must be a boolean/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const items = [{ n: 1 }, { n: 2, parallel: true as const }, { n: 3, parallel: true as const }, { n: 4 }, { n: 5 }];
  assert.deepEqual(items.map((_, i) => itemDependencies(items, i).map((d) => d.n)), [[], [], [], [1, 2, 3], [4]]);
});

test('a held consultancy item shows the dependency failure as needing attention', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'life04-held-'));
  try {
    const port = fakeQueuePort();
    const c = new Consultancy(dir, port);
    const job = c.create({ requestId: 'r1', client: 'Acme', title: 'Shop', brief: 'b', tasks: [{ title: 'One', prompt: 'p' }, { title: 'Two', prompt: 'p' }] }, 'ceo');
    c.approve(job.id, 'ceo');
    Object.assign(port.tasks[0], { status: 'done', outcome: 'exited' });
    Object.assign(port.tasks[1], { status: 'done', outcome: 'failed', error: 'dependency q1 did not finish', blockedBy: undefined });
    const item = c.snapshot().jobs[0].items[1];
    assert.equal(item.status, 'needs_attention');
    assert.equal(item.attention, 'dependency q1 did not finish');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the waiting routine walks to an amenity and the name card names who it is waiting on', () => {
  // Find a worker id whose break lands on the coffee bar, so the exact sentence can be checked.
  const id = Array.from({ length: 50 }, (_, i) => `w${i}`).find((x) => amenityFor(x, 0, 1) === 'coffee')!;
  const plan = planRoutine({ id, status: 'done', fresh: true, typing: false, since: 0, now: 1, waitingOn: { id: 'bea', name: 'Bea', taskId: 't3' } });
  assert.equal(plan.place, 'coffee');
  assert.equal(plan.activity, 'break');
  assert.equal(plan.reason, 'Waiting on Bea — at the coffee bar');
  // Waiting goes straight away (no BREAK_AFTER_MS pause), but never for stale, offline or working workers.
  assert.equal(planRoutine({ id, status: 'done', fresh: false, typing: false, since: 0, now: 1, waitingOn: { name: 'Bea' } }).place, 'desk');
  assert.equal(planRoutine({ id, status: 'offline', fresh: true, typing: false, since: 0, now: 1, waitingOn: { name: 'Bea' } }).place, 'desk');
  assert.equal(planRoutine({ id, status: 'working', fresh: true, typing: true, since: 0, now: 1, waitingOn: { name: 'Bea' } }).activity, 'typing');
});

test('queue panel text: blocked tasks read "Waiting on <dependency title>"', () => {
  const tasks = [
    { id: 'a', title: 'Build checkout API', status: 'running' },
    { id: 'b', title: 'Second', status: 'queued' },
  ] as QueueTask[];
  assert.equal(blockedLabel({ blockedBy: ['a'] }, tasks), 'Waiting on “Build checkout API”');
  assert.equal(blockedLabel({ blockedBy: ['a', 'b'] }, tasks), 'Waiting on “Build checkout API” and 1 more');
  assert.equal(blockedLabel({}, tasks), '');
  assert.equal(heldLabel({ status: 'done', outcome: 'failed', error: 'dependency zz did not finish' }, tasks), 'Held — dependency zz (removed) did not finish. Retry or remove it.');
  assert.equal(heldLabel({ status: 'done', outcome: 'failed', error: 'spawn failed' }, tasks), '');
});
