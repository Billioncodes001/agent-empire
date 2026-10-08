// Refuses a built web client that came from a fixture build (vite --mode fixture, see src/client/cloud/api-base.ts),
// or that carries the public development release key (REL-07: only development page builds trust it, see
// src/client/update/trust.ts). A fixture build points the GitHub client at a loopback fake and trusts dev-signed
// updates; it must never be packaged into desktop or mobile apps or deployed. Used by `npm run build:client`
// (dist/public), tools/prepare-desktop.mjs, tools/release/package-game.mjs, and as a CLI by packaging scripts:
//
//   node tools/check-no-fixture.mjs <dir>     exits 1 and names the files when the marker or the dev key is found
//
// devKeyFiles() scans every file (any type, as bytes) for the development key or a desktop dev-trust.json; the release
// gate uses it on whole packaged apps (`node tools/release/sign.mjs check-trust <dir>`).
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_MARKER = '__AGENT_EMPIRE_FIXTURE_BUILD__';
const TEXT = /\.(m?js|cjs|html|json)$/i;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The public development release key, read from src/shared/release-key.ts. */
export function devReleaseKey(root = ROOT) {
  const m = /export const DEV_RELEASE_PUBLIC_KEY = '([A-Za-z0-9+/]{43}=)';/.exec(readFileSync(path.join(root, 'src/shared/release-key.ts'), 'utf8'));
  if (!m) throw new Error('src/shared/release-key.ts must declare DEV_RELEASE_PUBLIC_KEY as a string literal');
  return m[1];
}

/** Files under `dir` that carry the fixture marker, the fixture override variable name, or the development key. */
export function fixtureFiles(dir) {
  const hits = [];
  const devKey = devReleaseKey();
  for (const name of readdirSync(dir, { recursive: true })) {
    const rel = String(name);
    if (!TEXT.test(rel)) continue;
    const text = readFileSync(path.join(dir, rel), 'utf8');
    if (text.includes(FIXTURE_MARKER) || text.includes('VITE_AGENT_EMPIRE_FAKE_GITHUB_API') || text.includes(devKey)) hits.push(rel);
  }
  return hits;
}

/** Every file under `dir` (or `dir` itself when it is a file) whose bytes contain the development key, plus any dev-trust.json. */
export function devKeyFiles(dir, devKey = devReleaseKey()) {
  const needle = Buffer.from(devKey);
  const stat = lstatSync(dir);
  const files = stat.isFile() ? [['', dir]] : readdirSync(dir, { recursive: true }).map((name) => [String(name), path.join(dir, String(name))]);
  const hits = [];
  for (const [rel, full] of files) {
    const s = lstatSync(full);
    if (!s.isFile()) continue;
    if (path.basename(full) === 'dev-trust.json' || readFileSync(full).includes(needle)) hits.push(rel || path.basename(full));
  }
  return hits;
}

export function assertNoFixtureBuild(dir) {
  const hits = fixtureFiles(dir);
  if (hits.length) throw new Error(`${dir} is a fixture build or another development build (it talks to a fake GitHub or trusts the development release key): ${hits.slice(0, 5).join(', ')}. Rebuild with \`npm run build:client\` before packaging.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node tools/check-no-fixture.mjs <built client dir>'); process.exit(2); }
  try { assertNoFixtureBuild(dir); console.log(`no fixture build markers or development key in ${dir}`); }
  catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
