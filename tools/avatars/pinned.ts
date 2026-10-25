// CHAR-02: a pinned build input, verified before it is cached (tools/avatars/build-clips.mts).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
type Fetch = (url: string) => Promise<Response>;

/**
 * Returns the bytes of `url` whose SHA-256 must be `expected`. A cached copy at `file` is used only when it matches;
 * a corrupt one (truncated download, edited file) is deleted and fetched again. A download is checked before it is
 * written, so a mismatching archive never lands in the cache.
 */
export async function fetchPinned(url: string, expected: string, file: string, get: Fetch = fetch): Promise<Uint8Array> {
  if (existsSync(file)) {
    const cached = new Uint8Array(readFileSync(file));
    if (sha256(cached) === expected) return cached;
    unlinkSync(file);
  }
  const res = await get(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== expected) throw new Error(`${url}: SHA-256 ${got} does not match the pinned ${expected}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return bytes;
}
