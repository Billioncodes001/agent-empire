// Builds the Squirrel.Windows installer and update feed for the packaged Windows app (run on Windows, after
// `node tools/prepare-desktop.mjs --platform=win32 --arch=x64 --skip-archive` and any exe signing):
//   <out>/Agent-Empire-Windows-Setup.exe           per-user installer (Squirrel Setup.exe), always
//   <out>/AgentEmpire-<nugetVersion>-full.nupkg     full update package      } signed builds only: the shell installs
//   <out>/RELEASES                                  Squirrel feed index       } in place only from a signed release
//   <info>/windows-x64.json                         build info {signed} for the channel builder (never published)
// An unsigned build publishes the installer alone: no installed app reads the package of an unsigned release
// (channel.mjs sets auto: false, and desktop/main.cjs only fetches the nupkg when auto is true).
//
// Signing: when WINDOWS_SIGN_PARAMS is set (signtool arguments, e.g. /f "cert.pfx" /p "…" /fd sha256 /tr … /td sha256),
// Squirrel signs Setup.exe and the executables in the package with them.
//
//   node tools/release/package-windows-installer.mjs --app "release/windows/Agent Empire-win32-x64" --out release/assets --info release/build-info --signed true|false
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVersion, ROOT } from './version.mjs';
import { NAMES, nugetVersion, nupkgName, SQUIRREL_ID, writeBuildInfo } from './assets.mjs';

export { nugetVersion, nupkgName, SQUIRREL_ID };

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
    const signedArg = option(args, '--signed', null);
    if (!['true', 'false'].includes(signedArg)) throw new Error('--signed must be true or false');
    const signed = signedArg === 'true';
    const infoDir = path.resolve(option(args, '--info', path.join(ROOT, 'release/build-info')));
    const version = readVersion();
    if (!existsSync(path.join(appDirectory, 'Agent Empire.exe'))) throw new Error(`${appDirectory} has no Agent Empire.exe`);
    const work = path.join(ROOT, 'release/squirrel');
    rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
    const require = createRequire(path.join(ROOT, 'desktop/package.json'));
    const { createWindowsInstaller } = require('electron-winstaller');
    const signWithParams = process.env.WINDOWS_SIGN_PARAMS || undefined;
    const setupExe = NAMES.windowsSetup;
    await createWindowsInstaller({
      appDirectory, outputDirectory: work, name: SQUIRREL_ID, exe: 'Agent Empire.exe', title: 'Agent Empire', productName: 'Agent Empire',
      authors: 'Agent Empire', owners: 'Agent Empire', description: 'Agent Empire desktop', version: nugetVersion(version),
      setupExe, noMsi: true, ...(signWithParams ? { signWithParams } : {}),
    });
    const problems = checkFeed(work, version);
    if (!existsSync(path.join(work, setupExe))) problems.push(`${setupExe} was not produced (found ${readdirSync(work).join(', ')})`);
    if (problems.length) throw new Error(problems.join('; '));
    mkdirSync(outDir, { recursive: true });
    for (const name of signed ? [setupExe, nupkgName(version), 'RELEASES'] : [setupExe]) {
      copyFileSync(path.join(work, name), path.join(outDir, name));
      console.log(`${name}  ${statSync(path.join(outDir, name)).size} bytes`);
    }
    writeBuildInfo(infoDir, { platform: 'windows', arch: 'x64', signed });
    if (!signed) console.log('Unsigned build: only the installer is published (no in-place updates).');
    if (!signWithParams) console.log('Squirrel installer is not signed by this step (unsigned, or signed afterwards by Azure Artifact Signing).');
  } catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
