/**
 * Semantic versions as releases use them (docs/team/RELEASE_PLAN.md: `X.Y.Z[-pre.N]`, e.g. 1.0.0-beta.2).
 * Strict SemVer 2.0 precedence; build metadata is not accepted (no release uses it). Same rules as the shells:
 * desktop/update-store.cjs, Android UpdatePolicy.java, iOS UpdatePolicy.swift.
 */
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-((?:0|[1-9]\d{0,8}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d{0,8}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: (string | number)[];
}

export function parseSemver(text: unknown): SemVer | null {
  if (typeof text !== 'string' || text.length > 64) return null;
  const m = SEMVER.exec(text);
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

export const isSemver = (text: unknown): text is string => parseSemver(text) !== null;

/** <0, 0 or >0. Throws on a malformed version (callers validate first). */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] - y[k];
  // A pre-release is lower than its release.
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    if (typeof p === 'number') return -1; // numeric identifiers sort before alphanumeric ones
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** True when `candidate` is strictly newer than `current` (a missing current counts as older than anything). */
export function isNewer(candidate: string, current: string | null | undefined): boolean {
  if (!isSemver(candidate)) return false;
  if (!current || !isSemver(current)) return true;
  return compareSemver(candidate, current) > 0;
}

export const isPrerelease = (v: string) => (parseSemver(v)?.pre.length ?? 0) > 0;
