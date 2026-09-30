# Cloud coordinator: CLOUD-01, and the pure parts of CLOUD-02 and CLOUD-05

Backend lane report, 2026-09-30. Branch `claude/cloud-coordinator`, based on `08bb4a4`. This implements the [cloud mode plan](../CLOUD_MODE_PLAN.md) decision that the user's own GitHub hosts the Empire: a private state repository plus a scheduled Actions workflow as the coordinator.

Everything below is **verified only by automated tests with fake GitHub and fake provider transports**. No real GitHub repository, Actions run or Anthropic session was created. There is no evidence yet that the workflow runs on GitHub.

## What was built

| Path | Purpose |
| --- | --- |
| `src/cloud/schema.ts` | Versioned state files, validation, migrations, stable serialization |
| `src/cloud/intents.ts` | One-file-per-intent format and validation |
| `src/cloud/economy.ts` | Pure city economy following [ECONOMY.md](../../ECONOMY.md) |
| `src/cloud/tick.ts` | Coordinator phases (pure) and `runCoordinatorTick` orchestration |
| `src/cloud/provider.ts` | `ProviderAdapter` interface, `DispatchFailure`, `UnavailableProvider` |
| `src/cloud/anthropic-adapter.ts` | Adapter wrapping the unchanged `src/server/providers/anthropic-managed.ts` |
| `src/cloud/store.ts` | `StateStore` interface, GitHub Git Data API store, in-memory fake, retry helper, workflow enable/disable |
| `src/cloud/client.ts` | Client helpers: read snapshot with age, submit intent, request shutdown/start |
| `src/cloud/workflow.ts` | Workflow YAML template |
| `src/cloud/installer.ts` | Installer core with the `encryptSecret` seam |
| `src/cloud/cli.ts` | `node agent-empire-coordinator.mjs tick\|status` |
| `vite.cloud.config.ts`, `npm run build:cloud` | Single-file ES module bundle at `dist/cloud/agent-empire-coordinator.mjs` (~100 KB, no imports). Uses the existing `vite` devDependency; no new dependency |
| `tsconfig.cloud.json` | Added to `npm run typecheck` |

Everything under `src/cloud` except `cli.ts` and `anthropic-adapter.ts` is browser-safe: `fetch`, `TextEncoder` and `btoa` only, no Node built-ins. The client cloud adapter (CLOUD-04) can import `schema`, `intents`, `store` and `client` directly.

Existing server code is unchanged. The cloud module reuses `execution-validation.ts` (`validateConfig` for limits and provider/repository references, `validateSubmit` for paid jobs, and the ID regexes), `execution-errors.ts`, `anthropic-managed.ts`, and `shared/empire.ts` and `shared/layout.ts` (sites, rates, costs, capacity).

## State repository schema (schemaVersion 1)

`state/*` is written only by the coordinator. Clients add `intents/<uuid>.json` files and nothing else.

| File | Content |
| --- | --- |
| `state/meta.json` | `schemaVersion`, `createdAt`, `revision` (incremented by every coordinator commit), `configRevision`, `lifecycle {status: running\|shutting_down\|shutdown, changedAt, workflow: enabled\|disable_requested\|disabled}`, `coordinator {lastRunId, lastRunAt, economyClockAt}`, `limits`, `execution` (provider and repository references only), `processedIntents` (last 2,000 ids with outcome) |
| `state/empire.json` | The host `EmpireState` (version 2) without the ephemeral `supervision` field, so the client store can consume it unchanged |
| `state/jobs.json` | Cloud jobs: id, title, prompt, optional `site`, status, message, repository, branch `agent-empire/task-<id>`, sourceCommit, sessionId, event cursor, `reservation {cents, day, basis: per_job_allowance_estimate}`, `cost {…, basis: provider_reported_list_cost}`, `dispatch {runId, preparedAt, attempts}`, stopRequested, review, `outputs: 'unverified'` |
| `state/ledger.json` | **Real-money** evidence in USD cents: reserved, released and cost-observed entries (last 1,000) and per-UTC-day totals (last 90 days). It is kept separate from the city's simulation-credit ledger in `empire.json` |
| `state/journal.json` | Ordered entries `{seq, at, runId, kind, message, intentId?, jobId?}` (last 500), validated gap-free |

