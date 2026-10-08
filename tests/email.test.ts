import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EmailNotifier, approvalEmail, emailConfig, isLoopbackHost, renderMessage, smtpTransport, type MailMessage, type MailTransport } from '../src/server/email.js';
import type { Approval } from '../src/shared/approvals.js';

const SECRET = 'hunter2-not-real';

test('email config is off when unset, needs both variables, and never echoes the URL or password', () => {
  assert.equal(emailConfig({}), undefined);
  const url = `smtps://ceo%40example.com:${SECRET}@mail.example.com`;
  for (const env of [{ AGENT_EMPIRE_SMTP_URL: url }, { AGENT_EMPIRE_NOTIFY_EMAIL: 'ceo@example.com' }, { AGENT_EMPIRE_SMTP_URL: `http://u:${SECRET}@x`, AGENT_EMPIRE_NOTIFY_EMAIL: 'ceo@example.com' }, { AGENT_EMPIRE_SMTP_URL: url, AGENT_EMPIRE_NOTIFY_EMAIL: 'not an address' }, { AGENT_EMPIRE_SMTP_URL: `smtps://u:${SECRET}@`, AGENT_EMPIRE_NOTIFY_EMAIL: 'ceo@example.com' }]) {
    assert.throws(() => emailConfig(env), (e: Error) => !e.message.includes(SECRET) && !e.message.includes('mail.example.com') && /AGENT_EMPIRE_/.test(e.message));
  }
  const ok = emailConfig({ AGENT_EMPIRE_SMTP_URL: url, AGENT_EMPIRE_NOTIFY_EMAIL: 'ceo@example.com' })!;
  assert.deepEqual(ok.smtp, { secure: true, host: 'mail.example.com', port: 465, user: 'ceo@example.com', pass: SECRET });
  assert.equal(ok.to, 'ceo@example.com');
  assert.equal(ok.from, 'ceo@example.com');
  assert.equal(emailConfig({ AGENT_EMPIRE_SMTP_URL: 'smtp://relay.example.com', AGENT_EMPIRE_NOTIFY_EMAIL: 'ceo@example.com' })!.smtp.port, 587);
  assert.ok(isLoopbackHost('127.0.0.1') && isLoopbackHost('localhost') && isLoopbackHost('::1'));
  assert.ok(!isLoopbackHost('mail.example.com'));
});

interface FakeSmtp { port: number; transcript: string[]; data: string[]; close(): Promise<void> }
/** A scripted local SMTP server (no real network): EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT. */
async function fakeSmtp(opts: { auth?: 'PLAIN' | 'LOGIN' | 'both'; failMail?: boolean; silent?: boolean; starttls?: boolean; injectAfterStarttls?: boolean } = {}): Promise<FakeSmtp> {
  const transcript: string[] = [];
  const data: string[] = [];
  const server = net.createServer((socket) => {
    if (opts.silent) return; // accepts, never greets
    let buffer = '';
    let inData = false;
    let login: 'user' | 'pass' | undefined;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 fake.local ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data.push(buffer.slice(0, end + 2));
          buffer = buffer.slice(end + 5);
          inData = false;
          reply('250 queued');
          continue;
        }
        const i = buffer.indexOf('\r\n');
        if (i < 0) return;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        transcript.push(line);
        if (login === 'user') { login = 'pass'; reply('334 UGFzc3dvcmQ6'); continue; }
        if (login === 'pass') { login = undefined; reply(Buffer.from(line, 'base64').toString() === SECRET ? '235 ok' : '535 bad'); continue; }
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') {
          const mechs = opts.auth === 'LOGIN' ? 'LOGIN' : opts.auth === 'PLAIN' ? 'PLAIN' : 'PLAIN LOGIN';
          socket.write(`250-fake.local\r\n${opts.starttls ? '250-STARTTLS\r\n' : ''}250-AUTH ${mechs}\r\n250 8BITMIME\r\n`);
        } else if (verb === 'AUTH' && line.split(' ')[1] === 'PLAIN') reply(Buffer.from(line.split(' ')[2], 'base64').toString() === `\0ceo@example.com\0${SECRET}` ? '235 ok' : '535 bad');
        else if (verb === 'AUTH' && line.split(' ')[1] === 'LOGIN') { login = 'user'; reply('334 VXNlcm5hbWU6'); }
        else if (verb === 'MAIL') reply(opts.failMail ? '451 try later' : '250 ok');
        else if (verb === 'RCPT') reply('250 ok');
        else if (verb === 'DATA') { inData = true; reply('354 go'); }
        else if (verb === 'STARTTLS' && opts.injectAfterStarttls) socket.write('220 go ahead\r\n250 injected before TLS\r\n');
        else if (verb === 'QUIT') { reply('221 bye'); socket.end(); }
        else reply('502 unknown');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as net.AddressInfo).port, transcript, data, close: () => new Promise((r) => server.close(() => r())) };
}

const message: MailMessage = { from: 'empire@example.com', to: 'ceo@example.com', subject: 'Approval A1: Client plan', text: 'Line one\n.hidden line starts with a dot\n..two dots\nlast' };

