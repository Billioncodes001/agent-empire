/**
 * FREE-07 security review fixes: one untrusted report or an inbox backlog must never wedge the coordinator. Each test
 * was run against 76f3c133 first and failed there. No network: in-memory store, fake provider, fake GitHub request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTaskBranchFile } from '../src/cloud/provider';
import { ORG_FILE, ORG_LIMITS, ORG_MAX_BYTES, addResearch, emptyOrg, recordResearch, researchPath, validateOrg, type CloudOrg } from '../src/cloud/org';
import { parseResearchReport } from '../src/shared/research-report';
import { parseArtifact } from '../src/shared/artifact-parse';
import { approvalFingerprint } from '../src/shared/approvals';
import { serializeState } from '../src/cloud/schema';
import { MemoryStateStore } from '../src/cloud/store';
import { EXECUTION, FakeProvider, harness, intent, job, makeStore, push, uuid } from './cloud-fixtures';

const report = (url: string, tools = 1, name = 'T') => `---\nquestion: q\nfeasibility: feasible\nconfidence: low\n---\n## Findings\n- claim https://example.com\n## What we can do now\nx\n## What we can't do yet and why\ny\n## Proposed tools\n| Name | URL | Licence | Enables | Risk |\n|---|---|---|---|---|\n`
  + Array.from({ length: tools }, (_, i) => `| ${name}${i} | ${url}${i} | MIT | a | b |`).join('\n') + '\n';
const jobAt = (n: number): any => ({ id: uuid(n), status: 'awaiting_review', branch: `agent-empire/task-${uuid(n)}` });
const found = (text: string) => ({ state: 'found' as const, text, bytes: new TextEncoder().encode(text).length });
const roundTrips = (org: CloudOrg) => validateOrg(JSON.parse(JSON.stringify(org)));
const research = (n: number, q = 'What tools?') => intent(n, { kind: 'research', question: q, job: { id: uuid(n), configRevision: 0, confirmPaid: true } } as any);
const lastOutcome = (state: any, id: string) => state.processed.entries.find((e: any) => e.id === id)?.outcome;

// ---------------------------------------------------------------- 1. long URL

test('review 1: a report with an over-long tool URL is refused with a reason, and the org still validates', () => {
  const parsed = parseResearchReport(parseArtifact(report('https://example.com/' + 'a'.repeat(3000))));
  assert.equal(parsed.ok, false);
  assert.match((parsed as any).reason, /URL/);
  const org = emptyOrg();
  addResearch(org, uuid(1), 'q', 1);
  const text = report('https://example.com/' + 'a'.repeat(3000));
  recordResearch(org, [jobAt(1)], { [uuid(1)]: found(text) }, 2);
  assert.equal(org.research[0].status, 'needs_attention');
  assert.equal(org.approvals.length, 0);
  roundTrips(org);
});

test('review 1: a coordinator run never commits an org.json it cannot read back (end to end)', async () => {
  const provider = new FakeProvider();
  const h = harness(makeStore(), provider);
  push(h.store, research(1));
  await h.tick();
  provider.files.set(`${uuid(1)}:${researchPath(uuid(1))}`, report('https://example.com/' + 'a'.repeat(3000)));
  provider.finish(uuid(1));
  h.advance(60_000); await h.tick();
  h.advance(60_000); await h.tick();
  const state = await h.state(); // throws if the committed state is unreadable
  assert.equal(state.org.research[0].status, 'needs_attention');
  const raw = h.store.commits.at(-1)!.files[ORG_FILE];
  validateOrg(JSON.parse(raw));
});

// ---------------------------------------------------------------- 2. full inbox

test('review 2: a full inbox never throws out of the import; the report says why and decisions still drain it', async () => {
  const org = emptyOrg();
  const jobs: any[] = [];
  for (let k = 0; k < 45; k++) { jobs.push(jobAt(k + 1)); addResearch(org, uuid(k + 1), `q${k}`, k); }
  const reads = Object.fromEntries(jobs.map((j, i) => [j.id, found(report(`https://example.com/t${i}-`, 10))]));
  assert.doesNotThrow(() => recordResearch(org, jobs, reads, 5));
  const pending = org.approvals.filter((a) => a.status === 'pending').length;
  assert.ok(pending <= ORG_LIMITS.approvals);
  const blocked = org.research.filter((r) => r.status !== 'imported');
  assert.ok(blocked.length > 0 && blocked.every((r) => /inbox/i.test(r.reason ?? '')), 'reports that did not fit say the inbox is full');
  roundTrips(org);
});

test('review 2: with a full inbox, cancel and decisions in the same run are still applied', async () => {
  const provider = new FakeProvider();
  const h = harness(makeStore({ limits: { maxConcurrent: 2, perTaskBudgetCents: 100, dailyBudgetCents: 100_000 } }), provider);
  // A state whose inbox is already at its limit with pending tool proposals.
  const state = await h.state();
  for (let k = 0; k < ORG_LIMITS.approvals; k++) state.org.approvals.push({ id: `A${k + 1}`, kind: 'lesson', raisedBy: 'chief_of_staff', title: 't', detail: 'd', jobId: '', createdAt: 1, status: 'pending',
    lesson: { lessonId: `L${k + 1}`, text: `Lesson ${k}`, scope: 'company', source: { kind: 'ceo_note', ref: '', label: 'x' }, proposedBy: 'CEO', nonce: 'a'.repeat(16) } } as any);
  state.org.nextApproval = ORG_LIMITS.approvals + 1;
  state.org.lessons = state.org.approvals.map((a: any, k: number) => ({ id: `L${k + 1}`, text: `Lesson ${k}`, scope: 'company', source: { kind: 'ceo_note', ref: '', label: 'x' }, status: 'proposed', proposedBy: 'CEO', proposedAt: 0, uses: 0, nonce: 'a'.repeat(16), approvalId: a.id }));
  state.org.nextLesson = ORG_LIMITS.approvals + 1;
  const store = new MemoryStateStore(serializeState(state));
  const h2 = harness(store, provider, h.now);
  push(store, research(1), intent(2, { kind: 'new_job', job: { id: uuid(2), title: 'Other', prompt: 'Other work', configRevision: 0, confirmPaid: true } } as any));
  await h2.tick();
  provider.files.set(`${uuid(1)}:${researchPath(uuid(1))}`, report('https://example.com/t', 3));
  provider.finish(uuid(1));
  const s1 = await h2.state();
  const first = s1.org.approvals[0];
  push(store, intent(3, { kind: 'approval_decision', approvalId: first.id, decision: 'approve', seen: approvalFingerprint(first) } as any), intent(4, { kind: 'cancel', jobId: uuid(2) } as any));
  h2.advance(60_000); await h2.tick();
  const s2 = await h2.state();
  assert.equal(lastOutcome(s2, uuid(100_003)), 'applied', 'the decision drains the backlog');
  assert.equal(lastOutcome(s2, uuid(100_004)), 'applied', 'cancel still runs');
  assert.ok(['cancelled'].includes(job(s2, 2).status) || job(s2, 2).stopRequested, 'the cancel took effect');
});

// ---------------------------------------------------------------- 3. size bound

test('review 3: the largest org the rules allow stays under the reader budget', () => {
  const org = emptyOrg();
  const jobs: any[] = [];
  const big = (n: number) => 'x'.repeat(n);
  const fat = `---\nquestion: ${big(480)}\nfeasibility: feasible\nconfidence: low\n---\n## Findings\n- ${big(20_000)} https://example.com\n## What we can do now\n${big(20_000)}\n## What we can't do yet and why\n${big(20_000)}\n## Proposed tools\n| Name | URL | Licence | Enables | Risk |\n|---|---|---|---|---|\n`
    + Array.from({ length: 10 }, (_, i) => `| ${big(110)}${i} | https://example.com/${big(400)}${i} | ${big(110)} | ${big(290)} | ${big(290)} |`).join('\n') + '\n';
  for (let k = 0; k < ORG_LIMITS.research + 20; k++) {
    jobs.push(jobAt(k + 1));
    try { addResearch(org, uuid(k + 1), big(480), k); } catch { /* full */ }
    recordResearch(org, jobs, { [uuid(k + 1)]: found(fat) }, k + 10);
    // Decide everything so nothing pins the old reports.
    for (const a of org.approvals) if (a.status === 'pending') { a.status = 'approved'; a.decidedAt = k + 10; }
    for (const r of org.research) for (const t of r.tools) t.decision = 'approved';
  }
  const bytes = new TextEncoder().encode(JSON.stringify(org, null, 2) + '\n').length;
  assert.ok(bytes <= ORG_MAX_BYTES, `org.json is ${bytes} bytes (budget ${ORG_MAX_BYTES})`);
  assert.ok(ORG_MAX_BYTES <= 3 * 1024 * 1024);
  roundTrips(org);
  // A tool proposal's details are stored once, in its report, not again in the inbox item.
  assert.ok(org.approvals.filter((a) => a.kind === 'tool_proposal').every((a) => a.tool === undefined));
});

