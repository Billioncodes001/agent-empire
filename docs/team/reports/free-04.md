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
