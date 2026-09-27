import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Continuity } from '../src/server/continuity';
import { acquireHostLock } from '../src/server/host-lock';
import { SyncArtifacts } from '../src/server/sync-artifacts';
import { initialEmpire } from '../src/shared/empire';
import { Auth } from '../src/server/auth';
import { startServer } from '../src/server/server';
import type { Config } from '../src/server/config';
import type { WorkerInfo } from '../src/shared/protocol';
import type { WorkerRuntime } from '../src/server/workers';

const temporary = () => mkdtempSync(path.join(tmpdir(), 'empire-continuity-'));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repository() {
  const root = temporary();
  const project = path.join(root, 'project'); const data = path.join(root, 'state');
  mkdirSync(project); mkdirSync(data);
  git(project, 'init', '-b', 'main');
  git(project, 'config', 'user.name', 'Fixture'); git(project, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(project, '.gitignore'), '.agent-office/\n');
  writeFileSync(path.join(project, 'base.txt'), 'base\n');
  git(project, 'add', '.'); git(project, 'commit', '-m', 'base');
  const base = git(project, 'rev-parse', 'HEAD');
  const rel = '.agent-office/worktrees/fixture'; const cwd = path.join(project, rel);
  git(project, 'worktree', 'add', '-b', 'office/fixture', cwd);
  writeFileSync(path.join(cwd, 'result.txt'), 'committed result\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'result');
  const worker: WorkerInfo = {
    id: 'fixture-worker', name: 'Fixture', kind: 'agent', deskId: 'desk-1', color: '#123456', status: 'exited', processState: 'stopped',
    createdAt: 1, createdBy: 'Fixture', acked: true, cols: 80, rows: 24, viewers: [], worktree: { path: rel, branch: 'office/fixture', base },
  };
  return { root, project, data, cwd, base, worker };
}

test('continuity checkpoints give bounded ordered replay and retain identity/revisions across restart', () => {
  const dir = temporary();
  try {
    const state = { empire: initialEmpire(), queue: { tasks: [], maxWorkers: 0 }, workers: [] };
    const first = new Continuity(dir, 4); first.observe(state);
    const initial = first.status(); assert.equal(initial.revision, 3);
    const initialFeed = first.feed(); assert.equal(initialFeed.reset, true); assert.equal(initialFeed.snapshot?.revision, 3);
    state.queue.maxWorkers = 1; first.observe(state);
    state.empire.funds += 3; first.observe(state);
    const feed = first.feed(initial.serverId, 3);
    assert.equal(feed.reset, false); assert.deepEqual(feed.events.map(event => [event.revision, event.topic]), [[4, 'queue'], [5, 'empire']]);
    assert.equal(first.feed(initial.serverId, 0).reset, true);
    assert.equal(first.feed('other-server', 5).reset, true);
    assert.equal(first.feed(initial.serverId, 6).reset, true);
    assert.equal(first.feed(initial.serverId, 5).events.length, 0);
    const second = new Continuity(dir, 4);
    assert.equal(second.serverId, first.serverId); assert.equal(second.status().revision, 5);
    assert.notEqual(second.status().serverRunId, initial.serverRunId);
    second.observe(state); assert.equal(second.status().revision, 5); assert.ok(second.status().observedAt > 0);
    // Returned snapshots are detached from persisted state.
    second.feed().snapshot!.queue.maxWorkers = 99;
    assert.equal(second.feed().snapshot!.queue.maxWorkers, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed checkpoint leaves previous revision intact and reports recovery without claiming a saved update', () => {
  const dir = temporary();
  try {
    const store = new Continuity(dir);
    const state = { empire: initialEmpire(), queue: { tasks: [], maxWorkers: 0 }, workers: [] };
    store.observe(state); const before = store.status().revision;
    const file = path.join(dir, 'continuity.json'); renameSync(file, file + '.saved'); mkdirSync(file);
    state.queue.maxWorkers = 2; store.observe(state);
    assert.equal(store.status().revision, before); assert.equal(store.status().durability, 'error');
    assert.equal(store.feed().snapshot!.queue.maxWorkers, 0);
    assert.match(store.status().error!, /last saved revision/);
    rmSync(file, { recursive: true }); renameSync(file + '.saved', file);
    store.observe(state); assert.equal(store.status().revision, before + 1); assert.equal(store.status().durability, 'ok');
    assert.equal(new Continuity(dir).feed().snapshot!.queue.maxWorkers, 2);
    writeFileSync(file, '{bad checkpoint'); assert.throws(() => new Continuity(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('local host ownership rejects another live/unknown owner and safely releases or reclaims absent PIDs', () => {
  const dir = temporary();
  try {
    const release = acquireHostLock(dir);
    assert.throws(() => acquireHostLock(dir), /already owned/); release();
    const owner = path.join(dir, 'server-owner.json');
    writeFileSync(owner, JSON.stringify({ pid: 1073741823, host: hostname() }));
    acquireHostLock(dir)();
    writeFileSync(owner, JSON.stringify({ pid: process.pid, host: 'unknown-host' }));
    assert.throws(() => acquireHostLock(dir), /unknown host/); rmSync(owner);
    writeFileSync(path.join(dir, 'server-starting.lock'), 'interrupted startup');
    assert.throws(() => acquireHostLock(dir), /startup was interrupted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent artifact publish is immutable and self-contained, survives reload and excludes corrupt files', async () => {
  const f = repository();
  try {
    const serverId = randomUUID(); const artifacts = new SyncArtifacts(f.project, f.data, serverId);
    let reservations = 0;
    const publish = () => artifacts.publish(f.worker.id, async callback => { reservations++; return callback(f.worker); });
    const [first, second] = await Promise.all([publish(), publish()]);
    assert.deepEqual(first, second); assert.equal(reservations, 1);
    assert.deepEqual(await publish(), first);
    const bundle = await artifacts.bundle(first.artifactId);
    assert.equal(createHash('sha256').update(readFileSync(bundle.file)).digest('hex'), first.artifactId);
    const destination = path.join(f.root, 'import'); mkdirSync(destination); git(destination, 'init');
    git(destination, 'bundle', 'verify', bundle.file); // Empty repo proves there are no prerequisites.
    git(destination, 'fetch', bundle.file, 'HEAD');
    assert.equal(git(destination, 'rev-parse', 'FETCH_HEAD'), first.commit);
    assert.equal(git(destination, 'show', 'FETCH_HEAD:result.txt'), 'committed result');
    const reloaded = new SyncArtifacts(f.project, f.data, serverId);
    assert.deepEqual(await reloaded.list(), [first]);
    mkdirSync(path.join(f.data, 'sync-artifacts', '.publishing-interrupted'));
    assert.equal((await reloaded.list()).length, 1);
    writeFileSync(bundle.file, 'corrupt');
    await assert.rejects(() => reloaded.bundle(first.artifactId), /integrity/);
    assert.deepEqual(await reloaded.list(), []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('artifact export refuses running, dirty, foreign-root, wrong-branch and nonancestor work', async () => {
  const f = repository();
  try {
    const artifacts = new SyncArtifacts(f.project, f.data, randomUUID());
    const publish = (worker = f.worker) => artifacts.publish(worker.id, callback => callback(worker));
    await assert.rejects(publish({ ...f.worker, processState: 'running' }), /stopped/);
    writeFileSync(path.join(f.cwd, 'untracked.txt'), 'not committed');
    await assert.rejects(publish(), /must be clean/); rmSync(path.join(f.cwd, 'untracked.txt'));
    await assert.rejects(publish({ ...f.worker, worktree: { ...f.worker.worktree!, path: '../' } }), /outside/);
    await assert.rejects(publish({ ...f.worker, worktree: { ...f.worker.worktree!, branch: 'office/wrong' } }), /branch or base/);
    const otherCommit = git(f.project, 'commit-tree', git(f.project, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated root');
    await assert.rejects(publish({ ...f.worker, worktree: { ...f.worker.worktree!, base: otherCommit } }));
    writeFileSync(path.join(f.cwd, 'pointer'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n');
    git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-m', 'LFS fixture');
    await assert.rejects(publish(), /LFS/);
    assert.deepEqual(await artifacts.list(), []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

class FakeProcess {
  pid = 987654;
  kills = 0;
  exitCallback?: (event: { exitCode: number }) => void;
  onData() { return { dispose() {} }; }
  onExit(callback: (event: { exitCode: number }) => void) { this.exitCallback = callback; return { dispose() {} }; }
  write() {} resize() {}
  kill() { this.kills++; this.exitCallback?.({ exitCode: 0 }); }
  exit() { this.exitCallback?.({ exitCode: 0 }); }
}

test('authenticated HTTP/WS continuity survives no-client job completion, reconnect and restart; artifact routes enforce origin', async () => {
  const f = repository();
  const processes: FakeProcess[] = []; const tokens: string[] = []; const sockets: WebSocket[] = [];
  let running: Awaited<ReturnType<typeof startServer>> | undefined;
  const cfg: Config = { dir: f.project, dataDir: f.data, host: '127.0.0.1', port: 0, passwordGenerated: false, verifier: Buffer.alloc(32, 1), salt: Buffer.alloc(16, 2), secret: 'fixture-secret', claimed: true, markClaimed() {}, agentCmd: 'claude', agentArgs: [], trustProxy: false, iceServers: [], budgetPause: false };
  const runtime: WorkerRuntime = { taskNaming: false, resolveCommand: () => '/fixture/claude', processExists: () => false, spawn: ((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => { const process = new FakeProcess(); processes.push(process); tokens.push(opts.env.AGENT_OFFICE_HOOK_TOKEN); return process; }) as WorkerRuntime['spawn'] };
  let origin = ''; let cookie = '';
  async function start() {
    running = await startServer(cfg, { workers: runtime, backgroundServices: false, publicDir: f.root });
    const port = (running.server.address() as { port: number }).port; origin = `http://127.0.0.1:${port}`;
    cookie = `ao_session_${port}=${new Auth(cfg.verifier, cfg.salt, cfg.secret).issue()}`;
  }
  async function stop() {
    const instance = running!; running = undefined;
    const closed = new Promise<void>(resolve => instance.server.once('close', () => resolve())); instance.shutdown(); await closed;
  }
  const get = (route: string) => fetch(origin + route, { headers: { cookie } });
  async function connect() {
    const ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { origin, headers: { cookie } }); sockets.push(ws);
    const messages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No continuity welcome')), 3000);
      ws.on('error', reject); ws.on('message', raw => { const msg = JSON.parse(raw.toString()); messages.push(msg); if (msg.t === 'continuity.status') { clearTimeout(timeout); resolve(); } });
    });
    assert.equal(messages[0].t, 'welcome'); return { ws, messages };
  }
  try {
    writeFileSync(path.join(f.root, 'sw.js'), '// fixture'); writeFileSync(path.join(f.root, 'manifest.webmanifest'), '{}');
    writeFileSync(path.join(f.data, 'workers.json'), JSON.stringify([f.worker]));
    writeFileSync(path.join(f.data, 'queue.json'), JSON.stringify({ maxWorkers: 1, tasks: [] }));
    await start();
    assert.equal((await fetch(origin + '/api/continuity/status')).status, 401);
    assert.equal((await fetch(origin + '/api/sync/artifacts')).status, 401);
    const sw = await fetch(origin + '/sw.js'); assert.equal(sw.status, 200); assert.match(sw.headers.get('cache-control')!, /no-cache|no-store/);
    assert.match((await fetch(origin + '/manifest.webmanifest')).headers.get('content-type')!, /manifest\+json/);
    const initial = await (await get('/api/continuity/status')).json();
    const first = await connect();
    const id = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fixture task did not start')), 3000);
      first.ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        const task = msg.t === 'queue' && msg.state.tasks.find((task: any) => task.status === 'running' && task.workerId);
        if (task) { clearTimeout(timeout); resolve(task.workerId); }
      });
      first.ws.send(JSON.stringify({ t: 'queue.add', prompt: 'fixture only', title: 'No-client job' }));
    });
    const closed = new Promise<void>(resolve => first.ws.once('close', () => resolve())); first.ws.close(); await closed;
    // A user-authorized fixture process continues and completes after every client has closed.
    assert.equal(processes[0].kills, 0);
    running!.workers.handleHook(id, tokens[0], 'SessionStart', { session_id: 'fixture-session' });
    running!.workers.handleHook(id, tokens[0], 'Stop', {}); processes[0].exit();
    assert.equal(running!.workers.get(id)!.processState, 'stopped');
    const replay = await (await get(`/api/continuity/events?serverId=${initial.serverId}&after=${initial.revision}`)).json();
    assert.equal(replay.reset, false); assert.ok(replay.events.some((event: any) => event.topic === 'workers' && event.state.some((worker: any) => worker.id === id && worker.processState === 'stopped')));
    assert.deepEqual(replay.events.map((event: any) => event.revision), Array.from({ length: replay.events.length }, (_, i) => initial.revision + i + 1));
    const second = await connect(); assert.equal(second.messages[0].workers.find((worker: any) => worker.id === id).processState, 'stopped');
    assert.equal(second.messages[0].queue.tasks[0].status, 'done');
    assert.equal(second.messages[0].queue.tasks[0].outcome, 'done');
    const secondClosed = new Promise<void>(resolve => second.ws.once('close', () => resolve())); second.ws.close(); await secondClosed;
    const post = (headers: Record<string, string>) => fetch(origin + '/api/sync/artifacts', { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ workerId: f.worker.id }) });
    assert.equal((await post({})).status, 403); assert.equal((await post({ origin: 'http://elsewhere.invalid' })).status, 403);
    const published = await post({ origin }); assert.equal(published.status, 200); const manifest = await published.json();
    const downloaded = Buffer.from(await (await get(manifest.bundle.url)).arrayBuffer());
    assert.equal(createHash('sha256').update(downloaded).digest('hex'), manifest.artifactId);
    assert.equal((await fetch(origin + manifest.bundle.url)).status, 401);
    const status = await (await get('/api/continuity/status')).json();
    assert.equal(status.serverRunId, second.messages.find(message => message.t === 'empire').state.supervision.serverRunId);
    await stop(); await start();
    const restarted = await (await get('/api/continuity/status')).json();
    assert.equal(restarted.serverId, status.serverId); assert.ok(restarted.revision > status.revision); assert.notEqual(restarted.serverRunId, status.serverRunId);
    assert.equal(processes.length, 1, 'restart and reconnect must never launch a replacement');
    assert.equal((await (await get('/api/sync/artifacts')).json()).artifacts[0].artifactId, manifest.artifactId);
    const journal = readFileSync(path.join(f.data, 'continuity.json'), 'utf8');
    for (const secret of [cfg.secret, cookie, tokens[0]]) assert.equal(journal.includes(secret), false);
  } finally {
    for (const ws of sockets) ws.terminate(); if (running) await stop(); rmSync(f.root, { recursive: true, force: true });
  }
});
