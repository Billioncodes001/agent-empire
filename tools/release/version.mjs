// One version for the game, server, coordinator, desktop, Android and iOS (docs/team/RELEASE_PLAN.md, REL-01).
// The root package.json `version` is the source of truth; everything else is derived and synced by this script.
//
//   node tools/release/version.mjs set 1.0.0-beta.2      write the version everywhere (npm run version:set -- 1.0.0-beta.2)
//   node tools/release/version.mjs sync                  copy package.json's version to every other file
//   node tools/release/version.mjs check                 exit 1 and name each file that disagrees (npm run version:check)
//   node tools/release/version.mjs info                  print the derived values as JSON (used by the release workflow)
//   node tools/release/version.mjs tag-check <tag> [--sha <commit>] [--main <ref>]
//                                                        exit 1 unless tag == v<version> and the commit is on main
//
// Versions are X.Y.Z or X.Y.Z-(alpha|beta|rc).N. Android versionCode and the iOS build number are the same monotonic
// integer: MAJOR*10^7 + MINOR*10^5 + PATCH*10^3 + preRank, where preRank is alpha.N=100+N, beta.N=300+N, rc.N=600+N
// and a final release is 999. So 1.0.0-beta.1 = 10000301 < 1.0.0-rc.1 = 10000601 < 1.0.0 = 10000999 < 1.0.1-beta.1.
// iOS MARKETING_VERSION is the numeric X.Y.Z (App Store Connect does not accept prerelease suffixes).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;
const PRE_BASE = { alpha: 100, beta: 300, rc: 600 };
const PRE_MAX = 199;
const FINAL_RANK = 999;
// Google Play's versionCode ceiling.
const MAX_VERSION_CODE = 2_100_000_000;

/** Parses X.Y.Z[-(alpha|beta|rc).N]; throws with the accepted format on anything else. */
export function parseVersion(version) {
  const m = VERSION_RE.exec(String(version));
  if (!m) throw new Error(`Invalid version "${version}": use X.Y.Z or X.Y.Z-(alpha|beta|rc).N, e.g. 1.0.0-beta.1`);
  const [major, minor, patch] = [m[1], m[2], m[3]].map(Number);
  const pre = m[4] ? { tag: m[4], n: Number(m[5]) } : null;
  if (minor > 99 || patch > 99) throw new Error(`Invalid version "${version}": minor and patch must be at most 99 (versionCode mapping)`);
  if (pre && pre.n > PRE_MAX) throw new Error(`Invalid version "${version}": prerelease number must be at most ${PRE_MAX}`);
  return { major, minor, patch, pre, raw: String(version) };
}

/** The monotonic integer used as Android versionCode and iOS CURRENT_PROJECT_VERSION. */
export function versionCode(version) {
  const v = parseVersion(version);
  const rank = v.pre ? PRE_BASE[v.pre.tag] + v.pre.n : FINAL_RANK;
  const code = v.major * 1e7 + v.minor * 1e5 + v.patch * 1e3 + rank;
  if (code > MAX_VERSION_CODE) throw new Error(`Version ${version} maps to versionCode ${code}, above Google Play's limit`);
  return code;
}

/** Orders two versions the same way their version codes do. */
export function compareVersions(a, b) {
  return Math.sign(versionCode(a) - versionCode(b));
}

/** `beta` for any prerelease (alpha, beta, rc), `stable` otherwise. */
export function releaseChannel(version) {
  return parseVersion(version).pre ? 'beta' : 'stable';
}

/**
 * Until the first stable release (1.0.0) exists, a 1.0.0 pre-release is also the stable channel's release: it publishes
 * channel-stable.json and is GitHub's "latest" release (so not flagged pre-release). Installed v1.0.0-beta.1 apps default
 * to the stable channel and read .../releases/latest/download/channel-stable.json; without this that URL is a 404 and
 * they would never be offered an update (docs/team/reports/device-testing.md). Later pre-releases (1.0.1-beta.1, …)
 * leave the stable channel to the real stable release.
 */
export function stableBridge(version) {
  const v = parseVersion(version);
  return Boolean(v.pre) && v.major === 1 && v.minor === 0 && v.patch === 0;
}

export function versionInfo(version) {
  const v = parseVersion(version);
  const code = versionCode(version);
  return {
    version: v.raw, tag: `v${v.raw}`, prerelease: Boolean(v.pre), channel: releaseChannel(version),
    stableBridge: stableBridge(version), latest: !v.pre || stableBridge(version),
    androidVersionName: v.raw, androidVersionCode: code,
    iosMarketingVersion: `${v.major}.${v.minor}.${v.patch}`, iosBuildNumber: String(code),
  };
}

