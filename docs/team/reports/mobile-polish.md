# Mobile polish and security review fixes

Branch `claude/mobile-polish`, based on `929a166`. That commit integrates the bundled iOS app, the bundled Android app, the first-launch setup and the cloud coordinator.

The work covers two things:
- the three problems the coordinator found walking the iOS first launch;
- the fixes from the independent security review of `929a166` (M1, M2, L1–L10).

Everything was walked with real taps on both the iOS simulator and an Android emulator.

## The three iOS findings

### 1. The keyboard stays open over the loading screen and covers the founder dialog

**Cause.**
- The password field kept focus after a successful sign-in, so the iOS keyboard stayed up while the game loaded.
- The founder dialog then focused its name field by script.
- On a landscape phone that keyboard covers almost the whole dialog.

**Fix: `src/client/keyboard.ts` (new).** The setup and the game share it, and it imports nothing else.
- `dismissKeyboard()` blurs the focused field when one screen hands over to the next. The setup calls it on a successful server sign-in, and `boot.ts` calls it when the game starts.
- `autoFocus(target, fallback)`: on touch devices (`pointer: coarse`, or `?touch=1`), a dialog never focuses a text field by itself. The dialog takes focus instead, so the focus trap and screen readers still start inside it. Desktop keeps its autofocus.
  - It is used by the founder, prompt, ask, queue, team, picture and sector-task dialogs.
  - `openModal`'s own fallback focus follows the same rule.
- `trackKeyboard()` handles fields the user focuses:
  - While a field is focused on touch and the visible area is clearly shorter than the full page, it sets `html.ae-kb` plus `--ae-vvt` and `--ae-vvh`, taken from `visualViewport`.
  - The full-page height is measured before the field took focus, so this works on iOS (where only the visual viewport shrinks) and on Android (where the whole WebView shrinks).
  - It scrolls the focused field into view inside its own scroll box.
  - It resets a page scroll that WebKit leaves behind after the keyboard closes.
- CSS while `html.ae-kb` is set:
  - The setup and dialog backdrops fit the visible area.
  - The setup hides its header, because the field's label stays in view.
  - Dialogs compact their header, body and footer, and the founder's 3D preview steps aside.
  - The result: the focused field and the primary action both stay above the keyboard.
- Touch text fields in dialogs are 16px or more, so iOS doesn't zoom the page.

**Android needed a native fix too (`MainActivity.java`).**
- The app calls `setDecorFitsSystemWindows(false)`, which turns off `adjustResize`. The keyboard therefore covered the focused field: see `android-07`, captured before the fix and later replaced.
- The root view now pads itself by the IME inset.
- It then re-dispatches the insets, because without that the WebView dropped the 52px display-cutout inset (`env(safe-area-inset-left)`) after the first keyboard. Measured: 52 → 52 → 52 across opening and closing the keyboard.

### 2. Light cream dialogs next to the dark Agent Empire design

`.modal.ae-dark` re-skins the old "paper" dialogs with the setup's design tokens:
- teal glass;
- Inter / SF Pro type;
- 44px controls, a mint primary button and the setup's focus ring;
- 16px inputs.

It redefines `--ink`, `--muted` and the other paper variables inside the dialog, so inline styles that use them follow. Ids, roles and aria attributes are unchanged.

| Dialog | Change |
|---|---|
| Founder / character | Now dark (`charsel ae-dark`), with a dark turntable stage and accent swatches |
| Settings | Now dark (`settings-modal ae-dark`): slider, quality cards, key rows |
| Desktop Controls help | Was light; now `game-help ae-dark` |
| Prompt and confirm dialogs | Now dark (`confirmDialog` includes "Sign out?" from the menu) |
| Game menu, Touch help | Were already dark; they gain the same header, close button and focus ring |
| Management, execution, founding | Were already dark; they now share the setup typeface |

The page background in `style.css` was light blue (`#bfe3ff`), and it flashed under the setup as it handed over to the game (`android-12-handover-before-bg-fix.jpg`). It is now the splash ink.

### 3. Setup text is larger on the steps after the mode choice

**Cause.** Landscape iOS text inflation (`-webkit-text-size-adjust: auto`). WebKit enlarges long paragraphs, but not the short text on the mode cards.

**Fix.**
- `text-size-adjust: 100%` on `html` (in `index.html` and `style.css`) and on `.su`.
- The compact lede is now one size on every step. It was 12.5px on the mode step and 13px elsewhere.
- On the simulator, `ios-02-mode` and `ios-03-cloud-github` now show the same body size.
- Inputs stay at 16px.

