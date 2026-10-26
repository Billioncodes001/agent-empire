/**
 * CHAR-02 review: a pinned archive is verified before it is cached, and a corrupt cached copy is replaced, never used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPinned } from '../tools/avatars/pinned';

const good = new TextEncoder().encode('the real archive');
const sha = createHash('sha256').update(good).digest('hex');
const serve = (bytes: Uint8Array, calls: string[]) => async (url: string) => { calls.push(url); return new Response(bytes); };

test('a download that does not match the pin is never written into the cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char02-pin-'));
  const file = join(dir, 'pack.zip'), calls: string[] = [];
  await assert.rejects(fetchPinned('https://example.test/pack.zip', sha, file, serve(new TextEncoder().encode('tampered'), calls)), /does not match/);
  assert.equal(existsSync(file), false, 'nothing cached');
});

test('a good download is cached and reused without fetching again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char02-pin-'));
  const file = join(dir, 'pack.zip'), calls: string[] = [];
  assert.deepEqual(await fetchPinned('https://example.test/pack.zip', sha, file, serve(good, calls)), good);
  assert.deepEqual(readFileSync(file), Buffer.from(good));
  await fetchPinned('https://example.test/pack.zip', sha, file, serve(good, calls));
  assert.equal(calls.length, 1);
});

test('a corrupt cached archive is deleted and downloaded again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char02-pin-'));
  const file = join(dir, 'pack.zip'), calls: string[] = [];
  writeFileSync(file, 'truncated');
  assert.deepEqual(await fetchPinned('https://example.test/pack.zip', sha, file, serve(good, calls)), good);
  assert.equal(calls.length, 1);
  assert.deepEqual(readFileSync(file), Buffer.from(good));
});

test('HTTP errors are reported and leave no file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char02-pin-'));
  const file = join(dir, 'pack.zip');
  await assert.rejects(fetchPinned('https://example.test/pack.zip', sha, file, async () => new Response('no', { status: 404 })), /HTTP 404/);
  assert.equal(existsSync(file), false);
});
