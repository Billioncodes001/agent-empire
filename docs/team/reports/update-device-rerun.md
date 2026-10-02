# In-app updates: device re-run after the security fixes

| | |
|---|---|
| Branch | `claude/update-device-rerun` (from `origin/codex/empire-world` `7560c47`), not pushed |
| Author | Claude (Claude Code), verification |
| Method | As in `docs/team/reports/in-app-updates.md`: a locally served, dev-key-signed fake channel with real 302 redirects (`tools/update-fixture.ts`, port 4721) and the isolated UI fixture (`tools/ui-fixture.ts`, port 4720). Nothing touched 4610, the Pixel worker or `.agent-office`. No real signing key, no secrets, nothing published |
| Evidence | `docs/team/reports/update-device-rerun/` (screenshots, fixture request logs and shell logs as `.txt`, because `*.log` is git-ignored) |

Releases served: N = built-in `1.0.0-beta.1`. N+1 = `1.0.0-beta.2` (the real game, relabelled). N+2 = `1.0.0-beta.3`, a broken bundle that never reports booting; on iOS and Android a second broken `1.0.0-beta.4` was also used to capture the trial screen. The downgrade candidate is `0.1.1`, a validly signed release that is older than N.

## Results

| Check | macOS (packaged app) | iOS (iPhone 18 Pro simulator) | Android 15 emulator |
|---|---|---|---|
| Tampered `channel-stable.json` refused by the page | **PASS** `macos-01` | **PASS** `ios-01` | **PASS** `android-01` |
| Tampered `channel-beta.json` (tagged release) refused by the shell's own Ed25519 check | **PASS** `macos-02`, `macos-install-requests.txt` (`node:crypto`) | **PASS** `ios-02`, `ios-shell-refusal-requests.txt` (CryptoKit) | **FAIL**: no usable platform Ed25519 on Android 15 (see finding 1). The shell logs the skip and installs. `android-04`, `android-shell.txt` |
| Prompt appears (signed channel verified by the page) | **PASS** `macos-03` | **PASS** `ios-03` | **PASS** `android-03` |
| Install N+1: shell re-reads `v<N+1>/channel-beta.json(.sig)`, then downloads, checks sha256 and unzips | **PASS** `macos-04` | **PASS** `ios-04` | **PASS** after fix 2 (before the fix, every genuine release was refused: `android-00`). `android-install-requests.txt` |
| Restart into N+1, `bootOk` → `knownGood` | **PASS** `macos-05` | **PASS** `ios-05` | **PASS** `android-05` |
| Broken N+2 → rolled back after ~20 s | **PASS**: 21.2 s, `bad:["1.0.0-beta.3"]`. `macos-06` | **PASS**: 20.0 s (log 13:23:38.36 → 13:23:58.41). `ios-06` | **PASS**: 20.06 s (`trialStartedAt` 15:07:40.692 → log 15:08:00.752). `android-06` |
| Rollback notice to the player | **PASS** `macos-07` | **PASS** `ios-07` | **PARTIAL**: the toast was in the page (UI tree, 16 s after the rollback) but expired behind the loading screen on the slow emulator, so no screenshot shows it. `android-07` |
| Downgrade: older signed release not offered by the page | **PASS** `macos-08` | **PASS** `ios-08` | **PASS** `android-10` |
| Downgrade: shell refuses `update.installGame` asked directly over the bridge | **PASS**: "Version 0.1.1 is not newer than what this app has." | **NOT RUN ON DEVICE**: there is no scriptable WKWebView access. Covered by iOS Checks "updates: no downgrade" (124 pass) | **PASS** over WebView CDP: same message. `android-downgrade-bridge.txt` |
| APK path: download, sha256 against the signed channel, system installer confirmation | n/a | n/a | **PASS**, stopped at the confirmation and not installed (still versionCode 10000301). `android-08`, `android-09`, `android-apk-requests.txt` |

**Automated checks after the fixes:**
- `npm run typecheck`: pass.
- `npm test`: 467 pass, including the new contrast test.
- Android `PolicyTest`: 441 pass, including the new Keystore case.
- iOS `mobile/ios/Checks/run.sh`: 124 pass.
- Desktop check: `tools/update-desktop-check.ts`, 16/16 pass.

## Findings and fixes

### 1. Android has no native release-signature check in practice (open, needs a decision)

On stock Android 13–15 the only Ed25519 implementation is Android Keystore's, which cannot import an external raw public key. Conscrypt has none: the probe on the Android 15 image lists only X25519 HPKE.

So the shell's "defense in depth" check (security review, finding Low (a)) never runs on Android. It always takes the "skipped and logged" branch that was documented only for Android 8–12. The page's WebCrypto/tweetnacl check still applies, as do the pinned-repository URL, the sha256 and the request-to-release binding. A script injected into the page could, however, install any published asset of the pinned repository whose `channel-beta.json` it can match.

