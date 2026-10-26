# Device bugs round 3 (DEVICE-BUGS-03)

Branch `claude/device-bugs-03`, from `origin/codex/empire-world` at `64585f8`. Tested on 2026-10-26 on an Apple M4 Pro Mac (macOS 27). Owner reports on the published **1.0.0-beta.2**.

**Isolation.**
- **Ports.** Fixtures used ports 5231–5236. The emulator used 5244 and the WebView DevTools forward 5246. The scratch Mac app's CDP used 5247 and 5248. The released local host was started once on 5249.
- **Never touched:** port 4610, Pixel, `.agent-office`, the real Mac profile (`~/Library/Application Support/Agent Empire`) and the user's AVDs.
- **No sign-ins.** I made no paid calls, used no real credentials and created no accounts. The GitHub sign-ins in this round all used a fake token against an in-memory `api.github.com`.
- **Scratch only.** The Android emulator ran a scratch AVD (`db03`, 3 GB data partition). I deleted it afterwards.
- **Clean-up.** Everything I started is stopped, and the scratch downloads are deleted.

## Bug 1: the Android cloud setup runs off the right edge

### Reproduced

- **Released APK** (`Agent-Empire-Android.apk`, SHA-256 `1070e5d0…dc9f`) on an API 35 emulator, at 2400×1080 and 420 dpi (CSS 915×412).
  - The setup welcome, mode and GitHub steps render, but the projects step can't be reached in a release build: it needs a real GitHub sign-in, and release WebViews aren't inspectable.
  - So the projects step was driven on a **debug APK built from the same sources**. Over the WebView DevTools socket (raw CDP), `api.github.com` was answered by `tests/fake-github.ts`.
- **Chromium (Playwright)** with the owner's kind of data, meaning long repository descriptions: the **projects panel overflows at every size**, 1024×768 included.
  - The panel ends at x = 969 on a 915 px screen and at 875 on a 667 px screen. The lede is cut ("Only t…"), the descriptions are clipped and **Choose engine** is off screen. That is exactly the owner's screenshot.
  - Evidence: `device-bugs-03/android-setup/before-repos-*.jpg`.

### Root cause

- **The stage track.** `.su-stage` is a grid with no explicit tracks, so its implicit column is `auto`.
- **How it grows.** An `auto` track's minimum is the grid item's min-content width. The panel's min-content width comes from content that can't wrap:
  - repository descriptions (`.su-repo-meta { white-space: nowrap }`);
  - `nowrap` buttons;
  - long unbroken names.
- **The result.** The column, and the panel in it, grew to the panel's 760 px maximum whatever the screen width. `.su { overflow: hidden }` then clipped the right side silently.
- **Why the old check missed it:**
  - it measured `scrollWidth` at only two sizes (874×402 and 1440×900);
  - it used short fixture descriptions.

Font scale is **not** the trigger in the Android app. `MainActivity` sets `setTextZoom(100)`, so the WebView's text doesn't change at font scale 1.3 (checked on the emulator). Browsers and the PWA do scale text, so the sweep covers that case too.

### Fix (`src/client/setup/setup.css`, `view.ts`)

- **Grid tracks.** `.su-stage { grid-template: minmax(0, 1fr) / minmax(0, 1fr) }`, plus `min-width: 0` / `max-width: 100%` down the panel, header, footer, rows and buttons.
- **Repository rows:**
  - descriptions wrap and clamp to two lines with an ellipsis;
  - names flow inline, so a long name wraps after the owner and the lock icon follows it;
  - the filter field shrinks.
- **Footer.** It wraps if it must, and the primary action keeps the right edge. It is the panel's sticky footer, so it is always on screen. Button labels ellipsize instead of pushing.
- **Step rail:**
  - an icon rail in short landscape up to **820 px** wide (it was 700), so 800×360 phones get the width;
  - in portrait it stays the existing top progress bar;
  - labels ellipsize.
- **Welcome title.** It wraps between "AGENT" and "EMPIRE" instead of running off a phone with large text.
- **Long text.** Errors, callouts, the linked-account card and the create progress wrap long tokens.

### New automated check (`tools/setup-ui-check.ts`, overflow sweep)

