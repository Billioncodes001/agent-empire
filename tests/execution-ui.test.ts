import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError, MODE_COPY, PROVIDERS, canStop, clearPending, comparable, confirmationSnapshot, dollars, executionApi, loadPending, parseCents, pendingScope, persistPending,
  provenPreDispatch, setupView, shouldOffer, submissionOf, taskView, validateConfig, type Pending,
} from '../src/client/ui/execution';
import type { ExecutionConfig, ExecutionSetup, ExecutionTask, ExecutionTaskStatus } from '../src/shared/execution';

const config = (over: Partial<ExecutionConfig> = {}): ExecutionConfig => ({
  schemaVersion: 1, completed: true, mode: 'anthropic_cloud',
  repository: { owner: 'acme', name: 'app', baseBranch: 'main' },
  anthropic: { agentId: 'agent_abc12345', environmentId: 'env_abc12345' },
  githubAuth: 'host_token',
  limits: { maxConcurrent: 2, perTaskBudgetCents: 500, dailyBudgetCents: 2000 },
  ...over,
});
const setup = (over: Partial<ExecutionSetup> = {}): ExecutionSetup => ({
  config: config(), configRevision: 3, credentials: { anthropic: true, github: true }, check: { status: 'ready', checkedAt: 1 }, ready: true, notices: [], ...over,
});
const task = (status: ExecutionTaskStatus, over: Partial<ExecutionTask> = {}): ExecutionTask => ({
  id: 't1', provider: 'anthropic', mode: 'anthropic_cloud', status, prompt: 'Fix it', createdAt: 1, updatedAt: 2,
  repository: config().repository, sourceCommit: 'abc', branch: 'agent/t1', reservedCents: 500, budgetDay: '2026-09-27', message: '', outputs: 'unverified', ...over,
});

test('task states are honest: only running is active and idle/completed never read as verified success', () => {
  const all: ExecutionTaskStatus[] = ['dispatch_uncertain', 'running', 'waiting_for_approval', 'budget_paused', 'idle', 'unknown', 'completed', 'failed', 'cancelled'];
  for (const s of all) {
    const v = taskView(task(s));
    assert.equal(v.tone === 'active', s === 'running', s);
    assert.doesNotMatch(v.label, /success|verified|complete|done/i, s);
  }
  assert.match(taskView(task('idle')).detail, /not verified success/);
  assert.match(taskView(task('completed', { message: 'Session ended.' })).detail, /Outputs unverified/);
  assert.equal(taskView(task('dispatch_uncertain')).tone, 'attention');
  assert.equal(canStop(task('running', { sessionId: 's1' })), true);
  assert.equal(canStop(task('dispatch_uncertain', { sessionId: 's1' })), true);
  assert.equal(canStop(task('unknown')), false, 'no session, nothing to stop');
  for (const s of ['completed', 'failed', 'cancelled'] as const) assert.equal(canStop(task(s, { sessionId: 's1' })), false);
});

test('dollar amounts round-trip through whole cents', () => {
  assert.equal(parseCents('5'), 500);
  assert.equal(parseCents('$12.34'), 1234);
  assert.equal(parseCents(' 0.5 '), 50);
  for (const bad of ['', '-1', '1.234', 'abc', '1e3']) assert.equal(parseCents(bad), null, bad);
  assert.equal(dollars(1234), '$12.34');
});

