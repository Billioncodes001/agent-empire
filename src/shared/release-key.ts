// Pinned Ed25519 public keys for signed release files (docs/team/RELEASE_PLAN.md, "Update channel contract").
// They verify channel-<channel>.json(.sig) and game-manifest.json(.sig): the client and every native shell check a file's
// signature against the keys their build trusts before trusting anything in it.
//
// Format: base64 of the raw 32-byte Ed25519 public key (tweetnacl `sign.detached.verify`, CryptoKit
// `Curve25519.Signing.PublicKey(rawRepresentation:)`). Signatures are base64 of the 64-byte signature over the exact
// file bytes.
//
// Both values must stay single-quoted string literals: tools/release/sign.mjs and vite.config.ts read them from this
// file, and native shells pin the same strings (tools/release/config.json `pinnedKeyFiles`).
//
// RELEASE_PUBLIC_KEY is the owner's key (generated offline and pinned on 2026-10-08, REL-07). Its private half lives
// only in the GitHub `release` environment secret GAME_SIGNING_KEY and the owner's offline backup.
//
// DEV_RELEASE_PUBLIC_KEY's private half is derived from a public seed (tools/release/sign.mjs devPrivateKey) for tests
// and fixtures. Only development builds trust it (vite dev server and `--mode fixture`, desktop packages prepared with
// --dev-updates, the Android debug variant, iOS Debug); release builds trust RELEASE_PUBLIC_KEY alone, and the release
// gate (`node tools/release/sign.mjs check-key`) refuses a release whose builds would trust the development key.
// Client code must never import DEV_RELEASE_PUBLIC_KEY: development page builds get it from vite.config.ts instead, so the
// string is absent from production bundles (tools/check-no-fixture.mjs refuses one that carries it).
export const DEV_RELEASE_PUBLIC_KEY = 'q7m8HRpNA8EClSZsC3KSzzInRy3LxrjPIXNU41+WLYU=';
export const RELEASE_PUBLIC_KEY = 'rIRaOVUyoolaIritW/W8zMW7kGymgcjvg7uXhHtTqPk=';
