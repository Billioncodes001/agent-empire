// Packages the macOS desktop app for a release (run on a Mac after `npm run desktop:prepare`), for the host arch:
//   <out>/Agent-Empire-Mac-<Apple-Silicon|Intel>.dmg          drag-to-Applications disk image, always
//   <out>/Agent-Empire-Mac-<Apple-Silicon|Intel>-Update.zip   ditto zip, the Squirrel.Mac update payload: signed builds only
//   <info>/macos-<arch>.json                                  build info {signed} for the channel builder (never published)
//
// Signing turns on when APPLE_SIGNING_IDENTITY names a Developer ID Application identity in the keychain
// (optionally APPLE_KEYCHAIN). Signing requires notarization credentials, either APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD
// + APPLE_TEAM_ID, or APPLE_API_KEY_PATH + APPLE_API_KEY_ID + APPLE_API_ISSUER; the app is then notarized and stapled.
// Without an identity the app is ad-hoc signed: Squirrel.Mac cannot update it, so no update zip is published and the
// build info says signed: false (the release notes tell users about "Open Anyway").
//
//   node tools/release/package-macos.mjs [--out release/assets] [--info release/build-info]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './version.mjs';
import { NAMES, writeBuildInfo } from './assets.mjs';

if (process.platform !== 'darwin') throw new Error('package-macos.mjs runs on macOS only');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = path.resolve(outIndex >= 0 ? args[outIndex + 1] : path.join(ROOT, 'release/assets'));
const infoIndex = args.indexOf('--info');
const infoDir = path.resolve(infoIndex >= 0 ? args[infoIndex + 1] : path.join(ROOT, 'release/build-info'));
const desktop = path.join(ROOT, 'desktop');
if (!existsSync(path.join(desktop, 'runtime/public/index.html'))) throw new Error('Run `npm run desktop:prepare` first');
const version = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
const rootVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
if (version !== rootVersion) throw new Error(`desktop/package.json ${version} != package.json ${rootVersion}; run npm run version:check`);
const arch = process.arch;
const env = process.env;

const identity = env.APPLE_SIGNING_IDENTITY || '';
const notarize = env.APPLE_API_KEY_PATH && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER
  ? { appleApiKey: env.APPLE_API_KEY_PATH, appleApiKeyId: env.APPLE_API_KEY_ID, appleApiIssuer: env.APPLE_API_ISSUER }
  : env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID
    ? { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID }
    : null;
if (identity && !notarize) throw new Error('A signing identity is set but notarization credentials are missing; Gatekeeper blocks signed apps that are not notarized');
const signed = Boolean(identity);

const { packager } = await import(path.join(desktop, 'node_modules/@electron/packager/dist/index.js'));
const work = path.join(ROOT, 'release/macos');
rmSync(work, { recursive: true, force: true });
const [appDir] = await packager({
  dir: desktop, name: 'Agent Empire', platform: 'darwin', arch, out: work, overwrite: true, asar: false, prune: true,
  appVersion: version, buildVersion: version, appBundleId: 'com.agentempire.desktop', appCategoryType: 'public.app-category.games',
  ignore: [/^\/node_modules\/@electron\/packager/],
  ...(signed ? {
    osxSign: {
      identity, ...(env.APPLE_KEYCHAIN ? { keychain: env.APPLE_KEYCHAIN } : {}), continueOnError: false,
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: path.join(ROOT, 'tools/release/macos-entitlements.plist') }),
    },
    osxNotarize: notarize,
  } : {}),
});
const app = path.join(appDir, 'Agent Empire.app');
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', ...opts });
if (signed) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  run('xcrun', ['stapler', 'validate', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
} else {
  // Free path (FREE-03): ad-hoc sign the whole bundle. Packaging edits Electron's bundle, which breaks its original
  // signature, and Apple Silicon refuses to launch code with a broken or missing signature ("app is damaged").
  // Ad-hoc is not Developer ID: Gatekeeper still asks once (System Settings → Privacy & Security → Open Anyway), and
  // the app updates by download (update-store.cjs macDeveloperIdSigned), never in place.
  run('codesign', ['--force', '--deep', '--sign', '-', app]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
}

mkdirSync(outDir, { recursive: true });
const zip = path.join(outDir, NAMES.macZip(arch));
const dmg = path.join(outDir, NAMES.macDmg(arch));
rmSync(zip, { force: true }); rmSync(dmg, { force: true });
// ditto keeps symlinks, extended attributes and the stapled ticket intact (zip(1) can break framework signatures).
if (signed) run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
const stage = path.join(work, 'dmg');
rmSync(stage, { recursive: true, force: true }); mkdirSync(stage);
run('ditto', [app, path.join(stage, 'Agent Empire.app')]);
symlinkSync('/Applications', path.join(stage, 'Applications'));
// hdiutil on hosted macOS runners intermittently fails "Resource busy" while background scanning holds the staged
// folder; retry a few times with a pause instead of failing the release.
for (let attempt = 1; ; attempt++) {
  try { run('hdiutil', ['create', '-volname', 'Agent Empire', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg]); break; }
  catch (error) {
    if (attempt >= 5) throw error;
    console.warn(`hdiutil create failed (attempt ${attempt} of 5); retrying in ${attempt * 10} s`);
    rmSync(dmg, { force: true });
    execFileSync('sleep', [String(attempt * 10)]);
  }
}
if (signed) run('codesign', ['--sign', identity, ...(env.APPLE_KEYCHAIN ? ['--keychain', env.APPLE_KEYCHAIN] : []), '--timestamp', dmg]);
for (const file of signed ? [zip, dmg] : [dmg]) {
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  console.log(`${path.basename(file)}  sha256 ${sha}`);
}
writeFileSync(path.join(work, 'build-info.json'), JSON.stringify({ version, arch, signed, notarized: signed, zip: signed ? path.basename(zip) : null, dmg: path.basename(dmg) }, null, 2) + '\n');
writeBuildInfo(infoDir, { platform: 'macos', arch, signed });
if (!signed) console.log('UNSIGNED build: Gatekeeper will block it until the user allows it in System Settings; no in-place updates.');
