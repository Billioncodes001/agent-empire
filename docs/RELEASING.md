# Releasing Agent Empire

GitHub is where releases come from. Pushing a version tag on `main` makes `.github/workflows/release.yml` build the game bundle, cloud coordinator, macOS, Windows, Android and iOS apps, and publish a GitHub Release with a signed update channel file. Installed apps read that file to offer **Update available**. The design and channel contract are in `docs/team/RELEASE_PLAN.md`.

Every signing step switches on by itself once its GitHub secrets exist. Without them the platform still builds, but unsigned. File names never carry the signing state: each platform job records it as build info, the signed channel file carries it (`signed`, `auto`), and the release notes tell users (see "Release notes"). Only `GAME_SIGNING_KEY` and its pinned public key are needed before the first tagged release.

## Cutting a release

1. **Set the version** on `codex/empire-world`. One version covers everything: the game, server, coordinator, desktop, Android and iOS.

   ```sh
   npm run version:set -- 1.0.0-beta.2   # writes package.json, lock files, desktop, Android and iOS versions
   npm run version:check                 # every file agrees
   ```

   Versions are `X.Y.Z` or `X.Y.Z-(alpha|beta|rc).N`. Any prerelease goes to the beta channel and is marked pre-release on GitHub. Versions only move forward. Android `versionCode` and the iOS build number are derived from the version (`1.0.0-beta.2` = 10000302), so a version can only be uploaded to Play or TestFlight once.

2. **Release notes:** `docs/release-notes/<version>.md`, for example `docs/release-notes/1.0.0-beta.2.md`. The text goes into the channel file the apps show (first 4000 characters), and becomes the GitHub release notes. Without the file, the apps show "Agent Empire <version>" and GitHub generates notes. Follow "Release notes" below: it must end with one install line per platform.

3. **Commit, open a PR to `main`, and merge it.** Releases are tagged on `main` only.

4. **Tag the merged commit and push the tag:**

   ```sh
   git fetch origin
   git show origin/main:package.json | grep '"version"'      # must print the version from step 1
   git tag -a v1.0.0-beta.2 origin/main -m "Agent Empire 1.0.0-beta.2"
   git push origin v1.0.0-beta.2
   ```

5. **Watch the workflow:** GitHub, then Actions, then Release. When it passes, the release appears under Releases with the files listed in "What each release contains" (8 for a release with unsigned desktop builds).

The workflow fails before building anything when:

- the tag is not exactly `v` + `package.json`'s version;
- the tagged commit is not on `main`;
- the version files disagree;
- the pinned public key is still the development key.

It also fails if `GAME_SIGNING_KEY` is missing or does not match the pinned key.

**If a run fails:** nothing is published unless the final `publish` job runs. Fix the problem through a PR to `main`. Then move the tag:

```sh
git push --delete origin v1.0.0-beta.2
git tag -d v1.0.0-beta.2
```

Then tag the new `main` commit again. If the run had already uploaded to Google Play or TestFlight, those stores keep the build number. In that case, bump the version (`1.0.0-beta.3`) instead of reusing it.

**Dry run:** go to Actions, then Release, then **Run workflow**, on any branch. Everything builds and is attached to the run as artifacts. `release-bundle` holds exactly what would be published (the `assemble` log lists it). Nothing is published or uploaded to the stores.

A dry run never joins the `release` environment, so it can never read a signing secret. It always signs with the public development key (`--dev`, untrusted) and builds unsigned macOS and Windows apps and a debug-signed Android APK. This is deliberate: code on an unreviewed branch must never be able to mint production signatures.

**Approvals:** on a tag run, each job that signs or publishes waits for the owner's approval of the `release` environment. Approve from the run page with **Review deployments**. Approval comes in three batches:
1. the builds (macOS ×2, Windows, Android, iOS; the game job holds no secret and needs no approval);
2. `assemble` (the channel files);
3. `publish` and `play` together.

## One-time setup: the `release` environment and tag protection (required)

Every signing secret lives in a GitHub **Environment** named `release`, never in repository secrets. Only a run started by a `v*` tag, approved by the owner, can use them.

1. **Create the environment:** Settings → Environments → **New environment** → name it `release`.
2. **Protection rules** on that environment:
   - **Required reviewers:** add yourself (the owner). If you are the only maintainer, leave **Prevent self-review** off, or you cannot approve your own release.
   - **Deployment branches and tags:** choose **Selected branches and tags**. **Add deployment branch or tag rule** → type **Tag** → pattern `v*`. Add no branch rules. A run from any branch (a dry run, or a modified workflow on a feature branch) is then refused the environment.
   - Leave **Allow administrators to bypass configured protection rules** off.
