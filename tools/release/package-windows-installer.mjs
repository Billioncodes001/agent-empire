// Builds the Squirrel.Windows installer and update feed for the packaged Windows app (run on Windows, after
// `node tools/prepare-desktop.mjs --platform=win32 --arch=x64 --skip-archive` and any exe signing):
//   <out>/Agent-Empire-<v>-windows-x64-Setup[-unsigned].exe   per-user installer (Squirrel Setup.exe)
//   <out>/AgentEmpire-<nugetVersion>-full.nupkg                 full update package
//   <out>/RELEASES                                              Squirrel feed index ("SHA1 file size" per line)
// Electron's built-in autoUpdater on Windows reads <feed>/RELEASES and then downloads <feed>/<nupkg>, so publishing
// these three files as release assets makes the release download URL a Squirrel feed (docs/team/RELEASE_PLAN.md).
//
// Signing: when WINDOWS_SIGN_PARAMS is set (signtool arguments, e.g. /f "cert.pfx" /p "…" /fd sha256 /tr … /td sha256),
// Squirrel signs Setup.exe and the executables in the package with them.
//
//   node tools/release/package-windows-installer.mjs --app "release/windows/Agent Empire-win32-x64" --out release/assets [--label -unsigned]
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersion, readVersion, ROOT } from './version.mjs';

/** Squirrel package id: no spaces; also the install folder under %LocalAppData%. Never change it after a release. */
export const SQUIRREL_ID = 'AgentEmpire';

/**
 * The NuGet (SemVer 1) version Squirrel uses. NuGet 2 compares prerelease labels as strings, so the number is
 * zero-padded to keep beta.2 < beta.10: 1.0.0-beta.2 -> 1.0.0-beta002, 1.0.0 -> 1.0.0.
 */
export function nugetVersion(version) {
  const v = parseVersion(version);
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.pre ? `${core}-${v.pre.tag}${String(v.pre.n).padStart(3, '0')}` : core;
}

export const nupkgName = version => `${SQUIRREL_ID}-${nugetVersion(version)}-full.nupkg`;

/** Parses a Squirrel RELEASES file into { sha1, file, size } entries. */
export function parseReleases(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(line => line.trim());
  return lines.map(line => {
    const m = /^([0-9A-Fa-f]{40}) (\S+\.nupkg) (\d+)$/.exec(line.trim());
    if (!m) throw new Error(`Malformed RELEASES line: ${line}`);
    return { sha1: m[1].toUpperCase(), file: m[2], size: Number(m[3]) };
  });
}

/** Problems with a feed folder: RELEASES must list exactly the expected full package, with matching SHA1 and size. */
export function checkFeed(dir, version) {
  const problems = [];
  const releasesPath = path.join(dir, 'RELEASES');
  if (!existsSync(releasesPath)) return ['RELEASES is missing'];
  let entries;
  try { entries = parseReleases(readFileSync(releasesPath, 'utf8')); } catch (error) { return [error.message]; }
  const expected = nupkgName(version);
  if (entries.length !== 1 || entries[0].file !== expected) problems.push(`RELEASES should list only ${expected}, has ${entries.map(e => e.file).join(', ') || 'nothing'}`);
  for (const entry of entries) {
    const file = path.join(dir, entry.file);
    if (!existsSync(file)) { problems.push(`${entry.file} is listed in RELEASES but missing`); continue; }
    const bytes = readFileSync(file);
    if (bytes.length !== entry.size) problems.push(`${entry.file} is ${bytes.length} bytes, RELEASES says ${entry.size}`);
    if (createHash('sha1').update(bytes).digest('hex').toUpperCase() !== entry.sha1) problems.push(`${entry.file} SHA1 does not match RELEASES`);
  }
  return problems;
}

function option(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (process.platform !== 'win32') throw new Error('Squirrel.Windows installers are built on Windows');
    const appDirectory = path.resolve(option(args, '--app', path.join(ROOT, 'release/windows/Agent Empire-win32-x64')));
    const outDir = path.resolve(option(args, '--out', path.join(ROOT, 'release/assets')));
    const label = option(args, '--label', '');
    if (!['', '-unsigned'].includes(label)) throw new Error('--label must be empty or -unsigned');
    const version = readVersion();
    if (!existsSync(path.join(appDirectory, 'Agent Empire.exe'))) throw new Error(`${appDirectory} has no Agent Empire.exe`);
    const work = path.join(ROOT, 'release/squirrel');
    rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
    const require = createRequire(path.join(ROOT, 'desktop/package.json'));
    const { createWindowsInstaller } = require('electron-winstaller');
    const signWithParams = process.env.WINDOWS_SIGN_PARAMS || undefined;
    const setupExe = `Agent-Empire-${version}-windows-x64-Setup${label}.exe`;
    await createWindowsInstaller({
      appDirectory, outputDirectory: work, name: SQUIRREL_ID, exe: 'Agent Empire.exe', title: 'Agent Empire', productName: 'Agent Empire',
      authors: 'Agent Empire', owners: 'Agent Empire', description: 'Agent Empire desktop', version: nugetVersion(version),
      setupExe, noMsi: true, ...(signWithParams ? { signWithParams } : {}),
    });
    const problems = checkFeed(work, version);
    if (!existsSync(path.join(work, setupExe))) problems.push(`${setupExe} was not produced (found ${readdirSync(work).join(', ')})`);
    if (problems.length) throw new Error(problems.join('; '));
    mkdirSync(outDir, { recursive: true });
    for (const name of [setupExe, nupkgName(version), 'RELEASES']) {
      copyFileSync(path.join(work, name), path.join(outDir, name));
      console.log(`${name}  ${statSync(path.join(outDir, name)).size} bytes`);
    }
    if (!signWithParams) console.log('Squirrel installer is not signed by this step (unsigned, or signed afterwards by Azure Artifact Signing).');
  } catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