Job statuses are `queued`, `dispatching`, `dispatch_uncertain`, `running`, `waiting_for_approval`, `budget_paused`, `idle`, `unknown`, `awaiting_review`, `accepted`, `rejected`, `failed` and `cancelled`. The seven states from `dispatching` through `unknown` hold a concurrency slot. The validator rejects a slot-holding job that has no reservation.

**Validation.** Unknown fields, bad ranges, secrets in `execution`, journal sequence gaps and invalid city saves are refused. A refused snapshot aborts the run without committing; nothing is "repaired".

**Migrations.** `SNAPSHOT_MIGRATIONS` is keyed by the version being upgraded from. It is empty because v1 is the first release. A snapshot with a newer `schemaVersion` is refused, never downgraded. A version-1 city save is migrated to version 2 exactly as the host migrates it (tested).

**Intents** (`schemaVersion: 1`, `id` = UUID matching the file name, `createdAt`):

| Kind | Payload |
| --- | --- |
| `new_job` | `{id, title, prompt, site?, configRevision, confirmPaid: true}`, validated with the host `validateSubmit` |
| `review` | `{jobId, decision: accept\|reject, note?}` |
| `cancel` | `{jobId}` |
| `resolve_uncertain` | `{jobId, resolution: not_dispatched\|attach_session, sessionId?}` |
| `shutdown`, `start` | none |
| `limits` | `{limits, configRevision}` |
| `configure` | `{execution, configRevision}` |
| `empire_action` | Host `EmpireAction`, minus `retry-manager`; in cloud mode a manager retry is a new job |

## Tick algorithm

`runCoordinatorTick({store, provider, now, runId, allowSelfDisable})` runs in two commits:

1. **Read** `state/*` and up to 100 intent files. Parse, migrate and validate.
2. **Reconcile stale dispatches.** A `dispatching` job marked by another run becomes `dispatch_uncertain` and is never retried.
3. **Apply intents** in `(createdAt, path)` order. Each intent is applied to a scratch copy, so a rejected intent leaves no partial change. Already-processed ids are dropped as duplicates. Invalid files are rejected with a reason and journaled. Every read intent file is deleted in the commit that records its outcome.
4. **Poll and stop provider sessions.** This is a provider side effect, run once per tick. Slot-holding jobs with a session are observed (events, then session). Stop requests (cancel or shutdown) are interrupted if running, then archived when idle. A finished turn (idle, `end_turn`) is archived to release its slot.
5. **Record outcomes:**

   | Provider state | Job status |
   | --- | --- |
   | Archived after a finished turn | `awaiting_review` |
   | Archived after a stop request | `cancelled` |
   | Terminated | `failed` |
   | Idle, `requires_action` | `waiting_for_approval` |
   | Idle, `budget_reached` | `budget_paused` |
   | Idle, other reason | `idle` (keeps its slot) |
   | Session budget differs from the reservation | `unknown` |
   | Read error | `unknown`, keeping the session ID and reservation |

   Nothing is ever marked verified; `outputs` stays `'unverified'`.
6. **Plan dispatch** (FIFO), only while `running`, with execution configured and credentials present. Checks:
   - concurrency: slot-holding jobs < `maxConcurrent`
   - daily admission: the full reservation of every job reserved today (UTC) or still holding a slot, plus the new reservation, must fit `dailyBudgetCents`
   - per job: reserve `min(current perTaskBudgetCents, allowance confirmed at submission)`

   Admitted jobs are marked `dispatching` with the reservation and a ledger entry. They are not yet sent.
