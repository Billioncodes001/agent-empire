// Builds the update channel files every app reads (docs/team/RELEASE_PLAN.md, "Update channel contract") from a staged
// release, and checks that the folder about to be published holds exactly what the signed channel lists.
// No network: URLs are derived from the repository, tag and asset names (tools/release/assets.mjs).
//
//   node tools/release/channel.mjs --assets release/assets --info release/build-info [--repo owner/repo]
//        [--notes-file notes.md] [--published-at <ISO time>] [--play-published]
//   node tools/release/channel.mjs check-publish --assets release/assets
//
// Inputs: release/assets holds the files that may be published; release/build-info holds each platform's build info
// ({signed}) and game-manifest.json. Nothing outside the plan below may sit in release/assets: an unplanned file is
// refused, so it can never reach the release page.
//
// Writes channel-<channel>.json for the version's channel (stable, or beta for any prerelease); a stable release also
// writes channel-beta.json so beta users are offered it too. For signed macOS builds it writes the Squirrel.Mac static
// feeds RELEASES-darwin-<arch>.json. Sign the channel files afterwards (sign.mjs sign <assets>/channel-*.json), then
// run check-publish.
//
// What is published (each file has a reader; docs/team/reports/release-assets.md):
//   agent-empire-game-<v>.zip, agent-empire-coordinator.mjs         game bundle (over the air) and cloud coordinator
//   Agent-Empire-Mac-<Apple-Silicon|Intel>.dmg                      macOS app
//   Agent-Empire-Windows-Setup.exe                                  Windows installer (Squirrel.Windows)
//   Agent-Empire-Android.apk                                        Android app
//   channel-<channel>.json(.sig)                                    the signed channel, with every asset's sha256
//   signed macOS only:   Agent-Empire-Mac-<arch label>-Update.zip, RELEASES-darwin-<arch>.json
//   signed Windows only: AgentEmpire-<nugetVersion>-full.nupkg, RELEASES
//
// Desktop update feeds (Electron's built-in autoUpdater), in each channel file as shell.<os>.feed:
//   stable channel: https://github.com/<repo>/releases/latest/download[/RELEASES-darwin-<arch>.json]
//   beta channel:   https://github.com/<repo>/releases/download/<tag>[/RELEASES-darwin-<arch>.json]
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_NAME } from './package-game.mjs';
import { checkFeed } from './package-windows-installer.mjs';
import { MAC_ARCHS, NAMES, readBuildInfo } from './assets.mjs';
import { parseVersion, readVersion, releaseChannel, ROOT, versionCode } from './version.mjs';

export const COORDINATOR_NAME = NAMES.coordinator;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CHANNEL_FILE = /^channel-(stable|beta)\.json$/;

/** The coordinator state schema the bundle writes (src/cloud/schema.ts CLOUD_SCHEMA_VERSION). */
export function coordinatorSchema(root = ROOT) {
  const m = /export const CLOUD_SCHEMA_VERSION = (\d+);/.exec(readFileSync(path.join(root, 'src/cloud/schema.ts'), 'utf8'));
  if (!m) throw new Error('src/cloud/schema.ts no longer exports CLOUD_SCHEMA_VERSION as a number literal');
  return Number(m[1]);
}

/** The Squirrel.Mac static-storage feed (Electron autoUpdater with serverType "json"; Electron docs "Updating Applications", static storage RELEASES.json format) for one signed zip. */
export function squirrelFeed({ version, url, notes, publishedAt }) {
  return { currentRelease: version, releases: [{ version, updateTo: { version, pub_date: publishedAt, notes, name: version, url } }] };
}
const feedText = (args) => JSON.stringify(squirrelFeed(args), null, 2) + '\n';
const isoSeconds = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The release plan for a staged folder: which platform builds exist, their signing state, and the files to publish.
 * Throws when release/assets and the build info disagree, or when release/assets holds anything unplanned.
 */
