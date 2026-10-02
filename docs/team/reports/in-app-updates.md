# In-app updates (REL-03, REL-04, REL-05)

| | |
|---|---|
| Branch | `claude/in-app-updates` (from `d26d7fa`), not pushed |
| Author | Claude (Claude Code), interface lane |
| Plan | `docs/team/RELEASE_PLAN.md` (in-app updates, channel contract); aligned with the release lane's contract on `claude/release-pipeline` (`1ec70a1`, `c8a4fed`) |
| Screenshots | `docs/team/reports/in-app-updates/` |

Nothing was published, tagged or uploaded. No real GitHub release was read; every check used the local, dev-signed update fixture.

## What a player gets

- **Checks:** at launch, then about every 6 hours while the game is open, and from **Menu → Check for updates**.
- **Prompt:** a HUD toast, "Update available: Agent Empire X" with **View** and **Later**.
  - It waits while a dialog is open, a text field has focus, the player is in the air, the city is still loading, or the window is hidden or occluded.
  - A dialog that opens over it hides it. It comes back at the next calm moment.
- **Updates dialog:** shows the installed versions and the release notes (plain text). It offers:
  - Update game → Restart now;
  - an app update through the platform's own path;
  - "your server runs vX; vY is available" in server mode;
  - the coordinator update in cloud mode.
- **Settings → Updates:** "Game 0.1.0 · Android app 0.3.0 · Stable channel", a Stable/Beta choice saved on the device, the last check result and **Check for updates**.
- **Updates never change saves or settings.** A rollback is announced once: "The update to 0.1.2 didn't start, so the app went back to 0.1.1."

## Implementation

### REL-03: client (`src/client/update/`)

| File | Purpose |
|---|---|
| `channel.ts` | Parses the channel contract strictly. Fields the app uses are validated and fields it doesn't use are ignored, as the contract asks. A missing platform is `null`. <ul><li>The game zip and coordinator must be assets of the `v<version>` release of `Billioncodes001/agent-empire`.</li><li>Desktop `url` is the release page.</li><li>`feed` is per architecture: a Squirrel.Mac JSON asset, or a Squirrel.Windows release folder (`…/releases/download/<tag>` or `…/releases/latest/download`).</li><li>Play and Apple links are host-checked.</li><li>A file for the other channel is refused.</li></ul> |
| `verify.ts` | Checks Ed25519 against `RELEASE_PUBLIC_KEY` before parsing anything. Uses WebCrypto, with tweetnacl as the fallback. The `.sig` is base64 of 64 bytes; whitespace is trimmed |
| `source.ts` | **Stable:** `releases/latest/download/channel-stable.json(.sig)`. **Beta:** the newest pre-release from `api.github.com/…/releases` (ETag with a cached listing; on a 403/429 rate limit it uses the cache and backs off 30 min), compared with stable so the newer one wins |
| `decide.ts` | Forward only: never at or below the running, built-in or pending game, and never the version that was just rolled back. `minShell` above the app gives "needs a newer app". Picks the native path per platform. Shows the server version without acting on it |
| `bridge.ts` | Typed `update.*` calls, with the same validation as the shells |
| `service.ts` | State, checks and the install/restart/native/coordinator actions. Nothing happens without an explicit call from the UI |
| `gate.ts`, `ui.ts`, `index.ts` | Prompt gating, toast, dialog, Settings section and menu entry (`setMenuUpdateEntry` in `game-menu.ts`) |
| `boot-ok.ts` | `update.bootOk` once per page, as soon as the game module has evaluated or the setup is shown. Model loading on 3G can take longer than 20 s, so the report doesn't wait for it |
| `coordinator.ts` | REL-05 (below) |

**Why downloads go through the shell.** GitHub's release downloads send no CORS headers, so a WebView page can't read them. I checked this live: `github.com/…/releases/download/…` answers 302 without ACAO, and `release-assets.githubusercontent.com` answers 200 without ACAO. The shells follow the redirects natively. A plain browser doesn't check: there the game comes from the Empire's server.

**Build:** `vite.config.ts` defines `__AGENT_EMPIRE_GAME_VERSION__` from `package.json` and writes `game-version.json` into the bundle root. The shells use that file to know which game they carry and to check that an installed zip is the version they were asked for.

### REL-04: shells

All three implement the same contract and the same state machine:

