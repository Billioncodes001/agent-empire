// FREE-10 security review fixes: stale approvals can never activate a lesson; Telegram sees full lesson text;
// product scopes match whole words.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Consultancy } from '../src/server/consultancy.js';
import { estimateJob, type PlannedItem } from '../src/server/estimate.js';
import { ApprovalInbox, approvalLine } from '../src/server/approvals.js';
import { LessonMemory } from '../src/server/memory.js';
import type { QueueState, QueueTask } from '../src/shared/protocol.js';
import { relevantLessons, type Lesson } from '../src/shared/memory.js';

const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = (() => { throw new Error('network call attempted'); }) as typeof fetch; });
test.after(() => { globalThis.fetch = realFetch; });

class FakeQueue {
  tasks: QueueTask[] = [];
  state(): QueueState { return { tasks: this.tasks, maxWorkers: 2 }; }
  add(): string | undefined { return undefined; }
}

function world(dir: string) {
  let inbox!: ApprovalInbox;
  const office = new Consultancy(dir, new FakeQueue(), () => { inbox?.reconcile(); }, { estimate: (items: PlannedItem[]) => estimateJob(items, [], { maxWorkers: 2, now: 7 }) });
  inbox = new ApprovalInbox(dir, office);
  const memory = new LessonMemory(dir);
  memory.setInbox({ raise: (f) => inbox.raiseLesson(f), resolve: (id, note) => inbox.resolveLesson(id, note), get: (id) => inbox.get(id) });
  inbox.setLessons(memory.actions());
  return { inbox, memory };
}
const source = { kind: 'review' as const, ref: 'J1:i1:q1:1', jobId: 'J1', label: 'Review' };

test('review fix 1a: after lessons.json is reset, an old approval never activates a new lesson with the same id', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mem-rev-'));
  const a = world(dir);
  const old = a.memory.addNote({ text: 'Old, reviewed lesson.', scope: 'company' }, 'CEO');
  const oldItem = a.inbox.state().items.find((i) => i.kind === 'lesson')!;
  a.inbox.approve(oldItem.id, 'CEO');
  assert.equal(a.memory.get(old.id)!.status, 'approved');
  rmSync(path.join(dir, 'lessons.json'));
  const b = world(dir);
  const fresh = b.memory.proposeFromChief({ key: 'review:x', draft: { text: 'Unreviewed model text.', scope: 'company' }, source, model: 'm' });
  assert.ok('ok' in fresh);
  assert.equal(fresh.ok.id, old.id, 'the id is reused after a reset');
  b.memory.reconcile();
  assert.equal(b.memory.get(fresh.ok.id)!.status, 'proposed', 'never approved by the old item');
  assert.deepEqual(b.memory.relevant({ client: 'x', title: 'Unreviewed model text', brief: '' }), []);
  const pending = b.inbox.state().items.filter((i) => i.kind === 'lesson' && i.status === 'pending');
  assert.equal(pending.length, 1, 'a fresh pending item is shown');
  assert.equal(pending[0].lesson!.text, 'Unreviewed model text.');
  assert.notEqual(pending[0].id, oldItem.id);
  // Approving the old (decided) item again changes nothing; the stale item cannot be applied.
  assert.match(b.memory.actions().check(b.inbox.get(oldItem.id)!) ?? '', /no longer/);
  assert.equal(b.memory.actions().apply(b.inbox.get(oldItem.id)!, 'approved', 'CEO'), '');
  assert.equal(b.memory.get(fresh.ok.id)!.status, 'proposed');
  rmSync(dir, { recursive: true, force: true });
});

test('review fix 1b: after approvals.json is reset, a stale approvalId pointing at an unrelated approved item is ignored', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mem-rev-'));
  const a = world(dir);
  const l = a.memory.addNote({ text: 'Waiting lesson.', scope: 'company' }, 'CEO');
  assert.equal(a.memory.get(l.id)!.approvalId, 'A1');
  rmSync(path.join(dir, 'approvals.json'));
  const b = world(dir);
  // The memory restored before raising: the reset inbox hands out A1 to an unrelated item, which is approved.
  const tool = b.inbox.raise({ source: 'tool:x', kind: 'tool_proposal', jobId: 'J9', title: 'Tool', detail: 'd', tool: { name: 'x', url: 'https://x.example', licence: 'MIT', enables: 'e', risk: 'r' } });
  assert.equal(tool, 'A1');
  b.inbox.approve('A1', 'CEO');
  b.memory.reconcile();
  assert.equal(b.memory.get(l.id)!.status, 'proposed');
  const item = b.inbox.state().items.find((i) => i.kind === 'lesson' && i.status === 'pending');
  assert.ok(item, 'a fresh lesson item is raised');
  assert.equal(b.memory.get(l.id)!.approvalId, item!.id);
  rmSync(dir, { recursive: true, force: true });
});

test('review fix 2: /approvals lines carry the full lesson text, and the replaced text for edits', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mem-rev-'));
  const a = world(dir);
  const long = `Start of lesson ${'x'.repeat(440)} END-OF-LESSON`;
  const l = a.memory.addNote({ text: long, scope: 'company' }, 'CEO');
  const item = a.inbox.state().items.find((i) => i.kind === 'lesson')!;
  assert.match(approvalLine(item), /END-OF-LESSON/);
  a.inbox.approve(item.id, 'CEO');
  a.memory.edit(l.id, { text: 'The edited lesson text.' }, 'CEO');
  const edit = a.inbox.state().items.find((i) => i.kind === 'lesson' && i.status === 'pending')!;
  const line = approvalLine(edit);
  assert.match(line, /The edited lesson text\./);
  assert.match(line, /replaces L1: Start of lesson x+ END-OF-LESSON/);
  rmSync(dir, { recursive: true, force: true });
});

test('review note: product scope matches whole words only', () => {
  const mk = (id: string, scopeValue: string): Lesson => ({ id, text: 'Ship it.', scope: 'product', scopeValue, status: 'approved', source: { kind: 'ceo_note', ref: '', label: 'CEO note' }, proposedBy: 'CEO', proposedAt: 1, uses: 0 });
  const all = [mk('L1', 'App'), mk('L2', 'Clinic Calendar')];
  assert.deepEqual(relevantLessons(all, { client: 'c', title: 'A happy customer', brief: 'Clinic calendars.' }).map((l) => l.id), []);
  assert.deepEqual(relevantLessons(all, { client: 'c', title: 'The app', brief: 'Uses the clinic-calendar API.' }).map((l) => l.id), ['L1', 'L2']);
});
