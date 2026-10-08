import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Consultancy } from '../src/server/consultancy.js';
import { ApprovalInbox } from '../src/server/approvals.js';
import { chiefCommands } from '../src/server/chief-commands.js';
import { projectOrg } from '../src/server/org.js';
import { ResearchDesk, parseResearchReport, researchPrompt } from '../src/server/research.js';
import { MAX_ARTIFACT_BYTES, parseArtifact, readArtifact } from '../src/server/research-artifact.js';
import type { QueueState, QueueTask } from '../src/shared/protocol.js';

// ---- fixtures ---------------------------------------------------------------------------------------------------------

const GOOD = `---
question: Can we sell to dentists?
feasibility: partial
confidence: medium
---
# Report

## Findings
- Dental practices buy scheduling software (https://example.com/survey).
- Most use a practice management system with an API, see https://docs.example.org/api and https://example.net/b.

## What we can do now
Build an integration prototype.

## What we can't do yet and why
We lack a sandbox account.

## Proposed tools
| Name | URL | Licence | Enables | Risk |
|---|---|---|---|---|
| Foo SDK | https://foo.dev | MIT | Talk to the PMS API | Vendor lock-in |
| Bar CLI | [site](https://bar.example) | Apache-2.0 | Bulk import | Needs credentials |
`;

const art = (text: string) => parseArtifact(Buffer.from(text));
const reason = (text: string) => { const r = parseResearchReport(art(text)); assert.equal(r.ok, false); return (r as { reason: string }).reason; };

class FakeQueue {
  tasks: QueueTask[] = [];
  private n = 1;
  state(): QueueState { return { tasks: this.tasks.map((t) => ({ ...t })), maxWorkers: 2 }; }
  add(prompt: string, by: string, title?: string, _issue?: number, jobKey?: string): string | undefined {
    this.tasks.push({ id: `q-${this.n++}`, jobKey, title: title ?? 'task', prompt, addedBy: by, addedAt: 1, status: 'queued' });
    return undefined;
  }
}