7. **Lifecycle.** `shutting_down` becomes `shutdown` (with `workflow: disable_requested`) once no known session still needs stopping.
8. **Economy.** While `running`, settle `now − economyClockAt`, capped at 20 minutes per tick (1 real second = 1 city minute; every city hour settles payroll as on the host). Then sync managers and workforce from jobs.
9. **Commit 1** with optimistic concurrency. On conflict (a client pushed an intent), re-read and recompute steps 1–8 while reusing the provider results already fetched, so no provider side effect is repeated.
10. **Dispatch** the jobs marked in commit 1. The adapter does a read-only agent/environment/repository check once per run, then `POST /v1/sessions` with the reservation as the session budget.

    | Adapter outcome | Result |
    | --- | --- |
    | Check fails before the paid request (`sent: false`) | Requeued; reservation released; failed after 3 attempts |
    | Anything after the request, or an unexpected error | `dispatch_uncertain`; never retried |
11. **Optional self-disable** of the workflow after shutdown.
12. **Commit 2** records the session receipts and whether the workflow was disabled, again with retry. If receipts cannot be saved, the run prints `UNSAVED dispatch receipt job=… session=…` to the Actions log and fails.

Recovery for uncertain jobs is a user decision via `resolve_uncertain`, matching the host contract ("never retry an uncertain dispatch blindly").

**Rewards.** A job earns the 500-credit reward once, only on a `review: accept` of an `awaiting_review` job. Acceptance is a user review, not automated verification. Manager appointments follow their linked job. A finished turn counts as `ready`, matching the host's "startup turn ended; brief not yet verified". Founding appoints managers but never dispatches their briefs: the user submits them as paid jobs.

**Shutdown and start (CLOUD-05 core).** On shutdown the tick first settles the economy up to now. It then requests stops for every live session and stops dispatching and advancing city time. It completes once sessions are archived or terminated, then disables the workflow: itself with `actions: write`, otherwise it records `disable_requested` for the app. On `start`, the economy clock is reset to now: no catch-up. Queued jobs stay queued while shut down. Client helpers:
- `requestShutdown`: writes the intent and sends `repository_dispatch`.
- `requestStart`: re-enables the workflow with the user's token, writes the intent and sends `repository_dispatch`.

## Workflow (CLOUD-02 template)

`coordinatorWorkflow()` is committed as `.github/workflows/agent-empire.yml`:
- Triggers: `schedule` every 10 minutes, `workflow_dispatch`, and `repository_dispatch` with types `agent-empire-intent`, `agent-empire-start` and `agent-empire-shutdown`.
- `concurrency: {group: agent-empire, cancel-in-progress: false}`.
- `permissions: contents: write`, plus `actions: write` so the coordinator can disable itself after shutdown. `allowSelfDisable: false` produces a template with `contents: write` only; the app then disables the workflow.
- `timeout-minutes: 8`.
- Steps: `actions/checkout@v4` (sparse `coordinator/`, `persist-credentials: false`), `actions/setup-node@v4` (Node 22), then `node coordinator/agent-empire-coordinator.mjs tick`.
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `PROJECT_GITHUB_TOKEN` appear only as `env:` of that step. `GITHUB_TOKEN` is the run's own repository-scoped token.

**Storage.** `GitHubStateStore` uses `fetch` only, with no Octokit:
- **Read:** `GET git/ref/heads/{branch}` → `git/commits/{sha}` → `git/trees/{tree}?recursive=1` → `git/blobs/{sha}`, for `state/*` and `intents/*` only.
- **Write** (one atomic commit): `POST git/trees` (base tree, including `sha: null` deletions) → `POST git/commits` → `PATCH git/refs/heads/{branch}` with `force: false`. A 422 or 409 response is reported as a conflict; `updateWithRetry` re-reads and recomputes.
- **Workflow control:** `PUT actions/workflows/{file}/enable|disable`, and `POST /dispatches` for wake-ups.

