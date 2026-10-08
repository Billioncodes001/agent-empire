// Pinned Ed25519 public keys for signed release files (docs/team/RELEASE_PLAN.md, "Update channel contract").
// They verify channel-<channel>.json(.sig) and game-manifest.json(.sig): the client and every native shell check a file's
// signature against the keys their build trusts before trusting anything in it.
//
// Format: base64 of the raw 32-byte Ed25519 public key (tweetnacl `sign.detached.verify`, CryptoKit
// `Curve25519.Signing.PublicKey(rawRepresentation:)`). Signatures are base64 of the 64-byte signature over the exact
// file bytes.
//
// It must stay a single-quoted string literal: tools/release/sign.mjs reads it from this file, and native shells pin the
// same string (tools/release/config.json `pinnedKeyFiles`).
//
// RELEASE_PUBLIC_KEY is the owner's key (generated offline and pinned on 2026-10-08, REL-07). Its private half lives
// only in the GitHub `release` environment secret GAME_SIGNING_KEY and the owner's offline backup.
//
// The public DEVELOPMENT key is deliberately not here: src/shared is compiled into dist/server, which ships inside the
// desktop app. It lives in tools/release/dev-key.mjs (dev-release-public-key.txt); only development builds trust it (vite
// dev server and `--mode fixture`, desktop packages prepared with --dev-updates, the Android debug variant, iOS Debug),
// and the release gate (`node tools/release/sign.mjs check-key`) refuses a release whose builds would trust it.
export const RELEASE_PUBLIC_KEY = 'rIRaOVUyoolaIritW/W8zMW7kGymgcjvg7uXhHtTqPk=';
