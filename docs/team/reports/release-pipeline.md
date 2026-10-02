# Release pipeline (REL-01, REL-02)

| | |
|---|---|
| Branch | `claude/release-pipeline` (from `d26d7fa`) |
| Author | Claude (Claude Code), release lane |
| Plan | `docs/team/RELEASE_PLAN.md`. Its contract section now records what was implemented |
| Owner steps | `docs/RELEASING.md` |

Nothing was pushed, tagged, released or uploaded. No secrets were set, and no real signing key was made.

## What changed

### REL-01: one version

- **`tools/release/version.mjs`** has five commands: `set`, `sync`, `check`, `info` and `tag-check`.
  - `package.json` is the source of truth. The script syncs the version to `package-lock.json`, `desktop/package.json`, `desktop/package-lock.json`, the AndroidManifest `versionCode`/`versionName`, the optional Gradle file, and the iOS `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` (both build configurations).
  - The npm scripts are `version:set` and `version:check`.
- **versionCode** is `MAJOR*10^7 + MINOR*10^5 + PATCH*10^3 + rank`:
  - rank is `alpha.N`=100+N, `beta.N`=300+N, `rc.N`=600+N (N ≤ 199), and a final release is 999;
  - minor and patch must be at most 99;
  - the iOS build number uses the same integer, and iOS `MARKETING_VERSION` is `X.Y.Z`.
  - So `1.0.0-beta.1` is 10000301. The plan's example said 10000002 for beta.2; the contract now says 10000302.
- **The tag rule** requires the tag to be exactly `v<package.json version>`, with the tagged commit reachable from `origin/main` (`git merge-base --is-ancestor`).
- **This branch is set to `1.0.0-beta.1`** (Android code 10000301; it was 3).
- **`.gitignore`:** `release/` became `/release/`. The old pattern also ignored `tools/release/`.

### Signing and release files

- **`src/shared/release-key.ts`** pins the public key.
  - It exports `RELEASE_PUBLIC_KEY`, `DEV_RELEASE_PUBLIC_KEY` and `RELEASE_KEY_IS_DEVELOPMENT`. The key format is raw 32-byte Ed25519 in base64.
  - It currently holds the **development placeholder**. Its private half is derived from a public seed (`sign.mjs devPrivateKey()`), for tests and fixtures only.
- **`tools/release/sign.mjs`** signs and verifies Ed25519 with `node:crypto`. Each `.sig` file is the base64 of the 64-byte signature over the exact file bytes.
  - `sign --dev` signs with the development key.
  - `check-key` is the release gate. It fails when:
    - the pinned key is still the development key;
    - a file in `tools/release/config.json` `pinnedKeyFiles` does not pin the key;
    - `GAME_SIGNING_KEY` is not the private half of the pinned key.
  - A test checks that tweetnacl verifies the same signatures, so the web client can use it.
- **`tools/release/generate-signing-key.mjs`** is for the owner to run once.
  - With `--out` (mode 600, never overwrites), it writes the PEM to a file; without it, the PEM goes to stdout only.
  - The public key and the paste snippet go to stderr.
  - It was run here only into the scratchpad, as a throwaway for the dry run.
- **`tools/release/zip.mjs`** writes and reads deterministic ZIPs:
  - entries are sorted;
  - every timestamp is 1980-01-01 and permissions are fixed;
  - each file is deflated or stored, whichever is smaller;
  - the reader checks every CRC, and unsafe paths and symlinks are refused.
- **`tools/release/package-game.mjs`** writes `agent-empire-game-<v>.zip` and `game-manifest.json`.
  - The manifest holds `schema, name, version, file, bytes, sha256, files, entry, minShell, commit`.
  - The script refuses fixture builds and a missing `index.html`.
  - `minShell` comes from `tools/release/config.json`.
- **`tools/release/channel.mjs`** builds `channel-<stable|beta>.json` from the asset folder, with no network.
  - A final release writes both stable and beta channel files.
  - Signed macOS zips also get Squirrel.Mac static feeds (`desktop-update-darwin-<arch>.json`).
  - The fields it adds beyond the plan's example are listed in the plan's contract section.
- **`tools/release/play-upload.mjs`** is a Play Developer API v3 client with no dependencies. It runs the service-account JWT, then creates an edit, uploads the bundle, sets the track and commits. A third-party action never sees the credentials.
- **`tools/release/package-macos.mjs`** calls `@electron/packager` with its bundled `@electron/osx-sign` and `@electron/notarize`, which are already installed.
  - It signs with hardened runtime using `tools/release/macos-entitlements.plist`, which has JIT only.
  - It notarizes, staples, then checks with `codesign --verify`, `stapler validate` and `spctl`.
  - It makes the zip with `ditto` and the dmg with `hdiutil`.
  - It refuses to sign without notarization credentials.