export function planRelease({ assetsDir, infoDir, version }) {
  parseVersion(version);
  const names = readdirSync(assetsDir).filter((n) => !n.startsWith('.'));
  const info = readBuildInfo(infoDir);
  const problems = [];
  const planned = new Set([NAMES.game(version), NAMES.coordinator]);
  const generated = new Set(); // written by this tool
  const has = (name) => names.includes(name);
  const need = (name, why) => { planned.add(name); if (!has(name)) problems.push(`${name} is missing (${why})`); };
  const orphan = (name) => { if (has(name)) problems.push(`${name} would be published but no updater reads it (the build is not signed)`); planned.add(name); };

  const mac = {};
  for (const arch of MAC_ARCHS) {
    const built = info.macos?.[arch];
    if (!built) { if (has(NAMES.macDmg(arch))) problems.push(`${NAMES.macDmg(arch)} has no build info (release/build-info/macos-${arch}.json)`); continue; }
    need(NAMES.macDmg(arch), `macOS ${arch} build info exists`);
    if (built.signed) { need(NAMES.macZip(arch), 'the signed build updates in place from it'); generated.add(NAMES.macFeed(arch)); }
    else orphan(NAMES.macZip(arch));
    mac[arch] = { dmg: NAMES.macDmg(arch), zip: built.signed ? NAMES.macZip(arch) : null, signed: built.signed };
  }
  let windows = null;
  if (info.windows) {
    need(NAMES.windowsSetup, 'Windows build info exists');
    if (info.windows.signed) {
      need(NAMES.nupkg(version), 'the signed build updates in place from it');
      need(NAMES.windowsFeedIndex, 'the Squirrel.Windows feed index of the signed build');
      if (has(NAMES.nupkg(version)) && has(NAMES.windowsFeedIndex)) problems.push(...checkFeed(assetsDir, version));
    } else { orphan(NAMES.nupkg(version)); orphan(NAMES.windowsFeedIndex); }
    windows = { setup: NAMES.windowsSetup, nupkg: info.windows.signed ? NAMES.nupkg(version) : null, signed: info.windows.signed };
  } else if (has(NAMES.windowsSetup)) problems.push(`${NAMES.windowsSetup} has no build info (release/build-info/windows-x64.json)`);
  let android = null;
  if (info.android) { need(NAMES.androidApk, 'Android build info exists'); android = { apk: NAMES.androidApk, signed: info.android.signed }; }
  else if (has(NAMES.androidApk)) problems.push(`${NAMES.androidApk} has no build info (release/build-info/android.json)`);

  for (const name of names) {
    if (planned.has(name) || generated.has(name) || CHANNEL_FILE.test(name) || CHANNEL_FILE.test(name.replace(/\.sig$/, ''))) continue;
    problems.push(`${name} is not a release asset of ${version} (only planned files are published)`);
  }
  if (problems.length) throw new Error(problems.join('; '));
  const publish = [...planned].filter((n) => has(n)).concat([...generated]).sort();
  return { mac, windows, android, publish, feeds: [...generated] };
}

/**
 * Builds the channel document. `assetsDir` must hold the game zip and the coordinator, `infoDir` the game manifest and
 * the build info; platform builds that are absent are published as null so apps fall back to the release page.
 */
