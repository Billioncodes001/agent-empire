# Platform builds

These are development builds. They have not been published to an app store or signed with a distribution identity.

| Platform | What is implemented | Validation boundary |
| --- | --- | --- |
| macOS desktop | Bundled city, local server, protected credentials, cloud/remote controls and the existing isolated Git importer | Existing native desktop checks; local workers require their own installed CLI/authentication |
| Windows x64 desktop | Separate Electron ZIP packaging with Windows x64 Node-API PTY dependencies | PE, dependency and ZIP checks; actual Windows launch remains unverified on this macOS build host |
| Android 8+ | Native HTTPS host companion, touch WebView, landscape/portrait support | APK compilation/signature, policy tests and isolated Android 35 install/startup diagnostics passed; interactive acceptance remains unverified |
| iOS/iPadOS 16+ | SwiftUI/WKWebView host companion and Xcode project | Source/project only: full Xcode and the iOS SDK are unavailable here; no IPA or device validation |

## Windows ZIP

From the repository root, with Node 22.12+, npm, `zip` and `unzip` installed on the build host:

```sh
npm ci --ignore-scripts
npm ci --prefix desktop
npm run build
npm run package:windows --prefix desktop
```

The target stage is `release/staging/win32-x64/desktop`; output is `release/windows/Agent Empire-win32-x64.zip`, with SHA256 and verification JSON alongside it. It does not replace the macOS application or `desktop/runtime`.

The preparation script installs locked production dependencies using npm's `--os=win32 --cpu=x64` overrides. It checks that both PTY `.node` modules export the Node-API registration entrypoint and that the modules, ConPTY DLL/helper and Electron executable are Windows x64 PE files. The ZIP is integrity-tested. Those checks do not execute Windows code.

Extract the entire ZIP before opening `Agent Empire.exe`. Git for Windows must be installed to create/open a local city project. The city assets and server are bundled. Provider-managed cloud execution and authenticated remote-host connections follow the existing explicit setup/paid-confirmation gates.

**Windows local terminal and CLI-agent execution is not supported by this release's validation.** The legacy worker resolver/fallback still assumes a POSIX shell and does not handle Windows executable suffixes completely. Do not infer local worker support from the bundled PTY binaries. Use provider-cloud tasks or connect to a tested host until this is ported and tested. No paid provider calls were made to validate the ZIP.

Before promoting the ZIP from a development artifact, run it on a clean Windows x64 machine: open the launcher, create an empty local city using installed Git, confirm founding tasks remain paused, reopen it to verify saves, check protected credential storage availability without using production secrets, connect to a disposable authenticated HTTPS fixture and verify shutdown. Windows signing and installer packaging remain separate release work.

## Android companion

The application opens an existing Agent Empire HTTPS host. It uses that host's normal authenticated login page. It does not collect provider keys, include a Node server, import Git bundles, dispatch work on close, or provide an offline playable world. Closing the companion leaves host/provider jobs under their existing lifecycle rules. The host must be reachable to inspect or change them.

Only the selected HTTPS origin can navigate inside the WebView. Cleartext, invalid certificates, file/content access, native JavaScript bridges, popup windows, media/location permissions and downloads are blocked. Login cookies live in the operating system's private WebView storage; only the non-secret host origin is written to app preferences. “Forget saved host and sessions” clears companion cookies and browser storage. Android cloud backup is disabled. Rotation preserves the connection; landscape provides more room for the game HUD.

The Android project is `mobile/android`. It uses Java/platform APIs without app-library dependencies. For Android Studio/Gradle builds, configure a local Gradle 8.9 distribution with JDK 17 and SDK 35 (a Gradle wrapper is not bundled), or use the tested direct SDK build:

```sh
python3 mobile/tools/build-android.py --sdk /path/to/android-sdk --jdk /path/to/jdk-17
```

The script requires platform `android-35` and build-tools `35.0.0`, runs the host-origin policy tests, compiles resources/Java/Dex, aligns the APK and verifies its signature. It installs no system packages and accepts no SDK licenses. It generates a development signing key under ignored `mobile/android/build/portable/`; it never accesses an existing signing identity. Output: `release/android/Agent-Empire-android-development.apk` and its SHA256 file. This APK is for sideloaded testing, not Google Play publication. Retain your own protected release signing identity when planning distribution; none is configured here.

For a real phone, an existing host needs a certificate trusted by the phone and a reachable HTTPS address. A localhost HTTP server or a self-signed certificate does not satisfy that requirement. This task does not provision hosting, purchase infrastructure or install certificates on a user's device.

## iOS source project

Open `mobile/ios/AgentEmpire.xcodeproj` in full Xcode. Select the `AgentEmpire` target and an iOS simulator first; no signing account is required for a simulator build:

```sh
xcodebuild -project mobile/ios/AgentEmpire.xcodeproj -target AgentEmpire \
  -configuration Debug -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build
```

The shell uses WKWebView with the same host-only HTTPS navigation and no native script bridge. App Transport Security remains enabled, TLS trust uses Apple's default handling, and media permissions are denied. Sessions remain in the app's private WebKit store and can be cleared from its host selector. The phone does not run the city server or local workers.

This machine has Command Line Tools rather than full Xcode. Project syntax can be checked, but UIKit/WebKit application compilation, simulator execution, iOS signing, an IPA, TestFlight and App Store delivery are unverified and not performed. The existing local Swift toolchain also reports a duplicate SwiftBridging module; this is not evidence of an application build. An app icon catalog, device testing and signing/distribution configuration remain release work.

## Evidence for this build

The Windows x64 ZIP passed PE/Node-API/dependency checks and archive integrity testing. Its `index.html` and referenced JavaScript bundle are checked against the final client build byte-for-byte. The adjacent artifact verification record identifies the archived bundle and its SHA256. No Windows runtime is available on this build host.

The Android origin-policy harness passed. Both the initial build and a rebuild containing deliberate stale class/source/Dex sentinels passed; the sentinels were removed before compilation. APK alignment and v2/v3 signature checks passed. It installed on a new isolated Android 35 ARM64 emulator; Activity startup returned `Status: ok`, the app process was present and the AndroidRuntime error log was empty. Existing emulator profiles were untouched.

CUA could not bind the SDK emulator's unbundled native window. No input, screenshots or UI-hierarchy automation was substituted. Touch, rotation, landscape layout, certificate rejection and authenticated host login therefore still need interactive device acceptance. Host-policy unit tests and startup diagnostics do not replace those checks. No real host credentials or paid jobs were used.

Exact artifact hashes are recorded in the generated artifact sidecars and round handoff. Successful compilation or Windows PE checks do not establish successful paid execution, remote host availability, or store readiness.

## Official references

- [Electron Packager target platforms and packaging](https://github.com/electron/packager)
- [npm OS/CPU dependency selection](https://docs.npmjs.com/cli/v10/commands/npm-install/)
- [Android WebView integration](https://developer.android.com/develop/ui/views/layout/webapps/webview)
- [Android WebView file-access risks](https://developer.android.com/privacy-and-security/risks/webview-unsafe-file-inclusion)
- [AGP 8.7 / Gradle 8.9 / JDK 17 compatibility](https://developer.android.com/build/releases/agp-8-7-0-release-notes)
- [WKWebView](https://developer.apple.com/documentation/webkit/wkwebview) and [App Transport Security](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity)