3. **Put the secrets in the environment, not the repository:** every `gh secret set … --env release` command in this document does this. In the web UI, use Environments → `release` → **Environment secrets**. Set the Azure variables the same way, with `gh variable set NAME --env release --body …`.
4. **Remove repository-level copies,** if any were set before:

   ```sh
   gh secret list                      # repository secrets: none of the signing names may appear here
   gh secret delete GAME_SIGNING_KEY   # repeat for any signing secret listed
   gh secret list --env release        # the signing secrets live here
   ```

5. **Restrict who can create release tags** with a tag ruleset: Settings → Rules → Rulesets → **New ruleset** → **New tag ruleset**.
   - Name: `release tags`. Enforcement: **Active**.
   - Target tags: **Add target** → **Include by pattern** → `v*`.
   - Rules: **Restrict creations**, **Restrict updates**, **Restrict deletions**.
   - Bypass list: **Repository admin** and **Maintain** roles only.

   Or with the CLI (role ids: 5 = admin, 2 = maintain):

   ```sh
   gh api repos/Billioncodes001/agent-empire/rulesets -X POST --input - <<'JSON'
   {"name": "release tags", "target": "tag", "enforcement": "active",
    "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
    "rules": [{"type": "creation"}, {"type": "update"}, {"type": "deletion"}],
    "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"},
                      {"actor_id": 2, "actor_type": "RepositoryRole", "bypass_mode": "always"}]}
   JSON
   ```

Together these mean:
- only maintainers can push a `v*` tag;
- the workflow refuses a tag that is not on `main` or does not match the version;
- secrets are released only to that tag's run, and only after you approve it.

## One-time setup: the update signing key (required)

Every app checks the signature on the channel file against a public key built into the app. The channel file carries the sha256 of the game bundle and of every other published file, so it is the only file that needs a signature.

**Status: done.** The owner generated the key offline and it was pinned on 2026-10-08 (REL-07, [report](team/reports/rel-07-pin-key.md)). The public key is `rIRaOVUyoolaIritW/W8zMW7kGymgcjvg7uXhHtTqPk=` (raw Ed25519, base64). It is in `src/shared/release-key.ts` and in every file listed in `tools/release/config.json` → `pinnedKeyFiles`. The owner stores the private key as the `release` environment secret `GAME_SIGNING_KEY` with `~/AgentEmpire-credentials/setup-github-release.sh`, and keeps an offline backup. GitHub secrets cannot be read back. If the key is lost, installed apps stop accepting updates until users install a new native build.

Check that the secret matches the pinned key (paste the PEM from your password manager; it is never written to disk):

```sh
GAME_SIGNING_KEY="$(pbpaste)" node tools/release/sign.mjs check-key
```

This prints "ready … matches".

**Development builds and the public development key.** Tests and the local update fixture (`tools/update-fixture.ts`) sign with a public development key (`tools/release/dev-release-public-key.txt`, private half derived from a published seed; never under `src/`, which ships in the apps). Only development builds trust it:

| Platform | Development build (trusts owner key + dev key) | Release build (owner key only) |
|---|---|---|
| Web page | Vite dev server, `vite build --mode fixture` (compile-time define) | `npm run build:client`: the dev key string is absent from `dist/public` (checked by `tools/check-no-fixture.mjs`) |
| Desktop | `node tools/prepare-desktop.mjs --dev-updates` writes `desktop/dev-trust.json` | Any other prepare deletes that file; the release workflow never passes the flag |
| Android | `build-android.py --variant debug` (`app/src/debug/java/.../DevTrust.java`) | Release variant (`app/src/release/java`, no key); the build fails if the dev key is anywhere in the APK |
| iOS | Debug configuration (`#if DEBUG`) | Release configuration |

A development shell reports the dev key to the page it carries (`update.nativeInfo` → `devReleaseKey`), so the production page can be tested against the fixture. A release shell never does. Every run of the release workflow builds release-shaped apps, dry runs included. `node tools/release/sign.mjs check-key` refuses a release when `RELEASE_PUBLIC_KEY` is the dev key, when a shell file does not pin the owner key, or when any release-build source would trust the dev key. Dry runs run the same check (`check-key --allow-dev`). The workflow also runs `sign.mjs check-trust` on the packaged macOS, Windows and iOS apps and on the iOS archive, and `build-android.py` scans the release APK and AAB. A development shell's reported key is accepted only when it is exactly the dev key.

