# Releases and in-app updates

The owner's direction, recorded before implementation on 2026-10-02: GitHub is the source of releases. Tagging a release makes GitHub Actions build every platform, and every installed app sees an in-app **"Update available"** prompt.

## Decisions (owner, 2026-10-02)

| Topic | Decision |
|---|---|
| Release branch | `main`. Development integrates on `codex/empire-world`; promoting to `main` (as PR #1 did, `78f6841`) means shippable. Releases are tagged on `main` only |
| Versioning | One version for everything: game, server, cloud coordinator, desktop, Android, iOS. The source of truth is `package.json` `version`, synced by script. The first unified release is **`v1.0.0-beta.1`**. Tags are `vX.Y.Z[-pre.N]`; the inherited `v0.1.x` upstream tags are ignored |
| Update model | **Game over-the-air updates plus native prompts**: a signed game bundle that every app can install after a prompt, plus the best native update path each platform allows |
| Signing | The owner will provide Apple Developer, a Windows code-signing certificate and Google Play. Each signing step turns on automatically when its GitHub secret exists. Until then, builds are unsigned and labelled so |

## Release workflow (`.github/workflows/release.yml`)

**Trigger:** a pushed tag `v*` that points at a commit on `main`; any other tag fails the run. A manual dispatch does a dry run.

1. **Verify:** `npm ci`, typecheck, `npm test`, the tag matches `package.json`, versions are in sync.
2. **Game bundle:**
   - `npm run build`, `npm run build:cloud`.
   - The game files from `dist/public` are packed as `agent-empire-game-<version>.zip`.
   - The pack also gets a `game-manifest.json` with the version, the sha256 of the zip, `minShell` (the oldest native shell version that can run it) and the build commit.
   - The manifest is signed with **Ed25519** (secret `GAME_SIGNING_KEY`). The matching public key is pinned in every shell and in the client.
   - The run fails if the fixture marker is present.
3. **Desktop:**
   - macOS (arm64 and x64) and Windows (x64) builds.
   - **macOS signing** turns on when `APPLE_DEVELOPER_ID_CERT_P12`, `APPLE_DEVELOPER_ID_CERT_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_SPECIFIC_PASSWORD` (or an App Store Connect API key) exist. It signs with Developer ID, notarizes and staples.
   - **Windows signing** turns on when `WINDOWS_CERT_P12` and `WINDOWS_CERT_PASSWORD` exist, or an Azure Trusted Signing configuration does.
   - Publishes the update feed the desktop updater reads.
4. **Android:**
   - Release APK (and an AAB for Play) signed with `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Without them, a clearly labelled debug-signed build.
   - `versionCode` comes from the version.
   - Play upload (internal track) when `PLAY_SERVICE_ACCOUNT_JSON` exists.
5. **iOS:**
   - Simulator build always.
   - Archive and TestFlight upload when `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` and `IOS_DIST_CERT_P12` with its password and provisioning profile exist.
6. **Publish:**
   - A GitHub Release for the tag, marked pre-release for `-beta`/`-rc`.
   - Assets: the game zip, `game-manifest.json` and its `.sig`, the desktop installers and update feed, the APK and AAB, and SHA256SUMS.
   - Plus **`channel-<stable|beta>.json`**: the update channel file every app reads.
7. **Cloud coordinator:** the `agent-empire-coordinator.mjs` bundle and its sha256 are also release assets. A user's state repo updates its coordinator only when the user accepts the in-app prompt; no state repo is ever changed automatically.

Actions are pinned to full commit SHAs. Secrets are used only in the steps that need them. No step runs on pull requests from forks.

## Update channel contract (`channel-<channel>.json`, signed)

```json
{
  "schema": 1,
  "channel": "beta",
  "version": "1.0.0-beta.2",
  "publishedAt": "2026-10-03T12:00:00Z",
  "notes": "Short release notes (plain text)",
  "game":   { "url": "https://github.com/<owner>/<repo>/releases/download/v1.0.0-beta.2/agent-empire-game-1.0.0-beta.2.zip", "sha256": "…", "minShell": "1.0.0-beta.1" },
  "shell": {
    "macos":   { "version": "1.0.0-beta.2", "url": "…", "auto": true },
    "windows": { "version": "1.0.0-beta.2", "url": "…", "auto": true },
    "android": { "version": "1.0.0-beta.2", "versionCode": 10000302, "url": "…apk", "play": "https://play.google.com/store/apps/details?id=com.agentempire.mobile" },
    "ios":     { "version": "1.0.0-beta.2", "testflight": "…", "appStore": "…" }
  },
  "coordinator": { "url": "…mjs", "sha256": "…", "schema": 1 },
  "mandatory": false
}
```

The file is signed with the same Ed25519 key (`channel-<channel>.json.sig`). Apps fetch the file and its signature from `https://github.com/<owner>/<repo>/releases/latest/download/…` (stable), or from the newest pre-release for beta. They check the signature against the pinned public key before trusting anything in it.

### As implemented (REL-01/REL-02, `tools/release/`)

- **Pinned public key:** `src/shared/release-key.ts` exports `RELEASE_PUBLIC_KEY`: the base64 of the **raw 32-byte Ed25519 public key** (tweetnacl `sign.detached.verify`, CryptoKit `Curve25519.Signing.PublicKey(rawRepresentation:)`). Both constants there must stay single-quoted string literals. Native shells pin the same string; list each shell file that pins it in `tools/release/config.json` `pinnedKeyFiles`, and the release gate (`node tools/release/sign.mjs check-key`) fails unless every listed file contains it.
- **Development key:** until the owner pastes their key, `RELEASE_PUBLIC_KEY` equals `DEV_RELEASE_PUBLIC_KEY`, whose private half is derived from a public seed (`devPrivateKey()` in `tools/release/sign.mjs`; `sign.mjs sign --dev`). Tests and fixtures sign with it. `RELEASE_KEY_IS_DEVELOPMENT` is true in such a build. A tagged release fails while the pinned key is the development key, or when `GAME_SIGNING_KEY` is not its private half.
- **Signatures:** `<file>.sig` holds the base64 of the 64-byte Ed25519 signature over the file's exact bytes, plus a trailing newline. Verifiers should trim whitespace.
- **versionCode:** `MAJOR*10^7 + MINOR*10^5 + PATCH*10^3 + rank`, where rank is `alpha.N`=100+N, `beta.N`=300+N, `rc.N`=600+N (N ≤ 199) and a final release is 999. So `1.0.0-beta.1` is 10000301 and `1.0.0` is 10000999. iOS `CURRENT_PROJECT_VERSION` uses the same number; `MARKETING_VERSION` is the numeric `X.Y.Z`.
- **Channels:** a prerelease writes `channel-beta.json`. A final release writes `channel-stable.json` and also `channel-beta.json`, so beta users are offered it too.
- **Fields beyond the example above** (additive; clients must ignore unknown fields):
  - top level: `tag`, `releasePage` (the GitHub release page).
  - `game`: `bytes`, `manifest` and `manifestSig` (URLs of `game-manifest.json` and its `.sig`). `game-manifest.json` holds `schema, name, version, file, bytes, sha256, files, entry, minShell, commit`. `minShell` comes from `tools/release/config.json`.
  - `shell.macos` / `shell.windows`: `url` is the release page (users pick a download). `downloads.<arch>` has `dmg`/`zip` entries of `{ name, url, sha256 }` and `signed`. `auto` is true only when every macOS build is signed and notarized. `shell.macos.feed.<arch>` is then the URL of a Squirrel.Mac static feed `desktop-update-darwin-<arch>.json` (Electron `autoUpdater`, `serverType: 'json'`), else `null`. Windows `auto` is always false for now: there is no Squirrel/NSIS installer yet.
  - `shell.android`: `name`, `sha256` (check it before opening the installer) and `signed` (false for the labelled debug-signed APK). `play` is set only when the release was uploaded to Play.
  - `shell.ios`: `testflight` and `appStore` come from `tools/release/config.json` (null until the owner fills them in).
  - A platform whose build is missing is `null`.
- **Asset names:** `agent-empire-game-<v>.zip`, `game-manifest.json(.sig)`, `agent-empire-coordinator.mjs`, `Agent-Empire-<v>-macos-<arm64|x64>[-unsigned].{zip,dmg}`, `Agent-Empire-<v>-windows-x64[-unsigned].zip`, `Agent-Empire-<v>-android[-debug-signed].apk`, `Agent-Empire-<v>-android.aab` (only when upload-key signed), `channel-<channel>.json(.sig)`, `desktop-update-darwin-<arch>.json` (only when signed), `SHA256SUMS`.

## In-app updates

- **When apps check:** at launch, then about every 6 hours while open, and from the menu ("Check for updates").
- **Game update:**
  - The app shows the prompt with the notes. If accepted, it downloads the zip, checks the sha256 from the signed manifest and unpacks it into its own app-data folder.
  - The app switches to the new bundle on the next start. If the new bundle doesn't report that it booted within 20 s, the app rolls back to the last known-good bundle.
  - Versions only move forward; a lower version is never installed.
  - If `minShell` is above the installed shell, the app asks for a native update first.
- **Native update:**
  - **Desktop:** the Mac and Windows app updates itself once signed (Squirrel.Mac needs Developer ID; Windows uses its own installer). Until then it prompts and opens the download.
  - **Android:** sideloaded installs download the APK, check its sha256 and open the system installer (`REQUEST_INSTALL_PACKAGES`). Play installs are sent to the Play listing.
  - **iOS:** the app opens TestFlight or the App Store; it never installs code itself.
- **Coordinator update (cloud mode):** a prompt in Cloud Empire. If accepted, the client commits the new coordinator bundle (sha256 checked) to the user's state repository.
- **Server mode:** the existing self-upgrader (`src/server/upgrade.ts`) continues for hosts deployed from git. The app can show "your server runs vX; vY is available".

The prompt never shows during a modal, typing or a jump; it uses the HUD toast plus an entry in the menu. Updating never changes saves or settings.

## Slices

| ID | Slice | Owner |
|---|---|---|
| REL-01 | Version sync script and check; tag rules; `RELEASING.md` with the full list of secrets for the owner | Release lane |
| REL-02 | `release.yml`: verify, game bundle with Ed25519 signing, channel file, coordinator asset, desktop/Android/iOS builds with signing gated on secrets, GitHub Release publish. Test the dry run with `act`, or with a tag on a fork-safe branch | Release lane |
| REL-03 | Client update service: channel fetch, signature check, prompt UI, game-bundle install and rollback hooks | Interface |
| REL-04 | Native shells: a bundle store with atomic switch and rollback; native update paths (desktop autoUpdater, Android APK install, iOS store links); `update.*` bridge calls | Interface (per shell) |
| REL-05 | Cloud coordinator update prompt and commit; server-mode version notice | Interface + Backend |
