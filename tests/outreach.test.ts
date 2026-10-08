// ORG-04a: email outreach. Fake SMTP transports only; no message ever leaves this process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Consultancy } from '../src/server/consultancy.ts';
import { ApprovalInbox } from '../src/server/approvals.ts';
import { SmtpError, renderMessage, type MailMessage } from '../src/server/email.ts';
import { Outreach, outreachConfig, parseCsv, renderOutreach, validateDraft, type OutreachConfig } from '../src/server/outreach.ts';
import { parseArtifact } from '../src/server/artifacts.ts';
import { chiefCommands } from '../src/server/chief-commands.ts';
import type { QueueTask } from '../src/shared/protocol.ts';
import { STOP_LINE } from '../src/shared/outreach.ts';

const CONFIG: OutreachConfig = { from: 'sales@acme.example', address: 'Acme Ltd, 1 Main Street, Springfield 12345, USA', dailyCap: 200, intervalMs: 10_000, problems: [] };
const CSV = 'name,email,company,source,basis,tags\nAnn Lee,ann@client.example,Northwind,inbound inquiry,existing customer,customers\nBob Ray,BOB@client.example,Harbor,conference,legitimate interest,customers;events\nCid Ng,cid@client.example,Atlas,referral,existing customer,events\n';
const DRAFT = (extra = '') => `---\nsubject: Hello {{name}} from Acme\naudience: [customers]\nproposedLeads:\n  - Dee Fox | dee@client.example | Orbit | trade show | met at booth 4\n${extra}---\n\nHi {{name}},\n\nA short note for {{company}}.\n`;
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

type Behaviour = (m: MailMessage) => Promise<void> | void;

function setup(opts: { config?: OutreachConfig; dir?: string; behave?: Behaviour; noTransport?: boolean } = {}) {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), 'empire-outreach-'));
  const tasks: QueueTask[] = [];
  const sent: MailMessage[] = [];
  const box = { behave: opts.behave ?? (() => undefined) };
  let clock = Date.parse('2026-10-08T09:00:00Z');
  let timers: { fn: () => void; at: number }[] = [];
  let inbox: ApprovalInbox | undefined;
  let outreach: Outreach | undefined;
  const office = new Consultancy(dir, {
    state: () => ({ tasks: tasks.map((t) => ({ ...t })), maxWorkers: 1 }),
    add: (prompt, by, title, _issue, jobKey) => { tasks.push({ id: `q${tasks.length + 1}`, jobKey, prompt, title: title ?? 'task', addedBy: by, addedAt: 1, status: 'queued' }); return undefined; },
  }, () => inbox?.reconcile(), { itemIssue: (jobKey) => outreach?.itemIssue(jobKey) });
  inbox = new ApprovalInbox(dir, office, undefined, () => clock);
  const make = () => {
    const o = new Outreach(dir, {
      projectDir: dir, office, queue: () => ({ tasks: tasks.map((t) => ({ ...t })), maxWorkers: 1 }), config: opts.config ?? CONFIG,
      ...(opts.noTransport ? {} : { transport: { send: async (m: MailMessage) => { await box.behave(m); sent.push(m); } } }),
      now: () => clock,
      schedule: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return () => { timers = timers.filter((x) => x !== t); }; },
      log: () => undefined,
    });
    o.setInbox(inbox!);
    inbox!.setExternal(o);
    return o;
  };
  outreach = make();
  const f = {
    dir, tasks, sent, office, inbox, box,
    get outreach() { return outreach!; },
    restart() { outreach!.stop(); outreach = make(); return outreach; },
    get clock() { return clock; },
    async advance(ms: number) {
      clock += ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= clock);
        if (!due.length) break;
        timers = timers.filter((t) => t.at > clock);
        for (const t of due) t.fn();
        await flush();
      }
      await flush();
    },
    /** Creates a campaign, approves its drafting plan, finishes the task as Wren and writes the artifact. */
    draft(text = DRAFT(), { title = 'Autumn launch', workerBranch = 'office/wren-1', write = true } = {}) {
      const c = outreach!.createCampaign({ requestId: `r-${title}`, title, brief: 'Tell existing customers about the autumn launch.' }, 'CEO');
      const plan = inbox!.state().items.find((i) => i.kind === 'job_plan' && i.jobId === c.jobId)!;
      inbox!.approve(plan.id, 'CEO');
      office.reconcile();
      const task = tasks.find((t) => t.jobKey === `consultancy:${c.jobId}:item-1`)!;
      Object.assign(task, { status: 'done', outcome: 'done', branch: workerBranch, workerName: 'Wren', finishedAt: clock });
      if (write) {
        const file = path.join(dir, '.agent-office/worktrees', workerBranch.slice('office/'.length), 'docs/empire/campaigns', `${c.jobId}.md`);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
      }
      outreach!.reconcile();
      return { campaign: () => outreach!.state().campaigns.find((x) => x.id === c.id)!, jobId: c.jobId, task };
    },
    pendingSend() { return inbox!.state().items.find((i) => i.kind === 'external_action' && i.status === 'pending'); },
  };
  return f;
}

