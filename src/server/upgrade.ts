import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UpgradeState, VersionInfo } from '../shared/protocol.js';

/** The install this server runs from (deploy/aws.sh makes it a git checkout). */
function findAppDir(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++, dir = path.dirname(dir)) {
    try {
      if (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name === 'agent-office') return dir;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

const APP_DIR = findAppDir() ?? process.cwd();
// The new version is built here, next to the install, so swapping it in is a few renames.
const STAGE = path.join(APP_DIR, '.upgrade');
/** Written when putting the old build back failed; its text is the error. Survives restarts. */
const RESTORE_MARKER = path.join(STAGE, 'NEEDS_RESTORE');
const CHECK_EVERY_MS = 15 * 60_000;
const SHOW_CHANGES = 15;

const tail = (s: string, lines = 25) => s.trim().split('\n').slice(-lines).join('\n');

function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd ?? APP_DIR, timeout: opts.timeout ?? 60_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, out, errOut) => {
      if (err) reject(new Error(tail(`${out}\n${errOut}`) || err.message));
      else resolve(out.trim());
    });
  });
}

function gitSync(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: APP_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function parseVersion(line: string | undefined): VersionInfo | undefined {
  if (!line) return undefined;
  const [sha, subject, date] = line.split('\0');
  return { sha, subject, date };
}

const VERSION_FORMAT = '--format=%h%x00%s%x00%cI';

/**
 * Lets an office installed by deploy/aws.sh upgrade itself from the UI. The new version is
 * built next to the running one (the office keeps working meanwhile, and a failed build changes
 * nothing), swapped in, and then the process exits so systemd starts the new version.
 */
export class Upgrader {
  readonly state: UpgradeState;
  /** What the running server is: its commit, or the package version outside a git checkout. */
  readonly version: string;
  /** The release version from package.json (REL-05: the apps show it, and never act on it). */
  readonly packageVersion: string;
  private branch?: string;
  private latestSha?: string;
  private checking?: Promise<void>;
  private timer?: NodeJS.Timeout;

  constructor(
    private emit: (state: UpgradeState) => void,
    private restart: () => void,
    allowBackgroundUpdates = true,
  ) {
    const current = existsSync(path.join(APP_DIR, '.git')) ? parseVersion(gitSync(['log', '-1', VERSION_FORMAT, 'HEAD'])) : undefined;
    let pkg = '0.0.0';
    try {
      pkg = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version ?? pkg;
    } catch {
      // keep the default
    }
    this.version = current?.sha ?? pkg;
    this.packageVersion = pkg;
    const branch = current ? gitSync(['rev-parse', '--abbrev-ref', 'HEAD']) : undefined;
    // Only deploy/aws.sh's systemd unit sets this, and it restarts the office whenever it exits.
    // A checkout on a tag (detached HEAD) has no branch to follow.
    const enabled = allowBackgroundUpdates && process.env.AGENT_OFFICE_SELF_UPDATE === '1' && !!branch && branch !== 'HEAD';
    this.branch = enabled ? branch : undefined;
    this.state = { available: enabled, current, phase: 'idle' };
    if (!enabled) return;
    if (existsSync(RESTORE_MARKER)) {
      // A failed rollback left the only copy of the old build in the stage: keep it, and keep saying so.
      this.manualRestore = true;
      let error = '';
      try {
        error = readFileSync(RESTORE_MARKER, 'utf8');
      } catch {
        // the marker itself is what matters
      }
      this.state = { ...this.state, phase: 'failed', error: error || `Restore the previous build from ${path.join(STAGE, 'old')} by hand, then delete ${RESTORE_MARKER}.` };
      console.warn(`[upgrade] ${RESTORE_MARKER} is present; not upgrading until the old build is restored by hand.`);
    } else void rm(STAGE, { recursive: true, force: true }); // what's left of the previous version
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    setTimeout(() => void this.check(), 10_000);
  }

  stop() {
    clearInterval(this.timer);
  }

  private get busy() {
    return this.state.phase === 'building' || this.state.phase === 'restarting';
  }

  /** Set when putting the old build back failed: nothing may clear that message or touch the stage. */
  private manualRestore = false;

  private set(patch: Partial<UpgradeState>) {
    Object.assign(this.state, patch);
    this.emit(this.state);
  }

  /** Looks upstream for new commits on the installed branch. */
  check(): Promise<void> {
    if (!this.branch || this.busy || this.manualRestore) return Promise.resolve();
    this.checking ??= this.fetchLatest(this.branch).finally(() => (this.checking = undefined));
    return this.checking;
  }

  private async fetchLatest(branch: string) {
    this.set({ checking: true, ...(this.state.phase === 'failed' ? { phase: 'idle', error: undefined } : {}) });
    try {
      // Deep enough to list what changed; the install stays a shallow clone.
      await run('git', ['fetch', '--quiet', '--depth', '50', 'origin', branch]);
      const [head, fetched] = await Promise.all([run('git', ['rev-parse', 'HEAD']), run('git', ['rev-parse', 'FETCH_HEAD'])]);
      if (head === fetched) {
        this.latestSha = undefined;
        this.set({ checking: false, checkedAt: Date.now(), latest: undefined, changes: undefined, behind: undefined, error: undefined });
        return;
      }
      const [latest, behind, log] = await Promise.all([
        run('git', ['log', '-1', VERSION_FORMAT, fetched]),
        run('git', ['rev-list', '--count', `${head}..${fetched}`]),
        run('git', ['log', '-n', String(SHOW_CHANGES), '--format=%h%x00%s', `${head}..${fetched}`]),
      ]);
      this.latestSha = fetched;
      this.set({
        checking: false,
        checkedAt: Date.now(),
        latest: parseVersion(latest),
        behind: Number(behind) || undefined,
        changes: log
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [sha, subject] = l.split('\0');
            return { sha, subject };
          }),
        error: undefined,
      });
    } catch (err) {
      this.set({ checking: false, checkedAt: Date.now(), error: `Couldn't check for updates: ${(err as Error).message}` });
    }
  }

  /** Starts building the newest version. Returns why it can't, if it can't. */
  async start(by: string): Promise<string | undefined> {
    if (!this.branch) return "This office can't upgrade itself (it wasn't installed by deploy/aws.sh)";
    if (this.busy) return 'An upgrade is already running';
    if (this.manualRestore) return this.state.error ?? 'Restore the previous build by hand first';
    await this.check();
    if (this.busy) return 'An upgrade is already running';
    const sha = this.latestSha;
    if (!sha) return this.state.error ?? 'The office is already up to date';
    this.set({ phase: 'building', by, error: undefined });
    void this.build(sha);
    return undefined;
  }

  private async build(sha: string) {
    const next = path.join(STAGE, 'next');
    const old = path.join(STAGE, 'old');
    let oldSha: string | undefined;
    try {
      await rm(STAGE, { recursive: true, force: true });
      await mkdir(next, { recursive: true });
      await run('sh', ['-c', 'git archive "$1" | tar -x -C "$2"', 'sh', sha, next]);
      // npm install runs the prepare script, which builds the client and the server.
      await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: next, timeout: 15 * 60_000 });
      for (const f of ['dist/server/server/cli.js', 'dist/public/index.html']) {
        if (!existsSync(path.join(next, f))) throw new Error(`the build didn't produce ${f}`);
      }
      // Swap it in. The running process already has everything it needs loaded.
      oldSha = await run('git', ['rev-parse', 'HEAD']);
      await run('git', ['reset', '--quiet', '--hard', sha]);
      await mkdir(old);
      for (const d of ['dist', 'node_modules']) {
        if (existsSync(path.join(APP_DIR, d))) await rename(path.join(APP_DIR, d), path.join(old, d));
        await rename(path.join(next, d), path.join(APP_DIR, d));
      }
    } catch (err) {
      // A swap that got partway must be undone before the stage (which holds the old build) goes.
      const undo = oldSha ? await rollback(oldSha, old).then(() => undefined, (e: Error) => e.message) : undefined;
      if (undo) {
        this.manualRestore = true;
        const error = `The upgrade failed partway through swapping in the new version, and putting the old one back failed too. The old build is in ${old}; restore it by hand.\n\n${(err as Error).message}\n\n${undo}\n\nThen delete ${RESTORE_MARKER}.`;
        await writeFile(RESTORE_MARKER, error).catch(() => {});
        this.set({ phase: 'failed', error });
        return;
      }
      await rm(STAGE, { recursive: true, force: true }).catch(() => {});
      this.set({ phase: 'failed', error: `The upgrade failed, so the office stays on ${this.state.current?.sha}.\n\n${(err as Error).message}` });
      return;
    }
    this.set({ phase: 'restarting' });
    // Give every browser a moment to hear about it, then hand over to the new version.
    setTimeout(this.restart, 1500);
  }
}

/** Puts the install back the way it was before a failed swap: the old commit, and old/* back in place. */
async function rollback(sha: string, old: string) {
  await run('git', ['reset', '--quiet', '--hard', sha]);
  for (const d of ['dist', 'node_modules']) {
    if (!existsSync(path.join(old, d))) continue;
    await rm(path.join(APP_DIR, d), { recursive: true, force: true });
    await rename(path.join(old, d), path.join(APP_DIR, d));
  }
}
