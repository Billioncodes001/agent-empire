# CLOUD-03: first-launch setup (shared client) and the iOS shell

Branch `claude/first-launch-setup`, based on `08bb4a4` (cloud mode plan and native bridge contract). Lane: `src/client/**`, `mobile/ios/**`, fixture-only additions to `tools/ui-fixture.ts`, tests, and this report. Nothing in `src/server` changed.

## What the player sees now

On every platform, a first launch with no stored mode opens the setup before any game code loads (`src/client/boot.ts` imports `main.ts`, three.js and the models only once the Empire has somewhere to run):

1. **Welcome**: the tower mark, a split-letter title over a layered skyline, and "Set up my Empire".
2. **Mode choice**: two cards.
   - "Run in the cloud with my accounts": the Empire lives in a private repository in your GitHub and keeps working when the app is closed. It uses your Claude and/or OpenAI API keys. Limits: it reacts in minutes rather than seconds, and there are no live terminals, tunnels or local agents; voice and screen share are limited.
   - "Connect my own server": full capabilities. It needs a server you run; "What you need" summarises `deploy/cloud`.
3. **Server path**: the server address and the office password. The app probes `GET /api/health`, then calls `POST /api/device/login` (APP-01) with no cookies and redirects refused. It stores `server.host`, `server.token`, `server.deviceId` and `mode=server` through `secure.set`, adopts the session in the page (`setSessionConfig`, no reload) and loads the game. In a browser it validates the address and continues to that server's own `/login` page, so the page never sees the password.
4. **Cloud path**, in six steps:
   - **GitHub**: "Sign in with GitHub" runs the native `github.deviceFlow({clientId, scopes:['repo','workflow']})`. A token fallback is always offered: a fine-grained token, with the permissions listed.
     - In a browser, or when the build has no client id, the step says so plainly and shows the token form.
     - Native apps keep the token in secure storage. A browser keeps it in memory only.
   - **Projects**: the repositories come from `GET /user/repos` on api.github.com. The step has a filter, explicit checkboxes, "load more", read-only repositories disabled, and at most 20. The state repository itself is never offered.
   - **AI keys**: Anthropic and/or OpenAI, at least one, checked by format only. It explains that API keys are not a Claude or ChatGPT subscription, and that no subscription sign-in exists for third-party apps.
   - **Limits**: jobs at once (1–10), allowance per job, daily allowance (at least the per-job allowance) and "Ask me before each job starts".
   - **Review**:
     - the home repository `<login>/agent-empire-state` (private);
     - the projects, the providers and the limits;
     - what happens when the app is closed ("keeps working … only 'Shut down Empire' stops it");
     - the costs, which are the user's (Actions minutes and provider API).

     A cost acknowledgement is required before creating.
   - **Create**: a four-step progress list. It creates the repository, uploads the sealed secrets, installs the workflow, then writes the setup intent.
5. After the setup the mode is stored, so the next launch goes straight to the Empire. Cloud mode shows the honest view "Your Empire is being set up — Cloud view coming in the next update", with "Open on GitHub" and "Change setup". CLOUD-04 doesn't exist yet.

The web build served by an Agent Empire server (cookie session) is already "my own server". `probeOwnOrigin()` sees `/api/whoami` succeed and the game starts as before. A `401` goes to `/login`. Only a static copy of the game with no server behind it runs the setup. So the protected live host and the fixture-based checks are unchanged.

Design: this is original SVG and CSS art in the splash palette.
- Parallax skyline layers, twinkling windows and a blueprint grid.
- Glass panels, spotlight cards and the step rail.
- Step transitions, and focus moved to each step heading with an `aria-live` step announcement. Escape goes back.
- Touch targets are at least 44px, and inputs are 16px so iOS doesn't zoom.
- Reduced motion and Save-Data turn off all animation and blur.

No Higgsfield or third-party assets were used.

## Native bridge (page side: `src/client/native.ts`)

The page side implements the contract in `CLOUD_MODE_PLAN.md`.
- Requests are `{id, method, params}`. Answers come through `window.__empireNative.resolve/reject(id, …)`.
- Every request has a timeout: 15 s by default, and 16 min for the device flow, since GitHub codes last 15 min. Unknown or late ids are ignored.
- Secure keys are limited to the allowlist, and values to 8 KiB. GitHub scopes are limited to `repo`, `workflow` and `read:user`. Only `https` links can be opened.

| Shell | Transport |
|---|---|
| iOS | `window.webkit.messageHandlers.empire.postMessage(request)` |
| Android (APP-04) | `window.empireAndroid.postMessage(JSON.stringify(request))` |
| Desktop | `window.empireDesktop.postMessage(request)`. This is defined here; the desktop shell doesn't implement it yet |
| Browser | `webNative`: `mode`, `server.host`, `github.login` and `state.repo` are kept in localStorage. Secrets are refused. There is no device flow, and links open with `noopener` |