**Recommendation:** a small pure-Java Ed25519 verifier in `UpdatePolicy` (no library), tested against the JDK's SunEC. I didn't write crypto code under a "fix minimally" brief.

### 2. Bug fixed: every genuine Android game update was refused (`65df08e`)

`KeyFactory.getInstance("Ed25519")` in an app process resolves to `AndroidKeyStore`. Its `generatePublic` throws, and `verifyEd25519` mapped that to `FALSE`. The result was "The release's signature does not match this app's release key. Nothing was installed." for real releases (`android-00`).

- **Probe:** a throwaway dex, not committed, run with `app_process` on the emulator with and without the Keystore provider installed. Without it: "Ed25519 KeyFactory not available". With it: `AndroidKeyStoreKeyFactorySpi.engineGeneratePublic` throws `InvalidKeySpecException`.
- **Fix:** skip `AndroidKeyStore*` providers. If no other provider can import the key, return `null` (unavailable, logged). Verification errors after a key was imported still return `FALSE`.
- **Test:** `PolicyTest` installs a stand-in Keystore provider with the JDK provider removed. Android's `KeyFactory` doesn't fail over, unlike the JDK's, so the JDK provider has to go. Before the fix it failed with `got false`; it passes after.

The previous device run didn't catch this. It ran before the shell-side signature check existed, and `PolicyTest` runs on the JDK, where SunEC verifies and `KeyFactory` fails over between providers.

### 3. Bug fixed: unreadable status lines in the dark Updates dialog (`dd5dfb7`)

`.modal.ae-dark` sets a light `--ink`, but `.upgrade-status` kept its light-paper fills. The shell refusal ("The release's signature does not match…"), "You're up to date" and the busy lines measured **1.10:1**.

- **Fix:** dark fills with matching light text for `.modal.ae-dark .upgrade-status{,.ok,.error}`.
- **Test:** `tests/update-status-contrast.test.ts` renders `style.css` in headless Chrome and requires 4.5:1. It fails before the fix and passes after.
- **Effect:** the macOS, iOS and Android screenshots show the readable lines.

### 4. Observation, not fixed: rollback notice on slow devices

On the slow emulator, the game took about 60–90 s to load again after the rollback. The one-time "didn't start, so the app went back…" toast was raised while the loading screen still covered the page, and it had expired before the city showed. Showing it after boot, or making it persistent, is a UI decision. `takeRolledBack()` is one-shot, so the notice isn't shown again.

## Tooling changes (evidence only)

- **`tools/update-fixture.ts`:**
  - `POST /__fixture/tamper/<off|page|shell|all>` alters a channel file after signing;
  - `UPDATE_OLDER` adds a downgrade release;
  - `UPDATE_APK` publishes a sideload APK as the good release's `shell.android`;
  - `GET /__fixture?since=<count>` lists the requests since an earlier count.
- **`tools/update-desktop-check.ts`:** reads the versions from the fixture, takes `OUT_DIR`, and adds the page and shell tamper checks, the request-log evidence of the shell's own channel read, and the downgrade checks for both page and shell. The old defaults (`0.1.1`/`0.1.2`) are below the current `1.0.0-beta.1`, so the old script could no longer run.

## How each platform was run

- **macOS:**
  - `npm run desktop:package`, then `release/Agent Empire-darwin-arm64` launched with `--user-data-dir=<scratchpad>/update-rerun/ud-macos`, `--use-mock-keychain`, CDP on 9333 and `--empire-update-fixture=http://127.0.0.1:4721`.
  - Driven by `tools/update-desktop-check.ts`.
- **iOS:**
  - Debug simulator build (`xcodebuild -scheme AgentEmpire`, DerivedData in the scratchpad).
  - Launched with `-AE_UPDATE_FIXTURE http://127.0.0.1:4721` and driven by taps.
  - **I uninstalled and reinstalled `com.agentempire.mobile` on the shared booted iPhone 18 Pro to start from a clean bundle store.** The simulator now has this Debug build with fixture data.
- **Android:**
  - Isolated AVD `ae-update-rerun` in the scratchpad: `system-images;android-35;google_apis;arm64-v8a`, `pixel_7`, `disk.dataPartition.size=3G`, port 5596, headless.
  - Debug APK from `mobile/tools/build-android.py`. A second APK with `versionCode 10000302` / `1.0.0-beta.2` was built by temporarily editing the manifest, which was then reverted. Both are signed with the same local development key.
  - Signed in with `ae.debug.login` to 4720. Driven by `adb input`, plus WebView CDP for the direct bridge call.
  - The emulator was killed and the AVD deleted. The other emulators (5554, 5556) were not touched.
