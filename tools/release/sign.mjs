// Ed25519 signatures for release files (docs/team/RELEASE_PLAN.md): channel-<channel>.json, the only signed release
// file. It carries the sha256 of the game bundle and of every other published asset (tools/release/channel.mjs).
// A signature is the base64 of the 64-byte Ed25519 signature over the file's exact bytes, written to <file>.sig.
// Public keys are the raw 32-byte key in base64 (what tweetnacl, CryptoKit and BouncyCastle-style verifiers take).
//
//   GAME_SIGNING_KEY="$(cat key.pem)" node tools/release/sign.mjs sign <file>...     writes <file>.sig
//   node tools/release/sign.mjs verify <file> [--public-key <base64>]               checks <file>.sig (default: pinned key)
//   GAME_SIGNING_KEY=... node tools/release/sign.mjs public-key                       prints the key's public half
//   GAME_SIGNING_KEY=... node tools/release/sign.mjs check-key [--allow-dev]          release gate, see checkPinnedKey()
//   node tools/release/sign.mjs check-trust <dir|file>...                             a built app trusts only the release key
//
// `--dev` on sign uses the well-known development key instead of GAME_SIGNING_KEY. It is derived from a public seed,
// so anything it signs is untrusted by design: tests and fixtures only, never a published release.
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devKeyFiles } from '../check-no-fixture.mjs';
import { DEV_KEY_FILE, devReleaseKey } from './dev-key.mjs';

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

/** The release key in src/shared/release-key.ts (a string literal, so tools and shells can read it) and the dev key (dev-key.mjs). */
export function pinnedKeys(root = ROOT) {
  const text = readFileSync(path.join(root, RELEASE_KEY_FILE), 'utf8');
  const m = /export const RELEASE_PUBLIC_KEY = '([A-Za-z0-9+/=]{44})';/.exec(text);
  if (!m) throw new Error(`${RELEASE_KEY_FILE} must declare RELEASE_PUBLIC_KEY as a base64 string literal`);
  return { release: m[1], dev: devReleaseKey(root) };
}

/**
 * REL-07: where release builds come from, no source may let them trust the development key. It may appear only in
 * tools/ (dev-key.mjs and its .txt; read by vite.config.ts for the dev server / fixture define), mobile/android/app/src/debug
 * (the debug variant's DevTrust.java), and inside `#if DEBUG` in the iOS app. Nowhere under src/: src/shared and
 * src/server compile into dist/server, which ships in the desktop app, and src/client into dist/public. Desktop dev trust lives only in a dev-trust.json written by
 * `prepare-desktop.mjs --dev-updates`, which must not exist in the tree being released. Built outputs are checked by
 * `check-trust` (packaged apps), tools/check-no-fixture.mjs (dist/public) and mobile/tools/build-android.py (APK).
 */
export function checkReleaseTrust(root = ROOT, dev = pinnedKeys(root).dev) {
  const problems = [];
  const text = (rel) => { try { return readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };
  const walk = (rel, recursive = true) => {
    const dir = path.join(root, rel);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive }).map((name) => path.join(rel, String(name))).filter((f) => /\.(ts|tsx|mts|js|mjs|cjs|java|swift|json|html)$/.test(f));
  };
  if (existsSync(path.join(root, 'desktop/dev-trust.json'))) problems.push('desktop/dev-trust.json exists: it makes the desktop app trust the development key; rerun `node tools/prepare-desktop.mjs` without --dev-updates');
  for (const file of [...walk('desktop', false), ...walk('src'), ...walk('mobile/android/app/src/main'), ...walk('mobile/android/app/src/release')]) {
    const body = text(file);
    if (body && body.includes(dev)) problems.push(`${file}: a release build would trust the development key (it may appear only in development-only sources)`);
  }
  const releaseTrust = text('mobile/android/app/src/release/java/com/agentempire/mobile/DevTrust.java');
  if (releaseTrust === null) problems.push('mobile/android/app/src/release/java/com/agentempire/mobile/DevTrust.java: missing (the release variant must declare no development key)');
  for (const file of walk('mobile/ios/AgentEmpire').filter((f) => f.endsWith('.swift'))) {
    const stack = [];
    text(file).split('\n').forEach((line, i) => {
      const t = line.trim();
      if (/^#if\b/.test(t)) stack.push(t === '#if DEBUG');
      else if (/^#else\b/.test(t) || /^#elseif\b/.test(t)) stack[stack.length - 1] = false;
      else if (/^#endif\b/.test(t)) stack.pop();
      else if (line.includes(dev) && !(stack.length && stack[stack.length - 1])) problems.push(`${file}:${i + 1}: the development key outside #if DEBUG (a Release build would trust it)`);
    });
  }
  return problems;
}

/**
 * Release gate: the pinned key is not the development key, every file listed in tools/release/config.json
 * `pinnedKeyFiles` carries it, no release build would trust the development key (checkReleaseTrust), and (when a
 * signing key is given) the signing key is its private half.
 */
export function checkPinnedKey({ root = ROOT, signingKey, allowDev = false } = {}) {
  const problems = [];
  const { release, dev } = pinnedKeys(root);
  const devDerived = publicKeyBase64(devPrivateKey());
  if (dev !== devDerived) problems.push(`${DEV_KEY_FILE}: is not the development key (${devDerived})`);
  if (release === devDerived && !allowDev) problems.push(`${RELEASE_KEY_FILE}: RELEASE_PUBLIC_KEY is still the development key; paste the owner's public key (node tools/release/generate-signing-key.mjs)`);
  const config = JSON.parse(readFileSync(path.join(root, 'tools/release/config.json'), 'utf8'));
  for (const file of config.pinnedKeyFiles ?? []) {
    let text = '';
    try { text = readFileSync(path.join(root, file), 'utf8'); } catch { problems.push(`${file}: missing (listed in tools/release/config.json pinnedKeyFiles)`); continue; }
    if (!text.includes(release)) problems.push(`${file}: does not pin RELEASE_PUBLIC_KEY ${release}`);
  }
  problems.push(...checkReleaseTrust(root, dev));
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
    } else if (command === 'check-trust') {
      if (!files.length) throw new Error('usage: sign.mjs check-trust <built app dir or file>...');
      const { dev } = pinnedKeys();
      const hits = files.flatMap((f) => devKeyFiles(f, dev).map((h) => path.join(f, h)));
      if (hits.length) { for (const h of hits.slice(0, 20)) console.error(`error: ${h} carries the development release key (or dev-trust.json): a development build`); process.exit(1); }
      console.log(`no development key trust in ${files.join(', ')}`);
    } else {
      throw new Error('usage: sign.mjs sign [--dev] <file>... | verify <file> [--public-key <b64>] | public-key [--dev] | check-key [--allow-dev] | check-trust <dir>...');
    }
  } catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
