// Builds the update channel files every app reads (docs/team/RELEASE_PLAN.md, "Update channel contract") from the
// release assets in one folder. No network: URLs are derived from the repository, tag and asset names.
//
//   node tools/release/channel.mjs --assets release/assets [--repo owner/repo] [--notes-file notes.txt]
//        [--published-at <ISO time>] [--play-published]
//
// Writes channel-<channel>.json for the version's channel (stable, or beta for any prerelease). A stable release
// also writes channel-beta.json, so beta users are offered it too. It also writes the Squirrel.Mac static update
// feeds RELEASES-darwin-<arch>.json for signed macOS zips. Sign the channel files afterwards:
//   node tools/release/sign.mjs sign <assets>/channel-*.json
//
// Asset names (the release workflow produces exactly these):
//   agent-empire-game-<v>.zip, game-manifest.json(.sig)                    game bundle (package-game.mjs)
//   agent-empire-coordinator.mjs                                           cloud coordinator bundle
//   Agent-Empire-<v>-macos-<arm64|x64>[-unsigned].zip / .dmg               macOS app (zip = updater payload)
//   Agent-Empire-<v>-windows-x64[-unsigned].zip                            Windows app (portable folder)
//   Agent-Empire-<v>-windows-x64-Setup[-unsigned].exe, RELEASES,
//   AgentEmpire-<nugetVersion>-full.nupkg                                  Squirrel.Windows installer + feed
//
// Desktop update feeds (Electron's built-in autoUpdater), in each channel file as shell.<os>.feed:
//   stable channel: https://github.com/<repo>/releases/latest/download[/RELEASES-darwin-<arch>.json]
//   beta channel:   https://github.com/<repo>/releases/download/<tag>[/RELEASES-darwin-<arch>.json]
// Windows (Squirrel.Windows) takes the folder URL and reads <feed>/RELEASES; macOS (Squirrel.Mac, serverType 'json')
// takes the per-arch JSON file URL.
//   Agent-Empire-<v>-android[-debug-signed].apk, Agent-Empire-<v>-android.aab
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_NAME, gameZipName } from './package-game.mjs';
import { nupkgName } from './package-windows-installer.mjs';
import { parseVersion, readVersion, releaseChannel, ROOT, versionCode } from './version.mjs';

export const COORDINATOR_NAME = 'agent-empire-coordinator.mjs';
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The coordinator state schema the bundle writes (src/cloud/schema.ts CLOUD_SCHEMA_VERSION). */
export function coordinatorSchema(root = ROOT) {
  const m = /export const CLOUD_SCHEMA_VERSION = (\d+);/.exec(readFileSync(path.join(root, 'src/cloud/schema.ts'), 'utf8'));
  if (!m) throw new Error('src/cloud/schema.ts no longer exports CLOUD_SCHEMA_VERSION as a number literal');
  return Number(m[1]);
}

/** Finds the platform assets for `version` in `names`. */
export function classifyAssets(names, version) {
  const v = escape(version);
  const pick = re => names.map(name => ({ name, m: re.exec(name) })).filter(x => x.m);
  const one = (re, what) => {
    const hits = pick(re);
    if (hits.length > 1) throw new Error(`More than one ${what}: ${hits.map(h => h.name).join(', ')}`);
    return hits[0] ?? null;
  };
  const mac = {};
  for (const arch of ['arm64', 'x64']) {
    const zip = one(new RegExp(`^Agent-Empire-${v}-macos-${arch}(-unsigned)?\\.zip$`), `macOS ${arch} zip`);
    const dmg = one(new RegExp(`^Agent-Empire-${v}-macos-${arch}(-unsigned)?\\.dmg$`), `macOS ${arch} dmg`);
    if (zip || dmg) mac[arch] = { zip: zip?.name ?? null, dmg: dmg?.name ?? null, signed: !(zip?.m[1] || dmg?.m[1]) };
  }
  const win = one(new RegExp(`^Agent-Empire-${v}-windows-x64(-unsigned)?\\.zip$`), 'Windows zip');
  const setup = one(new RegExp(`^Agent-Empire-${v}-windows-x64-Setup(-unsigned)?\\.exe$`), 'Windows installer');
  const squirrel = setup && names.includes('RELEASES') && names.includes(nupkgName(version));
  const apk = one(new RegExp(`^Agent-Empire-${v}-android(-debug-signed)?\\.apk$`), 'Android APK');
  const aab = one(new RegExp(`^Agent-Empire-${v}-android\\.aab$`), 'Android AAB');
  return {
    game: names.includes(gameZipName(version)) ? gameZipName(version) : null,
    manifest: names.includes(MANIFEST_NAME) ? MANIFEST_NAME : null,
    coordinator: names.includes(COORDINATOR_NAME) ? COORDINATOR_NAME : null,
    mac,
    windows: win || setup ? {
      zip: win?.name ?? null, setup: setup?.name ?? null, nupkg: squirrel ? nupkgName(version) : null,
      signed: !(win?.m[1] || setup?.m[1]),
    } : null,
    android: apk ? { apk: apk.name, aab: aab?.name ?? null, signed: !apk.m[1] } : null,
  };
}

/** The Squirrel.Mac static-storage feed (Electron autoUpdater with serverType "json"; Electron docs "Updating Applications", static storage RELEASES.json format) for one signed zip. */
export function squirrelFeed({ version, url, notes, publishedAt }) {
  return { currentRelease: version, releases: [{ version, updateTo: { version, pub_date: publishedAt, notes, name: version, url } }] };
}