test('local and VPS modes allow blank cloud references; cloud mode requires them', () => {
  const blank = { repository: { owner: '', name: '', baseBranch: '' }, anthropic: { agentId: '', environmentId: '' } };
  assert.deepEqual(validateConfig(config({ mode: 'local', ...blank })), []);
  assert.deepEqual(validateConfig(config({ mode: 'vps', ...blank })), []);
  assert.equal(validateConfig(config({ ...blank })).length, 5);
  assert.deepEqual(validateConfig(config()), []);
  assert.ok(validateConfig(config({ limits: { maxConcurrent: 1, perTaskBudgetCents: 3000, dailyBudgetCents: 2000 } })).some((e) => /at least the per-task/.test(e)));
  assert.ok(validateConfig(config({ limits: { maxConcurrent: 0, perTaskBudgetCents: NaN, dailyBudgetCents: 100 } })).length >= 2);
  const limits = (maxConcurrent: number, perTaskBudgetCents: number, dailyBudgetCents: number) => validateConfig(config({ mode: 'local', limits: { maxConcurrent, perTaskBudgetCents, dailyBudgetCents } }));
  assert.deepEqual(limits(10, 100_000, 10_000_000), []);
  assert.equal(limits(11, 100, 100).length, 1);
  assert.equal(limits(1, 100_001, 200_000).length, 1);
  assert.equal(limits(1, 100, 10_000_001).length, 1);
  for (const [key, bad] of [['agentId', 'agent_short'], ['agentId', 'env_abc12345'], ['environmentId', 'env_ab-12345'], ['vaultId', 'vault_abc12345']] as const)
    assert.equal(validateConfig(config({ anthropic: { ...config().anthropic, [key]: bad } })).length, 1, `${key}=${bad}`);
  assert.deepEqual(validateConfig(config({ anthropic: { ...config().anthropic, vaultId: 'vlt_abc12345' } })), []);
});

test('setup summary never claims readiness without a passed read-only check', () => {
  assert.equal(setupView(setup({ config: config({ completed: false }) })).label, 'Not set up');
  assert.match(setupView(setup({ check: { status: 'unchecked' }, ready: false })).label, /not checked/);
  assert.match(setupView(setup({ ready: false })).label, /check expired/);
  assert.equal(setupView(setup({ check: { status: 'blocked', message: 'No agent' }, ready: false })).detail, 'No agent');
  assert.match(setupView(setup()).detail, /explicit paid confirmation/);
  assert.equal(setupView(setup({ storageError: 'disk' })).tone, 'attention');
  assert.equal(setupView(setup({ config: config({ mode: 'vps' }) })).label, MODE_COPY.vps.title);
  assert.match(MODE_COPY.vps.detail, /does not provision/);
  assert.match(MODE_COPY.anthropic_cloud.detail, /queue .* is held/);
  assert.match(MODE_COPY.local.detail, /starts nothing/);
  assert.match(MODE_COPY.local.detail, /quitting the packaged desktop app stops/);
  assert.deepEqual(PROVIDERS.filter((p) => p.available).map((p) => p.id), ['anthropic']);
});

test('the first-use offer appears only before any execution choice is saved', () => {
  assert.equal(shouldOffer(setup({ config: config({ completed: false }) }), false), true);
  assert.equal(shouldOffer(setup({ config: config({ completed: false }) }), true), false);
  assert.equal(shouldOffer(setup(), false), false);
  assert.equal(shouldOffer(null, false), false);
  assert.equal(comparable(config()), comparable(config({ completed: false, anthropic: { agentId: 'agent_abc12345', environmentId: 'env_abc12345', vaultId: '' } })));
  assert.notEqual(comparable(config()), comparable(config({ mode: 'local' })));
});

const memory = () => {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

test('pending submissions are scoped to the host and repository/agent identity', () => {
  assert.equal(pendingScope(undefined, config()), null, 'no stable host identity means no paid submission');
  const a = pendingScope('host-a', config())!;
  assert.equal(a, pendingScope('host-a', config({ repository: { owner: 'ACME', name: 'App', baseBranch: 'main' } })));
  assert.equal(a, pendingScope('host-a', config({ limits: { maxConcurrent: 5, perTaskBudgetCents: 100, dailyBudgetCents: 100 } })), 'limits are not identity');
  for (const other of [
    pendingScope('host-b', config()),
    pendingScope('host-a', config({ repository: { owner: 'acme', name: 'other', baseBranch: 'main' } })),
    pendingScope('host-a', config({ repository: { owner: 'acme', name: 'app', baseBranch: 'dev' } })),
    pendingScope('host-a', config({ anthropic: { agentId: 'agent_zzz12345', environmentId: 'env_abc12345' } })),
  ])
    assert.notEqual(other, a);
  const store = memory();
  const p: Pending = { scope: a, id: 'id-1', prompt: 'Do X', configRevision: 3 };
  assert.equal(persistPending(p, store), true);
  assert.deepEqual(loadPending(a, store), p);
  assert.equal(loadPending(pendingScope('host-b', config())!, store), null, 'another host on the same origin never sees it');
  store.data.set([...store.data.keys()][0], JSON.stringify({ ...p, scope: 'forged' }));
  assert.equal(loadPending(a, store), null, 'a record whose own scope disagrees is ignored');
  persistPending(p, store);
  clearPending(a, store);
  assert.equal(loadPending(a, store), null);
});

test('a submission is not sent unless its record is durably saved first', () => {
  const p: Pending = { scope: 's', id: 'id-1', prompt: 'p', configRevision: 1 };
  assert.equal(persistPending(p, { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } }), false);
  assert.equal(persistPending(p, { getItem: () => null, setItem: () => {} }), false, 'a write that does not read back fails closed');
  assert.equal(persistPending(p, memory()), true);
});

