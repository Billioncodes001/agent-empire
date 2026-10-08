# APP-02 and APP-03: bundled iOS game app

Branch `claude/ios-bundled-app`, based on `37cd28f` (the mobile game shell plus APP-01 device tokens). This replaces the SwiftUI host-picker WebView companion in `mobile/ios`. The app is now a native iOS game app with:

- a native launch screen;
- native Connect and Sign-in screens;
- a full-screen landscape game loaded from the app bundle, not from a server page.

No server code changed, and no dependencies were added.

## Architecture

```
Launch screen (asset catalog: brand colour and tower mark)
  → Keychain has a session? ─ yes → Game
  → Connect (server URL) → GET /api/health → Sign in (password) → POST /api/device/login → Keychain → Game
Game: WKWebView ← empire-app://game/* served from the app's Game/ folder (a copy of dist/public)
      window.AGENT_EMPIRE_APP = {host, token, platform:'ios', deviceId}   (WKUserScript at document start)
      fetch  → https://<host>/api/…   Authorization: Bearer <token>
      socket → wss://<host>/ws        subprotocols ["empire.v1", "bearer.<token>"]
      window.webkit.messageHandlers.empire ← {type:'signedOut', reason}   (the only bridge)
```

### APP-02: client (`src/client`)

`endpoint.ts` is now the only place that knows the server base and credentials.

- **Config.** `appConfig()` reads `window.AGENT_EMPIRE_APP` once and validates it:
  - `host` must be a bare http(s) origin: no path, query or credentials;
  - `token` must be base64url, 16 to 256 characters;
  - `platform` must be `ios`, `android` or `desktop`;
  - `deviceId` is optional.

  Anything malformed means "not an app", so the web behaviour stays. The config is never read from the query string.
- **Helpers.** `apiUrl(path)`, `apiInit(init)`, `apiFetch(path, init)`, `wsUrl(query)` and `wsProtocols()`.
  - Web (no config): paths stay relative, `init` passes through unchanged, and the socket has no subprotocols.
  - App: requests go to the absolute host URL with `Authorization: Bearer`, `credentials: 'omit'` and `mode: 'cors'`. The socket offers `['empire.v1', 'bearer.<token>']`. The token is never put in a URL.
- **Call sites routed through it:**
  - `net.ts`: the socket, and the whoami probe after a close;
  - `main.ts`: continuity status;
  - `ui/execution.ts`, `ui/pull.ts` and `consultancy.ts`: their API calls;
  - `login.ts` and `claim.ts`: login and claim, which are web-only pages;
  - `ui/game-menu.ts`: sign-out.

  Static assets (models, textures, `/audio/*.wav` in `world-audio.ts`) stay relative, so the app loads them from its bundle.
- **Signing out.** When the socket closes with `4401`, or an API call gets `401`, the web keeps its `/login` redirect. In the app, `notifySignedOut(reason)` posts `{type:'signedOut', reason}` once to `window.webkit.messageHandlers.empire`. No other native capability is used.
- **Menu Sign out (app mode).** It confirms with app wording, then:
  1. revokes its own device with `DELETE /api/devices/<deviceId>`, taking the id from the config or else from `/api/whoami`;
  2. sends `signedOut('user')`.

  `beginUserSignOut()` makes sure the revoke's own `4401` is still reported as `user`.
- **PWA.** In the app, `ui/pwa.ts` doesn't register the service worker and reports the app as installed.
- **Tests.** `tests/endpoint.test.ts` has 10 tests:
  - host normalisation and rejection;
  - config validation;
  - web requests left exactly unchanged;
  - bearer headers, with the caller's own headers kept;
  - the socket URL and subprotocols, with no token in the URL;
  - a 401 posts to the bridge once;
  - `Net` in the app offers the bearer subprotocol, and a `4401` signs out without retrying or probing;
  - `Net` on the web has no subprotocols and probes `/api/whoami` with a relative path;
  - a user sign-out is still reported as `user` when it races the revoke;
  - the client and server agree on `WS_PROTOCOL` and `APP_ORIGINS`.

### APP-03: iOS (`mobile/ios`)

It's a plain Xcode project with no CocoaPods or SPM. The bundle id is `com.agentempire.mobile`, the display name is "Agent Empire", the version is 0.3.0, and the minimum iOS version is 16.

