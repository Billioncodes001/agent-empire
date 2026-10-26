/**
 * DEVICE-BUGS-03: which source a game build came from. The version (package.json) stays the same across many builds of
 * a branch, so a release and a newer development build of "1.0.0-beta.2" looked identical in the app. vite.config.ts
 * writes this into game-version.json ({version, build}) and the page shows it in Settings (src/client/update/version-line.ts).
 * Native shells read only `version` from that file.
 */
import { execFileSync } from 'node:child_process';

const HEX = /^[0-9a-f]{7,40}$/;

/** @returns {{ commit: string | null, date: string | null, dirty: boolean }} */
export function gameBuild({ cwd = process.cwd(), env = process.env } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const pinned = [env.AGENT_EMPIRE_BUILD_COMMIT, env.GITHUB_SHA].map((v) => String(v ?? '').trim().toLowerCase()).find((v) => HEX.test(v));
  let head = null, date = null, dirty = false;
  try {
    head = git('rev-parse', 'HEAD');
    date = git('show', '-s', '--format=%cI', 'HEAD');
    dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
  } catch {
    head = null;
  }
  const commit = (pinned ?? (head && HEX.test(head) ? head : null))?.slice(0, 12) ?? null;
  if (!commit) return { commit: null, date: null, dirty: false };
  if (pinned && head && !head.startsWith(pinned.slice(0, 12))) date = null; // a pinned commit that isn't HEAD: no date guess
  return { commit, date: date ? new Date(date).toISOString().replace(/\.000Z$/, 'Z') : null, dirty: pinned ? false : dirty };
}