**Rotating the key** (only if it is compromised or lost): run `node tools/release/generate-signing-key.mjs --out <new file>` on a trusted computer, replace `RELEASE_PUBLIC_KEY` in `src/shared/release-key.ts` and in every `pinnedKeyFiles` entry, update the secret, and ship a native build. Apps that are already installed trust only the old key.

## GitHub secrets and variables

Signing secrets and the Azure variables go in the **`release` environment** (above): Settings → Environments → `release`, or `gh secret set NAME --env release` / `gh variable set NAME --env release`. `PLAY_RELEASE_STATUS` and `PLAY_LISTED` are plain repository variables (`gh variable set NAME`); they are not secret. Binary files are stored base64-encoded: `base64 -i file | gh secret set NAME --env release` on macOS, or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("file"))` on Windows.

| Name | Kind | Unlocks | Where it comes from |
|---|---|---|---|
| `GAME_SIGNING_KEY` | `release` env secret | **Required for any tagged release.** Signs `channel-*.json` | `node tools/release/generate-signing-key.mjs` (above) |
| `APPLE_DEVELOPER_ID_CERT_P12` | `release` env secret | macOS Developer ID signing (with notarization below). Signed macOS builds also get in-place updates (`auto: true` and Squirrel feeds) | base64 of a **Developer ID Application** certificate exported as .p12 (see Apple below) |
| `APPLE_DEVELOPER_ID_CERT_PASSWORD` | `release` env secret | (with the above) | the password you chose when exporting the .p12 |
| `APPLE_ID` | `release` env secret | macOS notarization with an Apple ID | your Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | `release` env secret | (with `APPLE_ID`) | appleid.apple.com → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | `release` env secret | notarization with an Apple ID; iOS archive signing | developer.apple.com/account → Membership details → Team ID (10 characters) |
| `ASC_KEY_ID` | `release` env secret | TestFlight upload; also macOS notarization. Preferred over `APPLE_ID` when both are set | App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → generate (role **App Manager**) |
| `ASC_ISSUER_ID` | `release` env secret | (with the above) | same page, "Issuer ID" |
| `ASC_KEY_P8` | `release` env secret | (with the above) | the `AuthKey_<id>.p8` downloaded once when the key is created: `gh secret set ASC_KEY_P8 --env release < AuthKey_XXXX.p8` |
| `IOS_DIST_CERT_P12` | `release` env secret | iOS archive and TestFlight upload (needs all `ASC_*`, `APPLE_TEAM_ID` and the two below) | base64 of an **Apple Distribution** certificate exported as .p12 |
| `IOS_DIST_CERT_PASSWORD` | `release` env secret | (with the above) | its export password |
| `IOS_PROVISIONING_PROFILE_B64` | `release` env secret | (with the above) | base64 of an **App Store** provisioning profile for `com.agentempire.mobile` |
| `WINDOWS_CERT_P12` | `release` env secret | Windows Authenticode signing of `Agent Empire.exe` and the Squirrel installer; signed Windows builds also get in-place updates | base64 of an OV/EV code-signing certificate as .pfx |
| `WINDOWS_CERT_PASSWORD` | `release` env secret | (with the above) | its .pfx password |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | `release` env secrets | Windows signing with Azure Artifact Signing (formerly Trusted Signing). Used when no .pfx is set | an Entra app registration granted **Artifact Signing Certificate Profile Signer** on the signing account |
| `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` | `release` env variables | (with the above) | the account's region endpoint (for example `https://eus.codesigning.azure.net/`), account name and certificate profile name |
| `ANDROID_KEYSTORE_B64` | `release` env secret | upload-key signed APK and Play App Bundle (AAB). Without it, the APK is debug-signed (the channel file says `signed: false`; say so in the notes) and there is no AAB for Play | base64 of the upload keystore (command below) |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | `release` env secrets | (with the above) | the values used when creating the keystore |
| `PLAY_SERVICE_ACCOUNT_JSON` | `release` env secret | upload of the AAB to the Play **internal** track (also needs the keystore) | Google Cloud service account JSON key (see Google Play below) |
| `PLAY_LISTED` | repository variable, optional | `true` once the Play listing is public. Channel files then link Android users to Play | — |
| `PLAY_RELEASE_STATUS` | repository variable, optional | `draft` until the app's first release is rolled out from the Play Console. Default `completed` | — |

Secrets only reach the steps that use them, only in jobs that joined the `release` environment on a tag run. Jobs see true/false presence flags, which are always false on a dry run.

### Apple (macOS and iOS)

