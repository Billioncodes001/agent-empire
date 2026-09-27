import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramBridge, telegramConfig, telegramTransport, type TelegramUpdate, type TelegramTransport } from '../src/server/telegram.js';

const config = { token: '123456:fake_token_for_tests_only_123', ownerId: 42 };
const now = 1_800_000_000_000;
const update = (id: number, text = '/jobs'): TelegramUpdate => ({ update_id: id, message: { date: now / 1000, text, from: { id: 42 }, chat: { id: 42, type: 'private' } } });
function fixture(t: any) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'empire-telegram-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let updates: TelegramUpdate[] = [], fingerprint = 'initial', sendFails = false;
  const executed = new Map<string, string>();
  const transport: TelegramTransport = { async call(method, body) {
    calls.push({ method, body });
    if (method === 'getUpdates') return updates;
    if (sendFails) throw new Error('network failure');
    return { message_id: 1 };
  } };
  const commands = {
    execute(text: string, key: string) { executed.set(key, text); return 'Saved'; },
    summary() { return { fingerprint, text: 'Chief report: one job needs attention.' }; },
  };
  const create = () => new TelegramBridge(dir, config, commands, transport, () => now);
  return { dir, calls, executed, create, updates: (u: TelegramUpdate[]) => { updates = u; }, change: () => { fingerprint = 'changed'; }, failSend: (v: boolean) => { sendFails = v; } };
}
test('Telegram config is disabled by default and rejects partial/invalid credentials', () => {
  assert.equal(telegramConfig({}), undefined);
  assert.throws(() => telegramConfig({ AGENT_EMPIRE_TELEGRAM_TOKEN: config.token }));
  assert.throws(() => telegramConfig({ AGENT_EMPIRE_TELEGRAM_TOKEN: config.token, AGENT_EMPIRE_TELEGRAM_OWNER_ID: '-42' }));
  assert.deepEqual(telegramConfig({ AGENT_EMPIRE_TELEGRAM_TOKEN: config.token, AGENT_EMPIRE_TELEGRAM_OWNER_ID: '42' }), config);
});
test('only allowlisted private sender commands execute; unauthorised updates get no response', async t => {
  const f = fixture(t), bot = f.create();
  const wrongSender = update(1), group = update(2), wrongChat = update(3), botSender = update(4);
  wrongSender.message!.from!.id = 99; group.message!.chat.type = 'group';
  wrongChat.message!.chat.id = 99; botSender.message!.from!.is_bot = true;
  f.updates([wrongSender, group, wrongChat, botSender]); await bot.tick();
  assert.equal(f.executed.size, 0); assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 0);
  assert.equal(JSON.parse(readFileSync(path.join(f.dir, 'telegram.json'), 'utf8')).offset, 5);
});
test('restart preserves offset, replies use plain text, and domain command identity is stable', async t => {
  const f = fixture(t); f.updates([update(8, '/new Acme | Site | Build it')]); await f.create().tick();
  await f.create().tick();
  assert.equal(f.executed.size, 1); assert.ok(f.executed.has('telegram-123456-8'));
  assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1);
  assert.equal(f.calls.find(c => c.method === 'sendMessage')!.body.parse_mode, undefined);
  assert.equal(f.calls.filter(c => c.method === 'getUpdates').at(-1)!.body.offset, 9);
});
test('stale approvals do not execute and owner receives an explanation', async t => {
  const f = fixture(t), u = update(2, '/approve job'); u.message!.date -= 700;
  f.updates([u]); await f.create().tick();
  assert.equal(f.executed.size, 0); assert.match(String(f.calls.find(c => c.method === 'sendMessage')!.body.text), /too old/);
});
test('failed response delivery retries the same idempotent command without advancing cursor', async t => {
  const f = fixture(t); f.updates([update(4)]); f.failSend(true);
  const first = f.create(); await first.tick(); assert.ok(first.status().error);
  f.failSend(false); await f.create().tick();
  assert.equal(f.executed.size, 1);
  assert.equal(JSON.parse(readFileSync(path.join(f.dir, 'telegram.json'), 'utf8')).offset, 5);
});
test('meaningful status transitions notify once and persist across restart', async t => {
  const f = fixture(t); await f.create().tick(); f.change(); await f.create().tick(); await f.create().tick();
  assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1);
});
test('corrupt state fails closed without network calls', async t => {
  const f = fixture(t); writeFileSync(path.join(f.dir, 'telegram.json'), 'bad json');
  const bot = f.create(); bot.start(); await bot.tick();
  assert.equal(f.calls.length, 0); assert.match(bot.status().error!, /checkpoint/); assert.equal(bot.status().running, false);
});
test('checkpoint write failure pauses commands and cannot advance acknowledged offset', async t => {
  const f = fixture(t), bot = f.create(); rmSync(f.dir, { recursive: true, force: true });
  await bot.tick(); await bot.tick(); assert.equal(f.calls.length, 1); assert.match(bot.status().error!, /paused/);
});
test('overlapping ticks cannot overlap transport polls', async t => {
  const f = fixture(t); const bot = f.create(); await Promise.all([bot.tick(), bot.tick()]);
  assert.equal(f.calls.filter(c => c.method === 'getUpdates').length, 1);
});
test('a poll resolving after stop cannot execute commands or overwrite a replacement checkpoint', async t => {
  const f = fixture(t);
  let resolvePoll!: (updates: TelegramUpdate[]) => void;
  const pendingPoll = new Promise<TelegramUpdate[]>(resolve => { resolvePoll = resolve; });
  let pollSignal: AbortSignal | undefined, commands = 0, sends = 0, summaries = 0;
  const stopped = new TelegramBridge(f.dir, config, {
    execute() { commands++; return 'Approved'; },
    summary() { summaries++; return { fingerprint: 'obsolete', text: 'Obsolete summary' }; },
  }, { async call(method, _body, signal) {
    if (method === 'getUpdates') { pollSignal = signal; return pendingPoll; }
    sends++; return { message_id: 1 };
  } }, () => now);
  const flight = stopped.tick();
  stopped.stop();
  assert.equal(pollSignal?.aborted, true);

  f.updates([update(10)]);
  await f.create().tick();
  const checkpoint = readFileSync(path.join(f.dir, 'telegram.json'), 'utf8');
  assert.equal(JSON.parse(checkpoint).offset, 11);
  // A response already completing at shutdown may resolve despite its aborted signal.
  resolvePoll([update(1, '/approve fixture-job')]);
  await flight;

  assert.equal(commands, 0);
  assert.equal(sends, 0);
  assert.equal(summaries, 0);
  assert.equal(readFileSync(path.join(f.dir, 'telegram.json'), 'utf8'), checkpoint);
  assert.deepEqual(stopped.status(), { configured: true, running: false, lastPollAt: undefined, error: undefined });
});
test('a reply resolving after stop cannot acknowledge the command or process the remaining batch', async t => {
  const f = fixture(t);
  let resolveSend!: (result: unknown) => void, markSendStarted!: () => void;
  const pendingSend = new Promise<unknown>(resolve => { resolveSend = resolve; });
  const sendStarted = new Promise<void>(resolve => { markSendStarted = resolve; });
  let sendSignal: AbortSignal | undefined, sends = 0, summaries = 0;
  const executed: string[] = [];
  const stopped = new TelegramBridge(f.dir, config, {
    execute(_text, requestId) { executed.push(requestId); return 'Approved'; },
    summary() { summaries++; return { fingerprint: 'obsolete', text: 'Obsolete summary' }; },
  }, { async call(method, _body, signal) {
    if (method === 'getUpdates') return [update(1, '/approve fixture-job'), update(2, '/approve another-job')];
    sends++; sendSignal = signal; markSendStarted(); return pendingSend;
  } }, () => now);
  const flight = stopped.tick();
  await sendStarted;
  assert.deepEqual(executed, ['telegram-123456-1']);
  stopped.stop();
  assert.equal(sendSignal?.aborted, true);

  f.updates([update(10)]);
  await f.create().tick();
  const checkpoint = readFileSync(path.join(f.dir, 'telegram.json'), 'utf8');
  assert.equal(JSON.parse(checkpoint).offset, 11);
  resolveSend({ message_id: 1 });
  await flight;

  assert.deepEqual(executed, ['telegram-123456-1']);
  assert.equal(sends, 1);
  assert.equal(summaries, 0);
  assert.equal(readFileSync(path.join(f.dir, 'telegram.json'), 'utf8'), checkpoint);
  assert.deepEqual(stopped.status(), { configured: true, running: false, lastPollAt: undefined, error: undefined });
});
test('transport errors do not expose token-bearing URLs', async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error(`https://api.telegram.org/bot${config.token}/getUpdates`); };
  try { await assert.rejects(telegramTransport(config.token).call('getUpdates', {}, new AbortController().signal), e => !String(e).includes(config.token)); }
  finally { globalThis.fetch = prior; }
});
