// Packs the built game (dist/public) as the over-the-air game bundle (docs/team/RELEASE_PLAN.md, step 2):
//   agent-empire-game-<version>.zip   deterministic: the same build always gives the same bytes
//   game-manifest.json                version, sha256 and size of the zip, minShell, build commit
// Sign the manifest afterwards: node tools/release/sign.mjs sign <out>/game-manifest.json
//
//   node tools/release/package-game.mjs [--dist dist/public] [--out release/assets] [--commit <sha>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoFixtureBuild } from '../check-no-fixture.mjs';
import { parseVersion, readVersion, ROOT } from './version.mjs';
import { listFiles, readZip, zipDirectory } from './zip.mjs';

export const MANIFEST_NAME = 'game-manifest.json';
export const gameZipName = version => `agent-empire-game-${version}.zip`;

export function packageGame({ dist, outDir, version, commit, minShell }) {
  parseVersion(version);
  parseVersion(minShell);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`commit must be a full 40-character SHA, got "${commit}"`);
  if (!existsSync(path.join(dist, 'index.html'))) throw new Error(`${dist}/index.html is missing; run \`npm run build\` first`);
  assertNoFixtureBuild(dist);
  const zip = zipDirectory(dist);
  const files = readZip(zip);
  if (files.size !== listFiles(dist).length || !files.has('index.html')) throw new Error('The game zip does not contain every built file');
  mkdirSync(outDir, { recursive: true });
  const file = gameZipName(version);
  writeFileSync(path.join(outDir, file), zip);
  const manifest = {
    schema: 1,
    name: 'agent-empire-game',
    version,
    file,
    bytes: zip.length,
    sha256: createHash('sha256').update(zip).digest('hex'),
    files: files.size,
    entry: 'index.html',
    minShell,
    commit,
  };
  const manifestPath = path.join(outDir, MANIFEST_NAME);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { zipPath: path.join(outDir, file), manifestPath, manifest };
}

function option(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const config = JSON.parse(readFileSync(path.join(ROOT, 'tools/release/config.json'), 'utf8'));
    const commit = option(args, '--commit', process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim());
    const result = packageGame({
      dist: path.resolve(option(args, '--dist', path.join(ROOT, 'dist/public'))),
      outDir: path.resolve(option(args, '--out', path.join(ROOT, 'release/assets'))),
      version: readVersion(), commit, minShell: config.minShell,
    });
    console.log(`${result.zipPath}\n  ${result.manifest.files} files, ${result.manifest.bytes} bytes, sha256 ${result.manifest.sha256}\n${result.manifestPath}`);
  } catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
