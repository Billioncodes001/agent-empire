// Round 2 shared contract (ORG-04a campaigns, ORG-05 research): an internal job's worker writes one markdown file with
// strict frontmatter at a fixed path in its worktree. When the task finishes with outcome 'done', the server reads it
// here, confined to the task's worktree (or its branch, or the project folder for a task without a worktree).
//
// API (keep it small; both slices build on it):
//   readArtifact(projectDir, task, kind, jobId) → { ok: true, frontmatter, body, source, path } | { ok: false, reason }
//   parseArtifact(text | bytes) → the same result for content already in hand (bytes: size cap and strict UTF-8)
//   artifactPath(kind, jobId) → "docs/empire/<kind>/<jobId>.md", the path a prompt tells the worker to write
//
// Frontmatter is a strict YAML subset: `key: value` scalars (optionally "double" or 'single' quoted), inline lists
// `key: [a, b]`, and block lists (`key:` followed by `  - item` lines). Keys are unique; anything else is an error with
// its line number. Kind-specific fields (subject, question, …) are validated by the caller. Nothing is ever guessed: a
// missing, oversized, symlinked or malformed file is `{ ok: false, reason }`, which callers show as "needs attention".

import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { QueueTask } from '../shared/protocol.js';
import { BRANCH_PREFIX, WORKTREES_DIR } from './worktrees.js';
// FREE-07: the strict parser is shared with the cloud coordinator, which reads the same file from the task branch.
import { MAX_ARTIFACT_BYTES, parseArtifact, type Frontmatter, type ParsedArtifact } from '../shared/artifact-parse.js';
export { MAX_ARTIFACT_BYTES, parseArtifact, type Frontmatter, type ParsedArtifact };

export type ArtifactKind = 'campaigns' | 'research';
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['campaigns', 'research'];
/** Consultancy job ids are the only names an artifact file may have. */
export const ARTIFACT_JOB_ID_RE = /^consultancy-[a-f0-9]{12}$/;

export type ArtifactSource = 'worktree' | 'branch' | 'project';
export type ArtifactResult = ({ ok: true; frontmatter: Frontmatter; body: string; source: ArtifactSource; path: string }) | { ok: false; reason: string };
/** What the reader needs from a queue task. */
export type ArtifactTask = Pick<QueueTask, 'status' | 'outcome' | 'branch'>;

/** Tests only: runs between the checks and the open, to simulate a worker swapping the file or a folder. */
export const artifactTestHooks: { beforeOpen?: (file: string) => void } = {};