/**
 * Builds the channel document. `assetsDir` must hold the game zip, its manifest and the coordinator; platform
 * builds that are absent are published as null so apps fall back to the release page.
 */
export function buildChannel({ assetsDir, version, channel, repo, publishedAt, notes, config, playPublished = false, root = ROOT }) {
  parseVersion(version);
  if (!['stable', 'beta'].includes(channel)) throw new Error(`Unknown channel ${channel}`);
  if (channel === 'stable' && releaseChannel(version) !== 'stable') throw new Error(`${version} is a prerelease; it cannot go to the stable channel`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Repository must be owner/name, got "${repo}"`);
  if (Number.isNaN(Date.parse(publishedAt))) throw new Error(`publishedAt is not a date: ${publishedAt}`);
  const tag = `v${version}`;
  const download = name => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const page = `https://github.com/${repo}/releases/tag/${tag}`;
  // Stable apps follow GitHub's "latest release" redirect; beta apps follow this exact tag (the channel file is the pointer).
  const feedBase = channel === 'stable' ? `https://github.com/${repo}/releases/latest/download` : `https://github.com/${repo}/releases/download/${tag}`;
  const assets = classifyAssets(readdirSync(assetsDir), version);
  if (!assets.game || !assets.manifest) throw new Error(`${assetsDir} must contain ${gameZipName(version)} and ${MANIFEST_NAME}`);
  if (!assets.coordinator) throw new Error(`${assetsDir} must contain ${COORDINATOR_NAME}`);
  const manifest = JSON.parse(readFileSync(path.join(assetsDir, MANIFEST_NAME), 'utf8'));
  const gameSha = sha256(path.join(assetsDir, assets.game));
  if (manifest.version !== version || manifest.file !== assets.game || manifest.sha256 !== gameSha)
    throw new Error(`${MANIFEST_NAME} does not describe ${assets.game} for ${version}`);
  const file = name => ({ name, url: download(name), sha256: sha256(path.join(assetsDir, name)) });

  const macArchs = Object.entries(assets.mac);
  const macAuto = macArchs.length > 0 && macArchs.every(([, a]) => a.signed && a.zip);
  const macos = macArchs.length ? {
    version, url: page, auto: macAuto,
    downloads: Object.fromEntries(macArchs.map(([arch, a]) => [arch, { ...(a.dmg ? { dmg: file(a.dmg) } : {}), ...(a.zip ? { zip: file(a.zip) } : {}), signed: a.signed }])),
    feed: macAuto ? Object.fromEntries(macArchs.map(([arch]) => [arch, `${feedBase}/RELEASES-darwin-${arch}.json`])) : null,
  } : null;
  // Squirrel.Windows: in-place updates only from a signed installer build with its RELEASES feed.
  const w = assets.windows;
  const windows = w ? {
    version, url: page, auto: Boolean(w.signed && w.nupkg),
    downloads: { x64: { ...(w.setup ? { setup: file(w.setup) } : {}), ...(w.zip ? { zip: file(w.zip) } : {}), ...(w.nupkg ? { nupkg: file(w.nupkg) } : {}), signed: w.signed } },
    feed: w.nupkg ? feedBase : null,
  } : null;
  const android = assets.android ? {
    version, versionCode: versionCode(version), ...file(assets.android.apk), signed: assets.android.signed,
    play: playPublished ? config.playListing ?? null : null,
  } : null;
  const ios = { version, testflight: config.iosTestFlight ?? null, appStore: config.iosAppStore ?? null };
  return {
    schema: 1,
    channel,
    version,
    tag,
    publishedAt: new Date(publishedAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    notes,
    releasePage: page,
    game: { url: download(assets.game), sha256: gameSha, bytes: manifest.bytes, minShell: manifest.minShell, manifest: download(MANIFEST_NAME), manifestSig: download(`${MANIFEST_NAME}.sig`) },
    shell: { macos, windows, android, ios },
    coordinator: { url: download(assets.coordinator), sha256: sha256(path.join(assetsDir, assets.coordinator)), schema: coordinatorSchema(root) },
    mandatory: false,
  };
}

function option(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const assetsDir = path.resolve(option(args, '--assets', path.join(ROOT, 'release/assets')));
    const config = JSON.parse(readFileSync(path.join(ROOT, 'tools/release/config.json'), 'utf8'));
    const version = readVersion();
    const repo = option(args, '--repo', process.env.GITHUB_REPOSITORY || config.repository);
    const notesFile = option(args, '--notes-file', null);
    const notes = (notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : `Agent Empire ${version}`).trim().slice(0, 4000);
    const publishedAt = option(args, '--published-at', new Date().toISOString());
    const channels = releaseChannel(version) === 'stable' ? ['stable', 'beta'] : ['beta'];
    let doc;
    for (const channel of channels) {
      doc = buildChannel({ assetsDir, version, channel, repo, publishedAt, notes, config, playPublished: args.includes('--play-published') });
      const out = path.join(assetsDir, `channel-${channel}.json`);
      writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
      console.log(`wrote ${out}`);
    }
    for (const [arch, entry] of Object.entries(doc.shell.macos?.downloads ?? {})) {
      if (!doc.shell.macos.auto || !entry.zip) continue;
      const out = path.join(assetsDir, `RELEASES-darwin-${arch}.json`);
      writeFileSync(out, JSON.stringify(squirrelFeed({ version, url: entry.zip.url, notes, publishedAt: doc.publishedAt }), null, 2) + '\n');
      console.log(`wrote ${out}`);
    }
  } catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
