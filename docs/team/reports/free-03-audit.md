# FREE-03 audit: secrets, personal data and history (2026-10-23)

Scope: every commit reachable from all 57 remote branches and tags (570 commits, `git fetch origin '+refs/heads/*:refs/remotes/origin/*'` first), plus the working tree of `claude/free-03-open-source` at `aba620d`. All values below are redacted. Nothing was rewritten, rotated or changed on GitHub.

## Result

**No true secret was found in the tree or in history.** One item of **personal data** is in the commit metadata (author emails), which becomes public with the repository. It needs an owner decision before the visibility flip (see "Owner decision" below). Everything else is a false positive or deliberate fixture data.

## Method

| Check | Tool | Coverage |
| --- | --- | --- |
| Secrets in history | gitleaks 8.x default rules, `--redact`, over `git log -p --all --full-history` (15.6 MB of patches) | 570 commits, all branches. `gitleaks git` itself is blocked by this agent's worktree guard, so the same rules ran over the exported patch stream; findings were mapped back to commit and file. |
| Secrets in the working tree | `gitleaks dir --redact` | the whole checkout |
| Private paths, emails, phone numbers, IPv4, private-key blocks, GitHub/Anthropic/OpenAI/AWS/Google/Slack token shapes, owner identifiers, the `AgentEmpire-credentials` name | a TypeScript scanner over added lines of every history patch | 570 commits |
| Key-like files ever committed (`.pem .p12 .pfx .jks .keystore .key .p8 .mobileprovision .der .env`, `id_rsa`, `id_ed25519`) | file-name scan of `git log --all --name-only` | every path ever tracked |
| Personal data in screenshots | tesseract OCR of all 426 report/screenshot images in the tree, plus the 10 images that were later deleted from history (extracted from their commits); visual spot checks of the real-device, GitHub device-flow and desktop update captures | `docs/team/reports/**` and app icons. Not OCRed: 120 avatar textures and Poly Haven textures (third-party art, no UI text). |
| Commit metadata | `git log --all --format='%an <%ae>'` | all commits |

## Findings

### True secrets: none

- No private key block (`BEGIN … PRIVATE KEY`), no key-like file, no live-format token was ever committed.
- `AgentEmpire-credentials` appears once, in `docs/RELEASING.md`, as the name of the owner's offline folder. No key material from it is in the repository. The folder lives outside the repo; the release secrets are set as **environment** secrets of `release` by `setup-github-release.sh` (checked: every `gh secret set` uses `--env release`). The repository currently has no repository-level secrets and no `release` environment yet.

### False positives (gitleaks `generic-api-key`, 8 in the tree, 12 in history)

| Location | Commits (first seen) | What it is |
| --- | --- | --- |
| `src/client/update/trust.ts`, `desktop/update-store.cjs` `DEV_KEY_SHA512` | c053bd8 | SHA-512 digest of the **public** development key |
| `desktop/update-store.cjs` `RELEASE_PUBLIC_KEY`, `docs/team/reports/rel-07-pin-key.md`, `docs/RELEASING.md` | b6e470e | the owner's Ed25519 **public** release key (meant to be public) |
| `tests/in-app-updates.test.ts`, `tests/release-tools.test.ts` `OWNER_KEY` | c053bd8, 3533852 | the same public key in tests |
| `mobile/android/tests/PolicyTest.java` `devKey` | 5a96192, 3454e85 | the public development key (its private half is derived from a published seed by design, REL-07) |
| `tests/endpoint.test.ts` `TOKEN`, `tests/desktop-bridge.test.ts` `github.token` | 033db17, c3fe704 | made-up test tokens |
| `tests/cloud-github.test.ts` `key:` | 6f786c9, 584fb5a | fake GitHub Actions public key in a mock server |

The scanner's token-shape hits are all fixtures: `gho_FAKEFIXTURE…`, `ghp_classic000…` and `sk-ant-FAKE-fixture-only-…` in `tools/setup-ui-check.ts`, `tools/cloud-seed.ts` and `tools/cloud-ui-check.ts`. IPv4 hits are `127.0.0.1`, `10.0.2.2` (Android emulator host), the documentation range `203.0.113.7`, and numbers inside SVG paths and version strings. "Phone numbers" are SVG coordinates in `src/client/consultancy.html`. `/home/office/` in `deploy/provision.sh` is the provisioned service user, not a person.

### Personal data

| Item | Where | Assessment |
| --- | --- | --- |
| **Owner's personal email addresses as commit author** (two Gmail addresses, `j…@gmail.com` and `j…@gmail.com`) | metadata of ~416 commits on all branches | **Becomes public with the repo.** Not a secret, but personal data. Needs an owner decision. |
| Upstream contributors' author emails (Web Dev Cody and four others) | 151 inherited commits from AgentSystemLabs/agent-office | Already public in the upstream repository. No action. |
| `Billioncodes001` (GitHub username) | docs, update reports | The repository owner's public handle. No action. |
| Email addresses in text | tests, fixtures, docs | All are `*.example`, `example.com`, `example.invalid`, `users.noreply.github.com` or a package author in a lockfile. No real person. |
| Screenshots | 436 images | Only fixture data was found: "UI fixture · synthetic data" banners, `*-fixture.example` and `*-preview.example` addresses, `127.0.0.1`. The Android device-flow capture shows a one-time GitHub user code that expired within 15 minutes of capture and grants nothing. Real-device captures show only the app and system UI (clock, battery, signal), no account names or notifications. |
| Private paths (`/Users/…`, `C:\Users\…`) | none | No hit in any tracked file or added line in history. |

## Owner decision: author emails

Choose one before making the repository public:

1. **Accept** (simplest). The addresses are visible in `git log` to anyone who clones. Set future commits to the noreply address: `git config --global user.email "<id>+<user>@users.noreply.github.com"` and enable "Block command line pushes that expose my email" in GitHub email settings.
2. **Rewrite history** (only before the flip; disruptive). With `git filter-repo` on a fresh mirror clone:
   ```sh
   git clone --mirror git@github.com:Billioncodes001/agent-empire.git ae-mirror && cd ae-mirror
   printf '%s\n' 'Billioncodes001 <ID+Billioncodes001@users.noreply.github.com> <first-personal-address>' \
                 'Billioncodes001 <ID+Billioncodes001@users.noreply.github.com> <second-personal-address>' > ../mailmap
   git filter-repo --mailmap ../mailmap
   git push --force --mirror   # rewrites every SHA: open PRs, worktrees, pinned commit references and signed tags break
   ```
   Every branch, worktree and reference to a commit SHA (reports cite many) changes, and all agents must re-clone. Only an owner can authorise a force push. GitHub's cached PR refs (`refs/pull/*`) keep the old commits until GitHub support purges them.

No secret needs rotating.

## Pinned action SHAs

Re-verified with `git ls-remote --tags` against upstream (read-only). All match their version comment.

| Action | SHA | Tag |
| --- | --- | --- |
| actions/checkout | 3d3c42e5aac5 | v7.0.1 |
| actions/setup-node | 820762786026 | v7.0.0 |
| actions/upload-artifact | 043fb46d1a93 | v7.0.1 |
| actions/download-artifact | 3e5f45b2cfb9 | v8.0.1 |
| actions/setup-java | de7274f081f3 | v6.0.1 |
| Azure/artifact-signing-action | c7ab2a863ab5 | v2.0.0 (annotated tag; the pin is the commit, correct) |
| actions/checkout (cloud worker template, `src/cloud/workflow.ts`) | 11bd71901bbe | v4.2.2 |
| actions/setup-node (cloud worker template) | 49933ea5288c | v4.4.0 |