function setup(dir = mkdtempSync(path.join(tmpdir(), 'research-'))) {
  const queue = new FakeQueue();
  const files = new Map<string, string>();
  let inbox!: ApprovalInbox;
  let research: ResearchDesk | undefined;
  const office = new Consultancy(dir, queue, () => { inbox?.reconcile(); research?.reconcile(); }, { itemIssue: (key) => research?.issue(key) });
  inbox = new ApprovalInbox(dir, office, () => research?.reconcile());
  const reads: string[] = [];
  research = new ResearchDesk(dir, {
    create: (input, actor) => office.create(input, actor),
    snapshot: () => office.snapshot(),
    queue: () => queue.state(),
    readArtifact: (task, jobId) => { reads.push(jobId); const t = files.get(jobId); return t === undefined ? { ok: false, reason: `The worker did not write docs/empire/research/${jobId}.md.` } : parseArtifact(Buffer.from(t)); },
    raiseTool: ({ source, jobId, tool }) => inbox.raise({ source, kind: 'tool_proposal', jobId, tool, title: `Tool: ${tool.name}`, detail: 'd' }),
    decision: (id) => inbox.get(id),
  });
  const finish = (jobId: string, extra: Partial<QueueTask> = {}) => {
    const job = office.snapshot().jobs.find((j) => j.id === jobId)!;
    const task = queue.tasks.find((t) => t.jobKey === job.items[0].jobKey)!;
    Object.assign(task, { status: 'done', outcome: 'done', workerName: 'Bea', branch: 'office/bea-1', finishedAt: 9 }, extra);
    office.reconcile();
    research!.reconcile();
  };
  return { dir, queue, office, inbox, research, files, reads, finish, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---- strict parsing ---------------------------------------------------------------------------------------------------

test('a complete report parses: frontmatter, four sections, sources counted, tools listed', () => {
  const r = parseResearchReport(art(GOOD));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.feasibility, 'partial');
  assert.equal(r.confidence, 'medium');
  assert.equal(r.sources, 3);
  assert.deepEqual(r.tools.map((t) => [t.name, t.url, t.licence]), [['Foo SDK', 'https://foo.dev/', 'MIT'], ['Bar CLI', 'https://bar.example/', 'Apache-2.0']]);
  assert.match(r.sections.cannotYet, /sandbox/);
});

test('strict parse: missing or invalid frontmatter and sections are rejected with a reason', () => {
  assert.match(reason(GOOD.replace(/^---\n/, '')), /no frontmatter/);
  assert.match(reason(GOOD.replace('feasibility: partial\n', '')), /missing feasibility/);
  assert.match(reason(GOOD.replace('feasibility: partial', 'feasibility: maybe')), /feasibility must be/);
  assert.match(reason(GOOD.replace('confidence: medium', 'confidence: very')), /confidence must be/);
  assert.match(reason(GOOD.replace('confidence: medium\n', '')), /missing confidence/);
  assert.match(reason(GOOD.replace('question: Can we sell to dentists?\n', '')), /missing question/);
  assert.match(reason(GOOD.replace('confidence: medium', 'confidence: medium\nextra: 1')), /Unexpected frontmatter key/);
  assert.match(reason(GOOD.replace('confidence: medium', 'confidence: medium\nconfidence: low')), /appears twice/);
  assert.match(reason(GOOD.replace('## What we can do now', '## Next steps')), /"What we can do now" is missing/);
  assert.match(reason(GOOD.replace('## Proposed tools', '## Tools')), /"Proposed tools" is missing/);
  assert.match(reason(GOOD + '\n## Findings\n- again https://x.example\n'), /appears twice/);
  assert.match(reason(GOOD.replace('| Bar CLI | [site](https://bar.example)', '| Bar CLI | http://bar.example')), /needs an https URL/);
  assert.match(reason(GOOD.replace('| Bar CLI | [site](https://bar.example)', '| Bar CLI | javascript:alert(1)')), /needs an https URL/);
  assert.match(reason(GOOD.replace('| Name | URL | Licence | Enables | Risk |', '| Name | Link |')), /columns/);
  assert.match(reason(GOOD.replace('| Bar CLI | [site](https://bar.example) | Apache-2.0 | Bulk import | Needs credentials |', '| Foo SDK | https://foo2.dev | MIT | x | y |')), /listed twice/);
  // A report with no tools says so explicitly.
  const none = GOOD.replace(/## Proposed tools[\s\S]*$/, '## Proposed tools\nNone.\n');
  const ok = parseResearchReport(art(none));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.tools, []);
  assert.match(reason(GOOD.replace(/## Proposed tools[\s\S]*$/, '## Proposed tools\n')), /Proposed tools is empty/);
});

test('Findings must cite a source URL for every claim', () => {
  assert.match(reason(GOOD.replace(/## Findings[\s\S]*?## What/, '## Findings\nDentists like software.\n\n## What')), /no claims/);
  assert.match(reason(GOOD.replace(' (https://example.com/survey)', '')), /claim 1 cites no source URL/);
  // URLs outside Findings do not count.
  const noSources = GOOD.replace(/## Findings[\s\S]*?## What/, '## Findings\n- Dentists like software.\n\n## What');
  assert.match(reason(noSources), /cites no source URL/);
});

test('the artifact parse is strict about encoding, NUL and frontmatter shape', () => {
  assert.deepEqual(parseArtifact(Buffer.from([0xff, 0xfe, 0x00])), { ok: false, reason: 'The report is not valid UTF-8.' });
  assert.equal(parseArtifact(Buffer.from('---\nq: a\0\n---\n')).ok, false);
  assert.match((parseArtifact(Buffer.from('---\nquestion: a\n')) as { reason: string }).reason, /not closed/);
  assert.match((parseArtifact(Buffer.from('---\nnot a pair\n---\n')) as { reason: string }).reason, /key: value/);
  assert.equal(parseArtifact(Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 'a')).ok, false);
  const quoted = parseArtifact(Buffer.from('---\nquestion: "Can we: do it?"\n---\nbody'));
  assert.deepEqual(quoted, { ok: true, frontmatter: { question: 'Can we: do it?' }, body: 'body' });
});

// ---- path confinement ---------------------------------------------------------------------------------------------

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'research-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(path.join(dir, 'README.md'), 'x');
  git('add', '.');
  git('commit', '-qm', 'init');
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const JOB = 'consultancy-0123456789ab';
const REL = `docs/empire/research/${JOB}.md`;

test('readArtifact reads the worker worktree, and falls back to the committed branch', () => {
  const r = repo();
  try {
    r.git('worktree', 'add', '-q', '-b', 'office/bea-1', '.agent-office/worktrees/bea-1');
    const wt = path.join(r.dir, '.agent-office/worktrees/bea-1');
    mkdirSync(path.join(wt, 'docs/empire/research'), { recursive: true });
    writeFileSync(path.join(wt, REL), GOOD);
    const fromTree = readArtifact({ branch: 'office/bea-1' }, 'research', JOB, { projectDir: r.dir });
    assert.equal(fromTree.ok, true);
    execFileSync('git', ['add', '.'], { cwd: wt });
    execFileSync('git', ['commit', '-qm', 'report'], { cwd: wt });
    r.git('worktree', 'remove', '--force', '.agent-office/worktrees/bea-1');
    const fromBranch = readArtifact({ branch: 'office/bea-1' }, 'research', JOB, { projectDir: r.dir });
    assert.equal(fromBranch.ok, true);
    assert.equal(fromBranch.ok && fromBranch.frontmatter.feasibility, 'partial');
    const missing = readArtifact({ branch: 'office/bea-1' }, 'research', 'consultancy-ffffffffffff', { projectDir: r.dir });
    assert.match((missing as { reason: string }).reason, /did not write/);
  } finally { r.done(); }
});

test('readArtifact refuses symlinks, .., unsafe names, oversize files and wrong paths', () => {
  const r = repo();
  try {
    r.git('worktree', 'add', '-q', '-b', 'office/bea-1', '.agent-office/worktrees/bea-1');
    const wt = path.join(r.dir, '.agent-office/worktrees/bea-1');
    mkdirSync(path.join(wt, 'docs/empire'), { recursive: true });
    // A symlinked directory on the way.
    const outside = mkdtempSync(path.join(tmpdir(), 'research-outside-'));
    writeFileSync(path.join(outside, `${JOB}.md`), GOOD);
    symlinkSync(outside, path.join(wt, 'docs/empire/research'));
    assert.match((readArtifact({ branch: 'office/bea-1' }, 'research', JOB, { projectDir: r.dir }) as { reason: string }).reason, /symlink/);
    unlinkSync(path.join(wt, 'docs/empire/research'));
    // A symlinked file.
    mkdirSync(path.join(wt, 'docs/empire/research'));
    symlinkSync(path.join(outside, `${JOB}.md`), path.join(wt, REL));
    assert.match((readArtifact({ branch: 'office/bea-1' }, 'research', JOB, { projectDir: r.dir }) as { reason: string }).reason, /symlink/);
    rmSync(path.join(wt, REL));
    // Oversize.
    writeFileSync(path.join(wt, REL), 'a'.repeat(MAX_ARTIFACT_BYTES + 1));
    assert.match((readArtifact({ branch: 'office/bea-1' }, 'research', JOB, { projectDir: r.dir }) as { reason: string }).reason, /256 KB/);
    // `..` and unsafe ids or branches never reach the file system.
    assert.match((readArtifact({ branch: 'office/bea-1' }, 'research', '../secret', { projectDir: r.dir }) as { reason: string }).reason, /safe file name/);
    assert.match((readArtifact({ branch: 'office/../../etc' }, 'research', JOB, { projectDir: r.dir }) as { reason: string }).reason, /not safe/);
    assert.match((readArtifact({ branch: 'main' }, 'research', JOB, { projectDir: r.dir }) as { reason: string }).reason, /no worker branch/);
    assert.match((readArtifact({}, 'research', JOB, { projectDir: r.dir }) as { reason: string }).reason, /no worker branch/);
    // The wrong kind's folder is not read: a campaign file is not a research report.
    rmSync(path.join(wt, REL));
    mkdirSync(path.join(wt, 'docs/empire/campaigns'));
    writeFileSync(path.join(wt, `docs/empire/campaigns/${JOB}.md`), GOOD);
    assert.match((readArtifact({ branch: 'office/bea-1' }, 'research', JOB, { projectDir: r.dir }) as { reason: string }).reason, /did not write/);
    rmSync(outside, { recursive: true, force: true });
  } finally { r.done(); }
});

test('a committed symlink on the worker branch is refused', () => {
  const r = repo();
  try {
    r.git('checkout', '-q', '-b', 'office/cy-2');
    mkdirSync(path.join(r.dir, 'docs/empire/research'), { recursive: true });
    symlinkSync('/etc/hosts', path.join(r.dir, REL));
    r.git('add', '.');
    r.git('commit', '-qm', 'link');
    r.git('checkout', '-q', 'main');
    assert.match((readArtifact({ branch: 'office/cy-2' }, 'research', JOB, { projectDir: r.dir }) as { reason: string }).reason, /symlink/);
  } finally { r.done(); }
});

// ---- the desk -------------------------------------------------------------------------------------------------------

test('asking creates an internal job pending approval whose prompt names the artifact path', () => {
  const f = setup();
  try {
    const { job, report } = f.research.ask('  Can we sell   to dentists? ', 'CEO', 'r1');
    assert.equal(job.client, 'Internal');
    assert.equal(job.decision, 'pending_approval');
    assert.equal(job.items.length, 1);
    assert.match(job.items[0].prompt, new RegExp(`docs/empire/research/${job.id}\\.md`));
    assert.doesNotMatch(job.items[0].prompt, /\{\{jobId\}\}/);
    assert.match(job.items[0].prompt, /every bullet|Every bullet/);
    assert.match(job.items[0].prompt, /Be honest/);
    assert.equal(report.status, 'awaiting_approval');
    assert.equal(report.question, 'Can we sell to dentists?');
    assert.equal(f.queue.tasks.length, 0, 'nothing runs before approval');
    // Idempotent per request id (Telegram replays), and the job reloads from its journal.
    assert.equal(f.research.ask('Can we sell to dentists?', 'CEO', 'r1').job.id, job.id);
    assert.equal(f.research.state().reports.length, 1);
    assert.equal(new Consultancy(f.dir, f.queue).snapshot().jobs[0].id, job.id);
    assert.ok(f.inbox.pending().some((i) => i.kind === 'job_plan' && i.jobId === job.id));
    assert.throws(() => f.research.ask('', 'CEO', 'r2'), /Ask a question/);
    assert.throws(() => f.research.ask('x'.repeat(501), 'CEO', 'r3'), /under 500/);
  } finally { f.done(); }
});

test('a finished task imports the report; each tool raises one tool_proposal, once, even on re-import', () => {
  const f = setup();
  try {
    const { job } = f.research.ask('Can we sell to dentists?', 'CEO', 'r1');
    f.office.approve(job.id, 'CEO');
    f.files.set(job.id, GOOD);
    f.research.reconcile();
    assert.equal(f.research.state().reports[0].status, 'queued');
    f.finish(job.id);
    const report = f.research.report(job.id)!;
    assert.equal(report.status, 'imported');
    assert.equal(report.worker, 'Bea');
    assert.equal(report.feasibility, 'partial');
    assert.equal(report.sources, 3);
    assert.match(report.sections!.findings, /example\.com/);
    const tools = f.inbox.state().items.filter((i) => i.kind === 'tool_proposal');
    assert.equal(tools.length, 2);
    assert.equal(tools[0].raisedBy, 'research');
    assert.deepEqual(tools.map((t) => t.tool?.name), ['Foo SDK', 'Bar CLI']);
    assert.equal(f.research.state().openProposals, 2);
    // Re-import attempts change nothing: no new items, no second read.
    const reads = f.reads.length;
    f.research.reconcile(); f.research.reconcile();
    const reloaded = new ResearchDesk(f.dir, { create: () => { throw new Error('no'); }, snapshot: () => f.office.snapshot(), queue: () => f.queue.state(), readArtifact: () => { throw new Error('should not read'); }, raiseTool: ({ source, jobId, tool }) => f.inbox.raise({ source, kind: 'tool_proposal', jobId, tool, title: 't', detail: 'd' }) });
    reloaded.reconcile();
    assert.equal(f.reads.length, reads);
    assert.equal(f.inbox.state().items.filter((i) => i.kind === 'tool_proposal').length, 2);
    // A new inbox over the same file keeps them (durable) and raising the same source answers the same id.
    const again = new ApprovalInbox(f.dir, f.office);
    assert.equal(again.raise({ source: `tool:${job.id}:1`, kind: 'tool_proposal', jobId: job.id, title: 'x', detail: 'x', tool: tools[0].tool! }), tools[0].id);
    // The consultancy item stays a normal finished item.
    assert.equal(f.office.snapshot().jobs[0].items[0].status, 'awaiting_review');
  } finally { f.done(); }
});

test('deciding a tool proposal only records the decision, on the inbox and the research card', () => {
  const f = setup();
  try {
    const { job } = f.research.ask('Q?', 'CEO', 'r1');
    f.office.approve(job.id, 'CEO');
    f.files.set(job.id, GOOD);
    f.finish(job.id);
    const tasksBefore = f.queue.tasks.length;
    const jobsBefore = f.office.snapshot().jobs.length;
    const [a, b] = f.inbox.pending().filter((i) => i.kind === 'tool_proposal');
    const approved = f.inbox.approve(a.id, 'CEO');
    assert.equal(approved.status, 'approved');
    f.inbox.reject(b.id, 'CEO via Telegram');
    assert.equal(f.inbox.approve(b.id, 'CEO').status, 'rejected', 'decisions are idempotent');
    f.research.reconcile();
    const tools = f.research.report(job.id)!.tools;
    assert.deepEqual(tools.map((t) => t.decision), ['approved', 'rejected']);
    assert.equal(tools[1].decidedBy, 'CEO via Telegram');
    assert.equal(f.research.state().openProposals, 0);
    assert.equal(f.queue.tasks.length, tasksBefore, 'no task is queued');
    assert.equal(f.office.snapshot().jobs.length, jobsBefore, 'no job is created');
  } finally { f.done(); }
});

test('an invalid or missing report makes the item need attention with the reason; a retry re-imports', () => {
  const f = setup();
  try {
    const { job } = f.research.ask('Q?', 'CEO', 'r1');
    f.office.approve(job.id, 'CEO');
    f.finish(job.id);
    let report = f.research.state().reports[0];
    assert.equal(report.status, 'needs_attention');
    assert.match(report.reason!, /did not write/);
    const item = f.office.snapshot().jobs[0].items[0];
    assert.equal(item.status, 'needs_attention');
    assert.match(item.attention!, /Research report not accepted: The worker did not write/);
    // Wrong content is reported too, and nothing is raised.
    f.files.set(job.id, GOOD.replace(' (https://example.com/survey)', ''));
    const task = f.queue.tasks[0];
    f.finish(job.id, { attempt: 1 });
    report = f.research.state().reports[0];
    assert.match(report.reason!, /claim 1 cites no source URL/);
    assert.equal(f.inbox.state().items.filter((i) => i.kind === 'tool_proposal').length, 0);
    // The CEO retries; a good report is accepted.
    f.files.set(job.id, GOOD);
    Object.assign(task, { attempt: 2 });
    f.research.reconcile();
    assert.equal(f.research.state().reports[0].status, 'imported');
    assert.equal(f.office.snapshot().jobs[0].items[0].status, 'awaiting_review');
  } finally { f.done(); }
});

test('only an outcome of done imports; a failed task does not read the report', () => {
  const f = setup();
  try {
    const { job } = f.research.ask('Q?', 'CEO', 'r1');
    f.office.approve(job.id, 'CEO');
    f.files.set(job.id, GOOD);
    f.finish(job.id, { outcome: 'killed' });
    assert.equal(f.reads.length, 0);
    assert.notEqual(f.research.state().reports[0].status, 'imported');
  } finally { f.done(); }
});

test('old data dirs without research.json load empty; a corrupt index is reported, not overwritten', () => {
  const f = setup();
  try {
    assert.deepEqual(f.research.state(), { schemaVersion: 1, reports: [], openProposals: 0 });
    // An approvals.json written before ORG-05 still loads.
    assert.equal(f.inbox.recoveryError, undefined);
    writeFileSync(path.join(f.dir, 'research.json'), '{"version":1,"revision":1,"reports":[{"jobId":"x"}]}');
    const broken = new ResearchDesk(f.dir, { create: f.office.create.bind(f.office), snapshot: () => f.office.snapshot(), queue: () => f.queue.state(), readArtifact: () => ({ ok: false, reason: 'x' }) });
    assert.match(broken.state().storageError!, /Cannot restore research.json/);
    assert.throws(() => broken.ask('Q?', 'CEO', 'r9'), /research.json/);
    assert.match(readFileSync(path.join(f.dir, 'research.json'), 'utf8'), /"jobId":"x"/);
  } finally { f.done(); }
});

test('Telegram /research creates a job pending approval; /approve on a tool proposal records it', () => {
  const f = setup();
  try {
    const chief = chiefCommands(f.office, () => 'resources', f.inbox, undefined, f.research);
    const reply = chief.execute('/research Can we sell to dentists?', 'tg-1');
    assert.match(reply, /Nothing starts before approval/);
    const job = f.office.snapshot().jobs[0];
    assert.equal(job.client, 'Internal');
    assert.equal(job.decision, 'pending_approval');
    assert.equal(chief.execute('/research Can we sell to dentists?', 'tg-1'), reply.replace(/\nIt is approval[\s\S]*$/, reply.match(/\nIt is approval[\s\S]*$/)?.[0] ?? ''), 'a replay answers the same job');
    assert.equal(f.office.snapshot().jobs.length, 1);
    assert.match(chief.execute('/research', 'tg-2'), /Use \/research/);
    const plan = f.inbox.pending().find((i) => i.kind === 'job_plan')!;
    assert.match(chief.execute(`/approve ${plan.id}`, 'tg-3'), /approved/);
    f.files.set(job.id, GOOD);
    f.finish(job.id);
    const tool = f.inbox.pending().find((i) => i.kind === 'tool_proposal')!;
    assert.match(chief.execute('/approvals', 'tg-4'), /Tool proposal/);
    assert.match(chief.execute(`/approve ${tool.id}`, 'tg-5'), new RegExp(`${tool.id} approved`));
    f.research.reconcile();
    assert.equal(f.research.report(job.id)!.tools[0].decision, 'approved');
    assert.match(chief.execute(`/reject ${f.inbox.pending()[0].id}`, 'tg-6'), /rejected/);
    // Without a research desk the command says so.
    assert.match(chiefCommands(f.office, () => 'r').execute('/research Q', 'tg-7'), /not available/);
  } finally { f.done(); }
});

test('the research executive is active; its attention is the tool proposals it raised', () => {
  const f = setup();
  try {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const org = (research = f.research.state()) => projectOrg({ now: 1, workers: [], queue: f.queue.state(), jobs: f.office.snapshot().jobs, usage: { total: zero, today: zero, day: 'd', pauseHiring: false } as never, approvals: f.inbox.state().items, research }).executives.find((e) => e.role === 'research')!;
    assert.equal(org().active, true);
    assert.match(org().summary, /No research yet/);
    const { job } = f.research.ask('Q?', 'CEO', 'r1');
    assert.match(org().summary, /1 question awaiting approval/);
    f.office.approve(job.id, 'CEO');
    f.files.set(job.id, GOOD);
    f.finish(job.id);
    assert.equal(org().attention, 2);
    assert.match(org().summary, /1 report · 2 tool proposals to decide/);
  } finally { f.done(); }
});

test('the prompt asks for every contract field', () => {
  const p = researchPrompt('Q');
  for (const needle of ['question:', 'feasibility: feasible | partial | not_yet | unknown', 'confidence: low | medium | high', '## Findings', '## What we can do now', "## What we can't do yet and why", '## Proposed tools', '| Name | URL | Licence | Enables | Risk |', 'docs/empire/research/{{jobId}}.md'])
    assert.ok(p.includes(needle), needle);
});