You need a paid Apple Developer Program membership. Only the Account Holder can create Developer ID certificates.

- **Developer ID Application certificate (macOS):**
  1. In Xcode, go to Settings, then Accounts, select your team, then Manage Certificates. Add a **Developer ID Application** certificate.
  2. In Keychain Access → My Certificates, right-click it, choose Export, and save it as `.p12` with a password.
  3. Store it: `base64 -i DeveloperID.p12 | gh secret set APPLE_DEVELOPER_ID_CERT_P12 --env release`.
- **Notarization:** choose one:
  - `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or
  - the App Store Connect API key (`ASC_*`).

  Signing without notarization is refused, because Gatekeeper still blocks such an app.
- **iOS:**
  1. At developer.apple.com → Identifiers, register the App ID `com.agentempire.mobile`.
  2. Create the app in App Store Connect with that bundle ID.
  3. Create an **Apple Distribution** certificate. Export it as .p12 the same way as above → `IOS_DIST_CERT_P12`.
  4. Under Profiles, create an **App Store Connect** distribution profile for the App ID → `base64 -i AgentEmpire.mobileprovision | gh secret set IOS_PROVISIONING_PROFILE_B64 --env release`.
  5. Once TestFlight works, put the public TestFlight link and App Store URL in `tools/release/config.json` (`iosTestFlight`, `iosAppStore`) so the channel file can point iPhone users to them.

### Windows

Choose one of these:

- **A .pfx certificate:** an OV or EV code-signing certificate from a CA, as .pfx → `WINDOWS_CERT_P12` and `WINDOWS_CERT_PASSWORD`. Most CAs now issue only on hardware tokens or cloud HSMs, which cannot be exported as .pfx. In that case, use the second option.
- **Azure Artifact Signing:**
  1. Create an Artifact Signing account and complete identity validation.
  2. Create a certificate profile.
  3. Create an app registration with a client secret and give it the signer role on the account.
  4. Set the three `AZURE_*` secrets and the three `AZURE_SIGNING_*` variables.

The release ships the Squirrel.Windows installer `Agent-Empire-Windows-Setup.exe`, built with `electron-winstaller` and signed with the same certificate, or by Azure. A signed build also ships its update package (`AgentEmpire-<nugetVersion>-full.nupkg`, a name installed apps check) and the `RELEASES` feed index, and installed apps then update in place: the shell downloads the package named in the signed channel, checks its sha256 and hands Squirrel a local feed. The feed is `https://github.com/<owner>/<repo>/releases/latest/download` for stable and `…/releases/download/<tag>` for beta. An unsigned build ships the installer only, and the apps prompt and open the download page.

### Android and Google Play

1. **Create the upload keystore once.** Keep the file and passwords backed up offline:

   ```sh
   keytool -genkeypair -v -keystore agent-empire-upload.jks -storetype PKCS12 -alias upload \
     -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Agent Empire, O=<your name or company>, C=<country>"
   base64 -i agent-empire-upload.jks | gh secret set ANDROID_KEYSTORE_B64 --env release
   gh secret set ANDROID_KEY_ALIAS --env release --body upload
   gh secret set ANDROID_KEYSTORE_PASSWORD --env release     # paste when prompted
   gh secret set ANDROID_KEY_PASSWORD --env release          # the same password for a PKCS12 keystore
   ```

2. **Play Console:**
   1. Create the app `com.agentempire.mobile` and enable **Play App Signing**. Google then keeps the app signing key, and this keystore is your upload key.
   2. Upload the first AAB by hand on the Internal testing track. The first upload must come from the Console; take `Agent-Empire-Android.aab` from a tag run's `play-bundle` artifact (the AAB is never a release asset).
3. **Service account:**
   1. In Google Cloud Console, enable the **Google Play Android Developer API**.
   2. Create a service account and add a JSON key → `gh secret set PLAY_SERVICE_ACCOUNT_JSON --env release < key.json`.
   3. In Play Console → Users and permissions, invite the service account's email with permission to **release to testing tracks** for this app.
   4. Set the variable `PLAY_RELEASE_STATUS=draft` until the app has been rolled out once, then remove it.

Sideloaded installs use the APK from the GitHub Release, and its sha256 is in the channel file. Play installs update through Play.

## What each release contains

