# CLOUD-06: an OpenAI option for cloud mode (requirements)

Requirements drafted 2026-10-08 on branch `claude/cloud-06-plan` (base `5ca742f`, the same tree as `65b6944`). This is planning only. No product code was changed, no paid API was called and no API key was used. Owner decisions are still pending; see [Owner decisions](#owner-decisions).

**Docs checked 2026-10-08.** Every OpenAI claim below cites the official page it came from. Most come from the Markdown versions of developers.openai.com pages (append `.md` to the URL). The per-method API reference pages (`/api/reference/resources/beta/subresources/agents/...`) returned 404 as Markdown and as HTML on that date. Anything that only the reference would settle is therefore marked **unverified** and assigned to the spike (slice 06-0).

## 1. What the Anthropic adapter does today

Sources: `src/cloud/provider.ts`, `src/cloud/anthropic-adapter.ts`, `src/server/providers/anthropic-managed.ts`, `src/cloud/provisioning.ts`, `src/cloud/worker-spec.ts`, `src/cloud/tick.ts`, `src/cloud/schema.ts`, `src/cloud/workflow.ts`, `src/cloud/cli.ts`.

### Interface (`ProviderAdapter`)

| Member | Contract |
|---|---|
| `provider` | The literal `'anthropic'`. The same literal is hard-coded in `CloudExecution`, `CloudProvisioning`, `CloudJob.provider` and the schema validator (`schema.ts:289,303,390`) |
| `canDispatch` / `canProvision` | Whether the credentials are present (API key plus project token, or the API key alone) |
| `provision(model)` | Finds or creates an agent and a cloud environment. It is idempotent: it looks for a metadata marker, then the exact name, and after a lost create it lists again with archived items included. It never starts a session. Failures raise `ProvisionError(message, retryable)` |
| `dispatch({jobId, prompt, branch, budgetCents, execution})` | (1) A read-only check, cached per run: agent, environment, repository metadata, then the base-branch head becomes `sourceCommit`. Any failure here raises `DispatchFailure(sent=false)`, and the job is requeued with its reservation released. (2) One `POST /v1/sessions` with no retries. A lost or invalid response raises `DispatchFailure(sent=true)`, and the job becomes `dispatch_uncertain`, which is never retried. The request carries `budget.max_list_cost = reservedCents` (a provider-enforced cap), `metadata.agent_empire_task_id`, a `github_repository` resource (the project token goes to Anthropic, the repository is mounted at `/workspace/repo` and checked out at the pinned commit), and a first message naming the task id, commit, branch rules and prompt |
| `observe(sessionId, cursor)` | Reads up to 5 pages of status and usage events only, never model text. The cursor tracks the `stopReason` (`end_turn`, `requires_action`, `budget_reached`, `error`). It then reads the session: status, `usage.list_cost` (exact provider-reported USD) and the echoed `budget` |
| `interrupt(id)` | `POST /v1/sessions/{id}/events` with `user.interrupt` |
| `archive(id)` | `POST /v1/sessions/{id}/archive`. This is a soft archive: the session stays readable and reports `archived` |
| `branchHead(execution, branch)` | Reads the task branch head with the project token, `found` or `missing`. It is evidence of a push, not verification of the work |

### Lifecycle the coordinator relies on (`tick.ts`)

1. Admission control reserves the per-job allowance (`reservation.basis = per_job_allowance_estimate`) before any paid call.
2. Dispatch (above).
3. Each tick calls `observe`. A session that is idle with `stopReason = end_turn` is a finished turn. If its branch moved past `sourceCommit`, the job goes to `awaiting_review` and the session is archived. Otherwise the session stays open and keeps its slot.
4. A stop (cancel, shutdown or review) interrupts the session if it is running, archives it once it is idle, and then re-observes it.
5. Cost: `observation.costCents` is ledgered as `cost_observed` with `basis = provider_reported_list_cost`. **The tick also requires `observation.budgetCents === job.reservation.cents` for any slot-holding status. Otherwise the job is set to `unknown`** (`tick.ts:455`). This line assumes the provider enforces and echoes a budget.
6. City credits are paid only on an accepted review.

### Secrets and runtime

`OPENAI_API_KEY` is already a supported sealed-box Actions secret (`installer.ts:52`). The workflow already passes it into the coordinator step (`workflow.ts`). `cli.ts` ignores it today. The coordinator runs at most every 15 to 60 minutes and each run is capped at 8 minutes (`timeout-minutes: 8`). **Anything that needs a long-lived client process cannot run in the coordinator.**

## 2. OpenAI candidates (checked 2026-10-08)

### A. Agents API with an OpenAI-hosted sandbox (recommended)

- **What it is.** OpenAI describes the Agents API as giving "access to the Codex harness through an OpenAI-managed API". OpenAI manages sessions, orchestration, compaction and recovery, and the agent can run code and edit files in a sandbox ([overview](https://developers.openai.com/api/docs/guides/agents-api/overview)). This is the closest equivalent of Managed Agents.
- **Auth.** An API key used as a bearer token, plus the header `OpenAI-Beta: agents=v1`. A restricted key needs `api.agents.read`, `api.agents.write` and `api.responses.write` ([quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart)), plus `api.vaults.read` and `api.vaults.write` for vaults ([vaults](https://developers.openai.com/api/docs/guides/agents-api/tools/vaults)). No ChatGPT sign-in is involved.
- **Endpoints seen in the guides:**
  - `POST /v1/agents/sessions`: create. It accepts an inline `agent` or a saved `agent_id`, plus `environment`, `input`, `vault_ids` and `stream`.
  - `GET` / `POST` / `DELETE /v1/agents/sessions/{id}`: retrieve, update (model, effort, service tier, metadata) and delete.
  - `GET /v1/agents/sessions?limit&order&after`: list.
  - `POST /v1/agents/sessions/{id}/events`: input and cancel.
  - `GET .../items` and `GET .../turns[/{turn_id}]`.
  - `GET /v1/agents/environments/{id}`.
  - `POST /v1/vaults/{vault_id}/credentials[/{credential_id}]`.

  Sources: [sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions), [manage](https://developers.openai.com/api/docs/guides/agents-api/sessions/manage), [configuration](https://developers.openai.com/api/docs/guides/agents-api/configuration), [openai-hosted](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted), [observability](https://developers.openai.com/api/docs/guides/agents-api/observability).
- **Sandbox.** `environment.type: "openai_hosted"` gives a Linux workspace at `/workspace` with Python, Node.js and CLI tools. It can be configured with:
  - `container_size`: `small` (1 vCPU, 1 GB), `medium` (2 vCPU, 4 GB, the default) or `large` (4 vCPU, 16 GB).
  - `network.access`: `enabled` (the default), `disabled`, or `restricted` with 1 to 100 exact hosts.
  - `packages`, `files` (inline base64 up to 5 MiB each and 10 MiB per request, or Files API ids up to 50 MiB), `setup_commands` (a nonzero exit prevents start) and `env`.

  `env` rejects `OPENAI_API_KEY`, `PATH` and `CODEX_*`. Files under `/workspace/outputs` are published as artifacts when a turn completes. A sandbox idle for an hour "can be deleted", and that timeout is not configurable. Sources: [openai-hosted](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted), [files](https://developers.openai.com/api/docs/guides/agents-api/environments/files).
- **Repository access.** **There is no GitHub repository resource or mount.** No repository or git handling is documented ([configuration](https://developers.openai.com/api/docs/guides/agents-api/configuration), [files](https://developers.openai.com/api/docs/guides/agents-api/environments/files)). Credentials are supplied by an `environment_variable` vault credential:
  - The sandbox sees only a placeholder. An egress proxy substitutes the real secret in HTTPS request headers sent to the credential's `allowed_hosts`. OpenAI's worked example is a GitHub token for `api.github.com`.
  - The placeholder "cannot supply the real secret for local computation", so a base64 Basic-auth header built inside the sandbox would not carry the real secret ([vaults](https://developers.openai.com/api/docs/guides/agents-api/tools/vaults), [security](https://developers.openai.com/api/docs/guides/agents-api/environments/security)).
  - **Unverified:** whether `git` over HTTPS to `github.com` works with an `Authorization: Bearer <placeholder>` extra header. GitHub's acceptance of a bearer PAT on git endpoints was not checked here. Calls to the GitHub REST API with a bearer token on `api.github.com` are the documented path.
- **Long tasks, polling and cancel.** Turns run asynchronously. Session `status` is one of `idle`, `in_progress`, `requires_action` or `failed`. Turn `status` is one of `queued`, `in_progress`, `waiting`, `completed`, `failed` or `cancelled` ([streaming events reference](https://developers.openai.com/api/reference/resources/beta/subresources/agents/streaming-events)). An idle session alone does not prove success; check the turn outcome ([events](https://developers.openai.com/api/docs/guides/agents-api/sessions/events)). Cancel is `POST .../events` with `{"type":"agent.session.input.cancel"}`. Delete removes the session from the API, and deletion can return 409 during setup or execution ([sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions), [manage](https://developers.openai.com/api/docs/guides/agents-api/sessions/manage)). No maximum turn duration is documented. Webhooks exist but need a public endpoint, which the coordinator does not have, so the coordinator polls.
- **Idempotency.** `Idempotency-Key` is documented for **input messages** ([sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions)). It is **not documented for session creation.** Treat creation as non-idempotent.
- **Usage and cost.**
  - Session and turn resources carry best-effort token `usage`: `input_tokens`, `cached_tokens`, `output_tokens`, `reasoning_tokens` and `total_tokens`. It "can be `null` when unknown", "may change", and "these counts are not a final bill".
  - Cache writes are not counted separately, so the exact model charge cannot be computed for models that price cache writes ([observability](https://developers.openai.com/api/docs/guides/agents-api/observability)).
  - **No USD cost field and no per-session budget parameter is documented.** A turn error code `session_budget_exceeded` ("the session reached its usage budget") exists, but no request field that sets such a budget appears in the guides ([errors](https://developers.openai.com/api/docs/guides/agents-api/errors)). This is unclear, so do not rely on it.
  - Project and organization **hard monthly spend limits** exist. They are "not instantaneous", and recorded spend "can slightly exceed" them ([spend limits](https://developers.openai.com/api/docs/guides/spend-limits)).
- **Pricing.**
  - Models are billed at API rates. OpenAI-hosted sandboxes use "standard container rates" ([openai-hosted](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted)).
  - Containers: 1 GB $0.03, 4 GB $0.12, 16 GB $0.48 "per 20-minute session per container". The same page also says eligible container sessions are billed "by the minute, with a 5-minute minimum". That is ambiguous, so estimate conservatively in whole 20-minute blocks ([pricing](https://developers.openai.com/api/docs/pricing)).
  - Models per 1M tokens (input / cached input / cache write / output, short context): `gpt-6.1-sol` $2 / $0.10 / $2.50 / $10; `gpt-6-astra` $10 / $1 / $12.50 / $50; `gpt-6-luna` $0.10 / $0.01 / $0.125 / $0.50. Prompts above 272K tokens cost more ([pricing](https://developers.openai.com/api/docs/pricing), [gpt-6-sol model page](https://developers.openai.com/api/docs/models/gpt-6-sol)).
- **Data.** No Zero Data Retention. Data residency is US-only. Session state is retained until deleted ([overview](https://developers.openai.com/api/docs/guides/agents-api/overview)).
- **Model support.** The guides use only `gpt-6-astra` in examples. Model pages list Responses, Chat and Batch endpoints but say nothing about Agents API support ([gpt-6.1-sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)). Support for `gpt-6.1-sol` and `gpt-6-luna` is **unverified**.
- **Stability.** The API needs a beta header. The configuration page mentions "beta and GA API contracts", so the GA status is unclear.

### B. Responses API with hosted shell and background mode (fallback)

The hosted shell runs in OpenAI containers ([shell tool](https://developers.openai.com/api/docs/guides/tools-shell)):
- Containers have no outbound network by default; `network_policy` and an organization allowlist control access.
- `domain_secrets` inject auth headers for allowlisted domains through a sidecar, using placeholders.
- Containers expire after inactivity, for example `expires_after.minutes: 20`.

Background responses can be polled and cancelled. Without `store=true` they are deleted after about 10 minutes ([background](https://developers.openai.com/api/docs/guides/background)). Usage is the standard per-response token usage. This is a plain model and tool loop, not a managed harness: we would have to chain responses and manage containers ourselves within 8-minute ticks. It is viable but more of our own code. Keep it as the fallback if Agents API access is unavailable.

### C. Codex cloud (blocked)

"Codex cloud requires signing in with ChatGPT" ([Codex auth](https://learn.chatgpt.com/docs/auth)). Environments and repositories are set up in the ChatGPT UI ([Codex Cloud](https://learn.chatgpt.com/docs/cloud)). This conflicts with the invariant "No subscription sign-in … API keys only" (`CLOUD_MODE_PLAN.md`). It also has no API-key task API. **Blocked.**

### D. `codex exec` / `openai/codex-action@v1` in GitHub Actions (alternative, not recommended for v1)

- It works with an API key. The action starts a Responses API proxy so the key is not handed to Codex directly. Its inputs include `openai-api-key`, `prompt`, `model`, `effort` and `sandbox` ([Codex GitHub Action](https://learn.chatgpt.com/docs/github-action), [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)).
- The work runs on the **user's Actions runner**: it uses the user's minutes and needs a second workflow with checkout and push permissions.
- OpenAI warns against exposing the key to jobs that run repository code.
- Cost and usage reporting and time limits are "not covered" on the action page.
- Its advantage is a real `git` checkout and push with `GITHUB_TOKEN`.

Consider it only if Agents API access or the repository path fails the spike.

### E. Agents SDK sandboxes (not suitable)

The application runs the harness ([Agents SDK sandboxes](https://developers.openai.com/api/docs/guides/agents/sandboxes)). An 8-minute coordinator tick cannot host it.

## 3. Recommended approach

Use **the Agents API with `openai_hosted`** as a second `ProviderAdapter`, with these choices:
- **No saved agent.** Each session carries an inline `agent` (`model`, `instructions` and the default tools). This removes agent provisioning and keeps the configuration auditable in our code.
- **Repository in, branch out, without the token entering the sandbox.**
  - **Credential.** One vault holds one `environment_variable` credential: `secret_name: AE_GITHUB_TOKEN`, value = `PROJECT_GITHUB_TOKEN`, `allowed_hosts: ["api.github.com"]`.
  - **Repository in.** A `setup_commands` step runs a small, pinned helper script (`files` inline, under 5 MiB). It downloads `GET /repos/{o}/{r}/tarball/{sourceCommit}` with the bearer placeholder and extracts it to `/workspace/repo`. It then creates a local baseline commit so the agent can diff. The tarball redirect host (`codeload.github.com`) needs network access but not the secret; this is unverified in the spike.
  - **Branch out.** The agent runs `ae-publish` (the same helper). It creates blobs, a tree, a commit whose parent is `sourceCommit` and the ref `refs/heads/agent-empire/task-<id>` through the GitHub Git Data API. Optionally it opens a pull request. The helper refuses any ref other than the task branch and never force-updates.
  - If the spike shows that `git` with a bearer extra header works, the helper may switch to plain `git clone` and `git push`. The external contract stays the same.
  - `branchHead` stays coordinator-side and unchanged (project token, GitHub API).
- **Money safety is enforced by the coordinator, not the provider** (§5). Strongly recommended in setup: a dedicated OpenAI project with an enforced hard monthly spend limit, as the only provider-side cap.

## 4. Adapter design and interface generalization

### Generalization (slice 06-1, no OpenAI calls)

| Area | Change |
|---|---|
| Provider identity | `type ProviderId = 'anthropic' \| 'openai'`. `ProviderAdapter.provider: ProviderId`. `CloudJob.provider`, `CloudProvisioning.provider` and the validators accept both. Additive in schema v1: existing states only contain `'anthropic'` |
| Execution config | `CloudExecution` becomes a union: `{provider:'anthropic', repository, anthropic}` \| `{provider:'openai', repository, openai: {model, containerSize, network: 'enabled'\|'restricted', vaultId, credentialId}}`. References only, never secrets (the existing "secrets in execution" refusal applies) |
| Budget capability | `ProviderAdapter.budget: 'provider_enforced' \| 'coordinator_estimate'`. The `budgetCents === reservation` check at `tick.ts:455` applies only to `provider_enforced` |
| Cost basis | `ProviderObservation` gains `costBasis: 'provider_reported_list_cost' \| 'estimate_from_reported_usage'` and optional `usage` tokens. Ledger `SpendEntry.basis` and `CloudJob.cost.basis` accept the new basis. Ledger days split `observedCostCents` from `estimatedCostCents` so the UI never adds them up as one "reported" number |
| Stop reasons | New `stopReason` value `'cancelled'` (turn cancelled). The coordinator-side budget stop uses the existing `budget_paused` status with its own message |
| Archive semantics | `ProviderAdapter.closeKind: 'archive' \| 'delete'`. For `delete`, the adapter records `cursor.deletedAt` after a confirmed `DELETE`. A later 404 maps to `providerStatus: 'archived'` **only** when `deletedAt` is set; any other 404 is an error |
| Selection | `providerFromEnv` picks the adapter from `meta.execution.provider`, not from which keys exist. Provisioning requests carry the provider |

### `OpenAICloudAdapter` (slice 06-2)

Transport rules are the same as for `AnthropicManaged`: no SDK, no automatic retries, a 2 MiB response cap, `redirect: 'error'` and user-safe errors. The headers are `Authorization: Bearer`, `OpenAI-Beta: agents=v1` and `content-type`.

| Method | OpenAI calls |
|---|---|
| `provision(model)` | Find or create a vault named `agent-empire-worker` (by metadata or name, then list again after a lost create). Create or update the `AE_GITHUB_TOKEN` credential from `PROJECT_GITHUB_TOKEN` on each provisioning run and on token rotation. No session is created |
| `dispatch` | Read-only pre-checks (vault and credential exist, repository metadata, base head as `sourceCommit`): a failure means `sent=false`. Then one `POST /v1/agents/sessions` with `stream: false`. The body has an inline `agent` (`model`, `instructions` from the worker spec, `reasoning.effort`, no web search, `multi_agent` disabled), `environment` (`openai_hosted`, size, network, helper `files`, `setup_commands`), `vault_ids`, `metadata.agent_empire_task_id` (support on create is unverified) and the first `input`. A lost or invalid response means `sent=true`, so the job becomes `dispatch_uncertain` and is never retried. The pre-session environment check (`GET /v1/agents/environments/{id}`) is observation only |
| `observe` | `GET session`: status, `usage`, `required_actions`. Then `GET turns?order=desc&limit=20` for the latest root turn (`subagent_id: null`). Mapping: turn `completed` + session `idle` gives `end_turn`; turn `failed` or session `failed` gives `error` / `failed`; `cancelled` gives `cancelled`; `requires_action` gives `waiting_for_approval`. It persists ids, statuses and token counts only, never items or text. Usage is held monotonic (max seen) because it "may change" |
| `interrupt` | `POST .../events {"events":[{"type":"agent.session.input.cancel"}]}` with an `Idempotency-Key` derived from the job id and stop request |
| `archive` | `DELETE /v1/agents/sessions/{id}`. A 409 means retry next run. Success sets `deletedAt` |
| `branchHead` | Unchanged (shared helper) |

The adapter's cost estimate (§5) needs the session `created_at` and the container size from the session's `environment.container_size`.

## 5. Money-safety mapping

| Rule | Anthropic today | OpenAI mode |
|---|---|---|
| Reserve before any paid call | Per-job allowance | Unchanged |
| Provider-side cap | `budget.max_list_cost` per session | **None per session (documented).** The coordinator cancels the turn when the estimate reaches the reservation. Recommended: a hard monthly project spend limit as the provider-side backstop |
| Uncertain dispatch | `sent=true` leads to `dispatch_uncertain`, never retried | Identical. The resolution UI says "check platform.openai.com/logs?api=agents for task <id>" ([observability](https://developers.openai.com/api/docs/guides/agents-api/observability)). A future read-only list-and-match on `metadata` may add evidence but never auto-resolves |
| Cost reporting | Exact `list_cost`, basis `provider_reported_list_cost` | **Estimate**, basis `estimate_from_reported_usage`: tokens × list price + container time. Every place that shows it is labelled "Estimated from OpenAI-reported token usage. Not a bill; your OpenAI invoice is authoritative." Missing usage is shown as "not reported yet", never $0 |
| Overspend window | Provider stops at the cap | Up to one tick interval (15 to 60 minutes) of work can happen past the reservation before the coordinator sees it. Daily admission control uses `max(reservation, estimate)` per job. A job whose estimate exceeds its allowance is flagged "over allowance (estimate)" |
| Credits | Only on accept | Unchanged |

**Estimate formula (proposed default, the "conservative" option).**

- Uncertain token pricing is rounded up: uncached input is priced at the cache-write rate, cached input at the cached rate, and output (including reasoning) at the output rate, all at short-context rates.
- Container time: `size` rate × ceil((last observed time, or deletion time, − created_at) / 20 minutes), counted until a confirmed delete.
- A 10% margin is added.

Prompts above 272K tokens and any tool fees are invisible to us, which is stated in the label. The price table is a dated constant (`checked: '2026-10-08'`) next to `WORKER_MODELS`.

Example (`gpt-6.1-sol`, medium, about 30 minutes, 0.5M uncached input + 1.5M cached + 0.1M output): $1.25 + $0.15 + $1.00 + $0.24 = $2.64, × 1.1 ≈ **$2.90**. The current default per-job allowance ($1, `DEFAULT_LIMITS`) is likely too low for OpenAI jobs. Setup should show this example.

## 6. Key storage

`OPENAI_API_KEY` uses the existing libsodium sealed-box Actions secret (already in `SECRET_NAMES` and the workflow `env:`). The key is used only by the coordinator and never enters the sandbox; the Agents API rejects `OPENAI_API_KEY` in `env` anyway. Setup guidance asks for a **restricted key in a dedicated project** with `api.agents.read`, `api.agents.write`, `api.responses.write`, `api.vaults.read` and `api.vaults.write`. **New exposure:** the project GitHub token is copied into an OpenAI vault, held by OpenAI and released only to `api.github.com` through the proxy. Setup and Status must say so.

## 7. Model defaults to propose

| Model | Role | Price (in / out per 1M) |
|---|---|---|
| `gpt-6.1-sol` | **Default.** "Near-Astra performance … at a lower cost for complex coding" ([model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol)) | $2 / $10 |
| `gpt-6-astra` | Selectable, the most capable | $10 / $50 |
| `gpt-6-luna` | Selectable, the cheapest ("focused, high-volume tasks") | $0.10 / $0.50 |

Reasoning effort is `medium`, the model default. Agents API support for each model must be confirmed in the spike before it is shown.

## 8. What will not work in OpenAI mode (compared with Anthropic)

- No provider-enforced per-session budget. Costs are estimates, not provider-reported dollars.
- No native repository mount. The workspace is a tarball snapshot without `.git` history unless the git spike passes. Pushing goes through our helper.
- Closing a session deletes it, so there is no soft archive. Saved items are gone from the API afterwards.
- The sandbox expires after 1 hour idle, which is not configurable. A turn left open for review can lose unpushed files.
- No ZDR, and US-only residency.
- Web search and subagents are off because their cost is not attributable.
- The Claude models and the Managed Agents toolset and agent provisioning do not apply. Limits shows OpenAI models when the Empire's provider is OpenAI.
- One provider per Empire in v1. Jobs cannot be mixed across providers.

## Owner decisions

| # | Decision | Recommended default |
|---|---|---|
| D1 | Execution surface | Agents API with an OpenAI-hosted sandbox. The fallback is the Responses API with hosted shell. The Codex Action on the user's runners is only if both fail |
| D2 | How the repository credential reaches GitHub | An OpenAI vault `environment_variable` credential bound to `api.github.com` (token copied to OpenAI, never visible in the sandbox). Never put the token in `environment.env` |
| D3 | Cost enforcement | A coordinator ceiling estimate that cancels at the reservation, **plus** setup strongly recommends (and Status shows) a hard monthly spend limit on a dedicated OpenAI project |
| D4 | Estimate method | Conservative (uncached input at the cache-write rate, 20-minute container blocks, +10%) |
| D5 | Default per-job allowance for OpenAI jobs | $3, shown with the §5 example. The daily limit stays user-set |
| D6 | Default model | `gpt-6.1-sol`, effort `medium`. Astra and Luna are selectable once the spike confirms support |
| D7 | Sandbox network | `enabled`, matching the owner's "unrestricted" Anthropic choice. The secret still goes only to `api.github.com` |
| D8 | Container size | `medium` (2 vCPU, 4 GB, $0.12 per 20-minute block) |
| D9 | When to delete sessions | Immediately once the branch moved past the source commit, or on cancel or shutdown. Keep a session with an unconfirmed branch (slot held), but warn that the sandbox expires after 1 hour idle |
| D10 | Provider when both keys are present | One Empire-level provider in Limits. The default stays Anthropic; switching requires no active jobs |
| D11 | Data terms | Disclose no ZDR and US-only residency in setup review; no opt-out |
| D12 | Spike budget | Approve one paid spike (slice 06-0) capped at $1 on a throwaway repository |

## Slices

| ID | Slice | Acceptance |
|---|---|---|
| 06-0 | **Owner-approved spike** (paid, ≤ $1, throwaway private repo, owner runs it with their key) | A written evidence report answering U1–U8 below with request IDs. No product code is merged on its basis without review |
| 06-1 | Interface generalization (§4 table) | Anthropic behaviour is unchanged: every existing test passes untouched or with only type-level edits. New schema tests cover the `openai` execution, the new cost basis, `deletedAt` and the budget-capability gate. Old states still validate |
| 06-2 | OpenAI transport and adapter | Fake-transport tests (below) all pass. The request-body snapshot contains no secret. No retries on create |
| 06-3 | Repository helper (`ae-fetch` / `ae-publish`) | Unit tests against a fake GitHub API: only refuses non-task refs, never force-updates, parent = `sourceCommit`, binary and deleted files handled, size limits enforced. Shipped inline under 5 MiB |
| 06-4 | Coordinator-side cost estimate and enforcement | A dated price table; the estimate is monotonic; a cancel is issued when it reaches the reservation; `budget_paused` with an estimate message; daily admission uses `max(reservation, estimate)`; the ledger separates estimated from observed |
| 06-5 | Provisioning (vault and credential sync) and setup/Limits/Status copy | Idempotent after a lost create; token rotation updates the credential; OpenAI-only setups can run jobs. The UI labels every OpenAI cost as an estimate and lists the §8 limits and the vault-copy disclosure |
| 06-6 | First real run | Follows the existing owner-approved checklist pattern, with one job and a low allowance. The report separates fake-only evidence from the real run |

**Spike questions (06-0).**

- **U1.** Is `metadata` accepted on session create and echoed back?
- **U2.** Is `gpt-6.1-sol` accepted by the Agents API?
- **U3.** Does the vault placeholder work for `api.github.com` tarball download (with the redirect) and for Git Data API writes?
- **U4.** Does `git` with an `Authorization: Bearer` extra header work through the proxy?
- **U5.** Are session and turn `usage` populated, and when?
- **U6.** Does `DELETE` stop container billing, and does it behave with 404 afterwards?
- **U7.** How is container time actually billed for agent sessions (per minute or per 20-minute block)?
- **U8.** Is there a settable session budget (the meaning of `session_budget_exceeded`)?

## Test strategy (fakes only, no paid calls)

All tests use an injected `fetch`. No test reads a real key. CI fails if `OPENAI_API_KEY` is set in the test environment. The cases to cover:

- **Dispatch.** A pre-check failure gives `sent=false` and a requeue. A create timeout, 5xx after send or invalid body gives `sent=true` and `dispatch_uncertain`, with exactly one create request recorded. A 4xx on create is also `sent=true`: we cannot prove the request was rejected before acceptance.
- **Body hygiene.** The create body contains no project token, API key or prompt in `metadata`. The token appears only in the vault-credential request. `env` contains no reserved names.
- **Observe mapping.** Every session and turn status combination is covered. `requires_action` gives `waiting_for_approval`. Usage `null` shows "not reported yet". Decreasing usage keeps the max. Subagent turns are ignored for the root outcome.
- **Stops.** Cancel then delete. A 409 on delete is retried next run with the slot held. A 404 after a confirmed delete is closed; a 404 without `deletedAt` is an error. Shutdown deletes every live session and keeps `dispatch_uncertain` jobs listed.
- **Budget.** An estimate crossing the reservation issues one cancel (idempotency key reused across runs), leads to `budget_paused` and no resume. Daily admission accounts for estimates.
- **Ledger.** Estimated and observed are kept separate. Credits are paid only on accept.
- **Provisioning.** A lost vault create is found by the next list. Credential rotation works. A missing key gives the existing "Waiting for …" copy.
- **Schema.** OpenAI execution, rejection of secrets in execution, and migration-free validation of existing Anthropic states.
- **Regression.** The full existing `npm test` suite passes, and the Anthropic fake-transport tests are unchanged.
