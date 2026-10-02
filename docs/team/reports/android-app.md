# APP-04: bundled Android game app

Branch `claude/android-bundled-app`, based on `08bb4a4` (cloud mode plan with the native bridge contract). This replaces the old HTTPS host-picker WebView companion in `mobile/android`. The app is now a landscape game app:

- The game is the built web client, bundled in the APK. No server page is loaded.
- It runs full-screen and immersive, with a dark launch screen and an adaptive launcher icon.
- It exposes one native bridge, which implements the contract in [CLOUD_MODE_PLAN.md](../CLOUD_MODE_PLAN.md#native-bridge-contract).

No `src/` or `mobile/ios` files changed. No dependencies were added: the app uses only platform APIs, with no androidx.

## Architecture

```
Launch: theme window background (brand ink + tower mark); Android 12+ system splash (same mark)
  → native overlay (mark, AGENT EMPIRE) until the page's first paint → the page's own splash with progress
Game: WebView ← https://appassets.androidplatform.net/*  served by GameAssets from APK assets/game (= dist/public)
      index.html gets <script src="/__agent-empire/app-config.js"> as the first element of <head>
        → window.AGENT_EMPIRE_APP = {platform:'android', appVersion, bridge:'empireAndroid', host?, token?, deviceId?}
      window.empireAndroid.postMessage(JSON)  → NativeBridge (the only native object)
        ← window.__empireNative.resolve(id, result) / reject(id, message)
      fetch/WebSocket → the Empire server or api.github.com directly (CORS; the server allows this origin with a bearer)
```

| File (`mobile/android/app/src/main/java/com/agentempire/mobile/`) | Role |
| --- | --- |
| `MainActivity.java` | The single Activity (`sensorLandscape`, `singleTask`):<br>- immersive mode: bars hidden, and they show only transiently when the player swipes (`WindowInsetsController`; `IMMERSIVE_STICKY` below API 30);<br>- keeps the screen on;<br>- draws into cutouts (`always` on API 30+, `shortEdges` on 28–29);<br>- sets up the WebView and its navigation rules, and the launch overlay;<br>- Back toggles the in-game menu;<br>- rebuilds the WebView if its renderer is lost;<br>- has the debug-only test hooks |
| `GameAssets.java` | Asset loader that replaces androidx `WebViewAssetLoader`:<br>- GET/HEAD only;<br>- serves the config script with `no-store`;<br>- injects that script into HTML, adding a `frame-src 'self'` / `object-src 'none'` CSP header;<br>- `nosniff`;<br>- immutable caching for `/assets/*`;<br>- 404 for anything it doesn't serve and 405 for other methods |
| `AssetPolicy.java` | Pure policy for the app origin, tested on the JVM:<br>- `isAppOrigin` checks the exact scheme and authority, and rejects userinfo, other ports and look-alike hosts;<br>- `assetPath` decodes strictly and refuses `.`/`..`/empty segments, hidden files, `\`, encoded `/` `\` NUL, control characters and invalid UTF-8;<br>- the MIME table;<br>- `<head>` injection |
| `NativeBridge.java` | The single `@JavascriptInterface` (see below) |
| `BridgePolicy.java` | Pure policy, tested on the JVM:<br>- method and key allowlists, and the session keys;<br>- limits on id, client id, scope and value;<br>- `externalUrl` (https only, no credentials);<br>- the verification URL must be on the GitHub origin;<br>- the gesture window |
| `SecureStore.java` | Secure storage without androidx: AES-256-GCM with a non-exportable Android Keystore key (`agent-empire.secure.v1`). The key name is bound as AAD. Values are stored as `v1:base64(iv‖ct)` in a private SharedPreferences file. An unreadable entry is deleted and reported as absent |
| `GitHubDeviceFlow.java` | Native device flow with `HttpURLConnection`: it refuses redirects, caps responses at 64 KB and never logs the token. It shows a native dialog with the code, "Copy code", "Open GitHub" (system browser) and "Cancel" |
| `ServerPolicy.java` | Server address validation, kept from the old `HostPolicy`:<br>- no path, query, fragment, credentials or bad port;<br>- release accepts HTTPS only;<br>- debuggable builds also accept `http://10.0.2.2`, `127.0.0.1` and `localhost` |

**Resources**
- `GameTheme`, in three versions:
  - `values`: the ink window background with the mark;
  - `values-v28`: adds the `shortEdges` cutout mode;
  - `values-v31`: adds the `always` cutout mode and `windowSplashScreen*`.
- Adaptive icon (`mipmap-anydpi-v26/ic_launcher.xml`): a radial "night" background, plus foreground and monochrome vectors generated from the web splash tower mark.
- `splash_icon.xml` sizes that same mark for the Android 12+ splash.

**Security settings**
- Manifest: `allowBackup=false`, `fullBackupContent=false`, and `dataExtractionRules`, which exclude everything from cloud backup and device transfer.
- Release: `network_security_config` is HTTPS-only with system CAs. The release WebView uses `MIXED_CONTENT_NEVER_ALLOW`, and non-https subresources are blocked in code too.
- Debug: `src/debug/res/xml/network_security_config.xml` is linked as an aapt2 overlay into the debug APK only. It allows cleartext solely to `10.0.2.2`, `127.0.0.1` and `localhost`. `debug-overrides` can't express cleartext rules, which is why this is an overlay.

**WebView settings**
- File and content access are off.
- Multiple windows are off, and `onCreateWindow` returns false.
- Permissions (camera, microphone and so on) are denied.
- There is no file chooser and no downloads.
- Cookies are off (the app uses bearer tokens), and third-party cookies are off.
- There are no service workers (a `ServiceWorkerClient` returns 403).
- SSL errors are cancelled, never proceeded.
- HTTP auth is cancelled.

**Navigation**
- The main frame can only be `https://appassets.androidplatform.net`.
- Other main-frame loads are refused in `shouldInterceptRequest` (403, which also catches POSTs and redirects) and in `shouldOverrideUrlLoading`.
- A link the player actually tapped (`hasGesture()`), such as "Open on GitHub ↗", opens in the system browser if it is https. Script-driven navigation goes nowhere. This is a deliberate usability addition, and it uses the same https-only, gesture-required rule as `app.openExternal`.

## Native bridge (implements the CLOUD_MODE_PLAN contract)

Transport: `window.empireAndroid.postMessage(JSON.stringify({id, method, params}))`. That object has exactly one method.

- **Answers.** The page gets `window.__empireNative.resolve(id, result)` or `reject(id, message)`. The page owns `__empireNative`. The `id` comes back as the same JSON type it was sent as: a number stays a number. Ids must match `[A-Za-z0-9_.:-]{1,64}`.
- **Origin check.** Every call is re-dispatched to the UI thread. `WebView.getUrl()` must be on the app origin, both when the call arrives and again before any answer is delivered. Otherwise the call is dropped with no answer, so a token is never handed to another document.

| Method | Params → result | Notes |
| --- | --- | --- |
| `secure.get` | `{key}` → string or `null` | Keys: `mode`, `server.host`, `server.token`, `server.deviceId`, `github.token`, `github.login`, `state.repo`. Anything else gets "Key not allowed" |
| `secure.set` | `{key, value}` → `true` | The value must be a string of at most 8192 characters |
| `secure.delete` | `{key}` → `true` | |
| `github.deviceFlow` | `{clientId, scopes:[…]}` → `{token, login}` | The client id comes from the page and isn't hard-coded. It runs one flow at a time and persists nothing.<br>Errors are `"<code>: <text>"`, where code is one of `cancelled`, `expired_token`, `access_denied`, `network`, `github_error` or `invalid_request`.<br>`authorization_pending` keeps polling. `slow_down` uses GitHub's new interval, or adds 5 s.<br>`login` is null if `GET /user` fails |
| `app.signedOut` | `{reason}` → `true` | Clears `server.token`, `server.deviceId`, `github.token` and `github.login`. Keeps the preferences `mode`, `server.host` and `state.repo`. Then reloads the game, so the injected config no longer carries credentials |
| `app.openExternal` | `{url}` → `true` | https only, no credentials, not the app origin. It needs a real touch or key release within the last 5 s, and one gesture opens one page |

- **APP-02 compatibility.** A stored session (`mode` absent or `server`, a valid `server.host` and a token-shaped `server.token`) is injected as `host`/`token`/`deviceId`. The current client (`src/client/endpoint.ts`) then talks to the server with its bearer, just as on iOS.
- **Legacy message.** `{type:'signedOut', reason}` without an id is accepted as fire-and-forget.
- **Needed in `src/` (interface lane).** `endpoint.ts` `nativeBridge()` only looks up `webkit.messageHandlers.empire`. The Android branch it needs is `window.empireAndroid.postMessage(JSON.stringify(msg))`. Until then, a 401 or 4401 in the current client doesn't reach the Android shell.

### Temporary debug-only test hooks

These exist until CLOUD-03 lands, and are ignored unless the APK is debuggable (verified: the release APK ignored `ae.debug.login`, and the fixture recorded no sign-in).

```
adb shell am start -n com.agentempire.mobile/.MainActivity --es ae.debug.login http://10.0.2.2:4706 [--es ae.debug.password pw]
    # native POST /api/device/login → stores mode=server, server.host, server.token, server.deviceId → reloads
adb shell am start -n com.agentempire.mobile/.MainActivity --es ae.debug.github http://10.0.2.2:4717   # fake GitHub; any invalid value resets to github.com
adb shell am start -n com.agentempire.mobile/.MainActivity --ez ae.debug.clear true                     # delete every secure key
```

The debug build also enables WebView remote debugging. Every bridge test below was driven from the page this way.

## Build and run

```
npm run build:client        # writes dist/public; the script stops with a clear message if it is missing
python3 mobile/tools/build-android.py --sdk /opt/homebrew/share/android-commandlinetools \
  --jdk /opt/homebrew/Cellar/openjdk@17/17.0.20.1/libexec/openjdk.jdk/Contents/Home [--variant release|debug|all] [--game DIR]
```

The script:
1. copies the game to `mobile/android/build/portable/assets/game`, leaving out hidden files;
2. compiles and runs `mobile/android/tests/PolicyTest.java` on the JVM;
3. compiles resources once and links both variants (the debug one with `--debug-mode` and the overlay);
4. runs javac (Java 8 bytecode against android-35), then d8 (`--min-api 26`), then zipalign;
5. signs with the local development key under the ignored `build/`;
6. runs `apksigner verify` and `zipalign -c`;
7. checks that the APK contains `assets/game/index.html`, `classes.dex` and every game file;
8. writes SHA-256 files.

The outputs are `release/android/Agent-Empire-android-{release,debug}.apk` (about 24 MB each, holding 69 game files, 32 MB uncompressed). `mobile/android/app/build.gradle` points its assets at the staged folder, for anyone using Android Studio. That Gradle build was not run.

## Evidence

**Build.** Both variants built. `apksigner verify` passed for both (v2 and v3). The manifest dump shows:
- release: no `debuggable`, and its network config has no cleartext domains;
- debug: `debuggable=true`, and its network config has the 3 test domains;
- both: `screenOrientation=sensorLandscape`, `allowBackup=false`.

**Unit tests.** `PolicyTest` passed all **295 checks**:
- origin look-alikes;
- traversal and encoding attacks on paths;
- MIME types;
- `<head>` injection (including `<header>`);
- server addresses in release and debug;
- the bridge allowlists and limits;
- a real-data check that every one of the 69 bundled files resolves to its own asset path with a known MIME type.

**Emulator.** Run on an isolated AVD in the scratchpad: `system-images;android-35;google_apis;arm64-v8a`, pixel_7, headless on port 5590, 3 GB data partition, with the "tall" display-cutout overlay enabled. The fixture ran on port 4706; see the fixture note under Limits. Screenshots in `docs/team/reports/android/` were taken with `adb exec-out screencap`, downscaled to 960 px:

| File | Shows |
| --- | --- |
| `01-launch-system-splash.png` | Android 15 system splash: the tower mark on brand ink |
| `02-launch-native-overlay.png` | The native overlay (mark, AGENT EMPIRE, tagline) in landscape |
| `03-launch-web-splash.png` | Hand-off to the page's own splash with its progress bar |
| `04-launch-burst-sheet.png` | Burst of 12 screenshots from a cold start: no white frame appears at any point |
| `05-game-founder-cutout-inset.png` | The founder dialog, clear of the left cutout. Over DevTools: `env(safe-area-inset-*)` = `0px 0px 0px 48px`, `isSecureContext` = true, origin `https://appassets.androidplatform.net`, 915×412 CSS px |
| `06-game-fullscreen-touch-controls.png` | The city edge to edge with no system bars. Joystick, Use, Jump and the view toggle are visible. The HUD shows fixture data over the bearer WebSocket |
| `07-back-opens-menu.png`, `08-back-closes-menu.png` | `KEYCODE_BACK` opens the in-game menu, and pressing it again closes it. The activity stays resumed throughout |
| `09-…transiently.png`, `10-bars-hidden-again.png` | A swipe from the top edge shows the bars transiently, then they hide again |
| `11-device-flow-dialog-fake-github.png` | The native "Sign in with GitHub" dialog, against the local fake GitHub |
| `12-device-flow-copy-code.png` | "Copy code" → "Code copied…" status. The dialog stays open |
| `13-device-flow-real-github-user-code.png` | **Real github.com** with the owner's public client id `Ov23li3G3aR4rgZ0lCJ3` and scopes `repo workflow`. GitHub returned user code `7AFE-3EF2`, then Cancel was pressed. The code was never entered and nothing was authorized |
| `14-open-github-system-browser.png` | "Open GitHub" hands off to Chrome, outside the app. Its first-run screen was left untouched |
| `15-signed-out-reloaded.png` | After `app.signedOut`: the session keys are gone, `mode`/`server.host`/`state.repo` are kept, and the reloaded config has no host or token. The current client shows "Reconnecting…"; CLOUD-03 will show setup here |
| `16-renderer-killed-recovered.png` | The WebView renderer was killed (`kill -9` under `adb root`). The app process survived, the WebView was rebuilt and the game reloaded |
| `17-release-build-running.png` | The release APK running. `ae.debug.login` was ignored, and there is no host in the config |

`bridge-evidence.txt` has the raw results. Summary:

- **Round-trip.** `secure.set` then `secure.get` returned `"ada/agent-empire-state"`.
- **Persistence.** The value survived a force-stop and cold start, then `secure.delete` → `null`. On disk, `shared_prefs/agent_empire_secure.xml` holds only `v1:<base64>` ciphertext.
- **Rejected calls:**
  - key not in the allowlist (`openai.key`);
  - unknown method;
  - a non-string value;
  - a value longer than 8192 characters;
  - `app.openExternal` without a tap;
  - an `http:` URL;
  - a malformed client id.
- **Numeric id.** A numeric id comes back as a number.
- **Foreign iframe.** Blocked by CSP (`frame-src`).
- **Script navigation to `https://example.com`.** Blocked; the page stays on the game.
- **`app.openExternal` right after a real tap.** Returned `true` and Chrome opened.
- **Device flow against the fake GitHub:**
  - success after pending, pending, `slow_down` (the interval went from 1 s to 3 s), pending → `{login: "fake-user", token: <38 chars>}`;
  - `access_denied`;
  - `expired_token`;
  - Cancel → `cancelled`.

  The fake's request log shows form posts with `Accept: application/json` and the device-code `grant_type`.

## Limits and not verified

- **No physical device and no Play signing.** Everything ran on the emulator with swiftshader. Frame rate and touch feel on a phone, and release signing or Play upload, were not tested. Both APKs are signed with the local development key.
- **The Android 8–11 fallback launch path was not run.** Only API 35 was emulated. The `IMMERSIVE_STICKY` path, the `shortEdges` cutout mode and the pre-31 launch background are built but unverified.
- **The cutout isn't drawn in screenshots.** `screencap` doesn't draw the emulated notch. The evidence is the 48 px safe-area inset the page reads, and the HUD being offset by it.
- **Not tested in the app:**
  - rotating between the two landscape orientations;
  - hardware keyboard play;
  - reduced motion;
  - Save-Data.

  The web behaviour is unchanged.
- **The fixture needed the Android origin.** `tools/ui-fixture.ts` (backend lane) allows only the iOS origin `empire-app://game`, so the committed fixture would refuse CORS and the WebSocket from `https://appassets.androidplatform.net`. Testing used a scratchpad copy whose only change was that origin. The fixture should accept both. The real server already does (`APP_ORIGINS` in `src/server/server.ts`, APP-01).
- **Setup flow not built.** Until CLOUD-03 lands, a signed-out app shows the game in plain web mode ("Reconnecting to the office host"). The mode choice and GitHub sign-in UI belong to CLOUD-03, and signing in currently needs the debug hook.
- **Needed in `src/`.** The Android branch in `nativeBridge()` (see "Native bridge" above) belongs to the interface lane.
- **Mixed content in debug.** The debug build allows mixed content so that the https app page can reach the `http://10.0.2.2` fixture. Chromium logs deprecation warnings for this. Release is `NEVER_ALLOW`.
- **DevTools socket on the emulator.** The release APK's WebView still exposed a DevTools socket there, because Google APIs emulator images are `userdebug` builds, which make every WebView debuggable. The app calls `setWebContentsDebuggingEnabled(false)` for release. That can only be confirmed on a `user`-build device.
- **Game version is fixed per APK.** The APK ships the client it was built with. Server/client version checks are future work, as on iOS.
- **Docs outside this lane are stale.** The Android section of `docs/PLATFORMS.md` still describes the host-picker companion.
