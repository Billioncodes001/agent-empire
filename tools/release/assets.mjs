// Release asset names and per-platform build info: the one place that decides what a GitHub Release contains
// (docs/RELEASING.md "What each release contains"; reasoning in docs/team/reports/release-assets.md).
//
// Files people download have plain names without version or signing jargon, so a stable release can be linked as
// https://github.com/<repo>/releases/latest/download/<name> forever. The version is in the release tag and title, and
// the signing state is in the release notes and the signed channel file.
//
// Machine files keep the names installed apps already look for: channel-<channel>.json(.sig) (every shell reads
// releases/download/v<version>/channel-beta.json), AgentEmpire-<nuget>-full.nupkg (the v1.0.0-beta.1 desktop shell
// accepts only that name) and RELEASES-darwin-<arch>.json (the stable macOS feed pattern).
//
// Build info: each platform job writes <info>/<platform>[-<arch>].json = {platform, arch?, signed}. The channel
// builder reads it instead of guessing the signing state from file names. It is never published.
//
//   node tools/release/assets.mjs build-info --out <dir> --platform android|macos|windows [--arch arm64|x64] --signed true|false
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameZipName } from './package-game.mjs';
import { parseVersion } from './version.mjs';

export const MAC_ARCHS = ['arm64', 'x64'];
const MAC_LABEL = { arm64: 'Apple-Silicon', x64: 'Intel' };
const macLabel = (arch) => {
  if (!MAC_LABEL[arch]) throw new Error(`Unknown macOS architecture ${arch}`);
  return MAC_LABEL[arch];
};

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

export const nupkgName = (version) => `${SQUIRREL_ID}-${nugetVersion(version)}-full.nupkg`;

export const NAMES = Object.freeze({
  // For people.
  macDmg: (arch) => `Agent-Empire-Mac-${macLabel(arch)}.dmg`,
  windowsSetup: 'Agent-Empire-Windows-Setup.exe',
  androidApk: 'Agent-Empire-Android.apk',
  // For updaters (published only when a reader exists).
  macZip: (arch) => `Agent-Empire-Mac-${macLabel(arch)}-Update.zip`,
  macFeed: (arch) => (macLabel(arch) && `RELEASES-darwin-${arch}.json`),
  windowsFeedIndex: 'RELEASES',
  nupkg: nupkgName,
  game: gameZipName,
  coordinator: 'agent-empire-coordinator.mjs',
  channel: (channel) => `channel-${channel}.json`,
  // Never published: the Play job takes it from its own workflow artifact.
  androidAab: 'Agent-Empire-Android.aab',
});

const PLATFORMS = { macos: MAC_ARCHS, windows: ['x64'], android: null };

function checkInfo({ platform, arch, signed }) {
  if (!Object.hasOwn(PLATFORMS, platform)) throw new Error(`Unknown platform ${platform} (macos, windows or android)`);
  const archs = PLATFORMS[platform];
  if (archs && !archs.includes(arch)) throw new Error(`${platform} build info needs an arch (${archs.join(' or ')}), got ${arch}`);
  if (!archs && arch !== undefined) throw new Error(`${platform} build info takes no arch`);
  if (typeof signed !== 'boolean') throw new Error(`${platform} build info: signed must be true or false, got ${JSON.stringify(signed)}`);
}

const infoFile = ({ platform, arch }) => `${platform}${PLATFORMS[platform] ? `-${arch}` : ''}.json`;

/** Records one platform build's signing state in `dir`. */
export function writeBuildInfo(dir, info) {
  checkInfo(info);
  mkdirSync(dir, { recursive: true });
  const doc = { platform: info.platform, ...(info.arch !== undefined ? { arch: info.arch } : {}), signed: info.signed };
  writeFileSync(path.join(dir, infoFile(info)), JSON.stringify(doc, null, 2) + '\n');
}

/** All build info in `dir` as {macos?: {arm64?: {signed}, x64?: {signed}}, windows?: {signed}, android?: {signed}}. */
export function readBuildInfo(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((n) => /^(macos|windows|android)(-\w+)?\.json$/.test(n)).sort()) {
    const info = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    checkInfo(info);
    if (name !== infoFile(info)) throw new Error(`${name} describes ${infoFile(info)}`);
    if (info.platform === 'macos') (out.macos ??= {})[info.arch] = { signed: info.signed };
    else out[info.platform] = { signed: info.signed };
  }
  return out;
}

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command !== 'build-info') throw new Error('usage: assets.mjs build-info --out <dir> --platform <macos|windows|android> [--arch <arch>] --signed <true|false>');
    const signed = option(args, '--signed');
    if (!['true', 'false'].includes(signed)) throw new Error('--signed must be true or false');
    const out = option(args, '--out');
    if (!out) throw new Error('--out <dir> is required');
    const info = { platform: option(args, '--platform'), arch: option(args, '--arch'), signed: signed === 'true' };
    writeBuildInfo(path.resolve(out), info);
    console.log(`${infoFile(info)}: ${info.signed ? 'signed' : 'not signed'}`);
  } catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