| File | Role |
| --- | --- |
| `AgentEmpireApp.swift` | App and model (Connect → Sign in → Game), orientation lock (the game is `.landscape`; the other screens allow all but upside-down), sign-out notices |
| `ConnectView.swift` | Native Connect and Sign-in screens. The layout puts the brand beside the form when a landscape phone is short. The address field has a clear button. Errors are native |
| `HostPolicy.swift` | Release: HTTPS only. Debug: also `http://localhost`, `127.0.0.1` and `::1`, and only those. A bare host means https. Paths, queries and credentials are refused |
| `OfficeAPI.swift` | URLSession with an ephemeral configuration: no cookies or cache, and redirects refused so a password never goes to another host. It probes `/api/health` and signs in with `/api/device/login` (the device name is `UIDevice.current.name`). Errors are mapped to plain messages, including an untrusted certificate. TLS uses Apple's default validation |
| `Keychain.swift` | `{host, token, deviceId}` stored as a generic password with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. It is never logged |
| `GameSchemeHandler.swift` | Serves `empire-app://game/*` from `Game/`. GET and HEAD only, with MIME types set and `nosniff`. It refuses other schemes, hosts and ports, `.`/`..` segments (encoded ones too), dotfiles, backslashes and NULs, directories, and symlinks that point outside `Game/` (the resolved path must stay under the root) |
| `GameView.swift` | The WKWebView. Details are below the table |
| `Info.plist` | `UILaunchScreen` uses the `LaunchBackground` colour and the `LaunchMark` image. The status bar is hidden at launch and the interface is dark. `NSAllowsLocalNetworking` is added only in Debug, through a plist preprocessor definition; the Release Info.plist has no ATS exception (checked) |
| `Assets.xcassets` | The app icon, rendered from `src/client/public/assets/pwa/icon-v1.svg`; the launch mark; brand colours |
| Run Script "Bundle game" | Runs `tools/sync-ios-game.sh`, which copies `dist/public` to `mobile/ios/AgentEmpire/Game` (git-ignored) and then into the app bundle. It fails clearly if `dist/public/index.html` is missing. It leaves out `sw.js`, `login.html`, `claim.html`, `consultancy.html` and source maps |
| `Checks/run.sh` | Mac-side checks for the host policy, scheme-handler traversal and MIME types: 30 checks |

`GameView.swift` configures the WKWebView as follows:

- It is non-opaque, with the brand background also behind the page and the scroll view.
- It has no scroll, bounce or pinch zoom, no link previews and no back/forward swipe.
- The SwiftUI screen uses `statusBarHidden`, `persistentSystemOverlays(.hidden)` and `defersSystemGestures(.all)`, and ignores the safe area.
- The config script is JSON-encoded and set with `Object.defineProperty` as frozen and non-writable.
- One script message handler, `empire`, is registered through a weak proxy. It accepts a message only when it comes from the main frame, the origin is `empire-app://game`, and the type is `signedOut`.
- Navigation outside `empire-app://game` is cancelled:
  - a link tap or `window.open` to an https URL shows a native "Open in Safari?" confirmation;
  - anything else is blocked.
- Camera, microphone and motion permission requests are denied.
- If the web content process ends, the game reloads.
- Web Inspector and an inset log are available only in Debug.

**Safe area.** With `contentInsetAdjustmentBehavior = .never`, the page's `env(safe-area-inset-*)` read as 0 when the page finished loading. The default adjustment is kept instead. Together with the page's `viewport-fit=cover`, the page settles at the full 874×402 in landscape with insets 0/62/20/62, measured in the simulator log about 4 s after load. The HUD, joystick and buttons then clear the Dynamic Island and the home indicator. At first paint the viewport is briefly 750×382, under the splash only.

## Build and run

