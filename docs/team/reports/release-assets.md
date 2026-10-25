# Release assets clean-up

Branch `claude/release-assets` (from `origin/codex/empire-world` at `759480d`, whose tree is identical to tag `v1.0.0-beta.1`). Author slice; it needs an independent review and a dry run before it is merged. Nothing was tagged, dispatched or pushed, and the published v1.0.0-beta.1 release was not touched.

## Requirements (recorded before coding)

1. Files people download get clear, human names. Signing state and architecture codes move out of the names and into the release notes and the signed channel file.
2. Every asset that no user and no updater needs is removed.
3. Consolidate only where every reader can be updated together and installed apps can still update.
4. Installed v1.0.0-beta.1 apps must still detect, verify and install 1.0.0-beta.2. This is proved with tests that run the beta.1 code itself.
5. Update `channel.mjs`, `sign.mjs` (it needed no change: it never handled names), `release.yml`, the docs and the release-notes guidance.

## Decision: no version in the names people download

The names for people are `Agent-Empire-Mac-Apple-Silicon.dmg`, `Agent-Empire-Mac-Intel.dmg`, `Agent-Empire-Windows-Setup.exe` and `Agent-Empire-Android.apk`. They carry no version, for three reasons:

- **Permanent links.** A version-free name makes `https://github.com/Billioncodes001/agent-empire/releases/latest/download/Agent-Empire-Android.apk` a link that always gives the newest stable build, for the README, a website or winget. Versioned names make every such link go stale at each release.
- **The version is shown elsewhere.** It is in the release title, the tag, the download URL path (`/releases/download/v1.0.0-beta.2/…`) and the app's About screen.
- **No updater needs it.** The updaters work from URLs in the signed channel, and those URLs already contain the tag, so a name only has to be unique within one release.

The cost: two downloads of different versions in one Downloads folder look alike (the browser appends "(1)"). That is acceptable for apps that update themselves.

Machine files keep the names installed apps depend on (`channel-beta.json`, `AgentEmpire-<nuget>-full.nupkg`, `RELEASES-darwin-<arch>.json`). The game zip keeps its versioned name because nobody downloads it by hand, and renaming it would gain nothing.

## Before and after

v1.0.0-beta.1 published 19 assets. With unsigned desktop builds (the current state of the signing secrets), 1.0.0-beta.2 publishes 8.

| beta.1 asset | Who needs it | beta.2 |
|---|---|---|
| `Agent-Empire-1.0.0-beta.1-macos-arm64-unsigned.dmg` | people (Apple Silicon Mac) | **kept**, renamed `Agent-Empire-Mac-Apple-Silicon.dmg` |
| `Agent-Empire-1.0.0-beta.1-macos-x64-unsigned.dmg` | people (Intel Mac) | **kept**, renamed `Agent-Empire-Mac-Intel.dmg` |
| `Agent-Empire-1.0.0-beta.1-macos-arm64-unsigned.zip`, `…-x64-unsigned.zip` | Squirrel.Mac, but only for Developer ID builds. An ad-hoc app never updates in place: `auto: false`, and `macDeveloperIdSigned` refuses | **removed** while unsigned. Signed builds publish `Agent-Empire-Mac-<Apple-Silicon\|Intel>-Update.zip` plus `RELEASES-darwin-<arch>.json` |
| `Agent-Empire-1.0.0-beta.1-windows-x64-Setup-unsigned.exe` | people (Windows) | **kept**, renamed `Agent-Empire-Windows-Setup.exe` |
| `Agent-Empire-1.0.0-beta.1-windows-x64-unsigned.zip` | nobody: a portable folder with no reader, which duplicates the installer | **removed** |
| `AgentEmpire-1.0.0-beta001-full.nupkg`, `RELEASES` | Squirrel.Windows, but only when `auto` is true (a signed build). Unsigned, the shell never fetches them | **removed** while unsigned. Kept, under the same names, for signed builds |
| `Agent-Empire-1.0.0-beta.1-android.apk` | people (Android); sideloaded apps update with it (URL and sha256 from the channel) | **kept**, renamed `Agent-Empire-Android.apk` |
| `Agent-Empire-1.0.0-beta.1-android.aab` | the Play upload job only | **removed** from the release. It is now the `play-bundle` workflow artifact, checked by sha256 before upload |
| `agent-empire-game-1.0.0-beta.1.zip` | every app's over-the-air game update | **kept** (name pattern unchanged) |
| `game-manifest.json`, `game-manifest.json.sig` | nobody: no shipped app fetches them, and the signed channel already has the zip's URL, sha256, bytes and minShell | **removed**. Folded into the channel (`game.commit` added); the manifest is now only an input to the channel builder |
| `agent-empire-coordinator.mjs` | cloud mode: the beta.1 client downloads the raw `.mjs` from `coordinator.url` and checks its sha256 | **kept** (same name; it cannot go into an archive, see below) |
| `channel-beta.json`, `channel-beta.json.sig` | every installed app | **kept** (same names) |
| `SHA256SUMS` | people verifying by hand; the Play job | **removed**. Replaced by the channel's signed `assets` list (sha256 and size of every other file). The old file was unsigned, so this is stronger. GitHub also shows each asset's sha256 on the release page |