export const artifactPath = (kind: ArtifactKind, jobId: string) => `docs/empire/${kind}/${jobId}.md`;

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** Reads and parses one job's artifact for a finished task. Never throws. */
export function readArtifact(projectDir: string, task: ArtifactTask, kind: ArtifactKind, jobId: string): ArtifactResult {
  try {
    if (!ARTIFACT_KINDS.includes(kind)) return fail(`Unknown artifact kind: ${String(kind)}`);
    if (!ARTIFACT_JOB_ID_RE.test(jobId)) return fail('The job id is not a consultancy job id');
    if (task.status !== 'done' || task.outcome !== 'done') return fail('The task has not finished with outcome done');
    const rel = artifactPath(kind, jobId);
    let read: { ok: true; bytes: Buffer; source: ArtifactSource } | { ok: false; reason: string };
    if (task.branch) {
      if (!task.branch.startsWith(BRANCH_PREFIX)) return fail('The task branch is not a worker branch');
      const slug = task.branch.slice(BRANCH_PREFIX.length);
      if (!SLUG.test(slug) || slug.includes('..')) return fail('The task branch name is not safe to read');
      const worktree = path.join(projectDir, WORKTREES_DIR, slug);
      const wt = statOrUndefined(worktree);
      if (wt && !wt.isSymbolicLink() && wt.isDirectory()) read = readConfined(worktree, rel, 'worktree');
      else if (wt) return fail('The task worktree is not a plain folder');
      else read = readFromBranch(projectDir, task.branch, rel);
    } else {
      read = readConfined(projectDir, rel, 'project');
    }
    if (!read.ok) return read;
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes); } catch { return fail(`${rel} is not valid UTF-8`); }
    const parsed = parseArtifact(text);
    return parsed.ok ? { ...parsed, source: read.source, path: rel } : fail(`${rel}: ${parsed.reason}`);
  } catch (error) {
    return fail(`The artifact could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
}

function statOrUndefined(p: string) {
  try { return lstatSync(p); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** Walks `rel` below `root` one component at a time: no symlink anywhere, folders then one regular file, within the cap. */
function readConfined(root: string, rel: string, source: ArtifactSource): { ok: true; bytes: Buffer; source: ArtifactSource } | { ok: false; reason: string } {
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return fail('The artifact path is not confined');
  let cur = root;
  let checked: { dev: number; ino: number } | undefined;
  for (const [i, part] of parts.entries()) {
    cur = path.join(cur, part);
    const st = statOrUndefined(cur);
    if (!st) return fail(`${rel} is missing — the worker did not write it`);
    if (st.isSymbolicLink()) return fail(`${rel} goes through a symlink (${parts.slice(0, i + 1).join('/')}); symlinks are refused`);
    const last = i === parts.length - 1;
    if (!last && !st.isDirectory()) return fail(`${rel}: ${parts.slice(0, i + 1).join('/')} is not a folder`);
    if (last && !st.isFile()) return fail(`${rel} is not a regular file`);
    if (last && st.size > MAX_ARTIFACT_BYTES) return fail(`${rel} is larger than ${MAX_ARTIFACT_BYTES / 1024} KB`);
    if (last) checked = { dev: st.dev, ino: st.ino };
  }
  // Belt and braces: the resolved file is inside the resolved root.
  const realRoot = realpathSync(root);
  const realFile = realpathSync(cur);
  const inside = path.relative(realRoot, realFile);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return fail(`${rel} resolves outside the task folder`);
  // A still-running worker may swap the file or a parent folder between the checks and the read. Open without
  // following a symlink and without blocking (a FIFO must never hang the server), then require the very file checked.
  artifactTestHooks.beforeOpen?.(cur);
  let fd: number;
  try { fd = openSync(cur, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch { return fail(`${rel} changed while it was read`); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== checked!.dev || st.ino !== checked!.ino) return fail(`${rel} changed while it was read`);
    if (st.size > MAX_ARTIFACT_BYTES) return fail(`${rel} is larger than ${MAX_ARTIFACT_BYTES / 1024} KB`);
    // Never more than the cap plus one byte, whatever the file grows to meanwhile.
    const bytes = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
    let off = 0;
    while (off < bytes.length) {
      const n = readSync(fd, bytes, off, bytes.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    if (off > MAX_ARTIFACT_BYTES) return fail(`${rel} is larger than ${MAX_ARTIFACT_BYTES / 1024} KB`);
    return { ok: true, bytes: bytes.subarray(0, off), source };
  } finally {
    closeSync(fd);
  }
}

/** The committed file on the worker's branch, when its worktree is gone: a plain blob only (a symlink is mode 120000). */
function readFromBranch(projectDir: string, branch: string, rel: string): { ok: true; bytes: Buffer; source: ArtifactSource } | { ok: false; reason: string } {
  const git = (args: string[], maxBuffer = 64 * 1024) => execFileSync('git', args, { cwd: projectDir, maxBuffer, timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
  try { git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]); } catch { return fail(`The task's worktree and branch ${branch} are both gone, so ${rel} cannot be read`); }
  const listing = git(['ls-tree', '-z', '--long', `refs/heads/${branch}`, '--', rel]).toString('utf8').split('\0').filter(Boolean);
  const entry = listing.find((line) => line.split('\t')[1] === rel);
  if (!entry) return fail(`${rel} is missing on branch ${branch} — the worker did not commit it`);
  const [meta] = entry.split('\t');
  const [mode, type, object, size] = meta.trim().split(/\s+/);
  if (mode === '120000') return fail(`${rel} is a symlink on branch ${branch}; symlinks are refused`);
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || !/^[0-9a-f]{40,64}$/.test(object)) return fail(`${rel} is not a regular file on branch ${branch}`);
  if (!(Number(size) <= MAX_ARTIFACT_BYTES)) return fail(`${rel} is larger than ${MAX_ARTIFACT_BYTES / 1024} KB`);
  const bytes = git(['cat-file', 'blob', object], MAX_ARTIFACT_BYTES + 1);
  if (bytes.length > MAX_ARTIFACT_BYTES) return fail(`${rel} is larger than ${MAX_ARTIFACT_BYTES / 1024} KB`);
  return { ok: true, bytes, source: 'branch' };
}