Names come from `tools/release/assets.mjs`. Files people download have plain names with no version, architecture code or signing label, so a stable release can be linked forever as `https://github.com/Billioncodes001/agent-empire/releases/latest/download/<name>` (GitHub's "latest" skips pre-releases). The version is in the release title and tag. Every file below has a reader; `assemble` refuses anything else (`channel.mjs` plan, then `channel.mjs check-publish`).

| Asset | Who needs it | Published |
|---|---|---|
| `Agent-Empire-Mac-Apple-Silicon.dmg`, `Agent-Empire-Mac-Intel.dmg` | people (Mac) | always |
| `Agent-Empire-Windows-Setup.exe` | people (Windows; per-user Squirrel.Windows installer) | always |
| `Agent-Empire-Android.apk` | people (Android), and sideloaded apps updating themselves (url + sha256 from the channel) | always |
| `agent-empire-game-<v>.zip` | every app's over-the-air game update (url + sha256 from the channel) | always |
| `agent-empire-coordinator.mjs` | cloud mode: a state repository gets it only when its user accepts the prompt | always |
| `channel-beta.json`, `channel-beta.json.sig` | every installed app (the beta.1 apps find releases by these two names); also the signed checksum list (`assets`: sha256 and size of every other file) | always |
| `channel-stable.json`, `.sig` | stable apps (`…/releases/latest/download/channel-stable.json`) | final releases |
| `Agent-Empire-Mac-Apple-Silicon-Update.zip`, `Agent-Empire-Mac-Intel-Update.zip` | Squirrel.Mac in-place update payload | signed and notarized macOS only |
| `RELEASES-darwin-arm64.json`, `RELEASES-darwin-x64.json` | Squirrel.Mac feed (Electron's static `RELEASES.json`; stable apps accept only this name under `latest/download`) | signed and notarized macOS only |
| `AgentEmpire-<nugetVersion>-full.nupkg`, `RELEASES` | Squirrel.Windows update package (the installed shell accepts only this name) and feed index | signed Windows only |

So a release with unsigned desktop builds has **8 files**; with signed macOS and Windows it has 14 (15 with `channel-stable` on a final release, 16 with its signature).

Not published: the Play App Bundle (`play-bundle` workflow artifact, uploaded to Play by the `play` job), the game manifest and build info (inputs to the channel file), `SHA256SUMS` (the signed channel lists every checksum, and GitHub shows each asset's sha256 on the release page). The iOS app goes to TestFlight; every run also builds an iOS simulator app, available as the `ios-simulator-app` artifact.

**Verifying a download by hand:** `jq -r '.assets["Agent-Empire-Android.apk"].sha256' channel-beta.json` gives the expected sha256; check the channel file itself with `node tools/release/sign.mjs verify channel-beta.json`.

## Release notes

`docs/release-notes/<version>.md` is shown in the apps and on the release page. Keep it short and end it with this block, one line per platform, naming the files as published and saying plainly what is not signed (change the wording when a platform becomes signed):

```md
**Installing**
- Mac: download `Agent-Empire-Mac-Apple-Silicon.dmg` (M1 or newer) or `Agent-Empire-Mac-Intel.dmg` (older Intel Macs), open it and drag Agent Empire to Applications. Not signed by Apple yet: the first time, open System Settings › Privacy & Security and choose Open Anyway.
- Windows: download and run `Agent-Empire-Windows-Setup.exe`. Not code-signed yet: if Windows warns you, choose More info › Run anyway.
- Android: download `Agent-Empire-Android.apk` on your phone and open it (allow installing from your browser when asked). The app tells you when an update is ready.
- iPhone and iPad: open your office address in Safari and choose Share › Add to Home Screen.

Installed apps update themselves: the game updates in place, and the app tells you when a new download is ready.
```

If the Android build is debug-signed (no upload key on the tag run), say so on the Android line: it cannot update or be updated by the normal build. Obtainium users who set an APK filter for 1.0.0-beta.1 (`^Agent-Empire-[0-9][^/]*-android\.apk$`) must change it to `^Agent-Empire-Android\.apk$` (mention this in the 1.0.0-beta.2 notes).

## Local commands

```sh
npm run version:check                          # versions in sync
node tools/release/version.mjs info            # derived values (versionCode, iOS build number, channel)
npm run build && npm run build:cloud
npm run release:game -- --manifest-dir release/build-info   # release/assets/agent-empire-game-<v>.zip + build-info/game-manifest.json
node tools/release/assets.mjs build-info --out release/build-info --platform android --signed false   # one per platform build
node tools/release/channel.mjs --assets release/assets --info release/build-info
node tools/release/sign.mjs sign --dev release/assets/channel-*.json   # development signature (untrusted)
node tools/release/channel.mjs check-publish --assets release/assets   # exactly the planned files, checksums match
```