- **Coverage.** Every step: welcome, mode, GitHub device step, GitHub linked, projects, engine, limits, review, create (failed and resumable), own server, the desktop three-way choice, the web token fallback and the web server step.
- **Sizes:** 667×375, 800×360, 915×412, 375×812 portrait, 1024×768, and 740×332 (a 915×412 phone with a larger Android display size).
- **Text cases:** 100%, CSS zoom 130%, and text-only 130% (every font size × 1.3, like Chrome text scaling).
- **What it measures.** Each element's visible right edge, honouring clipping ancestors inside the setup. `scrollWidth` alone missed this bug. It also checks that the primary button is fully on screen.
- **Before the fix: 29 failures.** The projects step failed at all sizes, plus the GitHub-linked, review, create, web-server and welcome steps at the phone sizes with larger text.
- **After the fix: 234 of 234 pass.**
- **Options.** `SWEEP_ONLY=1` runs just the sweep. `SWEEP_OUT=<dir>` saves every case.

### Verified on the device (debug APK of the fixed sources)

| Case | Viewport | Result | Evidence |
| --- | --- | --- | --- |
| Projects step, default display | 915×412 @2.625 | nothing overflows, **Choose engine** visible | `android-emulator/after-debug-apk-repos-default.jpg` |
| Projects step, display size 520 dpi + font scale 1.3, cold start | 739×333 @3.25 | icon rail, nothing overflows, primary visible | `android-emulator/after-debug-apk-repos-display-large-font130.jpg` |

Released-APK screens for comparison: `before-released-apk-mode-default.jpg` and `before-released-apk-github-default.jpg`.

### Found on the way (not fixed here)

- **The WebView doesn't re-lay out after a runtime display-size change.** The manifest lists `density` in `configChanges`, and nothing handles it.
  - After `wm density 520` with the app open, the page keeps a 915 px CSS viewport while it renders at DPR 3.25, so everything is scaled off screen. That happens on the released APK and on the debug build.
  - A cold start is correct.
  - Evidence: `released-apk-runtime-density-change-stale-viewport.jpg` and `debug-apk-runtime-density-change-stale-viewport.jpg`.
  - Suggested fix: on a `densityDpi` change in `onConfigurationChanged`, reload the WebView layout, or drop `density` from `configChanges` and let the activity be recreated. The second option needs setup progress to survive that.
- **Changing the font scale on the released APK returned the setup to the welcome screen** (`released-apk-font-scale-130-restarts-setup.jpg`). On the debug build the process survived. I didn't look further.

## Bug 2: the Mac app "seems to use the old world design"

### What the released app runs

- **The DMG.** `Agent-Empire-Mac-Apple-Silicon.dmg` (beta.2) was copied to scratch: shell `CFBundleShortVersionString` 1.0.0-beta.2, `Resources/app/package.json` 1.0.0-beta.2.
- **The built-in game.** `runtime/public` is **byte-identical** to the released `agent-empire-game-1.0.0-beta.2.zip` (`diff -rq`, no differences). Its `game-version.json` is `1.0.0-beta.2`.
- **Launched with `--user-data-dir=<scratch>`:**
  - The window loads `empire-app://game/`, and `/game-version.json` = `1.0.0-beta.2`, script `assets/main-CD0gm_P7.js`. That is the released bundle.
  - Driving further stalled: the first secure-storage write blocks the main process. This is almost certainly macOS asking for access to the real "Agent Empire Safe Storage" Keychain item, because the scratch copy has the same name.
  - I stopped there rather than touch the owner's Keychain. Screen recording isn't permitted for this session, so I couldn't see the prompt.

### Upgrade from beta.1 to beta.2

I ran `scratch/mac/upgrade-sim.cjs` with the **released beta.2 app's own `update-store.cjs`**. Its built-in game is the app's `runtime/public`. Each scratch profile's update store held the **released beta.1 game zip**, unpacked:

| Update store before launch | Served after `launch()` |
| --- | --- |
| beta.1 active and known good | built-in beta.2 (`main-CD0gm_P7.js`) |
| beta.1 pending | built-in beta.2 |
| beta.1 mid-trial (previous start never booted) | built-in beta.2, and beta.1 marked bad |
| beta.2 game installed earlier by the beta.1 shell | built-in beta.2 |
| fresh | built-in beta.2 |

