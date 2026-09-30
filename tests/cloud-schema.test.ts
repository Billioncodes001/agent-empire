import test from 'node:test';
import assert from 'node:assert/strict';
import { initialCloudState, parseStateFiles, SchemaError, serializeState, STATE_FILES, validateLimits } from '../src/cloud/schema';
import { IntentError, parseIntent, intentPath } from '../src/cloud/intents';
import { initialEmpire } from '../src/shared/empire';
import { EXECUTION, T0, uuid } from './cloud-fixtures';

const files = () => serializeState(initialCloudState(T0, { execution: EXECUTION }));
const edit = (path: string, change: (value: any) => void) => { const f = files(); const v = JSON.parse(f[path]); change(v); f[path] = JSON.stringify(v); return f; };

test('cloud schema: initial state round-trips through versioned JSON files byte-for-byte', () => {
  const serialized = files();
  assert.deepEqual(Object.keys(serialized).sort(), Object.values(STATE_FILES).sort());
  const { state, migrated } = parseStateFiles(serialized, T0);
  assert.deepEqual(migrated, []);
  assert.equal(state.meta.schemaVersion, 1);
  assert.equal(state.meta.lifecycle.status, 'running');
  assert.deepEqual(state.meta.execution, EXECUTION);
  assert.deepEqual(serializeState(state), serialized);
  assert.ok(!JSON.stringify(serialized).match(/api[_-]?key|token|secret/i), 'state files carry references only');
});

test('cloud schema: invalid or newer snapshots are refused rather than repaired', () => {
  assert.throws(() => parseStateFiles({ ...files(), [STATE_FILES.jobs]: undefined as any }, T0), /not initialized/);
  assert.throws(() => parseStateFiles(edit(STATE_FILES.meta, m => { m.schemaVersion = 2; }), T0), /newer coordinator/);
  assert.throws(() => parseStateFiles(edit(STATE_FILES.meta, m => { m.limits.maxConcurrent = 11; }), T0), SchemaError);
  assert.throws(() => parseStateFiles(edit(STATE_FILES.meta, m => { m.execution.anthropic.apiKey = 'sk-secret'; }), T0), SchemaError);
  assert.throws(() => parseStateFiles(edit(STATE_FILES.journal, j => { j.seq = 3; j.entries = [{ seq: 1, at: T0, runId: 'r', kind: 'job', message: 'x' }]; }), T0), /sequence gap/);
  assert.throws(() => parseStateFiles(edit(STATE_FILES.jobs, j => {
    j.jobs.push({ id: uuid(1), title: 't', promptPreview: 'p', promptHash: '0'.repeat(16), intentId: uuid(2), createdAt: T0, updatedAt: T0, configRevision: 0, authorizedCents: 100, status: 'running', message: '', provider: 'anthropic', repository: EXECUTION.repository, branch: `agent-empire/task-${uuid(1)}`, outputs: 'unverified' });
  }), T0), /without a budget reservation/);
  assert.throws(() => parseStateFiles(edit(STATE_FILES.empire, e => { e.funds = -1; }), T0), SchemaError);
  assert.throws(() => parseStateFiles({ ...files(), [STATE_FILES.ledger]: '{not json' }, T0), /invalid JSON/);
});

test('cloud schema: a version-1 city save migrates to version 2 like the host save', () => {
  const v1 = { ...initialEmpire(T0), version: 1, funds: 4321 } as any;
  delete v1.office; delete v1.setup; delete v1.economy;
  v1.sectors = v1.sectors.filter((s: any) => !['recreation', 'studio'].includes(s.id));
  const { state, migrated } = parseStateFiles({ ...files(), [STATE_FILES.empire]: JSON.stringify(v1) }, T0);
  assert.deepEqual(migrated, ['empire version 1→2']);
  assert.equal(state.empire.version, 2);
  assert.equal(state.empire.funds, 4321);
  assert.deepEqual(state.empire.office, { floors: 1, workstations: 16 });
  assert.ok(state.empire.sectors.some(s => s.id === 'studio'));
  assert.equal(state.empire.setup.completed, false);
});

test('cloud schema: limits reuse the host ranges', () => {
  assert.deepEqual(validateLimits({ maxConcurrent: 3, perTaskBudgetCents: 200, dailyBudgetCents: 1000 }), { maxConcurrent: 3, perTaskBudgetCents: 200, dailyBudgetCents: 1000 });
  assert.throws(() => validateLimits({ maxConcurrent: 0, perTaskBudgetCents: 200, dailyBudgetCents: 1000 }));
  assert.throws(() => validateLimits({ maxConcurrent: 1, perTaskBudgetCents: 200, dailyBudgetCents: 100 }));
});

test('cloud intents: validation reuses host submission rules and rejects with a reason', () => {
  const id = uuid(900);
  const body = (value: object) => JSON.stringify({ schemaVersion: 1, id, createdAt: T0, ...value });
  const job = { id: uuid(1), title: 'Fix it', prompt: '  Fix the bug  ', configRevision: 0, confirmPaid: true };
  const parsed = parseIntent(intentPath(id), body({ kind: 'new_job', job }));
  assert.equal(parsed.kind, 'new_job');
  assert.equal(parsed.kind === 'new_job' && parsed.job.prompt, 'Fix the bug');
  const reason = (path: string, text: string) => { try { parseIntent(path, text); return 'accepted'; } catch (error) { assert.ok(error instanceof IntentError); return error.code; } };
  assert.equal(reason(intentPath(id), body({ kind: 'new_job', job: { ...job, confirmPaid: false } })), 'paid_confirmation_required');
  assert.equal(reason(intentPath(uuid(901)), body({ kind: 'shutdown' })), 'invalid_intent'); // id/file mismatch
  assert.equal(reason('intents/../state/meta.json', body({ kind: 'shutdown' })), 'invalid_intent');
  assert.equal(reason(intentPath(id), body({ kind: 'launch_missiles' })), 'invalid_intent');
  assert.equal(reason(intentPath(id), body({ kind: 'shutdown', extra: 1 })), 'invalid_intent');
  assert.equal(reason(intentPath(id), '{'), 'invalid_intent');
  assert.equal(reason(intentPath(id), body({ kind: 'limits', configRevision: 0, limits: { maxConcurrent: 50, perTaskBudgetCents: 1, dailyBudgetCents: 1 } })), 'invalid_intent');
  assert.equal(reason(intentPath(id), body({ kind: 'configure', configRevision: 0, execution: { ...EXECUTION, apiKey: 'sk-x' } })), 'invalid_intent');
  assert.equal(reason(intentPath(id), body({ kind: 'empire_action', action: { kind: 'retry-manager', site: 'cafe' } })), 'invalid_intent');
  assert.equal(reason(intentPath(id), body({ kind: 'resolve_uncertain', jobId: uuid(1), resolution: 'attach_session', sessionId: 'nope' })), 'invalid_intent');
  assert.equal(reason(intentPath(id), body({ kind: 'review', jobId: uuid(1), decision: 'accept' })), 'accepted');
});