// ---------------------------------------------------------------- 4. branch reads

const fakeRequest = (data: unknown, status = 200) => async () => { if (status === 404) throw Object.assign(new Error('nf'), { status: 404 }); return { data }; };
const isNotFound = (e: any) => e?.status === 404;
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString('base64');
const BRANCH = `agent-empire/task-${uuid(1)}`;
const PATH = researchPath(uuid(1));

test('review 4: readTaskBranchFile refuses structural problems as final answers, and checks names', async () => {
  await assert.rejects(readTaskBranchFile(fakeRequest({}), isNotFound, EXECUTION, 'main', PATH), /branch/);
  await assert.rejects(readTaskBranchFile(fakeRequest({}), isNotFound, EXECUTION, BRANCH, '../../etc/passwd'), /path/);
  assert.deepEqual(await readTaskBranchFile(fakeRequest(null, 404), isNotFound, EXECUTION, BRANCH, PATH), { state: 'missing' });
  const dir = await readTaskBranchFile(fakeRequest([{ type: 'file' }]), isNotFound, EXECUTION, BRANCH, PATH);
  assert.equal(dir.state, 'refused');
  const link = await readTaskBranchFile(fakeRequest({ type: 'symlink', size: 10 }), isNotFound, EXECUTION, BRANCH, PATH);
  assert.equal(link.state, 'refused');
  const huge = await readTaskBranchFile(fakeRequest({ type: 'file', size: 300 * 1024, encoding: 'base64', content: '' }), isNotFound, EXECUTION, BRANCH, PATH);
  assert.equal(huge.state, 'refused');
  const bad = await readTaskBranchFile(fakeRequest({ type: 'file', size: 2, encoding: 'base64', content: b64(new Uint8Array([0xff, 0xfe])) }), isNotFound, EXECUTION, BRANCH, PATH);
  assert.equal(bad.state, 'refused');
  assert.match((bad as any).reason, /UTF-8/);
  const ok = await readTaskBranchFile(fakeRequest({ type: 'file', size: 5, encoding: 'base64', content: b64('hello') }), isNotFound, EXECUTION, BRANCH, PATH);
  assert.deepEqual(ok, { state: 'found', text: 'hello', bytes: 5 });
});

