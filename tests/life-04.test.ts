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
import { execFileSync } from 'node:child_process';
import { Worktrees } from '../src/server/worktrees';
import { workerTaskLine } from '../src/shared/dependencies';

interface Spawned { desk: string; prompt: string; persona?: Persona; continues?: { branch: string; title: string } }
type KillResult = { note?: string; error?: string };

function office(opts: { desks?: number; worktrees?: boolean; branches?: Set<string>; kill?: (id: string) => Promise<KillResult> } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'life04-'));
  const workers: WorkerInfo[] = [];
  const spawned: Spawned[] = [];
  const kills: string[] = [];
  const busy = new Set<string>();
  let desks = opts.desks ?? 4;
  let paused: string | undefined;
  let n = 0;
  let queue!: TaskQueue;
  const make = (deskId: string, name: string, color = '#5bc0eb'): WorkerInfo =>
    ({ id: `w${++n}`, kind: 'agent', deskId, name, color, status: 'working', processState: 'running', acked: true, createdBy: 't', createdAt: 0, cols: 80, rows: 24, viewers: [] });
  const sendHome = (id: string) => {
    const i = workers.findIndex((w) => w.id === id);
    if (i >= 0) workers.splice(i, 1);
    queue.onWorkerGone(id);
  };
  const fake = {
    workstationCapacity: () => desks,
    list: () => workers,
    deskOccupied: (id: string) => workers.some((w) => w.deskId === id),
    spawn: (desk: string, _by: string, prompt: string, _wt: boolean, _k?: 'agent', _q?: boolean, _o?: unknown, persona?: Persona, continues?: { branch: string; title: string }) => {
      spawned.push({ desk, prompt, persona, continues });
      const w = make(desk, persona?.name ?? `Worker${n + 1}`, persona?.color);
      if (opts.worktrees) w.worktree = { path: `wt/${w.id}`, branch: `office/${w.id}`, base: 'abc', ...(continues ? { continues } : {}) };
      workers.push(w);
      return w;
    },
    kill: (id: string) => {
      kills.push(id);
      if (opts.kill) return opts.kill(id);
      sendHome(id);
      return Promise.resolve({});
    },
    workerBusy: (id: string) => busy.has(id),
    branchExists: (b: string) => opts.branches?.has(b) ?? false,
  };
  const toasts: string[] = [];
  queue = new TaskQueue(dir, fake, !!opts.worktrees, { update() {}, toast: (t) => { toasts.push(t); }, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => paused });
  const setStatus = (id: string, status: WorkerInfo['status']) => { const w = workers.find((x) => x.id === id)!; w.status = status; queue.onWorker({ ...w }); };
  const task = (title: string) => queue.state().tasks.find((t) => t.title === title)!;
  const reserved = () => (queue as unknown as { reserved: Map<string, unknown> }).reserved.size;
  const close = () => { queue.shutdown(); rmSync(dir, { recursive: true, force: true }); };
  return {
    dir, workers, spawned, kills, toasts, busy, sendHome, reserved, setStatus, task, close,
    get queue() { return queue; },
    setDesks(d: number) { desks = d; },
    pause(why: string | undefined) { paused = why; },
  };
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

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


/** X keeps desk-1 busy, A runs at desk-2, B depends on A. */
function chain(o: ReturnType<typeof office>) {
  o.queue.add('x', 'ceo', 'X');
  o.queue.add('a', 'ceo', 'A');
  const a = o.task('A');
  o.queue.add('b', 'ceo', 'B', undefined, undefined, [a.id]);
  const aw = o.workers.find((w) => w.id === a.workerId)!;
  assert.equal(aw.deskId, 'desk-2');
  return aw;
}

test('continuity: the dependency desk is preferred when it is free', () => {
  const o = office();
  try {
    const aw = chain(o);
    o.setStatus(aw.id, 'done');
    // A free funded desk (desk-3) exists, so nothing is sent home and B starts at once.
    assert.deepEqual(o.kills, []);
    assert.equal(o.task('B').status, 'running');
    assert.equal(o.spawned.at(-1)?.desk, 'desk-3');
  } finally { o.close(); }
  const p = office();
  try {
    const aw = chain(p);
    p.queue.setLimit(0);
    p.setStatus(aw.id, 'done');
    p.sendHome(aw.id); // A's worker has left: its desk-2 is free and preferred over desk-3.
    p.queue.setLimit(3);
    assert.equal(p.task('B').status, 'running');
    assert.equal(p.spawned.at(-1)?.desk, 'desk-2');
  } finally { p.close(); }
});

