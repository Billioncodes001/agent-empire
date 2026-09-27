import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import type { SyncArtifactManifest } from '../shared/continuity.js';

export const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
export interface SyncReceipt {
  artifactId: string; serverId: string; commit: string; worktree: string;
  importedAt: number; conflicts: string[]; localHead: string;
}
const git = (dir: string, args: string[]) => { const output = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd: dir, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
}); return args.includes('-z') ? output : output.trim(); };
const names = (s: string) => s.split('\0').filter(Boolean);
function atomic(file: string, data: unknown) {
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}
function safeDirectory(dir: string) {
  if (existsSync(dir) && (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink())) throw new Error('Sync directory must be a real directory, not a link.');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
export function validateManifest(value: unknown, expectedServerId: string): SyncArtifactManifest {
  const m = value as SyncArtifactManifest;
  if (!m || m.schemaVersion !== 1 || m.serverId !== expectedServerId || !HASH.test(m.artifactId) || !COMMIT.test(m.commit) || !COMMIT.test(m.base) ||
      !m.bundle || m.bundle.ref !== 'HEAD' || m.bundle.sha256 !== m.artifactId || !Number.isSafeInteger(m.bundle.bytes) || m.bundle.bytes <= 0 || m.bundle.bytes > MAX_BUNDLE_BYTES ||
      m.bundle.url !== `/api/sync/artifacts/${m.artifactId}/bundle` || typeof m.branch !== 'string' || typeof m.workerId !== 'string') throw new Error('Invalid artifact manifest or unexpected host identity.');
  return m;
}
export function validateServerUrl(value: string): string {
  const u = new URL(value);
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Use an HTTPS host origin, or HTTP on localhost. No credentials, paths or query strings.');
  return u.origin;
}
export function syncDirectory(repo: string): string {
  const root = realpathSync(repo);
  const top = realpathSync(git(root, ['rev-parse', '--show-toplevel']));
  if (root !== top) throw new Error('Select the root of the laptop Git repository.');
  const common = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']));
  const dir = path.join(common, 'agent-empire-sync');
  safeDirectory(dir);
  return dir;
}
/** This pins only public identity/origin. It never stores a password or token. */
export function pinServer(repo: string, origin: string, serverId: string, trustServerId?: string): void {
  origin = validateServerUrl(origin);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(serverId)) throw new Error('Invalid host identity.');
  const file = path.join(syncDirectory(repo), 'host.json');
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.origin !== origin || saved.serverId !== serverId) throw new Error('Host identity changed. Existing trust and imported work were preserved; review the host before reconnecting.');
  } else {
    if (trustServerId !== serverId) throw new Error(`Review this host, then explicitly trust server ID ${serverId}.`);
    writeFileSync(file, JSON.stringify({ origin, serverId }), { flag: 'wx', mode: 0o600 });
  }
}
/** Imports objects into a separate bare repository and worktree. Never checks out or merges into the user's repository. */
export function importArtifact(repo: string, manifest: SyncArtifactManifest, bytes: Uint8Array, serverId: string): SyncReceipt & { reused: boolean } {
  const m = validateManifest(manifest, serverId);
  const root = realpathSync(repo), home = syncDirectory(root);
  if (bytes.byteLength !== m.bundle.bytes || createHash('sha256').update(bytes).digest('hex') !== m.artifactId) throw new Error('Bundle hash or size mismatch; nothing imported.');
  const lock = path.join(home, 'import.lock');
  try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error('Another import is running or was interrupted. Inspect import.lock before removing it.'); }
  try {
    const receiptFile = path.join(home, `${m.artifactId}.json`);
    if (existsSync(receiptFile)) {
      const saved = JSON.parse(readFileSync(receiptFile, 'utf8')) as SyncReceipt;
      if (saved.serverId !== serverId || saved.commit !== m.commit || !existsSync(saved.worktree) || git(saved.worktree, ['rev-parse', 'HEAD']) !== saved.commit) throw new Error('Imported worktree was moved or changed. It was preserved; resolve it manually.');
      return { ...saved, reused: true };
    }
    // Wrong-repository imports fail before creating a checkout. No fetch into the laptop repository.
    try { git(root, ['cat-file', '-e', `${m.base}^{commit}`]); }
    catch { throw new Error('The artifact base is not in this laptop repository. Fetch the matching project history first.'); }
    const localHead = git(root, ['rev-parse', 'HEAD']);
    const localChanges = new Set([
      ...names(git(root, ['diff', '--name-only', '-z', m.base, 'HEAD'])),
      ...names(git(root, ['diff', '--name-only', '-z', 'HEAD'])),
      ...names(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])),
    ]);
    const item = path.join(home, m.artifactId); safeDirectory(item);
    const bundle = path.join(item, 'source.bundle');
    if (!existsSync(bundle)) writeFileSync(bundle, bytes, { flag: 'wx', mode: 0o600 });
    else if (createHash('sha256').update(readFileSync(bundle)).digest('hex') !== m.artifactId) throw new Error('Existing import bundle differs; inspect the interrupted import.');
    const bare = path.join(item, 'objects.git');
    if (!existsSync(bare)) git(item, ['init', '--bare', bare]);
    git(bare, ['bundle', 'verify', bundle]);
    const heads = git(bare, ['bundle', 'list-heads', bundle]).split('\n');
    if (heads.length !== 1 || heads[0] !== `${m.commit} HEAD`) throw new Error('Bundle reference does not match the published commit.');
    git(bare, ['fetch', '--no-tags', bundle, 'HEAD:refs/heads/artifact']);
    git(bare, ['merge-base', '--is-ancestor', m.base, m.commit]);
    const changes = names(git(bare, ['diff', '--name-only', '-z', m.base, m.commit]));
    const conflicts = changes.filter(name => [...localChanges].some(local => name === local || name.startsWith(local + '/') || local.startsWith(name + '/')));
    // Separate repository means user hooks, filters and local Git configuration do not execute here.
    const worktree = path.join(item, 'review');
    if (existsSync(worktree)) {
      if (git(worktree, ['rev-parse', 'HEAD']) !== m.commit) throw new Error('Interrupted import checkout differs; it was preserved.');
    } else git(bare, ['worktree', 'add', '--detach', worktree, m.commit]);
    const receipt: SyncReceipt = { artifactId: m.artifactId, serverId, commit: m.commit, worktree, importedAt: Date.now(), conflicts, localHead };
    atomic(receiptFile, receipt);
    return { ...receipt, reused: false };
  } finally { unlinkSync(lock); }
}

export async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) throw new Error(`Host request failed (${response.status}).`);
  if (Number(response.headers.get('content-length') || 0) > limit) throw new Error('Host response exceeds the size limit.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Host response has no body.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      length += value.length; if (length > limit) throw new Error('Host response exceeds the size limit.');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  return Buffer.concat(chunks);
}
