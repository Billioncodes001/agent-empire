// FREE-05 HTTP surface on a real office server with fake speech engines: auth, upload limits, sent-once transcripts,
// the chief call routed to the rule-based briefing or to a *pending* plan. No worker, model, network or audio device.
import test from 'node:test';
import { scryptSync } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/server.js';
import { Auth } from '../src/server/auth.js';
import { encodeWav, type VoiceEngines } from '../src/server/voice.js';
import type { Config } from '../src/server/config.js';
import type { WorkerRuntime } from '../src/server/workers.js';
import { MAX_AUDIO_BYTES, VOICE_MODELS } from '../src/shared/voice.js';

const sttCalls: number[] = [];
const engines: VoiceEngines = {
  detect: async () => ({ available: true, detail: 'fake' }),
  stt: async () => ({ transcribe: async (s) => { sttCalls.push(s.length); return 'new job: draft the welcome email'; } }),
  tts: async () => ({ synthesize: async () => ({ samples: new Float32Array(800), sampleRate: 24000 }) }),
};

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-voice-server-'));
  writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ tasks: [], maxWorkers: 0 }));
  // Pretend Moonshine Tiny and Kokoro were installed earlier (a marker only; the fake engines never read files).
  for (const id of ['moonshine-tiny-en', 'kokoro-en-int8']) { mkdirSync(path.join(dir, 'voice', 'models', id), { recursive: true }); writeFileSync(path.join(dir, 'voice', 'models', id, 'installed.json'), '{}'); }
  const cfg: Config = { dir, dataDir: dir, host: '127.0.0.1', port: 0, passwordGenerated: false, verifier: scryptSync('fixture-password', Buffer.alloc(16, 2), 32), salt: Buffer.alloc(16, 2), secret: 'fixture-only-secret', claimed: true, markClaimed() {}, agentCmd: 'claude', agentArgs: [], trustProxy: false, iceServers: [], budgetPause: false };
  const runtime: WorkerRuntime = { taskNaming: false, resolveCommand: () => '/fixture/claude', processExists: () => false, spawn: (() => { throw new Error('no worker may start in this test'); }) as WorkerRuntime['spawn'] };
  const fetches: string[] = [];
  const running = await startServer(cfg, { publicDir: dir, backgroundServices: false, workers: runtime, telegram: false, email: false,
    voice: { engines, fetch: (async (u: string) => { fetches.push(String(u)); return new Response('x'); }) as unknown as typeof fetch } });
  const port = (running.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const cookie = `ao_session_${port}=${new Auth(cfg.verifier, cfg.salt, cfg.secret).issue()}`;
  t.after(async () => {
    await new Promise<void>((resolve) => { running.server.once('close', () => resolve()); running.shutdown(); });
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (route: string, body?: unknown, headers: Record<string, string> = { cookie, origin }, type = 'application/json') => fetch(`${origin}${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'content-type': type },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { call, cookie, fetches };
}

const wav = (seconds: number) => encodeWav(new Float32Array(Math.round(seconds * 16000)).fill(0.1), 16000);

test('voice and phone endpoints require sign-in, and a same-origin Origin for changes', async (t) => {
  const f = await fixture(t);
  for (const route of ['/api/voice', '/api/phone/chief']) assert.equal((await f.call(route, route === '/api/voice' ? undefined : {}, {})).status, 401, route);
  assert.equal((await f.call('/api/voice/transcribe', wav(1), {}, 'audio/wav')).status, 401);
  assert.equal((await f.call('/api/voice/transcribe', wav(1), { cookie: f.cookie }, 'audio/wav')).status, 403, 'a cookie without Origin cannot upload');
  assert.equal((await f.call('/api/voice/download', { model: 'moonshine-base-en', confirm: true }, { cookie: f.cookie })).status, 403);
  assert.equal((await f.call('/api/phone/chief', { text: 'status' }, { cookie: f.cookie })).status, 403);
  assert.equal(sttCalls.length, 0);
});

test('state lists the catalogue with sizes and licences; downloads need confirmation', async (t) => {
  const f = await fixture(t);
  const s = await (await f.call('/api/voice')).json();
  assert.equal(s.models.length, VOICE_MODELS.length);
  assert.deepEqual(s.selected, { stt: 'moonshine-tiny-en', tts: 'kokoro-en-int8' });
  assert.deepEqual(s.ready, { stt: true, tts: true });
  assert.ok(s.models.every((m: any) => m.sizeBytes > 0 && m.licence && m.url));
  assert.equal((await f.call('/api/voice/download', { model: 'moonshine-base-en' })).status, 400);
  assert.deepEqual(f.fetches, [], 'nothing fetched without confirmation');
});

test('push-to-talk: bounded upload, transcript confirmed once, routed to a pending plan that is never approved', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/voice/transcribe', Buffer.alloc(MAX_AUDIO_BYTES + 10), undefined, 'audio/wav')).status, 413, 'oversized upload refused');
  assert.equal((await f.call('/api/voice/transcribe', wav(31), undefined, 'audio/wav')).status, 413, 'over 30 s refused');
  assert.equal((await f.call('/api/voice/transcribe', Buffer.from('nope'), undefined, 'audio/wav')).status, 400);
  const tr = await (await f.call('/api/voice/transcribe', wav(1), undefined, 'audio/wav')).json();
  assert.equal(tr.text, 'new job: draft the welcome email');
  assert.equal(tr.status, 'pending');
  const sent = await f.call(`/api/voice/transcripts/${tr.id}/send`, {});
  assert.equal(sent.status, 200);
  const reply = await sent.json();
  assert.equal(reply.kind, 'new_job');
  assert.match(reply.text, /Nothing starts before you approve/);
  assert.equal((await f.call(`/api/voice/transcripts/${tr.id}/send`, {})).status, 409, 'a transcript is sent once');
  const jobs = (await (await f.call('/api/consultancy/jobs')).json()).jobs;
  assert.equal(jobs.length, 1, 'exactly one plan');
  assert.equal(jobs[0].decision, 'pending_approval', 'never auto-approved');
  const inbox = await (await f.call('/api/approvals')).json();
  assert.equal(inbox.items[0].kind, 'job_plan');
  assert.equal(inbox.items[0].status, 'pending');
  const other = await (await f.call('/api/voice/transcribe', wav(1), undefined, 'audio/wav')).json();
  assert.equal((await f.call(`/api/voice/transcripts/${other.id}/cancel`, {})).status, 200);
  assert.equal((await f.call(`/api/voice/transcripts/${other.id}/send`, {})).status, 409, 'cancelled is never sent');
});

test('the chief call answers with the rule-based report; speech output is a WAV', async (t) => {
  const f = await fixture(t);
  const r = await (await f.call('/api/phone/chief', { text: '', requestId: 'call-1' })).json();
  assert.equal(r.kind, 'briefing');
  assert.equal(r.source, 'rule_based');
  assert.equal(r.label, 'Rule-based report');
  assert.match(r.text, /Chief of staff: No chief appointed/);
  assert.match(r.text, /Nothing is waiting for your approval/);
  assert.equal((await f.call('/api/phone/chief', { text: 'x'.repeat(5000), requestId: 'call-2' })).status, 200, 'long text is truncated, not an error');
  const speak = await f.call('/api/voice/speak', { text: r.text });
  assert.equal(speak.status, 200);
  assert.equal(speak.headers.get('content-type'), 'audio/wav');
  assert.equal(Buffer.from(await speak.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
});
