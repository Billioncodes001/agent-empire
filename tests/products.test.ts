/**
 * FREE-06: one repository per product. Fakes only: a fake gh (never GitHub), fake worker processes, temp git repos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Products, ProductError, githubOf, MIN_CREATE_GAP_MS, type GhRunner } from '../src/server/products';
import { WorkerManager, type WorkerRuntime } from '../src/server/workers';
import { TaskQueue, type QueueWorkers } from '../src/server/queue';
import { Consultancy } from '../src/server/consultancy';
import type { QueueState, QueueTask, WorkerInfo } from '../src/shared/protocol';
import type { Ledger } from '../src/server/usage';

const tmp = (tag: string) => realpathSync(mkdtempSync(path.join(tmpdir(), `free06-${tag}-`)));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=f@x', '-c', 'user.name=F', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo(dir: string, remote?: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(path.join(dir, 'README.md'), path.basename(dir));
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

/** A fake gh: `auth status` passes (or not); `repo create X --clone` makes a local repo with a GitHub-style remote. */
function fakeGh(opts: { signedIn?: boolean; fail?: boolean } = {}) {
  const calls: { args: string[]; cwd: string }[] = [];
  const gh: GhRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === 'auth') { if (opts.signedIn === false) throw new Error('You are not logged into any GitHub hosts'); return 'Logged in'; }
    if (args[0] === 'repo' && args[1] === 'create') {
      if (opts.fail) throw new Error('HTTP 403: secondary rate limit');
      const name = args[2];
      const short = name.split('/').pop()!;
      repo(path.join(cwd, short), `https://github.com/${name.includes('/') ? name : `fixture-user/${name}`}.git`);
      return `https://github.com/fixture-user/${short}`;
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

function setup(opts: { perHour?: number; gh?: GhRunner; usage?: (id: string) => { workers: number; openTasks: number; openJobs?: number }; home?: string; defaultProductsDir?: boolean } = {}) {
  const root = tmp('reg');
  const office = repo(path.join(root, 'office'));
  const data = path.join(office, '.agent-office');
  mkdirSync(data, { recursive: true });
  let now = 1_000_000_000_000;
  const make = () => new Products({ dataDir: data, officeDir: office, officeName: 'office', productsDir: opts.defaultProductsDir ? undefined : path.join(root, 'products'), perHour: opts.perHour, home: opts.home ?? path.join(root, 'fake-home'), gh: opts.gh, now: () => now, usage: opts.usage });
  return { root, office, data, make, advance(ms: number) { now += ms; }, close() { rmSync(root, { recursive: true, force: true }); } };
}

test('the office repository is the default product; no products.json means only it', () => {
  const s = setup();
  try {
    const p = s.make();
    const list = p.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'office');
    assert.equal(list[0].origin, 'office');
    assert.equal(p.dir(undefined), s.office);
    assert.equal(p.dir('office'), s.office);
    assert.equal(existsSync(path.join(s.data, 'products.json')), false, 'nothing is written for the default product');
    assert.equal(p.problem(undefined), undefined);
    assert.match(p.problem('nope')!, /No such product/);
  } finally { s.close(); }
});

