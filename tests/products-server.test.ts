/**
 * FREE-06 /api/products through the real server: same-origin, error mapping, create with a fake gh (never GitHub),
 * unlink guard with an open job, and a chief plan that names a product. No worker process, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/server.js';
import { Auth } from '../src/server/auth.js';
import type { Config } from '../src/server/config.js';
import type { WorkerRuntime } from '../src/server/workers.js';
import type { ChatFn } from '../src/server/chief.js';
import type { GhRunner } from '../src/server/products.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=f@x', '-c', 'user.name=F', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'ignore' });
function repo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(path.join(dir, 'README.md'), 'x');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}
const PLAN = JSON.stringify({ summary: 'One step.', items: [{ title: 'Build', prompt: 'Build it.', phase: 'build', role: 'backend_engineer', parallel: false, dependsOn: [] }] });
const fakeChat: ChatFn = async (p) => ({ text: PLAN, model: p.model, usage: { input: 1, output: 1 }, cost: { usd: 0, kind: 'local', label: 'US$0 · local model' } });

async function fixture(t: { after(fn: () => Promise<void>): void }, seed: { tasks?: unknown[] } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'empire-products-server-')));
  const office = repo(path.join(root, 'office'));
  const dataDir = path.join(office, '.agent-office');
  mkdirSync(dataDir);
  writeFileSync(path.join(dataDir, 'queue.json'), JSON.stringify({ tasks: seed.tasks ?? [], maxWorkers: 0 }));
  const ghCalls: string[][] = [];
  const gh: GhRunner = async (args, cwd) => {
    ghCalls.push(args);
    if (args[0] === 'auth') return 'ok';
    if (args[1] === 'create') { repo(path.join(cwd, args[2])); return 'ok'; }
    throw new Error('unexpected');
  };
  const cfg: Config = { dir: office, dataDir, host: '127.0.0.1', port: 0, passwordGenerated: false, verifier: Buffer.alloc(32, 1), salt: Buffer.alloc(16, 2), secret: 'fixture-only-secret', claimed: true, markClaimed() {}, agentCmd: 'claude', agentArgs: [], trustProxy: false, iceServers: [], budgetPause: false };
  const runtime: WorkerRuntime = { taskNaming: false, resolveCommand: () => '/fixture/claude', processExists: () => false, spawn: (() => { throw new Error('no worker may start in this test'); }) as WorkerRuntime['spawn'] };
  const running = await startServer(cfg, {
    publicDir: dataDir, backgroundServices: false, workers: runtime, telegram: false, email: false, outreach: false, engines: { providerKeys: () => ({}) },
    chief: { chat: fakeChat, probe: async () => ({ running: true, models: ['gpt-oss:20b'] }) },
    products: { gh, productsDir: path.join(root, 'products'), perHour: 3 },
  });
  const port = (running.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const cookie = `ao_session_${port}=${new Auth(cfg.verifier, cfg.salt, cfg.secret).issue()}`;
  t.after(async () => {
    await new Promise<void>((resolve) => { running.server.once('close', () => resolve()); running.shutdown(); });
    rmSync(root, { recursive: true, force: true });
  });
  const api = async (route: string, method = 'GET', body?: unknown, o: { origin?: string } = {}) => {
    const res = await fetch(`${origin}/api/${route}`, { method, headers: { cookie, origin: o.origin ?? origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };
  return { root, office, api, running, ghCalls };
}

test('/api/products: same-origin writes, error mapping, link, create through the server, unlink', async (t) => {
  const f = await fixture(t);
  const alpha = repo(path.join(f.root, 'alpha'));
  const start = await f.api('products');
  assert.equal(start.status, 200);
  assert.deepEqual(start.json.products.map((p: { id: string }) => p.id), ['office']);
  assert.equal((await f.api('products/link', 'POST', { name: 'Alpha', path: alpha }, { origin: 'http://evil.example' })).status, 403, 'cross-origin refused');
  assert.equal((await f.api('products/create', 'POST', { name: 'B', repo: 'b', confirm: 'b' }, { origin: 'http://evil.example' })).status, 403);
  assert.equal(f.ghCalls.length, 0, 'a refused request never reaches gh');
  const bad = await f.api('products/link', 'POST', { name: 'Office', path: f.office });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /office repository/);
  assert.equal((await f.api('products/link', 'POST', { name: 'X', path: alpha, extra: 1 })).status, 400);
  assert.equal((await f.api('products/nope', 'PUT', { maxWorkers: 2 })).status, 404);
  assert.equal((await f.api('products/link/extra', 'POST', {})).status, 404);
  const linked = await f.api('products/link', 'POST', { name: 'Alpha', path: alpha });
  assert.equal(linked.status, 200);
  assert.equal(linked.json.product.id, 'alpha');
  assert.equal((await f.api('products/link', 'POST', { name: 'Alpha', path: alpha })).status, 409);
  const unconfirmed = await f.api('products/create', 'POST', { name: 'Beta', repo: 'beta' });
  assert.equal(unconfirmed.status, 400);
  assert.match(unconfirmed.json.error, /Type the repository name/);
  const made = await f.api('products/create', 'POST', { name: 'Beta', repo: 'beta', confirm: 'beta' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal(made.json.product.private, true);
  assert.ok(f.ghCalls.some((c) => c[1] === 'create' && c.includes('--private')));
  const throttled = await f.api('products/create', 'POST', { name: 'Gamma', repo: 'gamma', confirm: 'gamma' });
  assert.equal(throttled.status, 429);
  assert.match(throttled.json.error, /throttled/);
  // An open client job for the product blocks unlink.
  f.running.consultancy.create({ requestId: 'r1', client: 'C', title: 'T', brief: 'B', productId: 'alpha' }, 'CEO');
  const blocked = await f.api('products/alpha', 'DELETE');
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /1 open job/);
  const job = f.running.consultancy.snapshot().jobs[0];
  f.running.consultancy.reject(job.id, 'CEO');
  assert.equal((await f.api('products/alpha', 'DELETE')).status, 200);
  assert.equal((await f.api('products/office', 'DELETE')).status, 400);
});

test('/api/chief/plans: a plan may name a linked product; an unknown product is refused before any model call', async (t) => {
  const f = await fixture(t);
  const alpha = repo(path.join(f.root, 'alpha'));
  assert.equal((await f.api('products/link', 'POST', { name: 'Alpha', path: alpha })).status, 200);
  assert.equal((await f.api('chief/settings', 'POST', { mode: 'free', freeModel: 'gpt-oss:20b' })).status, 200);
  const unknown = await f.api('chief/plans', 'POST', { requestId: 'p0', client: 'C', title: 'T', brief: 'B', productId: 'zeta' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /No such product/);
  const res = await f.api('chief/plans', 'POST', { requestId: 'p1', client: 'C', title: 'T', brief: 'B', productId: 'alpha' });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.equal(res.json.productId, 'alpha');
  await f.running.chief.idle();
  const plan = f.running.chief.state().plans.find((p) => p.requestId === 'p1')!;
  assert.equal(plan.status, 'proposed', plan.reason);
  const job = f.running.consultancy.snapshot().jobs.find((j) => j.id === plan.jobId)!;
  assert.equal(job.productId, 'alpha');
  assert.equal(job.decision, 'pending_approval', 'still a proposal');
});

test('review 2.1: ids named by saved work but missing from the registry are retired at startup (products.json moved away)', async (t) => {
  const f = await fixture(t, { tasks: [{ id: 'old000000001', title: 'Old Acme work', prompt: 'p', addedBy: 'CEO', addedAt: 1, status: 'queued', productId: 'acme', productName: 'Acme' }] });
  const other = repo(path.join(f.root, 'acme-new'));
  const linked = await f.api('products/link', 'POST', { name: 'Acme', path: other });
  assert.equal(linked.status, 200);
  assert.notEqual(linked.json.product.id, 'acme', 'the relinked repo never inherits the old work');
});