test('the SMTP client speaks EHLO, AUTH PLAIN, MAIL, RCPT and DATA with dot-stuffing', async (t) => {
  const s = await fakeSmtp({ auth: 'both' });
  t.after(() => s.close());
  await smtpTransport({ secure: false, host: '127.0.0.1', port: s.port, user: 'ceo@example.com', pass: SECRET }, { timeoutMs: 2000 }).send(message);
  assert.match(s.transcript[0], /^EHLO /);
  assert.match(s.transcript[1], /^AUTH PLAIN /);
  assert.ok(s.transcript.includes('MAIL FROM:<empire@example.com>'));
  assert.ok(s.transcript.includes('RCPT TO:<ceo@example.com>'));
  assert.ok(s.transcript.includes('DATA'));
  assert.equal(s.transcript.at(-1), 'QUIT');
  const [body] = s.data;
  assert.match(body, /^From: Agent Empire <empire@example\.com>\r\n/m);
  assert.match(body, /^Subject: Approval A1: Client plan\r\n/m);
  assert.match(body, /^Content-Type: text\/plain; charset=utf-8\r\n/m);
  assert.match(body, /\r\n\.\.hidden line starts with a dot\r\n/, 'a leading dot is doubled');
  assert.match(body, /\r\n\.\.\.two dots\r\n/);
  assert.doesNotMatch(body, /[^\r]\n/, 'every line ends in CRLF');
});

test('AUTH LOGIN is used when it is the only mechanism', async (t) => {
  const s = await fakeSmtp({ auth: 'LOGIN' });
  t.after(() => s.close());
  await smtpTransport({ secure: false, host: '127.0.0.1', port: s.port, user: 'ceo@example.com', pass: SECRET }, { timeoutMs: 2000 }).send(message);
  assert.equal(s.transcript[1], 'AUTH LOGIN');
  assert.equal(Buffer.from(s.transcript[2], 'base64').toString(), 'ceo@example.com');
  assert.equal(s.data.length, 1);
});

test('SMTP failures and timeouts reject with messages that carry no credentials', async (t) => {
  const refusing = await fakeSmtp({ failMail: true });
  const silent = await fakeSmtp({ silent: true });
  t.after(async () => { await refusing.close(); await silent.close(); });
  const cfg = { secure: false, host: '127.0.0.1', user: 'ceo@example.com', pass: SECRET };
  await assert.rejects(smtpTransport({ ...cfg, port: refusing.port }, { timeoutMs: 2000 }).send(message), (e: Error) => /451/.test(e.message) && !e.message.includes(SECRET));
  const started = Date.now();
  await assert.rejects(smtpTransport({ ...cfg, port: silent.port }, { timeoutMs: 200 }).send(message), (e: Error) => /timed out/i.test(e.message));
  assert.ok(Date.now() - started < 2000);
  // A server that offers no STARTTLS never gets credentials in clear unless it is this machine.
  const before = refusing.transcript.length;
  const plain = smtpTransport({ ...cfg, host: 'mail.invalid', port: 25 }, { timeoutMs: 2000, connect: () => net.connect({ host: '127.0.0.1', port: refusing.port }) });
  await assert.rejects(plain.send(message), (e: Error) => /STARTTLS/.test(e.message) && !e.message.includes(SECRET));
  assert.ok(!refusing.transcript.slice(before).some((l) => l.startsWith('AUTH')), 'no AUTH was sent');
});

const item = (over: Partial<Approval> = {}): Approval => ({ id: 'A1', kind: 'job_plan', raisedBy: 'chief_of_staff', title: 'Acme · Portal', detail: 'Acme · 1 item · estimate $0.50–$3.00', jobId: 'consultancy-x', createdAt: 1, status: 'pending', estimate: { costUsd: { low: 0.5, high: 3 } }, ...over });

test('an approval email is plain text with title, kind, money and where to approve; no links or secrets', () => {
  const plan = approvalEmail(item(), { to: 'ceo@example.com', from: 'empire@example.com' });
  assert.match(plan.subject, /A1/);
  assert.match(plan.subject, /Client plan/);
  assert.match(plan.text, /Acme · Portal/);
  assert.match(plan.text, /\$0\.50–\$3\.00/);
  assert.match(plan.text, /Approve in the game, on the founder desk, or with \/approve A1 in Telegram\./);
  assert.doesNotMatch(plan.text, /https?:|\/api\//);
  const budget = approvalEmail(item({ id: 'A2', kind: 'budget_increase', raisedBy: 'finance', spentUsd: 3.2, approvedBudgetUsd: 3, suggestedBudgetUsd: 8 }), { to: 'a@b.c', from: 'a@b.c' });
  assert.match(budget.subject, /Budget increase/);
  assert.match(budget.text, /\$3\.20/);
});

function notifierFixture(t: { after(fn: () => void): void }, transport: MailTransport) {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-email-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logs: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const make = () => new EmailNotifier(dir, transport, { to: 'ceo@example.com', from: 'empire@example.com' }, {
    log: (line) => logs.push(line), schedule: (fn, ms) => { timers.push({ fn, ms }); return () => undefined; },
  });
  return { dir, logs, timers, make };
}

test('one email per new pending item; the first look is a silent baseline and restarts remember', async (t) => {
  const sent: MailMessage[] = [];
  const f = notifierFixture(t, { async send(m) { sent.push(m); } });
  const n = f.make();
  assert.equal(n.status().label, 'Email: configured');
  n.observe([item({ id: 'A1' })]);
  await n.idle();
  assert.equal(sent.length, 0, 'what was pending before is not mailed');
  n.observe([item({ id: 'A1' }), item({ id: 'A2' })]);
  n.observe([item({ id: 'A1' }), item({ id: 'A2' })]);
  await n.idle();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /A2/);
  n.observe([item({ id: 'A2', status: 'approved' })]);
  await n.idle();
  const again = f.make();
  again.observe([item({ id: 'A2' })]);
  await again.idle();
  assert.equal(sent.length, 1, 'never mailed twice, even after a restart');
});

