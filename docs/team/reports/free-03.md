# FREE-03: open-source readiness and free distribution

Branch `claude/free-03-open-source`, based on `aba620d`. Not pushed. No GitHub setting was changed.

## Audit result

No true secret in the tree or in any of the 570 commits on all branches (gitleaks plus a pattern scan, OCR of every screenshot, including deleted ones). All gitleaks hits are public keys, key digests or fake test tokens. Screenshots contain only fixture data. **One personal-data item:** the owner's personal email addresses are the author of about 416 commits and become public with the repository. Details and options are in [free-03-audit.md](free-03-audit.md). All pinned action SHAs were re-verified upstream.

## What changed

- **Repository files:** `LICENSE` (MIT, "Billioncodes001 and contributors"), `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1 by reference), `.github/ISSUE_TEMPLATE/` (bug report, feature request, private-advisory link). `package.json` and `desktop/package.json` have matching `license`/`author` fields. `THIRD_PARTY_NOTICES.md` has a redistribution review: everything is compatible. One flag: the upstream Agent Office MIT grant exists only in its package metadata.
- **macOS:** unsigned builds are now ad-hoc signed and verified (`package-macos.mjs`). The Developer-ID check that decides between an in-place update and the download prompt is a tested helper (`macDeveloperIdSigned`). Ad-hoc apps always get the download prompt.
- **PWA:** the service worker also caches fingerprinted `/assets/` build files (public, immutable). It still never caches `/api`, pages, models, textures, audio or requests with an `Authorization` header. Fixed a pre-existing bug: the offline page's icon was precached but never served offline. `tools/pwa-check.ts` runs the real office over HTTPS in Chrome. Result: 20/20, screenshots in `free-03/`.
- **Docs:** `docs/DISTRIBUTION.md` (Open Anyway, SmartScreen, SignPath checklist, winget, Obtainium/IzzyOnDroid, Google verification, Add to Home Screen) and `docs/distribution/winget/` templates. README has a short download/licence section.
- **release.yml:** checked for a public repository. There is no `pull_request` or `pull_request_target` trigger, so fork PRs get nothing. Jobs join `release` only on tag pushes. The dry-run `workflow_dispatch` reads no secret. `permissions: {}` is the default. All actions are pinned by SHA. The only edit is the macOS ad-hoc warning text.

## Checks

`npm run typecheck` passes. `npm test` 719/719, `npm run build` passes, `tools/pwa-check.ts` 20/20, `tools/mobile-ui-check.ts` 411/411 against the UI fixture on 4701. Not run: a tagged release, a real macOS ad-hoc package, PWA install on a physical iPhone.

## Before you make it public

1. **Decide on the author emails** ([free-03-audit.md](free-03-audit.md#owner-decision-author-emails)): accept them, or rewrite them with `git filter-repo` **before** the flip. Either way, switch to your GitHub noreply address for future commits.
2. Merge this branch, then flip visibility yourself:
   ```sh
   gh repo edit Billioncodes001/agent-empire --visibility public --accept-visibility-change-consequences
   ```
3. Create the `release` environment, tag rule and secrets:
   ```sh
   ~/AgentEmpire-credentials/setup-github-release.sh
   ```
   Do this before the first public tag. Otherwise the Android APK is debug-signed and cannot update.
4. Enable private vulnerability reporting (SECURITY.md relies on it):
   ```sh
   gh api -X PUT repos/Billioncodes001/agent-empire/private-vulnerability-reporting
   ```
   Or use Settings → Code security → Private vulnerability reporting → Enable.
5. Turn on MFA for every account with write access, then apply to SignPath Foundation using the checklist in `docs/DISTRIBUTION.md`.
6. Optional: request IzzyOnDroid inclusion, and submit winget manifests for the first stable release.