test('continuity sends the dependency worker home only when no desk is free, and only a done one', async () => {
  const o = office({ desks: 2 });
  try {
    const aw = chain(o);
    o.setStatus(aw.id, 'done');
    assert.deepEqual(o.kills, [aw.id]);
    await settle();
    assert.equal(o.task('B').status, 'running');
    assert.equal(o.spawned.at(-1)?.desk, 'desk-2');
    assert.equal(o.reserved(), 0);
  } finally { o.close(); }
  for (const blocker of ['offline', 'viewers', 'busy'] as const) {
    const p = office({ desks: 2 });
    try {
      const aw = chain(p);
      if (blocker === 'viewers') aw.viewers = ['CEO'];
      if (blocker === 'busy') p.busy.add(aw.id);
      p.setStatus(aw.id, blocker === 'offline' ? 'offline' : 'done');
      assert.equal(p.reserved(), 0, `${blocker}: no desk is reserved`);
      if (blocker !== 'offline') assert.deepEqual(p.kills, [], `${blocker}: never sent home`);
    } finally { p.close(); }
  }
});

test('a send-home that fails without awaiting, or rejects, is bounded: no retry storm, the task uses another desk', async () => {
  for (const mode of ['error', 'reject', 'throw'] as const) {
    const o = office({
      desks: 2,
      kill: () => {
        if (mode === 'throw') throw new Error('boom');
        return mode === 'reject' ? Promise.reject(new Error('boom')) : Promise.resolve({ error: 'This worker is publishing a sync artifact; wait for it to finish' });
      },
    });
    try {
      const aw = chain(o);
      o.setStatus(aw.id, 'done');
      await settle();
      for (let i = 0; i < 20; i++) o.queue.pump();
      await settle();
      assert.equal(o.kills.length, 1, `${mode}: one attempt, then backoff`);
      assert.equal(o.toasts.filter((t) => /publishing|boom/.test(t)).length, 1, `${mode}: one toast`);
      assert.equal(o.task('B').status, 'queued');
      assert.equal(o.reserved(), 0);
      o.setDesks(3);
      o.queue.pump();
      assert.equal(o.task('B').status, 'running', `${mode}: B seats at another free desk`);
      assert.equal(o.spawned.at(-1)?.desk, 'desk-3');
      assert.equal(o.kills.length, 1);
    } finally { o.close(); }
  }
});

test('a reservation is released when the worker limit or a hiring pause blocks the reserved task', async () => {
  for (const block of ['limit', 'paused'] as const) {
    let finish!: () => void;
    const o = office({ desks: 2, kill: () => new Promise<KillResult>((r) => { finish = () => r({}); }) });
    try {
      const aw = chain(o);
      o.setStatus(aw.id, 'done');
      assert.equal(o.reserved(), 1);
      if (block === 'limit') o.queue.setLimit(1); else o.pause('Budget spent');
      // The send-home completes while the queue cannot seat B.
      const i = o.workers.indexOf(aw); o.workers.splice(i, 1);
      finish(); await settle();
      o.queue.onWorkerGone(aw.id);
      assert.equal(o.reserved(), 0, `${block}: reservation released`);
      assert.equal(o.task('B').status, 'queued');
      if (block === 'limit') o.queue.setLimit(3); else { o.pause(undefined); o.queue.pump(); }
      assert.equal(o.task('B').status, 'running');
      assert.equal(o.spawned.at(-1)?.desk, 'desk-2', `${block}: still prefers the dependency desk`);
    } finally { o.close(); }
  }
});

test('a kept reservation on a desk that is no longer funded is dropped', async () => {
  let finish!: () => void;
  const o = office({ desks: 2, kill: () => new Promise<KillResult>((r) => { finish = () => r({}); }) });
  try {
    const aw = chain(o);
    o.setStatus(aw.id, 'done');
    assert.equal(o.reserved(), 1);
    o.setDesks(1);
    o.workers.splice(o.workers.indexOf(aw), 1);
    finish(); await settle();
    o.queue.onWorkerGone(aw.id);
    assert.equal(o.reserved(), 0);
    assert.equal(o.task('B').status, 'queued', 'no funded desk: B waits, never at desk-2');
    assert.equal(o.spawned.length, 2, 'nothing else was seated');
  } finally { o.close(); }
});