test('a failed send is logged without secrets, retried with backoff, and shown in the status', async (t) => {
  let fail = true;
  const sent: MailMessage[] = [];
  const f = notifierFixture(t, { async send(m) { if (fail) throw new Error('SMTP server answered 451'); sent.push(m); } });
  const n = f.make();
  n.observe([]);
  n.observe([item({ id: 'A3' })]);
  await n.idle();
  assert.equal(sent.length, 0);
  assert.equal(n.status().state, 'failed');
  assert.equal(n.status().label, 'Email: last send failed');
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /A3/);
  assert.ok(f.logs.every((l) => !l.includes(SECRET) && !/smtps?:\/\//.test(l)));
  assert.equal(f.timers.length, 1);
  const first = f.timers[0].ms;
  f.timers.shift()!.fn();
  await n.idle();
  assert.ok(f.timers[0].ms > first, `backoff grows: ${first} then ${f.timers[0].ms}`);
  fail = false;
  f.timers.shift()!.fn();
  await n.idle();
  assert.equal(sent.length, 1);
  assert.equal(n.status().state, 'configured');
  // A decided item is not retried.
  fail = true;
  n.observe([item({ id: 'A4' })]);
  await n.idle();
  n.observe([item({ id: 'A4', status: 'rejected' })]);
  fail = false;
  f.timers.shift()!.fn();
  await n.idle();
  assert.equal(sent.length, 1);
});

test('review fix 3: a reply pipelined after the STARTTLS 220 is refused, never read as a TLS reply', async (t) => {
  const s = await fakeSmtp({ starttls: true, injectAfterStarttls: true });
  t.after(() => s.close());
  const before = s.transcript.length;
  await assert.rejects(
    smtpTransport({ secure: false, host: '127.0.0.1', port: s.port, user: 'ceo@example.com', pass: SECRET }, { timeoutMs: 2000 }).send(message),
    (e: Error) => /after STARTTLS/.test(e.message) && !e.message.includes(SECRET),
  );
  assert.ok(!s.transcript.slice(before).some((l) => l.startsWith('AUTH')), 'no credentials were sent');
});

test('review: a subject with CR/LF stays one header line', () => {
  const text = renderMessage({ ...message, subject: 'Hello\r\nBcc: victim@example.com\nX-Evil: 1' });
  const headers = text.split('\r\n\r\n')[0].split('\r\n');
  assert.equal(headers.filter((h) => h.startsWith('Subject:')).length, 1);
  assert.ok(!headers.some((h) => /^Bcc:|^X-Evil:/.test(h)), headers.join(' | '));
});

test('review fix 4: a permanent 5xx or repeated failures give up on that item and move on', async (t) => {
  const sent: string[] = [];
  const f = notifierFixture(t, { async send(m) {
    if (m.subject.includes('approval A1:')) throw new Error('SMTP server answered 550 to RCPT TO');
    if (m.subject.includes('approval A2:')) throw new Error('SMTP connection failed (ECONNRESET)');
    sent.push(m.subject);
  } });
  const n = f.make();
  n.observe([]);
  n.observe([item({ id: 'A1' }), item({ id: 'A3' })]);
  await n.idle();
  assert.equal(sent.length, 1, 'the 5xx item was given up at once and the next one sent');
  assert.match(sent[0], /A3:/);
  assert.equal(n.status().state, 'failed');
  assert.equal(n.status().gaveUp, 1);
  // A transient failure is retried, then given up after 5 attempts.
  n.observe([item({ id: 'A2' }), item({ id: 'A4' })]);
  await n.idle();
  for (let i = 0; i < 4; i++) { f.timers.shift()!.fn(); await n.idle(); }
  assert.ok(sent.some((x) => /A4:/.test(x)), 'A4 is sent after A2 is given up');
  assert.equal(n.status().gaveUp, 2);
  assert.ok(f.logs.some((l) => /gave up/i.test(l) && /A2/.test(l)));
  const again = f.make();
  again.observe([item({ id: 'A1' }), item({ id: 'A2' })]);
  await again.idle();
  assert.equal(sent.length, 2, 'given-up items are not retried after a restart');
});
