// Creates the owner's release signing key (Ed25519). Run it once, on a trusted machine:
//
//   node tools/release/generate-signing-key.mjs --out ~/agent-empire-signing-key.pem
//   gh secret set GAME_SIGNING_KEY < ~/agent-empire-signing-key.pem
//   (store the .pem in your password manager as the offline backup, then delete the file)
//
// Without --out, stdout carries ONLY the private key (PEM, PKCS#8), so it can be piped:
//   node tools/release/generate-signing-key.mjs | gh secret set GAME_SIGNING_KEY
// but then no backup exists: GitHub secrets cannot be read back, and losing the key means every installed app must be
// re-pinned through a store/native update before it accepts signed updates again.
// stderr carries the public key and the snippet to paste into src/shared/release-key.ts. See docs/RELEASING.md.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { publicKeyBase64 } from './sign.mjs';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : null;
if (outIndex >= 0 && !out) { console.error('usage: generate-signing-key.mjs [--out <new file>]'); process.exit(2); }
if (out && existsSync(out)) { console.error(`error: ${out} already exists; refusing to overwrite a key`); process.exit(1); }

const { privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const pub = publicKeyBase64(privateKey);
if (out) {
  writeFileSync(out, pem, { mode: 0o600, flag: 'wx' });
  process.stderr.write(`Private key written to ${out} (mode 600).\n`);
} else {
  if (process.stdout.isTTY)
    process.stderr.write('warning: printing a private key to the terminal. Prefer --out <file> or piping into `gh secret set GAME_SIGNING_KEY`.\n\n');
  process.stdout.write(pem);
}
process.stderr.write(`
Public key (raw Ed25519, base64): ${pub}

Paste into src/shared/release-key.ts (replace the existing line):

export const RELEASE_PUBLIC_KEY = '${pub}';

Then update every file listed in tools/release/config.json "pinnedKeyFiles", commit, and check with:
  GAME_SIGNING_KEY="$(cat <key file>)" node tools/release/sign.mjs check-key
`);
