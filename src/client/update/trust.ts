/**
 * Which keys this page trusts for signed release files (REL-07).
 *
 * A production build trusts RELEASE_PUBLIC_KEY alone. Development page builds (the Vite dev server and
 * `vite build --mode fixture`) also trust the public development key, which vite.config.ts compiles in as
 * __AGENT_EMPIRE_DEV_UPDATE_KEY__; in every other build that define is `undefined`, so the development key string never
 * reaches dist/public (tools/check-no-fixture.mjs refuses a bundle that carries it).
 *
 * A development native shell (desktop prepared with --dev-updates, the Android debug variant, iOS Debug) reports the
 * development key in update.nativeInfo `devReleaseKey`, so the production page it carries can be exercised against the
 * local update fixture. Release shells never report it, and every shell checks the signed release again with its own
 * per-build key set before installing anything.
 */
import { RELEASE_PUBLIC_KEY } from '../../shared/release-key';

declare const __AGENT_EMPIRE_DEV_UPDATE_KEY__: string | undefined;

const KEY = /^[A-Za-z0-9+/]{43}=$/;

/** Base64 of a raw 32-byte Ed25519 key. */
export const isPublicKey = (v: unknown): v is string => typeof v === 'string' && KEY.test(v);

const BUILD_DEV_KEY = typeof __AGENT_EMPIRE_DEV_UPDATE_KEY__ === 'string' && isPublicKey(__AGENT_EMPIRE_DEV_UPDATE_KEY__) ? __AGENT_EMPIRE_DEV_UPDATE_KEY__ : null;

/** The keys this page build trusts on its own. */
export const BUILD_TRUSTED_KEYS: readonly string[] = Object.freeze(BUILD_DEV_KEY ? [RELEASE_PUBLIC_KEY, BUILD_DEV_KEY] : [RELEASE_PUBLIC_KEY]);

/** This build's keys, plus the development key a development shell reports (nativeInfo.devReleaseKey). */
export function trustedKeys(shellDevKey?: string | null): readonly string[] {
  return isPublicKey(shellDevKey) && !BUILD_TRUSTED_KEYS.includes(shellDevKey) ? Object.freeze([...BUILD_TRUSTED_KEYS, shellDevKey]) : BUILD_TRUSTED_KEYS;
}
