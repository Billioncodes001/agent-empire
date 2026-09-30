# Cloud coordinator: CLOUD-01, and the pure parts of CLOUD-02 and CLOUD-05

Backend lane report, 2026-09-30. Branch `claude/cloud-coordinator`, based on `08bb4a4`. This implements the [cloud mode plan](../CLOUD_MODE_PLAN.md) decision that the user's own GitHub hosts the Empire: a private state repository plus a scheduled Actions workflow as the coordinator.

It was revised after the independent review of `675677e` (ACCEPT WITH FIXES); see [Review fixes](#review-fixes).

Everything below is **verified only by automated tests with fake GitHub and fake provider transports**. No real GitHub repository, Actions run or Anthropic session was created. There is no evidence yet that the workflow runs on GitHub.

## What was built

| Path | Purpose |
| --- | --- |
| `src/cloud/schema.ts` | Versioned state files, validation, migrations, stable serialization, schedule estimate |
| `src/cloud/intents.ts` | One-file-per-intent format, validation, oldest-first batch selection |
| `src/cloud/economy.ts` | Pure city economy following [ECONOMY.md](../../ECONOMY.md) |
| `src/cloud/tick.ts` | Coordinator phases (pure) and `runCoordinatorTick` orchestration |
| `src/cloud/provider.ts` | `ProviderAdapter` interface (including a read-only `branchHead`), `DispatchFailure`, `UnavailableProvider` |
| `src/cloud/anthropic-adapter.ts` | Adapter wrapping `src/server/providers/anthropic-managed.ts`, plus the task-branch check with the project token |
| `src/cloud/store.ts` | `StateStore` interface, GitHub Git Data API store, in-memory fake, retry with backoff, workflow enable/disable |
| `src/cloud/client.ts` | Client helpers: read snapshot with age, submit intent, request shutdown/start |
| `src/cloud/workflow.ts` | Workflow YAML template with actions pinned to SHAs |
| `src/cloud/installer.ts` | Installer core with the `encryptSecret` seam and `PROJECT_TOKEN_GUIDANCE` |
| `src/cloud/cli.ts` | `node agent-empire-coordinator.mjs tick\|status`, with the default-branch guard |
| `vite.cloud.config.ts`, `npm run build:cloud` | Single-file ES module bundle at `dist/cloud/agent-empire-coordinator.mjs` (~115 KB, no imports). Uses the existing `vite` devDependency; no new dependency |
| `tsconfig.cloud.json` | Added to `npm run typecheck` |

Everything under `src/cloud` except `cli.ts` and `anthropic-adapter.ts` is browser-safe: `fetch`, `TextEncoder`, `btoa` and `BigInt` only, no Node built-ins.

The only change outside `src/cloud` is in `src/server/providers/anthropic-managed.ts`, for review item 3c: a session with `archived_at` set is now treated as archived whatever its `status` field says. Host tests still pass.

## State repository schema (schemaVersion 1)

`state/*` is written only by the coordinator. Clients add `intents/<uuid>.json` and nothing else. `archive/*` files are write-only: the coordinator never reads them back.

| File | Content | Changes when |
| --- | --- | --- |
| `state/meta.json` | `schemaVersion`, `createdAt`, `revision`, `configRevision`, `lifecycle {status, changedAt, workflow}`, `coordinator {economyClockAt}`, `schedule {intervalMinutes, runsPerMonth, billedMinutesPerMonth, basis: estimate_scheduled_runs_only}`, `limits`, `execution` (references only) | Any commit (revision) |
| `state/heartbeat.json` | `{lastRunId, lastRunAt}` of the last committing run | Every commit, at least hourly |
| `state/processed-intents.json` | Last 2,000 intent ids with outcome (idempotency) | Only when intents are consumed |
| `state/empire.json` | Host `EmpireState` v2 without `supervision` | City actions, and time at each commit |
| `state/jobs.json` | Hot job list (below) | Job events |
| `state/ledger.json` | **Real-money** evidence in USD cents: reserved, released and cost-observed entries (last 1,000) and per-UTC-day totals (90 days) | Spending events |
| `state/journal.json` | Ordered entries `{seq, at, runId, kind, message, intentId?, jobId?}` (last 500), validated gap-free | Events |
| `archive/prompts/<jobId>.txt` | Full prompt, written once it is no longer needed for dispatch | Write-only |
| `archive/jobs/<day>-<runId>-<phase>.json` | Final jobs moved out of the hot file | Write-only |

**Job model.**
- The job keeps its full `prompt` only while `queued` or `dispatching`. It always keeps `promptPreview` (200 characters) and `promptHash` (FNV-1a, used for duplicate-submission checks; not a security hash). After dispatch, `promptArchive` points to the archived prompt.
- `branchHead {sha, observedAt}` records the observed push; it is evidence, not verification. `outputs` is always `'unverified'`.

**Job statuses:**
- `queued`, `dispatching`, `dispatch_uncertain`, `running`, `waiting_for_approval`, `budget_paused`, `idle`, `unknown`: the active states.
- `awaiting_review`, `accepted`, `rejected`: the review states.
- `failed`, `cancelled`: final without review.

A job **holds a concurrency slot** when it is in an active state other than `queued`, or when it is in a review state and its provider session is still live (not archived or terminated). Slot-holding jobs must carry a reservation.

**Hot-file bounds:**

| Limit | Value |
| --- | --- |
| Queued jobs (full prompts ≤ 20,000 chars) | 50; more are rejected with `queue_full` |
| Unreviewed jobs | 200; more are rejected with `review_backlog` |
| Retained final jobs | Newest 200 within 14 days, plus any with a reservation dated today (needed for the daily admission sum) |
| Hard cap | 600 jobs |

The worst case (50 × 20 KB prompts plus every other bound at its maximum) is tested below 3 MB. The GitHub read refuses state files over 4 MB.

**Validation and migrations.**
- Unknown fields, bad ranges, secrets in `execution`, an inconsistent schedule estimate, journal sequence gaps and invalid city saves are refused. A refused snapshot aborts the run without committing.
- `SNAPSHOT_MIGRATIONS` is empty because v1 is the first release. A newer `schemaVersion` is refused, never downgraded. City save v1 → v2 is migrated as the host does.
- v1 was changed in place during this revision; it has never shipped.

**Intents** (`schemaVersion: 1`, `id` = UUID matching the file name, `createdAt`):
- **Kinds:** `new_job`, `review`, `cancel`, `resolve_uncertain`, `shutdown`, `start`, `limits`, `configure`, `empire_action`. Payloads are unchanged from the first version.
- **Validation:** `new_job` uses the host `validateSubmit`; limits and execution use the host `validateConfig`.
- **Batch order:** each run processes the **oldest** 100 readable intents by `(createdAt, id)`, from up to 500 scanned, never by path. Clients should use time-ordered ids (UUIDv7) so the scan window also favours old intents.
- **Unreadable files** (oversized by tree size, not UTF-8, unsupported blob) are returned as unreadable. The run rejects, journals and deletes them. Transient network or 5xx errors fail the run and leave the intent for the next one.

## Tick algorithm

`runCoordinatorTick({store, provider, now, runId, allowSelfDisable, retry})`:

**Phase 1** runs a read-only provider pass, then commits:
1. **Read** `state/*` and the intent batch. Parse, migrate and validate.
2. **Reconcile stale dispatches.** A `dispatching` job marked by another run becomes `dispatch_uncertain` and is never retried.
3. **Apply intents** against a scratch copy each, so a rejected intent leaves no partial change. Duplicates and rejections are recorded. Every read file, including unreadable ones, is deleted in the commit.
4. **Observe** live sessions of slot-holding jobs that have no stop request. Only GET calls are made. For a finished turn (idle, `end_turn`), the coordinator also GETs the task branch head (`git/ref/heads/agent-empire/task-<id>`) with `PROJECT_GITHUB_TOKEN`.
5. **Record outcomes:**
   - Finished turn → `awaiting_review`. If the branch exists **and** differs from the source commit, the head is recorded and `stopRequested: turn_ended` is set, so the session is archived after the commit. Otherwise the session is **left open and keeps its slot**, so unpushed work or a question is not lost; the user reviews, rejects, or cancels to archive. The branch is re-checked on later runs.
   - `requires_action` → `waiting_for_approval`; `budget_reached` → `budget_paused`; terminated → `failed`; budget mismatch → `unknown`; read error → `unknown`, keeping the session ID and reservation.
   - An archived session with a saved `end_turn` cursor becomes `awaiting_review`, not `cancelled`.
   - Reviewed jobs keep their status; only session bookkeeping changes.
6. **Plan dispatch** (FIFO). The concurrency, daily-admission and per-job rules are unchanged. Admitted jobs are marked `dispatching` and their reservations recorded.
7. **Lifecycle, economy, compaction.**
   - Shutdown completes once no **active** session remains live. Finished turns left open for review are journaled and are not archived by shutdown.
   - Economy: while `running`, settle `now − economyClockAt`, capped at `max(90 min, 3 × interval)`. One real second is one city minute, and hourly payroll works as on the host.
   - Compaction moves out prompts and old final jobs.
8. **Commit 1**, only if something meaningful changed (intents consumed, jobs, ledger, journal, lifecycle or config, archives, migration) or the hourly heartbeat is due. Idle runs make **no commit**. City time not yet committed is settled at the next commit, within the cap.

**Phase 2** makes mutating provider calls, only for intentions already committed:

9. **Stops.** For jobs with a committed `stopRequested` (cancel, shutdown, turn_ended, review): interrupt if running, archive when idle, observe.
10. **Dispatch** jobs marked `dispatching`:

    | Adapter outcome | Result |
    | --- | --- |
    | Failure before the paid request | Requeued, reservation released; failed after 3 attempts |
    | Anything after the request, or unexpected | `dispatch_uncertain`; never retried |
11. **Optional self-disable** of the workflow, if the shutdown completes with these results.
12. **Commit 2** records stop and dispatch receipts, the lifecycle state and the workflow state.

Conflicts in either commit re-read and recompute from the provider results already fetched, with exponential backoff (250, 500, 1,000 ms …, 5 attempts). No provider call is repeated. If receipts cannot be saved, the run prints `UNSAVED dispatch receipt job=… session=…` and fails.

Because every mutation follows a commit, a failed commit 1 archives or stops nothing. A crash after commit 1 leaves a durable stop request, retried next run, or `dispatching`, which becomes uncertain.

**Rewards and managers.**
- The 500-credit reward is paid once, on `review: accept`. Accepting or rejecting a job whose session is still open archives the session.
- A manager becomes `ready` once any linked job reaches `awaiting_review` or `accepted`, and **stays ready**: later sector jobs never demote it. Until then, the most recent linked job is the current startup attempt and drives `queued`, `working`, `needs_input` or `offline`.

**Shutdown and start (CLOUD-05 core).**
- **Shutdown:** settles the economy up to now, requests stops for active live sessions and stops dispatching. City time stops. Once the stops are confirmed, the coordinator disables the workflow: itself with `actions: write`, otherwise it records `disable_requested` for the app.
- **Start:** resets the economy clock, with no catch-up.
- **Client helpers:** `requestShutdown` and `requestStart`; `requestStart` re-enables the workflow with the user's token.

## Workflow (CLOUD-02 template)

`coordinatorWorkflow({intervalMinutes, allowSelfDisable})`:
- **Triggers:** `schedule` every **30 minutes** by default (15, 20, 30 or 60; 60 runs at minute 7), `workflow_dispatch`, and `repository_dispatch` types `agent-empire-intent`, `agent-empire-start`, `agent-empire-shutdown`. Active apps wake the coordinator with `repository_dispatch` for faster reaction.
- **Concurrency and permissions:** `concurrency: {group: agent-empire, cancel-in-progress: false}`. `permissions: contents: write`, plus `actions: write` only when self-disable is allowed.
- **Actions:** pinned to full commit SHAs with version comments: `actions/checkout@11bd719… # v4.2.2` and `actions/setup-node@49933ea… # v4.4.0`.
- **Branch pinning:** `AGENT_EMPIRE_STATE_BRANCH: ${{ github.event.repository.default_branch || github.ref_name }}`. Scheduled runs always use the default branch. The CLI **skips with exit 0 and a log line** when `GITHUB_REF_NAME` differs, so a `workflow_dispatch` on another branch cannot act as a second coordinator.
- **Secrets:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `PROJECT_GITHUB_TOKEN` appear only as `env:` of the single step.

**Storage.** `GitHubStateStore` uses `fetch` only, with no Octokit:
- **Read:** ref → commit → recursive tree → blobs (state files always; intents size-checked from the tree before download).
- **Atomic write:** POST trees (with `sha: null` deletions) → POST commits → PATCH ref with `force: false`. A 422 or 409 response is a conflict.
- **Workflow control:** enable/disable, and `dispatches` for wake-ups.

Errors never include the token.

**Installer core.**
1. Refuse a `PROJECT_GITHUB_TOKEN` that is not a fine-grained token (`github_pat_…`), before creating anything.
2. Create a **private** `<login>/agent-empire-state` with `auto_init`; refuse an existing public one.
3. Upload secrets as `encryptSecret(publicKeyB64, value)` ciphertext.
4. Commit the workflow, bundle and initial state in one commit. The initial state includes the schedule estimate for the chosen interval. Re-running setup never overwrites an existing Empire.

`PROJECT_TOKEN_GUIDANCE` is the text the setup UI must show:
- Use a fine-grained token scoped to the selected repositories only.
- Grant only Contents and Pull requests read/write.
- The token is sent to Anthropic to mount the repository.
- Protect each project's default branch (require a pull request).
- Set an expiry.

## Limits and cost honesty

**Provider spending.**
- Reservations are estimates (`per_job_allowance_estimate`). Observed cost is the provider-reported list cost. The daily allowance is an admission limit by UTC day, not a billing meter.
- Provider budgets can overshoot between model requests.
- The coordinator never raises a budget, resumes a budget-paused session or approves a tool call.

**Actions minutes.**
- The default of 30 minutes is about **1,440 scheduled runs a month, about 1,440 billed minutes**, since each run is billed as at least one minute. `repository_dispatch` runs come on top.
- This estimate is stored in `state/meta.json → schedule` for the setup UI to show before the user confirms.
- For comparison, GitHub's published included minutes for private repositories are 2,000 a month on Free and 3,000 on Pro. The default therefore uses most of a Free allowance. Setup should show this and offer 60 minutes (about 720). These plan figures are from memory and must be rechecked against GitHub's pricing page before release.

**Scheduling behaviour.**
- GitHub may delay scheduled runs.
- The 60-day inactivity auto-disable applies to scheduled workflows in **public** repositories. The state repository is private, so it does not apply.

**Commit volume.** Idle runs make no commit, and a heartbeat is written at most hourly, so there are about 24 or more commits a day plus real events (previously 144). The heartbeat and processed-intent record are small separate files, so `meta.json` is not rewritten by a heartbeat.

City credits (`empire.json`) and real money (`ledger.json`) never mix.

## Review fixes

Each fix has a test in `tests/cloud-review-fixes.test.ts` or `tests/cloud-github.test.ts`. Unless marked, the test was run against the reviewed commit `675677e` (exported to a scratch copy) and fails there, and passes on the new code.

| # | Fix | Regression test |
| --- | --- | --- |
| 1 | Unreadable intent files are reported, not thrown. Oversize is detected from the tree size, so the blob is never downloaded | `review fix 1: unreadable intent blobs…` (GitHub fake: 70 KB and non-UTF-8 blobs plus a valid shutdown; all consumed, shutdown applied). An extra in-memory variant passes on both versions, because the brick was specific to the GitHub path |
| 2 | Hot file bounded: prompts archived after dispatch, final jobs archived (200 / 14 days), queue and review-backlog caps | `review fix 2: finished jobs and dispatched prompts leave the hot file…` fails before. The worst-case budget test (< 3 MB) is a size check and passes on both |
| 3a | Archive a finished turn only if the task branch exists and moved; otherwise keep the session and its slot | `review fix 3a` |
| 3b | Mutating calls run after commit 1; an archived session with a saved `end_turn` cursor becomes reviewable | `review fix 3b` (two tests) |
| 3c | `archived_at` set means archived, even with status `idle` | `review fix 3c` |
| 4 | 30-minute default, configurable 15/20/30/60, monthly estimate in `meta.schedule` | `review fix 4`; installer interval test in `cloud-github` |
| 5 | Heartbeat and processed intents in separate files; no commit for idle runs; heartbeat hourly | `review fix 5` |
| 6 | A ready manager stays ready | `review fix 6`. It initially passed on the old code because every tick ran at the same clock value; clock advances were added and it now fails before |
| 7 | State branch pinned to the default; runs on other branches skip | `review fix 7` |
| Quick | Oldest-first batch; backoff; pinned SHAs; fine-grained token check and guidance; 60-day note corrected | `review quick fix` tests (batch order, backoff, classic token) and the SHA assertions in `review fix 4` |

The in-memory review tests import new exports (`PINNED_ACTIONS`, `promptHash`, `LIMITS` fields). To run them against the old code, those imports were shimmed in a scratch copy only. The shims are not committed.

## Stubbed or not done

- **Sealed-box encryption.** `EncryptSecret` is an injected seam, tested with a fake. tweetnacl and blakejs belong to the client setup author. I added no dependency.
- **Installer UI and flow** (CLOUD-03), including showing `PROJECT_TOKEN_GUIDANCE` and the schedule estimate, and supplying the bundle.
- **OpenAI adapter** (CLOUD-06).
- **Output import and verification.** Branch evidence is recorded, but code is not reviewed automatically.
- **Changing the schedule after install** requires re-running setup, because the coordinator's `GITHUB_TOKEN` cannot edit workflow files.
- **Duplicate detection for archived jobs.** A job id resubmitted as a new intent more than 14 days (or 200 finished jobs) after its original is not recognised as a duplicate. The processed-intents record still catches a retried *intent*.
- **Duplicate city rules.** `src/cloud/economy.ts` duplicates the rules of `src/server/empire.ts`. Extracting a shared pure module is a follow-up.
- `build:cloud` is not part of `npm run build`.

## Unverified

- **Pinned action SHAs.** Written from memory without network access (`11bd71901bbe5b1630ceea73d27597364c9af683` for checkout v4.2.2, `49933ea5288caeca8642d1e84afbd3f7d6820020` for setup-node v4.4.0). Confirm both on github.com before shipping.
- **No real GitHub or Actions execution.** Untested there:
  - the YAML
  - `actions: write` self-disable
  - sparse checkout
  - the `github.event.repository.default_branch` expression on each trigger
  - cron cadence
  - pushes to a protected default branch
- **Emulated GitHub API edge behaviour:**
  - the 422 on a non-fast-forward
  - the delay after `auto_init`
  - Workflows permission needed to commit `.github/workflows/*`
  - real sealed-box upload
  - `git/ref/heads/<branch-with-slash>` behaviour
  - tree `size` for blobs
- **Anthropic wire shapes** are those verified for the host adapter on 2026-09-27. Treating `archived_at` as authoritative, and archiving right after a pushed turn, are untested against the real API.
- **Plan minute allowances** quoted above need rechecking.
- **The built bundle** was smoke-run for usage, error and branch-skip paths only. Full ticks are tested from TypeScript source through `main()` with fake transports.

## Checks

- `npm run typecheck`: pass (server, client and cloud).
- `npm test`: **300/300**. 259 existing, 41 cloud; 16 of the cloud tests are new in this revision.
- `npm run build`: pass.
- `npm run build:cloud`: pass, single file (~115 KB, no imports).
