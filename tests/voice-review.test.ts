// FREE-05 security review fixes: write errors, cancel/restart races, one speech job at a time, safe extraction,
// size-only verification, kept recordings, malformed WAVs. Fakes and synthetic archives only; no real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { VoiceError, VoiceRuntime, decodeWav, encodeWav, safeExtract, systemTar, type VoiceEngines } from '../src/server/voice.js';
import type { VoiceModel } from '../src/shared/voice.js';

const withTemp = async (fn: (dir: string) => Promise<void> | void) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-voice-review-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const payload = Buffer.from('synthetic model archive — not a real model');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const model = (over: Partial<VoiceModel> = {}): VoiceModel => ({
  id: 'fake-stt', kind: 'stt', family: 'moonshine', name: 'Fake STT', sizeBytes: payload.length, sha256: sha(payload),
  licence: 'MIT', licenceUrl: 'https://example.invalid/l', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/fake.tar.bz2', source: 'https://example.invalid', note: 'fixture', ...over,
});
const okFetch = (body = payload) => (async () => new Response(new Blob([body]).stream())) as unknown as typeof fetch;
const fakeExtract = async (_a: string, dest: string) => { mkdirSync(dest, { recursive: true }); writeFileSync(path.join(dest, 'tokens.txt'), 'x'); };
const engines = (stt?: () => Promise<string>): VoiceEngines => ({
  detect: async () => ({ available: true, detail: 'fake' }),
  stt: async () => ({ transcribe: stt ?? (async () => 'hello') }),
  tts: async () => ({ synthesize: async () => ({ samples: new Float32Array(10), sampleRate: 16000 }) }),
});
const wav = (s: number) => encodeWav(new Float32Array(Math.round(s * 16000)).fill(0.1), 16000);
/** A stream that never ends until released, and closes when aborted. */
function slowFetch() {
  let release = () => {};
  const f = (async (_u: string, init?: RequestInit) => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(payload.subarray(0, 4))); init?.signal?.addEventListener('abort', () => { try { c.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } }); },
    pull() { return new Promise<void>((r) => { release = r; }); },
  }))) as unknown as typeof fetch;
  return { f, release: () => release() };
}

test('a failing disk write (ENOSPC) fails the download cleanly instead of crashing or hanging', () => withTemp(async (dir) => {
  const failing = () => new Writable({ write(_c, _e, cb) { cb(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })); } });
  const v = new VoiceRuntime({ dataDir: dir, catalogue: [model()], engines: engines(), fetch: okFetch(), extract: fakeExtract, openWrite: failing });
  await v.startDownload('fake-stt', true).started;
  const s = await v.state();
  assert.equal(s.download?.done, true);
  assert.match(s.download?.error ?? '', /no space left|could not be saved/i);
  assert.equal(s.models[0].installed, false);
  assert.deepEqual(readdirSync(path.join(dir, 'voice')).filter((f) => /\.(part|tmp)/.test(f)), []);
}));

