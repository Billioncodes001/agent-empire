// Pinned Ed25519 public key for signed release files (docs/team/RELEASE_PLAN.md, "Update channel contract").
// It verifies channel-<channel>.json(.sig) and game-manifest.json(.sig): the client and every native shell must check
// a file's signature against RELEASE_PUBLIC_KEY before trusting anything in it.
//
// Format: base64 of the raw 32-byte Ed25519 public key (tweetnacl `sign.detached.verify`, CryptoKit
// `Curve25519.Signing.PublicKey(rawRepresentation:)`). Signatures are base64 of the 64-byte signature over the exact
// file bytes.
//
// Both values must stay single-quoted string literals: tools/release/sign.mjs reads them from this file, and native
// shells pin the same string (list their files in tools/release/config.json `pinnedKeyFiles`).
//
// DEVELOPMENT KEY PLACEHOLDER. RELEASE_PUBLIC_KEY currently equals DEV_RELEASE_PUBLIC_KEY, whose private half is
// derived from a public seed (tools/release/sign.mjs devPrivateKey) for tests and fixtures. The release workflow
// (`node tools/release/sign.mjs check-key`) refuses to publish until the owner replaces RELEASE_PUBLIC_KEY with the
// public key printed by `node tools/release/generate-signing-key.mjs`.
export const DEV_RELEASE_PUBLIC_KEY = 'q7m8HRpNA8EClSZsC3KSzzInRy3LxrjPIXNU41+WLYU=';
export const RELEASE_PUBLIC_KEY = 'q7m8HRpNA8EClSZsC3KSzzInRy3LxrjPIXNU41+WLYU=';

/** True while the build pins the development key: such a build must not be published, and updates it accepts are untrusted. */
export const RELEASE_KEY_IS_DEVELOPMENT = (RELEASE_PUBLIC_KEY as string) === DEV_RELEASE_PUBLIC_KEY;