```sh
# 1. Web client (the app bundles dist/public)
npm ci --ignore-scripts
npm run build:client

# 2. Unsigned simulator build, as specified. Compiles and runs, but see the Keychain note below.
cd mobile/ios
xcodebuild -project AgentEmpire.xcodeproj -scheme AgentEmpire -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' CODE_SIGNING_ALLOWED=NO SYMROOT=/tmp/ae-ios build

# 2b. Simulator build that can use the Keychain: ad-hoc "Sign to Run Locally" (no team or certificate)
xcodebuild -project AgentEmpire.xcodeproj -scheme AgentEmpire -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual SYMROOT=/tmp/ae-ios build
xcrun simctl install booted /tmp/ae-ios/Debug-iphonesimulator/AgentEmpire.app
xcrun simctl launch booted com.agentempire.mobile

# 3. Test server without the real host or paid workers (from the repo root)
FIXTURE_PORT=4705 npx tsx tools/ui-fixture.ts     # in the app: Connect → http://127.0.0.1:4705 → any password
curl -X POST http://127.0.0.1:4705/__fixture/revoke-devices   # simulates a server-side revoke (close 4401)

# Policy checks (Mac)
mobile/ios/Checks/run.sh
```

**Keychain on the simulator.** A `CODE_SIGNING_ALLOWED=NO` build has no `application-identifier` entitlement, so the simulator Keychain refuses `SecItemAdd`. After a successful server sign-in, the app then shows "couldn't store the sign-in securely". It never falls back to insecure storage, and it tells the user.

- **Fix used:** Xcode's ad-hoc "Sign to Run Locally" build (`CODE_SIGN_IDENTITY=-`, step 2b). Xcode embeds its simulated entitlements, `FAKETEAMID.com.agentempire.mobile`.
- **Tried and dropped:** re-signing with a custom entitlements file. AMFI refused to launch the app.

Device and TestFlight builds get real entitlements from the team profile.

**UI fixture additions** (`tools/ui-fixture.ts`, fixture only):

- `/api/health`.
- `/api/device/login`: any non-empty password returns a random in-memory token and device id.
- Bearer checks on `/api/*`: an unknown token gets 401.
- `/api/whoami` returns `deviceId`.
- `GET /api/devices` and `DELETE /api/devices/:id`. The DELETE closes that device's sockets with `4401`.
- CORS for `empire-app://game` only.
- The socket accepts `empire.v1` plus exactly one `bearer.<token>`, from no origin, the fixture itself, or `empire-app://game`. It only ever echoes `empire.v1`.
- `POST /__fixture/revoke-devices`.
- The log shows device ids only, never tokens.

## Evidence

- `npm run typecheck`: pass.
- `npm test`: **233/233 pass**, including the 10 new tests in `tests/endpoint.test.ts`. The existing tests pass unchanged, among them `execution-ui` (the relative-path assertions) and `device-auth`.
- `npm run build` (client and server): pass.
- `tools/mobile-ui-check.ts` (usage: `npm run build:client && FIXTURE_PORT=4705 npx tsx tools/ui-fixture.ts`, then `FIXTURE_URL=http://localhost:4705/ npx tsx tools/mobile-ui-check.ts`): **113/113 checks pass** against the extended fixture. The web touch and HUD behaviour is unchanged. Its screenshots were reverted rather than re-committed.
- `mobile/ios/Checks/run.sh`: **30/30 pass**.
- `xcodebuild` builds all succeed with no Swift warnings:
  - Debug, `CODE_SIGNING_ALLOWED=NO`;
  - Release, `CODE_SIGNING_ALLOWED=NO`;
  - Debug with ad-hoc signing.
- The unsigned Release Info.plist has no `NSAppTransportSecurity`.

Run on the booted **iPhone 18 Pro simulator (iOS 27.0)** against the fixture on 4705. Screenshots are in `docs/team/reports/ios/`, from `xcrun simctl io booted screenshot`, downscaled to 720 px wide:

