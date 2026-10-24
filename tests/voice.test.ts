// FREE-05: offline voice runtime, chief briefing and the chief call. Fakes only: no real model, no network, no audio
// device. The download tests serve synthetic bytes through an injected fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VoiceError, VoiceRuntime, decodeWav, encodeWav, type VoiceEngines } from '../src/server/voice.js';
import { routeChief, ruleBasedBriefing } from '../src/server/chief-briefing.js';
import { MAX_AUDIO_SECONDS, VOICE_MODELS, parseChiefRequest, type VoiceModel } from '../src/shared/voice.js';
import { projectOrg } from '../src/server/org.js';
import type { Approval } from '../src/shared/approvals.js';
import type { SupervisionState } from '../src/shared/empire.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const withTemp = async (fn: (dir: string) => Promise<void> | void) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-voice-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

const payload = Buffer.from('synthetic model archive — not a real model');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const model = (over: Partial<VoiceModel> = {}): VoiceModel => ({
  id: 'fake-stt', kind: 'stt', family: 'moonshine', name: 'Fake STT', sizeBytes: payload.length, sha256: sha(payload),
  licence: 'MIT', licenceUrl: 'https://example.invalid/licence', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/fake.tar.bz2',
  source: 'https://example.invalid', note: 'fixture', ...over,
});
const fakeFetch = (body: Buffer, calls: string[] = []) => (async (url: string | URL) => {
  calls.push(String(url));
  return new Response(new Blob([body]).stream(), { status: 200, headers: { 'content-length': String(body.length) } });
}) as typeof fetch;
const fakeExtract = async (_archive: string, dest: string) => { mkdirSync(dest, { recursive: true }); writeFileSync(path.join(dest, 'tokens.txt'), 'fake'); };

function fakeEngines(heard = 'What is the status of the office?', log: string[] = []): VoiceEngines {
  return {
    detect: async () => ({ available: true, detail: 'Fake speech runtime (tests).' }),
    stt: async (m) => ({ transcribe: async (samples, rate) => { log.push(`stt ${m.id} ${samples.length}@${rate}`); return heard; } }),
    tts: async (m) => ({ synthesize: async (text) => { log.push(`tts ${m.id} ${text.length}`); return { samples: new Float32Array(1600), sampleRate: 24000 }; } }),
  };
}

const tone = (seconds: number, rate = 16000) => {
  const s = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < s.length; i++) s[i] = Math.sin(i / 8) * 0.3;
  return encodeWav(s, rate);
};

test('the catalogue pins official sherpa-onnx release URLs, sizes, licences and sha256 where published', () => {
  for (const m of VOICE_MODELS) {
    assert.match(m.url, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/(asr|tts)-models\/[\w.-]+\.tar\.bz2$/);
    assert.ok(m.sizeBytes > 1e6 && Number.isInteger(m.sizeBytes));
    assert.ok(['MIT', 'Apache-2.0'].includes(m.licence), `${m.id} licence`);
    if (m.sha256) assert.match(m.sha256, /^[0-9a-f]{64}$/);
    else assert.match(m.note, /size is verified/i, `${m.id} documents the missing checksum`);
  }
  assert.ok(VOICE_MODELS.some((m) => m.kind === 'stt' && m.family === 'moonshine'));
  assert.ok(VOICE_MODELS.some((m) => m.kind === 'stt' && m.family === 'whisper'));
  assert.ok(VOICE_MODELS.some((m) => m.kind === 'tts' && m.family === 'kokoro'));
  assert.ok(!VOICE_MODELS.some((m) => /piper/i.test(m.url)), 'no Piper engine (GPL)');
});

test('nothing downloads without explicit confirmation, and only catalogue models', () => withTemp(async (dir) => {
  const calls: string[] = [];
  const v = new VoiceRuntime({ dataDir: dir, catalogue: [model()], engines: fakeEngines(), fetch: fakeFetch(payload, calls), extract: fakeExtract });
  const state = await v.state();
  assert.equal(state.models[0].installed, false);
  assert.equal(state.download, undefined, 'no download starts on its own');
  assert.match(v.startDownload('fake-stt', undefined).error ?? '', /explicit confirmation/);
  assert.match(v.startDownload('fake-stt', 'yes').error ?? '', /explicit confirmation/);
  assert.match(v.startDownload('https://evil.example/x', true).error ?? '', /listed/);
  assert.deepEqual(calls, [], 'no network request without confirmation');
  const r = v.startDownload('fake-stt', true);
  assert.equal(r.error, undefined);
  await r.started;
  assert.deepEqual(calls, [model().url]);
  const after = await v.state();
  assert.equal(after.download?.done, true);
  assert.equal(after.download?.error, undefined);
  assert.equal(after.models[0].installed, true);
  assert.equal(after.selected.stt, 'fake-stt', 'the first installed model is selected');
  assert.ok(!readdirSync(path.join(dir, 'voice')).some((f) => f.endsWith('.part')), 'the archive is removed after extraction');
}));

