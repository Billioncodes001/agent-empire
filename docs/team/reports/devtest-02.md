# Device testing round 2 (DEVTEST-02)

Branch `claude/devtest-02`, from `origin/codex/empire-world` at `cb70e5f`. Tested on 2026-10-25 on an Apple M4 Pro Mac (macOS 27.0.1).

**Isolation.** Every server was a `tools/ui-fixture.ts` fixture on ports 5101–5104 (runs disabled). Port 4610, Pixel, `.agent-office`, the real desktop profile and the user's AVDs were not touched. I made no paid calls, entered no real credentials, created no accounts and completed no founding that starts jobs. The fixture's local founder picker (a name and a suit, stored in the browser) was completed once in the iOS PWA; it starts nothing. I stopped everything I started: the fixtures, and the iPhone 18 Pro simulator, which I booted and shut down. I removed the Playwright WebKit and Firefox downloads (600 MB) afterwards.

## Matrix

| # | Platform / check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | **iOS Simulator, Safari PWA** (iPhone 18 Pro, iOS 27), fixture `http://localhost:5104` | | `devtest-02/ios-pwa/` |
| 1a | Opens in Safari. Portrait shows the splash, then "Rotate your device" | PASS | 01 |
| 1b | Add to Home Screen. The name ("Agent Empire"), icon and "Open as Web App" come from the manifest | PASS | 02, 03 |
| 1c | Launch from the home screen: standalone, with no Safari bars. Splash in the manifest's dark colours | PASS | 04 |
| 1d | Rotation to landscape: the game, the founder picker and onboarding lay out in landscape | PASS | 05, 06 |
| 1e | Touch controls: the joystick, Use, Jump and view buttons render in landscape. A drag that started outside the joystick base didn't show a clear walk | Partly: render PASS, joystick walk **not confirmed** | 07 |
| 1f | Install instructions in-game (`pwa.ts` hint) | **Not checked** | |
| 1g | Service worker never caches authenticated API responses | Source review only: `sw.js` answers pages network-first, never stores `/api`, and precaches only static assets. **Not inspected at runtime**: no Web Inspector session, and no sign-out/offline run | |
| 2 | **iOS native setup walk** | **Not re-run** (out of turns) | |
| 2′ | Finding for 2: simulator-tool taps **with `duration: 0.1–0.15`** reliably pressed Safari controls, while plain taps were dropped. That explains last round's "taps only focus Set up my Empire". It looks like a tool quirk, not an app bug (not yet confirmed in the native app) | Diagnosis | |
| 3 | **Browsers on the fixture** (`tools/browser-matrix-check.ts`). 1440×900, 1024×768, 874×402 touch and 375×812 portrait; sign-in page, game boot, HUD, city canvas, Settings, onboarding, founder desk, console errors, focus trap, reduced motion and Save-Data | | `devtest-02/browsers/` |
| 3a | Chromium (Chrome 155) | PASS 49/49 | `results-chromium.json` |
| 3b | WebKit 26.6 | **FAIL → fixed** (bug D), then PASS 49/49 | `results-webkit.json` |
| 3c | Firefox 155 (Playwright build) | **Blocked**: the browser process won't start on macOS 27 ("Could not find profile folder"), even outside the sandbox | |
| 4 | **macOS app**: the game connecting to the local host after "Run on this computer" | **Not tested** (out of turns) | |
| 5 | **Android extras** (reduced motion, Save-Data, hardware keyboard, garage dialogs, API 28/29) | **Not tested** (out of turns). No AVD was created | |

## Bugs and fixes (tests first; each new check failed before its fix)

| | Bug | Fix | Test | Commit |
| --- | --- | --- | --- | --- |
| B1/B2 | A release Android build reported a plain-http address (10.0.2.2) as "unreachable … HTTPS certificate". The "localhost may use http" hint is false there | The Android shell injects `AGENT_EMPIRE_APP.devBuild = true` only in debuggable builds. Without it (the released beta.1 APK included), setup refuses any http address before sending a request: "Release builds of the Android app connect over HTTPS only…". The loopback hint stays for web, iOS and desktop | `setup-cloud.test.ts`, `native-bridge.test.ts` | `7188ed1` |
| B3 | The cloud card said "Uses your Claude and/or OpenAI API keys" | It now says "Runs free on GitHub Actions, or on your Claude plan or API keys" | Assertion in `setup-ui-check` | `d8465be` |
| B4 | "Test sent" toasts stacked over the onboarding step tabs | While a dialog is open, toasts sit at the bottom edge and only the two newest show (`style.css`, `:has(#modal-root > .backdrop)`). On a phone they can overlap the footer buttons for 3.5 s, but they don't take taps (`pointer-events: none`) | `onboarding-ui-check`: no toast overlaps the header or rail at 1440×900 and 667×375 | `8d30369` |
| B5 | `08-notifications-667x375.jpg` showed the Company step | The check waits for the step change and asserts the title. Cause: the step-1 dialog that auto-reopens had a second one stacked over it. Settings › Company setup now reuses an open onboarding dialog | `onboarding-ui-check` | `8d30369` |
| B6 | Step-1 screenshot: the "Notifications" tab had a focus ring | Initial focus was already correct (the heading). The screenshot had been taken after the check's 25 Tab presses. It is now taken before them, with a check that no step tab has focus | `onboarding-ui-check` | `8d30369` |
| D | **WebKit/Safari:** Tab from the last text field left the dialog for the page body. Safari's default Tab skips buttons, so the trap's "last element" was never reached | The focus trap pulls focus back once the browser has moved it outside the top dialog (`dom.ts`) | `browser-matrix-check` WebKit (3 failures before) | `82aeeba` |

Fix screenshots: `devtest-02/fixes/` (cloud card), `free-08/01`, `04`, `08` and the new `08b` (toasts on a phone).

## Checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm test` | 998 tests: 997 pass, 1 skipped, 0 fail |
| `onboarding-ui-check` | 56/56 |
| `setup-ui-check` | ALL PASS. One earlier run timed out once at 1440×900 "all six steps done after resuming"; the re-run passed |
| `browser-matrix-check` | Chromium 49/49, WebKit 49/49 (after fix D), Firefox blocked |
| `mobile-ui-check`, `cloud-ui-check`, `inbox-ui-check` | **Not run** (out of turns) |

I reverted the screenshots that the checks regenerated, except the ones this round fixed.

## Still untested

- iOS PWA: the in-game install hint; a confirmed joystick walk; a runtime check that the service worker never caches authenticated API responses (Web Inspector, or sign out and go offline).
- iOS native: the setup walk, own-server sign-in on the fixture, the game and the update check. Next try: taps with `duration` 0.1.
- Firefox: needs a Playwright Firefox that runs on macOS 27, or another Mac.
- macOS DMG: the game connecting to the local host.
- Android: reduced motion, Save-Data, hardware keyboard, garage purchase dialogs, API 28/29, and the B1 message on the released APK (it shows only with a build that contains this change).
- `mobile-ui-check`, `cloud-ui-check`, `inbox-ui-check`.