- **No update-store bug.**
  - `servable()` serves an installed bundle only when it is strictly newer than the built-in game.
  - `compareSemver` orders beta.1 < beta.2 correctly.
  - The channel bridge can't install an equal or older game (`refuse()`).
  - `tests/desktop-updates.test.ts` already covers "after the app itself updated".
- **Local own-server mode.** I started the released app's `local-host.cjs` with its runtime on 5249 (scratch project, no credentials): `/api/health` OK, `publicDir` = the same `runtime/public`. In local mode the window still loads the built-in `empire-app://` game and only talks to the host.
- **Minor.** The server answers `/game-version.json` with an HTML page instead of the file. Nothing in the app reads it from the server.

### Root cause

- **The world changed after the release.** 65 commits landed on `codex/empire-world` after the `v1.0.0-beta.2` tag (`1fb8e12`, 2026-10-25 14:04). They include the CITY-10 city architect (world additions rendered in the game) and the CHAR-02 animation states: 1,410 changed lines across `src/client/world`, `src/shared/world*.ts` and the UI.
- **The version label didn't.** `package.json` stayed `1.0.0-beta.2`, so every later build (`npm run desktop`, the dev server, previews, fixtures) calls itself **Game 1.0.0-beta.2**, exactly like the release.
- **Conclusion.** The released Mac app is the released beta.2 world. If the owner compared it with a newer build, both showed the same version, and the app had no way to show the difference.
- **Another possible cause.** A beta.1 app still in use, for example launched from an old copy, shows the beta.1 world and labels itself 1.0.0-beta.1.

### Fix: make the build visible (test first)

- **The build stamp.** `tools/release/game-build.mjs` → `{commit, date, dirty}`. Git HEAD is the default; CI can pin it with `GITHUB_SHA` or `AGENT_EMPIRE_BUILD_COMMIT`. Outside Git it is null.
- **The build output.** `vite.config.ts` writes `game-version.json` = `{version, build}` and defines `__AGENT_EMPIRE_GAME_BUILD__`. The native shells (desktop, Android, iOS, and the frozen beta.1 readers) read only `version`.
- **The display.** `src/client/update/version-line.ts`: Settings › Updates and the game menu now read "**Game 1.0.0-beta.2 (build 1fb8e12, 25 Oct 2026)** · desktop app 1.0.0-beta.2 · Beta channel". A `+` marks a build from uncommitted changes.
- **The menu entry.** It always shows this line. Before, it showed it only after an update check.
- **Tests:**
  - `tests/game-build.test.ts`: red before (missing module), 5 of 5 after;
  - `setup-ui-check` asserts the Settings line at both sizes.
- **Evidence:** `device-bugs-03/mac/after-settings-version-with-build-874x402.jpg` and `-1440x900.jpg`. They show Settings › Updates reading "Game 1.0.0-beta.2 (build d2a29c0+, 26 Oct 2026)" for this branch's build. There is no "before" picture of the Mac window, because of the Keychain stall. Before this change the line read "Game 1.0.0-beta.2 · desktop app 1.0.0-beta.2 · …" for the release and for every later build alike.
- **How the owner can tell builds apart now:**
  - The release built from the tag shows `build 1fb8e12`.
  - A build of today's branch shows its own commit.
  - The shell version shows which app is running.

## Checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` | 1138 tests: 1137 pass, 1 skipped, 0 fail |
| `npm run build` | pass (client and server; no fixture markers or development key in `dist/public`; no development key trust in `dist/server`) |
| `setup-ui-check` (with the overflow sweep) | **365/365** ALL PASS: the 234-case overflow sweep, the existing flows at 874×402 and 1440×900, and the new Settings build line |
| `mobile-ui-check` | 411/411 |
| `cloud-ui-check` | 171/171 ALL PASS |
| `onboarding-ui-check` | 60/60 |

I reverted the screenshots the checks regenerate under other reports' folders. In `docs/team/reports/setup/`, only `*-05-repos.jpg` (the new repository rows) and `*-14-settings.jpg` (the build line) are updated. The evidence for this round is in `docs/team/reports/device-bugs-03/`.

## Review round 1

