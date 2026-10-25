# Free distribution

How Agent Empire reaches players without paid signing or store accounts (FREE-03). Everything ships from **GitHub Releases of the public repository** `Billioncodes001/agent-empire`. The paid Apple and Google paths in `release.yml` stay optional and switch on only when their secrets exist ([RELEASING.md](RELEASING.md)).

Release assets of a private repository need a GitHub login to download, so the in-app update feeds (`…/releases/latest/download/…`) work for everyone only once the repository is public.

| Platform | Free route | Updates |
| --- | --- | --- |
| macOS | Ad-hoc signed `Agent-Empire-Mac-Apple-Silicon.dmg` / `Agent-Empire-Mac-Intel.dmg` (the release notes say it is not Apple-signed) | The app shows "Update available" and opens the release page to download |
| Windows | Unsigned `Agent-Empire-Windows-Setup.exe`; SignPath Foundation later; winget | Download prompt while unsigned; in-place once signed |
| Android | `Agent-Empire-Android.apk` on Releases; Obtainium; IzzyOnDroid | Obtainium or the in-app prompt |
| iPhone, iPad, any browser | The web app (PWA) from your own office server over HTTPS | Always current: it loads from your server |

File names carry no version or signing label (docs/RELEASING.md, "What each release contains"). Stable releases can therefore be linked permanently, for example `https://github.com/Billioncodes001/agent-empire/releases/latest/download/Agent-Empire-Android.apk`; pre-releases are linked through their release page.

## macOS: ad-hoc signed builds

Without a Developer ID certificate, `tools/release/package-macos.mjs` signs the app **ad hoc** (`codesign --force --deep --sign -`) and verifies it. Packaging changes Electron's bundle, and Apple Silicon refuses to run code whose signature is broken or missing, so the ad-hoc signature is required. It is not a Developer ID signature and it is not notarized, so Gatekeeper asks once.

**First launch ("Open Anyway"):**

