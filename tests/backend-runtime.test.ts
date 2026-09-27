import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerManager, type WorkerRuntime } from '../src/server/workers';
import { TaskQueue } from '../src/server/queue';
import { Empire } from '../src/server/empire';
import { projectSupervision } from '../src/server/supervision';
import { writeJsonAtomic } from '../src/server/persistence';
import { initialEmpire } from '../src/shared/empire';
import type { QueueTask, WorkerInfo } from '../src/shared/protocol';
import type { Ledger } from '../src/server/usage';
import { startServer } from '../src/server/server';
import { Auth } from '../src/server/auth';
import type { Config } from '../src/server/config';
import { WebSocket } from 'ws';

const task = (patch: Partial<QueueTask> = {}): QueueTask => ({ id: 'task-1', jobKey: 'empire-manager-hq-1', title: 'Startup', prompt: 'fixture only', addedBy: 'Fixture', addedAt: 1, status: 'running', workerId: 'old-worker', ...patch });
const savedWorker = (patch: Record<string, unknown> = {}) => ({ id: 'old-worker', kind: 'agent', name: 'Fixture', deskId: 'desk-1', createdBy: 'Fixture', createdAt: 1, ...patch });
class FakePty {
  writes: string[] = [];
  kills = 0;
  autoExit = true;
  onExitCallback?: (event: { exitCode: number }) => void;
  constructor(readonly pid: number) {}
  onData() { return { dispose() {} }; }
  onExit(callback: (event: { exitCode: number }) => void) { this.onExitCallback = callback; return { dispose() {} }; }
  write(text: string) { this.writes.push(text); }
  resize() {}
  kill() { this.kills++; if (this.autoExit) this.exit(); }
  exit(exitCode = 0) { this.onExitCallback?.({ exitCode }); }
}
function fixture(saved: Record<string, unknown>[] = [], existingPids: number[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-runtime-test-'));
  writeFileSync(path.join(dir, 'workers.json'), JSON.stringify(saved));
  const processes: FakePty[] = [];
  const launches: { args: string[]; token: string }[] = [];
  const presentPids = new Set<number>(existingPids);
  const toasts: string[] = [];
  let budget: string | undefined;
  let capacity = 4;
  let queue: TaskQueue | undefined;
  const runtime: WorkerRuntime = {
    taskNaming: false,
    resolveCommand: () => '/fixture/claude',
    processExists: pid => presentPids.has(pid),
    spawn: ((_command: string, args: string[], options: { env: Record<string, string> }) => {
      const proc = new FakePty(8000 + processes.length);
      processes.push(proc);
      launches.push({ args, token: options.env.AGENT_OFFICE_HOOK_TOKEN });
      return proc;
    }) as WorkerRuntime['spawn'],
  };
  const events = { update(w: WorkerInfo) { queue?.onWorker(w); }, remove(id: string) { queue?.onWorkerGone(id); }, data() {}, screen() {}, toast(text: string) { toasts.push(text); } };
  const ledger = { get hiringPaused() { return budget; }, add() {} } as Ledger;
  const workers = new WorkerManager(dir, dir, 'claude', [], { url: 'http://127.0.0.1:1', token: '' }, events, ledger, () => capacity, runtime);
  return {
    dir, workers, processes, launches, presentPids, toasts,
    setBudget(value?: string) { budget = value; }, setCapacity(value: number) { capacity = value; },
    queue(tasks: QueueTask[], maxWorkers = 0, empire?: Empire) {
      writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ tasks, maxWorkers }));
      queue = new TaskQueue(dir, workers, false, { update: state => empire?.tick(workers.list(), state, 0), retryAllowed: task => empire?.managerTaskRetryBlocker(task), toast: text => toasts.push(text), hiringPaused: () => budget, claimIssue: async () => undefined, refreshGitHub() {} });
      return queue;
    },
    close() { queue?.shutdown(); workers.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('restoring or inspecting legacy workers never launches a process or guesses stopped', async () => {
  const f = fixture([savedWorker()]);
  try {
    assert.equal(f.workers.list()[0].processState, 'unknown');
    assert.match(f.workers.list()[0].activity!, /legacy save has no PID/);
    for (let i = 0; i < 3; i++) { f.workers.list(); f.workers.attach('old-worker', `client-${i}`, 'Observer'); f.workers.detachAll(`client-${i}`); }
    assert.match(f.workers.resume('old-worker')!, /unconfirmed/);
    assert.match((await f.workers.kill('old-worker')).error!, /unconfirmed/);
    assert.ok(f.workers.get('old-worker'));
    assert.equal(f.processes.length, 0);
  } finally { f.close(); }
});

test('interrupted tasks persist and retry, remove, clear, resume and manager retry cannot bypass unknown work', async () => {
  const f = fixture([savedWorker()]);
  try {
    const q = f.queue([task()]);
    const interrupted = q.state().tasks[0];
    assert.equal(interrupted.status, 'done');
    assert.equal(interrupted.outcome, 'exited');
    assert.equal(interrupted.interruption?.reason, 'server_restart');
    assert.equal(JSON.parse(readFileSync(path.join(f.dir, 'queue.json'), 'utf8')).tasks[0].interruption.reason, 'server_restart');
    for (const result of [q.retry(interrupted.id), q.remove(interrupted.id), q.managerRetryBlocker(interrupted.jobKey!, interrupted.workerId)]) assert.match(result!, /unknown/);
    q.clear(); q.setLimit(4); q.pump();
    assert.equal(q.state().tasks.length, 1);
    assert.match((await f.workers.kill('old-worker')).error!, /unconfirmed/);
    assert.equal(f.processes.length, 0);
  } finally { f.close(); }
});

test('stopped queue attempts retry once, preserve task identity and cannot independently resume', () => {
  const f = fixture([savedWorker({ processState: 'stopped' })]);
  try {
    const q = f.queue([task()], 1);
    assert.equal(q.retry('task-1'), undefined);
    assert.equal(f.processes.length, 1);
    assert.equal(q.state().tasks[0].id, 'task-1');
    assert.equal(q.state().tasks[0].attempt, 2);
    assert.equal(q.state().tasks[0].interruption, undefined);
    assert.match(q.retry('task-1')!, /still on the queue/);
    assert.match(f.workers.resume('old-worker')!, /belongs to the task queue/);
    assert.equal(f.processes.length, 1);
    const saved = JSON.parse(readFileSync(path.join(f.dir, 'workers.json'), 'utf8'));
    assert.equal(saved.find((w: any) => w.id === 'old-worker').queueOwned, true);
    assert.equal(saved.find((w: any) => w.id !== 'old-worker').processPid, f.processes[0].pid);
  } finally { f.close(); }
});

test('budget, paused concurrency and funded capacity hold retries; resume obeys current budget/capacity', () => {
  const f = fixture([savedWorker({ processState: 'stopped' })]);
  try {
    f.setBudget('Fixture budget spent');
    assert.match(f.workers.resume('old-worker')!, /budget spent/);
    f.setBudget(); f.setCapacity(0);
    assert.match(f.workers.resume('old-worker')!, /workstation/);
    f.setCapacity(1);
    const q = f.queue([task()]);
    assert.equal(q.retry('task-1'), undefined);
    assert.equal(f.processes.length, 0);
    q.setLimit(1);
    // The stopped prior worker still occupies the only funded desk; it is no longer linked
    // to the new attempt and must be sent home explicitly before this desk can be reused.
    assert.equal(f.processes.length, 0);
    f.setCapacity(2); f.setBudget('Fixture budget spent'); q.pump();
    assert.equal(f.processes.length, 0);
    f.setBudget(); q.pump();
    assert.equal(f.processes.length, 1);
  } finally { f.close(); }
});

test('stopping a live worker waits for exit before removal, history release and replacement', async () => {
  const f = fixture();
  try {
    const q = f.queue([], 2);
    q.add('fixture', 'Fixture');
    const current = q.state().tasks[0];
    const proc = f.processes[0];
    proc.autoExit = false;
    const stopping = f.workers.kill(current.workerId!);
    assert.ok(f.workers.get(current.workerId!));
    assert.match(q.retry(current.id)!, /still on the queue/);
    assert.match(f.workers.resume(current.workerId!)!, /stopping/);
    assert.equal(f.processes.length, 1);
    proc.exit();
    assert.equal((await stopping).error, undefined);
    assert.equal(f.workers.get(current.workerId!), undefined);
    assert.equal(q.retry(current.id), undefined);
    assert.equal(f.processes.length, 2);
  } finally { f.close(); }
});

test('a rejected kill preserves worker and task instead of assuming the process stopped', async () => {
  const f = fixture();
  try {
    const q = f.queue([], 1); q.add('fixture', 'Fixture');
    const t = q.state().tasks[0];
    f.processes[0].kill = () => { throw new Error('fixture kill failure'); };
    assert.match((await f.workers.kill(t.workerId!)).error!, /not confirmed/);
    assert.equal(f.workers.get(t.workerId!)?.processState, 'running');
    assert.ok(q.remove(t.id));
    assert.equal(f.processes.length, 1);
    f.processes[0].exit();
  } finally { f.close(); }
});

test('failed session resume does not silently launch a fresh session', () => {
  const f = fixture([savedWorker({ processState: 'stopped', sessionId: 'expired-session' })]);
  try {
    assert.equal(f.workers.resume('old-worker'), undefined);
    assert.deepEqual(f.launches[0].args.slice(-2), ['--resume', 'expired-session']);
    f.processes[0].exit(1);
    assert.equal(f.processes.length, 1);
    assert.equal(f.workers.get('old-worker')?.processState, 'stopped');
    assert.ok(f.toasts.some(t => t.includes('No replacement session')));
  } finally { f.close(); }
});

test('permission hooks and viewing/acknowledging terminals never approve input', () => {
  const f = fixture();
  try {
    const w = f.workers.spawn('desk-1', 'Fixture') as WorkerInfo;
    f.workers.handleHook(w.id, f.launches[0].token, 'PermissionRequest', { tool_name: 'Bash' });
    assert.equal(w.status, 'needs_input');
    assert.equal(w.acked, false);
    f.workers.attach(w.id, 'client', 'Observer');
    assert.equal(w.status, 'needs_input');
    assert.equal(w.acked, false);
    assert.deepEqual(f.processes[0].writes, []);
    f.workers.write(w.id, 'n');
    assert.equal(w.acked, true);
    assert.equal(w.status, 'needs_input');
    assert.deepEqual(f.processes[0].writes, ['n']);
  } finally { f.close(); }
});

test('stopped evidence survives a restart but creates no automatic process', () => {
  const f = fixture();
  try {
    const w = f.workers.spawn('desk-1', 'Fixture') as WorkerInfo;
    f.processes[0].exit();
    const saved = JSON.parse(readFileSync(path.join(f.dir, 'workers.json'), 'utf8'));
    assert.equal(saved[0].processState, 'stopped');
    assert.equal(saved[0].processPid, undefined);
    const restored = fixture(saved);
    try { assert.equal(restored.workers.get(w.id)?.processState, 'stopped'); assert.equal(restored.processes.length, 0); }
    finally { restored.close(); }
  } finally { f.close(); }
});

test('launch intent is durable before spawn and a missing interruption link blocks replacement', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-launch-intent-'));
  let q: TaskQueue | undefined;
  try {
    q = new TaskQueue(dir, {
      list: () => [], deskOccupied: () => false, kill: async () => ({}),
      spawn() {
        const saved = JSON.parse(readFileSync(path.join(dir, 'queue.json'), 'utf8'));
        assert.equal(saved.tasks[0].status, 'running');
        assert.equal(saved.tasks[0].workerId, undefined);
        throw new Error('simulated crash after durable launch intent');
      },
    }, false, { update() {}, toast() {}, hiringPaused: () => undefined, claimIssue: async () => undefined, refreshGitHub() {} });
    assert.throws(() => q!.add('fixture', 'Fixture'), /simulated crash/);
    q.shutdown();
    q = new TaskQueue(dir, { list: () => [], deskOccupied: () => false, spawn() { throw new Error('must not respawn'); }, kill: async () => ({}) }, false,
      { update() {}, toast() {}, hiringPaused: () => undefined, claimIssue: async () => undefined, refreshGitHub() {} });
    assert.match(q.retry(q.state().tasks[0].id)!, /no confirmed worker link/);
    q.clear(); q.pump();
    assert.equal(q.state().tasks.length, 1);
  } finally { q?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test('atomic save failure retains previous data and removes incomplete temporary files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-atomic-test-'));
  try {
    const file = path.join(dir, 'state.json');
    writeJsonAtomic(file, { previous: true });
    const circular: any = {}; circular.circular = circular;
    assert.throws(() => writeJsonAtomic(file, circular));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { previous: true });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['state.json']);
    const blocked = path.join(dir, 'directory.json'); mkdirSync(blocked); writeFileSync(path.join(blocked, 'keep'), 'keep');
    assert.throws(() => writeJsonAtomic(blocked, { replacement: true }));
    assert.equal(readFileSync(path.join(blocked, 'keep'), 'utf8'), 'keep');
    assert.equal(readdirSync(dir).some(n => n.endsWith('.tmp')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('queue/worker persistence failures are visible and halt further process launches', () => {
  const f = fixture();
  try {
    const q = f.queue([]);
    renameSync(path.join(f.dir, 'queue.json'), path.join(f.dir, 'queue-preserved.json'));
    mkdirSync(path.join(f.dir, 'queue.json'));
    assert.match(q.add('fixture', 'Fixture')!, /could not be saved/);
    q.setLimit(4); q.pump();
    assert.ok(q.recoveryError);
    renameSync(path.join(f.dir, 'workers.json'), path.join(f.dir, 'workers-preserved.json'));
    mkdirSync(path.join(f.dir, 'workers.json'));
    assert.match(f.workers.spawn('desk-1', 'Fixture') as string, /could not be saved/);
    assert.ok(f.workers.recoveryError);
    assert.equal(f.processes.length, 0);
    assert.ok(f.toasts.some(t => t.includes('repair storage')));
  } finally { f.close(); }
});

test('corrupt saves fail closed and preserve their bytes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-corrupt-test-'));
  try {
    const file = path.join(dir, 'queue.json'); writeFileSync(file, '{broken');
    assert.throws(() => new TaskQueue(dir, { list: () => [], deskOccupied: () => false, spawn() { throw new Error('must not spawn'); }, kill: async () => ({}) }, false,
      { update() {}, toast() {}, hiringPaused: () => undefined, claimIssue: async () => undefined, refreshGitHub() {} }), /preserve the file/);
    assert.equal(readFileSync(file, 'utf8'), '{broken');
    writeFileSync(path.join(dir, 'workers.json'), '{broken');
    assert.throws(() => new WorkerManager(dir, dir, 'claude', [], { url: '', token: '' }, { update() {}, remove() {}, data() {}, screen() {}, toast() {} }, {} as Ledger, () => 4,
      { taskNaming: false, resolveCommand: () => null, processExists: () => false, spawn() { throw new Error('must not spawn'); } }), /preserve the file/);
    assert.equal(readFileSync(path.join(dir, 'workers.json'), 'utf8'), '{broken');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function chiefFixture() {
  const empire = initialEmpire(1);
  empire.sectors[0].manager = { id: 'manager-hq', name: 'Chief', status: 'working', attempt: 1, jobKey: 'empire-manager-hq-1', taskId: 'task-1', workerId: 'old-worker' };
  const worker = { ...savedWorker(), processState: 'running', status: 'working', viewers: [] } as WorkerInfo;
  return { empire, worker, queue: { tasks: [task()], maxWorkers: 3 } };
}

test('supervision reports each observed job phase independently of delegated preference', () => {
  const f = chiefFixture();
  for (const phase of ['starting', 'idle', 'working', 'needs_input'] as const) {
    f.worker.status = phase;
    for (const delegated of [false, true]) {
      f.empire.delegated = delegated;
      const result = projectSupervision(f.empire, [f.worker], f.queue, 'runtime', 100);
      assert.equal(result.chief.phase, phase);
      assert.equal(result.delegationRequested, delegated);
      assert.deepEqual(result.monitor, { mode: 'rule_based', lastCheckAt: 100 });
    }
  }
  f.queue.tasks[0].status = 'done'; f.queue.tasks[0].outcome = 'done';
  assert.equal(projectSupervision(f.empire, [f.worker], f.queue, 'runtime', 100).chief.phase, 'turn_ended');
  f.queue.tasks[0].outcome = 'failed';
  assert.equal(projectSupervision(f.empire, [f.worker], f.queue, 'runtime', 100).chief.phase, 'failed');
});

test('missing or conflicting process links cannot produce active chief evidence; interruption outranks readiness', () => {
  const f = chiefFixture();
  const project = () => projectSupervision(f.empire, [f.worker], f.queue, 'runtime', 100);
  f.worker.processState = undefined; assert.equal(project().chief.phase, 'unknown');
  f.worker.processState = 'stopped'; assert.equal(project().chief.phase, 'unknown');
  f.worker.processState = 'running'; f.queue.tasks[0].workerId = 'missing'; assert.equal(project().chief.phase, 'unknown');
  f.queue.tasks[0].workerId = 'old-worker'; f.queue.tasks.push(task({ id: 'duplicate' })); assert.equal(project().chief.phase, 'unknown');
  f.queue.tasks.pop(); f.empire.sectors[0].manager!.status = 'ready';
  f.queue.tasks[0].interruption = { reason: 'server_restart', at: 1 };
  assert.equal(project().chief.phase, 'interrupted');
  f.queue.tasks = []; assert.equal(project().chief.phase, 'unknown');
  f.empire.sectors[0].manager!.status = 'pending'; assert.equal(project().chief.phase, 'pending');
  delete f.empire.sectors[0].manager; assert.equal(project().chief.phase, 'unassigned');
});

test('AI supervision counts working agents separately from blocked, idle, shell and unknown workers', () => {
  const f = chiefFixture();
  const workers = [f.worker,
    { ...f.worker, id: 'attention', status: 'needs_input' },
    { ...f.worker, id: 'idle', status: 'idle' },
    { ...f.worker, id: 'starting', status: 'starting' },
    { ...f.worker, id: 'shell', kind: 'shell' },
    { ...f.worker, id: 'unknown', processState: 'unknown' },
  ] as WorkerInfo[];
  f.queue.tasks.push(task({ id: 'queued', status: 'queued' }));
  assert.deepEqual(projectSupervision(f.empire, workers, f.queue, 'runtime', 100).workforce, { active: 1, attention: 1, queued: 1 });
});

test('saved supervision is discarded, never persisted, and regenerated with a new runtime identity', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-supervision-test-'));
  try {
    const stale = initialEmpire(1);
    stale.supervision = { schemaVersion: 1, serverRunId: 'old', observedAt: 1, delegationRequested: true, monitor: { mode: 'rule_based', lastCheckAt: 1 }, chief: { phase: 'working' }, workforce: { active: 99, attention: 0, queued: 0 } };
    writeFileSync(path.join(dir, 'empire.json'), JSON.stringify(stale));
    const e = new Empire(dir, () => {});
    assert.equal(e.state.supervision, undefined);
    e.tick([], { tasks: [], maxWorkers: 0 }, 0);
    assert.equal(e.state.supervision!.chief.phase, 'unassigned');
    assert.notEqual(e.state.supervision!.serverRunId, 'old');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'empire.json'), 'utf8')).supervision, undefined);
    const next = new Empire(dir, () => {}); next.tick([], { tasks: [], maxWorkers: 0 }, 0);
    assert.notEqual(next.state.supervision!.serverRunId, e.state.supervision!.serverRunId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recorded live PIDs remain unknown until an absence probe confirms the prior process ended', async () => {
  const f = fixture([savedWorker({ processState: 'running', processPid: 777 })], [777]);
  try {
    assert.equal(f.workers.list()[0].processState, 'unknown');
    assert.match(f.workers.resume('old-worker')!, /PID 777/);
    assert.match((await f.workers.kill('old-worker')).error!, /PID 777/);
    f.presentPids.delete(777);
    assert.equal(f.workers.list()[0].processState, 'stopped');
    assert.equal(f.workers.resume('old-worker'), undefined);
    assert.equal(f.processes.length, 1);
  } finally { f.close(); }
});