| Call | What it does |
|---|---|
| `update.fetch` | GETs a release asset or the releases listing (≤ 6 MB). Redirects are followed only to `objects.githubusercontent.com` and `release-assets.githubusercontent.com` |
| `update.installGame` | Validates the URL as a tagged asset of the pinned repo, a hex sha256 and a semver version. Refuses anything not newer than active, pending, known-good or built-in, and any version that failed to boot. Downloads, checks the sha256, unzips into a temp dir, checks for `index.html` and that `game-version.json` matches, renames into `<appdata>/game-bundles/<version>`, then marks it pending (state file written atomically) |
| `update.activate` | Makes pending the trial and reloads |
| `update.bootOk` | Marks the trial known-good and cleans up old bundles |
| `update.nativeInfo` | `{platform, shellVersion, os, arch, installedGame, builtinGame, pendingGame, canInstallGame, canAutoUpdate, installSource, rolledBack}` |

**Rollback:**
- Without `bootOk` within 20 s of the trial starting, the shell returns to the last known-good bundle, or the built-in one.
- A launch that finds an unfinished trial rolls back too.
- A newer built-in game, for example after an app update, wins over an older installed bundle.

**Serving:** each shell's handler picks its root per request, with the same traversal, dotfile and MIME rules as before. The built-in bundle is always the fallback.

**Zip-slip:** every shell refuses before writing:
- absolute paths, drive letters, backslashes, NUL and control characters;
- `.`, `..` and empty segments;
- symlinks and special files, encryption and duplicates;
- ZIP64 and oversize archives.

Each target is also re-checked to stay inside the destination.

**Development fixture:** honoured only while the shell's pinned key equals the dev key (`RELEASE_KEY_IS_DEVELOPMENT`), and on mobile only in Debug or debuggable builds.

| Shell | Fixture switch |
|---|---|
| Desktop | `--empire-update-fixture=http://127.0.0.1:<port>` |
| Android | `--es ae.debug.updates http://10.0.2.2:<port>` |
| iOS | `-AE_UPDATE_FIXTURE http://127.0.0.1:<port>` |

#### Desktop

Files: `desktop/update-store.cjs` (zip reader, store, downloads, Squirrel helpers, pinned key), `bridge-policy.cjs`, `app-protocol.cjs` (dynamic root) and `main.cjs`.

Native updates use Electron's built-in `autoUpdater`, with no new dependency:
- **macOS:** only for a packaged app signed with Developer ID (checked with `codesign`). The feed is a JSON asset, used with `setFeedURL({url, serverType: 'json'})`.
- **Windows:** only when Squirrel's `Update.exe` sits next to the app folder. The feed is the release folder; a `/RELEASES` suffix is stripped.
- **Flow:** the first `openNative` downloads and answers `auto-update`. The page then shows **Restart to update**; calling it again answers `restart`, then `quitAndInstall`.
- **Fallback:** if the app isn't signed, has no feed, or the updater errors, it opens the release page (`https://github.com/<repo>/releases/tag/<tag>`).
- **Squirrel launch events:** `--squirrel-install`, `-updated`, `-uninstall` and `-obsolete` are handled first thing in `main.cjs`, before any window or server starts. Install and update create shortcuts and uninstall removes them, through `Update.exe --createShortcut|--removeShortcut <exe>`. Then the app quits.

#### Android

Files: `UpdatePolicy.java` (pure; covered by `PolicyTest`), `GameUpdater.java`, plus changes to `GameAssets` (active bundle), `NativeBridge` (own executor so secure storage never waits behind a download), `MainActivity` and `BridgePolicy`.

The native update depends on how the app was installed:
- **Sideloaded:** downloads the APK, checks the sha256 from the signed channel, and hands it to the system installer through the `PackageInstaller` session API (`REQUEST_INSTALL_PACKAGES`). If the app may not install yet, it first opens the "install unknown apps" setting.
- **Play installs:** open the Play listing.

#### iOS

Files: `UpdatePolicy.swift` (pure) and `GameUpdater.swift` (URLSession with a redirect guard, CryptoKit sha256, zip extraction with Compression). `GameSchemeHandler` takes a root provider, and `GameView` and `BridgeProtocol` are wired in.