test('CSV import validates every row: address, required source and basis, header, duplicates by lowercase address', () => {
  const f = setup();
  const r = f.outreach.importCsv(`${CSV}Dup,ann@CLIENT.example,X,s,b,\nNo Mail,,X,s,b,\nBad,bad@,X,s,b,\nNo Source,ns@client.example,X,,b,\nNo Basis,nb@client.example,X,s,,\n"Eve ""E""","eve@client.example","Line\nBreak",s,b,\n`, 'CEO');
  assert.equal(r.added, 3);
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.errors.map((e) => e.line), [6, 7, 8, 9, 10]);
  assert.match(r.errors[0].reason, /email is missing/);
  assert.match(r.errors[1].reason, /not a valid email/);
  assert.match(r.errors[2].reason, /source is required/);
  assert.match(r.errors[3].reason, /basis is required/);
  assert.match(r.errors[4].reason, /line break/);
  const leads = f.outreach.state().leads;
  assert.deepEqual(leads.map((l) => [l.id, l.email, l.status]), [['L1', 'ann@client.example', 'confirmed'], ['L2', 'bob@client.example', 'confirmed'], ['L3', 'cid@client.example', 'confirmed']]);
  assert.deepEqual(leads[1].tags, ['customers', 'events']);
  assert.throws(() => f.outreach.importCsv('email,name\na@b.example,A', 'CEO'), /missing: company, source, basis/);
  assert.throws(() => f.outreach.importCsv('name,email,company,source,basis,phone\n', 'CEO'), /Unknown column/);
  assert.throws(() => f.outreach.importCsv('', 'CEO'), /CSV/);
  assert.deepEqual(parseCsv('a,"b,c"\r\n"d""e",f'), { rows: [{ line: 1, fields: ['a', 'b,c'] }, { line: 2, fields: ['d"e', 'f'] }] });
  // Persisted in leads.json.
  assert.equal(JSON.parse(readFileSync(path.join(f.dir, 'leads.json'), 'utf8')).leads.length, 3);
});

test('a campaign is drafted as an internal job; its artifact is imported once done, labelled, and raises an external_action', () => {
  const f = setup();
  f.outreach.importCsv(CSV, 'CEO');
  f.outreach.suppress('bob@client.example', 'opt_out', 'CEO');
  const c = f.outreach.createCampaign({ requestId: 'r1', title: 'Autumn launch', brief: 'Brief' }, 'CEO');
  const job = f.office.snapshot().jobs.find((j) => j.id === c.jobId)!;
  assert.equal(job.client, 'Internal');
  assert.equal(job.decision, 'pending_approval');
  assert.match(job.items[0].prompt, new RegExp(`docs/empire/campaigns/${c.jobId}\\.md`));
  assert.match(job.items[0].prompt, /Never scrape, guess or buy addresses/);
  assert.equal(c.state, 'drafting');
  // Nothing happens before the plan is approved and the task finishes with outcome done.
  f.outreach.reconcile();
  assert.equal(f.pendingSend(), undefined);

  const d = f.draft(DRAFT(), { title: 'Second' });
  const view = d.campaign();
  assert.equal(view.state, 'awaiting_approval');
  assert.equal(view.draft?.draftedBy, 'Wren');
  assert.equal(view.draft?.subject, 'Hello {{name}} from Acme');
  // The proposed lead is stored unconfirmed and is never a recipient.
  const dee = f.outreach.state().leads.find((l) => l.email === 'dee@client.example')!;
  assert.equal(dee.status, 'proposed');
  assert.equal(dee.proposedBy, view.id);
  const item = f.pendingSend()!;
  assert.equal(item.raisedBy, 'marketing_sales');
  assert.equal(item.kind, 'external_action');
  const o = item.outreach!;
  assert.deepEqual(o.recipients, ['ann@client.example']);
  assert.deepEqual(o.excluded, { suppressed: 1, invalid: 0, unconfirmed: 0 });
  assert.equal(o.from, 'sales@acme.example');
  assert.equal(o.dailyCap, 200);
  assert.equal(o.samples.length, 1);
  assert.equal(o.samples[0].subject, 'Hello Ann Lee from Acme');
  assert.match(o.samples[0].text, /^Hi Ann Lee,\n\nA short note for Northwind\.\n\n--\nAcme Ltd, 1 Main Street, Springfield 12345, USA\nSent by sales@acme\.example\.\nReply STOP to stop receiving these emails\.\n$/);
  // The consultancy item is ready for review: its artifact was valid.
  assert.equal(f.office.snapshot().jobs.find((j) => j.id === d.jobId)!.items[0].status, 'awaiting_review');
});

