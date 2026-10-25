# Device testing: v1.0.0-beta.1

Branch `claude/device-testing`, from `origin/codex/empire-world` at `759480d` (the same tree as tag `v1.0.0-beta.1` → `e151d4d`), with `origin/codex/empire-world` at `e93c63a` (PR #48) merged in later. Tested on 2026-10-25 on an Apple M4 Pro Mac.

**Isolation.** Every server was a fixture (`tools/ui-fixture.ts`, port 5041, runs disabled). The 4610 session, Pixel, the real `.agent-office`, the real desktop profile and the MyMecho AVDs were never touched. I made no paid calls, entered no real credentials and created no accounts. I didn't complete the founding setup anywhere. Everything I started has been stopped, and the scratch AVD has been deleted.

## Matrix

| # | Platform / check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | **Android emulator**: released APK (SHA-256 `3f9287…3778`, checked against `SHA256SUMS`), API 35 `google_apis` arm64, scratch AVD with a 3 GB data partition | | `device-testing/android/` |
| 1a | Install and cold launch (887 ms). Landscape only. The system splash shows, then the game | PASS | 01, 02 |
| 1b | First-launch setup: choosing cloud or own server, Back, the cloud GitHub step (I stopped before the device flow) | PASS | 03, 08, 09 |
| 1c | Released APK pointed at the fixture `http://10.0.2.2:5041` | Refused, by design | 05, 06 |
| 1d | Own server (debug build of the same sources): sign-in, HUD with fixture data, 3D city | PASS | 10–14, 24 |
| 1e | Touch controls: the joystick walks, Jump, the view toggle (third ↔ first person), and Back opens and closes the menu | PASS | 24–28 |
| 1f | Sedan: entered with **Use**, driven with the joystick (7.5 m/s), and exit refused while moving | PASS | 31–33 |
| 1g | Helicopter: bought with fictional city credits, boarded with **Use**, **Up** climbs to 34.7 m, the stick flies it forward, and the skyline view works | PASS | 34–36 |
| 1h | Onboarding (four steps; resumes after restarting the app) | PASS after fix A | 19–22, 37 |
| 1i | Rotation: the app stays landscape and flips 90° ↔ 270° in both setup and game. Same process, state kept, safe-area inset follows the cutout | PASS | 07-*, 40-* |
| 1j | Session survives a force-stop. Invalid token → "Your sign-in is no longer valid", with the address kept | PASS | 16, 37 |
| 1k | Update check | Wrong (bug C), fixed | 29, 30 |
| 1l | Long press on a button selects its label | Bug B, fixed and re-verified on the device | 23, 38 |
| 1m | `adb logcat`: no FATAL, ANR or renderer crash in either session | PASS | |
| 2 | **iOS Simulator native** (iPhone 18 Pro, iOS 27): `xcodebuild -target AgentEmpire -configuration Release -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO` | | `device-testing/ios/` |
| 2a | Build, install and launch, landscape setup welcome | PASS | 01 |
| 2b | Setup walk, game, touch controls, update check | **Not completed** | 02 |
| 3 | **iOS Safari PWA** | **Not tested** (out of time) | |
| 4 | **macOS DMG** (arm64, unsigned), copied to scratch, `--user-data-dir` scratch, CDP on 5053 | | `device-testing/macos/` |
| 4a | Gatekeeper | Recorded | |
| 4b | First run: welcome, then a three-way choice (cloud / own server / this computer) | PASS | 01, 02 |
| 4c | **Run on this computer**: a native confirmation names the project folder. The local host starts on a random loopback port (52221; `/api/health` 200), with its data in the scratch profile | PASS | 03, 04 |
| 4d | The game connecting to the local host | Not confirmed | 04 |
| 5 | **Windows** | Not testable here | |
| 6 | **Browsers** (Playwright Chromium, WebKit, Firefox at 1440×900, 874×402 and 375 px) | **Not tested** | |

Notes on rows that need more than a word:

- **1c (released APK at the fixture).** A release build accepts only HTTPS (the native `ServerPolicy` and the HTTPS-only network config). The fixture was never contacted. So I tested everything after sign-in (rows 1d–1l) on a debug APK built from the same sources (`build-android.py --variant debug`). It bundles the same `dist/public` as the release APK.
- **1d (founder name).** On swiftshader the founder-name field lost characters typed with `adb input text`. That is an emulator quirk from running at 1.3 fps.
- **1f–1g (placement).** I put the player next to each ride with a test-only placement over CDP. Everything after that used real taps.
- **1l (selection bar).** Before the fix, Android's Copy/Share bar opened over the game.
- **2b (iOS walk).** Simulator-tool taps didn't press **Set up my Empire**: the button took focus but didn't advance, both with raw coordinates and with the documented landscape mapping. I didn't verify whether that is a tool quirk.
- **4a (Gatekeeper).** The app is ad-hoc signed: `TeamIdentifier=not set`, `Signature=adhoc`. `codesign --verify --deep --strict` passes, and `spctl --assess` gives **rejected**. A `gh` download carries no quarantine flag, so it launched directly. A browser download is quarantined, so macOS blocks the first open until the user allows it in **System Settings › Privacy & Security › Open Anyway** (or right-clicks › Open).
- **4d (desktop HUD).** The HUD still said "Connecting…" behind the founder picker when I stopped. On Android it connected once the founder picker closed. I stopped there to stay clear of founding.
- **5 (Windows).** There's no VM on this Mac, and I found no free, safe way to run one.

Emulator-only observations, not bugs:
- swiftshader rendered at 1.3 fps. I restarted the emulator with `-gpu host` and got 60 fps.
- The emulator shows Android's system "Viewing full screen" notice on first launch.
- The emulator's soft keyboard covered the form.

## Bugs found and fixed (test first; each test failed before its fix)

| | Bug | Fix | Commit |
| --- | --- | --- | --- |
| A | App walks against the UI fixture showed "Setup is not available: A same-origin Origin header is required" instead of onboarding. The fixture trusted only same-origin writes, while the real server trusts bearer requests (`trusted()` in `server.ts`). Fixture only, but it blocked testing onboarding in the apps | `tools/ui-fixture.ts` now treats a signed-in device's bearer as trusted. Test: `tests/ui-fixture-app.test.ts` | `4705c3c` |
| B | A long press on any game or setup button selected its label and opened the touch Copy/Share/Select all bar (Android; iOS has the same callout) | `user-select: none` and `-webkit-touch-callout: none` on `button, [role=button]` in `style.css` and `setup/setup.css`. Text fields stay selectable. Test: `tests/button-select.test.ts` (real stylesheets in headless Chrome). Re-verified on the emulator: the selection is empty | `7e76ea1` |
| C | 1.0.0-beta.1 shows "Stable channel · You're up to date" forever. Every release is a pre-release, so `releases/latest/download/channel-stable.json` is a 404 (checked live), which the reader treats as "no release". New builds were also defaulting to stable | **For new builds:** a pre-release build with no saved choice defaults to beta (`defaultChannel` in `src/client/update/service.ts`). Test in `tests/in-app-updates.test.ts` | `6cc9e52` |
| C′ | **The installed beta.1 apps are stranded** (they already sit on stable) | The release remedy below | `0a0ad46` |

### The stranding remedy (C′) and how it was proven

Options I considered:
- (a) publish the next 1.0.0 pre-release as GitHub's "latest" release, with a `channel-stable.json`;
- (b) a separate one-time "latest" release that carries only a stable channel file pointing at beta.2;
- doing nothing until 1.0.0 ships.

I chose (a):
- (b) would put a fake release at the top of the Releases page as "Latest".
- (b) would also need a tag that isn't semver.
- GitHub never makes a pre-release "latest", so either option has to publish without the pre-release flag.

**What changed:**
- `tools/release/version.mjs`: `stableBridge(version)` is true for any `1.0.0-*` pre-release. `versionInfo` gains `stableBridge` and `latest`.
- `tools/release/channel.mjs`: a bridged version writes `channel-stable.json` as well as `channel-beta.json`. Both list the same assets, and `checkPublished` already requires a `.sig` for each.
- `release.yml`: `verify` outputs `latest`. `publish` uses `--latest` when it is true (otherwise `--prerelease --latest=false`), and it refuses a latest release that has no `channel-stable.json`. Signing is unchanged: it signs `channel-*.json`.
- `docs/RELEASING.md` is updated.
- From 1.0.1-beta.1 on, pre-releases go back to beta-only. 1.0.0 itself is a normal stable release.

**Proof with the frozen beta.1 readers** (`tests/release-compat.test.ts`, a new test using `tests/compat/beta1/`). A beta.2 release is built by today's tools and served as GitHub's latest release:
- the beta.1 client's `fetchChannel('stable')` requests `…/releases/latest/download/channel-stable.json`;
- it verifies the signature and accepts a stable channel file whose version is a pre-release (its parser checks only `channel === 'stable'` and that the version is semver);
- `decide()` offers the game install, and the download matches the signed sha256;
- the desktop shell's fetch policy admits the latest URL;
- `channel-beta.json` is still published under the tag, which the desktop, Android and iOS shells re-read when they install;
- a beta.1 player who chose beta still gets beta.2. The listing no longer marks it a pre-release, but beta also reads stable and takes the newer one.

`tests/release-tools.test.ts` covers the version rules and the workflow wiring.

**What the release run must do:** nothing extra. Tag `v1.0.0-beta.2` as usual. The workflow publishes it as **latest** with both channel files. I didn't publish anything.

**Side effect to accept:** while it is "latest", `…/releases/latest/download/<name>` download links resolve to the beta.2 files, which are the newest builds anyway.

## Diagnoses (no product code changed)

- **Screenshot 16, "Your sign-in is no longer valid" after a restart.** This is fixture-only. I restarted the fixture to load fix A, and the fixture keeps device tokens in memory. The app handled it correctly: it showed the signed-out notice and kept the server address. The real server stores an HMAC of each token in `devices.json` (`src/server/devices.ts`). A new test, `device store: an issued app token still verifies after a server restart` in `tests/device-auth.test.ts`, passes on the unchanged code. A rotated secret still signs the device out.
- **Screenshot 36 (first run), the sedan on the garage roof with the founder on the bonnet.** My test harness caused this; normal play can't produce it.
  - **What happened:** I placed the player on the helipad (`player.pos.set(80.2, 6.3, 74.8)` over CDP) while the traversal state was still `driving`. The joystick had left the car at 1.6 m/s, so the exit tap was refused. While driving, the sedan follows the player's pose, so it was moved up to the roof at y = 6.3 with the player. The next **Use** then exited the car on the roof.
  - **Physical traversal wasn't involved.** The sedan never climbed the staircase.
  - **One thing for the character-quality slice:** a raw position write while driving drags the car with it. That is only reachable through the debug hook today.
  - Screenshot 36 was overwritten by the clean helicopter run after I relaunched the app. A later placement bug of mine (reading `spec.door` as `{x, z}` instead of an array) had put NaN into the player state. That is what produced the `AudioParam … non-finite` exceptions, and it was also test-induced.

## Checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm test` | 993 pass, 1 skipped, 1 fail (see below) |
| Targeted suites (`release-compat`, `release-tools`, `in-app-updates`, `update-roundtrip`, `desktop-updates`, `device-auth`, `button-select`, `ui-fixture-app`) | pass |

The one `npm test` failure was `continuity-sync` ("Fixture task did not start", a 9 s timing wait). It ran while the emulator and simulator were loading the machine. Re-run alone, it passed 6/6.

UI checks: emulator walks only. I didn't run the Playwright fixture checks, such as `mobile-ui-check`.

## Not tested

- **iOS native, beyond the welcome screen.** The setup walk, game, touch controls and update check need a re-run with working simulator taps (or `xcrun simctl` UI automation).
- **iOS Safari PWA:**
  - install instructions;
  - Add to Home Screen;
  - service-worker offline behaviour (including that authenticated API responses are never cached);
  - touch controls.
- **Browsers:** Playwright Chromium, WebKit and Firefox at the three sizes. WebKit and Firefox aren't installed for Playwright here.
- **macOS:** the game actually connecting to the local host after the founder picker. Gatekeeper's quarantined first-open dialog (described above, not observed).
- **Windows.**
- **Android:**
  - reduced motion;
  - Save-Data;
  - hardware keyboard;
  - API < 30;
  - garage purchase dialogs. Only the sedan and the helicopter were driven.
- **Minor, not fixed:**
  - On a release Android build, `http://10.0.2.2` passes the page's address check and then fails as "unreachable … HTTPS certificate", where "HTTPS required" would be clearer.
  - The "localhost may use http" hint is untrue on Android release builds.
  - The cloud card still says "Uses your Claude and/or OpenAI API keys" despite the free-first direction.