test('cancel then restart: a new download waits until the cancelled one has stopped, then installs', () => withTemp(async (dir) => {
  const slow = slowFetch();
  let calls = 0;
  const fetcher = (async (u: string, init?: RequestInit) => (++calls === 1 ? slow.f(u, init) : okFetch()())) as unknown as typeof fetch;
  const v = new VoiceRuntime({ dataDir: dir, catalogue: [model()], engines: engines(), fetch: fetcher, extract: fakeExtract });
  const first = v.startDownload('fake-stt', true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(v.cancelDownload(), true);
  assert.match(v.startDownload('fake-stt', true).error ?? '', /stopping|still/i, 'no overlap with the stopping download');
  await first.started;
  assert.equal((await v.state()).download?.cancelled, true);
  const second = v.startDownload('fake-stt', true);
  assert.equal(second.error, undefined);
  await second.started;
  assert.equal((await v.state()).models[0].installed, true);
}));

test('cancel during unpacking does not install', () => withTemp(async (dir) => {
  let unpacking!: () => void; const reached = new Promise<void>((r) => { unpacking = r; });
  let finish!: () => void; const gate = new Promise<void>((r) => { finish = r; });
  const extract = async (_a: string, dest: string) => { unpacking(); await gate; mkdirSync(dest, { recursive: true }); writeFileSync(path.join(dest, 'tokens.txt'), 'x'); };
  const v = new VoiceRuntime({ dataDir: dir, catalogue: [model()], engines: engines(), fetch: okFetch(), extract });
  const r = v.startDownload('fake-stt', true);
  await reached;
  v.cancelDownload();
  finish();
  await r.started;
  const s = await v.state();
  assert.equal(s.models[0].installed, false);
  assert.equal(s.download?.cancelled, true);
}));

test('one speech job at a time: a second transcription while busy gets 429', () => withTemp(async (dir) => {
  let release!: () => void;
  const v = new VoiceRuntime({ dataDir: dir, catalogue: [model()], engines: engines(() => new Promise<string>((r) => { release = () => r('done'); })), fetch: okFetch(), extract: fakeExtract });
  await v.startDownload('fake-stt', true).started;
  const a = v.transcribe(wav(1));
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(v.transcribe(wav(1)), (e: VoiceError) => e.status === 429 && /busy/i.test(e.message));
  await assert.rejects(v.speak('hi'), (e: VoiceError) => e.status === 429 || e.status === 409);
  release();
  assert.equal((await a).text, 'done');
  release = () => {};
}));

test('a model without a published checksum needs a second confirmation; its digest is recorded and a change is flagged', () => withTemp(async (dir) => {
  const m = model({ sha256: undefined, note: 'size is verified' });
  let body = payload;
  const v = new VoiceRuntime({ dataDir: dir, catalogue: [m], engines: engines(), fetch: (async () => new Response(new Blob([body]).stream())) as unknown as typeof fetch, extract: fakeExtract });
  assert.match(v.startDownload('fake-stt', true).error ?? '', /no published checksum/i);
  await v.startDownload('fake-stt', true, true).started;
  const installed = JSON.parse(readFileSync(path.join(dir, 'voice', 'models', 'fake-stt', 'installed.json'), 'utf8'));
  assert.equal(installed.sha256, sha(payload));
  assert.equal(installed.verified, 'size');
  v.remove('fake-stt');
  body = Buffer.from(payload); body[3] ^= 1; // same size, different bytes
  await v.startDownload('fake-stt', true, true).started;
  assert.match((await v.state()).download?.warning ?? '', /differs from the earlier install/);
}));

test('kept recordings can be deleted and are pruned after 30 days; the models path is not exposed', () => withTemp(async (dir) => {
  const v = new VoiceRuntime({ dataDir: dir, catalogue: [model()], engines: engines(), fetch: okFetch(), extract: fakeExtract });
  await v.startDownload('fake-stt', true).started;
  v.setKeepRecordings(true);
  await v.transcribe(wav(1));
  const rec = path.join(dir, 'voice', 'recordings');
  const old = path.join(rec, 'Told.wav'); writeFileSync(old, 'x');
  const past = new Date(Date.now() - 31 * 864e5); utimesSync(old, past, past);
  await v.transcribe(wav(1));
  assert.equal(existsSync(old), false, 'older than 30 days is pruned');
  const s = await v.state();
  assert.equal(s.keptRecordings, 2);
  assert.ok(!s.modelsDir.startsWith('/') && !s.modelsDir.includes(dir), s.modelsDir);
  assert.equal(v.deleteRecordings(), 2);
  assert.equal((await v.state()).keptRecordings, 0);
}));

test('malformed WAVs are rejected with 400, never a crash', () => {
  const good = wav(0.5);
  const huge = Buffer.from(good); huge.writeUInt32LE(0xffffffff, 16); // fmt chunk claims 4 GB
  const dataFirst = Buffer.concat([good.subarray(0, 12), Buffer.from('data'), Buffer.alloc(4), good.subarray(12, 36)]);
  const odd = Buffer.concat([good, Buffer.from([1])]); odd.writeUInt32LE(good.length - 44 + 1, 40);
  const hugeData = Buffer.from(good); hugeData.writeUInt32LE(0xfffffff0, 40);
  const tiny = good.subarray(0, 30);
  for (const [name, buf] of Object.entries({ huge, dataFirst, tiny })) assert.throws(() => decodeWav(buf), (e: VoiceError) => e instanceof VoiceError && e.status === 400, name);
  assert.equal(decodeWav(odd).samples.length, 8000, 'odd data size: whole frames only');
  assert.equal(decodeWav(hugeData).samples.length, 8000, 'data size larger than the file is clamped');
});

// ---- safe extraction with the real system tar over synthetic archives ----
const tar = systemTar();
const skip = !tar || !existsSync(tar) ? 'no system tar' : false;

test('systemTar is an absolute path, never resolved via PATH', { skip }, () => {
  assert.ok(path.isAbsolute(tar!));
});

test('safeExtract unpacks a clean archive', { skip }, () => withTemp(async (dir) => {
  const src = path.join(dir, 'src', 'model'); mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, 'tokens.txt'), 'a b c');
  const arch = path.join(dir, 'ok.tar.bz2');
  execFileSync(tar!, ['-cjf', arch, '-C', path.join(dir, 'src'), 'model']);
  const dest = path.join(dir, 'out');
  await safeExtract(arch, dest, { maxBytes: 1e6, maxFiles: 10 });
  assert.equal(readFileSync(path.join(dest, 'model', 'tokens.txt'), 'utf8'), 'a b c');
}));

test('safeExtract rejects ../ entries, symlinks and oversized content; nothing is written outside', { skip }, () => withTemp(async (dir) => {
  const inner = path.join(dir, 'build', 'inner'); mkdirSync(inner, { recursive: true });
  writeFileSync(path.join(dir, 'build', 'evil.txt'), 'escape');
  const traversal = path.join(dir, 'traversal.tar.bz2');
  execFileSync(tar!, ['-cjPf', traversal, '../evil.txt'], { cwd: inner });
  assert.match(execFileSync(tar!, ['-tjf', traversal]).toString(), /\.\.\/evil\.txt/, 'the crafted archive really contains ../');
  const linkDir = path.join(dir, 'linksrc'); mkdirSync(linkDir);
  symlinkSync('/etc/hosts', path.join(linkDir, 'hosts'));
  const link = path.join(dir, 'link.tar.bz2');
  execFileSync(tar!, ['-cjf', link, '-C', linkDir, 'hosts']);
  const bigDir = path.join(dir, 'bigsrc'); mkdirSync(bigDir);
  writeFileSync(path.join(bigDir, 'big.bin'), Buffer.alloc(2_000_000));
  const big = path.join(dir, 'big.tar.bz2');
  execFileSync(tar!, ['-cjf', big, '-C', bigDir, 'big.bin']);
  const out = path.join(dir, 'x', 'out');
  await assert.rejects(safeExtract(traversal, out, { maxBytes: 1e6, maxFiles: 10 }), /unsafe path/i);
  await assert.rejects(safeExtract(link, out, { maxBytes: 1e6, maxFiles: 10 }), /link|not a regular file/i);
  await assert.rejects(safeExtract(big, out, { maxBytes: 1e6, maxFiles: 10 }), /too large/i);
  assert.equal(existsSync(path.join(dir, 'x', 'evil.txt')), false);
  assert.equal(existsSync(out) ? readdirSync(out).length : 0, 0, 'nothing unpacked');
}));