test('a missing, invalid or symlinked artifact makes the item need attention with the reason; nothing is guessed', () => {
  const f = setup();
  f.outreach.importCsv(CSV, 'CEO');
  const missing = f.draft(DRAFT(), { title: 'Missing', write: false, workerBranch: 'office/a-1' });
  mkdirSync(path.join(f.dir, '.agent-office/worktrees/a-1'), { recursive: true });
  f.outreach.reconcile();
  assert.equal(missing.campaign().state, 'needs_attention');
  assert.match(missing.campaign().issue!, /missing/);
  const item = f.office.snapshot().jobs.find((j) => j.id === missing.jobId)!.items[0];
  assert.equal(item.status, 'needs_attention');
  assert.match(item.attention!, /missing — the worker did not write it/);

  const bad = f.draft('---\nsubject: Hi\naudience: [customers]\n---\nHello {{first_name}}', { title: 'Bad', workerBranch: 'office/b-1' });
  assert.equal(bad.campaign().state, 'needs_attention');
  assert.match(bad.campaign().issue!, /only \{\{name\}\} and \{\{company\}\}/);

  const link = f.draft(DRAFT(), { title: 'Link', write: false, workerBranch: 'office/c-1' });
  const outside = mkdtempSync(path.join(tmpdir(), 'empire-outside-'));
  writeFileSync(path.join(outside, 'x.md'), DRAFT());
  mkdirSync(path.join(f.dir, '.agent-office/worktrees/c-1/docs/empire/campaigns'), { recursive: true });
  symlinkSync(path.join(outside, 'x.md'), path.join(f.dir, '.agent-office/worktrees/c-1/docs/empire/campaigns', `${link.jobId}.md`));
  f.outreach.reconcile();
  assert.match(link.campaign().issue!, /symlink/);
  assert.equal(f.pendingSend(), undefined);

  // A retry that writes a valid draft clears the attention.
  Object.assign(bad.task, { status: 'queued', outcome: undefined });
  f.outreach.reconcile();
  assert.equal(bad.campaign().state, 'drafting');
  writeFileSync(path.join(f.dir, '.agent-office/worktrees/b-1/docs/empire/campaigns', `${bad.jobId}.md`), DRAFT());
  Object.assign(bad.task, { status: 'done', outcome: 'done', attempt: 2 });
  f.outreach.reconcile();
  assert.equal(bad.campaign().state, 'awaiting_approval');
});

test('the drafting task binding is persisted, so a draft is still imported from the committed branch after the queue forgets the task', () => {
  const f = setup();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  writeFileSync(path.join(f.dir, 'README.md'), 'x');
  git('add', 'README.md');
  git('commit', '-qm', 'init');
  f.outreach.importCsv(CSV, 'CEO');
  const c = f.outreach.createCampaign({ requestId: 'gone', title: 'Gone', brief: 'Brief' }, 'CEO');
  f.inbox.approve(f.inbox.state().items.find((i) => i.kind === 'job_plan')!.id, 'CEO');
  f.office.reconcile();
  const task = f.tasks.find((t) => t.jobKey === `consultancy:${c.jobId}:item-1`)!;
  Object.assign(task, { status: 'running', branch: 'office/wren-9', workerName: 'Wren' });
  f.outreach.reconcile();
  const saved = JSON.parse(readFileSync(path.join(f.dir, 'outreach.json'), 'utf8')).campaigns[0].task;
  assert.deepEqual(saved, { id: task.id, attempt: 1, branch: 'office/wren-9', workerName: 'Wren' });
  // The worker commits the draft on its branch and finishes; the task is seen done once, then cleared from the queue.
  git('checkout', '-qb', 'office/wren-9');
  mkdirSync(path.join(f.dir, 'docs/empire/campaigns'), { recursive: true });
  writeFileSync(path.join(f.dir, `docs/empire/campaigns/${c.jobId}.md`), DRAFT());
  git('add', 'docs');
  git('commit', '-qm', 'draft');
  git('checkout', '-q', 'main');
  Object.assign(task, { status: 'done', outcome: 'done' });
  f.office.reconcile();
  // The queue forgets the task before outreach reads the draft; the worktree folder never existed here.
  f.tasks.splice(f.tasks.indexOf(task), 1);
  f.outreach.reconcile();
  const view = f.outreach.state().campaigns[0];
  assert.equal(view.state, 'awaiting_approval', JSON.stringify(view));
  assert.equal(view.draft?.draftedBy, 'Wren');
});

