# Releasing Agent Empire

GitHub is where releases come from. Pushing a version tag on `main` makes `.github/workflows/release.yml` build the game bundle, cloud coordinator, macOS, Windows, Android and iOS apps, and publish a GitHub Release with a signed update channel file. Installed apps read that file to offer **Update available**. The design and channel contract are in `docs/team/RELEASE_PLAN.md`.

Every signing step switches on by itself once its GitHub secrets exist. Without them the platform still builds, but unsigned, and the file name says so (`-unsigned`, `-debug-signed`). Only `GAME_SIGNING_KEY` and its pinned public key are needed before the first tagged release.

## Cutting a release

1. **Set the version** on `codex/empire-world`. One version covers everything: the game, server, coordinator, desktop, Android and iOS.

   ```sh
   npm run version:set -- 1.0.0-beta.2   # writes package.json, lock files, desktop, Android and iOS versions
   npm run version:check                 # every file agrees
   ```

   Versions are `X.Y.Z` or `X.Y.Z-(alpha|beta|rc).N`. Any prerelease goes to the beta channel and is marked pre-release on GitHub. Versions only move forward. Android `versionCode` and the iOS build number are derived from the version (`1.0.0-beta.2` = 10000302), so a version can only be uploaded to Play or TestFlight once.

2. **Optional release notes:** `docs/release-notes/<version>.md`, for example `docs/release-notes/1.0.0-beta.2.md`. The text goes into the channel file the apps show, and becomes the GitHub release notes. Without the file, the apps show "Agent Empire <version>" and GitHub generates notes.

3. **Commit, open a PR to `main`, and merge it.** Releases are tagged on `main` only.

4. **Tag the merged commit and push the tag:**

   ```sh
   git fetch origin
   git show origin/main:package.json | grep '"version"'      # must print the version from step 1
   git tag -a v1.0.0-beta.2 origin/main -m "Agent Empire 1.0.0-beta.2"
   git push origin v1.0.0-beta.2
   ```

5. **Watch the workflow:** GitHub, then Actions, then Release. When it passes, the release appears under Releases with every asset and `SHA256SUMS`.

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

**Dry run:** go to Actions, then Release, then **Run workflow**, on any branch. Everything builds and is attached to the run as artifacts. `release-bundle` holds exactly what would be published. Nothing is published or uploaded to the stores. Without `GAME_SIGNING_KEY`, the dry run signs with the public development key, which is untrusted.

## One-time setup: the update signing key (required)

Every app checks the signature on the channel file and game manifest against a public key built into the app. This key must exist before the first release.

1. On a trusted computer, from the repository root, create the key into a file only you can read:

   ```sh
   node tools/release/generate-signing-key.mjs --out ~/agent-empire-signing-key.pem
   ```

   It prints the public key and a line to paste.
2. Store the private key as a repository secret:

   ```sh
   gh secret set GAME_SIGNING_KEY < ~/agent-empire-signing-key.pem
   ```
3. Back up the `.pem` in your password manager, then delete the file. GitHub secrets cannot be read back. If this key is lost, installed apps stop accepting updates until users install a new native build.
4. Replace `RELEASE_PUBLIC_KEY` in `src/shared/release-key.ts` with the printed line. Also replace it in every file listed in `tools/release/config.json` → `pinnedKeyFiles`. Commit through the normal PR flow.
5. Check the key locally:

   ```sh
   GAME_SIGNING_KEY="$(pbpaste)" node tools/release/sign.mjs check-key
   ```

   This prints "ready … matches". `pbpaste` assumes the PEM is on the clipboard; you can use your password manager's CLI instead.

## GitHub secrets and variables