test('review 4: a refused read needs attention at once; unknown reads stop after a few tries', () => {
  const org = emptyOrg();
  addResearch(org, uuid(1), 'a', 1); addResearch(org, uuid(2), 'b', 2);
  recordResearch(org, [jobAt(1), jobAt(2)], { [uuid(1)]: { state: 'refused', reason: 'The report is a folder, not a file.' } as any }, 3);
  assert.equal(org.research[0].status, 'needs_attention');
  assert.match(org.research[0].reason!, /folder/);
  for (let i = 0; i < ORG_LIMITS.readAttempts; i++) recordResearch(org, [jobAt(1), jobAt(2)], { [uuid(2)]: { state: 'unknown', reason: 'down' } }, 4 + i);
  assert.equal(org.research[1].status, 'needs_attention');
  assert.match(org.research[1].reason!, /tried/);
});

// ---------------------------------------------------------------- 5. hidden characters

test('review 5: hidden characters in tool fields or sections refuse the report', () => {
  const bidi = parseResearchReport(parseArtifact(report('https://example.com/x', 1, 'Safe‮tool')));
  assert.equal(bidi.ok, false);
  assert.match((bidi as any).reason, /invisible/);
  const zw = parseResearchReport(parseArtifact(report('https://example.com/x').replace('## What we can do now\nx', '## What we can do now\nx​')));
  assert.equal(zw.ok, false);
});

// ---------------------------------------------------------------- 6. more

test('review 6: prototype-pollution keys in org.json are refused', () => {
  const org = JSON.parse(JSON.stringify(emptyOrg()));
  assert.throws(() => validateOrg(JSON.parse(JSON.stringify(org).replace('"schemaVersion"', '"__proto__":{"polluted":1},"schemaVersion"'))), /unexpected org field/);
  assert.equal(({} as any).polluted, undefined);
  assert.throws(() => validateOrg(JSON.parse('{"schemaVersion":1,"nextApproval":1,"nextLesson":1,"approvals":[],"lessons":[],"research":[],"constructor":{}}')), /unexpected/);
});

test('review 6: research_full rolls back the queued job; nothing is reserved or dispatched', async () => {
  const provider = new FakeProvider();
  const store = makeStore({ mutate: (s) => { for (let k = 0; k < ORG_LIMITS.research; k++) s.org.research.push({ jobId: uuid(500 + k), question: 'q', askedAt: 0, status: 'queued', tools: [] }); } });
  const h = harness(store, provider);
  const i = research(1);
  push(store, i);
  await h.tick();
  const state = await h.state();
  assert.equal(lastOutcome(state, i.id), 'rejected');
  assert.equal(state.jobs.jobs.length, 0);
  assert.equal(provider.calls.filter((c) => c.startsWith('dispatch')).length, 0);
});