test('validateDraft is strict about the campaign contract', () => {
  const check = (text: string) => { const p = parseArtifact(text); assert.ok(p.ok); return validateDraft(p.frontmatter, p.body); };
  assert.equal(check(DRAFT()).ok, true);
  for (const [text, reason] of [
    ['---\naudience: [all]\n---\nBody', /subject is required/],
    ['---\nsubject: Hi\n---\nBody', /audience is required/],
    ['---\nsubject: Hi\naudience: [all]\ncc: x@y.example\n---\nBody', /unknown frontmatter key "cc"/],
    ['---\nsubject: Hi\naudience: [all]\n---\n', /body is empty/],
    ['---\nsubject: Hi\naudience: [all]\n---\n<p>Hello</p>', /plain text/],
    ['---\nsubject: Hi {{email}}\naudience: [all]\n---\nBody', /only \{\{name\}\}/],
    ['---\nsubject: Hi\naudience: [all]\n---\nBody {{name}', /unmatched/],
    ['---\nsubject: Hi\naudience: [all]\nproposedLeads:\n  - Only | two\n---\nBody', /must be "Name \| email/],
    ['---\nsubject: Hi\naudience: [all]\nproposedLeads:\n  - A | a@b.example | C | | basis\n---\nBody', /source is required/],
  ] as const) {
    const r = check(text);
    assert.equal(r.ok, false, text);
    assert.match((r as { reason: string }).reason, reason);
  }
});

test('approving sends exactly the frozen snapshot, one message per recipient, with the footer always present', async () => {
  const f = setup();
  f.outreach.importCsv(CSV, 'CEO');
  const d = f.draft(DRAFT().replace('[customers]', '[all]').replace('A short note', 'A short note.\n--\nFake footer by the worker'));
  const item = f.pendingSend()!;
  assert.deepEqual(item.outreach!.recipients, ['ann@client.example', 'bob@client.example', 'cid@client.example']);
  // Approving with a budget is refused: no budget applies to a send.
  assert.throws(() => f.inbox.approve(item.id, 'CEO', { budgetUsd: 5 }), /No budget applies/);
  f.inbox.approve(item.id, 'CEO');
  assert.equal(d.campaign().state, 'sending');
  await f.advance(0);
  await f.advance(10_000);
  await f.advance(10_000);
  assert.deepEqual(f.sent.map((m) => m.to), ['ann@client.example', 'bob@client.example', 'cid@client.example']);
  // The first two are exactly the samples the CEO approved.
  for (const [i, m] of f.sent.slice(0, 2).entries()) {
    assert.equal(m.subject, item.outreach!.samples[i].subject);
    assert.equal(m.text, item.outreach!.samples[i].text);
  }
  for (const m of f.sent) {
    assert.equal(m.from, 'sales@acme.example');
    assert.ok(m.text.endsWith(`--\nAcme Ltd, 1 Main Street, Springfield 12345, USA\nSent by sales@acme.example.\n${STOP_LINE}\n`), m.text);
  }
  await f.advance(10_000);
  const view = d.campaign();
  assert.equal(view.state, 'completed');
  assert.deepEqual(view.counts, { recipients: 3, sent: 3, refused: 0, failed: 0, suppressed: 0, unknown: 0, inFlight: 0, pending: 0 });
  // Durable per-recipient results.
  const saved = JSON.parse(readFileSync(path.join(f.dir, 'outreach.json'), 'utf8'));
  assert.equal(saved.campaigns[0].sends['bob@client.example'].status, 'sent');
});

test('any change to what would be sent makes a new item; the old one can no longer be approved', () => {
  const f = setup();
  f.outreach.importCsv(CSV, 'CEO');
  const d = f.draft();
  const first = f.pendingSend()!;
  assert.deepEqual(first.outreach!.recipients, ['ann@client.example', 'bob@client.example']);
  // The CEO imports another customer before deciding.
  f.outreach.importCsv('name,email,company,source,basis,tags\nFay,fay@client.example,Zed,inbound,existing customer,customers', 'CEO');
  assert.throws(() => f.inbox.approve(first.id, 'CEO'), /out of date/);
  assert.equal(f.sent.length, 0);
  f.outreach.reconcile();
  assert.equal(f.inbox.get(first.id)!.status, 'resolved');
  const second = f.pendingSend()!;
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second.outreach!.recipients, ['ann@client.example', 'bob@client.example', 'fay@client.example']);
  assert.equal(d.campaign().approvalId, second.id);
  // Rejecting records the decision; nothing is sent.
  f.inbox.reject(second.id, 'CEO');
  assert.equal(d.campaign().state, 'rejected');
  assert.equal(f.inbox.get(second.id)!.status, 'rejected');
  assert.equal(f.sent.length, 0);
});

test('review fix 1: a snapshot that changes A→B→A raises a fresh pending item, and an unchanged campaign is not rewritten', () => {
  // The sender settings change and change back (the daily cap is part of the snapshot): A → B → A.
  const config = { ...CONFIG };
  const f = setup({ config });
  f.outreach.importCsv(CSV, 'CEO');
  const d = f.draft();
  const a = f.pendingSend()!;
  config.dailyCap = 100;
  f.outreach.reconcile();
  const b = f.pendingSend()!;
  assert.notEqual(b.id, a.id);
  assert.equal(f.inbox.get(a.id)!.status, 'resolved');
  // Back to A's snapshot: A is resolved, so a new pending item must stand in for it.
  config.dailyCap = 200;
  f.outreach.reconcile();
  const again = f.pendingSend();
  assert.ok(again, 'the inbox must hold a pending send');
  assert.ok(![a.id, b.id].includes(again!.id));
  assert.equal(again!.outreach!.snapshotHash, a.outreach!.snapshotHash);
  assert.equal(d.campaign().state, 'awaiting_approval');
  assert.equal(d.campaign().approvalId, again!.id);
  const file = path.join(f.dir, 'outreach.json');
  const before = readFileSync(file, 'utf8');
  f.outreach.reconcile();
  f.outreach.reconcile();
  assert.equal(readFileSync(file, 'utf8'), before, 'nothing changed, so outreach.json is not rewritten');
  f.inbox.approve(again!.id, 'CEO');
  assert.equal(d.campaign().state, 'sending');
});

test('review fix (lower): the approval decision is durable before the campaign starts sending', () => {
  const f = setup();
  f.outreach.importCsv(CSV, 'CEO');
  const d = f.draft();
  const item = f.pendingSend()!;
  let recordedWhenStarted: string | undefined;
  const original = f.outreach.apply.bind(f.outreach);
  f.outreach.apply = (i, decision, actor) => {
    recordedWhenStarted = JSON.parse(readFileSync(path.join(f.dir, 'approvals.json'), 'utf8')).items.find((x: { id: string }) => x.id === i.id).status;
    original(i, decision, actor);
  };
  f.inbox.approve(item.id, 'CEO');
  assert.equal(recordedWhenStarted, 'approved');
  assert.equal(d.campaign().state, 'sending');
});