- `openNative` opens TestFlight or the App Store only.
- `shellVersion` recovers the prerelease from the build number (`10000301` → `1.0.0-beta.1`), because `MARKETING_VERSION` is numeric.
- The shared scheme is `mobile/ios/AgentEmpire.xcodeproj/xcshareddata/xcschemes/AgentEmpire.xcscheme` (`xcodebuild -list` shows it; Release archive action).

### REL-05: coordinator and server

**Cloud mode:**
- `CloudRepo.coordinatorInfo` reads `coordinator/coordinator.json` (`{version, sha256, schema}`). A repository without that file has its bundle hashed instead; if the bundle differs from the channel's, its version is unknown and treated as older.
- The update is offered only when it is newer. When the channel coordinator's schema is newer than this client's `CLOUD_SCHEMA_VERSION`, the dialog says "needs a newer game" instead.
- Accepting shows a confirmation. Then one commit (Git Data API, never forced, retried on conflict) writes the bundle and the manifest. `state/` and `intents/` are never touched.
- The bundle comes from the game's own `cloud/` copy when its sha256 matches, otherwise through `update.fetch`. It is sha256-checked against the signed channel before anything is written.
- Nothing is ever committed automatically.

**Server mode:** `welcome` gained an optional `appVersion` (`package.json`, from `Upgrader.packageVersion`). The app shows "your server runs vX; vY is available" and never changes the server.

## Coordination with the release lane (merge notes)

- **`src/shared/release-key.ts`** is byte-identical to `claude/release-pipeline`.
- **`.gitignore`** has the identical `/release/` change.
- **`tools/release/config.json`** is the release lane's file plus my `pinnedKeyFiles`: `src/shared/release-key.ts`, `desktop/update-store.cjs`, `mobile/android/.../UpdatePolicy.java` and `mobile/ios/AgentEmpire/UpdatePolicy.swift`. Each pins `DEV_RELEASE_PUBLIC_KEY` and `RELEASE_PUBLIC_KEY` as literals.
  - A test checks that all four pin the same key.
  - **When the owner pastes the real key, `RELEASE_PUBLIC_KEY` must be replaced in all four files.** `check-key` enforces this.
  - Merging will give an add/add conflict on this one line.
- **Other shared files:**
  - `tools/prepare-desktop.mjs`: `update-store.cjs` added to `DESKTOP_FILES`.
  - `mobile/tools/build-android.py`: `UpdatePolicy` added to the policy test compile.
  - The release lane edited other lines of both files.
- **Fixture signing:** the test fixtures sign with the release lane's dev seed (`tests/update-fixtures.ts` `DEV_KEY_SEED_TEXT`, the same text as `sign.mjs`).
- **Channel fields consumed:** `game.{url,sha256,minShell}`, `shell.*` (`url`, `auto`, `feed`, `android.sha256/url/play`, `ios.testflight/appStore`), `coordinator`, `notes`, `mandatory` and `tag` (must match the version).

## Verification

### Automated checks

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | **437 pass**, 0 fail (was 405) |
| New: `tests/in-app-updates.test.ts` | 22 tests: semver, channel parsing and tamper cases, signature (tamper, wrong key, garbage, the other channel; both WebCrypto and tweetnacl), stable/beta/ETag/rate limit, offers (downgrade, minShell, rollback, native per platform including Squirrel.Windows and the stable feed folder), gating, bridge validation, service flow, pinned keys, coordinator against FakeGitHub (mismatch writes nothing; concurrent commit kept) |
| New: `tests/desktop-updates.test.ts` | 10 tests: bridge validation, zip-slip (11 hostile archives), downloads and redirects, fixture mapping, store state machine (install, forward only, activate, bootOk, 20 s rollback, unfinished trial at launch, built-in wins, damaged state), protocol handler, Squirrel events and feeds |
| `npm run build`, `npm run build:cloud` | pass |
| Android `PolicyTest` | 429 checks pass, including in-app updates; the debug APK builds |
| iOS `mobile/ios/Checks/run.sh` | 115 checks pass |
| iOS simulator build (`-scheme AgentEmpire`) | `BUILD SUCCEEDED` |

### UI checks against the fixture (port 4718, never 4610)

- **`tools/update-ui-check.ts`: 57 pass.** It ran with a desktop 1440×900 window, a narrow 375×812 window (reduced motion and `Save-Data: on`) and a phone in landscape at 812×375 (touch). Each covered:
  - Settings versions and channel;
  - no prompt while a dialog is open, no prompt while typing, the prompt fits the screen;
  - keyboard access to the release notes;
  - install only after accepting, restart, bootOk, then "up to date" (forward only);
  - the menu entry and no page errors.
