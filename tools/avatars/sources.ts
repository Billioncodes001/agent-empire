// Build inputs for the corporate avatars: Microsoft Rocketbox (MIT) FBX + TGA files at a pinned commit.
// They are downloaded into the git-ignored .cache/rocketbox/ and verified against sources.lock.json; only
// the optimized GLB/WebP outputs are committed.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const ROCKETBOX_REPO = 'microsoft/Microsoft-Rocketbox';
/** Pinned upstream commit (master on 2026-10-02). Changing it requires regenerating sources.lock.json (--relock). */
export const ROCKETBOX_COMMIT = '0943055db6ec570bcef9f2c8b41c9e5467c808f9';
export const CACHE = join(process.cwd(), '.cache', 'rocketbox', ROCKETBOX_COMMIT.slice(0, 12));
const LOCK = new URL('./sources.lock.json', import.meta.url);

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function loadLock(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(LOCK, 'utf8')).files ?? {};
  } catch {
    return {};
  }
}

/**
 * Returns the local path of a pinned source file, downloading it once. Every file must match its recorded
 * SHA-256; `relock` records new checksums instead (only when deliberately moving the pin).
 */
export async function fetchSource(path: string, relock = false): Promise<string> {
  const lock = await loadLock();
  const local = join(CACHE, path);
  let bytes: Uint8Array;
  if (existsSync(local)) bytes = await readFile(local);
  else {
    const url = `https://raw.githubusercontent.com/${ROCKETBOX_REPO}/${ROCKETBOX_COMMIT}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, bytes);
  }
  const hash = sha256(bytes);
  if (relock) {
    lock[path] = hash;
    await writeFile(LOCK, `${JSON.stringify({ repo: ROCKETBOX_REPO, commit: ROCKETBOX_COMMIT, files: Object.fromEntries(Object.entries(lock).sort()) }, null, 2)}\n`);
  } else if (lock[path] !== hash) throw new Error(`${path}: checksum ${hash} does not match sources.lock.json (${lock[path] ?? 'missing'})`);
  return local;
}
