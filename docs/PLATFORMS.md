# Platform builds

Every platform is now a **bundled game app**. The built web client (`dist/public`) ships inside each app; no server page is loaded to show the game. On first launch the shared setup asks where the Empire runs: in the cloud with the user's own accounts (a state repository in their GitHub) or on their own server. The old host-picker HTTPS companions were replaced by APP-03 (iOS) and APP-04 (Android).

These are development builds. None is signed for distribution or published to a store.

| Platform | Project | What is implemented | Verified | Not verified |
| --- | --- | --- | --- | --- |
| iOS / iPadOS | `mobile/ios` | Native launch screen and Connect/Sign-in screens. The game is served from the app bundle over the `empire-app://game` scheme. Keychain session. Full-screen landscape | Simulator builds. iPhone simulator walks with real taps ([report](team/reports/ios-app.md), [polish](team/reports/mobile-polish.md)) | Physical device, signing, TestFlight. The first tap on the founder name field shows no simulator keyboard; check this on a device |
| Android 8+ | `mobile/android` | The game is bundled in the APK and served from `https://appassets.androidplatform.net`. Immersive landscape. Adaptive icon. One native bridge | Pixel 7 / API 35 emulator walks with real taps ([report](team/reports/android-app.md)) | API < 30, a physical device, Play signing |
| macOS / Windows | `desktop/` | Electron game window with the shared setup. Secrets encrypted with OS-backed `safeStorage`. **Empire › Run on this computer…** starts a bundled local server after a confirmation | Packaged macOS app walked over CDP ([report](team/reports/desktop-app.md)) | Windows was packaged and checked but not run. Unsigned on both |

## Native bridge

The page talks to its shell through one documented bridge ([contract](team/CLOUD_MODE_PLAN.md#native-bridge-contract-one-owner-interface-lane)). The bridge covers three things:

- a secure store for the mode, the server token and cloud keys (Keychain, Android Keystore, Electron safeStorage);
- the GitHub device-code sign-in for cloud mode;
- the sign-out notice.

In server mode the shell injects `window.AGENT_EMPIRE_APP = {host, token, platform, deviceId}`. `src/client/endpoint.ts` then adds the bearer token only for that server. WebSockets carry it as the `bearer.<token>` subprotocol. The server never reads tokens from the query string. Device tokens come from `POST /api/device/login` ([APP-01](team/reports/app-device-auth.md)). They are listed and revoked with `GET`/`DELETE /api/devices`, which the game shows in **Settings › App & connection › Signed-in devices**. A malformed config means "not an app", and the page then behaves like the web client.

## Updates

Each shell checks a signed release channel. The shells verify the signature themselves and trust only the owner's pinned key in release builds; development builds also trust the public development key. A game update is downloaded, verified and switched in, with rollback if it fails to start. App updates go through the platform's own path. See [in-app updates](team/reports/in-app-updates.md), [REL-07](team/reports/rel-07-pin-key.md) and [releasing](RELEASING.md).

## Building

- **iOS:** `npm run build:client`, then open `mobile/ios/AgentEmpire.xcodeproj` in full Xcode. The "Bundle game" build phase runs `tools/sync-ios-game.sh`, which copies `dist/public` into the app. The simulator build commands are in the [iOS report](team/reports/ios-app.md).
- **Android:** `npm run build:client`, then `python3 mobile/tools/build-android.py --sdk <android-sdk> --jdk <jdk-17>`. The script generates a development signing key under the ignored `mobile/android/build/`. It never touches an existing signing identity.
- **Desktop:** run `npm ci --prefix desktop`, then `npm run desktop:package`, or `npm run package:windows --prefix desktop` for the Windows x64 ZIP. The Windows checks (PE, Node-API and archive integrity) do not run Windows code.

**Windows local terminals and CLI agents are not validated.** The worker resolver still assumes a POSIX shell. On Windows, use cloud mode or connect to a tested server.

Builds and emulator walks are platform evidence. They do not prove a paid provider run, an always-on server or store readiness. No paid calls or real credentials were used for any of them.
