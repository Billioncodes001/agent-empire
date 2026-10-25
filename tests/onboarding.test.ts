/**
 * FREE-08 onboarding, unit level: the resumable/skippable step model, secret sealing on disk, env-vs-saved precedence
 * for every channel and the budget, and the ntfy transport against a fake local server. No real network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ONBOARDING_STEPS, advance, dismiss, goTo, initialProgress, reopen, shouldOffer, validateNotifications, validateProfile } from '../src/shared/onboarding.js';
import { FileSecretStore } from '../src/server/secrets.js';
import { ntfyTransport, resolveBudget, resolveEmail, resolveNtfy, resolveTelegram, validNtfyServer } from '../src/server/notify.js';
import { DEFAULT_SETTINGS } from '../src/shared/onboarding.js';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const tmp = () => mkdtempSync(path.join(tmpdir(), 'empire-onboarding-'));

test('steps: resumable, skippable, finishing, dismissing and re-opening', () => {
  let p = initialProgress(false);
  assert.equal(p.status, 'not_started');
  assert.equal(p.current, 'profile');
  assert.equal(shouldOffer(p, false), false, 'never before founding');
  assert.equal(shouldOffer(p, true), true);
  p = advance(p, 'profile', 'done', 1);
  assert.equal(p.status, 'in_progress');
  assert.equal(p.current, 'engines');
  p = advance(p, 'engines', 'skipped', 2);
  assert.equal(p.steps.engines, 'skipped');
  assert.equal(p.current, 'notifications');
  assert.equal(shouldOffer(p, true), true, 'an unfinished setup is offered again (resumes where it stopped)');
  p = goTo(p, 'profile');
  assert.equal(p.current, 'profile');
  assert.equal(p.steps.profile, 'done', 'going back keeps what was done');
  p = advance(p, 'notifications', 'done', 3);
  p = advance(p, 'approvals', 'skipped', 4);
  assert.equal(p.status, 'done');
  assert.equal(shouldOffer(p, true), false);
  assert.deepEqual(ONBOARDING_STEPS.map((s) => p.steps[s]), ['done', 'skipped', 'done', 'skipped']);
  const d = dismiss(initialProgress(false), 5);
  assert.equal(d.status, 'dismissed');
  assert.equal(shouldOffer(d, true), false);
  const r = reopen(d, 6);
  assert.equal(r.status, 'in_progress');
  assert.equal(r.current, 'profile');
});

test('old installs are never offered onboarding automatically, but can re-open it', () => {
  const legacy = initialProgress(true);
  assert.equal(legacy.legacy, true);
  assert.equal(shouldOffer(legacy, true), false);
  const opened = reopen(legacy, 1);
  assert.equal(opened.legacy, true);
  assert.equal(opened.status, 'in_progress');
  assert.equal(shouldOffer(opened, true), false, 're-opening is explicit; the next load does not push it');
});

test('profile and notification validation', () => {
  assert.deepEqual(validateProfile({ name: 'Northwind', mission: '', industry: '', website: '' }), []);
  assert.ok(validateProfile({ name: 'x'.repeat(200), mission: '', industry: '', website: '' }).length);
  assert.ok(validateProfile({ name: 'A', mission: '', industry: '', website: 'javascript:alert(1)' }).length);
  const n = structuredClone(DEFAULT_SETTINGS.notifications);
  assert.deepEqual(validateNotifications(n), []);
  n.telegram.ownerId = '12ab';
  n.ntfy.topic = 'bad topic!';
  n.email.to = 'not-an-address';
  assert.equal(validateNotifications(n).length, 3);
});

test('secrets are sealed on disk, reported only as present, and fail closed', () => {
  const dir = tmp();
  try {
    const store = new FileSecretStore(dir);
    assert.deepEqual(store.names(), { telegramToken: false, ntfyToken: false, smtpPassword: false });
    store.set('telegramToken', TOKEN);
    store.set('smtpPassword', 'p@ss word-123');
    assert.deepEqual(store.names(), { telegramToken: true, ntfyToken: false, smtpPassword: true });
    assert.equal(store.get('telegramToken'), TOKEN);
    const file = path.join(dir, 'secrets.enc');
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes(TOKEN) && !raw.includes('p@ss'), 'no plaintext on disk');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(dir, 'secrets.key')).mode & 0o777, 0o600);
    assert.equal(new FileSecretStore(dir).get('smtpPassword'), 'p@ss word-123', 'survives a restart');
    store.delete('smtpPassword');
    assert.equal(store.names().smtpPassword, false);
    assert.throws(() => store.set('telegramToken', 'line\nbreak'), /line breaks/);
    // Tampered file: reads report nothing, writes are refused, the file is left as it was.
    writeFileSync(file, 'garbage');
    const broken = new FileSecretStore(dir);
    assert.equal(broken.get('telegramToken'), undefined);
    assert.throws(() => broken.set('ntfyToken', 'tk_abcdefghijklmnopqrstuvwxyz012'), /could not be opened/);
    assert.equal(readFileSync(file, 'utf8'), 'garbage');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('precedence: environment variables override saved settings, per channel', () => {
  const dir = tmp();
  try {
    const secrets = new FileSecretStore(dir);
    const saved = structuredClone(DEFAULT_SETTINGS);
    assert.equal(resolveTelegram({}, saved, secrets).source, 'off');
    saved.notifications.telegram.ownerId = '42';
    assert.equal(resolveTelegram({}, saved, secrets).source, 'off', 'no token saved yet');
    secrets.set('telegramToken', TOKEN);
    const s = resolveTelegram({}, saved, secrets);
    assert.equal(s.source, 'saved');
    assert.equal(s.config?.ownerId, 42);
    const envToken = '987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const e = resolveTelegram({ AGENT_EMPIRE_TELEGRAM_TOKEN: envToken, AGENT_EMPIRE_TELEGRAM_OWNER_ID: '7' }, saved, secrets);
    assert.equal(e.source, 'env');
    assert.equal(e.config?.token, envToken);
    const half = resolveTelegram({ AGENT_EMPIRE_TELEGRAM_OWNER_ID: '7' }, saved, secrets);
    assert.equal(half.source, 'env', 'a half-set environment still wins (and says what is wrong)');
    assert.ok(half.error && !half.config);
    assert.ok(!half.error!.includes(TOKEN));

    saved.notifications.email = { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me@example.com', to: 'ceo@example.com', from: '' };
    secrets.set('smtpPassword', 'secret-pass');
    const em = resolveEmail({}, saved, secrets);
    assert.equal(em.source, 'saved');
    assert.deepEqual(em.config?.smtp, { secure: false, host: 'smtp.example.com', port: 587, user: 'me@example.com', pass: 'secret-pass' });
    assert.equal(em.config?.from, 'me@example.com');
    assert.equal(resolveEmail({ AGENT_EMPIRE_SMTP_URL: 'smtps://a:b@mail.example.org', AGENT_EMPIRE_NOTIFY_EMAIL: 'x@example.org' }, saved, secrets).config?.smtp.host, 'mail.example.org');

    saved.notifications.ntfy = { server: 'https://ntfy.sh', topic: 'empire-abcdefghijklmnop' };
    assert.equal(resolveNtfy({}, saved, secrets).source, 'saved');
    const envN = resolveNtfy({ AGENT_EMPIRE_NTFY_URL: 'https://push.example.com/my-topic' }, saved, secrets);
    assert.equal(envN.source, 'env');
    assert.deepEqual([envN.config?.server, envN.config?.topic], ['https://push.example.com', 'my-topic']);

    saved.approvals.dailyBudgetUsd = 9;
    saved.approvals.pauseHiring = true;
    assert.deepEqual(resolveBudget({ pause: false }, saved), { source: 'saved', usd: 9, pause: true });
    assert.deepEqual(resolveBudget({ usd: 5, pause: false, source: 'cli' }, saved), { source: 'cli', usd: 5, pause: false });
    assert.deepEqual(resolveBudget({ pause: false }, DEFAULT_SETTINGS), { source: 'off', usd: undefined, pause: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ntfy: only https (http just for this computer), tokens never over plain http to another host', () => {
  assert.equal(validNtfyServer('https://ntfy.sh', true), undefined);
  assert.equal(validNtfyServer('http://127.0.0.1:8080', true), undefined);
  assert.match(validNtfyServer('http://192.168.1.5', false) ?? '', /https/);
  assert.match(validNtfyServer('https://user:pw@ntfy.sh', false) ?? '', /credentials/);
  assert.match(validNtfyServer('ftp://ntfy.sh', false) ?? '', /https/);
});

test('ntfy transport posts JSON to the configured server only, with the bearer token; errors never echo secrets', async () => {
  const seen: { url?: string; auth?: string; body: string }[] = [];
  let status = 200;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { seen.push({ url: req.url, auth: req.headers.authorization, body }); res.writeHead(status, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const t = ntfyTransport({ server: base, topic: 'empire-test-topic', token: 'tk_secret_value_1234567890abc' });
    await t.send({ from: 'x@y.z', to: 'x@y.z', subject: 'Approval A1 · Booking portal', text: 'Body text' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/');
    assert.equal(seen[0].auth, 'Bearer tk_secret_value_1234567890abc');
    assert.deepEqual(JSON.parse(seen[0].body), { topic: 'empire-test-topic', title: 'Approval A1 · Booking portal', message: 'Body text', tags: ['office'] });
    status = 401;
    await assert.rejects(t.send({ from: 'x@y.z', to: 'x@y.z', subject: 's', text: 't' }), (e: Error & { signIn?: boolean }) => {
      assert.equal(e.signIn, true);
      assert.ok(!e.message.includes('tk_secret') && !e.message.includes(base));
      return true;
    });
    status = 400;
    await assert.rejects(t.send({ from: 'x@y.z', to: 'x@y.z', subject: 's', text: 't' }), (e: Error & { permanent?: boolean }) => e.permanent === true);
  } finally { server.close(); }
});
