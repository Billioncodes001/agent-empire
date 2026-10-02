// Ed25519 signatures for release files (docs/team/RELEASE_PLAN.md): game-manifest.json and channel-<channel>.json.
// A signature is the base64 of the 64-byte Ed25519 signature over the file's exact bytes, written to <file>.sig.
// Public keys are the raw 32-byte key in base64 (what tweetnacl, CryptoKit and BouncyCastle-style verifiers take).
//
//   GAME_SIGNING_KEY="$(cat key.pem)" node tools/release/sign.mjs sign <file>...     writes <file>.sig
//   node tools/release/sign.mjs verify <file> [--public-key <base64>]               checks <file>.sig (default: pinned key)
//   GAME_SIGNING_KEY=... node tools/release/sign.mjs public-key                       prints the key's public half
//   GAME_SIGNING_KEY=... node tools/release/sign.mjs check-key [--allow-dev]          release gate, see checkPinnedKey()
//
// `--dev` on sign uses the well-known development key instead of GAME_SIGNING_KEY. It is derived from a public seed,
// so anything it signs is untrusted by design: tests and fixtures only, never a published release.
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RELEASE_KEY_FILE = 'src/shared/release-key.ts';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const DEV_KEY_SEED_TEXT = 'agent-empire/dev-release-key/v1: public test key, never trusted by a release build';

/** The development private key (KeyObject), derived from a published seed. */
export function devPrivateKey() {
  const seed = createHash('sha256').update(DEV_KEY_SEED_TEXT).digest();
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** Accepts a PEM string or KeyObject; refuses anything that is not an Ed25519 private key. */
export function privateKey(key) {
  const object = typeof key === 'string' ? createPrivateKey(key.trim().replace(/\\n/g, '\n')) : key;
  if (object.type !== 'private' || object.asymmetricKeyType !== 'ed25519') throw new Error('GAME_SIGNING_KEY must be an Ed25519 private key in PEM (PKCS#8)');
  return object;
}

/** Raw 32-byte public key, base64. */
export function publicKeyBase64(key) {
  const object = key.type === 'private' ? createPublicKey(key) : key;
  const der = object.export({ format: 'der', type: 'spki' });
  return der.subarray(SPKI_ED25519_PREFIX.length).toString('base64');
}

export function publicKeyFromBase64(raw) {
  const bytes = Buffer.from(String(raw), 'base64');
  if (bytes.length !== 32) throw new Error('An Ed25519 public key is 32 bytes (base64 of the raw key)');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, bytes]), format: 'der', type: 'spki' });
}

export function signBytes(bytes, key) {
  return edSign(null, Buffer.from(bytes), privateKey(key)).toString('base64');
}

export function verifyBytes(bytes, signatureBase64, publicKeyB64) {
  const signature = Buffer.from(String(signatureBase64).trim(), 'base64');
  if (signature.length !== 64) return false;
  try { return edVerify(null, Buffer.from(bytes), publicKeyFromBase64(publicKeyB64), signature); }
  catch { return false; }
}

/** The keys in src/shared/release-key.ts. Both must be string literals so tools and shells can read them. */
export function pinnedKeys(root = ROOT) {
  const text = readFileSync(path.join(root, RELEASE_KEY_FILE), 'utf8');
  const read = name => {
    const m = new RegExp(`export const ${name} = '([A-Za-z0-9+/=]{44})';`).exec(text);
    if (!m) throw new Error(`${RELEASE_KEY_FILE} must declare ${name} as a base64 string literal`);
    return m[1];
  };
  return { release: read('RELEASE_PUBLIC_KEY'), dev: read('DEV_RELEASE_PUBLIC_KEY') };
}

/**
 * Release gate: the pinned key is not the development key, every file listed in tools/release/config.json
 * `pinnedKeyFiles` carries it, and (when a signing key is given) the signing key is its private half.
 */
export function checkPinnedKey({ root = ROOT, signingKey, allowDev = false } = {}) {
  const problems = [];
  const { release, dev } = pinnedKeys(root);
  const devDerived = publicKeyBase64(devPrivateKey());
  if (dev !== devDerived) problems.push(`${RELEASE_KEY_FILE}: DEV_RELEASE_PUBLIC_KEY is not the development key (${devDerived})`);
  if (release === devDerived && !allowDev) problems.push(`${RELEASE_KEY_FILE}: RELEASE_PUBLIC_KEY is still the development key; paste the owner's public key (node tools/release/generate-signing-key.mjs)`);
  const config = JSON.parse(readFileSync(path.join(root, 'tools/release/config.json'), 'utf8'));
  for (const file of config.pinnedKeyFiles ?? []) {
    let text = '';
    try { text = readFileSync(path.join(root, file), 'utf8'); } catch { problems.push(`${file}: missing (listed in tools/release/config.json pinnedKeyFiles)`); continue; }
    if (!text.includes(release)) problems.push(`${file}: does not pin RELEASE_PUBLIC_KEY ${release}`);
  }
  if (signingKey) {
    const actual = publicKeyBase64(privateKey(signingKey));
    if (actual !== release) problems.push(`GAME_SIGNING_KEY's public key ${actual} is not the pinned RELEASE_PUBLIC_KEY ${release}`);
  }
  return problems;
}

function signingKeyFromEnv(args) {
  if (args.includes('--dev')) return devPrivateKey();
  const pem = process.env.GAME_SIGNING_KEY;
  if (!pem) throw new Error('GAME_SIGNING_KEY is not set (or pass --dev for an untrusted development signature)');
  return privateKey(pem);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const files = args.filter(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--public-key');
  try {
    if (command === 'sign') {
      if (!files.length) throw new Error('usage: sign.mjs sign [--dev] <file>...');
      const key = signingKeyFromEnv(args);
      for (const file of files) { writeFileSync(`${file}.sig`, signBytes(readFileSync(file), key) + '\n'); console.log(`signed ${file} -> ${file}.sig`); }
      console.log(`public key ${publicKeyBase64(key)}${args.includes('--dev') ? ' (DEVELOPMENT key: untrusted)' : ''}`);
    } else if (command === 'verify') {
      if (files.length !== 1) throw new Error('usage: sign.mjs verify <file> [--public-key <base64>]');
      const i = args.indexOf('--public-key');
      const key = i >= 0 ? args[i + 1] : pinnedKeys().release;
      if (!verifyBytes(readFileSync(files[0]), readFileSync(`${files[0]}.sig`, 'utf8'), key)) throw new Error(`${files[0]}.sig does not verify with ${key}`);
      console.log(`${files[0]} verifies with ${key}`);
    } else if (command === 'public-key') {
      console.log(publicKeyBase64(signingKeyFromEnv(args)));
    } else if (command === 'check-key') {
      const problems = checkPinnedKey({ signingKey: process.env.GAME_SIGNING_KEY || undefined, allowDev: args.includes('--allow-dev') });
      if (problems.length) { for (const p of problems) console.error(`error: ${p}`); process.exit(1); }
      console.log(`pinned release key ${pinnedKeys().release} is ready${process.env.GAME_SIGNING_KEY ? ' and matches GAME_SIGNING_KEY' : ''}`);
    } else {
      throw new Error('usage: sign.mjs sign [--dev] <file>... | verify <file> [--public-key <b64>] | public-key [--dev] | check-key [--allow-dev]');
    }
  } catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