test('review fix 2: a 5xx at the end of DATA is a message problem — the campaign pauses and nobody is suppressed', async () => {
  const f = setup({ behave: () => { throw new SmtpError('SMTP server answered 552 to end of DATA'); } });
  f.outreach.importCsv(CSV, 'CEO');
  const d = f.draft();
  f.inbox.approve(f.pendingSend()!.id, 'CEO');
  for (let i = 0; i < 4; i++) await f.advance(10_000);
  const view = d.campaign();
  assert.equal(view.state, 'paused');
  assert.match(view.note!, /refused the message itself \(552 at end of DATA\)/);
  assert.deepEqual(f.outreach.state().suppression, []);
  assert.equal(view.counts!.pending, 2, 'the refused message was not accepted, so its recipient is still pending');
  assert.equal(f.outreach.status().sentToday, 0);
});

test('review fix 2: three RCPT refusals in a row pause the campaign, revert them to pending and suppress nobody', async () => {
  const f = setup({ behave: () => { throw new SmtpError('SMTP server answered 550 to RCPT TO'); } });
  f.outreach.importCsv(`${CSV}Dee,dee@client.example,Orbit,inbound,consent,customers\n`, 'CEO');
  const d = f.draft(DRAFT().replace('[customers]', '[all]'));
  f.inbox.approve(f.pendingSend()!.id, 'CEO');
  for (let i = 0; i < 8; i++) await f.advance(10_000);
  const view = d.campaign();
  assert.equal(view.state, 'paused');
  assert.match(view.note!, /3 refusals in a row/);
  assert.deepEqual(f.outreach.state().suppression, []);
  assert.equal(view.counts!.pending, 4);
  assert.equal(view.counts!.refused, 0);
  // Resuming needs the CEO, and retries them.
  f.box.behave = () => undefined;
  f.outreach.resume(view.id, 'CEO');
  for (let i = 0; i < 5; i++) await f.advance(10_000);
  assert.equal(d.campaign().counts!.sent, 4);
});

test('re-review 1: three 554 refusals pause the campaign and put all three back to pending, refunding the day count', async () => {
  const f = setup({ behave: () => { throw new SmtpError('SMTP server answered 554 to RCPT TO'); } });
  f.outreach.importCsv(CSV, 'CEO');
  const d = f.draft(DRAFT().replace('[customers]', '[all]'));
  f.inbox.approve(f.pendingSend()!.id, 'CEO');
  for (let i = 0; i < 6; i++) await f.advance(10_000);
  const view = d.campaign();
  assert.equal(view.state, 'paused');
  assert.deepEqual([view.counts!.pending, view.counts!.refused], [3, 0]);
  assert.equal(f.outreach.status().sentToday, 0);
  assert.deepEqual(f.outreach.state().suppression, []);
});

test('re-review 2: a 550 with enhanced status 5.7.x (policy) never suppresses; 5.1.1 does', async () => {
  const policy = Object.assign(new SmtpError('SMTP server answered 550 to RCPT TO'), { enhanced: '5.7.1' });
  const unknown = Object.assign(new SmtpError('SMTP server answered 550 to RCPT TO'), { enhanced: '5.1.1' });
  const f = setup({ behave: (m) => { if (m.to === 'ann@client.example') throw policy; if (m.to === 'bob@client.example') throw unknown; } });
  f.outreach.importCsv(CSV, 'CEO');
  f.draft(DRAFT().replace('[customers]', '[all]'));
  f.inbox.approve(f.pendingSend()!.id, 'CEO');
  for (let i = 0; i < 4; i++) await f.advance(10_000);
  assert.deepEqual(f.sent.map((m) => m.to), ['cid@client.example']);
  assert.deepEqual(f.outreach.state().suppression.map((s) => s.email), ['bob@client.example']);
});

test('re-review minor: a stored tool_proposal without valid tool fields is refused on restore', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-approvals-tool-'));
  const item = { id: 'A1', kind: 'tool_proposal', raisedBy: 'research', source: 'tool:x', jobId: 'consultancy-0123456789ab', title: 't', detail: 'd', createdAt: 1, status: 'pending' };
  writeFileSync(path.join(dir, 'approvals.json'), JSON.stringify({ version: 1, revision: 1, nextSeq: 2, items: [{ ...item, tool: { name: 'X', url: 'javascript:alert(1)', licence: 'MIT', enables: 'e', risk: 'r' } }] }));
  const office = new Consultancy(dir, { state: () => ({ tasks: [], maxWorkers: 0 }), add: () => undefined });
  assert.match(new ApprovalInbox(dir, office).recoveryError ?? '', /tool is invalid/);
  writeFileSync(path.join(dir, 'approvals.json'), JSON.stringify({ version: 1, revision: 1, nextSeq: 2, items: [{ ...item, tool: { name: 'X', url: 'https://x.example', licence: 'MIT', enables: 'e', risk: 'r' } }] }));
  assert.equal(new ApprovalInbox(dir, office).recoveryError, undefined);
});

