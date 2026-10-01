# APP-05: the desktop app is a bundled game app

Branch `claude/desktop-bundled`, based on `2da4548`. Lane: `desktop/**`, `tools/prepare-desktop.mjs`, `tests/desktop-bridge.test.ts` and this report. Nothing changed in `src/client`, `src/server` or `src/cloud`.

## What the player sees now

The old launcher (`launch.html`), which asked for a VPS address first, is gone. The app opens one game window, and the shared setup runs in it like it does on iOS and Android:

1. **First launch.** The splash, then Welcome. The mode choice offers "Run in the cloud with my accounts" or "Connect my own server".
2. **Server path.** Sign-in uses the address and office password, the same as on the phones. It works against remote HTTPS servers and against a server on this computer's loopback.
3. **Cloud path.** It reaches GitHub sign-in. The device code appears in an in-app window with "Open GitHub", "Copy code" and "Cancel".
4. **Relaunch.** The app goes straight back into the Empire.

**"Run on this computer"** is a third way to run the Empire. It lives in the app menu (**Empire → Run on this computer…**). It is not a third card in the setup, because the setup view is the other author's lane and has no hook for it. Before starting, the app shows a confirmation dialog that states the limits:

> It runs only while the app is open. When you quit, local workers stop and nothing happens until you open the app again. … Workers stay paused until you choose where they run inside the game.