test('linking validates the repo, persists, and survives a restart; unlink never deletes the folder', () => {
  let use = { workers: 0, openTasks: 0 };
  const s = setup({ usage: () => use });
  try {
    const a = repo(path.join(s.root, 'alpha'), 'git@github.com:acme/alpha.git');
    const p = s.make();
    assert.throws(() => p.link({ name: 'Office again', path: s.office }, 'CEO'), /office repository/);
    assert.throws(() => p.link({ name: 'Relative', path: 'alpha' }, 'CEO'), /absolute/);
    mkdirSync(path.join(s.root, 'plain'));
    assert.throws(() => p.link({ name: 'Plain', path: path.join(s.root, 'plain') }, 'CEO'), /not a git repository/);
    mkdirSync(path.join(a, 'sub'));
    assert.throws(() => p.link({ name: 'Sub', path: path.join(a, 'sub') }, 'CEO'), /inside the repository/);
    assert.throws(() => p.link({ name: 'X', path: a, extra: 1 }, 'CEO'), /Unknown field/);
    const linked = p.link({ name: 'Alpha App', client: 'Acme', path: a }, 'CEO');
    assert.equal(linked.id, 'alpha-app');
    assert.equal(linked.github, 'acme/alpha');
    assert.equal(linked.defaultBranch, 'main');
    assert.equal(linked.present, true);
    assert.match(readFileSync(path.join(a, '.git/info/exclude'), 'utf8'), /\.agent-office\//);
    assert.throws(() => p.link({ name: 'Alpha twice', path: a }, 'CEO'), /Already linked/);
    const again = s.make();
    assert.deepEqual(again.list().map((x) => x.id), ['office', 'alpha-app']);
    assert.equal(again.dir('alpha-app'), a);
    again.update('alpha-app', { maxWorkers: 2 });
    assert.equal(s.make().maxWorkers('alpha-app'), 2);
    use = { workers: 1, openTasks: 0 };
    assert.throws(() => again.unlink('alpha-app'), /still has 1 worker/);
    use = { workers: 0, openTasks: 0 };
    again.unlink('alpha-app');
    assert.equal(existsSync(a), true, 'the folder is never deleted');
    assert.throws(() => again.unlink('office'), /cannot be unlinked/);
  } finally { s.close(); }
});

test('a corrupt products.json is a recovery error; the office product still works', () => {
  const s = setup();
  try {
    writeFileSync(path.join(s.data, 'products.json'), '{broken');
    const p = s.make();
    assert.match(p.recoveryError!, /could not be read/);
    assert.deepEqual(p.list().map((x) => x.id), ['office']);
    assert.equal(p.dir(undefined), s.office);
    assert.throws(() => p.link({ name: 'A', path: s.office }, 'CEO'), (e: unknown) => e instanceof ProductError && e.status === 503);
    assert.equal(readFileSync(path.join(s.data, 'products.json'), 'utf8'), '{broken', 'the bytes are preserved');
  } finally { s.close(); }
});

test('creating a repo needs the typed name, a signed-in gh, and is private by default (fake gh only)', async () => {
  const f = fakeGh();
  const s = setup({ gh: f.gh });
  try {
    const p = s.make();
    await assert.rejects(p.create({ name: 'Beta', repo: 'beta-app' }, 'CEO'), /Type the repository name/);
    await assert.rejects(p.create({ name: 'Beta', repo: '--upload-pack=x', confirm: '--upload-pack=x' }, 'CEO'), /repo must be/);
    await assert.rejects(p.create({ name: 'Beta', repo: '../x', confirm: '../x' }, 'CEO'), /repo must be/);
    assert.equal(f.calls.length, 0, 'nothing ran before confirmation and validation');
    const made = await p.create({ name: 'Beta', client: 'Bee Co', repo: 'beta-app', confirm: 'beta-app' }, 'CEO');
    const create = f.calls.find((c) => c.args[1] === 'create')!;
    assert.deepEqual(create.args.slice(0, 6), ['repo', 'create', 'beta-app', '--private', '--add-readme', '--clone']);
    assert.equal(create.cwd, path.join(s.root, 'products'));
    assert.equal(made.origin, 'created');
    assert.equal(made.private, true);
    assert.equal(made.github, 'fixture-user/beta-app');
    assert.equal(made.dir, path.join(s.root, 'products', 'beta-app'));
    const signedOut = setup({ gh: fakeGh({ signedIn: false }).gh });
    try {
      await assert.rejects(signedOut.make().create({ name: 'C', repo: 'c', confirm: 'c' }, 'CEO'), /gh is not signed in.*never asks for or stores/);
    } finally { signedOut.close(); }
  } finally { s.close(); }
});

test('repository creation is throttled per hour and spaced; failed attempts count and the window survives a restart', async () => {
  const f = fakeGh();
  const s = setup({ gh: f.gh, perHour: 2 });
  try {
    const p = s.make();
    await p.create({ name: 'One', repo: 'one', confirm: 'one' }, 'CEO');
    await assert.rejects(p.create({ name: 'Two', repo: 'two', confirm: 'two' }, 'CEO'), /throttled.*Next allowed/);
    s.advance(MIN_CREATE_GAP_MS);
    await p.create({ name: 'Two', repo: 'two', confirm: 'two' }, 'CEO');
    s.advance(MIN_CREATE_GAP_MS);
    const restarted = s.make();
    assert.equal(restarted.state().creation.usedThisHour, 2);
    await assert.rejects(restarted.create({ name: 'Three', repo: 'three', confirm: 'three' }, 'CEO'), /at most 2 an hour/);
    s.advance(3_600_000);
    assert.equal(restarted.nextAllowedAt(), undefined);
    const failing = setup({ gh: fakeGh({ fail: true }).gh, perHour: 1 });
    try {
      const q = failing.make();
      await assert.rejects(q.create({ name: 'F', repo: 'f', confirm: 'f' }, 'CEO'), /GitHub did not create f/);
      failing.advance(MIN_CREATE_GAP_MS);
      await assert.rejects(q.create({ name: 'G', repo: 'g', confirm: 'g' }, 'CEO'), /throttled/);
    } finally { failing.close(); }
  } finally { s.close(); }
});

test('githubOf reads https and ssh remotes', () => {
  assert.equal(githubOf('https://github.com/a/b.git'), 'a/b');
  assert.equal(githubOf('git@github.com:a/b'), 'a/b');
  assert.equal(githubOf('https://gitlab.com/a/b.git'), undefined);
});

// ---- Workers: cwd and worktrees come from the product's repository ------------------------------------------------

function workerFixture(saved: unknown[] = []) {
  const root = tmp('workers');
  const office = repo(path.join(root, 'office'));
  const alpha = repo(path.join(root, 'alpha'));
  const data = path.join(root, 'data');
  mkdirSync(data);
  writeFileSync(path.join(data, 'workers.json'), JSON.stringify(saved));
  const launches: { cwd: string }[] = [];
  const runtime: WorkerRuntime = {
    taskNaming: false,
    resolveCommand: () => '/fixture/claude',
    processExists: () => false,
    spawn: ((_c: string, _a: string[], options: { cwd: string }) => {
      launches.push({ cwd: options.cwd });
      return { pid: 9000 + launches.length, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {} };
    }) as unknown as WorkerRuntime['spawn'],
  };
  const known: Record<string, string> = { alpha };
  const toasts: string[] = [];
  const ledger = { get hiringPaused() { return undefined; }, add() {} } as unknown as Ledger;
  const workers = new WorkerManager(office, data, 'claude', [], { url: 'http://127.0.0.1:1', token: '' }, { update() {}, remove() {}, data() {}, screen() {}, toast: (t: string) => toasts.push(t) }, ledger, () => 4, runtime, () => undefined, undefined, (id) => (id === undefined ? office : known[id]));
  return { toasts, root, office, alpha, data, workers, launches, known, close() { workers.shutdown(); rmSync(root, { recursive: true, force: true }); } };
}

test('a product worker runs in its own repository and worktree; the office worker is unchanged', () => {
  const f = workerFixture();
  try {
    const a = f.workers.spawn('desk-1', 'CEO', 'build alpha', true, 'agent', false, undefined, undefined, undefined, { productId: 'alpha', productName: 'Alpha' });
    assert.equal(typeof a, 'object', String(a));
    const aw = a as WorkerInfo;
    assert.equal(aw.productId, 'alpha');
    assert.equal(aw.productName, 'Alpha');
    assert.ok(f.launches[0].cwd.startsWith(path.join(f.alpha, '.agent-office', 'worktrees')), f.launches[0].cwd);
    assert.ok(existsSync(path.join(f.alpha, aw.worktree!.path)), 'the worktree is in the product repo');
    assert.ok(!f.launches[0].cwd.startsWith(f.office), 'never the office repo');
    assert.equal(f.workers.branchExists(aw.worktree!.branch, 'alpha'), true);
    assert.equal(f.workers.branchExists(aw.worktree!.branch), false, 'the office repo does not see product branches');
    const o = f.workers.spawn('desk-2', 'CEO', 'office work', true) as WorkerInfo;
    assert.equal(o.productId, undefined);
    assert.ok(f.launches[1].cwd.startsWith(path.join(f.office, '.agent-office', 'worktrees')));
    const plain = f.workers.spawn('desk-3', 'CEO', 'no worktree', false, 'agent', false, undefined, undefined, undefined, { productId: 'alpha' }) as WorkerInfo;
    assert.equal(f.launches[2].cwd, f.alpha);
    assert.equal(plain.productId, 'alpha');
    assert.match(f.workers.spawn('desk-4', 'CEO', 'x', true, 'agent', false, undefined, undefined, undefined, { productId: 'gone' }) as string, /not linked any more/);
    // isolation: no worker of one product was handed the other's path
    const owners = f.workers.owners();
    assert.ok(owners.find((x) => x.workerId === aw.id)!.cwd.startsWith(f.alpha));
    assert.ok(owners.find((x) => x.workerId === o.id)!.cwd.startsWith(f.office));
  } finally { f.close(); }
});

test('saved workers keep their product; saves from before products load as office workers', () => {
  const f = workerFixture([
    { id: 'w-old', kind: 'agent', name: 'Ada', deskId: 'desk-1', createdBy: 'x', createdAt: 1, processState: 'stopped' },
    { id: 'w-new', kind: 'agent', name: 'Bob', deskId: 'desk-2', createdBy: 'x', createdAt: 1, processState: 'stopped', productId: 'alpha', productName: 'Alpha' },
  ]);
  try {
    assert.equal(f.workers.get('w-old')!.productId, undefined);
    assert.equal(f.workers.get('w-new')!.productId, 'alpha');
    assert.equal(f.workers.owners().find((x) => x.workerId === 'w-new')!.cwd, f.alpha);
  } finally { f.close(); }
});

// ---- Queue: tasks carry the product; caps, unlinked products and continuity per product ----------------------------

function queueFixture(products: Record<string, { name: string; maxWorkers?: number } | undefined>, saved?: unknown) {
  const dir = tmp('queue');
  if (saved) writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(saved));
  const list: WorkerInfo[] = [];
  const spawns: { desk: string; extra?: { productId?: string; productName?: string } }[] = [];
  const toasts: string[] = [];
  const workers: QueueWorkers = {
    list: () => list,
    workstationCapacity: () => 4,
    deskOccupied: (d) => list.some((w) => w.deskId === d),
    spawn(deskId, _by, prompt, _wt, _k, _q, _o, _p, _c, extra) {
      spawns.push({ desk: deskId, extra });
      const w = { id: `w${spawns.length}`, kind: 'agent', deskId, name: `W${spawns.length}`, color: '#000', status: 'working', acked: true, createdBy: 'q', createdAt: 1, prompt, cols: 1, rows: 1, viewers: [], ...(extra?.productId ? { productId: extra.productId } : {}) } as WorkerInfo;
      list.push(w);
      return w;
    },
    branchExists: () => false,
    kill: async () => ({}),
  };
  const q = new TaskQueue(dir, workers, false, {
    update() {}, toast: (t) => toasts.push(t), claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined,
    product: (id) => (products[id] ? { name: products[id]!.name, maxWorkers: products[id]!.maxWorkers } : { error: `No such product: ${id}` }),
  });
  return { dir, q, spawns, toasts, products, close() { q.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test('queue tasks carry their product to the worker; unknown products are refused; office tasks unchanged', () => {
  const f = queueFixture({ alpha: { name: 'Alpha' } });
  try {
    assert.match(f.q.add('x', 'CEO', undefined, undefined, undefined, undefined, { productId: 'nope' })!, /No such product/);
    assert.equal(f.q.add('build alpha', 'CEO', undefined, undefined, undefined, undefined, { productId: 'alpha' }), undefined);
    assert.equal(f.q.add('office work', 'CEO'), undefined);
    f.q.setLimit(4);
    f.q.pump();
    const [a, o] = f.q.state().tasks;
    assert.equal(a.productId, 'alpha');
    assert.equal(a.productName, 'Alpha');
    assert.equal(o.productId, undefined);
    assert.deepEqual(f.spawns[0].extra, { productId: 'alpha', productName: 'Alpha' });
    assert.equal(f.spawns[1].extra, undefined, 'office tasks spawn exactly as before');
    // persisted
    const saved = JSON.parse(readFileSync(path.join(f.dir, 'queue.json'), 'utf8'));
    assert.equal(saved.tasks[0].productId, 'alpha');
  } finally { f.close(); }
});

test('a product cap holds its tasks while others run; an unlinked product fails its task instead of running elsewhere', () => {
  const f = queueFixture({ alpha: { name: 'Alpha', maxWorkers: 1 }, beta: { name: 'Beta' } });
  try {
    f.q.add('a1', 'CEO', undefined, undefined, undefined, undefined, { productId: 'alpha' });
    f.q.add('a2', 'CEO', undefined, undefined, undefined, undefined, { productId: 'alpha' });
    f.q.add('b1', 'CEO', undefined, undefined, undefined, undefined, { productId: 'beta' });
    f.q.setLimit(4);
    f.q.pump();
    const t = f.q.state().tasks;
    assert.deepEqual(t.map((x) => x.status), ['running', 'queued', 'running']);
    assert.match(t[1].error!, /Alpha already has 1 busy worker/);
    const g = queueFixture({ beta: { name: 'Beta' } });
    try {
      g.q.setLimit(0);
      g.q.add('b', 'CEO', undefined, undefined, undefined, undefined, { productId: 'beta' });
      g.products.beta = undefined;
      g.q.setLimit(2);
      g.q.pump();
      const [b] = g.q.state().tasks;
      assert.equal(b.status, 'done');
      assert.equal(b.outcome, 'failed');
      assert.match(b.error!, /No such product/);
      assert.equal(g.spawns.length, 0);
    } finally { g.close(); }
  } finally { f.close(); }
});

test('a queue saved before products loads unchanged (office tasks)', () => {
  const old: QueueTask = { id: 'aaaaaaaaaaaa', title: 'Old', prompt: 'old', addedBy: 'x', addedAt: 1, status: 'queued' };
  const f = queueFixture({}, { maxWorkers: 0, tasks: [old] });
  try {
    const [t] = f.q.state().tasks;
    assert.equal(t.id, old.id);
    assert.equal(t.productId, undefined);
  } finally { f.close(); }
});

// ---- Consultancy: a job names a product; every item is queued in it ------------------------------------------------

test('a client job bound to a product queues every item in that product; unknown products are refused', () => {
  const dir = tmp('consult');
  try {
    const tasks: QueueTask[] = [];
    const adds: { productId?: string }[] = [];
    const queue = {
      state: (): QueueState => ({ tasks: tasks.map((t) => ({ ...t })), maxWorkers: 3 }),
      add(prompt: string, by: string, title?: string, _i?: number, jobKey?: string, _d?: readonly string[], options?: { productId?: string }) {
        adds.push({ productId: options?.productId });
        tasks.push({ id: `t${tasks.length + 1}`, title: title ?? prompt, prompt, addedBy: by, addedAt: 1, status: 'queued', jobKey, ...(options?.productId ? { productId: options.productId } : {}) });
        return undefined;
      },
    };
    const ports = { productProblem: (id: string) => (id === 'alpha' ? undefined : `No such product: ${id}`) };
    const c = new Consultancy(dir, queue, undefined, ports);
    assert.throws(() => c.create({ requestId: 'r0', client: 'C', title: 'T', brief: 'B', productId: 'zeta' }, 'CEO'), /No such product/);
    const job = c.create({ requestId: 'r1', client: 'Acme', title: 'Alpha site', brief: 'Build it', productId: 'alpha', tasks: [{ title: 'one', prompt: 'p1' }, { title: 'two', prompt: 'p2', parallel: true }] }, 'CEO');
    assert.equal(job.productId, 'alpha');
    c.approve(job.id, 'CEO');
    assert.deepEqual(adds, [{ productId: 'alpha' }, { productId: 'alpha' }]);
    const plain = c.create({ requestId: 'r2', client: 'Acme', title: 'Office', brief: 'B' }, 'CEO');
    assert.equal(plain.productId, undefined);
    c.approve(plain.id, 'CEO');
    assert.deepEqual(adds[2], { productId: undefined });
    // The journal restores with the product, and the same request is idempotent.
    const again = new Consultancy(dir, queue, undefined, ports);
    assert.equal(again.snapshot().jobs.find((j) => j.id === job.id)!.productId, 'alpha');
    assert.equal(again.create({ requestId: 'r1', client: 'Acme', title: 'Alpha site', brief: 'Build it', productId: 'alpha', tasks: [{ title: 'one', prompt: 'p1' }, { title: 'two', prompt: 'p2', parallel: true }] }, 'CEO').id, job.id);
    assert.throws(() => again.create({ requestId: 'r1', client: 'Acme', title: 'Alpha site', brief: 'Build it', tasks: [{ title: 'one', prompt: 'p1' }, { title: 'two', prompt: 'p2', parallel: true }] }, 'CEO'), /different content/);
    // Without a products port, a product is refused (never silently dropped).
    assert.throws(() => new Consultancy(tmp('consult2'), queue).create({ requestId: 'r9', client: 'C', title: 'T', brief: 'B', productId: 'alpha' }, 'CEO'), /not available/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Security review fixes (FREE-06 review 1) ----------------------------------------------------------------------

test('review 1.1: a product id is never reused after unlink, across restarts', () => {
  const s = setup();
  try {
    const first = repo(path.join(s.root, 'acme-one'));
    const second = repo(path.join(s.root, 'acme-two'));
    const p = s.make();
    assert.equal(p.link({ name: 'Acme', path: first }, 'CEO').id, 'acme');
    p.unlink('acme');
    const again = s.make();
    const relinked = again.link({ name: 'Acme', path: second }, 'CEO');
    assert.notEqual(relinked.id, 'acme', 'the old id stays retired, so old jobs and tasks can never land in the new repo');
    assert.match(relinked.id, /^acme-[0-9a-f]{6}$/);
    assert.equal(s.make().problem('acme')?.startsWith('No such product'), true);
  } finally { s.close(); }
});

test('review 1.1: unlink is refused while client jobs or chief plans for the product are open', () => {
  let use = { workers: 0, openTasks: 0, openJobs: 1 };
  const s = setup({ usage: () => use });
  try {
    const a = repo(path.join(s.root, 'alpha'));
    const p = s.make();
    p.link({ name: 'Alpha', path: a }, 'CEO');
    assert.throws(() => p.unlink('alpha'), /1 open job\(s\) or plan\(s\)/);
    use = { workers: 0, openTasks: 0, openJobs: 0 };
    p.unlink('alpha');
  } finally { s.close(); }
});

test('review 1.2: home, system folders, folders containing them, and the office data folder are refused', () => {
  const s = setup();
  try {
    const home = repo(path.join(s.root, 'home-user'));
    const p = new Products({ dataDir: s.data, officeDir: s.office, officeName: 'office', productsDir: path.join(s.root, 'products'), home });
    assert.throws(() => p.link({ name: 'Dotfiles', path: home }, 'CEO'), /is \(or contains\).*home or system folder/);
    // A repository around the (fake) home folder contains it.
    const outer = repo(path.join(s.root, 'outer'));
    const innerHome = path.join(outer, 'me');
    mkdirSync(innerHome);
    const q = new Products({ dataDir: s.data, officeDir: s.office, officeName: 'office', productsDir: path.join(s.root, 'products'), home: innerHome });
    assert.throws(() => q.link({ name: 'Outer', path: outer }, 'CEO'), /home or system folder/);
    // Inside the data folder only the products folder may hold products.
    const stray = repo(path.join(s.data, 'stray'));
    assert.throws(() => p.link({ name: 'Stray', path: stray }, 'CEO'), /only repositories in the products folder|inside the office repository/);
  } finally { s.close(); }
});

test('review 1.2: a repository created into the default products folder (inside the office data folder) is accepted', async () => {
  const s = setup({ gh: fakeGh().gh, defaultProductsDir: true });
  try {
    const made = await s.make().create({ name: 'Gamma', repo: 'gamma', confirm: 'gamma' }, 'CEO');
    assert.equal(made.dir, path.join(s.data, 'products', 'gamma'));
  } finally { s.close(); }
});

test('review: linking through a symlink stores the real path; a nested or overlapping repo is refused', () => {
  const s = setup();
  try {
    const a = repo(path.join(s.root, 'alpha'));
    const link = path.join(s.root, 'alpha-link');
    symlinkSync(a, link);
    const p = s.make();
    assert.equal(p.link({ name: 'Alpha', path: link }, 'CEO').dir, a);
    assert.throws(() => p.link({ name: 'Alpha again', path: a }, 'CEO'), /Already linked/);
    const nested = repo(path.join(a, 'vendor', 'lib'));
    assert.throws(() => p.link({ name: 'Nested', path: nested }, 'CEO'), /Overlaps the product Alpha/);
    const parentRepo = path.join(s.root, 'parent');
    mkdirSync(parentRepo);
    const b = repo(path.join(parentRepo, 'beta'));
    p.link({ name: 'Beta', path: b }, 'CEO');
    repo(parentRepo);
    assert.throws(() => p.link({ name: 'Parent', path: parentRepo }, 'CEO'), /Overlaps the product Beta/);
  } finally { s.close(); }
});

test('review 3: a creation whose throttle record cannot be saved stops before gh creates anything', async () => {
  const f = fakeGh();
  const s = setup({ gh: f.gh });
  try {
    const p = s.make();
    mkdirSync(path.join(s.data, 'products.json'));
    await assert.rejects(p.create({ name: 'Delta', repo: 'delta', confirm: 'delta' }, 'CEO'), /Nothing was created on GitHub/);
    assert.equal(f.calls.some((c) => c.args[1] === 'create'), false);
  } finally { s.close(); }
});

test('review 4-6: an unlinked or broken product never runs or is attributed elsewhere', () => {
  const f = workerFixture([{ id: 'w-gone', kind: 'agent', name: 'Ada', deskId: 'desk-1', createdBy: 'x', createdAt: 1, processState: 'stopped', productId: 'gone', productName: 'Gone' }]);
  try {
    assert.equal(f.workers.owners().some((o) => o.workerId === 'w-gone'), false, 'not attributed to the office folder');
    f.workers.resume('w-gone');
    assert.equal(f.launches.length, 0);
    assert.ok(f.toasts.some((t) => /no longer linked/.test(t)), f.toasts.join(' | '));
    // The folder is still there but is no longer a repository's top level.
    rmSync(path.join(f.alpha, '.git'), { recursive: true, force: true });
    assert.match(f.workers.spawn('desk-2', 'CEO', 'x', false, 'agent', false, undefined, undefined, undefined, { productId: 'alpha' }) as string, /no longer the top of a git repository/);
    assert.equal(f.launches.length, 0);
  } finally { f.close(); }
});

test('review: a task never continues a dependency from another product', () => {
  const done: QueueTask = { id: 'dep000000001', title: 'Alpha work', prompt: 'p', addedBy: 'x', addedAt: 1, status: 'done', outcome: 'done', branch: 'office/ada-1', productId: 'alpha', productName: 'Alpha' };
  const next: QueueTask = { id: 'nxt000000001', title: 'Beta work', prompt: 'p', addedBy: 'x', addedAt: 2, status: 'queued', dependsOn: [done.id], productId: 'beta', productName: 'Beta' };
  const f = queueFixture({ alpha: { name: 'Alpha' }, beta: { name: 'Beta' } }, { maxWorkers: 0, tasks: [done, next] });
  try {
    f.q.setLimit(2);
    f.q.pump();
    assert.equal(f.spawns.length, 1);
    assert.deepEqual(f.spawns[0].extra, { productId: 'beta', productName: 'Beta' });
    assert.equal(f.q.state().tasks.find((t) => t.id === next.id)!.status, 'running');
  } finally { f.close(); }
});

test('review 2.2: paths are compared in their true on-disk case (case-insensitive file systems)', (t) => {
  const s = setup();
  try {
    const a = repo(path.join(s.root, 'casey'));
    const upper = path.join(s.root, 'CASEY');
    if (!existsSync(upper)) { t.skip('case-sensitive file system'); return; }
    const p = s.make();
    const linked = p.link({ name: 'Casey', path: upper }, 'CEO');
    assert.equal(linked.dir, a, 'stored with its real case');
    assert.throws(() => p.link({ name: 'Casey again', path: a }, 'CEO'), /Already linked/);
    assert.throws(() => p.link({ name: 'Office', path: s.office.toUpperCase() === s.office ? s.office : path.join(path.dirname(s.office), path.basename(s.office).toUpperCase()) }, 'CEO'), /office repository/);
  } finally { s.close(); }
});

test('review 2.1: retireMissing retires unknown ids (not linked ones, not office) and persists them', () => {
  const s = setup();
  try {
    const p = s.make();
    p.link({ name: 'Beta', path: repo(path.join(s.root, 'beta')) }, 'CEO');
    assert.deepEqual(p.retireMissing(['acme', undefined, 'office', 'beta', 'acme']), ['acme']);
    assert.notEqual(s.make().link({ name: 'Acme', path: repo(path.join(s.root, 'acme')) }, 'CEO').id, 'acme');
  } finally { s.close(); }
});
