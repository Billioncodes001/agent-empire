/**
 * FREE-08 fixture (FIXTURE_ONBOARDING=new|legacy in tools/ui-fixture.ts): the real OnboardingService and secret store
 * over a throwaway directory, with in-process fake Telegram, ntfy and SMTP servers on loopback. "Send test" reaches only
 * those fakes; /__fixture/onboarding reports their addresses and what they received (never a secret value).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OnboardingError, OnboardingService } from '../src/server/onboarding.js';
import { FileSecretStore } from '../src/server/secrets.js';
import { ntfyTransport, resolveBudget, resolveEmail, resolveNtfy, resolveTelegram } from '../src/server/notify.js';
import { smtpTransport } from '../src/server/email.js';
import { telegramTransport } from '../src/server/telegram.js';
import { shouldOffer, type ChannelId, type ChannelView } from '../src/shared/onboarding.js';

async function fakeHttp(name: string, hits: string[]) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let summary = `${req.method} ${req.url?.replace(/bot\d+:[A-Za-z0-9_-]+/, 'bot<token>')}`;
      try { const j = JSON.parse(body); summary += ` ${j.topic ?? j.chat_id ?? ''}`; } catch { /* plain */ }
      hits.push(`${name}: ${summary}${req.headers.authorization ? ' (with token)' : ''}`);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"result":{}}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

async function fakeSmtp(hits: string[]) {
  const server = net.createServer((socket) => {
    let buf = '', data = false;
    socket.write('220 fixture ESMTP\r\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (line === '.') { data = false; socket.write('250 queued\r\n'); } continue; }
        if (/^EHLO/.test(line)) socket.write('250-fixture\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) { hits.push('smtp: AUTH PLAIN (password not recorded)'); socket.write('235 ok\r\n'); }
        else if (/^(MAIL|RCPT)/.test(line)) { hits.push(`smtp: ${line}`); socket.write('250 ok\r\n'); }
        else if (line === 'DATA') { data = true; socket.write('354 go\r\n'); }
        else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as { port: number }).port, server };
}

export async function onboardingFixture(mode: 'new' | 'legacy', founded: () => boolean) {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-onboarding-fixture-'));
  const secrets = new FileSecretStore(dir);
  const service = new OnboardingService(dir, secrets, { legacy: mode === 'legacy' });
  const hits: string[] = [];
  const tg = await fakeHttp('telegram', hits);
  const ntfy = await fakeHttp('ntfy', hits);
  const smtp = await fakeSmtp(hits);
  const env = {};
  const lastTest = new Map<ChannelId, number>();

  const channel = (id: ChannelId): ChannelView => {
    const s = service.settings();
    const r = id === 'telegram' ? resolveTelegram(env, s, secrets) : id === 'ntfy' ? resolveNtfy(env, s, secrets) : resolveEmail(env, s, secrets);
    const name = id === 'telegram' ? 'Telegram' : id === 'ntfy' ? 'ntfy' : 'Email';
    const configured = r.source !== 'off' && !r.error;
    return { source: r.source, configured, running: false, label: r.error ? `${name}: needs attention` : configured ? `${name}: saved, not delivering in this preview` : `${name}: not set up`, ...(r.error ? { error: r.error } : {}) };
  };
  const view = () => {
    const progress = service.progress(), s = service.settings();
    return { progress, offer: shouldOffer(progress, founded()), settings: { profile: s.profile, notifications: s.notifications, approvals: s.approvals, secrets: secrets.names(), secretStorage: `${secrets.describe} (fixture: a throwaway directory)`,
      channels: { telegram: channel('telegram'), ntfy: channel('ntfy'), email: channel('email') }, budget: resolveBudget({ pause: false }, s) } };
  };
  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

  const test = async (id: ChannelId) => {
    if (Date.now() - (lastTest.get(id) ?? 0) < 5_000) throw new OnboardingError(429, 'Wait a few seconds before sending another test.');
    const s = service.settings();
    const subject = `${s.profile.name || 'Agent Empire'}: test notification`, text = 'Fixture test notification.';
    if (id === 'telegram') {
      const c = resolveTelegram(env, s, secrets).config;
      if (!c) throw new OnboardingError(400, 'Save your Telegram bot token and user ID first.');
      lastTest.set(id, Date.now());
      await telegramTransport(c.token, tg.base).call('sendMessage', { chat_id: c.ownerId, text: `${subject}\n\n${text}` }, AbortSignal.timeout(5000));
      return 'Sent a test message to your Telegram chat with the bot.';
    }
    if (id === 'ntfy') {
      const c = resolveNtfy(env, s, secrets).config;
      if (!c) throw new OnboardingError(400, 'Save an ntfy server and topic first.');
      if (c.server !== ntfy.base) throw new OnboardingError(400, `Fixture only: use the fake ntfy server ${ntfy.base}.`);
      lastTest.set(id, Date.now());
      await ntfyTransport(c).send({ from: 'x@fixture.invalid', to: 'x@fixture.invalid', subject, text });
      return `Sent a test to the ntfy topic ${c.topic}.`;
    }
    const c = resolveEmail(env, s, secrets).config;
    if (!c) throw new OnboardingError(400, 'Save the SMTP server and the address to notify first.');
    if (c.smtp.host !== '127.0.0.1' || c.smtp.port !== smtp.port) throw new OnboardingError(400, `Fixture only: use the fake SMTP server 127.0.0.1:${smtp.port}.`);
    lastTest.set(id, Date.now());
    await smtpTransport(c.smtp).send({ from: c.from, to: c.to, subject, text });
    return `Sent a test email to ${c.to}.`;
  };

  /** Handles FREE-08 routes; returns false for anything else. `sameOrigin` follows the fixture's own rule. */
  async function route(req: IncomingMessage, res: ServerResponse, p: string, sameOrigin: boolean): Promise<boolean> {
    if (p === '/__fixture/onboarding') { json(res, 200, { ntfy: ntfy.base, smtpPort: smtp.port, hits, progress: service.progress() }); return true; }
    if (!(p === '/api/onboarding' || p.startsWith('/api/onboarding/') || p === '/api/settings' || p.startsWith('/api/settings/'))) return false;
    if (req.method !== 'GET' && !sameOrigin) { json(res, 403, { error: 'A same-origin Origin header is required' }); return true; }
    try {
      if (p === '/api/onboarding' && req.method === 'GET') { json(res, 200, view()); return true; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      let body: unknown; try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { json(res, 400, { error: 'Expected a JSON request.' }); return true; }
      if (p === '/api/onboarding/progress' && req.method === 'POST') { service.updateProgress(body); json(res, 200, view()); return true; }
      if (p === '/api/settings' && req.method === 'PUT') { service.updateSettings(body); json(res, 200, view()); return true; }
      const t = /^\/api\/settings\/test\/(telegram|ntfy|email)$/.exec(p);
      if (t && req.method === 'POST') {
        try { json(res, 200, { ok: true, message: await test(t[1] as ChannelId) }); }
        catch (e) { if (e instanceof OnboardingError) throw e; json(res, 502, { error: `The test was not delivered: ${(e as Error).message}` }); }
        return true;
      }
      json(res, 404, { error: 'Unknown onboarding endpoint.' });
    } catch (e) { json(res, e instanceof OnboardingError ? e.status : 500, { error: (e as Error).message }); }
    return true;
  }
  const close = () => { tg.server.close(); ntfy.server.close(); smtp.server.close(); };
  return { route, close };
}