**Also found and fixed: two setup panels on screen at once.** Pressing Back and then a card within the 260ms transition left the mode panel on screen over the server step. `render()` assumed only one old panel existed. It now retires every visible panel. This came from a desktop timing difference in the UI check.

## Security review fixes

| ID | Fix | Test |
|---|---|---|
| **M1** | iOS `BridgeProtocol.sessionKeys` = server.token, server.deviceId, github.token, github.login (the same set as Android `SESSION_KEYS`). `app.signedOut` deletes all of them | `Checks`: the set, and that mode, host and repo are kept |
| **M2** | Android `scopes()` accepts only `repo`, `workflow` and `read:user`. It de-duplicates and refuses an empty list (iOS parity) | `PolicyTest`: 8 refused scopes, de-duplication, empty list |
| L1 | Android HTML CSP moved to `AssetPolicy.HTML_CSP` / `htmlHeaders()`, which is the only HTML response path in GameAssets. `frame-src 'self'` is kept. Origin-scoped messaging was not attempted | `PolicyTest`: CSP present and has no wildcard |
| L2 | Android config gains `deviceName` (the user's device name, or maker + model), `mode`, and a one-shot `signedOut` reason, through the pure `BridgePolicy.configFields` | `PolicyTest`: 9 config cases |
| L3 | The page accepts `login: null` (or a missing login) from the device flow. `linked()` already reads the login from `/user` itself | `native-bridge.test` (+1 test, +1 assertion for a non-string login) |
| L4 | iOS verification URL must be https on exactly `github.com` or a `.github.com` subdomain | `Checks`: evilgithub.com, github.com.evil.io and http are refused |
| L5 | iOS `GestureGate`: one Safari open per touch, within 5s | `Checks`: 4 cases |
| L6 | `apiUrl` and `apiInit` throw unless the target resolves to `app.host`. `apiFetch` sends nothing in that case. `apiInit` now takes the path | `endpoint.test` (+1): 5 foreign targets, nothing fetched |
| L7 | `decideLaunch` passes the stored `server.host` through `normaliseHost` before redirecting or prefilling | `setup-flow.test`: javascript:, data:, a path, credentials, `//evil` and garbage all fall back to setup; the host is normalised |
| L8 | The setup's `el()` sets an input's `value` as a property, never as an attribute | `setup-ui-check`: after a re-render the typed key is kept in the field, the attribute is absent and the key isn't in `outerHTML`. This failed before the fix |
| L9 | Android `secure.set` applies per-key value rules identical to iOS `validate` (`BridgePolicy.invalidValue`) | `PolicyTest`: 9 accepted and 17 refused values, plus the debug emulator host |
| L10 | Token guidance: create the private `agent-empire-state` repository first (a prefilled `github.com/new` link), then a fine-grained token with **Only select repositories**, a 30-day-or-shorter expiry, and Contents, Secrets, Workflows, Actions and Pull requests (read and write) plus Metadata (read). No Administration. `createStateRepo` now looks the repository up before creating it, so that token is enough | `setup-cloud.test`: an existing repository is reused with no create call. Screenshot `android-06-token-guidance.jpg` |

**Related change for the device walk.** The page allows `http://10.0.2.2` (the emulator's alias for the host's loopback) only in the Android app. The shell is still the authority: a release build refuses cleartext and won't store that host, which L9 checks.

## Evidence

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | **345/345** (338 before: +5 `keyboard`, +1 `native-bridge`, +1 `endpoint`; more assertions in `setup-flow` and `setup-cloud`) |
| `npm run build`, `npm run build:cloud` | pass |
| `tools/setup-ui-check.ts`, fixture 4713 | **73/73** (49 at `929a166`). New checks: one lede size and a compact body scale on every step; text-size-adjust 100%; keyboard closed at the hand-over; the founder doesn't autofocus on touch but does on desktop; focus starts inside the dialog; a tap focuses the field; Settings, Controls and Management are dark; no light dialog in the first minutes; L8 |
| `tools/mobile-ui-check.ts`, fixture 4713 | **149/149** (135 before). New checks: Settings, founder and Controls are dark at 667, 874 and 1024 wide; no auto-focused field on touch; desktop autofocus kept. Its screenshots were reverted as before |
| `mobile/ios/Checks/run.sh` | **65/65** (54 before) |
| Android `PolicyTest` (in the build script) | **355** checks passed |
| `xcodebuild` Debug, ad-hoc signed | succeeded, no Swift warnings |
| Android APKs | release and debug built and verified by the script |

### Android walk

Isolated AVD (pixel_7, API 35 google_apis arm64, 3 GB data, soft keyboard, port 5592), debug APK, fixture `http://10.0.2.2:4713`. Screenshots are in `docs/team/reports/mobile-polish/android-*.jpg`.

1. **00** System "Viewing full screen" hint on first immersive launch, dismissed with Got it. **01** Welcome after a fresh install.
2. **02** Mode choice. **03** Cloud, step 1: the text is the same size as on the mode step.
3. **04** Native device-code dialog against **real github.com** with client id `Ov23li3G3aR4rgZ0lCJ3`. GitHub returned codes CFFD-83C9 and 98B7-9184 on two runs. Neither was entered, and Cancel was pressed. **05** "GitHub sign-in was cancelled."
4. **06** New token guidance. **07** Token field focused: the field, Check token and Back sit above the keyboard. Before the native fix the keyboard covered it.
5. **08** Server step. **09, 10** Address and password, each above the keyboard. **11** Wrong password: "Wrong password.", the field is cleared, the keyboard is closed and the cutout inset is kept.
6. **12** Hand-over (correct password): the keyboard closes and the background is dark. **13** Loading with no keyboard (`mInputShown=false`). The fixture logged the sign-in.
7. **14** Founder dialog: dark, with focus on the dialog form and not the field, and no keyboard. **15** Name field tapped: the field and Save are above the keyboard. `innerHeight` was 151 with `ae-kb` on.
8. **16** Game. **17** Back opens the game menu (dark). **18** Back closes it; the activity stays resumed. **19** Settings (dark).
9. **20** Force-stop and relaunch go straight to the game: no setup and no dialog.

### iOS walk

iPhone 18 Pro simulator, a fresh install (uninstall plus `simctl keychain reset`), fixture `http://127.0.0.1:4713`. Taps were sent in portrait points. Screenshots are in `docs/team/reports/mobile-polish/ios-*.jpg`.

1. **01** Welcome. **02** Mode. **03** Cloud, step 1: the body text is the same size as on the mode step.
2. **04** Native sheet with a real GitHub code (A221-6D3B). It was not entered; Cancel was tapped. **05** "GitHub sign-in was cancelled." This confirms the L4 host check accepts github.com.
3. **06** Server step. **07** Address field with the keyboard: the field and Sign in are visible. This shot was retaken with the final build. **08** Empty-password error. **09** Password with the keyboard (final build). **10** "Wrong password."
4. **11** Correct password: the loading screen shows **no keyboard**. The fixture logged the sign-in.
5. **12** Founder dialog: dark, no keyboard.
6. **13** Name field with the keyboard: the title, the field, and Random profile / Continue to my city are all above it (final build). **14** Game.
7. **15** The final build was reinstalled over the old one and relaunched: it goes straight to the game. **16** Menu (dark). **17** Settings (dark).

The app is left installed on the booted simulator.

## Not verified / known gaps

- **iOS first tap on the founder name field.**
  - On the simulator, the first tap on the name field after the hand-over reliably did not open the keyboard; a second tap did. The page log shows the first touch landing on the input and a click firing.
  - It did not happen on Android, in the Chromium touch run, or in the setup's own fields.
  - Cause not found within the time box. Candidates: WebKit timing under a busy WebGL main thread, or focus moving from the dialog form to the input.
  - Worth checking on a physical iPhone.
- **iOS accessory bar.** The "next field" chevron did not respond to synthetic taps, so the walk tapped the password field directly. This is not a page issue.
- **Physical devices.** None used; everything ran on the emulator and the simulator.
  - Android below API 30: the IME padding is only installed on API 30+, where the decor no longer fits system windows. Older versions keep `adjustResize`, which was not exercised.
- **Not exercised in the apps:** the keyboard-fit layout in the in-game prompt, ask, queue and team dialogs. Their open-time focus change is unit-tested through `autoFocus`.
- **L1** is covered by a policy-level test of the single HTML header path, not by an instrumented WebView test. Origin-scoped messaging (`WebMessagePort`) was not attempted.
- **L10's flow end to end:** the real `github.com/new` prefill and a fine-grained token without Administration were not exercised against GitHub. Only the fake-GitHub unit test was run.

The fixture on 4713 and the emulator were stopped, and the scratchpad AVD was deleted. Port 4610, `.agent-office`, `tests/browser-smoke.mjs` and the MyMecho AVDs were not touched.