export function buildChannel({ assetsDir, infoDir, version, channel, repo, publishedAt, notes, config, playPublished = false, root = ROOT }) {
  parseVersion(version);
  if (!['stable', 'beta'].includes(channel)) throw new Error(`Unknown channel ${channel}`);
  if (channel === 'stable' && releaseChannel(version) !== 'stable') throw new Error(`${version} is a prerelease; it cannot go to the stable channel`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Repository must be owner/name, got "${repo}"`);
  if (Number.isNaN(Date.parse(publishedAt))) throw new Error(`publishedAt is not a date: ${publishedAt}`);
  const tag = `v${version}`;
  const download = (name) => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const page = `https://github.com/${repo}/releases/tag/${tag}`;
  // Stable apps follow GitHub's "latest release" redirect; beta apps follow this exact tag (the channel file is the pointer).
  const feedBase = channel === 'stable' ? `https://github.com/${repo}/releases/latest/download` : `https://github.com/${repo}/releases/download/${tag}`;
  const game = NAMES.game(version);
  if (!existsSync(path.join(assetsDir, game))) throw new Error(`${assetsDir} must contain ${game}`);
  if (!existsSync(path.join(assetsDir, NAMES.coordinator))) throw new Error(`${assetsDir} must contain ${NAMES.coordinator}`);
  const manifestPath = path.join(infoDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) throw new Error(`${infoDir} must contain ${MANIFEST_NAME} (package-game.mjs --manifest-dir)`);
  const plan = planRelease({ assetsDir, infoDir, version });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const gameSha = sha256(readFileSync(path.join(assetsDir, game)));
  if (manifest.version !== version || manifest.file !== game || manifest.sha256 !== gameSha)
    throw new Error(`${MANIFEST_NAME} does not describe ${game} for ${version}`);
  const at = isoSeconds(publishedAt);
  // Generated feeds are hashed from the exact text writeRelease writes.
  const bytesOf = (name) => {
    const feedArch = MAC_ARCHS.find((arch) => NAMES.macFeed(arch) === name && plan.feeds.includes(name));
    return feedArch ? Buffer.from(feedText({ version, url: download(plan.mac[feedArch].zip), notes, publishedAt: at })) : readFileSync(path.join(assetsDir, name));
  };
  const file = (name) => ({ name, url: download(name), sha256: sha256(bytesOf(name)) });

  const macArchs = Object.entries(plan.mac);
  const macAuto = macArchs.length > 0 && macArchs.every(([, a]) => a.signed);
  const macos = macArchs.length ? {
    version, url: page, auto: macAuto,
    downloads: Object.fromEntries(macArchs.map(([arch, a]) => [arch, { dmg: file(a.dmg), ...(a.zip ? { zip: file(a.zip) } : {}), signed: a.signed }])),
    feed: macAuto ? Object.fromEntries(macArchs.map(([arch]) => [arch, `${feedBase}/${NAMES.macFeed(arch)}`])) : null,
  } : null;
  // Squirrel.Windows: in-place updates only from a signed installer build with its package (the shell verifies it).
  const w = plan.windows;
  const windows = w ? {
    version, url: page, auto: w.signed,
    downloads: { x64: { setup: file(w.setup), ...(w.nupkg ? { nupkg: file(w.nupkg) } : {}), signed: w.signed } },
    feed: w.signed ? feedBase : null,
  } : null;
  const android = plan.android ? {
    version, versionCode: versionCode(version), ...file(plan.android.apk), signed: plan.android.signed,
    play: playPublished ? config.playListing ?? null : null,
  } : null;
  const ios = { version, testflight: config.iosTestFlight ?? null, appStore: config.iosAppStore ?? null };
  return {
    schema: 1,
    channel,
    version,
    tag,
    publishedAt: at,
    notes,
    releasePage: page,
    game: { url: download(game), sha256: gameSha, bytes: manifest.bytes, minShell: manifest.minShell, commit: manifest.commit },
    shell: { macos, windows, android, ios },
    coordinator: { url: download(NAMES.coordinator), sha256: sha256(readFileSync(path.join(assetsDir, NAMES.coordinator))), schema: coordinatorSchema(root) },
    // The signed checksum list (it replaces SHA256SUMS): every published file except the channel files and signatures.
    assets: Object.fromEntries(plan.publish.map((name) => { const b = bytesOf(name); return [name, { sha256: sha256(b), bytes: b.length }]; })),
    mandatory: false,
  };
}

/** Writes the channel file(s) and the Squirrel.Mac feeds into assetsDir. Returns the written file names. */
export function writeRelease({ assetsDir, infoDir, version, repo, publishedAt, notes, config, playPublished = false, root = ROOT }) {
  const channels = releaseChannel(version) === 'stable' ? ['stable', 'beta'] : ['beta'];
  const written = [];
  let doc;
  for (const channel of channels) {
    doc = buildChannel({ assetsDir, infoDir, version, channel, repo, publishedAt, notes, config, playPublished, root });
    writeFileSync(path.join(assetsDir, NAMES.channel(channel)), JSON.stringify(doc, null, 2) + '\n');
    written.push(NAMES.channel(channel));
  }
  for (const [arch, entry] of Object.entries(doc.shell.macos?.downloads ?? {})) {
    if (!entry.zip) continue;
    writeFileSync(path.join(assetsDir, NAMES.macFeed(arch)), feedText({ version, url: entry.zip.url, notes, publishedAt: doc.publishedAt }));
    written.push(NAMES.macFeed(arch));
  }
  return written;
}

/**
 * Problems with a folder about to be published: it must hold exactly the files channel-beta.json lists in `assets`
 * (each matching its sha256 and size), the channel file(s) and one .sig per channel file. Signatures themselves are
 * checked with `sign.mjs verify`.
 */
export function checkPublished(assetsDir) {
  const beta = path.join(assetsDir, NAMES.channel('beta'));
  if (!existsSync(beta)) return [`${NAMES.channel('beta')} is missing (every release publishes it; installed apps read it)`];
  const listed = JSON.parse(readFileSync(beta, 'utf8')).assets ?? {};
  const names = readdirSync(assetsDir).filter((n) => !n.startsWith('.'));
  const channels = names.filter((n) => CHANNEL_FILE.test(n));
  const problems = [];
  for (const c of channels) {
    if (!names.includes(`${c}.sig`)) problems.push(`${c}.sig is missing`);
    if (c !== NAMES.channel('beta') && JSON.stringify(JSON.parse(readFileSync(path.join(assetsDir, c), 'utf8')).assets) !== JSON.stringify(listed)) problems.push(`${c} lists other assets than ${NAMES.channel('beta')}`);
  }
  for (const [name, entry] of Object.entries(listed)) {
    if (!names.includes(name)) { problems.push(`${name} is listed in ${NAMES.channel('beta')} but missing`); continue; }
    const bytes = readFileSync(path.join(assetsDir, name));
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) problems.push(`${name} does not match its sha256 in ${NAMES.channel('beta')}`);
  }
  for (const name of names) {
    if (Object.hasOwn(listed, name) || channels.includes(name) || channels.includes(name.replace(/\.sig$/, ''))) continue;
    problems.push(`${name} is not listed in ${NAMES.channel('beta')} and must not be published`);
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
    const assetsDir = path.resolve(option(args, '--assets', path.join(ROOT, 'release/assets')));
    if (args[0] === 'check-publish') {
      const problems = checkPublished(assetsDir);
      if (problems.length) { for (const p of problems) console.error(`error: ${p}`); process.exit(1); }
      const names = readdirSync(assetsDir).filter((n) => !n.startsWith('.')).sort();
      console.log(`${names.length} files to publish, each listed with its sha256 in the signed channel:\n  ${names.join('\n  ')}`);
    } else {
      const infoDir = path.resolve(option(args, '--info', path.join(ROOT, 'release/build-info')));
      const config = JSON.parse(readFileSync(path.join(ROOT, 'tools/release/config.json'), 'utf8'));
      const version = readVersion();
      const repo = option(args, '--repo', process.env.GITHUB_REPOSITORY || config.repository);
      const notesFile = option(args, '--notes-file', null);
      const notes = (notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : `Agent Empire ${version}`).trim().slice(0, 4000);
      const publishedAt = option(args, '--published-at', new Date().toISOString());
      for (const name of writeRelease({ assetsDir, infoDir, version, repo, publishedAt, notes, config, playPublished: args.includes('--play-published') }))
        console.log(`wrote ${path.join(assetsDir, name)}`);
    }
  } catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
