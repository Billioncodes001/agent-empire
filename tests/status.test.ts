import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chiefView, evidence, managerTyping, managerView, monitorView, typingPose, workforceView, STALE_MS } from '../src/client/ui/status';
import { newSector, type SupervisionState, type SectorState } from '../src/shared/empire';
import type { QueueTask, WorkerInfo } from '../src/shared/protocol';

const supervision = (phase: SupervisionState['chief']['phase'], extra: Partial<SupervisionState['chief']> = {}): SupervisionState => ({
  schemaVersion: 1,
  serverRunId: 'run-1',
  observedAt: 1,
  delegationRequested: true,
  monitor: { mode: 'rule_based', lastCheckAt: 1 },
  chief: { phase, ...extra },
  workforce: { active: 1, attention: 2, queued: 3 },
});
const fresh = evidence(supervision('idle'), true, 1000, 2000);
const LIVE = /working|active|on duty|in progress|starting/i;

test('evidence is unknown when disconnected, missing or stale', () => {
  assert.equal(fresh.fresh, true);
  assert.equal(evidence(supervision('working'), false, 1000, 2000).reason, 'disconnected');
  assert.equal(evidence(undefined, true, 1000, 2000).reason, 'missing');
  assert.equal(evidence(supervision('working'), true, 0, 2000).reason, 'missing');
  assert.equal(evidence(supervision('working'), true, 1000, 1000 + STALE_MS + 1).reason, 'stale');
  assert.equal(evidence(supervision('working'), true, 1000, 1000 + STALE_MS).fresh, true);
});

test('stale or disconnected evidence never shows a live chief', () => {
  for (const ev of [
    evidence(supervision('working'), false, 1000, 2000),
    evidence(supervision('working'), true, 1000, 1000 + STALE_MS * 2),
    evidence(undefined, true, 1000, 2000),
  ]) {
    const v = chiefView(supervision('working'), ev);
    assert.equal(v.tone, 'unknown');
    assert.doesNotMatch(v.label, LIVE);
    assert.equal(workforceView(supervision('working'), ev), null);
    assert.equal(monitorView(supervision('working'), ev).tone, 'unknown');
  }
});

test('only starting and working phases use active wording', () => {
  const phases: SupervisionState['chief']['phase'][] = ['unassigned', 'pending', 'queued', 'starting', 'idle', 'working', 'needs_input', 'turn_ended', 'interrupted', 'failed', 'unknown'];
  for (const phase of phases) {
    const v = chiefView(supervision(phase), fresh);
    const live = phase === 'starting' || phase === 'working';
    assert.equal(v.tone === 'active', live, phase);
    if (!live) assert.doesNotMatch(v.label, LIVE, phase);
  }
  assert.equal(chiefView(supervision('needs_input'), fresh).tone, 'attention');
  assert.equal(chiefView(supervision('interrupted'), fresh).tone, 'attention');
  assert.doesNotMatch(chiefView(supervision('turn_ended'), fresh).detail, /verified brief|complete/i);
  assert.equal(chiefView(supervision('failed', { reason: 'Agent exited 1' }), fresh).detail, 'Agent exited 1');
});

test('monitoring is labelled rule-based and workforce comes from the projection', () => {
  assert.equal(monitorView(supervision('idle'), fresh).label, 'Rule-based monitoring');
  assert.deepEqual(workforceView(supervision('idle'), fresh), { active: 1, attention: 2, queued: 3 });
});

const worker = (over: Partial<WorkerInfo>): WorkerInfo => ({
  id: 'w1', kind: 'agent', deskId: 'd1', name: 'Ada', color: '#fff', status: 'working', acked: false,
  createdBy: 'x', createdAt: 0, cols: 80, rows: 24, viewers: [], ...over,
});
const managed = (status: NonNullable<SectorState['manager']>['status'], error?: string): SectorState => ({
  ...newSector('hospital'),
  built: true,
  manager: { id: 'manager-hospital', name: 'Maya', status, attempt: 1, jobKey: 'job-1', taskId: 't1', workerId: 'w1', error },
});
const task = (over: Partial<QueueTask> = {}): QueueTask => ({
  id: 't1', jobKey: 'job-1', title: '', prompt: '', addedBy: '', addedAt: 0, status: 'running', workerId: 'w1', ...over,
});

test('sector managers need a running linked agent before they look active', () => {
  const tasks = [task()];
  const running = new Map([['w1', worker({ processState: 'running' })]]);
  assert.equal(managerView(managed('working'), tasks, running, fresh).tone, 'active');
  for (const w of [worker({}), worker({ processState: 'unknown' }), worker({ processState: 'stopped' }), worker({ kind: 'shell', processState: 'running' })])
    assert.equal(managerView(managed('working'), tasks, new Map([['w1', w]]), fresh).tone, 'unknown');
  assert.equal(managerView(managed('working'), tasks, new Map(), fresh).tone, 'unknown');
  assert.equal(managerView(managed('needs_input'), tasks, running, fresh).tone, 'attention');
  assert.doesNotMatch(managerView(managed('ready'), tasks, running, fresh).label, LIVE);
  assert.equal(managerView(managed('offline', 'gone'), tasks, running, fresh).detail, 'gone');
  assert.equal(managerView(managed('pending', 'queue full'), tasks, running, fresh).tone, 'attention');
  assert.equal(managerView(managed('working'), tasks, running, evidence(undefined, false, 0, 0)).tone, 'unknown');
  assert.equal(managerView(managed('working'), [], running, fresh).tone, 'unknown');
  assert.equal(managerView(managed('working'), [task({ status: 'queued' })], running, fresh).tone, 'unknown');
});

test('conflicting manager, task and worker links stay unknown and never type', () => {
  const running = new Map([
    ['w1', worker({ processState: 'running' })],
    ['w2', worker({ id: 'w2', processState: 'running' })],
  ]);
  for (const tasks of [[task({ id: 'other' })], [task({ workerId: 'w2' })]]) {
    const v = managerView(managed('working'), tasks, running, fresh);
    assert.equal(v.tone, 'unknown');
    assert.match(v.detail, /disagree/);
    assert.equal(managerTyping(managed('working'), tasks, running, fresh), false);
    assert.equal(managerView(managed('ready'), tasks, running, fresh).tone, 'unknown');
  }
  assert.equal(managerTyping(managed('working'), [task()], running, fresh), true);
  assert.equal(managerTyping(managed('needs_input'), [task()], running, fresh), false);
  assert.equal(managerTyping(managed('ready'), [task({ status: 'done' })], running, fresh), false);
});

test('a restored interruption outranks the legacy manager flag', () => {
  const tasks = [task({ interruption: { reason: 'server_restart', at: 1 } })];
  assert.equal(managerView(managed('working'), tasks, new Map([['w1', worker({ processState: 'running' })]]), fresh).label, 'Interrupted');
});

test('only fresh running agent turns use the typing pose', () => {
  assert.equal(typingPose(worker({ processState: 'running' }), true), true);
  assert.equal(typingPose(worker({ processState: 'running' }), false), false);
  for (const status of ['idle', 'done', 'needs_input', 'offline', 'exited', 'starting'] as const)
    assert.equal(typingPose(worker({ status, processState: 'running' }), true), false, status);
  assert.equal(typingPose(worker({}), true), false);
  assert.equal(typingPose(undefined, true), false);
});
