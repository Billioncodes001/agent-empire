/**
 * Which keys this page trusts for signed release files (REL-07).
 *
 * A production build trusts RELEASE_PUBLIC_KEY alone. Development page builds (the Vite dev server and
 * `vite build --mode fixture`) also trust the public development key, which vite.config.ts compiles in as
 * __AGENT_EMPIRE_DEV_UPDATE_KEY__; in every other build that define is `undefined`, so the development key string never
 * reaches dist/public (tools/check-no-fixture.mjs refuses a bundle that carries it).
 *
 * A development native shell (desktop prepared with --dev-updates, the Android debug variant, iOS Debug) reports the
 * development key in update.nativeInfo `devReleaseKey` (accepted only when it is that exact key, by digest), so the production page it carries can be exercised against the
 * local update fixture. Release shells never report it, and every shell checks the signed release again with its own
 * per-build key set before installing anything.
 */
import nacl from 'tweetnacl';
import { RELEASE_PUBLIC_KEY } from '../../shared/release-key';

declare const __AGENT_EMPIRE_DEV_UPDATE_KEY__: string | undefined;

const KEY = /^[A-Za-z0-9+/]{43}=$/;

/** Base64 of a raw 32-byte Ed25519 key. */
export const isPublicKey = (v: unknown): v is string => typeof v === 'string' && KEY.test(v);

const BUILD_DEV_KEY = typeof __AGENT_EMPIRE_DEV_UPDATE_KEY__ === 'string' && isPublicKey(__AGENT_EMPIRE_DEV_UPDATE_KEY__) ? __AGENT_EMPIRE_DEV_UPDATE_KEY__ : null;

/** The keys this page build trusts on its own. */
export const BUILD_TRUSTED_KEYS: readonly string[] = Object.freeze(BUILD_DEV_KEY ? [RELEASE_PUBLIC_KEY, BUILD_DEV_KEY] : [RELEASE_PUBLIC_KEY]);

/**
 * SHA-512 (hex) of the raw development key bytes (tools/release/dev-key.mjs keyDigest). A shell may add only the
 * development key itself, never any other key; comparing a digest keeps the key string out of production bundles.
 */
export const DEV_KEY_SHA512 = '53a585bd98bdf147c51bdc8f4dca645a9d9fe95e3bd662580c7ce3f0e9b67a62019b86085f75980477100aefeb219719a1fe6d58a7bb7e80c9d193f5e081ef03';

/** True only for the public development key. */
export function isDevKey(key: unknown): key is string {
  if (!isPublicKey(key)) return false;
  let bin: string;
  try {
    bin = atob(key);
  } catch {
    return false;
  }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return [...nacl.hash(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('') === DEV_KEY_SHA512;
}

/** This build's keys, plus the development key when a development shell reports it (nativeInfo.devReleaseKey). Any other reported key is ignored. */
export function trustedKeys(shellDevKey?: string | null): readonly string[] {
  return isDevKey(shellDevKey) && !BUILD_TRUSTED_KEYS.includes(shellDevKey) ? Object.freeze([...BUILD_TRUSTED_KEYS, shellDevKey]) : BUILD_TRUSTED_KEYS;
}