Set them under Settings, then Secrets and variables, then Actions, or with `gh secret set NAME` / `gh variable set NAME`. Binary files are stored base64-encoded: `base64 -i file | gh secret set NAME` on macOS, or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("file"))` on Windows.

| Name | Kind | Unlocks | Where it comes from |
|---|---|---|---|
| `GAME_SIGNING_KEY` | secret | **Required for any tagged release.** Signs `game-manifest.json` and `channel-*.json` | `node tools/release/generate-signing-key.mjs` (above) |
| `APPLE_DEVELOPER_ID_CERT_P12` | secret | macOS Developer ID signing (with notarization below). Signed macOS builds also get in-place updates (`auto: true` and Squirrel feeds) | base64 of a **Developer ID Application** certificate exported as .p12 (see Apple below) |
| `APPLE_DEVELOPER_ID_CERT_PASSWORD` | secret | (with the above) | the password you chose when exporting the .p12 |
| `APPLE_ID` | secret | macOS notarization with an Apple ID | your Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | secret | (with `APPLE_ID`) | appleid.apple.com → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | secret | notarization with an Apple ID; iOS archive signing | developer.apple.com/account → Membership details → Team ID (10 characters) |
| `ASC_KEY_ID` | secret | TestFlight upload; also macOS notarization. Preferred over `APPLE_ID` when both are set | App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → generate (role **App Manager**) |
| `ASC_ISSUER_ID` | secret | (with the above) | same page, "Issuer ID" |
| `ASC_KEY_P8` | secret | (with the above) | the `AuthKey_<id>.p8` downloaded once when the key is created: `gh secret set ASC_KEY_P8 < AuthKey_XXXX.p8` |
| `IOS_DIST_CERT_P12` | secret | iOS archive and TestFlight upload (needs all `ASC_*`, `APPLE_TEAM_ID` and the two below) | base64 of an **Apple Distribution** certificate exported as .p12 |
| `IOS_DIST_CERT_PASSWORD` | secret | (with the above) | its export password |
| `IOS_PROVISIONING_PROFILE_B64` | secret | (with the above) | base64 of an **App Store** provisioning profile for `com.agentempire.mobile` |
| `WINDOWS_CERT_P12` | secret | Windows Authenticode signing of `Agent Empire.exe` | base64 of an OV/EV code-signing certificate as .pfx |
| `WINDOWS_CERT_PASSWORD` | secret | (with the above) | its .pfx password |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | secrets | Windows signing with Azure Artifact Signing (formerly Trusted Signing). Used when no .pfx is set | an Entra app registration granted **Artifact Signing Certificate Profile Signer** on the signing account |
| `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` | variables | (with the above) | the account's region endpoint (for example `https://eus.codesigning.azure.net/`), account name and certificate profile name |
| `ANDROID_KEYSTORE_B64` | secret | upload-key signed APK and Play App Bundle (AAB). Without it, the APK is labelled `-debug-signed` and no AAB is published | base64 of the upload keystore (command below) |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | secrets | (with the above) | the values used when creating the keystore |
| `PLAY_SERVICE_ACCOUNT_JSON` | secret | upload of the AAB to the Play **internal** track (also needs the keystore) | Google Cloud service account JSON key (see Google Play below) |
| `PLAY_RELEASE_STATUS` | variable, optional | `draft` until the app's first release is rolled out from the Play Console. Default `completed` | — |

Secrets only reach the steps that use them. Jobs see true/false presence flags.

### Apple (macOS and iOS)

You need a paid Apple Developer Program membership. Only the Account Holder can create Developer ID certificates.

- **Developer ID Application certificate (macOS):**
  1. In Xcode, go to Settings, then Accounts, select your team, then Manage Certificates. Add a **Developer ID Application** certificate.
  2. In Keychain Access → My Certificates, right-click it, choose Export, and save it as `.p12` with a password.
  3. Store it: `base64 -i DeveloperID.p12 | gh secret set APPLE_DEVELOPER_ID_CERT_P12`.