1. Open `Agent-Empire-Mac-Apple-Silicon.dmg` (M1 or newer) or `Agent-Empire-Mac-Intel.dmg` and drag **Agent Empire** to **Applications**.
2. Open it. macOS says it cannot verify the developer. Click **Done** (not "Move to Trash").
3. Open **System Settings → Privacy & Security**, scroll to Security, and click **Open Anyway** next to "Agent Empire was blocked". Confirm with your password. ([Apple's instructions](https://support.apple.com/en-us/102445))
4. Later launches open normally.

**Updates:** Squirrel.Mac only updates apps signed with Developer ID. The release channel marks ad-hoc builds as `auto: false`, and the app also checks its own signature (`macDeveloperIdSigned` in `desktop/update-store.cjs`, unit-tested). An ad-hoc app therefore never tries an in-place update. When a new version exists it shows the update prompt, and **View** opens the release page so you can download and replace the app. Each new download needs "Open Anyway" once.

## Windows: unsigned builds

Without a certificate the pipeline publishes `Agent-Empire-Windows-Setup.exe` (per-user Squirrel installer, unsigned; the release notes say so). There is no portable zip any more. SmartScreen shows "Windows protected your PC": click **More info → Run anyway**. Unsigned installs update through the download prompt; in-place Squirrel updates turn on with a signed build.

### SignPath Foundation (free code signing for open source): owner checklist

SignPath Foundation signs releases of OSI-licensed projects for free ([terms](https://signpath.org/terms)). Apply only **after** the repository is public.

- [ ] Repository is public and MIT-licensed (`LICENSE`). Every shipped component is OSI-licensed, or an asset licence (MIT, CC0) that will be listed in the application for SignPath to decide on: see the review in `THIRD_PARTY_NOTICES.md` (npm dependencies MIT/Apache/ISC/BSD/0BSD/Unlicense; assets MIT and CC0). No proprietary parts in the Windows build.
- [ ] Builds are reproducible from public source on GitHub-hosted runners: `.github/workflows/release.yml`, job `desktop-windows`, tag-triggered only.
- [ ] MFA is on for every GitHub account with write access (owner: Settings → Password and authentication).
- [ ] Each release is approved manually: the `release` environment requires the owner as reviewer (`setup-github-release.sh` sets this) and SignPath's own approval step stays on.
- [ ] Add a **"Code signing policy"** section to the README once accepted. Draft:
      > Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org). Committers and reviewers: @Billioncodes001. Approvers: @Billioncodes001. Privacy: the app sends no telemetry; it contacts only your own office server and GitHub (for updates and, if you enable cloud mode, the GitHub API and Actions).
- [ ] Apply at [signpath.org](https://signpath.org) with: project name, repository URL, licence (MIT), a short description, the release workflow path, and the artifact to sign (`Agent-Empire-Windows-Setup.exe` and the app's `.exe`).
- [ ] After approval: add SignPath's GitHub action (pin it by commit SHA) to the `desktop-windows` job behind a new `HAS_SIGNPATH` flag, like the existing Azure path. Not done yet, because the organisation and project slugs only exist after acceptance.

### winget

Templates for a [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) pull request are in `docs/distribution/winget/` (schema 1.6.0, identifier `Billioncodes001.AgentEmpire`, per-user Squirrel installer with `--silent`). For each stable release: replace `<VERSION>` and `<SHA256>` (the installer's `sha256` in the release's `channel-stable.json` `assets`, or on the release page), check with `winget validate --manifest <dir>` and `winget install --manifest <dir>` on Windows, then open the PR (or use `wingetcreate update`). winget accepts unsigned installers, but Defender/SmartScreen scans in their pipeline may delay or block them, so submit after SignPath signing if the first attempt fails. Submit stable versions only; winget does not want pre-releases under the main identifier.

## Android: APK, Obtainium and IzzyOnDroid

Each release has `Agent-Empire-Android.apk`, signed with the owner's upload key (`setup-github-release.sh` stores it in the `release` environment). Install: download the APK on the phone, allow "Install unknown apps" for the browser, open it.

**Before the first public release:** run the setup script. Without the upload key the pipeline still publishes `Agent-Empire-Android.apk`, but signed with a throwaway key made on the runner (the channel file says `signed: false`, and the release notes must say so). Android refuses to update an app signed with a different key, so debug-signed APKs cannot update each other or the real build.

### Obtainium

[Obtainium](https://github.com/ImranR98/Obtainium) installs and updates straight from GitHub Releases.

| Setting | Value |
| --- | --- |
| Source URL | `https://github.com/Billioncodes001/agent-empire` |
| Include prereleases | on for the beta channel, off for stable |
| Filter APKs by regular expression | `^Agent-Empire-Android\.apk$` (optional: each release has one APK). Releases up to 1.0.0-beta.1 used `Agent-Empire-<v>-android.apk`; a filter set for those (`^Agent-Empire-[0-9][^/]*-android\.apk$`) finds nothing from 1.0.0-beta.2 on and must be changed |
| Version detection | from the release tag (`v1.0.0-beta.2` → `1.0.0-beta.2`) |

A one-tap link can go on the README: `obtainium://add/github.com/Billioncodes001/agent-empire`.

### IzzyOnDroid

The [IzzyOnDroid repository](https://apt.izzysoft.de/fdroid/) picks APKs up from GitHub Releases. Request inclusion through its [inclusion issue tracker](https://gitlab.com/IzzyOnDroid/repo/-/issues) once the repository is public. Their criteria (not re-verified here): open-source licence, APK attached to releases, no proprietary trackers or ads, and a reasonably small APK. The app has no trackers or Google Play Services. It is a WebView shell that talks to the user's own server, which they may label as an anti-feature. F-Droid's main repository builds from source and is a later goal.

### Google developer verification (honest note)

Google is introducing [developer verification](https://developer.android.com/developer-verification) for apps installed on certified Android devices, including sideloaded ones: required in Brazil, Indonesia, Singapore and Thailand from 2026-09-30, and **globally in 2027**. Unverified apps will then not install on certified devices through the normal flow. The free "limited distribution" account covers up to 20 devices; wider distribution needs a verified developer account (fees and terms per Google's FAQ, not reviewed here). Google says an "advanced flow" for power users will still install unverified apps. Plan: register for verification before the global date; until then the APK, Obtainium and IzzyOnDroid work as today.

## iPhone, iPad and every browser: the web app (PWA)

Apple offers no free way to distribute an app to other people, so iOS users install the web game from their own office server.

**What it is:** `manifest.webmanifest` (standalone display, 192/512 and maskable icons, apple-touch icon) and `sw.js`. The service worker:

- answers page loads from the network, and shows a public offline page (`/assets/pwa/offline-v1.html`) only when that fails;
- caches **only** the fingerprinted build files `/assets/<name>-<hash>.<ext>`, which the server serves to everyone before sign-in and which never change;
- never caches `/api/*`, pages, models, textures, audio, or anything requested with an `Authorization` header, and never sees WebSocket traffic.

**Requirements:** HTTPS with a certificate the device trusts, or `localhost`. Browsers do not register service workers on plain HTTP or with an untrusted certificate. The office's `--self-signed` mode works on a phone only after you install and trust that certificate. A real certificate is simpler: put the office behind Caddy or another reverse proxy with Let's Encrypt, or use `tailscale serve` on a private network.

**Install:**

- **iPhone/iPad (Safari):** open the office address, sign in, tap **Share → Add to Home Screen → Add**.
- **Android (Chrome):** menu **⋮ → Install app** (or **Add to Home screen**).
- **Desktop Chrome/Edge:** the install icon in the address bar, or **Settings › App & connection › Install** inside the game.

**Verified:** `npx tsx tools/pwa-check.ts` (after `npm run build`) starts the real office server with `--self-signed` on a throwaway project and checks in Chrome: valid manifest and icons, Chrome's own installability check, service-worker registration and control, every `/api` response bypassing the worker, CacheStorage holding only the offline page, its icon and hashed `/assets/` files, and the offline page. Screenshots: `docs/team/reports/free-03/`. That run uses Chrome's `--ignore-certificate-errors` for the throwaway certificate. Installing on a real iPhone over a trusted certificate has not been tested.
