// The public DEVELOPMENT release key (REL-07). Its private half is derived from a published seed
// (tools/release/sign.mjs devPrivateKey), so only development builds may trust it. It lives here, under tools/, and in
// dev-release-public-key.txt, never under src/: everything in src/shared and src/server is compiled into dist/server,
// which ships inside the desktop app, so a key there would put the dev key into release builds.
//
// Readers: vite.config.ts (dev server / fixture define), tools/check-no-fixture.mjs and tools/release/sign.mjs (gates),
// mobile/tools/build-android.py (APK check), tests and update fixtures.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEV_KEY_FILE = 'tools/release/dev-release-public-key.txt';

/** The development key (base64 of the raw 32-byte Ed25519 public key). */
export function devReleaseKey(root = ROOT) {
  const key = readFileSync(path.join(root, DEV_KEY_FILE), 'utf8').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error(`${DEV_KEY_FILE} must hold one base64 Ed25519 public key`);
  return key;
}

/** SHA-512 (hex) of the raw key bytes: what shells and pages compare a reported dev key against (trust.ts, update-store.cjs). */
export const keyDigest = (key) => createHash('sha512').update(Buffer.from(key, 'base64')).digest('hex');

export const DEV_RELEASE_PUBLIC_KEY = devReleaseKey();