- **Notarization:** choose one:
  - `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or
  - the App Store Connect API key (`ASC_*`).

  Signing without notarization is refused, because Gatekeeper still blocks such an app.
- **iOS:**
  1. At developer.apple.com → Identifiers, register the App ID `com.agentempire.mobile`.
  2. Create the app in App Store Connect with that bundle ID.
  3. Create an **Apple Distribution** certificate. Export it as .p12 the same way as above → `IOS_DIST_CERT_P12`.
  4. Under Profiles, create an **App Store Connect** distribution profile for the App ID → `base64 -i AgentEmpire.mobileprovision | gh secret set IOS_PROVISIONING_PROFILE_B64`.
  5. Once TestFlight works, put the public TestFlight link and App Store URL in `tools/release/config.json` (`iosTestFlight`, `iosAppStore`) so the channel file can point iPhone users to them.

### Windows

Choose one of these:

- **A .pfx certificate:** an OV or EV code-signing certificate from a CA, as .pfx → `WINDOWS_CERT_P12` and `WINDOWS_CERT_PASSWORD`. Most CAs now issue only on hardware tokens or cloud HSMs, which cannot be exported as .pfx. In that case, use the second option.
- **Azure Artifact Signing:**
  1. Create an Artifact Signing account and complete identity validation.
  2. Create a certificate profile.
  3. Create an app registration with a client secret and give it the signer role on the account.
  4. Set the three `AZURE_*` secrets and the three `AZURE_SIGNING_*` variables.

Signing removes the "unknown publisher" warning. The Windows app still has no in-place updater, so it prompts and opens the download page (see `docs/team/reports/release-pipeline.md`).

### Android and Google Play

1. **Create the upload keystore once.** Keep the file and passwords backed up offline:

   ```sh
   keytool -genkeypair -v -keystore agent-empire-upload.jks -storetype PKCS12 -alias upload \
     -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Agent Empire, O=<your name or company>, C=<country>"
   base64 -i agent-empire-upload.jks | gh secret set ANDROID_KEYSTORE_B64
   gh secret set ANDROID_KEY_ALIAS --body upload
   gh secret set ANDROID_KEYSTORE_PASSWORD     # paste when prompted
   gh secret set ANDROID_KEY_PASSWORD          # the same password for a PKCS12 keystore
   ```

2. **Play Console:**
   1. Create the app `com.agentempire.mobile` and enable **Play App Signing**. Google then keeps the app signing key, and this keystore is your upload key.
   2. Upload the first AAB by hand on the Internal testing track. The first upload must come from the Console; take the AAB from a release run or its `release-android` artifact.
3. **Service account:**
   1. In Google Cloud Console, enable the **Google Play Android Developer API**.
   2. Create a service account and add a JSON key → `gh secret set PLAY_SERVICE_ACCOUNT_JSON < key.json`.
   3. In Play Console → Users and permissions, invite the service account's email with permission to **release to testing tracks** for this app.
   4. Set the variable `PLAY_RELEASE_STATUS=draft` until the app has been rolled out once, then remove it.

Sideloaded installs use the APK from the GitHub Release, and its sha256 is in the channel file. Play installs update through Play.

## What each release contains

| Asset | Notes |
|---|---|
| `agent-empire-game-<v>.zip`, `game-manifest.json`, `game-manifest.json.sig` | over-the-air game bundle (deterministic zip of `dist/public`) and its signed manifest |
| `agent-empire-coordinator.mjs` | cloud coordinator. A state repository gets it only when its user accepts the prompt |
| `Agent-Empire-<v>-macos-<arm64\|x64>[-unsigned].dmg` / `.zip` | the zip is the in-place update payload |
| `desktop-update-darwin-<arch>.json` | Squirrel.Mac feed. Only for signed and notarized builds |
| `Agent-Empire-<v>-windows-x64[-unsigned].zip` | portable app folder |
| `Agent-Empire-<v>-android[-debug-signed].apk`, `Agent-Empire-<v>-android.aab` | the AAB is only published when signed with the upload key |
| `channel-beta.json(.sig)`, plus `channel-stable.json(.sig)` for final releases | the update channel the apps read |
| `SHA256SUMS` | checksums of every asset |

The iOS app is not a release asset. It goes to TestFlight. Every run also builds an iOS simulator app, available as the `ios-simulator-app` artifact.

## Local commands

```sh
npm run version:check                          # versions in sync
node tools/release/version.mjs info            # derived values (versionCode, iOS build number, channel)
npm run build && npm run build:cloud
npm run release:game                           # release/assets/agent-empire-game-<v>.zip + game-manifest.json
node tools/release/sign.mjs sign --dev release/assets/game-manifest.json   # development signature (untrusted)
node tools/release/sign.mjs verify release/assets/game-manifest.json --public-key <base64>
```
