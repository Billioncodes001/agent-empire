/**
 * CLOUD-06 slice 06-3: the exact helper bytes shipped into the OpenAI sandbox, imported from a temp file and driven with
 * a fake GitHub API, fake tar and fake git. No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HELPER_SOURCE, helperBase64 } from '../src/cloud/openai-repo-helper';

const dir = mkdtempSync(join(tmpdir(), 'ae-helper-'));
const file = join(dir, 'ae-repo.mjs');
writeFileSync(file, HELPER_SOURCE);
const helper: any = await import(pathToFileURL(file).href);

const SRC = 'a'.repeat(40);
const BRANCH = 'agent-empire/task-00000000-0000-4000-8000-000000000001';
const ENV = { AE_REPO: 'fixture/repo', AE_SOURCE_COMMIT: SRC, AE_TASK_BRANCH: BRANCH, AE_GITHUB_TOKEN: 'placeholder-from-vault', AE_REPO_DIR: '/workspace/repo' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function fakeGitHub(branchHead: string | null) {
  const calls: { method: string; path: string; body?: any; auth?: string }[] = [];
  let n = 0;
  const fetch = async (url: string, init: any = {}) => {
    const path = new URL(url).pathname; const method = init.method ?? 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.authorization });
    if (path.endsWith(`/tarball/${SRC}`)) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    if (path.endsWith(`/git/commits/${SRC}`)) return json(200, { sha: SRC, tree: { sha: 't'.repeat(40) } });
    if (path.endsWith('/git/blobs')) return json(201, { sha: `blob${++n}`.padEnd(40, '0') });
    if (path.endsWith('/git/trees')) return json(201, { sha: 'e'.repeat(40) });
    if (path.endsWith(`/git/ref/heads/${BRANCH}`)) return branchHead ? json(200, { object: { sha: branchHead } }) : json(404, { message: 'Not Found' });
    if (path.endsWith('/git/commits')) return json(201, { sha: 'f'.repeat(40) });
    if (path.endsWith('/git/refs') || path.endsWith(`/git/refs/heads/${BRANCH}`)) return json(200, { ref: `refs/heads/${BRANCH}` });
    return json(404, {});
  };
  return { calls, fetch };
}
const files: Record<string, { bytes: Uint8Array; executable?: boolean; symlink?: boolean }> = {
  'src/app.ts': { bytes: new TextEncoder().encode('export const x = 1;\n') },
  'bin/run': { bytes: new TextEncoder().encode('#!/bin/sh\n'), executable: true },
  'assets/logo.png': { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]) },
};
const deps = (gh: ReturnType<typeof fakeGitHub>, changes: { path: string; deleted?: boolean }[]) => ({
  fetch: gh.fetch, read: (_d: string, p: string) => files[p], changes: () => changes,
  extract: () => {}, git: () => '',
});

test('helper: shipped inline well under the 5 MiB file limit', () => {
  assert.ok(Buffer.from(helperBase64(), 'base64').toString() === HELPER_SOURCE);
  assert.ok(HELPER_SOURCE.length < 64 * 1024);
});

test('helper fetch: downloads the pinned tarball with the vault placeholder, extracts it and records a baseline', async () => {
  const gh = fakeGitHub(null); const gitCalls: string[][] = []; let extracted: Uint8Array | undefined;
  const result = await helper.fetchRepo({ fetch: gh.fetch, extract: (a: Uint8Array) => { extracted = a; }, git: (_d: string, args: string[]) => { gitCalls.push(args); return ''; } }, ENV);
  assert.equal(result.status, 'fetched');
  assert.equal(gh.calls[0].path, `/repos/fixture/repo/tarball/${SRC}`);
  assert.equal(gh.calls[0].auth, 'Bearer placeholder-from-vault');
  assert.deepEqual([...extracted!], [1, 2, 3]);
  assert.deepEqual(gitCalls.map(a => a.includes('commit') ? 'commit' : a[0]), ['init', 'add', 'commit', 'tag']);
});

test('helper publish: first publish creates the task ref from a commit whose parent is the source commit; binary, executable and deleted files', async () => {
  const gh = fakeGitHub(null);
  const result = await helper.publish(deps(gh, [{ path: 'src/app.ts' }, { path: 'bin/run' }, { path: 'assets/logo.png' }, { path: 'old.txt', deleted: true }]), ENV, 'Fix it');
  assert.equal(result.status, 'published');
  assert.equal(result.parent, SRC);
  const blobs = gh.calls.filter(c => c.path.endsWith('/git/blobs'));
  assert.equal(blobs.length, 3);
  assert.equal(Buffer.from(blobs[2].body.content, 'base64').toString('hex'), '89504e4700ff', 'binary round-trips via base64');
  const tree = gh.calls.find(c => c.path.endsWith('/git/trees'))!.body;
  assert.equal(tree.base_tree, 't'.repeat(40));
  assert.deepEqual(tree.tree.find((e: any) => e.path === 'bin/run').mode, '100755');
  assert.deepEqual(tree.tree.find((e: any) => e.path === 'old.txt'), { path: 'old.txt', mode: '100644', type: 'blob', sha: null });
  assert.deepEqual(gh.calls.find(c => c.path.endsWith('/git/commits'))!.body.parents, [SRC]);
  const ref = gh.calls.find(c => c.path.endsWith('/git/refs'))!;
  assert.deepEqual(ref.body, { ref: `refs/heads/${BRANCH}`, sha: 'f'.repeat(40) });
});

test('helper publish: a later publish fast-forwards the task branch, never forcing', async () => {
  const head = 'b'.repeat(40);
  const gh = fakeGitHub(head);
  const result = await helper.publish(deps(gh, [{ path: 'src/app.ts' }]), ENV);
  assert.equal(result.parent, head);
  const patch = gh.calls.find(c => c.method === 'PATCH')!;
  assert.equal(patch.path, `/repos/fixture/repo/git/refs/heads/${BRANCH}`);
  assert.deepEqual(patch.body, { sha: 'f'.repeat(40), force: false });
  assert.ok(!gh.calls.some(c => c.body?.force === true));
});

test('helper publish: refuses other refs, unsafe paths, symlinks and oversize changes before writing anything', async () => {
  for (const branch of ['main', 'refs/heads/main', 'agent-empire/task-x', `${BRANCH}/../main`]) {
    const gh = fakeGitHub(null);
    await assert.rejects(helper.publish(deps(gh, [{ path: 'src/app.ts' }]), { ...ENV, AE_TASK_BRANCH: branch }), /only an agent-empire\/task-<id> branch/);
    assert.equal(gh.calls.length, 0);
  }
  for (const path of ['../escape', '/etc/passwd', '.git/config', 'a/.git/hooks/x']) {
    await assert.rejects(helper.publish(deps(fakeGitHub(null), [{ path }]), ENV), /unsafe path/);
  }
  files['link'] = { bytes: new Uint8Array(), symlink: true };
  await assert.rejects(helper.publish(deps(fakeGitHub(null), [{ path: 'link' }]), ENV), /symbolic link/);
  files['big.bin'] = { bytes: new Uint8Array(helper.LIMITS.fileBytes + 1) };
  const gh = fakeGitHub(null);
  await assert.rejects(helper.publish(deps(gh, [{ path: 'big.bin' }]), ENV), /larger than/);
  assert.ok(!gh.calls.some(c => c.method !== 'GET'), 'no write before the size check fails');
  const many = Array.from({ length: helper.LIMITS.files + 1 }, (_, i) => ({ path: `f${i}` }));
  await assert.rejects(helper.publish(deps(fakeGitHub(null), many), ENV), /limit is 2000/);
  assert.deepEqual(await helper.publish(deps(fakeGitHub(null), []), ENV), { status: 'nothing_to_publish', branch: BRANCH });
});
