// Refuses a built web client that came from a fixture build (vite --mode fixture, see src/client/cloud/api-base.ts).
// A fixture build points the GitHub client at a loopback fake; it must never be packaged into desktop or mobile apps or
// deployed. Used by `npm run build:client` (dist/public), tools/prepare-desktop.mjs, and as a CLI by packaging scripts:
//
//   node tools/check-no-fixture.mjs <dir>     exits 1 and names the files when the marker is found
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_MARKER = '__AGENT_EMPIRE_FIXTURE_BUILD__';
const TEXT = /\.(m?js|html|json)$/i;

/** Files under `dir` that carry the fixture marker or the fixture override variable name. */
export function fixtureFiles(dir) {
  const hits = [];
  for (const name of readdirSync(dir, { recursive: true })) {
    const rel = String(name);
    if (!TEXT.test(rel)) continue;
    const text = readFileSync(path.join(dir, rel), 'utf8');
    if (text.includes(FIXTURE_MARKER) || text.includes('VITE_AGENT_EMPIRE_FAKE_GITHUB_API')) hits.push(rel);
  }
  return hits;
}

export function assertNoFixtureBuild(dir) {
  const hits = fixtureFiles(dir);
  if (hits.length) throw new Error(`${dir} is a fixture build (it talks to a fake GitHub): ${hits.slice(0, 5).join(', ')}. Rebuild with \`npm run build:client\` before packaging.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node tools/check-no-fixture.mjs <built client dir>'); process.exit(2); }
  try { assertNoFixtureBuild(dir); console.log(`no fixture build markers in ${dir}`); }
  catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
