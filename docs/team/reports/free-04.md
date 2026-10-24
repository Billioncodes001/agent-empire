# FREE-04: free cloud mode on GitHub Actions

Branch `claude/free-04-actions`, from `codex/empire-world` at 8512264. Author: Claude (Engineer lane). Not pushed and not merged; it needs an independent security review first.

## What it does

Cloud setup now offers three engines:

| Engine | Where it runs | What the user provides | Cost shown |
| --- | --- | --- | --- |
| **Free · Qwen Code** | GitHub Actions in the project repository | One model source, picked in this order: their self-hosted runner with Ollama, a free hosted key (`FREE_LLM_API_KEY`), or the small CPU model | free run (US$0) |
| **Claude subscription** | GitHub Actions, using `claude-code-action` | `CLAUDE_CODE_OAUTH_TOKEN`, set in their own terminal (or `ANTHROPIC_API_KEY`) | "billed to your Claude plan" (an API-key run shows Claude Code's estimate instead) |
| **API keys** | Anthropic Managed Agents | A key sealed in the UI, as today | provider list cost |

The **API keys** path is unchanged and is still the default. The Anthropic adapter only gained a type guard that refuses a non-Anthropic execution.

## Code

- **`src/cloud/actions-spec.ts`** (browser-safe):
  - engines and model sources, settings validation (strict patterns for every value that reaches YAML), and honest labels;
  - the result-artifact schema, the rotation reminder (11 months) and the subscription checklist;
  - the pins below.
- **`src/cloud/job-workflow.ts`**: the job workflow generator.
  - Trigger and permissions: `workflow_dispatch` only, `permissions: {}`, and job-level `contents: write` (plus `pull-requests: write` when PRs are on). No `pull_request_target`.
  - Guards: `if: github.repository == '<owner>/<repo>'`, a concurrency group per job, and a fixed `timeout-minutes`.
  - Checkout uses `persist-credentials: false`.
  - The task travels base64-encoded in an input, goes through `env:`, is checked against the base64 alphabet and decoded to `.agent-empire-task/task.md`. Every engine gets a fixed instruction to read that file.
  - Qwen runs with no GitHub token in its environment.
  - A deterministic step commits, pushes `agent-empire/task-<id>` (never a force-push) and opens a draft PR. Then `jq` builds `result.json`, which is uploaded as the run's only artifact.
- **`src/cloud/actions-adapter.ts`**: the `GitHubActionsAdapter`.
  - Dispatch uses `return_run_details: true`, and the session id is `ghrun_<id>`.
  - Each poll re-checks that the run title still matches the job, its budget and its turn cap. If it doesn't, the caps are unconfirmed and the job is marked `unknown`.
  - Artifacts are size-checked before download. The token is never sent to the blob-storage redirect. A bounded zip reader handles the archive.
  - `interrupt` cancels the run. `archive` closes the run record.
- **`provider.ts`**: `ProviderRouter`, `canDispatchFor(execution)` and `costBasis`.
- **`schema.ts`**:
  - executions are a union of `anthropic` and `github-actions`, and jobs carry `provider`;
  - `ghrun_` session ids and an `actions` cursor;
  - a `run_caps` reservation basis (always 0 cents);
  - cost bases `free_run`, `claude_plan` (both always 0) and `engine_reported_estimate`, with the ledger field `estimatedCostCents`.
- **`tick.ts`**:
  - jobs take their provider from the execution;
  - free and subscription runs get a zero-money reservation;
  - the dispatch cursor is stored;
  - cost is recorded with its basis.
- **`cli.ts`**: `providersFromEnv` builds the router. The coordinator never reads a Claude token.
- **`actions-setup.ts`**:
  - `checkJobSecret` lists secret **names** only (`GET actions/secrets`). It has no parameter that could take a token.
  - `installJobWorkflow` commits the workflow, and skips the commit when nothing changed.
- **Setup UI** (`model.ts`, `view.ts`, `cloud-setup.ts`, `setup.css`):
  - three engine cards;
  - free-model sources, with the CPU model's name, size and licence, the data-use warning for hosted keys, and the public vs private minutes note;
  - the subscription checklist with copyable commands, an explicit "no token field" statement, and a "Check secret name" button that blocks Create until the name exists;
  - the create step gains "Install the job workflow in your project".
- **Cloud UI**: Status describes an Actions execution, and each job's cost line follows its basis.

## Pins

All pins were verified on 2026-10-24 with read-only `gh api` and `npm view`. All are at least two weeks old.

- `anthropics/claude-code-action` v1.0.245, commit `6fed3ca145920b639991cb756090506e1bcaf515`.
- `actions/upload-artifact` v7.0.2, commit `cf430e030ddbb5b0abf93d22962f4752f3646cd9`.
- The existing `actions/checkout` and `actions/setup-node` SHAs were re-confirmed to exist.
- `@qwen-code/qwen-code` 0.25.0: the sha512 integrity was cross-checked against a locally packed tarball. The package has no runtime dependencies.
- Ollama v0.40.10, `linux-amd64.tar.zst`, with its GitHub-reported sha256.

## Checks

| Check | Result |
| --- | --- |
| Typecheck (server, client, cloud) | Clean |
| `npm test` | 766 / 766 (16 new in `tests/free-04-actions.test.ts`) |
| `build`, `build:cloud` | OK |
| `tools/free-04-ui-check.ts` (new) | 57 / 57 |
| `setup-ui-check` | 127 / 127 |
| `cloud-ui-check` | 171 / 171 |
| `mobile-ui-check` | 411 / 411 |

- **Tests** use a fake Actions API covering dispatch, runs, cancel, artifacts with redirect, secrets and contents. They cover:
  - reservation, uncertain dispatch (network error, 5xx, no run id) and review, with credits only on accept;
  - a 4xx dispatch requeuing and then failing;
  - timed-out, cancelled, missing-artifact and title-mismatch outcomes;
  - artifact limits;
  - YAML pins and permissions, and prompts containing `${{ }}`, backticks and newlines;
  - injection-shaped settings being refused;
  - secret-name-only checks;
  - Anthropic jobs unchanged.
- **UI runs** used the isolated fixture on port 4861 and a fake `api.github.com`. Screenshots are in [free-04/](free-04/) at 1440x900 and 874x402. The phone run used real touch input with reduced motion.
- **Untouched:** no 4610, Pixel or `.agent-office`; no real GitHub writes, Actions runs or paid calls; nothing pushed. Unrelated regenerated screenshots were reverted.

## Unverified until a real run

- Qwen 0.25 flags: `--approval-mode yolo` and `--max-session-turns`, which were seen in the bundle.
- `claude_args --max-budget-usd`, and the action's `execution_file` cost field.
- Whether `return_run_details` returns `workflow_run_id`. If it doesn't, the job becomes `dispatch_uncertain`, which is safe.
- That upload-artifact v7 still zips.
- The CPU model's speed.

## First real run (owner, throwaway repository)

1. Create a **public** throwaway repository with a README. Protect `main` (require a PR).
2. Create a fine-grained PAT for that repository only. Grant Contents and Pull requests read/write, Actions read/write, and Metadata read.
3. In setup, choose **Free · Qwen Code** with the CPU model, or a self-hosted runner. Paste the PAT and create the Empire. Confirm that `.github/workflows/agent-empire-job.yml` appears on `main`.
4. In the game, submit a trivial job, such as "add a line to README". Within one coordinator interval, the Actions tab should show "Agent Empire job <id> budget 0c turns 30".
5. Check:
   - the run's permissions block;
   - that `sha512sum -c` passed;
   - that the task branch was pushed and a draft PR opened;
   - that the artifact `agent-empire-result` exists and is under 1 KB;
   - that the job reaches *Awaiting review* with "free run (US$0)".
6. Cancel a second job while it is running. The run should become *cancelled* and the job *Cancelled*.
7. For a subscription run: in your own terminal, run `claude setup-token` and then `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <repo>`. Click "Check secret name". Submit one job and confirm the job shows "billed to your Claude plan".
8. Afterwards: revoke the setup token from your Claude account (deleting the secret does not revoke it), delete the PAT, and delete the repository.

## Security review fixes (2026-10-24, "accept with fixes")

Each fix has a test in `tests/free-04-actions.test.ts` that was run against the pre-fix sources and failed (or hung) there.

- **H1, fixed:** the job workflow is now two jobs.
  - **`work`** runs the agent. It has `permissions: contents: read` and no write token. It uploads `git diff --binary` plus a manifest (job id, source commit, sha256, size) as `agent-empire-change`.
  - **`publish`** runs on a fresh `ubuntu-latest` runner, `needs: work`, and executes no agent code. It:
    - checks the manifest;
    - enforces a 5 MB cap;
    - refuses symlinks, submodules and any path (including rename and copy targets, case-insensitively) under `.git/` or `.github/`, or containing `..`;
    - applies the patch with `git -c core.hooksPath=/dev/null apply --index`;
    - commits with `--no-verify` and pushes only `refs/heads/agent-empire/task-$JOB_ID`;
    - is the only job that opens the draft PR or writes `result.json`.
  - Tests assert the YAML structure. They also run the real "Check the change" script against hostile patches in a local scratch repository.
- **M2, fixed:** the Claude agent job also has `contents: read` and publishes through the publish job. `claude-code-action` still receives `github_token: ${{ github.token }}`, because without it the action asks for an OIDC token for the Claude GitHub App and fails. That token is read-only under these permissions.
  - **Plainly: the Claude agent can read its own `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` from its environment** (yolo tool use in the same job). Use a token that only you use, rotate it, and don't run untrusted tasks with it.
  - The Qwen agent can likewise read `FREE_LLM_API_KEY` when that source is chosen.
- **M1, fixed:** `attach_session` accepts `ghrun_<id>` for GitHub Actions jobs (and only for them; Anthropic jobs still need `sesn_…`).
  - The cursor is rebuilt from the job and the current execution: repository, engine, the job's reservation and the turn cap.
  - The run is trusted only when its title names this job with that budget and turn cap. Otherwise the job stays `unknown` and its reservation is kept.
- **M3, fixed:** the copy now says "US$0 on public repositories; private repositories use GitHub Actions minutes (up to N minutes per job)". N is the agent cap plus the 15-minute publish job, and the CPU option allows up to 375.
  - The minutes estimate now includes job runs.
  - The setup note mentions a draft PR only when `openPullRequest` is on.
- **M4, fixed:** setup refuses a self-hosted runner for a public project repository. The free-model panel and the generated YAML warn that the agent controls that machine while it works, and recommend an ephemeral runner (`--ephemeral`) on a dedicated machine or VM.
- **L1, fixed:**
  - The schema requires the cursor's owner and name to match the OWNER/REPO patterns and to equal `job.repository`. The adapter re-checks the patterns.
  - The cost basis is accepted only when it matches the job's own reservation. A money-reserved run can't be recorded as free or plan-billed, and a run-caps run can't gain a dollar estimate.
- **L2, fixed:** the artifact body is read in chunks and abandoned past 16 KB, whether or not GitHub sent a content-length. The test checks how many bytes were actually pulled from a 10 MB stream. Cancelling the stream is no longer awaited (awaiting it could hang).
- **L3, fixed:** the job asserts that the packed Qwen `package.json` has no dependencies, then installs with `--offline`. The CPU model's registry manifest digest is pinned and compared after the pull. It is UNVERIFIED that Ollama's `/api/tags` digest equals the registry manifest's sha256; if it doesn't, the job stops, which is safe.
- **L4, fixed:** a 429, or a 403 that says "rate limit", stops every further GitHub call in that coordinator run. A dispatch after that fails as provably not sent.

New pin: `actions/download-artifact` v8.0.2, commit `9000827ccba6bdab643e8b6fd33ac0654aef8333` (2026-10-07).