// Each target reads the versions it holds and rewrites them in place, leaving the rest of the file untouched.
const jsonVersion = /^(\s*"version":\s*")([^"]*)(")/m;
function lockTarget(file) {
  return {
    file,
    read: text => { const j = JSON.parse(text); return [j.version, j.packages?.['']?.version]; },
    expected: info => [info.version, info.version],
    write: (text, info) => {
      const j = JSON.parse(text);
      j.version = info.version;
      if (j.packages?.['']) j.packages[''].version = info.version;
      return JSON.stringify(j, null, 2) + '\n';
    },
  };
}
function packageTarget(file) {
  return {
    file,
    read: text => [JSON.parse(text).version],
    expected: info => [info.version],
    write: (text, info) => {
      if (!jsonVersion.test(text)) throw new Error(`${file} has no "version" field`);
      return text.replace(jsonVersion, `$1${info.version}$3`);
    },
  };
}
function regexTarget(file, rules) {
  return {
    file,
    read: text => rules.flatMap(([re]) => {
      const hits = [...text.matchAll(new RegExp(re.source, 'g'))].map(m => m[2]);
      if (!hits.length) throw new Error(`${file}: no match for ${re.source}`);
      return hits;
    }),
    // One expected value per occurrence of each rule, in read() order.
    expected: (info, text) => rules.flatMap(([re, value]) => [...text.matchAll(new RegExp(re.source, 'g'))].map(() => value(info))),
    write: (text, info) => rules.reduce((out, [re, value]) => {
      if (!re.test(out)) throw new Error(`${file}: no match for ${re.source}`);
      return out.replace(new RegExp(re.source, 'g'), (_, a, _old, b) => `${a}${value(info)}${b}`);
    }, text),
  };
}

export const TARGETS = [
  packageTarget('package.json'),
  lockTarget('package-lock.json'),
  packageTarget('desktop/package.json'),
  lockTarget('desktop/package-lock.json'),
  regexTarget('mobile/android/app/src/main/AndroidManifest.xml', [
    [/(android:versionCode=")([^"]*)(")/, i => String(i.androidVersionCode)],
    [/(android:versionName=")([^"]*)(")/, i => i.androidVersionName],
  ]),
  // The optional Gradle build (Android Studio) carries its own copy.
  regexTarget('mobile/android/app/build.gradle', [
    [/(versionCode )(\d+)()/, i => String(i.androidVersionCode)],
    [/(versionName ')([^']*)(')/, i => i.androidVersionName],
  ]),
  regexTarget('mobile/ios/AgentEmpire.xcodeproj/project.pbxproj', [
    [/(CURRENT_PROJECT_VERSION = )([^;]*)(;)/, i => i.iosBuildNumber],
    [/(MARKETING_VERSION = )([^;]*)(;)/, i => i.iosMarketingVersion],
  ]),
];

export function readVersion(root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

/** Writes `version` (default: package.json's) to every target. Returns the files that changed. */
export function syncVersion(root = ROOT, version = readVersion(root)) {
  const info = versionInfo(version);
  const changed = [];
  for (const target of TARGETS) {
    const file = path.join(root, target.file);
    const before = readFileSync(file, 'utf8');
    const after = target.write(before, info);
    if (after !== before) { writeFileSync(file, after); changed.push(target.file); }
  }
  return changed;
}

/** Problems with the synced versions; empty when everything matches package.json. */
export function checkVersion(root = ROOT) {
  const problems = [];
  let version;
  try { version = readVersion(root); versionInfo(version); }
  catch (error) { return [`package.json: ${error.message}`]; }
  const info = versionInfo(version);
  for (const target of TARGETS) {
    let text;
    try { text = readFileSync(path.join(root, target.file), 'utf8'); }
    catch { problems.push(`${target.file}: missing`); continue; }
    let found;
    try { found = target.read(text); }
    catch (error) { problems.push(`${target.file}: ${error.message}`); continue; }
    const want = target.expected(info, text);
    if (found.length !== want.length || found.some((value, i) => value !== want[i]))
      problems.push(`${target.file}: has ${found.join(', ')}; expected ${want.join(', ')}`);
  }
  return problems;
}

/** Problems with a release tag for `version`: the tag must be exactly v<version>. */
export function checkTag(tag, version) {
  const problems = [];
  const name = String(tag).replace(/^refs\/tags\//, '');
  try { parseVersion(version); } catch (error) { problems.push(error.message); return problems; }
  if (name !== `v${version}`) problems.push(`Tag ${name} does not match package.json version ${version} (expected v${version})`);
  return problems;
}

/** True when `sha` is reachable from `mainRef` (the tagged commit is on main). */
export function isOnMain(sha, mainRef = 'origin/main', cwd = ROOT) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, mainRef], { cwd, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function option(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const fail = lines => { for (const line of lines) console.error(`error: ${line}`); process.exit(1); };
  try {
    if (command === 'set') {
      const version = args[0];
      if (!version) fail(['usage: version.mjs set <X.Y.Z[-(alpha|beta|rc).N]>']);
      versionInfo(version);
      const pkg = path.join(ROOT, 'package.json');
      const text = readFileSync(pkg, 'utf8');
      writeFileSync(pkg, text.replace(jsonVersion, `$1${version}$3`));
      const changed = syncVersion(ROOT, version);
      console.log(`version ${version} (versionCode ${versionCode(version)}); updated: ${changed.join(', ') || 'nothing'}`);
    } else if (command === 'sync') {
      const changed = syncVersion();
      console.log(`version ${readVersion()}; updated: ${changed.join(', ') || 'nothing'}`);
    } else if (command === 'check') {
      const problems = checkVersion();
      if (problems.length) fail([...problems, 'Run `npm run version:set -- <version>` (or `node tools/release/version.mjs sync`).']);
      console.log(`version ${readVersion()} is in sync across ${TARGETS.length} files`);
    } else if (command === 'info') {
      console.log(JSON.stringify(versionInfo(readVersion()), null, 2));
    } else if (command === 'tag-check') {
      const tag = args[0];
      if (!tag) fail(['usage: version.mjs tag-check <tag> [--sha <commit>] [--main <ref>]']);
      const problems = checkTag(tag, readVersion());
      const sha = option(args, '--sha', 'HEAD');
      const main = option(args, '--main', 'origin/main');
      if (!isOnMain(sha, main)) problems.push(`Commit ${sha} is not on ${main}; releases are tagged on main only`);
      if (problems.length) fail(problems);
      console.log(`tag ${tag} matches the version and ${sha} is on ${main}`);
    } else {
      fail(['usage: version.mjs set <version> | sync | check | info | tag-check <tag> [--sha <commit>] [--main <ref>]']);
    }
  } catch (error) { fail([error.message]); }
}