Once confirmed, the app:
- starts the bundled local server on the saved project (by default the app's `city-project` folder, or a folder you choose);
- signs the game in natively with a device token;
- opens the game.

If local workers are still running when you quit, the app asks before stopping them. The Help menu explains all three modes. A menu item is less visible than a setup card would be; see the follow-ups.

## Architecture (`desktop/`)

| File | Role |
|---|---|
| `main.cjs` | Opens one game window: `show:false` until `ready-to-show`, dark `#0c161b` background (no white flash), can go full screen (View → Toggle Full Screen), sandboxed and context-isolated with no Node integration. It also handles:<ul><li>**Navigation:** pinned to the app origin. https links the player clicked open in the system browser; everything else is refused.</li><li>**Permissions:** all denied, as before.</li><li>**Bridge:** checks each request with the bridge policy.</li><li>**Local mode** and the **migration** from the old launcher.</li><li>**Existing sync, publish and inbox actions:** now authenticate with the device token.</li></ul> |
| `bridge-policy.cjs` | The pure rules, matching Android `BridgePolicy` and iOS `BridgeProtocol`:<ul><li>method and key allowlists, and the session keys;</li><li>value rules for each key;</li><li>GitHub scopes limited to `repo`, `workflow` and `read:user` (de-duplicated; an empty list is refused);</li><li>client id format;</li><li>external links: https only, no credentials;</li><li>the GitHub verification page must be on the GitHub origin;</li><li>a 5 s gesture window;</li><li>request parsing;</li><li>building `AGENT_EMPIRE_APP`.</li></ul> |
| `app-protocol.cjs` | `empire-app://game` serves `runtime/public` and only allows GET and HEAD:<ul><li>The path is decoded once.</li><li>Requests are refused for `..`, `.` segments, backslashes, NUL bytes and leftover `%` signs.</li><li>The real path must stay inside the bundle, so symlinks can't escape.</li><li>Dotfiles, `.map` files and the web-only pages (`login`, `claim`, `consultancy`, `sw.js`) are refused, the same set as `tools/sync-ios-game.sh`.</li><li>Only extensions on a fixed MIME list are served.</li><li>Headers: `nosniff` and CORP on everything. HTML also gets a CSP: Android's policy plus `script-src 'self'; worker-src 'self' blob:`, since the build has no inline script or eval.</li></ul> |
| `secure-store.cjs` | One file encrypted with `safeStorage`: Keychain on macOS, DPAPI on Windows.<ul><li>The `basic_text` backend is refused.</li><li>Only allowlisted keys with valid values are read or written.</li><li>A file that can't be opened fails closed and is not overwritten.</li><li>`clearSession` removes `server.token`, `server.deviceId`, `github.token` and `github.login`, and keeps `mode`, `server.host` and `state.repo` (the M1 rule).</li></ul> |
| `device-flow.cjs` | GitHub device flow in the main process:<ul><li>requests a code, then polls; handles `authorization_pending`, `slow_down`, `expired_token` and `access_denied`, and cancelling via AbortSignal;</li><li>calls `GET /user` for the login;</li><li>errors are `<code>: <text>` with Android's codes;</li><li>persists nothing.</li></ul> |
| `preload.cjs` | Exposes exactly two things, and only when `location.origin` is `empire-app://game` in the top frame:<ul><li>`AGENT_EMPIRE_APP`, a synchronous config from main that is set before any page script runs;</li><li>`empireDesktop.postMessage`.</li></ul>Answers come back through the page's own `__empireNative.resolve/reject`, as JSON literals via `webFrame.executeJavaScript`. |
| `device.html` / `device-preload.cjs` | The modal code window, `default-src 'none'`, with exactly three IPC calls. Each one checks that its sender is that window. |
| `credentials.html` / `credentials-preload.cjs` | The existing provider-keys vault (`credential-vault.cjs`, unchanged). It is now reachable only in local mode (Empire → Provider keys for this computer…), and saving is refused in any other mode. |

**Origin.** The desktop uses `empire-app://game`, the same origin as the iOS app. That origin is already in the server's `APP_ORIGINS` (`src/server/server.ts:135`) and in the UI fixture, so **no server change was needed**. Bearer CORS, the device login and the bearer WebSocket all worked unchanged against both the fixture and the bundled server.

**`src/client/native.ts` was not edited.** Its existing desktop branch (`window.empireDesktop.postMessage(request)`) already works with the object exposed through `contextBridge`.

### Bridge behaviour

| Call | Desktop |
|---|---|
| `secure.get/set/delete` | Use the store above. A request is refused before it reaches storage if the key isn't allowed (for example `anthropic.key`) or the value is invalid. `server.host` accepts `https` or `http` on loopback only (`127.0.0.1`, `localhost`, `[::1]`). Calling `secure.set('server.host', other)` while running locally leaves local mode |
| `github.deviceFlow` | The client id comes from the page and is validated; scopes are checked against the policy. Only one flow runs at a time. Closing the code window or pressing Escape cancels it ("GitHub sign-in was cancelled.") |
| `app.signedOut` | Clears the session keys and reloads with a one-shot `signedOut` reason. The setup then shows the server step with the address prefilled and the notice.<ul><li>In local mode, `user` leaves "This computer" and returns to Welcome.</li><li>Any other reason makes the app sign in natively again.</li></ul> |
| `app.openExternal` | https only and no credentials. It opens directly within 5 s of a real mouse or key input (`webContents` `input-event`), and one gesture opens one page. Otherwise the app asks "Open this page in your browser?" |

### Local mode ("This computer")

- `local-host.cjs` is unchanged except for the new `localDeviceSession`. The local server still binds to loopback with a random in-memory office password, `requireExecutionSetup: true` and no background services.
- The device token is issued for each launch and kept in memory only. The changed password makes old tokens invalid by design (APP-01 key rotation), and the server drops the stale entries.
- Stored settings:
  - `mode=server` and `server.host` go in the secure store;
  - `runMode: 'local'`, the project and the port go in `connection.json`.

  The same port is reused when it's free, so the address stays stable.
- "Change setup…" in the menu forgets this computer's setup after a confirmation. It refuses while local workers run. A local project is never moved or deleted.

### Migration from the old launcher

This runs once, marked by `connection.json.shell = 2`:
- A former **local city** (`lastMode: 'local'`) opens again as "This computer" with the same project and port. Verified in `mac-12`.
- A former **remote host** has its address carried over into the server step, prefilled. Its old cookie session can't become a device token, so the player signs in once. Verified in `mac-13`.
- `provider-credentials.enc` is kept and still serves local mode.
- **Provider keys in cloud mode** never touch it: they go only to GitHub sealed secrets, through the shared setup.

## Evidence

| Check | Result |
|---|---|
| `npm test` | **355/355**: the 345 from before plus 10 new in `tests/desktop-bridge.test.ts`. `desktop-runtime` and `desktop-vault` are unchanged and pass |
| `npm run typecheck` | pass |
| `tests/desktop-bridge.test.ts` | Covers:<ul><li>**policy:** allowlists, 11 accepted and 21 refused values, scopes, client id, external links, verification URL, app origin (including Node's opaque origin for custom schemes), gesture window, request parsing, page config;</li><li>**protocol:** MIME, encoded traversal, symlink escape, excluded pages, dotfiles, maps, foreign hosts, CSP, 405;</li><li>**secure store:** encryption, allowlist, M1 sign-out set, `basic_text` refused, tampered entries filtered, corrupt file fails closed;</li><li>**device flow:** pending, `slow_down`, success with login, the scope sent, cancel, denied, expired, foreign verification URL, offline;</li><li>**preload:** exposed nothing for 4 foreign origins or in a subframe; exactly two globals for the app; malformed ids dropped; resolve/reject scripts;</li><li>**package:** the file list matches what `main.cjs` and the HTML load, and the old launcher is gone.</li></ul> |
| `npm run desktop:package` | pass: `release/Agent Empire-darwin-arm64` (asar) |
| `npm run package:windows --prefix desktop` | pass. PE x64 and Node-API PTY checks, and `unzip -t`. SHA256 `9b08d6eadd9a9cf56ed171ee0c6d088436eda430eeb1b5565f93358e67558e44`. `prepare-desktop.mjs` now copies an explicit `DESKTOP_FILES` list and fails if `runtime/public/index.html` is missing |

**Packaged macOS app, driven through `--remote-debugging-port` and playwright-core `connectOverCDP`:**
- Each run used an isolated `--user-data-dir` under the scratchpad and `--use-mock-keychain`, so it neither prompted the real Keychain nor touched `~/Library/Application Support/Agent Empire`.
- `main.cjs` honours `--user-data-dir`, including the single-instance lock.
- Fixture: `FIXTURE_PORT=4714 FIXTURE_PASSWORD=fixture-office`.

Screenshots are in `docs/team/reports/desktop/`:

| Shot | What it shows |
|---|---|
| `mac-01-welcome`, `mac-02-mode-choice` | First launch on a fresh profile, straight into the shared setup with no launcher |
| `mac-03-server-wrong-password` | "Wrong password." from the fixture |
| `mac-04-server-game` | The correct password; the fixture logged `device signed in`, and the game opens at the founder screen |
| `mac-05-server-relaunch-straight-to-game` | Quit and relaunch go directly into the game. The config has `mode:'server'`, the host, the token and the device id |
| `mac-06-signed-out-after-revoke` | Fixture devices were revoked (`whoami` → 401), then `app.signedOut('revoked')` went through the bridge. The session keys were cleared, and the reload shows the server step with the address and "This device was signed out…" |
| `mac-07-cloud-github-step` | Cloud card, then the GitHub step |
| `mac-08-github-device-code`, `mac-08b` | **Real github.com** with client id `Ov23li3G3aR4rgZ0lCJ3` and scopes `repo workflow`. GitHub returned user code `0509-7D33`, which was shown only: never entered, nothing authorised |
| `mac-09-github-cancelled` | After Cancel, the code window closes and "GitHub sign-in was cancelled." appears |
| `mac-10-this-computer-game` | Empire → Run on this computer… The bundled server started on `127.0.0.1:52492`, signed in natively, and the game opened with `local:true`. Founding setup was **not** completed |
| `mac-11-this-computer-relaunch` | Relaunch restarts the local server on the same port and goes straight into the game |
| `mac-12-migrated-local-city` | Old launcher `connection.json` with `lastMode: 'local'` resumes as "This computer" on port 4799 |
| `mac-13-migrated-remote-host-prefilled` | Old `lastMode: 'remote'` gives the server step with `http://127.0.0.1:4714` prefilled |

**In-app security probe** (packaged, from the game page): every one of these was refused or absent:
- `secure.set('anthropic.key')`
- `secure.set('server.host', 'http://evil.example')`
- the device flow with `admin:org`
- `openExternal('http://…')`
- an unknown method
- a `%2e%2e` traversal fetch (404)
- `/login.html` (404)
- `require`, `process` and `module` (all undefined)
- the bridge inside an iframe (undefined)

The page had no console errors except the deliberate wrong-password 401.

**How the native dialog was driven in testing.** The confirmation dialog for "Run on this computer" is native, so CDP can't click it. In testing, `--inspect` on the packaged main process replaced `dialog.showMessageBox` with an answer of "Run on this computer" and then clicked the real menu item. The dialog text quoted above was captured from that call. This is test scaffolding outside the app; no test hook ships in the code.

Stopped at the end: the fixture on 4714, every app instance and its local servers. Port 4610, `.agent-office` and the real app profile were not touched. No paid work was queued.

## Not done / not verified

- **Windows runtime.** Only the package and its checks were run; there is no Windows host. Not run on Windows:
  - DPAPI `safeStorage`;
  - the custom protocol;
  - the device-code window;
  - local mode with Git for Windows.
- **The "Run on this computer" dialog** was answered programmatically, as above. A person clicking it, and the "Choose project folder…" picker, were not exercised.
- **`app.openExternal`.** The gesture path and the "Open in browser?" fallback dialog were not exercised interactively. Neither was "Open GitHub" in the code window, which was deliberately not clicked.
- **Sync, publish and inbox with bearer tokens.** These are code-reviewed only; no sync artifact was published or imported in this run.
- **The real macOS Keychain.** All runs used `--use-mock-keychain`. A first real launch of an unsigned build may show a Keychain access prompt for "Agent Empire Safe Storage", especially where the old app created that item.
- **Signing and notarization.** The packaged app is unsigned and has no icon. Release work is unchanged.

## Follow-ups for other lanes

1. **Setup (src/client).** A discoverable "This computer" option needs a small hook in `src/client/setup/view.ts`. One option is to add `localAvailable: true` to `AGENT_EMPIRE_APP` on desktop, which would show a third card or a "Use this computer" button on the server step. That would also need a bridge method such as `app.runLocal`. The contract (`CLOUD_MODE_PLAN.md`) would have to add it, and the desktop side would then call the existing `runOnThisComputer()`. Until then it is in the menu only.
2. **Docs.**
   - `docs/PLATFORMS.md` still describes the old desktop launcher ("open the launcher", "Provider credentials"). It should say that the setup runs first and that "Run on this computer" is in the menu.
   - `CLOUD_MODE_PLAN.md`'s contract section should name `window.empireDesktop` and the `empire-app://game` desktop origin.
