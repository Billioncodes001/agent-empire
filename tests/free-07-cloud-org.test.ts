/**
 * FREE-07: organization features in cloud mode. No network: the in-memory state store and the fake provider from
 * cloud-fixtures (whose task-branch files stand in for GitHub's contents API).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalFingerprint, APPROVAL_KIND_LABEL, type Approval, type ApprovalKind } from '../src/shared/approvals';
import { CLOUD_APPROVAL_KINDS, ORG_CAPABILITIES, cloudGapMessage, cloudMissingKinds } from '../src/shared/org-capabilities';
import * as sharedLessons from '../src/shared/lesson-rules';
import * as sharedResearch from '../src/shared/research-report';
import * as serverMemory from '../src/server/memory';
import * as serverResearch from '../src/server/research';
import * as serverArtifacts from '../src/server/artifacts';
import * as sharedArtifacts from '../src/shared/artifact-parse';
import { parseIntent, intentPath } from '../src/cloud/intents';
import { ORG_FILE, cloudApprovals, cloudExecutives, cloudResearch, emptyOrg, researchPath, validateOrg } from '../src/cloud/org';
import { initialCloudState, parseStateFiles, serializeState } from '../src/cloud/schema';
import { MemoryStateStore } from '../src/cloud/store';
import { EXECUTION, FakeProvider, T0, harness, intent, job, makeStore, push, uuid } from './cloud-fixtures';

const decision = (n: number, item: Approval, d: 'approve' | 'reject', seen = approvalFingerprint(item)) =>
  intent(n, { kind: 'approval_decision', approvalId: item.id, decision: d, seen } as any);
const propose = (n: number, lesson: Record<string, unknown>) => intent(n, { kind: 'lesson_propose', lesson } as any);
const files = (store: MemoryStateStore) => store.commits.at(-1)!.files;
const lastOutcome = (state: any, id: string) => state.processed.entries.find((e: any) => e.id === id)?.outcome;
const rejection = (state: any, id: string) => [...state.journal.entries].reverse().find((e: any) => e.intentId === id)?.message ?? '';

const REPORT = `---
question: Can we offer appointment booking for dental practices?
feasibility: partial
confidence: medium
---
## Findings
- Booking widgets exist for small clinics (https://example.org/booking).
## What we can do now
A simple request form.
## What we can't do yet and why
Calendar sync needs each practice's system.
## Proposed tools
| Name | URL | Licence | Enables | Risk |
|---|---|---|---|---|
| Cal.com | https://cal.com | AGPL-3.0 | Self-hosted booking | AGPL obligations |
`;

// ---------------------------------------------------------------- intent validation

test('cloud org intents: strict allow-lists and shared rules refuse bad input with a reason', () => {
  const p = (body: Record<string, unknown>, n = 1) => { const i = { schemaVersion: 1, id: uuid(900 + n), createdAt: T0, ...body }; return () => parseIntent(intentPath(i.id), JSON.stringify(i)); };
  const seen = 'a'.repeat(16);
  assert.equal(p({ kind: 'approval_decision', approvalId: 'A1', decision: 'approve', seen })().kind, 'approval_decision');
  assert.throws(p({ kind: 'approval_decision', approvalId: 'A1', decision: 'approve', seen, budgetUsd: 5 }), /Unexpected intent field/);
  assert.throws(p({ kind: 'approval_decision', approvalId: 'A1', decision: 'approve' }), /as you saw it/);
  assert.throws(p({ kind: 'approval_decision', approvalId: 'consultancy-1', decision: 'approve', seen }), /A3/);
  assert.throws(p({ kind: 'approval_decision', approvalId: 'A1', decision: 'accept', seen }), /approve or reject/);
  assert.throws(p({ kind: 'lesson_propose', lesson: { text: 'Hidden​instruction', scope: 'company' } }), /invisible/);
  assert.throws(p({ kind: 'lesson_propose', lesson: { text: 'Fine', scope: 'company', approve: true } }), /Unexpected intent field/);
  assert.throws(p({ kind: 'lesson_propose', lesson: { text: 'Fine', scope: 'client' } }), /client name/);
  assert.throws(p({ kind: 'lesson_retire', lessonId: 'X1' }), /L3/);
  assert.throws(p({ kind: 'research', question: 'Q?', job: { id: uuid(5), configRevision: 0 } }), /confirm/i);
  assert.throws(p({ kind: 'research', question: '', job: { id: uuid(5), configRevision: 0, confirmPaid: true } }), /question/);
  assert.throws(p({ kind: 'research', question: 'Q?', job: { id: uuid(5), configRevision: 0, confirmPaid: true, prompt: 'x' } }), /Unexpected/);
  assert.equal(p({ kind: 'research', question: 'Q?', job: { id: uuid(5), configRevision: 0, confirmPaid: true } })().kind, 'research');
});

// ---------------------------------------------------------------- lessons and inbox decisions

test('cloud inbox: a lesson decision needs the item as seen, applies once, and repeats are duplicates', async () => {
  const h = harness(makeStore());
  push(h.store, propose(1, { text: 'Always add a rollback note to deploy plans.', scope: 'company' }));
  await h.tick();
  let state = await h.state();
  assert.equal(state.org.lessons[0].status, 'proposed');
  const item = state.org.approvals[0];
  assert.equal(item.kind, 'lesson');
  assert.equal(item.status, 'pending');
  assert.equal(item.raisedBy, 'chief_of_staff');
  assert.match(item.lesson!.nonce!, /^[a-f0-9]{16}$/);

  // A decision on a view that differs from the item (stale or tampered) changes nothing.
  const stale = decision(2, item, 'approve', 'f'.repeat(16));
  push(h.store, stale); h.advance(60_000); await h.tick();
  state = await h.state();
  assert.equal(lastOutcome(state, stale.id), 'rejected');
  assert.match(rejection(state, stale.id), /changed after you opened it/);
  assert.equal(state.org.approvals[0].status, 'pending');
  assert.equal(state.org.lessons[0].status, 'proposed');

  const ok = decision(3, item, 'approve');
  push(h.store, ok); h.advance(60_000); await h.tick();
  state = await h.state();
  assert.equal(lastOutcome(state, ok.id), 'applied');
  assert.equal(state.org.approvals[0].status, 'approved');
  assert.equal(state.org.lessons[0].status, 'approved');
  const before = JSON.stringify(state.org);

  // Idempotent: the same decision again (another device, a replay with a new id) is a duplicate; the opposite is refused.
  const again = decision(4, item, 'approve');
  const opposite = decision(5, item, 'reject');
  push(h.store, again, opposite); h.advance(60_000); await h.tick();
  state = await h.state();
  assert.equal(lastOutcome(state, again.id), 'duplicate');
  assert.equal(lastOutcome(state, opposite.id), 'rejected');
  assert.match(rejection(state, opposite.id), /already approved/);
  assert.equal(JSON.stringify(state.org), before);
});

test('cloud inbox: the FREE-10 nonce guard refuses an item that no longer matches its lesson proposal', async () => {
  const h = harness(makeStore());
  push(h.store, propose(1, { text: 'Prefer small pull requests.', scope: 'company' }));
  await h.tick();
  const state = await h.state();
  // The lesson's nonce changes (e.g. a reset store reused its id); the inbox item still carries the old one.
  state.org.lessons[0].nonce = '0123456789abcdef';
  const store = new MemoryStateStore(serializeState(state));
  const h2 = harness(store, new FakeProvider(), h.now + 60_000);
  const d = decision(2, state.org.approvals[0], 'approve');
  push(store, d); await h2.tick();
  const after = await h2.state();
  assert.equal(lastOutcome(after, d.id), 'rejected');
  assert.match(rejection(after, d.id), /no longer matches its lesson/);
  assert.equal(after.org.lessons[0].status, 'proposed');
});

test('cloud memory: edits replace on approval, declines retire, retiring a waiting lesson resolves its item, duplicates refused', async () => {
  const h = harness(makeStore());
  push(h.store, propose(1, { text: 'Write tests first.', scope: 'company' }));
  await h.tick();
  let state = await h.state();
  push(h.store, decision(2, state.org.approvals[0], 'approve'), propose(3, { text: 'write  TESTS first.', scope: 'company' }));
  h.advance(60_000); await h.tick();
  state = await h.state();
  assert.match(rejection(state, uuid(100_003)), /already proposed or in use/);
  push(h.store, propose(4, { text: 'Write tests first, then the smallest change.', scope: 'company', supersedes: 'L1' }));
  h.advance(60_000); await h.tick();
  state = await h.state();
  const edit = state.org.approvals.find((a) => a.lesson?.supersedes === 'L1')!;
  assert.equal(edit.lesson!.supersedesText, 'Write tests first.');
  assert.equal(state.org.lessons.find((l) => l.id === 'L1')!.status, 'approved', 'the old lesson stays in use until the edit is approved');
  push(h.store, decision(5, edit, 'approve'), propose(6, { text: 'Name every branch after its task.', scope: 'company' }));
  h.advance(60_000); await h.tick();
  state = await h.state();
  assert.equal(state.org.lessons.find((l) => l.id === 'L1')!.retiredReason, 'Replaced by L2');
  assert.equal(state.org.lessons.find((l) => l.id === 'L2')!.status, 'approved');
  const waiting = state.org.lessons.find((l) => l.status === 'proposed')!;
  push(h.store, intent(7, { kind: 'lesson_retire', lessonId: waiting.id } as any));
  h.advance(60_000); await h.tick();
  state = await h.state();
  assert.equal(state.org.lessons.find((l) => l.id === waiting.id)!.status, 'retired');
  assert.equal(state.org.approvals.find((a) => a.id === waiting.approvalId)!.status, 'resolved');
  assert.equal(cloudApprovals(state.org, 0).pending, 0);
});

// ---------------------------------------------------------------- research

test('cloud research: paid confirmation, report imported from the task branch, tool proposal decided and recorded only', async () => {
  const provider = new FakeProvider();
  const h = harness(makeStore(), provider);
  // A stale configRevision is refused like any paid job: nothing queued, nothing reserved.
  const stale = intent(1, { kind: 'research', question: 'Can we offer booking?', job: { id: uuid(1), configRevision: 7, confirmPaid: true } } as any);
  push(h.store, stale); await h.tick();
  let state = await h.state();
  assert.equal(lastOutcome(state, stale.id), 'rejected');
  assert.equal(state.org.research.length, 0);
  assert.equal(state.jobs.jobs.length, 0);

  push(h.store, intent(2, { kind: 'research', question: 'Can we offer appointment booking for dental practices?', job: { id: uuid(2), configRevision: 0, confirmPaid: true } } as any));
  h.advance(60_000); await h.tick();
  state = await h.state();
  const j = job(state, 2);
  assert.match(j.title, /^Research: Can we offer/);
  assert.equal(j.authorizedCents, 100, 'the per-job allowance applies as to any job');
  assert.ok(j.reservation, 'dispatched within the limits');
  assert.equal(cloudResearch(state.org, state.jobs.jobs).reports[0].status, 'running');
  assert.ok(provider.calls.some((c) => c === `dispatch:${uuid(2)}`));

  // The turn ends; the first read fails (unknown) and is retried, the second imports.
  provider.files.set(`${uuid(2)}:${researchPath(uuid(2))}`, 'error');
  provider.finish(uuid(2));
  h.advance(60_000); await h.tick();
  state = await h.state();
  assert.equal(state.org.research[0].status, 'queued');
  assert.match(state.org.research[0].reason!, /tries again/);
  provider.files.set(`${uuid(2)}:${researchPath(uuid(2))}`, REPORT);
  h.advance(60_000); await h.tick();
  state = await h.state();
  const r = state.org.research[0];
  assert.equal(r.status, 'imported');
  assert.equal(r.feasibility, 'partial');
  assert.equal(r.tools.length, 1);
  const tool = state.org.approvals.find((a) => a.kind === 'tool_proposal')!;
  assert.equal(tool.raisedBy, 'research');
  assert.equal(tool.tool!.url, 'https://cal.com/');
  assert.equal(cloudExecutives(state, state.org, h.now).executives.find((e) => e.role === 'research')!.attention, 1);
  const credits = state.empire.funds;
  const ledger = JSON.stringify(state.ledger);

  push(h.store, decision(3, tool, 'approve'));
  h.advance(60_000); await h.tick();
  state = await h.state();
  assert.equal(state.org.research[0].tools[0].decision, 'approved');
  assert.equal(JSON.stringify(state.ledger), ledger, 'a tool decision moves no money');
  assert.ok(state.empire.funds >= credits, 'and no city credits');
  // Read once: an imported report is never read again.
  const reads = provider.calls.filter((c) => c.startsWith('read:')).length;
  h.advance(60_000); await h.tick();
  assert.equal(provider.calls.filter((c) => c.startsWith('read:')).length, reads);
});

test('cloud research: a missing or invalid report needs attention with the reason; nothing is guessed', async () => {
  const provider = new FakeProvider();
  const h = harness(makeStore({ limits: { maxConcurrent: 2, perTaskBudgetCents: 100, dailyBudgetCents: 1000 } }), provider);
  push(h.store,
    intent(1, { kind: 'research', question: 'First?', job: { id: uuid(1), configRevision: 0, confirmPaid: true } } as any),
    intent(2, { kind: 'research', question: 'Second?', job: { id: uuid(2), configRevision: 0, confirmPaid: true } } as any));
  await h.tick();
  provider.files.set(`${uuid(2)}:${researchPath(uuid(2))}`, REPORT.replace('(https://example.org/booking)', ''));
  provider.finish(uuid(1)); provider.finish(uuid(2));
  h.advance(60_000); await h.tick();
  const state = await h.state();
  const [a, b] = [state.org.research.find((r) => r.jobId === uuid(1))!, state.org.research.find((r) => r.jobId === uuid(2))!];
  assert.equal(a.status, 'needs_attention');
  assert.match(a.reason!, /did not commit docs\/empire\/research\//);
  assert.equal(b.status, 'needs_attention');
  assert.match(b.reason!, /cites no source URL/);
  assert.equal(state.org.approvals.length, 0);
});

// ---------------------------------------------------------------- schema and compatibility

test('cloud org schema: an older snapshot without org.json loads; an empty org is never written; foreign kinds refused', async () => {
  const h = harness(makeStore());
  await h.tick();
  assert.equal(files(h.store)[ORG_FILE], undefined, 'no org file until the organization is used');
  assert.deepEqual((await h.state()).org, emptyOrg());
  push(h.store, propose(1, { text: 'Keep README current.', scope: 'company' }));
  h.advance(60_000); await h.tick();
  assert.ok(files(h.store)[ORG_FILE]);
  const raw = JSON.parse(files(h.store)[ORG_FILE]);
  raw.approvals[0].kind = 'job_plan';
  assert.throws(() => validateOrg(raw), /not raised in cloud mode/);
  const f = serializeState(initialCloudState(T0, { execution: EXECUTION }));
  assert.throws(() => parseStateFiles({ ...f, [ORG_FILE]: JSON.stringify(raw) }, T0), /state\/org\.json/);
});

// ---------------------------------------------------------------- matrix and shared rules

test('capability matrix: every cloud gap has a specific reason and the missing inbox kinds are exactly those not raised', () => {
  for (const [feature, c] of Object.entries(ORG_CAPABILITIES)) {
    if (c.cloud !== 'works') {
      assert.ok(c.reason && c.reason.length > 30, `${feature} names why it can't run in cloud mode`);
      assert.ok(cloudGapMessage(feature as never).includes(c.reason!), `${feature}: the UI message carries the reason`);
    }
  }
  const all = Object.keys(APPROVAL_KIND_LABEL) as ApprovalKind[];
  assert.deepEqual(cloudMissingKinds().map((m) => m.kind).sort(), all.filter((k) => !CLOUD_APPROVAL_KINDS.includes(k)).sort());
  for (const m of cloudMissingKinds()) assert.ok(m.message.length > 40);
  assert.match(cloudGapMessage('outreach'), /SMTP/);
  assert.match(cloudGapMessage('chief_brain'), /Ollama/);
});

test('cloud executives: rule-based, computed from the snapshot; marketing states its outreach gap', () => {
  const state = initialCloudState(T0, { execution: EXECUTION });
  const org = cloudExecutives(state, state.org, T0);
  assert.equal(org.executives.length, 5);
  assert.ok(org.executives.every((e) => e.monitor === 'rule_based' && e.active));
  assert.equal(org.executives.find((e) => e.role === 'marketing_sales')!.summary, ORG_CAPABILITIES.outreach.cloudSummary);
});

test('shared rules: the server and the coordinator apply the very same functions', () => {
  assert.equal(serverMemory.checkLesson, sharedLessons.checkLesson);
  assert.equal(serverResearch.parseResearchReport, sharedResearch.parseResearchReport);
  assert.equal(serverResearch.researchPrompt, sharedResearch.researchPrompt);
  assert.equal(serverArtifacts.parseArtifact, sharedArtifacts.parseArtifact);
});