test('review fix 2: a 554 (policy) RCPT refusal never suppresses; a 550 suppresses only once a later send succeeds', async () => {
  const f = setup({ behave: (m) => {
    if (m.to === 'ann@client.example') throw new SmtpError('SMTP server answered 554 to RCPT TO');
    if (m.to === 'bob@client.example') throw new SmtpError('SMTP server answered 550 to RCPT TO');
  } });
  f.outreach.importCsv(CSV, 'CEO');
  f.draft(DRAFT().replace('[customers]', '[all]'));
  f.inbox.approve(f.pendingSend()!.id, 'CEO');
  await f.advance(0);
  await f.advance(10_000);
  assert.deepEqual(f.outreach.state().suppression, [], 'not yet: two refusals could be a server problem');
  await f.advance(10_000);
  assert.deepEqual(f.sent.map((m) => m.to), ['cid@client.example']);
  assert.deepEqual(f.outreach.state().suppression.map((s) => [s.email, s.reason]), [['bob@client.example', 'bounce']]);
  // The bounce is recorded with its result, so a restart repairs a suppression list that missed it.
  writeFileSync(path.join(f.dir, 'leads.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(f.dir, 'leads.json'), 'utf8')), suppression: [] }));
  const o = f.restart();
  assert.equal(o.isSuppressed('bob@client.example'), true);
  assert.equal(o.isSuppressed('ann@client.example'), false);
});

test('review fixes: long lines are refused, non-ASCII bodies go out quoted-printable, encoded words are neutralised, addresses normalised', () => {
  const p = parseArtifact(`---\nsubject: Hi\naudience: [all]\n---\n${'é'.repeat(460)}`);
  assert.ok(p.ok);
  const long = validateDraft(p.frontmatter, p.body);
  assert.equal(long.ok, false);
  assert.match((long as { reason: string }).reason, /line 1 is longer than 900 bytes/);
  const enc = parseArtifact('---\nsubject: Hi =?utf-8?B?SGk=?=\naudience: [all]\n---\nBody');
  assert.ok(enc.ok);
  assert.match((validateDraft(enc.frontmatter, enc.body) as { reason: string }).reason, /encoded word/);
  const m = renderOutreach({ subject: 'Hi {{name}}', body: 'Grüße, {{name}}', footer: `--\nAcme\n${STOP_LINE}`, from: 'sales@acme.example' }, { email: 'ann@client.example', name: '=?utf-8?B?Rm9v?=', company: 'X' });
  assert.ok(!m.subject.includes('=?'), m.subject);
  const raw = renderMessage(m);
  assert.match(raw, /Content-Transfer-Encoding: quoted-printable/);
  assert.match(raw, /Gr=C3=BC=C3=9Fe/);
  assert.ok(raw.split('\r\n').every((line) => line.length <= 998));
  // Addresses: trimmed, NFC and lowercase; C0 controls refused; plus-addressing is a distinct address.
  const f = setup();
  const r = f.outreach.importCsv('name,email,company,source,basis\nA,"  Ann@Client.EXAMPLE ",X,s,b\nB,"bad\u0001@client.example",X,s,b\nC,ann+news@client.example,X,s,b', 'CEO');
  assert.deepEqual([r.added, r.errors.length], [2, 1]);
  assert.deepEqual(f.outreach.state().leads.map((l) => l.email), ['ann@client.example', 'ann+news@client.example']);
  assert.throws(() => f.outreach.suppress('x\u0007@client.example', 'opt_out', 'CEO'), /valid email/);
});

test('suppression always wins: before the snapshot, at send time, and after a 5xx refusal (bounce)', async () => {
  const f = setup({ behave: (m) => { if (m.to === 'ann@client.example') throw new SmtpError('SMTP server answered 550 to RCPT TO'); } });
  f.outreach.importCsv(CSV, 'CEO');
  f.draft(DRAFT().replace('[customers]', '[all]'));
  const item = f.pendingSend()!;
  f.inbox.approve(item.id, 'CEO');
  // Bob opts out after approval, before his turn.
  f.outreach.suppress('BOB@client.example', 'opt_out', 'CEO');
  await f.advance(0);
  for (let i = 0; i < 4; i++) await f.advance(10_000);
  assert.deepEqual(f.sent.map((m) => m.to), ['cid@client.example']);
  const view = f.outreach.state().campaigns[0];
  assert.equal(view.counts!.refused, 1);
  assert.equal(view.counts!.suppressed, 1);
  const supp = f.outreach.state().suppression;
  assert.deepEqual(supp.map((s) => [s.email, s.reason]), [['bob@client.example', 'opt_out'], ['ann@client.example', 'bounce']]);
  // A later campaign excludes both.
  f.draft(DRAFT().replace('[customers]', '[all]'), { title: 'Later', workerBranch: 'office/wren-2' });
  const later = f.pendingSend()!;
  assert.deepEqual(later.outreach!.recipients, ['cid@client.example']);
  assert.equal(later.outreach!.excluded.suppressed, 2);
});

test('rate limit (one per interval) and the daily cap (resumes the next UTC day)', async () => {
  const f = setup({ config: { ...CONFIG, dailyCap: 2 } });
  f.outreach.importCsv(CSV, 'CEO');
  f.draft(DRAFT().replace('[customers]', '[all]'));
  f.inbox.approve(f.pendingSend()!.id, 'CEO');
  await f.advance(0);
  assert.equal(f.sent.length, 1);
  await f.advance(9_000);
  assert.equal(f.sent.length, 1, 'never faster than the interval');
  await f.advance(1_000);
  assert.equal(f.sent.length, 2);
  await f.advance(60_000);
  assert.equal(f.sent.length, 2, 'daily cap');
  assert.match(f.outreach.state().campaigns[0].note!, /Daily cap of 2 reached/);
  assert.equal(f.outreach.status().sentToday, 2);
  await f.advance(15 * 3_600_000);
  assert.equal(f.sent.length, 3, 'resumes on the next UTC day');
  assert.equal(f.outreach.status().sentToday, 1);
});

test('a restart never sends anyone twice: sent stays sent, in-flight becomes unknown and is not re-sent', async () => {
  let hang = true;
  const f = setup({ behave: async (m) => { if (hang && m.to === 'bob@client.example') await new Promise(() => undefined); } });
  f.outreach.importCsv(CSV, 'CEO');
  f.draft(DRAFT().replace('[customers]', '[all]'));
  f.inbox.approve(f.pendingSend()!.id, 'CEO');
  await f.advance(0);
  await f.advance(10_000);
  assert.deepEqual(f.sent.map((m) => m.to), ['ann@client.example']);
  // Bob's send is in flight (recorded before sending) when the server stops.
  const saved = JSON.parse(readFileSync(path.join(f.dir, 'outreach.json'), 'utf8'));
  assert.equal(saved.campaigns[0].sends['bob@client.example'].status, 'in_flight');
  hang = false;
  const o = f.restart();
  const view = o.state().campaigns[0];
  assert.equal(view.results!.find((r) => r.email === 'bob@client.example')!.status, 'unknown');
  assert.match(view.results!.find((r) => r.email === 'bob@client.example')!.detail!, /check before resending/);
  o.reconcile();
  await f.advance(10_000);
  await f.advance(10_000);
  await f.advance(10_000);
  assert.deepEqual(f.sent.map((m) => m.to), ['ann@client.example', 'cid@client.example']);
  assert.deepEqual(o.state().campaigns[0].counts, { recipients: 3, sent: 2, refused: 0, failed: 0, suppressed: 0, unknown: 1, inFlight: 0, pending: 0 });
});

test('an uncertain SMTP result is unknown (never re-sent); definite transient failures retry, then fail; sign-in failure pauses', async () => {
  const seen: string[] = [];
  const f = setup({ behave: (m) => {
    seen.push(m.to);
    if (m.to === 'ann@client.example') { const e = new SmtpError('SMTP timed out'); e.uncertain = true; throw e; }
    if (m.to === 'bob@client.example') throw new SmtpError('SMTP connection failed (ECONNREFUSED)');
  } });
  f.outreach.importCsv(CSV, 'CEO');
  f.draft(DRAFT());
  f.inbox.approve(f.pendingSend()!.id, 'CEO');
  for (let i = 0; i < 6; i++) await f.advance(10_000);
  assert.deepEqual(seen, ['ann@client.example', 'bob@client.example', 'bob@client.example', 'bob@client.example']);
  const view = f.outreach.state().campaigns[0];
  assert.equal(view.counts!.unknown, 1);
  assert.equal(view.counts!.failed, 1);
  assert.equal(view.state, 'completed');

  const g = setup({ behave: () => { throw new SmtpError('SMTP server answered 535 to AUTH PLAIN'); } });
  g.outreach.importCsv(CSV, 'CEO');
  g.draft(DRAFT());
  g.inbox.approve(g.pendingSend()!.id, 'CEO');
  await g.advance(0);
  const paused = g.outreach.state().campaigns[0];
  assert.equal(paused.state, 'paused');
  assert.match(paused.note!, /Sign-in to the SMTP server failed/);
  assert.equal(paused.counts!.pending, 2, 'a definite sign-in failure sent nothing, so nobody is marked');
  assert.equal(g.outreach.status().sentToday, 0);
});

test('pause and cancel: a paused campaign sends nothing until resumed; a cancelled one never sends again', async () => {
  const f = setup();
  f.outreach.importCsv(CSV, 'CEO');
  const d = f.draft(DRAFT().replace('[customers]', '[all]'));
  f.inbox.approve(f.pendingSend()!.id, 'CEO');
  await f.advance(0);
  const id = d.campaign().id;
  f.outreach.pause(id, 'CEO');
  await f.advance(60_000);
  assert.equal(f.sent.length, 1);
  f.outreach.resume(id, 'CEO');
  await f.advance(0);
  assert.equal(f.sent.length, 2);
  f.outreach.cancel(id, 'CEO');
  await f.advance(120_000);
  assert.equal(f.sent.length, 2);
  assert.equal(d.campaign().state, 'cancelled');
  assert.equal(d.campaign().counts!.pending, 1);
  assert.throws(() => f.outreach.resume(id, 'CEO'), /Only a paused campaign/);
});

test('merge fields cannot inject headers: names and companies lose CR/LF, and each message has one recipient', () => {
  const snapshot = { subject: 'Hi {{name}} at {{company}}', body: 'Dear {{name}}', footer: `--\nAcme\n${STOP_LINE}`, from: 'sales@acme.example' };
  const m = renderOutreach(snapshot, { email: 'ann@client.example', name: 'Ann\r\nBcc: victim@evil.example', company: 'X\nTo: other@evil.example' });
  assert.equal(m.subject, 'Hi Ann Bcc: victim@evil.example at X To: other@evil.example');
  assert.equal(m.to, 'ann@client.example');
  const raw = renderMessage(m);
  const headers = raw.split('\r\n\r\n')[0].split('\r\n');
  assert.equal(headers.filter((h) => /^Bcc:/i.test(h)).length, 0);
  assert.deepEqual(headers.filter((h) => /^To:/i.test(h)), ['To: <ann@client.example>']);
  assert.equal(headers.filter((h) => /^Subject:/.test(h)).length, 1);
  // Body merge values are single-line too.
  assert.equal(m.text.split('\n')[0], 'Dear Ann Bcc: victim@evil.example');
  // A display name for the sender cannot break out of its phrase.
  const named = renderMessage({ ...m, fromName: 'Acme "Sales"\r\nBcc: x@evil.example <a>' });
  assert.match(named, /^From: "Acme Sales Bcc: x@evil\.example a" <sales@acme\.example>\r\n/);
});

test('sending is disabled (and says why) without the sender address, postal address or SMTP; no approval is raised', () => {
  const cfg = outreachConfig({ AGENT_EMPIRE_SMTP_URL: 'smtps://u:secret@mail.example:465' });
  assert.deepEqual(cfg.problems, ['Set AGENT_EMPIRE_OUTREACH_FROM to the sender address.', 'Set AGENT_EMPIRE_OUTREACH_ADDRESS to your sender identity and postal address (it is printed in every email).']);
  assert.ok(!JSON.stringify(cfg.problems).includes('secret'));
  const ok = outreachConfig({ AGENT_EMPIRE_SMTP_URL: 'smtps://u:p@mail.example', AGENT_EMPIRE_OUTREACH_FROM: 'sales@acme.example', AGENT_EMPIRE_OUTREACH_ADDRESS: 'Acme, 1 Main St', AGENT_EMPIRE_OUTREACH_DAILY_CAP: '50' });
  assert.deepEqual([ok.problems, ok.dailyCap, ok.intervalMs], [[], 50, 10_000]);
  assert.match(outreachConfig({ AGENT_EMPIRE_OUTREACH_DAILY_CAP: 'lots' }).problems.join(' '), /DAILY_CAP/);
  const f = setup({ config: cfg, noTransport: true });
  f.outreach.importCsv(CSV, 'CEO');
  const d = f.draft();
  assert.equal(d.campaign().state, 'ready');
  assert.match(d.campaign().note!, /Sending is disabled: Set AGENT_EMPIRE_OUTREACH_FROM/);
  assert.equal(f.pendingSend(), undefined);
  assert.match(f.outreach.status().label, /^Outreach sending: disabled — Set AGENT_EMPIRE_OUTREACH_FROM/);
});

test('proposed leads stay unconfirmed until the CEO accepts them; a declined one is dropped', () => {
  const f = setup();
  f.outreach.importCsv(CSV, 'CEO');
  f.draft(DRAFT().replace('[customers]', '[all]'));
  const first = f.pendingSend()!;
  assert.equal(first.outreach!.excluded.unconfirmed, 1);
  assert.ok(!first.outreach!.recipients.includes('dee@client.example'));
  const dee = f.outreach.state().leads.find((l) => l.email === 'dee@client.example')!;
  f.outreach.acceptLead(dee.id, 'CEO');
  f.outreach.reconcile();
  assert.ok(f.pendingSend()!.outreach!.recipients.includes('dee@client.example'));
  assert.throws(() => f.outreach.rejectLead('L1'), /Only proposed leads/);
});

test('Telegram: /optout adds a suppression; /approve A# approves a campaign send; a budget is refused', async () => {
  const f = setup();
  f.outreach.importCsv(CSV, 'CEO');
  f.draft();
  const item = f.pendingSend()!;
  const bot = chiefCommands(f.office, () => 'ok', f.inbox, undefined, undefined, f.outreach);
  assert.match(bot.execute('/optout Cid@Client.example', 'tg-1'), /cid@client\.example is on the suppression list \(opt-out\)/);
  assert.match(bot.execute('/optout not-an-address', 'tg-2'), /valid email address/);
  assert.match(bot.execute('/optout', 'tg-3'), /Use \/optout name@example\.com/);
  assert.equal(f.outreach.isSuppressed('cid@client.example'), true);
  assert.match(bot.execute(`/approve ${item.id} 25`, 'tg-4'), /No budget applies/);
  assert.match(bot.execute(`/approve ${item.id.toLowerCase()}`, 'tg-5'), new RegExp(`${item.id} approved\\. Sending starts now`));
  await f.advance(0);
  assert.equal(f.sent.length, 1);
  assert.match(bot.execute(`/approve ${item.id}`, 'tg-6'), /already approved/);
  // Notifications announce the send without the recipient list.
  assert.match(bot.execute('/help', 'tg-7'), /optout/);
});
