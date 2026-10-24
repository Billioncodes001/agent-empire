/**
 * FREE-01 engines: fakes only. Fake `claude`/`codex`/`qwen` CLIs are shell scripts in a temp directory resolved through
 * a PATH-only lookup; Ollama and the model API are fake local HTTP servers. No real CLI, model, pull or paid call runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { accessSync, chmodSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerManager, type WorkerRuntime } from '../src/server/workers';
import type { Ledger } from '../src/server/usage';
import type { WorkerInfo } from '../src/shared/protocol';
import { LinkedAccounts, engineEnv, parseClaudeAuthStatus, parseCodexLoginStatus } from '../src/server/engines';
import { OllamaRuntime } from '../src/server/ollama';
import { chat, provider, LlmError } from '../src/server/llm';
import { engineLabel, engineOptions, pickEngine, recommendModels, sanitizeEngine, type EnginesState } from '../src/shared/engines';

const GB = 2 ** 30;

interface Spawned { file: string; args: string[]; env: Record<string, string>; written: string[] }

function manager(dir: string, opts: { keys?: Record<string, string> } = {}) {
  const spawned: Spawned[] = [];
  const updates: WorkerInfo[] = [];
  const runtime: WorkerRuntime = {
    taskNaming: false,
    resolveCommand: (cmd) => `/fixture/${cmd}`,
    processExists: () => false,
    spawn: ((file: string, args: string[], o: { env: Record<string, string> }) => {
      const s: Spawned = { file, args, env: o.env, written: [] };
      spawned.push(s);
      return { pid: 9001 + spawned.length, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: (d: string) => s.written.push(d), resize() {}, kill() {} };
    }) as unknown as WorkerRuntime['spawn'],
  };
  const events = { update: (w: WorkerInfo) => updates.push(w), remove() {}, data() {}, screen() {}, toast() {} };
  const ledger = { get hiringPaused() { return undefined; }, add() {} } as unknown as Ledger;
  const m = new WorkerManager(dir, dir, 'claude', [], { url: 'http://127.0.0.1:1', token: '' }, events, ledger, () => 4, runtime, () => undefined,
    { keys: () => opts.keys ?? {}, ollamaUrl: 'http://127.0.0.1:11434', defaultEngine: () => ({ id: 'claude-code', auth: 'subscription' }) });
  return { m, spawned, updates };
}

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-engines-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('engine labels are honest and the wire sanitizer only accepts real combinations', () => {
  assert.equal(engineLabel({ id: 'qwen-code', auth: 'local', model: 'gpt-oss:20b' }), 'Qwen Code · gpt-oss:20b (local)');
  assert.equal(engineLabel({ id: 'claude-code', auth: 'subscription' }), 'Claude Code · your Claude account');
  assert.equal(engineLabel(undefined), 'Claude Code · your Claude account');
  assert.equal(engineLabel({ id: 'claude-code', auth: 'api-key' }), 'Claude Code · Anthropic API key');
  assert.equal(sanitizeEngine({ id: 'qwen-code', auth: 'subscription' }), undefined);
  assert.equal(sanitizeEngine({ id: 'qwen-code', auth: 'local' }), undefined, 'local needs a model');
  assert.equal(sanitizeEngine({ id: 'qwen-code', auth: 'local', model: '../../etc' }), undefined);
  assert.deepEqual(sanitizeEngine({ id: 'codex', auth: 'local', model: 'gpt-oss:20b', x: 1 }), { id: 'codex', auth: 'local', model: 'gpt-oss:20b' });
});

test('Claude path is unchanged: claude --settings … -- prompt, hooks drive status, transcript spend still tracked', () => withTemp((dir) => {
  const { m, spawned } = manager(dir);
  try {
    const w = m.spawn('desk-1', 'Owner', 'fix login') as WorkerInfo;
    assert.deepEqual(w.engine, { id: 'claude-code', auth: 'subscription' });
    assert.equal(spawned[0].file, '/fixture/claude');
    assert.deepEqual(spawned[0].args, ['--settings', path.join(dir, 'claude-hooks.json'), '--', 'fix login']);
    assert.equal(w.status, 'starting');
    const token = spawned[0].env.AGENT_OFFICE_HOOK_TOKEN;
    assert.ok(m.handleHook(w.id, token, 'SessionStart', {}));
    assert.equal(m.get(w.id)!.status, 'idle');
    assert.ok(m.handleHook(w.id, token, 'UserPromptSubmit', { prompt: 'go' }));
    assert.equal(m.get(w.id)!.status, 'working');
    assert.ok(m.handleHook(w.id, token, 'Stop', {}));
    assert.equal(m.get(w.id)!.status, 'done');
    assert.equal(m.handleHook(w.id, token, 'Stop', {}, 'qwen'), false, 'a Qwen hook never drives a Claude worker');
    const settings = JSON.parse(readFileSync(path.join(dir, 'claude-hooks.json'), 'utf8'));
    assert.match(settings.hooks.Stop[0].hooks[0].command, /\/hooks\/claude\?/);
    assert.equal(settings.security, undefined);
  } finally { m.shutdown(); }
}));

test('Qwen Code: launch with model, hooks posted to /hooks/qwen map to status; status unknown until hooks arrive', () => withTemp((dir) => {
  const { m, spawned } = manager(dir);
  try {
    const w = m.spawn('desk-1', 'Owner', 'add tests', false, 'agent', false, undefined, undefined, undefined, { engine: { id: 'qwen-code', auth: 'local', model: 'gpt-oss:20b' } }) as WorkerInfo;
    assert.equal(spawned[0].file, '/fixture/qwen');
    assert.deepEqual(spawned[0].args, ['--model', 'gpt-oss:20b', '-i', 'add tests']);
    const env = spawned[0].env;
    assert.equal(env.QWEN_CODE_SYSTEM_SETTINGS_PATH, path.join(dir, 'qwen-system-settings.json'));
    assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:11434/v1');
    assert.equal(env.OPENAI_MODEL, 'gpt-oss:20b');
    const settings = JSON.parse(readFileSync(env.QWEN_CODE_SYSTEM_SETTINGS_PATH, 'utf8'));
    assert.equal(settings.security.auth.selectedType, 'openai');
    for (const e of ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest', 'PreToolUse', 'PostToolUse'])
      assert.match(settings.hooks[e][0].hooks[0].command, new RegExp(`/hooks/qwen\\?worker=\\$AGENT_OFFICE_WORKER_ID&event=${e}`));
    const token = env.AGENT_OFFICE_HOOK_TOKEN;
    assert.equal(m.handleHook(w.id, token, 'SessionStart', {}, 'claude'), false, 'a Claude hook never drives a Qwen worker');
    assert.ok(m.handleHook(w.id, token, 'SessionStart', {}, 'qwen'));
    assert.equal(m.get(w.id)!.status, 'idle');
    m.handleHook(w.id, token, 'PreToolUse', { tool_name: 'run_shell_command', tool_input: { command: 'npm test' } }, 'qwen');
    assert.equal(m.get(w.id)!.status, 'working');
    assert.match(m.get(w.id)!.activity!, /npm test/);
    m.handleHook(w.id, token, 'PermissionRequest', { tool_name: 'write_file' }, 'qwen');
    assert.equal(m.get(w.id)!.status, 'needs_input');
    m.handleHook(w.id, token, 'PostToolUse', {}, 'qwen');
    assert.equal(m.get(w.id)!.status, 'working');
    m.handleHook(w.id, token, 'StopFailure', {}, 'qwen');
    assert.equal(m.get(w.id)!.status, 'done');
    // A Qwen transcript is never parsed as Claude spend.
    m.handleHook(w.id, token, 'Stop', { transcript_path: path.join(dir, 'qwen.jsonl') }, 'qwen');
    assert.equal(m.get(w.id)!.usage, undefined);
  } finally { m.shutdown(); }
}));

test('Codex cannot report status here: it says "status unknown" rather than guessing', () => withTemp((dir) => {
  const { m, spawned } = manager(dir);
  try {
    const w = m.spawn('desk-1', 'Owner', 'refactor', false, 'agent', false, undefined, undefined, undefined, { engine: { id: 'codex', auth: 'local', model: 'gpt-oss:20b' } }) as WorkerInfo;
    assert.equal(w.statusKnown, false);
    assert.deepEqual(spawned[0].args, ['--oss', '-c', 'oss_provider="ollama"', '-m', 'gpt-oss:20b', '--', 'refactor']);
    assert.equal(m.handleHook(w.id, spawned[0].env.AGENT_OFFICE_HOOK_TOKEN, 'Stop', {}, 'claude'), false);
    assert.equal(m.get(w.id)!.statusKnown, false);
  } finally { m.shutdown(); }
}));

test('env scrub (rule 6): subscription workers get no API keys; API-key workers only their own; local workers none', () => withTemp((dir) => {
  const saved = { ...process.env };
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-ant-office', ANTHROPIC_AUTH_TOKEN: 'tok', OPENAI_API_KEY: 'sk-openai', GROQ_API_KEY: 'gsk', CLAUDE_CODE_OAUTH_TOKEN: 'user-own-oauth' });
  const { m, spawned } = manager(dir, { keys: { ANTHROPIC_API_KEY: 'sk-ant-vault' } });
  try {
    m.spawn('desk-1', 'Owner', 'a');
    const sub = spawned[0].env;
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GROQ_API_KEY']) assert.equal(sub[k], undefined, k);
    assert.equal(sub.CLAUDE_CODE_OAUTH_TOKEN, 'user-own-oauth', 'the user’s own subscription token is their subscription');
    m.spawn('desk-2', 'Owner', 'b', false, 'agent', false, undefined, undefined, undefined, { engine: { id: 'claude-code', auth: 'api-key' } });
    const key = spawned[1].env;
    assert.equal(key.ANTHROPIC_API_KEY, 'sk-ant-vault');
    for (const k of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(key[k], undefined, k);
    m.spawn('desk-3', 'Owner', 'c', false, 'agent', false, undefined, undefined, undefined, { engine: { id: 'qwen-code', auth: 'local', model: 'gpt-oss:20b' } });
    const local = spawned[2].env;
    assert.equal(local.OPENAI_API_KEY, 'ollama-local');
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GROQ_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(local[k], undefined, k);
    m.spawn('desk-4', 'Owner', undefined, false, 'shell');
    assert.equal(spawned[3].env.ANTHROPIC_API_KEY, 'sk-ant-office', 'a plain shell is the user’s own terminal: unchanged');
    // Codex on the user's ChatGPT login: no OpenAI key, so the login is really used.
    const codex = engineEnv({ OPENAI_API_KEY: 'x', CODEX_API_KEY: 'y', PATH: '/bin' }, { id: 'codex', auth: 'subscription' }, { OPENAI_API_KEY: 'z' }, '');
    assert.deepEqual(codex, { PATH: '/bin' });
  } finally { m.shutdown(); process.env = saved; }
}));

test('"Sign in to Claude" types /login without pressing Enter, only after Claude is ready', () => withTemp((dir) => {
  const { m, spawned } = manager(dir);
  try {
    const w = m.spawn('desk-1', 'Owner', undefined, false, 'agent', false, undefined, undefined, undefined, { engine: { id: 'claude-code', auth: 'subscription' }, typeOnReady: '/login' }) as WorkerInfo;
    assert.deepEqual(spawned[0].written, []);
    m.handleHook(w.id, spawned[0].env.AGENT_OFFICE_HOOK_TOKEN, 'SessionStart', {});
    assert.deepEqual(spawned[0].written, ['/login']);
    assert.ok(!spawned[0].written.some((d) => d.includes('\r')));
  } finally { m.shutdown(); }
}));

test('legacy saves restore as Claude Code on the user’s account; engines persist', () => withTemp((dir) => {
  writeFileSync(path.join(dir, 'workers.json'), JSON.stringify([
    { id: 'a1', kind: 'agent', deskId: 'desk-1', name: 'Pixel', processState: 'stopped' },
    { id: 'a2', kind: 'agent', deskId: 'desk-2', name: 'Byte', processState: 'stopped', engine: { id: 'codex', auth: 'local', model: 'gpt-oss:20b' } },
  ]));
  const { m } = manager(dir);
  try {
    assert.deepEqual(m.get('a1')!.engine, { id: 'claude-code', auth: 'subscription' });
    assert.deepEqual(m.get('a2')!.engine, { id: 'codex', auth: 'local', model: 'gpt-oss:20b' });
    assert.equal(m.get('a2')!.statusKnown, false);
  } finally { m.shutdown(); }
}));

test('model recommendation by RAM follows the owner decision (16 GB floor)', () => {
  assert.deepEqual(recommendModels(8 * GB).models, []);
  assert.match(recommendModels(8 * GB).note, /below the 16 GB floor/);
  assert.deepEqual(recommendModels(16 * GB).models.map((m) => [m.tag, m.role]), [['gpt-oss:20b', 'default']]);
  assert.deepEqual(recommendModels(15.8 * GB).models.map((m) => m.tag), ['gpt-oss:20b']);
  assert.deepEqual(recommendModels(32 * GB).models.map((m) => [m.tag, m.role]), [['qwen3-coder:30b', 'fast'], ['qwen3.8:27b', 'quality'], ['gpt-oss:20b', 'option']]);
  assert.deepEqual(recommendModels(64 * GB).models.map((m) => m.tag)[0], 'qwen3-coder:30b');
});

test('claude auth status parsing: logged in, logged out, expired, expiring soon, text output; no account details kept', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const ok = parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'someone@example.com', orgName: 'Org' }), 0, now);
  assert.equal(ok.loggedIn, true);
  assert.equal(ok.method, 'claude.ai');
  assert.equal(ok.plan, 'max');
  assert.ok(!JSON.stringify(ok).includes('example.com') && !JSON.stringify(ok).includes('Org'));
  assert.equal(parseClaudeAuthStatus('{"loggedIn": false}', 1, now).loggedIn, false);
  const expired = parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, expiresAt: '2026-10-01T00:00:00Z' }), 0, now);
  assert.equal(expired.expired, true);
  assert.equal(expired.loggedIn, false);
  const soon = parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, expiresAt: '2026-10-25T00:00:00Z' }), 0, now);
  assert.equal(soon.expiringSoon, true);
  assert.match(soon.detail, /Expires 2026-10-25/);
  assert.equal(parseClaudeAuthStatus('Not logged in · Run /login', 1, now).loggedIn, false);
  assert.equal(parseClaudeAuthStatus('Your session has expired. Please run /login', 1, now).expired, true);
  assert.equal(parseClaudeAuthStatus('Logged in with your Claude subscription', 0, now).loggedIn, true);
  assert.equal(parseClaudeAuthStatus('something new', 0, now).loggedIn, null);
  assert.match(parseClaudeAuthStatus('{"loggedIn": true, "authMethod": "apiKeyHelper"}', 0, now).detail, /subscription workers scrub API keys/);
  const codex = parseCodexLoginStatus('Logged in using an API key - sk-proj-ABC***', 0);
  assert.equal(codex.loggedIn, true);
  assert.ok(!JSON.stringify(codex).includes('sk-proj'));
  assert.equal(parseCodexLoginStatus('Not logged in', 1).loggedIn, false);
});

function fakeBin(dir: string, scripts: Record<string, string>) {
  for (const [name, body] of Object.entries(scripts)) {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  // PATH-only lookup over the temp directory: never the login shell, so a real CLI can't be found by accident.
  return (cmd: string) => { const p = path.join(dir, cmd); try { accessSync(p, constants.X_OK); return p; } catch { return null; } };
}

async function server(handler: http.RequestListener) {
  const s = http.createServer(handler);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

test('linked accounts run fake CLIs (output only, key-free env) and pick premium, else free, else explain', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-accounts-test-'));
  const ollama = await server((req, res) => {
    if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.40.10' }));
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'gpt-oss:20b', size: 14e9 }] }));
    res.statusCode = 404; res.end();
  });
  try {
    const envLog = path.join(dir, 'env.log');
    const resolve = fakeBin(dir, {
      claude: `env > ${JSON.stringify(envLog)}; [ "$1 $2" = "auth status" ] && echo '{"loggedIn": false}'; exit 1`,
      qwen: 'exit 0',
    });
    const accounts = new LinkedAccounts({ dataDir: dir, ollama: new OllamaRuntime(ollama.url), keys: () => ({ GROQ_API_KEY: 'gsk' }), resolve, totalMem: () => 16 * GB, env: () => ({ PATH: dir, ANTHROPIC_API_KEY: 'sk-leak' }) });
    const s = await accounts.state();
    assert.equal(s.claude.installed, true);
    assert.equal(s.claude.loggedIn, false);
    assert.equal(s.codex.installed, false);
    assert.equal(s.qwen.installed, true);
    assert.equal(s.ollama.running, true);
    assert.deepEqual(s.keys.filter((k) => k.present).map((k) => k.name), ['GROQ_API_KEY']);
    assert.ok(!JSON.stringify(s).includes('gsk'), 'key values never leave the server');
    assert.ok(!readFileSync(envLog, 'utf8').includes('sk-leak'), 'the probe runs without provider keys');
    assert.deepEqual(s.recommended, { id: 'qwen-code', auth: 'local', model: 'gpt-oss:20b' }, 'no healthy premium: the free engine is offered');
    assert.equal(s.options.find((o) => o.engine.id === 'qwen-code')!.label, 'Qwen Code · gpt-oss:20b (local)');
    // Premium preferred when healthy.
    writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\necho \'{"loggedIn": true, "authMethod": "claude.ai"}\'\n');
    assert.deepEqual((await accounts.state(true)).recommended, { id: 'claude-code', auth: 'subscription' });
    // A chosen default wins when usable, and persists.
    accounts.setDefault({ id: 'qwen-code', auth: 'local', model: 'gpt-oss:20b' });
    assert.deepEqual((await accounts.state()).recommended, { id: 'qwen-code', auth: 'local', model: 'gpt-oss:20b' });
    assert.deepEqual(new LinkedAccounts({ dataDir: dir, ollama: new OllamaRuntime(ollama.url), keys: () => ({}), resolve }).defaultEngine, { id: 'qwen-code', auth: 'local', model: 'gpt-oss:20b' });
    assert.throws(() => accounts.setDefault({ id: 'evil' }));
  } finally { await ollama.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('with nothing usable, the hire choice explains what to install', () => {
  const none: Pick<EnginesState, 'claude' | 'codex' | 'qwen' | 'ollama' | 'keys' | 'ram'> = {
    claude: { installed: false, loggedIn: null, detail: '' }, codex: { installed: false, loggedIn: null, detail: '' }, qwen: { installed: false, detail: '' },
    ollama: { running: false, models: [], url: '', installUrl: '', detail: '' }, keys: [], ram: { totalGb: 16, note: '', models: recommendModels(16 * GB).models },
  };
  const picked = pickEngine(engineOptions(none));
  assert.equal(picked.engine, null);
  assert.match(picked.help.join(' '), /install Ollama/i);
  assert.match(engineOptions(none).find((o) => o.engine.id === 'qwen-code')!.reason, /Install Qwen Code/);
});

test('Ollama: absent → install link; a download needs confirmation, streams progress, and can be cancelled', async () => {
  const absent = await new OllamaRuntime('http://127.0.0.1:9').detect();
  assert.equal(absent.running, false);
  assert.equal(absent.installUrl, 'https://ollama.com/download');
  assert.throws(() => new OllamaRuntime('http://example.com:11434'), /loopback/);
  let pulls = 0;
  let hold: (() => void) | undefined;
  const fake = await server((req, res) => {
    if (req.url !== '/api/pull') { res.statusCode = 404; return res.end(); }
    pulls++;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const model = JSON.parse(body).model;
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
      res.write(JSON.stringify({ status: 'downloading', total: 100, completed: 40 }) + '\n');
      if (model === 'qwen3.8:27b') { hold = () => res.end(); return; } // stays open until cancelled
      res.write(JSON.stringify({ status: 'downloading', total: 100, completed: 100 }) + '\n');
      res.end(JSON.stringify({ status: 'success' }) + '\n');
    });
  });
  try {
    const seen: number[] = [];
    const o = new OllamaRuntime(fake.url, () => { if (o.pull) seen.push(o.pull.completed); });
    assert.match(o.startPull('gpt-oss:20b', undefined).error!, /explicit confirmation/);
    assert.match(o.startPull('gpt-oss:20b', 'yes').error!, /explicit confirmation/);
    assert.match(o.startPull('some/other:tag', true).error!, /Only the listed models/);
    assert.equal(pulls, 0, 'nothing was downloaded without confirmation');
    await o.startPull('gpt-oss:20b', true).started;
    assert.equal(o.pull!.done, true);
    assert.equal(o.pull!.status, 'success');
    assert.ok(seen.includes(40) && seen.includes(100), `progress streamed: ${seen}`);
    const run = o.startPull('qwen3.8:27b', true).started!;
    await new Promise((r) => setTimeout(r, 100));
    assert.match(o.startPull('gpt-oss:20b', true).error!, /still downloading/);
    assert.equal(o.cancelPull(), true);
    await run;
    assert.equal(o.pull!.cancelled, true);
    hold?.();
  } finally { await fake.close(); }
});

test('shared model client: Ollama $0, free tier labelled, paid estimate labelled, streaming, timeouts, no key leaks', async () => {
  const seen: { auth?: string; body: any }[] = [];
  const fake = await server((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, body: j });
      if (j.model === 'slow') return; // never answers
      if (j.model === 'limited') { res.statusCode = 429; return res.end('{"error":"rate"}'); }
      if (j.stream) {
        res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n');
        return res.end('data: [DONE]\n\n');
      }
      res.end(JSON.stringify({ model: j.model, choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }));
    });
  });
  try {
    const local = await chat(provider('ollama', 'gpt-oss:20b', {}, { ollamaUrl: fake.url.replace(/\/v1$/, '') }), [{ role: 'user', content: 'hi' }]);
    assert.equal(local.text, 'ok');
    assert.deepEqual(local.cost, { usd: 0, kind: 'local', label: 'US$0 · local model' });
    assert.equal(seen[0].auth, undefined, 'no key is sent to Ollama');
    const free = await chat(provider('groq', 'openai/gpt-oss-20b', { GROQ_API_KEY: 'gsk' }, { baseUrl: fake.url }), [{ role: 'user', content: 'hi' }]);
    assert.equal(free.cost.label, 'US$0 · free tier (rate-limited)');
    assert.equal(seen[1].auth, 'Bearer gsk');
    const paid = await chat(provider('anthropic', 'some-model', { ANTHROPIC_API_KEY: 'k' }, { baseUrl: fake.url, price: [3, 15] }), [{ role: 'user', content: 'hi' }]);
    assert.equal(paid.cost.usd, 0.0105);
    assert.match(paid.cost.label, /estimate/);
    const unpriced = await chat(provider('openai', 'm', { OPENAI_API_KEY: 'k' }, { baseUrl: fake.url }), [{ role: 'user', content: 'hi' }]);
    assert.equal(unpriced.cost.usd, null);
    assert.match(unpriced.cost.label, /no price configured/);
    const tokens: string[] = [];
    const streamed = await chat(provider('openrouter', 'x', { OPENROUTER_API_KEY: 'k' }, { baseUrl: fake.url }), [{ role: 'user', content: 'hi' }], { onToken: (t) => tokens.push(t) });
    assert.equal(streamed.text, 'Hello');
    assert.deepEqual(tokens, ['Hel', 'lo']);
    assert.deepEqual(streamed.usage, { input: 7, output: 2 });
    await assert.rejects(chat(provider('openai', 'limited', { OPENAI_API_KEY: 'k' }, { baseUrl: fake.url }), []), (e: LlmError) => e.status === 429 && /rate-limited/.test(e.message));
    await assert.rejects(chat(provider('openai', 'slow', { OPENAI_API_KEY: 'k' }, { baseUrl: fake.url }), [], { timeoutMs: 150 }), /did not answer in time/);
    assert.throws(() => provider('gemini', 'x', {}), /needs your own GEMINI_API_KEY/);
  } finally { await fake.close(); }
});

// ---- Security review fixes (2026-10-24) ----

const baseState = (claude: Partial<EnginesState['claude']>): Pick<EnginesState, 'claude' | 'codex' | 'qwen' | 'ollama' | 'keys' | 'ram'> => ({
  claude: { installed: true, loggedIn: true, detail: '', ...claude }, codex: { installed: false, loggedIn: null, detail: '' }, qwen: { installed: true, detail: '' },
  ollama: { running: true, models: [{ name: 'gpt-oss:20b', sizeBytes: 1 }], url: '', installUrl: '', detail: '' }, keys: [], ram: { totalGb: 16, note: '', models: recommendModels(16 * GB).models },
});

test('review 1: an API-key or helper sign-in is never offered as "your Claude account"', () => {
  for (const method of ['apiKeyHelper', 'API key', 'ANTHROPIC_API_KEY', 'console', undefined]) {
    const opts = engineOptions(baseState({ method }));
    const sub = opts.find((o) => o.engine.id === 'claude-code' && o.engine.auth === 'subscription')!;
    assert.equal(sub.usable, false, `method ${method}`);
    assert.match(sub.reason, /not your Claude subscription|sign-in method/i);
    assert.deepEqual(pickEngine(opts).engine, { id: 'qwen-code', auth: 'local', model: 'gpt-oss:20b' }, 'auto falls back to free, never silent API billing');
  }
  for (const method of ['claude.ai', 'oauth_token', 'Claude subscription']) assert.equal(engineOptions(baseState({ method })).find((o) => o.engine.auth === 'subscription')!.usable, true, method);
});

test('review 2: a dash-leading prompt is never parsed as a Qwen Code option', () => withTemp((dir) => {
  const { m, spawned } = manager(dir);
  try {
    for (const [i, prompt] of ['--yolo', '--approval-mode=yolo', '-y do it'].entries()) {
      m.spawn(`desk-${i + 1}`, 'Owner', prompt, false, 'agent', false, undefined, undefined, undefined, { engine: { id: 'qwen-code', auth: 'local', model: 'gpt-oss:20b' } });
      assert.deepEqual(spawned[i].args, ['--model', 'gpt-oss:20b', `--prompt-interactive=${prompt}`]);
      assert.ok(!spawned[i].args.includes(prompt), 'never a standalone argv element');
    }
  } finally { m.shutdown(); }
}));

test('review 3: "Sign in to Claude" types /login when Claude sits on its logged-out prompt without SessionStart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-engines-test-'));
  const written: string[] = [];
  let feed: ((d: string) => void) | undefined;
  const runtime: WorkerRuntime = {
    taskNaming: false, resolveCommand: (cmd) => `/fixture/${cmd}`, processExists: () => false,
    spawn: (() => ({ pid: 9100, onData: (cb: (d: string) => void) => { feed = cb; return { dispose() {} }; }, onExit: () => ({ dispose() {} }), write: (d: string) => written.push(d), resize() {}, kill() {} })) as unknown as WorkerRuntime['spawn'],
  };
  const m = new WorkerManager(dir, dir, 'claude', [], { url: 'http://127.0.0.1:1', token: '' }, { update() {}, remove() {}, data() {}, screen() {}, toast() {} },
    { get hiringPaused() { return undefined; }, add() {} } as unknown as Ledger, () => 4, runtime);
  try {
    m.spawn('desk-1', 'Owner', undefined, false, 'agent', false, undefined, undefined, undefined, { engine: { id: 'claude-code', auth: 'subscription' }, typeOnReady: '/login' });
    feed!('Welcome to Claude Code\r\n> \r\nNot logged in · Run /login\r\n');
    await new Promise((r) => setTimeout(r, 700)); // the 250 ms screen flush runs the blocked-screen check
    assert.deepEqual(written, ['/login']);
    assert.ok(!written.join('').includes('\r'), 'never presses Enter');
  } finally { m.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test('review: a setup menu (login method / trust) is never typed into', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-engines-test-'));
  const written: string[] = [];
  let feed: ((d: string) => void) | undefined;
  const runtime: WorkerRuntime = {
    taskNaming: false, resolveCommand: (cmd) => `/fixture/${cmd}`, processExists: () => false,
    spawn: (() => ({ pid: 9101, onData: (cb: (d: string) => void) => { feed = cb; return { dispose() {} }; }, onExit: () => ({ dispose() {} }), write: (d: string) => written.push(d), resize() {}, kill() {} })) as unknown as WorkerRuntime['spawn'],
  };
  const m = new WorkerManager(dir, dir, 'claude', [], { url: 'http://127.0.0.1:1', token: '' }, { update() {}, remove() {}, data() {}, screen() {}, toast() {} },
    { get hiringPaused() { return undefined; }, add() {} } as unknown as Ledger, () => 4, runtime);
  try {
    m.spawn('desk-1', 'Owner', undefined, false, 'agent', false, undefined, undefined, undefined, { engine: { id: 'claude-code', auth: 'subscription' }, typeOnReady: '/login' });
    feed!('Select login method:\r\n 1. Claude account with subscription\r\n');
    await new Promise((r) => setTimeout(r, 700));
    assert.deepEqual(written, []);
  } finally { m.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test('review: model client caps response size and strips key-shaped text from errors', async () => {
  const big = 'x'.repeat(5 * 1024 * 1024);
  const fake = await server((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      if (j.model === 'leak') { res.statusCode = 401; return res.end('{"error":"Incorrect API key provided: sk-proj-ABCDEFGHIJKLMNOPQRSTUV and AIzaSyA1234567890abcdefghijklmnopq and gsk_abcdefghijklmnopqrstuvwx"}'); }
      if (j.stream) { res.write(`data: {"choices":[{"delta":{"content":"${'y'.repeat(1024)}"}}]}\n\n`); for (let i = 0; i < 5000; i++) res.write(`data: {"choices":[{"delta":{"content":"${'y'.repeat(1024)}"}}]}\n\n`); return res.end(); }
      res.end(JSON.stringify({ choices: [{ message: { content: big } }] }));
    });
  });
  try {
    const p = (model: string) => provider('openai', model, { OPENAI_API_KEY: 'k' }, { baseUrl: fake.url });
    await assert.rejects(chat(p('huge'), []), /too large/);
    await assert.rejects(chat(p('huge'), [], { onToken: () => {} }), /too large/);
    await assert.rejects(chat(p('leak'), []), (e: Error) => !/sk-proj-ABC|AIzaSy|gsk_abc/.test(e.message) && /\[redacted\]/.test(e.message));
  } finally { await fake.close(); }
});

test('review: the task namer gets the scrubbed env; Foundry/Azure keys are scrubbed too', () => {
  const env = engineEnv({ ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_API_KEY: 'f', AZURE_OPENAI_API_KEY: 'a', PATH: '/bin' }, { id: 'claude-code', auth: 'subscription' }, {}, '');
  assert.deepEqual(env, { PATH: '/bin' });
  const src = readFileSync(path.join(import.meta.dirname, '../src/server/workers.ts'), 'utf8');
  assert.match(src, /new TaskNamer\(claude, engineEnv\(childEnv\(\), LEGACY_ENGINE/);
});

test('review: refresh=1 is rate-floored; an invalid saved engine keeps the worker with status unknown', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-accounts-floor-'));
  try {
    let runs = 0;
    let now = 1_000_000;
    const accounts = new LinkedAccounts({ dataDir: dir, ollama: new OllamaRuntime('http://127.0.0.1:9'), keys: () => ({}), resolve: () => null, exec: async () => { runs++; return { stdout: '', stderr: '', code: 0 }; }, totalMem: () => 16 * GB, now: () => now, env: () => ({}) });
    const probes = () => accounts.state(true);
    await probes(); await probes(); await probes();
    const first = (await accounts.state()).checkedAt;
    now += 11_000;
    const later = (await probes()).checkedAt;
    assert.equal(first, 1_000_000, 'refreshes within 10 s reuse the last probe');
    assert.equal(later, 1_011_000);
    assert.equal(runs, 0);
    writeFileSync(path.join(dir, 'workers.json'), JSON.stringify([{ id: 'b1', kind: 'agent', deskId: 'desk-1', name: 'Bolt', processState: 'stopped', engine: { id: 'aider', auth: 'local' } }]));
    const { m } = manager(dir);
    try {
      const w = m.get('b1')!;
      assert.equal(w.engine, undefined, 'never silently switched to Claude');
      assert.equal(w.statusKnown, false);
      assert.match(w.activity!, /saved engine is not recognised/i);
      assert.match(m.resume('b1')!, /saved engine is not recognised/i);
    } finally { m.shutdown(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('desktop vault seals free hosted keys and reports names only', async () => {
  const { createRequire } = await import('node:module');
  const { createVault, HOSTED } = createRequire(import.meta.url)('../desktop/credential-vault.cjs');
  const fake = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s.split('').reverse().join('')), decryptString: (b: Buffer) => b.toString().split('').reverse().join('') };
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-vault-free-'));
  try {
    const vault = createVault(path.join(dir, 'vault'), fake);
    vault.save({ groqKey: 'gsk-test' });
    assert.deepEqual(HOSTED, ['openrouterKey', 'geminiKey', 'groqKey']);
    assert.equal(vault.names().groqKey, true);
    assert.equal(vault.names().openaiKey, false);
    assert.ok(!JSON.stringify(vault.names()).includes('gsk-test'));
    assert.ok(!readFileSync(path.join(dir, 'vault'), 'utf8').includes('gsk-test'));
    assert.deepEqual(vault.status(), { available: true, anthropic: false, github: false }, 'status shape unchanged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