**Final beta.2 list (8 files), unsigned desktop builds and signed Android:**

```
Agent-Empire-Android.apk
Agent-Empire-Mac-Apple-Silicon.dmg
Agent-Empire-Mac-Intel.dmg
Agent-Empire-Windows-Setup.exe
agent-empire-coordinator.mjs
agent-empire-game-1.0.0-beta.2.zip
channel-beta.json
channel-beta.json.sig
```

Once Apple and Windows signing are configured, six files are added (14 in total): `Agent-Empire-Mac-Apple-Silicon-Update.zip`, `Agent-Empire-Mac-Intel-Update.zip`, `RELEASES-darwin-arm64.json`, `RELEASES-darwin-x64.json`, `AgentEmpire-1.0.0-beta002-full.nupkg` and `RELEASES`. A final (stable) release adds `channel-stable.json` and its `.sig`.

## How it works now

- `tools/release/assets.mjs` is the single source of every name. It also defines **build info**: each platform job writes `release/build-info/<platform>[-<arch>].json` = `{platform, arch, signed}`. Previously the channel builder guessed the signing state from `-unsigned` and `-debug-signed` in file names.
- Each platform job uploads `release/assets` (files that may be published) and `release/build-info` together. `assemble` merges them into `release/`.
- `channel.mjs` plans the release from both folders. It refuses three things:
  - an unplanned file (for example an old-style name or a stray `SHA256SUMS`);
  - a platform file without build info, or build info without its file;
  - an update payload for an unsigned build, since no reader exists for it.

  It then writes the channel files and the macOS feeds, and puts the sha256 of every file into `assets`.
- After signing, `channel.mjs check-publish` proves `release/assets` holds exactly the files the signed channel lists, byte for byte, plus each channel's `.sig`. The publish job uploads that folder.
- The game job no longer signs anything. It therefore has no secrets and no `release` environment, which means one fewer approval on a tag run.

## Compatibility analysis (installed v1.0.0-beta.1)

I read the code tagged `v1.0.0-beta.1` (`git diff v1.0.0-beta.1 origin/codex/empire-world` is empty for the whole tree). This is what each reader needs, and what beta.2 publishes for it:

| Reader (beta.1) | What it reads, by name or pattern | beta.2 |
|---|---|---|
| Client `source.ts` / `channel.ts` `newestPrereleaseTag` | the newest pre-release whose asset list contains `channel-beta.json` **and** `channel-beta.json.sig` | both published, same names |
| Client `parseChannel` | URLs must be `github.com/<repo>/releases/download/<tag>/<segment>` with segment `^[A-Za-z0-9._+-]{1,128}$`; the game, coordinator and nupkg URLs must use tag `v<version>`; no file-name regex except the stable mac feed `^RELEASES-darwin-(arm64\|x64)\.json$`; unknown fields are ignored | all names match the segment pattern; URLs are tagged; the new `assets` and `game.commit` fields are ignored; `game.manifest` and `manifestSig` were never read |
| Desktop `update-store.cjs` `signedRelease` | `releases/download/v<version>/channel-beta.json(.sig)`, checked with the pinned key | published |
| Desktop `windowsPackage` | `shell.windows.downloads.x64.nupkg` whose file is exactly `AgentEmpire-<nuget>-full.nupkg` from tag `v<version>`; only called when `auto` is true | same name for signed builds; unsigned builds have `auto: false`, so it is never called |
| Desktop `main.cjs` Squirrel.Windows | writes its own local `RELEASES` and never fetches the published one | `RELEASES` kept for signed builds only, so the GitHub folder stays a genuine Squirrel feed |
| Desktop / client macOS | `shell.macos.feed[arch]` (any tagged asset, or `RELEASES-darwin-<arch>.json` under `latest/download`); Squirrel.Mac then downloads the zip URL inside the feed | feed names unchanged; the zip name is free because it is referenced by URL |
| Android `GameUpdater` / `UpdatePolicy` | `releases/download/v<version>/channel-beta.json(.sig)`; `game.url/sha256/minShell`, `shell.android.url/sha256` must match the page's request; URL segments `[A-Za-z0-9._+-]{1,128}`; tagged assets only | unchanged fields; the new APK name passes |
| iOS `GameUpdater` / `UpdatePolicy` | the same channel URL; `releaseMismatch` on `schema`, `version`, `tag`, `game.url/sha256/minShell` | unchanged |
| Cloud coordinator (client `updateCoordinator`) | downloads `coordinator.url` (a tagged asset) as raw text when the bundled copy differs, and checks its sha256 | same raw `.mjs`, same name |

**Renames.** No shipped reader matches a human file name, so the renames need no compatibility aliases. The renamed APK, DMGs and installer reach installed apps only through URLs in the signed channel.

**Consolidation that was rejected:**

- **The coordinator and game bundle in one archive.** Rejected: the beta.1 client downloads `coordinator.url` and hashes the response as the coordinator text itself. A URL into an archive is impossible, so beta.1 apps in cloud mode would fail to update their coordinator.
- **Dropping `channel-beta.json.sig` as a separate file.** Impossible: all four shells fetch it by name.
- **SHA256SUMS** was folded into the signed channel instead (above).

**Known external break: Obtainium.** It is not part of the app, but DISTRIBUTION.md told users to filter on `^Agent-Empire-[0-9][^/]*-android\.apk$`. Users who set that filter will find no APK in beta.2 until they change it to `^Agent-Empire-Android\.apk$` (or remove it, since each release has one APK). A compatibility alias would mean publishing the APK twice, which defeats the purpose. Instead, the docs and the release-notes guidance tell those users what to change. In-app updates are unaffected.

**Behaviour that did not change:**

- A tag run without the Android upload key still publishes a debug-signed APK. Its name no longer says so; `signed: false` in the channel and the release notes have to.
- Installing such an APK over a release-signed app fails, exactly as before.

## Test evidence

Commands run in this worktree, Node 24, macOS:

- `npm run typecheck`: passed.
- `npm test`: 982 tests, **981 passed, 0 failed, 1 skipped**. The skip is `N1: actionlint accepts the generated workflows`, because actionlint is not installed. It was skipped before this change too.
- `npm run build`: passed (`check-trust dist/server`: no development key trust).
- `release.yml` parses as YAML, with jobs verify, game, desktop-macos, desktop-windows, android, ios, assemble, publish and play.
- **CLI dry run of the assemble path** (local, real CLIs, development signature):
  - The commands run: `package-game.mjs --manifest-dir`, then `assets.mjs build-info` ×4, then `channel.mjs`, then `sign.mjs sign --dev`, then `channel.mjs check-publish`.
  - Result: exactly the 8 files listed above.
  - Adding a stray `SHA256SUMS` made `check-publish` fail ("is not listed in channel-beta.json and must not be published").

New and changed tests:

- `tests/release-compat.test.ts` (new). It runs **frozen copies of the v1.0.0-beta.1 readers** (`tests/compat/beta1/`, extracted with `git archive v1.0.0-beta.1`) against a beta.2 release built by today's tools. A fake GitHub serves only the files that would be published, so a 404 on a dropped file would fail the test.
  - **beta.1 client.** `fetchChannel('beta')` finds `v1.0.0-beta.2` through the listing filter and verifies the Ed25519 signature. `decide` then:
    - offers the game install, whose served bytes match the signed sha256, with `minShell` 1.0.0-beta.1;
    - opens the release page for unsigned Mac and Windows builds;
    - gives sideloaded Android the renamed APK, with a matching sha256;
    - downloads the coordinator raw, with a matching sha256.

    Every URL the client requested was published.
  - **beta.1 desktop shell (unsigned and signed).** `signedRelease` re-verifies the channel, and `checkGameAgainstRelease` accepts it. The bridge policy allows every URL the page asks for. With signed builds:
    - Squirrel.Mac gets the per-arch feed, and the zip it points to is served with the signed sha256;
    - `windowsPackage` accepts `AgentEmpire-1.0.0-beta002-full.nupkg`, which is served with a matching sha256.

    Unsigned: no feed, and `windowsPackage` refuses, as in beta.1.
  - **beta.1 Android and iOS.** The test reads the URL segment patterns and the channel-URL templates from the frozen Java and Swift sources. It checks every published name and every installed URL against them, and checks the Ed25519 signature over the same bytes. It runs a transcription of `releaseMismatch` (Java and Swift); each transcription is anchored to the exact frozen source lines.
  - **Static check.** No beta.1 reader mentions any dropped file (`SHA256SUMS`, `game-manifest`, `.aab`, `windows-x64`, `-unsigned`, …).
  - **Fixture integrity.** The frozen files are byte-identical to `git show v1.0.0-beta.1:<path>`. This test skips only when the tag is missing from a clone.
- `tests/release-tools.test.ts`:
  - new tests for names (plain, unique, URL-safe), build info, unsigned and signed asset sets, stable plus beta channels, refusal of a wrong staging folder, and `checkPublished`;
  - the workflow tests updated: the game job has no secrets; Play uses `play-bundle`, checked by sha256;
  - a new test pins the staged paths, the names, `check-publish` and the absence of SHA256SUMS and old labels.
- `tests/update-roundtrip.test.ts`: ported to the staged layout. The new channel still parses in today's client and desktop policy for stable and beta, signed and unsigned.

## Review fixes (after the coordinator's review; the dry run, run 40186581018, published exactly the 8 files)

1. **DISTRIBUTION.md was corrupted.** My doc script used `String.replace`, and the Obtainium replacement contained `` $` ``, which inserts the text before the match. The file body ended up spliced into the table three times.
   - Fix: restored the file from `759480d` and re-applied the edits with an exact, single-occurrence split/join. I also moved the permanent-links paragraph below the platform table, where it had split off the iPhone row.
   - I checked the other scripted edits (`release.yml`, RELEASING.md, RELEASE_PLAN.md, the winget template); none had a special `$` pattern in a replacement.
   - New `tests/docs-integrity.test.ts` checks that:
     - each doc has one top-level heading outside code fences;
     - the title text occurs once anywhere in the file (fence-independent);
     - every table starts with a header and separator row;
     - the DISTRIBUTION.md Obtainium cell is the filter RELEASING.md documents.

     All three tests fail on the corrupted `b5e6899` file and pass on the fixed one.
2. `writeRelease` now refuses `channel-*.json`, any `.sig` and `RELEASES-darwin-*` arriving in `release/assets` from build artifacts, before writing anything. Otherwise `release.yml` would production-sign a stray channel file.
3. **macOS feeds.** A feed is written only when the channel says `macos.auto: true`. Mixed macOS signing (one arch signed, one not) is refused, so a signed payload can never sit next to `auto: false`.
4. **Manifest and comments.**
   - `packageGame` requires `manifestDir`, and it must differ from `outDir`. The CLI default is `release/build-info`.
   - The `sign.mjs` header now says the channel file is the only signed file.
5. The game manifest's `bytes` must equal the zip's real size.

## Not verified

- **No workflow run.** I did not run a dry run or a tag release (as instructed). Three things need the owner's dry run:
  - the multi-path artifact layout (`release/assets` and `release/build-info` uploaded together and merged into `release/`);
  - the Windows `--signed "${WINDOWS_SIGNED:-false}"` path, and the Azure step signing `Agent-Empire-Windows-Setup.exe`;
  - the new `setup-node` step in the Android job.
- **Signed desktop paths.** They are exercised only with fake files in tests. No Developer ID or Authenticode build was produced.
- **Shell code was not run.** The Android and iOS checks run JavaScript transcriptions, anchored to the frozen sources, not the Java or Swift code. No device or emulator run was done.
- **Obtainium** was not tested; its new filter is documented only.