The platform is detected only from `window.AGENT_EMPIRE_APP.platform`. `endpoint.notifySignedOut()` now sends `app.signedOut(reason)` through this bridge on every platform (a 401, a socket close 4401, or the menu). This replaces the old `{type:'signedOut'}` message.

## Cloud setup (`src/client/setup/cloud-setup.ts`, `github.ts`, `sealed-box.ts`)

`CloudSetup` exposes `createStateRepo`, `uploadSecret`, `installWorkflow` and `writeInitialState`. The implementation uses real api.github.com REST calls:
- `POST /user/repos` creates a private repository. If the name is taken, it reuses the repository only when it is the same account's and private.
- `GET …/actions/secrets/public-key`, then `PUT …/actions/secrets/ANTHROPIC_API_KEY|OPENAI_API_KEY`.
- `PUT …/contents/.github/workflows/agent-empire.yml`.
- `PUT …/contents/intents/setup.json`. This holds names and limits only; clients write intents, per the plan.

`readiness()` is checked before any network call.

**The sealed box is implemented.** It uses the user-approved `tweetnacl@^1.0.3` (Unlicense) and `blakejs@^1.2.1` (MIT), both devDependencies bundled into the client; see `THIRD_PARTY_NOTICES.md`.
- It follows libsodium `crypto_box_seal`: an ephemeral X25519 key pair, nonce = BLAKE2b-192(epk ‖ pk), XSalsa20-Poly1305 through `nacl.box`, and output epk ‖ ciphertext in base64.
- The ephemeral secret key and the plaintext buffer are wiped after sealing.
- It was verified against real libsodium 1.0.20 (PHP ext-sodium on this Mac) in both directions:
  - our code opens a box sealed by `sodium_crypto_box_seal`;
  - `sodium_crypto_box_seal_open` opens a box sealed by `sealForGitHub`.

  A fixed-ephemeral vector, built from libsodium's own primitives, is reproduced byte for byte. The vectors and their source are in `tests/setup-cloud.test.ts`. I found no published crypto_box_seal vector with a fixed ephemeral key.

**What still stops "Create my Empire" in this build:** the coordinator workflow content. It is owned by CLOUD-02 and isn't on this branch. `pendingWorkflow` makes `readiness()` return "The always-on coordinator (the GitHub Actions workflow) isn't in this build yet". The create step then says "This build can't create your Empire yet. Nothing was created in your GitHub.", and no GitHub request is made (checked by a unit test and by the UI check's network log). To enable creation, CLOUD-02 passes a `WorkflowSource` into `mountSetup` (`deps.workflow`).