test('a reservation whose task is removed before seating frees the desk, and a gone worker leaves no backoff entry', async () => {
  const o = office({ desks: 2, kill: () => new Promise<KillResult>(() => {}) });
  try {
    const aw = chain(o);
    o.setStatus(aw.id, 'done');
    assert.equal(o.reserved(), 1);
    assert.equal(o.queue.remove(o.task('B').id), undefined);
    o.queue.pump();
    assert.equal(o.reserved(), 0, 'the removed task no longer holds its desk');
    const failed = (o.queue as unknown as { sendHomeFailedAt: Map<string, number> }).sendHomeFailedAt;
    failed.set(aw.id, Date.now());
    o.queue.onWorkerGone(aw.id);
    assert.equal(failed.has(aw.id), false, 'backoff entries do not outlive their worker');
  } finally { o.close(); }
});

test('identity: the predecessor name is reused only when the worktree starts from its branch', () => {
  for (const exists of [true, false]) {
    const o = office({ worktrees: true, branches: new Set(exists ? ['office/w1'] : []) });
    try {
      o.queue.add('a', 'ceo', 'Schema');
      const a = o.task('Schema');
      o.queue.add('b', 'ceo', 'API', undefined, undefined, [a.id]);
      o.workers[0].name = 'Byte';
      o.setStatus(o.workers[0].id, 'done');
      const s = o.spawned.at(-1)!;
      assert.equal(o.task('API').status, 'running');
      if (exists) {
        assert.deepEqual(s.continues, { branch: 'office/w1', title: 'Schema' });
        assert.deepEqual(s.persona, { name: 'Byte', color: '#5bc0eb' });
        assert.match(s.prompt, /This task continues “Schema” \(branch office\/w1\): your worktree starts from that branch\./);
      } else {
        assert.equal(s.continues, undefined);
        assert.equal(s.persona, undefined);
        assert.match(s.prompt, /This task follows “Schema” \(branch office\/w1\)\. Its branch is no longer available, so your worktree starts from the project’s current HEAD\./);
      }
    } finally { o.close(); }
  }
  assert.deepEqual(workerTaskLine({ task: { name: 'API', summary: 'Writing routes' }, worktree: { path: 'p', branch: 'b', base: 'c', continues: { branch: 'x', title: 'Schema' } } }),
    { name: 'API', summary: 'continues “Schema” · Writing routes' });
  assert.deepEqual(workerTaskLine({ task: { name: 'API', summary: 'Writing routes' }, worktree: { path: 'p', branch: 'b', base: 'c' } }), { name: 'API', summary: 'Writing routes' });
});

test('worktrees start from a dependency branch when it exists, and reject unsafe names', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'life04-git-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root');
    git('checkout', '-q', '-b', 'office/byte-1');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'schema');
    const tip = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    const trees = new Worktrees(dir);
    assert.equal(trees.hasBranch('office/byte-1'), true);
    assert.equal(trees.hasBranch('office/missing'), false);
    assert.equal(trees.hasBranch('--output=x'), false);
    const made = trees.create('next-1', 'office/byte-1');
    assert.equal(typeof made, 'object');
    assert.equal((made as { base: string }).base, tip, 'the new branch starts at the predecessor branch tip');
    assert.match(String(trees.create('next-2', '-x')), /invalid branch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('a consultancy item whose finished predecessor was cleared still starts; a lost predecessor needs attention', () => {
  for (const finished of [true, false]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'life04-gone-'));
    try {
      const port = fakeQueuePort();
      let refuse = true;
      const add = port.add.bind(port);
      port.add = (...args: Parameters<typeof add>) => (args[2] === 'Two' && refuse ? 'Queue is full' : add(...args));
      const c = new Consultancy(dir, port);
      const job = c.create({ requestId: 'r1', client: 'Acme', title: 'Shop', brief: 'b', tasks: [{ title: 'One', prompt: 'p' }, { title: 'Two', prompt: 'p' }] }, 'ceo');
      c.approve(job.id, 'ceo');
      assert.equal(port.tasks.length, 1, 'item 2 was refused the first time');
      if (finished) { Object.assign(port.tasks[0], { status: 'done', outcome: 'done' }); c.reconcile(); }
      port.tasks.splice(0, 1); // cleared (or removed) from the queue
      refuse = false;
      c.reconcile();
      const items = c.snapshot().jobs[0].items;
      if (finished) {
        assert.equal(port.tasks.length, 1);
        assert.deepEqual(port.adds.at(-1), { title: 'Two', dependsOn: [] });
        assert.equal(items[0].status, 'awaiting_review');
        assert.equal(items[1].status, 'queued');
      } else {
        assert.equal(port.tasks.length, 0, 'never dispatched against a lost dependency');
        assert.equal(items[1].status, 'needs_attention');
        assert.match(items[1].attention ?? '', /item-1 \(“One”\) left the queue without finishing/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
