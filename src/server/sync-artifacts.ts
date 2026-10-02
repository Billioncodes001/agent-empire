import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SyncArtifactManifest } from '../shared/continuity.js';
import type { WorkerInfo } from '../shared/protocol.js';
import { WORKTREES_DIR } from './worktrees.js';
import { writeJsonAtomic } from './persistence.js';

const execute = promisify(execFile);
const ID = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const MAX_BYTES = 128 * 1024 * 1024;
async function git(cwd: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return (await execute('git', ['--no-replace-objects', ...args], {
    cwd, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
  })).stdout.trim();
}
async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}

/** Published directories never change. Interrupted temporary exports are not listed or served. */
export class SyncArtifacts {
  private root: string;
  private pending = new Map<string, Promise<SyncArtifactManifest>>();
  constructor(private projectDir: string, dataDir: string, readonly serverId: string) {
    this.root = path.join(dataDir, 'sync-artifacts');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  async list(): Promise<SyncArtifactManifest[]> {
    const items: SyncArtifactManifest[] = [];
    for (const id of readdirSync(this.root).filter(id => ID.test(id))) {
      try { items.push((await this.bundle(id)).manifest); }
      catch { /* Incomplete or corrupt artifacts are never advertised as importable. */ }
    }
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }

  manifest(id: string): SyncArtifactManifest {
    if (!ID.test(id)) throw new Error('Invalid artifact identifier');
    const manifest = JSON.parse(readFileSync(path.join(this.root, id, 'manifest.json'), 'utf8')) as SyncArtifactManifest;
    if (manifest.schemaVersion !== 1 || manifest.serverId !== this.serverId || manifest.artifactId !== id
      || !COMMIT.test(manifest.commit) || !COMMIT.test(manifest.base) || typeof manifest.branch !== 'string'
      || typeof manifest.workerId !== 'string' || !Number.isFinite(manifest.createdAt)
      || manifest.bundle?.sha256 !== id || manifest.bundle.ref !== 'HEAD'
      || manifest.bundle.url !== `/api/sync/artifacts/${id}/bundle`
      || !Number.isSafeInteger(manifest.bundle.bytes) || manifest.bundle.bytes <= 0 || manifest.bundle.bytes > MAX_BYTES) {
      throw new Error('Artifact manifest is invalid; preserve it and diagnose before importing');
    }
    return manifest;
  }

  async bundle(id: string): Promise<{ file: string; manifest: SyncArtifactManifest }> {
    const manifest = this.manifest(id);
    const file = path.join(this.root, id, 'artifact.bundle');
    if (statSync(file).size !== manifest.bundle.bytes || await sha256(file) !== manifest.bundle.sha256) throw new Error('Artifact integrity check failed');
    return { file, manifest };
  }

  /** Coalesce simultaneous explicit requests for the same worker; no second runtime reservation. */
  publish(workerId: string, reserve: (publish: (worker: WorkerInfo) => Promise<SyncArtifactManifest>) => Promise<SyncArtifactManifest>): Promise<SyncArtifactManifest> {
    const pending = this.pending.get(workerId);
    if (pending) return pending;
    const promise = reserve(worker => this.export(worker));
    this.pending.set(workerId, promise);
    void promise.finally(() => this.pending.delete(workerId)).catch(() => {});
    return promise;
  }

  private async inspect(worker: WorkerInfo) {
    if (worker.processState !== 'stopped' || !worker.worktree) throw new Error('A confirmed stopped worker with its own worktree is required');
    const wt = worker.worktree;
    const project = realpathSync(this.projectDir);
    const home = path.join(project, WORKTREES_DIR);
    const cwd = realpathSync(path.resolve(project, wt.path));
    if (!cwd.startsWith(home + path.sep) || realpathSync(home) !== home) throw new Error('Worktree is outside this server’s managed project root');
    const top = realpathSync(await git(cwd, ['rev-parse', '--show-toplevel']));
    const common = realpathSync(await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const projectCommon = realpathSync(await git(project, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    if (top !== cwd || common !== projectCommon) throw new Error('Worktree Git root does not match this server’s project');
    if (await git(cwd, ['rev-parse', '--is-shallow-repository']) !== 'false') throw new Error('A self-contained export requires complete Git history');
    const branch = await git(cwd, ['symbolic-ref', '--short', 'HEAD']);
    const commit = await git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (branch !== wt.branch || !COMMIT.test(commit) || !COMMIT.test(wt.base)) throw new Error('Worker branch or base no longer matches its saved worktree');
    const base = await git(cwd, ['rev-parse', '--verify', `${wt.base}^{commit}`]);
    await git(cwd, ['merge-base', '--is-ancestor', base, commit]);
    if (await git(cwd, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'])) throw new Error('Commit or remove uncommitted work before publishing; the worktree must be clean');
    // A bundle cannot deliver LFS contents or submodule repositories.
    if ((await git(cwd, ['ls-files', '--stage'])).split('\n').some(line => line.startsWith('160000 '))) throw new Error('Submodule worktrees are not supported by bundle synchronization');
    let lfsPointers = '';
    try { lfsPointers = await git(cwd, ['grep', '-I', '-l', '-e', '^version https://git-lfs.github.com/spec/v1$', 'HEAD', '--']); }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
    if (lfsPointers) throw new Error('Git LFS pointers require separate object transfer and are not supported by bundle synchronization');
    return { cwd, branch, commit, base };
  }

  private async export(worker: WorkerInfo): Promise<SyncArtifactManifest> {
    const source = await this.inspect(worker);
    const existing = (await this.list()).find(item => item.workerId === worker.id && item.branch === source.branch && item.commit === source.commit && item.base === source.base);
    if (existing) { await this.bundle(existing.artifactId); return existing; }
    const temp = path.join(this.root, `.publishing-${randomUUID()}`);
    mkdirSync(temp, { mode: 0o700 });
    try {
      const file = path.join(temp, 'artifact.bundle');
      await git(source.cwd, ['bundle', 'create', file, 'HEAD']);
      const bytes = statSync(file).size;
      if (bytes > MAX_BYTES) throw new Error('Bundle exceeds the supported 128 MiB export limit');
      // Verify against an empty object store, so missing prerequisites/objects cannot hide in the source repo.
      const verify = path.join(temp, 'verify.git');
      await git(temp, ['init', '--bare', verify]);
      await git(verify, ['bundle', 'verify', file]);
      await git(verify, ['-c', 'core.hooksPath=' + path.join(temp, 'no-hooks'), 'fetch', '--no-tags', file, 'HEAD']);
      if (await git(verify, ['rev-parse', 'FETCH_HEAD']) !== source.commit) throw new Error('Exported commit does not match the worker');
      rmSync(verify, { recursive: true, force: true });
      const heads = await git(source.cwd, ['bundle', 'list-heads', file]);
      if (heads !== `${source.commit} HEAD`) throw new Error('Bundle commit changed during publication; retry after all Git operations stop');
      const after = await this.inspect(worker);
      if (JSON.stringify(source) !== JSON.stringify(after)) throw new Error('Worktree changed during publication; retry after all Git operations stop');
      const id = await sha256(file);
      const manifest: SyncArtifactManifest = {
        schemaVersion: 1, serverId: this.serverId, artifactId: id, createdAt: Date.now(), workerId: worker.id,
        branch: source.branch, commit: source.commit, base: source.base,
        bundle: { sha256: id, bytes, ref: 'HEAD', url: `/api/sync/artifacts/${id}/bundle` },
      };
      const destination = path.join(this.root, id);
      if (existsSync(destination)) {
        const previous = (await this.bundle(id)).manifest;
        if (previous.branch !== manifest.branch || previous.base !== manifest.base || previous.commit !== manifest.commit) throw new Error('Identical bundle is already published with different branch/base metadata; use the existing artifact after reviewing its manifest');
        return previous;
      }
      writeJsonAtomic(path.join(temp, 'manifest.json'), manifest);
      renameSync(temp, destination);
      return manifest;
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
}