Provider keys:
- are held only in memory in the setup state;
- are cleared when leaving the cloud path and after creation;
- are never given to `secure.set` (the shell's allowlist has no key for them);
- are never sent anywhere except inside a sealed box.

## iOS shell (`mobile/ios`)

- **Launch.** The native launch screen goes straight to the bundled game.
  - `ConnectView.swift`, `OfficeAPI.swift` and `Keychain.swift` are removed.
  - The app is landscape only, including the plist orientations.
  - The scheme handler, full screen, no-white-flash, the navigation policy, the permission denials and the Debug-only localhost ATS exception are unchanged. The Release Info.plist has no `NSAppTransportSecurity` (checked).
- **`BridgeProtocol.swift`** is pure Foundation, so the Mac checks can run it:
  - it parses requests and validates id, method, key allowlist and values. `mode` must be cloud or server. `server.host` must be the exact origin allowed by `HostPolicy`, so a Release build is HTTPS-only. Token, login and repository have fixed shapes;
  - it builds the JSON-encoded resolve and reject scripts;
  - it builds the `AGENT_EMPIRE_APP` config: `platform`, `deviceName` and `mode`, plus host, token and device id only for a valid server session, plus a one-shot `signedOut` reason. The config is frozen and injected at document start.
- **`SecureStore.swift`** keeps one Keychain item per key, `AfterFirstUnlockThisDeviceOnly`. APP-03's single `device-session` item is migrated once to `mode=server` plus the server keys. This was exercised: the simulator's old session opened the game (`ios-00`).
- **`GitHubDeviceFlow.swift`** runs the flow with URLSession: `login/device/code`, then polling `oauth/access_token`, handling `authorization_pending`, `slow_down`, `expired_token` and `access_denied`, then `GET /user`. A native full-screen sheet shows the user code with "Copy code", "Open GitHub" and "Cancel". The token goes to the page and is not stored by this code.
- **`GameView.swift`** handles the bridge only for the main frame at the `empire-app://game` origin.
  - After `secure.set` or `secure.delete`, the config script is refreshed.
  - `app.signedOut` clears the token and device id, keeps the mode and address, and reloads into the setup's sign-in step with the reason.
  - `app.openExternal` opens Safari directly within 5 s of a real touch (a passive touch recorder) and otherwise asks "Open in Safari?".
  - Debug builds also send page errors to the simulator log (`AEPage …`).
- **`Checks/run.sh`** runs 54 checks (30 before), including 24 new bridge protocol checks.

## Evidence

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | **292/292** (259 before; 33 new: `setup-flow` 12, `native-bridge` 7, `setup-cloud` 13, `endpoint` +1). `endpoint.test.ts` was updated for the `app.signedOut` bridge requests |
| `npm run build` | pass. The setup chunk is 83 kB (29 kB gzip) and loads only when the setup is needed |
| `tools/mobile-ui-check.ts` (fixture 4707) | **135/135** (113 before). The new checks run the setup on a static copy at 667×375, 874×402 and 932×430: the start button and mode cards fully visible inside the panel's scroll area, touch-sized targets, no overflow, no page errors, reduced motion honoured, and the game bundle not loaded before a choice. The existing checks are unchanged and pass. Its screenshots were reverted, not re-committed |
| `tools/setup-ui-check.ts` (new; fixture 4707, playwright-core channel chrome) | **48/48**. It covers every step at 874×402 and 1440×900 with an in-page fake iOS bridge and a fake api.github.com (Playwright route; no request leaves the machine). The server path runs end to end against the fixture's device login, including a wrong password, and ends in the game. A not-ready build makes zero GitHub write calls. Only allowlisted keys are stored, and no provider key reaches secure storage. The web token fallback and the web server path (no password on the page) are checked too. Screenshots: `docs/team/reports/setup/{874x402,1440x900}-*.jpg` |
| `mobile/ios/Checks/run.sh` | **54/54** |
| `xcodebuild` | Debug with ad-hoc signing (`CODE_SIGN_IDENTITY=-`) and Release with `CODE_SIGNING_ALLOWED=NO`: both succeed with no Swift warnings. SYMROOT is in the scratchpad `ios-setup` |

**iPhone 18 Pro simulator (iOS 27.0), fixture `http://127.0.0.1:4707`:**
- `ios-00`: before the Keychain reset, the legacy APP-03 session was migrated and the game opened.
- `ios-01`: first launch after `simctl keychain reset` shows the Welcome screen.
- `ios-02`: mode choice.
- `ios-03`: server sign-in.
- `ios-04`: after a wrong password (fixture run with `FIXTURE_PASSWORD`). The field is cleared. This capture predates moving the error above the form, so the message is off-screen here; it was fixed afterwards and verified on "Enter the office password".
- `ios-05` and `ios-06`: correct password; the fixture logged `device signed in`; the game loads.
- `ios-07`: a relaunch goes straight to the game.
- `ios-08`: the device was revoked on the fixture, so the next API or socket use gets 401. The page sends `app.signedOut`, and the shell clears the token and reloads into the sign-in step with "Your sign-in is no longer valid…" and the address prefilled.
- `ios-09`: Back, then the cloud card, shows the GitHub step with "Sign in with GitHub" (the client id `Ov23li3G3aR4rgZ0lCJ3` is in the build).
- `ios-10`: the native sheet with the real GitHub user code `8557-DD69`. It was not entered, and nothing was authorised.
- `ios-11`: after Cancel, back on the GitHub step.

The app is left installed. The fixture on 4707 was stopped. Port 4610, `.agent-office` and `tests/browser-smoke.mjs` were not touched.

**Found and fixed while driving the simulator:**
- iOS zoomed the page when a field under 16px was focused.
- On touch, errors were hidden under the keyboard. Fields are now blurred on touch, and errors sit above the form.
- A wrong password now clears the password field.

## Not done / not verified

- **Cloud creation end to end.** It is blocked on the CLOUD-02 workflow, as above. No real repository or secret was created. The GitHub calls are tested only against a fake GitHub.
- **Repository listing, token check and the rest of the device flow against real GitHub.** Only the device-code request was made. The Projects step was not run in the simulator; that needs a real sign-in.
- **The "not configured" GitHub state inside the app.** The build now has a client id, so the app shows the device flow. The not-configured copy is covered by code and by the web token screen (`*-web-github-token.jpg`), but was not screenshotted inside iOS.
- **Other shells.**
  - Desktop: the Electron shell neither injects `AGENT_EMPIRE_APP` nor exposes `window.empireDesktop`. Its pages are served by its local server, so they are treated as "my own server". Its launcher (`desktop/launch.html`) is outside this lane.
  - Android: its shell is APP-04's. The transport was aligned to `window.empireAndroid`, but I didn't run it against this branch.
- **`app.openExternal` gesture rule.** It was not exercised on a device. Only "Open GitHub" in the native sheet was observed working in the simulator (the sheet itself was shown).
- **Visual review on a tablet.** The layout rules cover it, but it was not screenshotted.
- **Documentation.** `CLOUD_MODE_PLAN.md` is not in this lane. Its contract section should add the Android object name (`empireAndroid`) and the desktop object name (`empireDesktop`), both defined in `native.ts`.