Errors never include the token.

**Installer core** (`installStateRepository(client, options, encryptSecret)`):
1. `GET /user`.
2. Create `<login>/agent-empire-state` as a **private** repository with `auto_init`. It refuses an existing public repository.
3. Fetch the Actions public key and upload each secret as `encryptSecret(publicKeyB64, value)` ciphertext.
4. Commit the workflow, the coordinator bundle and the initial state in **one commit**. Re-running setup updates only the workflow and bundle and never overwrites an existing Empire.

Setup creates no job and triggers no run.

## Limits and cost honesty

- Reservations are **estimates**: the full per-job allowance, labelled `per_job_allowance_estimate`. Observed cost is the provider-reported list cost (`provider_reported_list_cost`), recorded only when it increases.
- The daily allowance is an **admission limit** by UTC day, not a billing meter. Provider budgets are enforced between model requests and can overshoot; this is carried over from the host notices.
- The coordinator never raises a budget, resumes a budget-paused session or approves a tool call.
- **Actions minutes:** a run every 10 minutes is about 4,300 runs a month. Each run commits at least `meta.json`, because `lastRunAt` gives clients the snapshot age, so history grows by about 144 commits a day. Private repositories consume the user's Actions minutes. GitHub may delay or skip scheduled runs under load, and disables schedules in repositories without activity for 60 days. Unsettled gaps longer than 20 minutes earn no catch-up and are journaled.
- City credits (`empire.json`) and real money (`ledger.json`) never mix.

## Stubbed or not done

- **Sealed-box encryption.** `EncryptSecret` is an injected seam, tested with a fake. Per the coordinator's instruction, tweetnacl and blakejs are added only by the client setup author (`cloudSetup.uploadSecret`). I added no dependency.
- **Installer UI and flow** (CLOUD-03): device-flow sign-in, repository selection, and loading the built bundle from app assets to pass as `coordinatorBundle`.
- **OpenAI adapter** (CLOUD-06). `ProviderAdapter` is the interface to implement. `OPENAI_API_KEY` is plumbed through the workflow but unused.
- **Import and verification of outputs.** Branches and PRs are not read back. Review is the user's decision.
- **Provider session lookup by task id** for uncertain dispatches. The user resolves them with `resolve_uncertain` after checking the provider Console.
- **Duplicate city rules.** `src/cloud/economy.ts` duplicates the action and settlement rules of `src/server/empire.ts`, which is filesystem-bound and outside my lane. Extracting one pure shared module is a follow-up.
- `build:cloud` is not part of `npm run build`. Run it separately; the output goes to `dist/cloud/`.

## Unverified

- No real GitHub or Actions execution. Nothing has run on GitHub: the YAML, the `actions: write` self-disable permission, sparse checkout, cron cadence, and `GITHUB_TOKEN` pushing to the default branch (which fails if the user adds branch protection) are all untested.
- Real GitHub API edge behaviour is emulated, not observed:
  - the exact 422 body on a non-fast-forward ref update
  - how soon after `auto_init` the ref appears
  - that committing `.github/workflows/*` requires the installer token to have Workflows write permission
  - Actions secret upload with real sealed-box ciphertext
- The Anthropic wire shapes are those already verified for the host adapter on 2026-09-27; this lane added no new calls. Archiving a session after `end_turn` to release its slot is a new policy and is untested against the real API. Branch or PR pushes may need to finish before archive; the agent prompt already tells it to push before finishing.
- The built bundle was smoke-run locally for usage and error paths only. The full tick runs from TypeScript source in the tests (`tests/cloud-github.test.ts`, via `main()` with fake transports).

## Checks

- `npm run typecheck`: pass (server, client and the new cloud project).
- `npm test`: 284/284. The baseline was 259; 25 are new in `tests/cloud-{schema,tick,github,scenario}.test.ts`, with no network access.
- `npm run build`: pass.
- `npm run build:cloud`: pass, producing a single file.