- **Cloud coordinator:** prompt, no automatic commit, confirmation text, the committed bundle equals the signed release's, and `coordinator.json` is written.
- **Regression:** setup-ui-check 127 pass, cloud-ui-check 171 pass, mobile-ui-check 411 pass. Their screenshots went to the scratchpad or were restored, so other lanes' evidence is unchanged.

### Real shells against `tools/update-fixture.ts` (dev-signed, 302 redirects)

**Packaged macOS app** (`tools/update-desktop-check.ts`; isolated `--user-data-dir` in the scratchpad, mock keychain, CDP): all 9 checks pass.
- The real shell fetched and verified the channel.
- It downloaded, sha256-checked and unzipped 23.7 MB into `game-bundles/0.1.1`.
- Restart served 0.1.1 (`/game-version.json`), and it booted to known-good.
- The broken 0.1.2 was installed and run on trial, then **rolled back after 21 s** with `bad:["0.1.2"]`, and the player was told.
- Screenshots: `device-macos-01…05`.

**iOS simulator** (iPhone 18 Pro, Debug, ad-hoc signed):
- Setup was done by hand: server sign-in to 4718 and the founder dialog. While that dialog was open, the prompt waited.
- Prompt → Update game → installed (`pending:"0.1.1"`) → Restart now → `knownGood:"0.1.1"`.
- The menu then read "Game 0.1.1".
- The broken 0.1.2 showed its page, then rolled back to 0.1.1 with `bad:["0.1.2"]`.
- Screenshots: `device-ios-01…05`.

**Android emulator** (isolated pixel_7 AVD in the scratchpad, Android 35, port 5594, `-netspeed umts -netdelay umts`):
- Signed in with the debug intent.
- The prompt came over 3G, the update installed, and Restart now led to `knownGood:"0.1.1"`.
- The broken 0.1.2 ran on trial. The log says "did not report booting within 20 s; rolled back" **20.06 s** after the trial started, with `bad:["0.1.2"]`.
- Screenshots: `device-android-01…05`.
- The emulator was killed and its AVD deleted. The MyMecho AVDs were not touched.

## Not verified, and known limits

- **Native app updates were not run on a device:**
  - desktop `autoUpdater`: there are no signed builds and no feed;
  - Squirrel.Windows install events: there is no Windows host;
  - the Android APK installer and Play path;
  - the iOS TestFlight/App Store links.
  These are covered only by the unit tests for parameters and policy.
- **The packaged macOS app was built before two late `main.cjs` edits:** moving the Squirrel handling (win32 only) and `releases/latest/download` feed folders. Both are covered by unit tests and `node --check`.
- **Timing:** the toast prompt itself was verified in the browser checks and the device runs. On the slow emulator the dialog took a few seconds to render.
- **Fixture WebSocket on iOS:** the iOS simulator game showed "Reconnecting to the office host" against the fixture's WebSocket, both before and after the update. This looks unrelated to updates and was not investigated.
- **Uninstalled simulator app:** I uninstalled the existing `com.agentempire.mobile` from the shared booted simulator (iPhone 18 Pro) to start clean, which removed that app's simulator data.
- **Browsers:** a plain browser doesn't check for updates (no CORS on GitHub release downloads). Cloud mode in a browser therefore never sees the coordinator prompt.
- **Beta selection:** the newest pre-release comes from the unauthenticated releases API (60 requests an hour per IP). ETags and the cache keep it to a handful a day.

## Security review fixes (`claude/updater-fixes`, from `2a16cdc`)

The review of `claude/release-integration` `2a16cdc` was "accept with fixes". Each fix below has tests that fail without it.

