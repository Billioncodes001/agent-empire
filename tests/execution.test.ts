import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionManager, ExecutionError, type ExecutionOptions } from '../src/server/execution';
import type { ExecutionConfig, ExecutionSubmit } from '../src/shared/execution';

const API_KEY = 'fixture-anthropic-secret'; const GITHUB_TOKEN = 'fixture-github-secret';
const AGENT = 'agent_fixture1'; const ENV = 'env_fixture1'; const SESSION = 'sesn_fixture1';
const SHA = 'a'.repeat(40);
const config = (patch: Partial<ExecutionConfig> = {}): ExecutionConfig => ({ schemaVersion: 1, completed: true, mode: 'anthropic_cloud', repository: { owner: 'fixture', name: 'repo', baseBranch: 'main' }, anthropic: { agentId: AGENT, environmentId: ENV }, githubAuth: 'host_token', limits: { maxConcurrent: 1, perTaskBudgetCents: 100, dailyBudgetCents: 300 }, ...patch });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: URL; init: RequestInit; body?: any };
class FakeProvider {
  calls: Call[] = [];
  status = 'running'; archivedAt: string | null = null;
  cost = '7'; stopReason = 'end_turn'; nextPage: string | null = null;
  eventTime = '2026-09-27T12:00:00Z';
  override?: (call: Call) => Response | Promise<Response> | undefined;
  transport: typeof fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: new URL(String(url)), init, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) }; this.calls.push(call);
    const overridden = this.override?.(call); if (overridden) return await overridden;
    if (call.url.host === 'api.github.com') {
      if (call.url.pathname.endsWith('/commits/main')) return json({ sha: SHA });
      return json({ full_name: 'fixture/repo', archived: false, disabled: false, permissions: { pull: true } });
    }
    if (call.url.pathname.startsWith('/v1/agents/')) return json({ id: AGENT, type: 'agent', version: 3, archived_at: null, multiagent: null, tools: [{ type: 'agent_toolset_20260401' }] });
    if (call.url.pathname.startsWith('/v1/environments/')) return json({ id: ENV, archived_at: null, config: { type: 'cloud' } });
    if (call.url.pathname.startsWith('/v1/vaults/')) return json({ id: 'vlt_fixture1', archived_at: null });
    if (call.url.pathname.endsWith('/archive')) { this.status = 'terminated'; this.archivedAt = this.eventTime; return json(this.session()); }
    if (call.url.pathname.endsWith('/events')) {
      if (init.method === 'POST') { this.status = 'idle'; return json({ data: [{ id: 'sevt_fixture1', type: 'user.interrupt' }] }); }
      return json({ data: [{ id: 'sevt_fixture1', type: 'session.status_idle', stop_reason: { type: this.stopReason }, processed_at: this.eventTime }], next_page: this.nextPage });
    }
    return json(this.session());
  }) as typeof fetch;
  session() { return { type: 'session', id: SESSION, status: this.status, archived_at: this.archivedAt, budget: { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } }, usage: { list_cost: { amount: this.cost, currency: 'USD' } } }; }
  creates() { return this.calls.filter(call => call.url.pathname === '/v1/sessions' && call.init.method === 'POST'); }
}
function fixture(options: ExecutionOptions = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-execution-')); const fake = new FakeProvider();
  let now = Date.parse('2026-09-27T12:00:00Z');
  const opts: ExecutionOptions = { fetch: fake.transport, apiKey: () => API_KEY, githubToken: () => GITHUB_TOKEN, now: () => now, ...options };
  const manager = new ExecutionManager(dir, opts); const managers = [manager];
  return {
    dir, fake, manager, setNow(value: number) { now = value; },
    reopen() { const next = new ExecutionManager(dir, opts); managers.push(next); return next; },
    input(id = randomUUID()): ExecutionSubmit { return { id, prompt: 'Fix fixture issue', configRevision: manager.setup().configRevision, confirmPaid: true }; },
    async ready(settings = config()) { manager.updateSetup(settings); assert.equal((await manager.check()).ready, true); },
    close() { for (const item of managers) item.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}
const rejected = (code: string) => (error: unknown) => error instanceof ExecutionError && error.code === code;

test('offline local/VPS setup accepts empty cloud/repository fields; save/start never dispatch', async () => {
  const f = fixture();
  try {
    assert.equal(f.manager.setup().config.completed, false); assert.equal(f.fake.calls.length, 0);
    for (const mode of ['local', 'vps'] as const) {
      const setup = f.manager.updateSetup({ ...f.manager.setup().config, completed: true, mode });
      assert.equal(setup.ready, true); assert.equal((await f.manager.check()).check.status, 'unchecked');
    }
    f.manager.start(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.fake.calls.length, 0); assert.equal(f.reopen().setup().config.mode, 'vps');
    assert.equal(statSync(path.join(f.dir, 'execution.json')).mode & 0o777, 0o600);
    await assert.rejects(f.manager.submit(f.input()), rejected('cloud_not_ready'));
  } finally { f.close(); }
});

test('strict configuration rejects raw keys, hostile references and invalid real-money controls before network', () => {
  const f = fixture();
  try {
    for (const invalid of [
      { ...config(), apiKey: API_KEY }, { ...config(), anthropic: { ...config().anthropic, apiKey: API_KEY } },
      config({ repository: { owner: '../outside', name: 'repo', baseBranch: 'main' } }),
      config({ anthropic: { agentId: 'agent_fixture1/../../secrets', environmentId: ENV } }),
      config({ limits: { maxConcurrent: 0, perTaskBudgetCents: 1, dailyBudgetCents: 1 } }),
      config({ limits: { maxConcurrent: 1, perTaskBudgetCents: 1.5, dailyBudgetCents: 10 } }),
      config({ limits: { maxConcurrent: 1, perTaskBudgetCents: 100, dailyBudgetCents: 50 } }),
    ]) assert.throws(() => f.manager.updateSetup(invalid), rejected('invalid_input'));
    assert.equal(f.fake.calls.length, 0);
  } finally { f.close(); }
});

test('connection probe is GET-only at fixed official origins with beta headers and never claims write/paid success', async () => {
  const f = fixture();
  try {
    await f.ready(config({ anthropic: { agentId: AGENT, environmentId: ENV, vaultId: 'vlt_fixture1' } }));
    assert.ok(f.fake.calls.every(call => call.init.method === 'GET' && call.init.redirect === 'error'));
    assert.deepEqual(new Set(f.fake.calls.map(call => call.url.origin)), new Set(['https://api.anthropic.com', 'https://api.github.com']));
    const headers = f.fake.calls[0].init.headers as Record<string, string>;
    assert.equal(headers['anthropic-beta'], 'managed-agents-2026-04-01'); assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.match(f.manager.setup().check.message!, /No paid session/);
    const saved = readFileSync(path.join(f.dir, 'execution.json'), 'utf8');
    for (const secret of [API_KEY, GITHUB_TOKEN]) assert.equal(saved.includes(secret), false);
    f.setNow(Date.parse('2026-09-27T12:06:00Z'));
    assert.equal(f.manager.setup().ready, false); await assert.rejects(f.manager.submit(f.input()), rejected('cloud_not_ready'));
    assert.equal(f.fake.creates().length, 0);
  } finally { f.close(); }
});

test('probe rejects self-hosted/multiagent definitions, and storage callback errors are sanitized', async () => {
  const f = fixture();
  try {
    f.manager.updateSetup(config());
    f.fake.override = call => call.url.pathname.startsWith('/v1/environments/') ? json({ id: ENV, archived_at: null, config: { type: 'self_hosted' } }) : undefined;
    assert.equal((await f.manager.check()).check.status, 'blocked');
    f.fake.override = call => call.url.pathname.startsWith('/v1/agents/') ? json({ id: AGENT, type: 'agent', version: 3, archived_at: null, multiagent: { type: 'coordinator' }, tools: [{ type: 'agent_toolset_20260401' }] }) : undefined;
    assert.match((await f.manager.check()).check.message!, /single-agent/);
    const locked = fixture({ apiKey() { throw new Error(API_KEY); } });
    try { locked.manager.updateSetup(config()); assert.equal((await locked.manager.check()).check.message!.includes(API_KEY), false); assert.equal(locked.fake.calls.length, 0); } finally { locked.close(); }
  } finally { f.close(); }
});

test('confirmed submission durably reserves before paid POST, pins source/version, and deduplicates stable IDs', async () => {
  const f = fixture();
  try {
    await f.ready();
    const input = f.input(); let sawIntent = false;
    f.fake.override = call => {
      if (call.url.pathname === '/v1/sessions' && call.init.method === 'POST') {
        const saved = JSON.parse(readFileSync(path.join(f.dir, 'execution.json'), 'utf8'));
        assert.equal(saved.records[0].task.id, input.id); assert.equal(saved.records[0].task.status, 'dispatch_uncertain');
        assert.equal(saved.records[0].task.sessionId, undefined); sawIntent = true;
      }
    };
    const [one, duplicate] = await Promise.all([f.manager.submit(input), f.manager.submit(input)]);
    assert.equal(sawIntent, true); assert.equal(f.fake.creates().length, 1); assert.deepEqual(one, duplicate);
    const body = f.fake.creates()[0].body;
    assert.deepEqual(body.budget, { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } });
    assert.deepEqual(body.agent, { type: 'agent', id: AGENT, version: 3 });
    assert.deepEqual(body.resources[0].checkout, { type: 'commit', sha: SHA });
    assert.equal(body.resources[0].authorization_token, GITHUB_TOKEN);
    assert.equal(body.metadata.agent_empire_task_id, input.id); assert.equal(body.initial_events[0].type, 'user.message');
    assert.match(body.initial_events[0].content[0].text, /do not modify or merge/);
    assert.equal(one.outputs, 'unverified'); assert.equal(one.sourceCommit, SHA);
    assert.deepEqual(await f.reopen().submit(input), one); assert.equal(f.fake.creates().length, 1);
    assert.throws(() => f.manager.submit({ ...input, prompt: 'Another task' }), rejected('task_id_conflict'));
    assert.throws(() => f.manager.submit({ ...f.input(), confirmPaid: false }), rejected('paid_confirmation_required'));
    const saved = readFileSync(path.join(f.dir, 'execution.json'), 'utf8'); for (const key of [API_KEY, GITHUB_TOKEN]) assert.equal(saved.includes(key), false);
  } finally { f.close(); }
});

test('lost create responses stay dispatch-uncertain after restart and never auto retry or expose upstream secrets', async () => {
  const f = fixture();
  try {
    await f.ready();
    f.fake.override = call => call.init.method === 'POST' ? new Response(`upstream body: ${API_KEY} ${GITHUB_TOKEN}`, { status: 500 }) : undefined;
    const input = f.input(); const task = await f.manager.submit(input);
    assert.equal(task.status, 'dispatch_uncertain'); assert.equal(task.sessionId, undefined); assert.equal(task.message.includes(API_KEY), false);
    const restored = f.reopen(); restored.start(); await new Promise(resolve => setImmediate(resolve));
    await restored.submit(input); await restored.refresh(input.id);
    assert.equal(f.fake.creates().length, 1);
    await assert.rejects(restored.stopTask(input.id), rejected('dispatch_unresolved'));
    assert.throws(() => restored.updateSetup(config({ mode: 'local' })), rejected('active_cloud_tasks'));
  } finally { f.close(); }
});

test('simultaneous different IDs obey concurrency and idle/unknown sessions retain their slots', async () => {
  const f = fixture();
  try {
    await f.ready(); f.fake.status = 'idle';
    const results = await Promise.allSettled([f.manager.submit(f.input()), f.manager.submit(f.input())]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(f.fake.creates().length, 1);
    const task = f.manager.tasks()[0]; assert.equal(task.status, 'idle');
    await assert.rejects(f.manager.submit(f.input()), rejected('concurrency_limit'));
    f.fake.override = call => call.url.pathname.endsWith('/events') ? json({}, 503) : undefined;
    assert.equal((await f.manager.refresh(task.id)).status, 'unknown');
    await assert.rejects(f.manager.submit(f.input()), rejected('concurrency_limit'));
  } finally { f.close(); }
});

test('budget pauses, approvals and idle remain distinct; event pagination survives restart without raw model content', async () => {
  const f = fixture();
  try {
    await f.ready(); const task = await f.manager.submit(f.input()); f.fake.status = 'idle';
    for (const [reason, status] of [['requires_action', 'waiting_for_approval'], ['budget_reached', 'budget_paused'], ['end_turn', 'idle']]) {
      f.fake.stopReason = reason; assert.equal((await f.manager.refresh(task.id)).status, status);
    }
    f.fake.nextPage = 'page_fixture_next'; await f.manager.refresh(task.id);
    const restored = f.reopen(); f.fake.nextPage = null; f.fake.eventTime = '2026-09-27T12:01:00Z';
    await restored.refresh(task.id);
    const request = f.fake.calls.filter(call => call.url.pathname.endsWith('/events')).at(-1)!;
    assert.equal(request.url.searchParams.get('page'), 'page_fixture_next');
    assert.ok(request.url.searchParams.has('created_at[gte]'));
    assert.deepEqual(request.url.searchParams.getAll('types[]'), ['session.status_idle', 'session.status_running', 'session.usage']);
    assert.equal(restored.tasks()[0].eventCursor, 'sevt_fixture1'); assert.equal(restored.tasks()[0].outputs, 'unverified');
    const posts = f.fake.calls.filter(call => call.init.method === 'POST').length;
    restored.start(); await new Promise(resolve => setTimeout(resolve, 20)); restored.stop();
    assert.equal(f.fake.calls.filter(call => call.init.method === 'POST').length, posts);
  } finally { f.close(); }
});

test('stop interrupts then archives only confirmed idle; daily full reservations survive success and UTC carryover', async () => {
  const f = fixture();
  try {
    await f.ready(config({ limits: { maxConcurrent: 2, perTaskBudgetCents: 100, dailyBudgetCents: 100 } }));
    const task = await f.manager.submit(f.input());
    f.setNow(Date.parse('2026-09-28T12:00:00Z')); await f.manager.check();
    await assert.rejects(f.manager.submit(f.input()), rejected('daily_allowance'));
    f.setNow(Date.parse('2026-09-27T12:00:00Z'));
    const stopped = await f.manager.stopTask(task.id); assert.equal(stopped.status, 'cancelled');
    const mutations = f.fake.calls.filter(call => call.init.method === 'POST').map(call => call.url.pathname);
    assert.deepEqual(mutations, ['/v1/sessions', `/v1/sessions/${SESSION}/events`, `/v1/sessions/${SESSION}/archive`]);
    await assert.rejects(f.manager.submit(f.input()), rejected('daily_allowance'));
    assert.equal(stopped.outputs, 'unverified'); assert.equal(stopped.reservedCents, 100);
  } finally { f.close(); }
});

test('uncertain stop never releases the slot, archives a running session, or automatically repeats a mutation', async () => {
  const f = fixture();
  try {
    await f.ready(); const task = await f.manager.submit(f.input());
    f.fake.override = call => call.init.method === 'POST' && call.url.pathname.endsWith('/events') ? new Response('lost', { status: 503 }) : undefined;
    assert.equal((await f.manager.stopTask(task.id)).status, 'unknown');
    assert.equal(f.fake.calls.some(call => call.url.pathname.endsWith('/archive')), false);
    const mutations = f.fake.calls.filter(call => call.init.method === 'POST').length;
    await f.reopen().refresh(task.id);
    assert.equal(f.fake.calls.filter(call => call.init.method === 'POST').length, mutations);
    await assert.rejects(f.manager.submit(f.input()), rejected('concurrency_limit'));
  } finally { f.close(); }
});

test('failed intent persistence prevents paid dispatch and failed receipt persistence retains known session ID', async () => {
  const f = fixture();
  try {
    await f.ready(); const file = path.join(f.dir, 'execution.json'); renameSync(file, file + '.saved'); mkdirSync(file);
    await assert.rejects(f.manager.submit(f.input()), rejected('execution_storage_failed')); assert.equal(f.fake.creates().length, 0);
    assert.match(f.manager.setup().storageError!, /dispatch is blocked/);
  } finally { f.close(); }
  const g = fixture();
  try {
    await g.ready(); const file = path.join(g.dir, 'execution.json');
    g.fake.override = call => { if (call.url.pathname === '/v1/sessions' && call.init.method === 'POST') { renameSync(file, file + '.intent'); mkdirSync(file); } };
    await assert.rejects(g.manager.submit(g.input()), rejected('execution_storage_failed'));
    assert.equal(g.manager.tasks()[0].sessionId, SESSION); assert.equal(g.manager.tasks()[0].status, 'unknown');
    const intent = JSON.parse(readFileSync(file + '.intent', 'utf8')); assert.equal(intent.records[0].task.status, 'dispatch_uncertain'); assert.equal(intent.records[0].task.sessionId, undefined);
    assert.equal(g.fake.creates().length, 1);
  } finally { g.close(); }
});

test('shutdown during delayed refresh/create cannot overwrite a reopened ledger or dispatch new work', async () => {
  for (const operation of ['refresh', 'create', 'preflight'] as const) {
    const f = fixture();
    try {
      await f.ready(); const task = operation === 'refresh' ? await f.manager.submit(f.input()) : undefined;
      let resolve!: (response: Response) => void; let entered!: () => void;
      const waiting = new Promise<void>(done => { entered = done; });
      f.fake.override = call => {
        if ((operation === 'refresh' && call.url.pathname.endsWith('/events')) || (operation === 'create' && call.url.pathname === '/v1/sessions') || (operation === 'preflight' && call.url.host === 'api.github.com')) {
          entered(); return new Promise<Response>(done => { resolve = done; });
        }
      };
      const pending = operation === 'refresh' ? f.manager.refresh(task!.id) : f.manager.submit(f.input());
      const rejectedPending = assert.rejects(pending, rejected('execution_stopped'));
      await waiting; f.manager.stop(); const reopened = f.reopen();
      reopened.updateSetup({ ...reopened.setup().config, limits: { ...reopened.setup().config.limits, dailyBudgetCents: 400 } });
      const after = readFileSync(path.join(f.dir, 'execution.json'), 'utf8');
      resolve(operation === 'refresh' ? json({ data: [], next_page: null }) : operation === 'preflight' ? json({ full_name: 'fixture/repo' }) : json(f.fake.session()));
      // If preflight advances into a second read, let that complete too; no POST is permitted.
      f.fake.override = undefined;
      await rejectedPending;
      assert.equal(readFileSync(path.join(f.dir, 'execution.json'), 'utf8'), after);
      if (operation === 'preflight') assert.equal(f.fake.creates().length, 0);
    } finally { f.close(); }
  }
});

test('bounded transport rejects oversized bodies and timeouts without exposing keys or following redirects', async () => {
  for (const mode of ['oversize', 'timeout', 'throw'] as const) {
    const f = fixture({ requestTimeoutMs: 15 });
    try {
      f.manager.updateSetup(config());
      f.fake.override = () => mode === 'oversize' ? new Response('x'.repeat(2 * 1024 * 1024 + 1)) : mode === 'timeout' ? new Promise<Response>(() => {}) : Promise.reject(new Error(API_KEY + GITHUB_TOKEN));
      const checked = await f.manager.check(); assert.equal(checked.ready, false); assert.equal(checked.check.status, 'blocked');
      for (const secret of [API_KEY, GITHUB_TOKEN]) assert.equal(JSON.stringify(checked).includes(secret), false);
      assert.equal(f.fake.calls[0].init.redirect, 'error'); assert.equal(f.fake.creates().length, 0);
    } finally { f.close(); }
  }
});

test('corrupt ledger is preserved and rejected rather than forgetting task/budget history', async () => {
  const f = fixture();
  try {
    await f.ready(); await f.manager.submit(f.input());
    const file = path.join(f.dir, 'execution.json'); const saved = JSON.parse(readFileSync(file, 'utf8'));
    saved.records.push(saved.records[0]); writeFileSync(file, JSON.stringify(saved));
    const before = readFileSync(file, 'utf8'); assert.throws(() => f.reopen(), rejected('execution_storage_invalid'));
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { f.close(); }
});