| File | Shows |
| --- | --- |
| `01-launch.png` | The native launch screen: brand colour and tower mark, no white frame |
| `02-connect-portrait.png`, `02-connect.png` | Connect in portrait, and in landscape with the side-by-side layout |
| `03-connect-untrusted-cert.png` | `https://self-signed.badssl.com` gets a native "certificate isn't trusted" error. Earlier, `http://city.example.com` got "must use HTTPS" |
| `04-signin.png` | Native sign-in: server `http://127.0.0.1:4705`, secure field, the device-name note |
| `05a-game-first-frame.png`, `05b-game-splash.png` | The first game frame is brand-dark, not white. Then the web splash shows real loading progress, in landscape at 2622×1206 |
| `06-game-founder.png` | The game's first-run founder dialog, edge to edge. No browser chrome or status bar |
| `07-game-city-touch-controls.png` | The city with joystick, Use, Jump and View. The HUD is clear of the Dynamic Island. The status strip shows fixture data over the bearer WebSocket |
| `08-game-after-joystick.png` | After a real simulator touch drag on the joystick, the player has walked |
| `09`/`10`/`11-…` | The in-game Menu, then Sign out, then the app-mode confirmation text |
| `12-signed-out-connect.png` | Back on Connect with "Signed out. This device's sign-in was removed." The fixture log shows `revoked by DELETE: <id>` |
| `13-relaunch-after-signout.png` | A relaunch after sign-out opens Connect, not the game, so the Keychain entry is gone |
| `14-revoked-by-server.png` | Revoked on the server side (`/__fixture/revoke-devices`, close 4401) while in the game: back to Connect with "This device was signed out from the Empire" |

The game rotated to landscape by itself when the game screen opened: the screenshots switch from 1206×2622 to 2622×1206. It also turned to the other landscape during testing, and both landscape orientations work. No browser UI appears at any point. Debug log from the Keychain-capable build: `AEInsets +4s native={0, 62, 20, 62} page=0px 62px 20px 62px 874x402 true`, where `true` means `isSecureContext` is true for `empire-app://game`.

## Limits and not verified

- **No physical device, signing, TestFlight or App Store work.** Only the simulator was exercised. Real touch feel, frame rate on a phone and TLS against a real certificate were not tested.
- **Real server not exercised end-to-end from the app.** The app was only run against the fixture; port 4610 and `.agent-office` were not touched. The real server's bearer, CORS and WebSocket paths are covered by the APP-01 tests (`tests/device-auth.test.ts`, which pass), not by driving the app.
- **Wrong-password, rate-limit and 409 errors** are mapped in code, but weren't shown on screen: the fixture accepts any non-empty password. Empty-password and HTTPS-required errors were shown.
- **Not routed, because the file is in the world author's lane:** `src/client/world/gallery.ts` fetches `/api/image?url=…` directly. In the app that resolves to the bundle and fails, so gallery pictures won't load. The fix is one line: `import { apiFetch } from '../endpoint'`, then `apiFetch(imageUrl(url))`. The world author should apply it.
- **Web-only or cookie-only features in the app:**
  - voice and screen share: camera and microphone are denied by design;
  - worker service tunnels: SSH and cookie only;
  - the founder desk page and the web sign-in/claim pages.
- **The bundled client doesn't update with the server.** An app build ships a fixed client. After a server upgrade, the in-game "reload" reloads the bundled copy. A version-compatibility check is future work.
- **Orphan device on Keychain failure.** If the Keychain write fails after the server has issued a token, that device stays in the server's list until it is revoked in Settings.
- **The Settings device list and revoke UI** on the web is still not built, as in APP-01.
- **Android (APP-04) and desktop (APP-05) are pending.** `endpoint.ts` already accepts `platform: 'android' | 'desktop'`. The native bridge lookup is iOS-only for now, and other shells add theirs in `nativeBridge()`.
- Save-Data and reduced motion weren't re-checked in the app. The web behaviour is unchanged and covered by `mobile-ui-check`.


## Reinstall starts signed out (owner decision, 2026-10-08)

iOS keeps Keychain items when an app is deleted, so a reinstalled app used to resume its old server or cloud session. The owner chose that a reinstall starts signed out.

- `InstallMarker.claimFreshInstall` (`BridgeProtocol.swift`) checks a flag in UserDefaults, which an uninstall deletes. On the first launch of an install, `SecureStore.wipeIfFreshInstall` removes every Keychain item the app owns, including the APP-03 legacy session, before anything reads them. It runs first in `AgentEmpireApp.init`.
- `Checks/run.sh` adds 3 checks: the first launch wipes, later launches keep the session, and removing the app's defaults wipes again.
- **Simulator:** the iPhone 18 Pro had a stored session from earlier runs. After uninstalling and installing this build, the app opens on the first-launch screen (`15-reinstall-starts-signed-out.png`) instead of the city.
- **Effects:**
  - The app hasn't been released yet, so the only side effect is a one-time sign-out on development installs that predate the marker.
  - Android needs no change: `allowBackup` and `fullBackupContent` are false, so an uninstall removes its encrypted storage.