test('queue desk recycling during manual exit cannot remove or replace the same live process twice', async () => {
  const f = fixture();
  try {
    f.setCapacity(1);
    const q = f.queue([], 1);
    q.add('first', 'Fixture'); q.add('second', 'Fixture');
    const id = q.state().tasks[0].workerId!;
    f.processes[0].autoExit = false;
    const stopping = f.workers.kill(id);
    assert.equal(f.processes.length, 1);
    assert.equal(f.processes[0].kills, 1);
    f.processes[0].exit();
    assert.equal((await stopping).error, undefined);
    assert.equal(f.processes.length, 2);
    assert.equal(f.processes[0].kills, 1);
    assert.equal(q.state().tasks[1].status, 'running');
    assert.notEqual(q.state().tasks[1].workerId, id);
  } finally { f.close(); }
});

test('monitoring reports a newly blocked worker even when the attention count stays unchanged', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-attention-test-'));
  try {
    const e = new Empire(dir, () => {});
    const worker = { ...savedWorker(), status: 'needs_input', processState: 'running' } as WorkerInfo;
    e.tick([worker], { tasks: [], maxWorkers: 0 }, 0);
    const before = e.state.reports.length;
    e.tick([{ ...worker, id: 'different-worker' }], { tasks: [], maxWorkers: 0 }, 0);
    assert.equal(e.state.reports.length, before + 1);
    assert.equal(e.state.supervision!.workforce.attention, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('authenticated browser reconnect receives reconciled supervision without launching or bypassing recovery', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-server-test-'));
  let running: Awaited<ReturnType<typeof startServer>> | undefined;
  const sockets: WebSocket[] = [];
  let launches = 0;
  try {
    const city = initialEmpire();
    city.setup.completed = true;
    city.sectors[0].manager = { id: 'manager-hq', name: 'Chief', status: 'working', attempt: 1, jobKey: 'empire-manager-hq-1', taskId: 'task-1', workerId: 'old-worker' };
    writeFileSync(path.join(dir, 'empire.json'), JSON.stringify(city));
    writeFileSync(path.join(dir, 'workers.json'), JSON.stringify([savedWorker()]));
    writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ maxWorkers: 0, tasks: [task()] }));
    const cfg: Config = {
      dir, dataDir: dir, host: '127.0.0.1', port: 0, passwordGenerated: false,
      verifier: Buffer.alloc(32, 1), salt: Buffer.alloc(16, 2), secret: 'fixture-only-secret',
      claimed: true, markClaimed() {}, agentCmd: 'claude', agentArgs: [], trustProxy: false, iceServers: [], budgetPause: false,
    };
    running = await startServer(cfg, {
      publicDir: dir, backgroundServices: false,
      workers: { taskNaming: false, resolveCommand: () => null, processExists: () => true, spawn() { launches++; throw new Error('Fixture must never launch'); } },
    });
    const port = (running.server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const cookie = `ao_session_${port}=${new Auth(cfg.verifier, cfg.salt, cfg.secret).issue()}`;
    async function connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin, headers: { cookie } });
      sockets.push(ws);
      const messages: any[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture handshake timed out')), 3000);
        ws.on('error', reject);
        ws.on('message', raw => {
          const message = JSON.parse(raw.toString()); messages.push(message);
          if (message.t === 'empire') { clearTimeout(timer); resolve(); }
        });
      });
      assert.equal(messages[0].t, 'welcome');
      assert.equal(messages.find(m => m.t === 'empire').state.supervision.chief.phase, 'interrupted');
      assert.equal(messages[0].queue.tasks[0].interruption.reason, 'server_restart');
      return { ws, messages };
    }
    const first = await connect();
    for (const command of [
      { t: 'worker.resume', workerId: 'old-worker' },
      { t: 'worker.kill', workerId: 'old-worker' },
      { t: 'queue.retry', taskId: 'task-1' },
      { t: 'queue.remove', taskId: 'task-1' },
      { t: 'queue.clear' },
      { t: 'empire.action', action: { kind: 'retry-manager', site: 'hq' } },
    ]) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { first.ws.off('message', onMessage); reject(new Error('Recovery command produced no diagnostic')); }, 3000);
        const onMessage = (raw: Buffer) => {
          const message = JSON.parse(raw.toString());
          if (message.t === 'toast') { clearTimeout(timer); first.ws.off('message', onMessage); resolve(); }
        };
        first.ws.on('message', onMessage); first.ws.send(JSON.stringify(command));
      });
    }
    const closed = new Promise<void>(resolve => first.ws.once('close', () => resolve())); first.ws.close(); await closed;
    const second = await connect();
    assert.equal(second.messages[0].queue.tasks.length, 1);
    assert.equal(second.messages[0].workers.length, 1);
    assert.equal(second.messages.find(m => m.t === 'empire').state.sectors[0].manager.attempt, 1);
    assert.equal(launches, 0);
  } finally {
    for (const ws of sockets) ws.terminate();
    if (running) { const closed = new Promise<void>(resolve => running!.server.once('close', () => resolve())); running.shutdown(); await closed; }
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const first of ['manager', 'queue'] as const) for (const maxWorkers of [0, 3])
test(`${first} recovery first shares the same manager task lineage with concurrency ${maxWorkers}`, () => {
  const f = fixture([savedWorker({ processState: 'stopped' })]);
  try {
    const empire = new Empire(f.dir, () => {});
    empire.action({ kind: 'found', sites: [] });
    const manager = empire.state.sectors[0].manager!;
    const originalKey = manager.jobKey;
    const q = f.queue([task({ jobKey: originalKey })], maxWorkers, empire);
    empire.tick(f.workers.list(), q.state(), 0);
    const managementRetry = () => {
      const result = empire.action({ kind: 'retry-manager', site: 'hq' }, q);
      if (!result) empire.dispatchManagers(q, 'Fixture');
      empire.tick(f.workers.list(), q.state(), 0);
      return result;
    };
    const firstResult = first === 'manager' ? managementRetry() : q.retry('task-1');
    assert.equal(firstResult, undefined);
    const secondResult = first === 'manager' ? q.retry('task-1') : managementRetry();
    assert.ok(secondResult, 'the other recovery control must refuse the existing queued/running attempt');
    assert.equal(q.state().tasks.length, 1);
    assert.equal(q.state().tasks[0].id, 'task-1');
    assert.equal(q.state().tasks[0].jobKey, originalKey);
    assert.equal(q.state().tasks[0].attempt, 2);
    assert.equal(manager.jobKey, originalKey);
    assert.equal(f.processes.length, maxWorkers ? 1 : 0);
    assert.equal(JSON.parse(readFileSync(path.join(f.dir, 'queue.json'), 'utf8')).tasks[0].id, 'task-1');
    if (maxWorkers) {
      // Repeating the startup after a completed turn retains the same reward identity.
      const id = q.state().tasks[0].workerId!;
      f.workers.handleHook(id, f.launches[0].token, 'Stop', {});
      assert.equal(empire.state.economy.revenue, 500);
      f.processes[0].exit();
      assert.equal(q.retry('task-1'), undefined);
      const repeatedId = q.state().tasks[0].workerId!;
      f.workers.handleHook(repeatedId, f.launches[1].token, 'Stop', {});
      assert.equal(empire.state.economy.revenue, 500);
      const restored = new Empire(f.dir, () => {});
      restored.tick(f.workers.list(), q.state(), 0);
      assert.equal(restored.state.economy.revenue, 500);
      assert.deepEqual(restored.state.economy.rewardedTasks, ['task-1']);
    }
  } finally { f.close(); }
});