test('retries resend the stored request exactly and never adopt a newer prompt or revision', () => {
  const p: Pending = { scope: 's', id: 'id-1', prompt: 'Do X', configRevision: 3 };
  assert.deepEqual(submissionOf(p), { id: 'id-1', prompt: 'Do X', configRevision: 3, confirmPaid: true });
  const s = setup();
  const snap = confirmationSnapshot(s, 'Do X', 'scope-1');
  s.configRevision = 9;
  s.config.repository.name = 'changed';
  s.config.limits.perTaskBudgetCents = 1;
  assert.equal(snap.configRevision, 3);
  assert.equal(snap.config.repository.name, 'app');
  assert.equal(snap.config.limits.perTaskBudgetCents, 500);
  assert.ok(Object.isFrozen(snap));
});

test('only proven pre-dispatch rejections release a submission ID', () => {
  for (const code of ['invalid_input', 'paid_confirmation_required', 'setup_changed', 'cloud_not_ready', 'concurrency_limit', 'daily_allowance', 'credentials_missing'])
    assert.equal(provenPreDispatch(new ApiError('x', code === 'invalid_input' || code === 'paid_confirmation_required' ? 400 : 409, code)), true, code);
  for (const err of [
    new ApiError('conflict', 409, 'task_id_conflict'),
    new ApiError('busy', 409, 'task_busy'),
    new ApiError('no code', 409),
    new ApiError('gateway', 502, 'provider_unavailable'),
    new ApiError('storage', 503, 'execution_storage_failed'),
    new ApiError('network', 0),
    new ApiError('login', 401),
    new Error('other'),
  ])
    assert.equal(provenPreDispatch(err), false, err.message);
});

test('saving and checking only touch setup endpoints; submission carries explicit paid confirmation', async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(url.includes('/tasks') ? task('running') : setup()), { status: 200 });
  }) as typeof fetch;
  try {
    await executionApi.save(config());
    await executionApi.check();
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['PUT /api/execution/setup', 'POST /api/execution/check']);
    assert.deepEqual(calls[0].body, config());
    assert.equal(calls[1].body, undefined);
    await executionApi.submit({ id: 'u1', prompt: 'p', configRevision: 3, confirmPaid: true });
    await executionApi.refresh('a/b');
    await executionApi.stop('t1');
    assert.deepEqual(calls.slice(2).map((c) => `${c.method} ${c.url}`), ['POST /api/execution/tasks', 'POST /api/execution/tasks/a%2Fb/refresh', 'POST /api/execution/tasks/t1/stop']);
    assert.deepEqual(calls[2].body, { id: 'u1', prompt: 'p', configRevision: 3, confirmPaid: true });
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Budget exhausted', code: 'budget' }), { status: 409 })) as typeof fetch;
    await assert.rejects(executionApi.submit({ id: 'u2', prompt: 'p', configRevision: 3, confirmPaid: true }), (e: ApiError) => e.code === 'budget' && e.status === 409);
    globalThis.fetch = (async () => { throw new TypeError('network'); }) as typeof fetch;
    await assert.rejects(executionApi.submit({ id: 'u2', prompt: 'p', configRevision: 3, confirmPaid: true }), (e: ApiError) => e.status === 0 && !provenPreDispatch(e));
  } finally {
    globalThis.fetch = original;
  }
});