- **`tools/prepare-desktop.mjs`** has two release-only changes:
  - the `--skip-archive` flag, so the Windows exe can be signed before zipping;
  - on a Windows host, `npm.cmd` runs through a shell, because Node refuses to start `.cmd` files without one.
- **`mobile/tools/build-android.py`** has two release-only additions:
  - `--release-keystore` and `--key-alias`, with passwords read only from `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_PASSWORD`;
  - `--aab --bundletool <jar>`: aapt2 proto link, then the base module, bundletool `build-bundle` + `validate`, then jarsigner.

### REL-02: `.github/workflows/release.yml`

**Jobs:**

| Job | Runner | What it does |
|---|---|---|
| `verify` | ubuntu | Tag rule, version check, key gate, `npm ci`, typecheck, build, build:cloud, test, no-fixture check |
| `game` | ubuntu | Game zip and manifest, coordinator asset (its sha256 must match the client's `coordinator.json`), manifest signature |
| `desktop-macos` | `macos-15` (arm64) and `macos-15-intel` (x64) | Builds the app. Developer ID signing and notarization turn on with their secrets |
| `desktop-windows` | windows-latest | Builds the app. Signs with a .pfx through the signtool vendored by `@electron/windows-sign`, or with Azure Artifact Signing |
| `android` | ubuntu | SDK 35, build-tools 35.0.0, JDK 17. bundletool 1.18.3 is checksum-pinned. Builds the APK and AAB with the upload key, or a labelled debug-signed APK |
| `play` | ubuntu | Uploads to the internal track. Tag only; needs its secrets |
| `ios` | macos-15 | Policy checks and a simulator Release build. On a tag with secrets: archive, export, and TestFlight upload |
| `assemble` | ubuntu | Channel files and their signatures, signature verification, `SHA256SUMS` |
| `publish` | ubuntu | `gh release create --verify-tag` with every asset. The only job with `contents: write`, and it has no secrets |

**Triggers and permissions:**

- It runs on `push: tags: ['v*']` and on `workflow_dispatch`. A manual run is a dry run: everything is built and uploaded as artifacts, and nothing is published.
- There is no pull_request trigger.
- Top-level `permissions: {}`. Each job declares its own.
- Concurrency is per ref, and runs are never cancelled.
- Secret values appear only in step `env`/`with`. Job-level env carries only `HAS_*` booleans. Refs are passed through env.

**Action pins.** Each was looked up with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`; annotated tags were dereferenced.

| Action | Version | Commit |
|---|---|---|
| actions/checkout | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| actions/setup-node | v7.0.0 | `820762786026740c76f36085b0efc47a31fe5020` |
| actions/upload-artifact | v7.0.1 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| actions/download-artifact | v8.0.1 | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` |
| actions/setup-java | v6.0.1 | `de7274f081f381c8f8158605e0321c36c376e2e6` |
| Azure/artifact-signing-action | v2.0.0 | `c7ab2a863ab5f9a846ddb8265964877ef296ee82` (tag object `208f8af…`; azure/trusted-signing-action redirects here) |

bundletool 1.18.3 is pinned by sha256 `a099cfa1…28e29`, taken from the release asset digest on GitHub.

## Secrets and variables

The full table, with where each value comes from, is in `docs/RELEASING.md`.

**Secrets:**

- `GAME_SIGNING_KEY` (required for a tag)
- `APPLE_DEVELOPER_ID_CERT_P12`, `APPLE_DEVELOPER_ID_CERT_PASSWORD`
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
- `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`
- `IOS_DIST_CERT_P12`, `IOS_DIST_CERT_PASSWORD`, `IOS_PROVISIONING_PROFILE_B64`
- `WINDOWS_CERT_P12`, `WINDOWS_CERT_PASSWORD`
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
- `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
- `PLAY_SERVICE_ACCOUNT_JSON`

**Variables:**

- `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`
- `PLAY_RELEASE_STATUS` (optional; `draft` until the first Play rollout)

The plan named only the first iOS certificate secret. Its password and profile secrets are named `IOS_DIST_CERT_PASSWORD` and `IOS_PROVISIONING_PROFILE_B64`. The Azure names are this lane's choice.

## Dependency decision needed (not added)

**Windows in-place updates need an installer framework.** Electron's built-in `autoUpdater` on Windows needs a Squirrel.Windows installer, and electron-packager does not make one. So Windows `auto` is always `false`: the app prompts and opens the download.

| Option | Package | Version | License | Unpacked size | Note |
|---|---|---|---|---|---|
| Recommended | `electron-winstaller` | 5.4.4 | MIT | ~30 MB (bundles the Squirrel.Windows binaries) | Smallest change: keeps electron-packager and adds a Squirrel installer and `RELEASES` feed |
| Alternative | `electron-builder` + `electron-updater` | 26.15.3 / 6.8.9 | MIT | 85 KB / 565 KB plus a large dependency tree | NSIS and DMG installers and its own updater on every platform. Replaces the packager flow |

macOS needed no new dependency: it uses the Squirrel.Mac static JSON feed plus the packager's bundled osx-sign and notarize.

## Verification

- `npm run typecheck`: pass.
- `npm test`: **421 pass**, 0 fail. That is 405 existing tests plus 16 in `tests/release-tools.test.ts`, which cover:
  - version mapping, ordering and Play limit;
  - invalid versions;
  - sync, check and drift detection on a copied tree;
  - the tag rule, plus "on main" against a temporary git repo;
  - sign/verify with tampering, wrong key, malformed signatures and tweetnacl interop;
  - the development-key gate and key matching;
  - zip CRC, unsafe paths and round trip;
  - game-bundle determinism (a different copy with different mtimes gives identical bytes) and refusals;
  - the beta, signed and stable channel builder and its refusals;
  - the Play JWT and the API call sequence, with a fake fetch;
  - static workflow rules: every `uses:` is pinned to a 40-character SHA with a version comment, no PR triggers, per-job permissions, only `publish` can write, the placement of secrets, and the gates being present.
- `npm run build` and `npm run build:cloud`: pass. `npm run version:check`: in sync across 7 files.
- **actionlint 1.7.12** (official darwin-arm64 binary, checksum verified, kept in the scratchpad): 0 findings. shellcheck was not installed, so the `run:` scripts were not shellchecked.
- **Local dry run** (scratchpad, throwaway key):
  - The real `dist/public` became a 79-file, 23.7 MB zip, byte-identical across two runs.
  - The manifest and channel files were signed, and both verified with the throwaway public key.
  - A tampered channel file failed verification.
  - `check-key` refused the development pinned key and the mismatched key.
- **Android release keystore path** (local SDK and JDK 17, throwaway PKCS12 upload key in the scratchpad): the release APK was signed by that key (`apksigner verify --print-certs`). `aapt2 dump badging` shows `versionCode='10000301' versionName='1.0.0-beta.1'`.

## Not verified

- **No GitHub Actions run.** No `act` and no fork tag. Runner behaviour is unverified for every job, including:
  - the `macos-15-intel` label (actionlint accepts it);
  - signtool and Azure signing on windows-latest;
  - `prepare-desktop` cross mode on a Windows host;
  - sdkmanager on ubuntu;
  - the iOS simulator build;
  - `xcodebuild -scheme AgentEmpire archive`. The project has no shared scheme and relies on xcodebuild creating one; adding a shared scheme is outside this lane.
- **The AAB path** (`--aab`: aapt2 `--proto-format`, bundletool, jarsigner). bundletool was not downloaded locally.
- **macOS signing, notarization and stapling; the dmg; Windows signing; the Play upload; the TestFlight upload.** None ran without real credentials. The Play client is tested only against a fake fetch.
- **The macOS bundle ID `com.agentempire.desktop`** set in `package-macos.mjs`. The packager default would have been `com.electron.agent-empire`. Changing it after the first signed release breaks in-place updates, so the owner should confirm it.

## Handoffs

- **Updater lane (REL-03/04):**
  - Read the key from `src/shared/release-key.ts`. Pin the same string in the desktop, Android and iOS shells, and add each pinning file to `tools/release/config.json` `pinnedKeyFiles`.
  - Treat `RELEASE_KEY_IS_DEVELOPMENT` as "never trust updates".
  - Clients must ignore unknown channel fields. Use `shell.macos.feed.<arch>` for Squirrel.Mac and `shell.android.sha256` before installing an APK.
  - If the shells add files that the Windows stage must copy, extend `DESKTOP_FILES` in `tools/prepare-desktop.mjs`.
- **Owner:**
  - Generate the signing key and paste the public key.
  - Set the secrets, following `docs/RELEASING.md`.
  - Choose the Windows installer dependency.
  - Confirm the macOS bundle ID.