All eight items are fixed. `origin/codex/empire-world` (FREE-11/12, #57) was merged first. Each item had a failing check first where one applies.

| # | Item | Result |
| --- | --- | --- |
| 1 | The sweep couldn't see overflow inside scrolling bodies | **Fixed.** Ancestors with `overflow-x: auto/scroll` fail when `scrollWidth > clientWidth + 1`; only `hidden`/`clip` clamp. `.su-cmd code` scrolls by design. **Proof:** I put repository descriptions back on one unwrapped line and the sweep failed 21 cases ("`.su-body` scrolls sideways"), which the clamp-only version passed. Then I restored the rule. |
| 2 | Sweep coverage | **Fixed.** Closed `<details>` are opened while measuring. Added: the create step while running (installer held at the secrets step) and after success (the 900 ms hand-over held), "Open my Empire" (`mountCloudUnlock`), limits, review and create in the desktop and web paths, desktop "Run on this computer" cancelled and failing, and 1440×900. **567 sweep cases:** 27 screens × 7 sizes × 3 text cases. |
| 3 | Icon-rail steps had no accessible names | **Fixed.** Labels are visually hidden instead of `display: none`, in both the icon rail and the portrait top bar, and keep their done/current status. `setup-ui-check` reads the rail's accessibility tree at 667×375, 375×812 and 915×412: nameless list items before the fix, "Projects (current step)" after. |
| 4 | A font-scale change reset the setup on Android | **Fixed.** `configChanges` adds `fontScale\|fontWeightAdjustment`. The review's `fontWeightAdjust` doesn't exist, and aapt2 rejected it; I caught that by building the APK. **On the emulator:** font scale 1.3 keeps the same process and the setup stays on Projects. Test: `tests/android-shell.test.ts`. |
| 5 | A display-size change, or a reload or kill, lost the setup | **Fixed.** See details below. |
| 6 | Version-line guard | **Fixed.** The page's build is shown only when `s.game` equals the page's compiled version. Test in `tests/game-build.test.ts`. |
| 7 | Git-less test runs | **Fixed.** The two Git-dependent tests skip when `git rev-parse` fails. |
| 8 | The new `game-version.json` shape with the old readers | **Fixed.** See details below. |

**Item 5 in detail:**
- **What is saved.** The setup saves its non-secret progress in localStorage on every change: step, mode, server address, GitHub login, repositories, limits, schedule and engine choices. It never saves tokens, keys, the project token or the cost confirmation.
- **The restore.** A fresh launch takes the token back only from secure storage. It stops at the first step whose requirements are missing again, and never lands on create.
- **The density change.** Reloading the WebView wasn't enough: on the emulator it stayed at 915 CSS px with DPR 3.25. So `MainActivity` now **recreates** itself on a density change.
- **On the emulator.** After `wm density 520` the new WebView lays out at 739×333, and the setup comes back on Projects with "1 selected" (`android-emulator/after-review-density-change-recreated-projects-restored.jpg`). The emulator was offline for this step, so nothing reached `api.github.com`.
- **Tests:**
  - `tests/setup-progress.test.ts`: 6 cases;
  - `tests/android-shell.test.ts`;
  - `setup-ui-check` reload checks, 4 of 4. They were red with the restore disabled (the reload landed on the welcome screen).

**Item 8 in detail:**
- `tools/update-fixture.ts` keeps the rest of `game-version.json`, including the build, when it relabels the game.
- `tests/release-compat.test.ts`:
  - the frozen beta.1 desktop store installs and serves a `{version, build}` bundle;
  - the frozen Android and iOS readers read only `"version"`, within Android's 4 KB limit.
- The fixture case was red before the fix.

**Checks after the review:**

| Check | Result |
| --- | --- |
| typecheck | pass |
| `npm test` | 1221 tests: 1220 pass, 1 skipped, 0 fail |
| `npm run build` | pass |
| Debug APK build | pass (`MainActivity` compiles, policy tests run) |
| `setup-ui-check` | **705/705**: 567 sweep cases, 4 reload checks, 3 accessibility checks and the existing flows |
| `mobile-ui-check` | 411/411 |
| `cloud-ui-check` | 171/171 |
| `onboarding-ui-check` | 60/60 |

## Not done

- **The Mac GUI past the first screen** in the scratch profile, because of the Keychain prompt described above. A test run would need a differently named scratch build, or an approved Keychain item.
- **The projects step on the released APK itself.** It needs a real GitHub sign-in.
- ~~The runtime display-size relayout and the font-scale restart on Android.~~ Both are fixed in review round 1 (items 4 and 5).
