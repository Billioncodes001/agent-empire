import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Local-process ownership only: no shared network volume or distributed lease support. */
export function acquireHostLock(dataDir: string): () => void {
  const gate = path.join(dataDir, 'server-starting.lock');
  const owner = path.join(dataDir, 'server-owner.json');
  const token = randomUUID();
  let fd: number;
  try { fd = openSync(gate, 'wx', 0o600); }
  catch { throw new Error(`Another server is starting, or startup was interrupted. Diagnose ${gate} before removing a stale startup lock.`); }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token }));
    if (existsSync(owner)) {
      let previous: { pid: number; host: string };
      try { previous = JSON.parse(readFileSync(owner, 'utf8')); }
      catch { throw new Error(`Invalid server ownership record: ${owner}. Preserve it and diagnose before restarting.`); }
      if (previous.host !== hostname() || !Number.isSafeInteger(previous.pid) || previous.pid < 1) {
        throw new Error('Server data belongs to an unknown host/process; shared-host execution is unsupported');
      }
      let absent = false;
      try { process.kill(previous.pid, 0); }
      catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (!absent) throw new Error(`This data directory is already owned by process ${previous.pid}; its exit is not confirmed`);
      // Every contender holds the exclusive startup gate while inspecting/replacing the owner.
      unlinkSync(owner);
    }
    writeFileSync(owner, JSON.stringify({ pid: process.pid, host: hostname(), token }), { flag: 'wx', mode: 0o600 });
  } finally {
    closeSync(fd);
    unlinkSync(gate);
  }
  return () => {
    try { if (JSON.parse(readFileSync(owner, 'utf8')).token === token) unlinkSync(owner); } catch { /* preserve uncertain ownership */ }
  };
}
