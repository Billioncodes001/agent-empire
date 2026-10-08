# REL-07: pin the owner's release key

Branch `claude/rel-07-pin-key`, based on `origin/codex/empire-world` at ae8bda5.

## What changed

- `RELEASE_PUBLIC_KEY` is now the owner's key, `rIRaOVUyoolaIritW/W8zMW7kGymgcjvg7uXhHtTqPk=`. It is set in `src/shared/release-key.ts`, `desktop/update-store.cjs`, Android `UpdatePolicy.java` and iOS `UpdatePolicy.swift`. The owner generated it offline; no private key was generated, seen or used here.
- `RELEASE_KEY_IS_DEVELOPMENT` is gone. Each build now has a set of trusted keys. A release build trusts only the owner key. A development build also trusts the public dev key, so the local update fixture keeps working.
- Every verify call site uses its build's trusted set: the page's `verifyChannel`/`fetchChannel`/`UpdateService`, desktop `signedRelease`, Android `GameUpdater`, and iOS `GameUpdater`. Each key is checked separately, so one signature always has exactly one signer. The release workflow still signs with exactly one key: `GAME_SIGNING_KEY` on tag runs, `--dev` on dry runs.

## Development trust, per platform

| Platform | Mechanism | Proof that release builds exclude it |
|---|---|---|
| Web page | `vite.config.ts` defines `__AGENT_EMPIRE_DEV_UPDATE_KEY__` only when `command === 'serve'` or `--mode fixture`. It reads the key from `release-key.ts`; no client module imports the dev key (`src/client/update/trust.ts`). | `npm run build` produced a `dist/public` with 0 dev-key hits; the owner key is in `main-*.js`. `tools/check-no-fixture.mjs` (run by `build:client`, `prepare-desktop`, `package-game`) now also refuses the dev key. The fixture build carries it and is refused. |
| Desktop | Build time, not an environment variable. `prepare-desktop.mjs --dev-updates` writes `desktop/dev-trust.json`, which holds the key, and every other prepare deletes it. `update-store.cjs` does not contain the dev key string. Only with that file does it trust the key, honour `--empire-update-fixture`, and report `devReleaseKey`. | The release workflow never passes `--dev-updates`, dry runs included. A new step asserts there is no `dev-trust.json`, and `sign.mjs check-trust` scans the shell files and `runtime/public` (macOS) or the whole packaged app (Windows). `.gitignore` excludes the file. |
| Android | Per-variant source sets: `app/src/debug/java/.../DevTrust.java` holds the key, and `app/src/release/java` holds `null`. `build-android.py` compiles one of them, and PolicyTest runs once per variant (`-Dae.variant`). | `build-android.py` decompresses every APK entry and fails the release build if the dev key is present. Result: "release APK development-key check: absent from every entry". `unzip -p … classes.dex` found the dev key 0 times in the release dex and 1 time in the debug dex. |
| iOS | `#if DEBUG` / `#else nil`. `Checks/run.sh` now compiles and runs the checks twice, without and with `-D DEBUG`. | The simulator Release build passes `sign.mjs check-trust`; the Debug build is flagged. The workflow runs check-trust on its Release simulator build. |

Development shells send `devReleaseKey` in `update.nativeInfo`, and the page adds it to its trusted set (`trustedKeys()`). This lets the production page inside a debug shell (and `tools/update-ui-check.ts`) verify dev-signed fixtures. Release shells never send it, and each shell verifies the signed release again with its own set before installing anything.

## Release gate

`checkPinnedKey` (`sign.mjs check-key`) now also runs `checkReleaseTrust`. It refuses a release in any of these cases:

- the dev key appears in desktop shell files, `src/client`, Android `src/main` or `src/release`;
- a client module imports `DEV_RELEASE_PUBLIC_KEY`;
- the dev key appears outside `#if DEBUG` in the iOS sources;
- the Android release `DevTrust` is missing;
- `desktop/dev-trust.json` exists.

It still refuses the dev key as `RELEASE_PUBLIC_KEY` and any shell that does not pin the owner key. The new CLI `check-trust <dir|file>…` scans built output byte by byte. The repository passes `check-key`.

## Checks

- `npm run typecheck`: pass. `npm test`: 583/583, with new gate, desktop and page trust tests.
- `npm run build`: pass, no dev key in `dist/public`.
- Android `build-android.py --variant all`: PolicyTest 708 checks passed for each variant; release and debug APKs built (debug-signed).
- `sh mobile/ios/Checks/run.sh`: all checks passed in Release and Debug.
- iOS simulator Debug and Release builds (`CODE_SIGNING_ALLOWED=NO`, scratch SYMROOT, not installed): both succeeded. The only Swift warning is an existing one at `GameView.swift:314`.
- `tools/update-ui-check.ts` against the UI fixture on port 4718 and its own update fixture: 57 PASS, "All update UI checks passed". Evidence: `rel-07-pin-key/*.jpg` (desktop 1440×900 and 375×812 reduced-motion update dialog). The regenerated in-app-updates screenshots were reverted.
- actionlint: not installed on this host.

## Open issues

- Not run: `prepare-desktop.mjs --dev-updates`, which needs a desktop `npm ci` into `runtime/`, plus `tools/update-desktop-check.ts` and the device or emulator fixture runs. The desktop logic is unit-tested (`readDevTrust`, trusted sets, `signedRelease`).
- The workflow's check-trust steps have not run in CI yet. Running one dry run would prove them.
- Anyone with write access to an installed desktop app could add a `dev-trust.json`. On macOS that breaks the code signature. It is the same trust boundary as editing `update-store.cjs`.