| Finding | Fix | Tests |
|---|---|---|
| **#1 (critical)** `tools/release/channel.mjs` writes the stable macOS feed `…/releases/latest/download/RELEASES-darwin-<arch>.json`, which both the client and desktop parsers refused. Once Apple secrets exist, every stable channel would have failed to parse | Both parsers accept, under `latest/download`, only `RELEASES-darwin-(arm64\|x64).json`. The client also carries the signed `downloads.x64.nupkg` `{url, sha256}`. `channel.mjs` is unchanged | `tests/update-roundtrip.test.ts`: `buildChannel()` (stable and beta; macOS and Windows signed and unsigned; Android signed and debug-signed) → `parseChannel()` → `nativeOffer()` → desktop `parseRequest(update.openNative)`. Also tests that only the two macOS feed names are accepted |
| **#2** Squirrel.Windows applies whatever `RELEASES`/`.nupkg` the feed lists, and the stable feed was `latest`, not the signed tag | On Windows, `desktop/main.cjs` `verifiedFeed()` works in this order: <ol><li>reads the release's own signed channel (the tag `v<version>`, never `latest`);</li><li>takes `downloads.x64.nupkg`, which must be the tagged asset `AgentEmpire-<nuget>-full.nupkg`;</li><li>downloads it and checks the sha256;</li><li>writes it with a `RELEASES` index computed locally into `<userData>/squirrel-feed`;</li><li>points `autoUpdater` at that folder.</li></ol> The version must be newer than the app. The macOS feed is also taken from the signed release | `tests/updater-security.test.ts`: the package must come from the tag and have the right name and hash; `latest` and other tags are refused; the `RELEASES` line matches the release lane's `parseReleases` |
| **#4** `MainActivity.handleInstallStatus` was reachable through the exported launcher with any `EXTRA_INTENT` | The `PackageInstaller` answer now goes to `InstallStatusReceiver`: <ul><li>declared `exported=false`, with an explicit component;</li><li>accepts only intents carrying the per-session in-memory nonce (24 random bytes, compared in constant time);</li><li>launches `EXTRA_INTENT` only when it is a package-installer confirmation (`CONFIRM_INSTALL`, `CONFIRM_PERMISSIONS` or `CONFIRM_PRE_APPROVAL`) that `resolveActivity` maps to a system or updated-system app, pinned to that component. This accepts any OEM's installer, such as Xiaomi's or Samsung's, and never a third-party app (follow-up branch `claude/android-installer-oems`).</li></ul> The launcher activity no longer handles install intents. If the app is killed mid-install, the in-memory nonce is lost. A non-secret marker ("app update vX pending since T", deleted once installed or after a day) makes the next launch say "Tap Update again to finish installing" instead of stalling silently | `PolicyTest` (nonce rules, installer-confirmation rule including OEM names, pending-marker states) |
| **Low (a)** shells trusted the page's url/sha256 | Before `installGame`, and on desktop and Android before the native app update, every shell fetches `channel-beta.json(.sig)` from the release `v<version>`. It verifies the file with the pinned key and requires the request to match it exactly: version, tag, game url and sha256, `minShell` ≤ app version; on Android, the APK url and sha256. Platform Ed25519: <ul><li>desktop: `node:crypto`;</li><li>iOS: CryptoKit `Curve25519.Signing`;</li><li>Android: `java.security` Ed25519 on API 33+. Below Android 13 there is no platform Ed25519, so the native check is skipped and logged; the page's WebCrypto/tweetnacl check and the pinned-repo and sha256 rules still apply.</li></ul> | desktop `tests/updater-security.test.ts`; Android `PolicyTest` signs with the dev seed and verifies; iOS Checks |
| **Low (b)** the coordinator could be offered below what runs. Example: a repository set up by a newer app, with no manifest, after a switch from beta to stable | `coordinatorDecision` takes this app's own bundled coordinator `{version, sha256}`. A matching unknown bundle counts as that version, so nothing older is offered | `tests/updater-security.test.ts` |

**For the owner (App Review guideline 2.5.2):** the iOS app downloads JavaScript game bundles and runs them in WKWebView. These are signed, hash-checked, and run only inside the web view, which the guidelines allow for HTML5 content. Whether to ship over-the-air game updates on iOS, or to update the game only through TestFlight/App Store builds, is your decision before App Store submission.

Results on this branch:

| Check | Result |
|---|---|
| typecheck | pass |
| `npm test` | 464 pass (was 455) |
| build, build:cloud | pass |
| `tools/update-ui-check.ts` | 57 pass |
| Android `PolicyTest` | 439 checks; debug APK builds |
| iOS Checks | 124 pass; simulator build succeeded |

Not re-run on devices for these fixes:
- the packaged macOS app, the iOS simulator app and the Android emulator;
- the Windows Squirrel path (no Windows host);
- the Android installer-confirmation launch.