test('superseded legacy manager task keys cannot be retried or automatically seated', () => {
  const f = fixture([savedWorker({ processState: 'stopped' })]);
  try {
    const empire = new Empire(f.dir, () => {});
    empire.action({ kind: 'found', sites: [] });
    const manager = empire.state.sectors[0].manager!;
    manager.jobKey = 'empire-manager-hq-2'; manager.attempt = 2;
    const q = f.queue([
      task({ status: 'done', outcome: 'exited' }),
      task({ id: 'old-queued', jobKey: 'empire-manager-hq-0', status: 'queued', workerId: undefined }),
      task({ id: 'current', jobKey: manager.jobKey, status: 'done', outcome: 'exited' }),
    ], 3, empire);
    empire.tick(f.workers.list(), q.state(), 0);
    assert.match(q.retry('task-1')!, /superseded/);
    q.pump();
    assert.equal(f.processes.length, 0);
    assert.equal(q.state().tasks.find(t => t.id === 'old-queued')!.outcome, 'failed');
    assert.equal(empire.action({ kind: 'retry-manager', site: 'hq' }, q), undefined);
    empire.dispatchManagers(q, 'Fixture');
    assert.equal(f.processes.length, 1);
    assert.equal(q.state().tasks.find(t => t.status === 'running')!.id, 'current');
    assert.match(q.retry('task-1')!, /superseded/);
  } finally { f.close(); }
});

test('a current manager retry cannot overlap an uncertain legacy sibling process', () => {
  const f = fixture([savedWorker()]);
  try {
    const empire = new Empire(f.dir, () => {}); empire.action({ kind: 'found', sites: [] });
    const manager = empire.state.sectors[0].manager!;
    manager.jobKey = 'empire-manager-hq-2'; manager.status = 'offline';
    const q = f.queue([
      task({ status: 'done', outcome: 'exited' }),
      task({ id: 'current', jobKey: manager.jobKey, status: 'done', outcome: 'failed', workerId: undefined }),
    ], 3, empire);
    assert.match(empire.action({ kind: 'retry-manager', site: 'hq' }, q)!, /unknown/);
    assert.match(q.retry('current')!, /unknown/);
    assert.equal(f.processes.length, 0);
  } finally { f.close(); }
});