test('a checksum mismatch is rejected and nothing is installed', () => withTemp(async (dir) => {
  const tampered = Buffer.from(payload); tampered[0] ^= 1;
  const v = new VoiceRuntime({ dataDir: dir, catalogue: [model()], engines: fakeEngines(), fetch: fakeFetch(tampered), extract: fakeExtract });
  await v.startDownload('fake-stt', true).started;
  const s = await v.state();
  assert.match(s.download?.error ?? '', /checksum/i);
  assert.equal(s.models[0].installed, false);
  assert.ok(!existsSync(path.join(dir, 'voice', 'models', 'fake-stt')));
}));

test('without a published checksum the exact size is verified; a wrong size is rejected', () => withTemp(async (dir) => {
  const v = new VoiceRuntime({ dataDir: dir, catalogue: [model({ sha256: undefined, sizeBytes: payload.length + 5 })], engines: fakeEngines(), fetch: fakeFetch(payload), extract: fakeExtract });
  await v.startDownload('fake-stt', true, true).started;
  const s = await v.state();
  assert.match(s.download?.error ?? '', /size/i);
  assert.equal(s.models[0].installed, false);
}));

test('a download can be cancelled', () => withTemp(async (dir) => {
  let release!: () => void;
  const slow = (async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(payload.subarray(0, 4))); },
    pull() { return new Promise<void>((r) => { release = r; }); },
  }), { headers: { 'content-length': String(payload.length) } })) as unknown as typeof fetch;
  const v = new VoiceRuntime({ dataDir: dir, catalogue: [model()], engines: fakeEngines(), fetch: slow, extract: fakeExtract });
  const r = v.startDownload('fake-stt', true);
  await new Promise((res) => setTimeout(res, 30));
  assert.match(v.startDownload('fake-stt', true).error ?? '', /still downloading/);
  assert.equal(v.cancelDownload(), true);
  release?.();
  await r.started;
  const s = await v.state();
  assert.equal(s.download?.cancelled, true);
  assert.equal(s.models[0].installed, false);
}));

test('transcription: bounded audio, local fake engine, audio not kept, transcript sent once', () => withTemp(async (dir) => {
  const log: string[] = [];
  const v = new VoiceRuntime({ dataDir: dir, catalogue: [model()], engines: fakeEngines('What is the status of the office?', log), fetch: fakeFetch(payload), extract: fakeExtract });
  await assert.rejects(v.transcribe(tone(1)), (e: VoiceError) => e.status === 409 && /speech-to-text model/.test(e.message));
  await v.startDownload('fake-stt', true).started;
  await assert.rejects(v.transcribe(Buffer.from('not a wav')), (e: VoiceError) => e.status === 400);
  await assert.rejects(v.transcribe(tone(MAX_AUDIO_SECONDS + 1)), (e: VoiceError) => e.status === 413);
  const t = await v.transcribe(tone(1.5));
  assert.equal(t.text, 'What is the status of the office?');
  assert.equal(t.status, 'pending');
  assert.deepEqual(log, ['stt fake-stt 24000@16000']);
  assert.ok(!existsSync(path.join(dir, 'voice', 'recordings')), 'no audio is stored by default');
  assert.equal(v.takeTranscript(t.id).status, 'sent');
  assert.throws(() => v.takeTranscript(t.id), (e: VoiceError) => e.status === 409, 'a transcript is sent once');
  const c = await v.transcribe(tone(1));
  v.cancelTranscript(c.id);
  assert.throws(() => v.takeTranscript(c.id), (e: VoiceError) => e.status === 409, 'a cancelled transcript is never sent');
  assert.throws(() => v.takeTranscript('nope'), (e: VoiceError) => e.status === 404);
  v.setKeepRecordings(true);
  await v.transcribe(tone(1));
  assert.equal(readdirSync(path.join(dir, 'voice', 'recordings')).length, 1, 'kept only after the user opts in');
}));

test('speech output needs an installed voice, and is a WAV', () => withTemp(async (dir) => {
  const tts = model({ id: 'fake-tts', kind: 'tts', family: 'kokoro', name: 'Fake TTS' });
  const v = new VoiceRuntime({ dataDir: dir, catalogue: [model(), tts], engines: fakeEngines(), fetch: fakeFetch(payload), extract: fakeExtract });
  await assert.rejects(v.speak('Hello'), (e: VoiceError) => e.status === 409);
  await v.startDownload('fake-tts', true).started;
  const wav = await v.speak('Hello');
  const back = decodeWav(wav);
  assert.equal(back.sampleRate, 24000);
  assert.equal(back.samples.length, 1600);
  await assert.rejects(v.speak(''), (e: VoiceError) => e.status === 400);
}));

