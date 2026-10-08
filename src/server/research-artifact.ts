import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { QueueTask } from '../shared/protocol.js';
import { BRANCH_PREFIX, WORKTREES_DIR } from './worktrees.js';

// ORG-05's copy of the shared internal-job artifact importer. It implements exactly the contract ORG-04a owns in
// src/server/artifacts.ts, so the coordinator can swap this module for that one:
//   readArtifact(task, kind, jobId) → { ok: true, frontmatter, body } | { ok: false, reason }
// The worker writes docs/empire/<kind>/<jobId>.md in its worktree. It is read from that worktree when it is still on
// disk, otherwise from the worker's branch. No symlinks, no `..`, at most 256 KB, and a strict frontmatter parse.

export type ArtifactKind = 'campaigns' | 'research';
export type ArtifactResult = { ok: true; frontmatter: Record<string, string>; body: string } | { ok: false; reason: string };

export const MAX_ARTIFACT_BYTES = 256 * 1024;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const KEY_RE = /^[a-z][A-Za-z0-9_]{0,40}$/;

export const artifactPath = (kind: ArtifactKind, jobId: string) => `docs/empire/${kind}/${jobId}.md`;

export interface ArtifactOptions {
  /** The project directory (the server's `cfg.dir`). Defaults to the current directory. */
  projectDir?: string;
}

type Raw = { ok: true; bytes: Buffer } | { ok: false; reason: string } | { ok: false; missing: true };

export function readArtifact(task: Pick<QueueTask, 'branch' | 'outcome'>, kind: ArtifactKind, jobId: string, options: ArtifactOptions = {}): ArtifactResult {
  if (kind !== 'campaigns' && kind !== 'research') return { ok: false, reason: 'Unknown artifact kind.' };
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) return { ok: false, reason: 'The job id is not a safe file name.' };
  const branch = task.branch;
  if (typeof branch !== 'string' || !branch.startsWith(BRANCH_PREFIX)) return { ok: false, reason: 'The task has no worker branch to read the report from.' };
  const slug = branch.slice(BRANCH_PREFIX.length);
  if (!BRANCH_RE.test(slug) || slug.includes('..')) return { ok: false, reason: 'The worker branch name is not safe to read.' };
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const rel = artifactPath(kind, jobId);

  let raw = fromWorktree(projectDir, slug, rel);
  if ('missing' in raw) raw = fromBranch(projectDir, branch, rel);
  if ('missing' in raw) return { ok: false, reason: `The worker did not write ${rel}.` };
  if (!raw.ok) return raw;
  return parseArtifact(raw.bytes);
}

/** The worker's worktree, when it is still on disk. Every path component is checked: no symlink anywhere. */
function fromWorktree(projectDir: string, slug: string, rel: string): Raw {
  const root = path.join(projectDir, WORKTREES_DIR, slug);
  let rootStat;
  try { rootStat = lstatSync(root); } catch { return { ok: false, missing: true }; }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { ok: false, reason: 'The worker worktree is not a plain folder.' };
  let current = root;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let st;
    try { st = lstatSync(current); } catch { return { ok: false, missing: true }; }
    if (st.isSymbolicLink()) return { ok: false, reason: `${rel} is or passes through a symlink; symlinks are not read.` };
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return { ok: false, reason: `${rel} is not a plain file.` };
    if (i === parts.length - 1 && st.size > MAX_ARTIFACT_BYTES) return { ok: false, reason: `${rel} is larger than 256 KB.` };
  }
  // Belt and braces: the resolved file must still be inside the resolved worktree.
  const realRoot = realpathSync(root);
  const realFile = realpathSync(current);
  if (path.relative(realRoot, realFile).startsWith('..') || path.isAbsolute(path.relative(realRoot, realFile))) return { ok: false, reason: `${rel} resolves outside the worker worktree.` };
  const bytes = readFileSync(current);
  if (bytes.length > MAX_ARTIFACT_BYTES) return { ok: false, reason: `${rel} is larger than 256 KB.` };
  return { ok: true, bytes };
}

/** The worker's committed branch, when its worktree is gone. A symlink blob (mode 120000) is refused. */
function fromBranch(projectDir: string, branch: string, rel: string): Raw {
  const git = (args: string[]) => execFileSync('git', args, { cwd: projectDir, encoding: 'buffer', maxBuffer: MAX_ARTIFACT_BYTES + 4096, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  let listing: string;
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    listing = git(['ls-tree', '-l', '-z', `refs/heads/${branch}`, '--', rel]).toString('utf8');
  } catch { return { ok: false, missing: true }; }
  const entry = listing.split('\0').find(Boolean);
  if (!entry) return { ok: false, missing: true };
  const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t(.+)$/.exec(entry);
  if (!match || match[5] !== rel) return { ok: false, reason: `${rel} could not be read from the worker branch.` };
  const [, mode, type, sha, size] = match;
  if (mode === '120000') return { ok: false, reason: `${rel} is a symlink on the worker branch; symlinks are not read.` };
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) return { ok: false, reason: `${rel} is not a plain file on the worker branch.` };
  if (Number(size) > MAX_ARTIFACT_BYTES) return { ok: false, reason: `${rel} is larger than 256 KB.` };
  try {
    return { ok: true, bytes: git(['cat-file', 'blob', sha]) };
  } catch {
    return { ok: false, reason: `${rel} could not be read from the worker branch.` };
  }
}

/**
 * Strict: UTF-8, no NUL, a leading `---` block of `key: value` lines (unique lower-camel keys, single-line values,
 * optional surrounding double quotes), then the body. Nothing is guessed.
 */
export function parseArtifact(bytes: Buffer): ArtifactResult {
  if (bytes.length > MAX_ARTIFACT_BYTES) return { ok: false, reason: 'The report is larger than 256 KB.' };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { ok: false, reason: 'The report is not valid UTF-8.' }; }
  if (text.includes('\0')) return { ok: false, reason: 'The report contains NUL bytes.' };
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { ok: false, reason: 'The report has no frontmatter (it must start with ---).' };
  const end = text.indexOf('\n---\n', 3);
  const endAtEof = text.endsWith('\n---') ? text.length - 4 : -1;
  const close = end >= 0 ? end : endAtEof;
  if (close < 0) return { ok: false, reason: 'The report frontmatter is not closed with ---.' };
  const block = text.slice(4, close);
  const body = text.slice(close + 5);
  const frontmatter: Record<string, string> = {};
  for (const [i, line] of block.split('\n').entries()) {
    if (!line.trim()) continue;
    const m = /^([^:\s]+):[ \t]*(.*)$/.exec(line);
    if (!m) return { ok: false, reason: `Frontmatter line ${i + 1} is not "key: value".` };
    const [, key, rawValue] = m;
    if (!KEY_RE.test(key)) return { ok: false, reason: `Frontmatter key "${key.slice(0, 40)}" is not allowed.` };
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) return { ok: false, reason: `Frontmatter key "${key}" appears twice.` };
    let value = rawValue.trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
    frontmatter[key] = value;
  }
  return { ok: true, frontmatter, body };
}