test('without the optional sherpa-onnx package the runtime says so and text still works', () => withTemp(async (dir) => {
  const v = new VoiceRuntime({ dataDir: dir, catalogue: [model()], engines: { detect: async () => ({ available: false, detail: 'sherpa-onnx-node is not installed.' }), stt: async () => { throw new Error('unavailable'); }, tts: async () => { throw new Error('unavailable'); } }, fetch: fakeFetch(payload), extract: fakeExtract });
  const s = await v.state();
  assert.equal(s.runtime.available, false);
  assert.equal(s.ready.stt, false);
  assert.equal(s.ready.tts, false);
}));

test('parseChiefRequest: "new job: …" creates a plan request; anything else is a question', () => {
  assert.deepEqual(parseChiefRequest('New job: build a landing page for Acme'), { kind: 'new_job', title: 'Build a landing page for Acme', brief: 'build a landing page for Acme' });
  assert.equal(parseChiefRequest('new job').kind, 'needs_text');
  assert.deepEqual(parseChiefRequest('How much did we spend today?'), { kind: 'briefing', question: 'How much did we spend today?' });
  assert.deepEqual(parseChiefRequest(''), { kind: 'briefing' });
  assert.equal(parseChiefRequest('x'.repeat(5000)).kind, 'briefing');
});

// ---- the chief briefing: truthful, from fixture state ----
const supervision: SupervisionState = { schemaVersion: 1, serverRunId: 'run', observedAt: 1, delegationRequested: true, monitor: { mode: 'rule_based', lastCheckAt: 1 }, chief: { phase: 'working' }, workforce: { active: 2, attention: 1, queued: 3 } };
const worker = (id: string, status: WorkerInfo['status']): WorkerInfo => ({ id, kind: 'agent', deskId: 'desk-2', name: id, color: '#fff', status, processState: 'running' } as WorkerInfo);
const pending: Approval = { id: 'A4', kind: 'job_plan', status: 'pending', raisedBy: 'chief_of_staff', title: 'Acme portal', detail: '', createdAt: 1, jobId: 'consultancy-1' } as Approval;
const fixtureInput = () => {
  const org = projectOrg({ now: 1, supervision, workers: [worker('w1', 'working'), worker('w2', 'needs_input')], queue: { tasks: [], maxWorkers: 2 }, jobs: [], usage: { total: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, calls: 0 }, today: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 1.25, calls: 3 }, day: '2026-10-24', pauseHiring: false, budget: 10 }, approvals: [pending] });
  return { now: Date.UTC(2026, 9, 24, 9, 30), org, approvals: [pending], capacity: '4 funded workstations · 2 running workers' };
};

test('ruleBasedBriefing reports only what the office state shows, labelled rule-based', () => {
  const b = ruleBasedBriefing(fixtureInput());
  assert.equal(b.source, 'rule_based');
  assert.match(b.text, /Working · 2 active · 1 needs input/);
  assert.match(b.text, /Today \$1\.25 of \$10\.00 daily budget/);
  assert.match(b.text, /A4/);
  assert.match(b.text, /4 funded workstations/);
  const money = ruleBasedBriefing(fixtureInput(), 'How much did we spend today?');
  assert.match(money.text, /Finance/);
  assert.doesNotMatch(money.text, /Operations/, 'a focused question gets the matching report');
  const odd = ruleBasedBriefing(fixtureInput(), 'Will it rain tomorrow?');
  assert.match(odd.text, /only report what the office records show/);
});

test('routeChief: questions get the briefing; "new job" creates a pending plan, never approved', async () => {
  const created: string[] = [];
  const deps = {
    briefing: async (q?: string) => ruleBasedBriefing(fixtureInput(), q),
    createJob: (title: string, brief: string, requestId: string) => { created.push(`${requestId}|${title}|${brief}`); return { jobId: 'consultancy-9', approvalId: 'A5' }; },
  };
  const q = await routeChief('status please', deps, 'r1');
  assert.equal(q.kind, 'briefing');
  assert.equal(q.label, 'Rule-based report');
  const j = await routeChief('new job: write the onboarding guide', deps, 'r2');
  assert.equal(j.kind, 'new_job');
  assert.equal(j.approvalId, 'A5');
  assert.match(j.text, /Nothing starts before you approve/);
  assert.deepEqual(created, ['r2|Write the onboarding guide|write the onboarding guide']);
  const n = await routeChief('new job', deps, 'r3');
  assert.equal(n.kind, 'needs_text');
  assert.equal(created.length, 1);
});
