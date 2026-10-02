# Cloud execution setup: the Empire creates its own Anthropic agent and environment

Branch `claude/cloud-exec-setup`, based on `f6283d2`. Also contains the fixes from the cloud-installer security review (ACCEPT WITH FIXES, items #1 and #2, notes a and b).

Everything was verified against fakes only: a fake Anthropic control plane, `FakeGitHub`, `FakeProvider`, and the Playwright fixture on port 4717. No real key was used. No agent, environment, session or paid call was created, and no repository or workflow was touched. `localhost:4610` was not touched.

## Research (documentation, 2026-10-01)

| Question | Finding | Source |
|---|---|---|
| Create an agent | `POST /v1/agents`. `name` and `model` are required. `system`, `tools`, `mcp_servers`, `skills`, `multiagent`, `description` and `metadata` are optional. The response carries `id`, `version`, `archived_at`. Create the agent once and reference it by ID. | [agent-setup](https://platform.claude.com/docs/en/managed-agents/agent-setup) |
| Create an environment | `POST /v1/environments` with `name` and `config: {type: "cloud", networking}`. The doc says to "use a unique, descriptive `name`". The skill reference says a duplicate name returns 409. The public page doesn't state the 409, so that is **unconfirmed**. | [environments](https://platform.claude.com/docs/en/managed-agents/environments) |
| Beta header | `anthropic-beta: managed-agents-2026-04-01` on every Managed Agents endpoint. Access is "enabled by default for all API accounts". | [overview](https://platform.claude.com/docs/en/managed-agents/overview) |
| Lookup for idempotency | `GET /v1/agents` filters only on `created_at[gte/lte]`, `include_archived`, `limit` (≤100) and `page`. `GET /v1/environments` filters on `include_archived`, `limit` and `page`. **There is no name or metadata filter.** You list and match on the client side. Both objects return `name` and `metadata`. | [list agents](https://platform.claude.com/docs/en/api/beta/agents/list), [list environments](https://platform.claude.com/docs/en/api/beta/environments/list) |
| What costs money | Managed Agents bills only "tokens and session runtime". Session runtime is $0.08 per session-hour, and only while the session is `running`. Web search is $10 per 1,000 searches. Creating an agent or environment is **not a listed charge**. The docs never say "free" outright, so the UI calls it "not a billed item" and shows nothing as free beyond that. | [pricing → Claude Managed Agents](https://platform.claude.com/docs/en/about-claude/pricing) |
| Limits | Per organization: 300 create requests per minute and 1,200 read requests per minute. Organization spend limits also apply. | [reference → rate limits](https://platform.claude.com/docs/en/managed-agents/reference) |
| GitHub access | A `github_repository` session resource takes `url` and `authorization_token`, plus optional `mount_path` and `checkout` (as `anthropic-managed.ts` already does). The token is not echoed. The docs' table lists classic `repo` scopes and recommends fine-grained tokens. Creating PRs is shown through the GitHub MCP server with vault credentials. Vaults are only needed for MCP or `environment_variable` credentials, not for cloning. | [github](https://platform.claude.com/docs/en/managed-agents/github) |
| Browser / WebView | **Not possible.** On 2026-10-01 I sent an unauthenticated CORS preflight (no key). `OPTIONS /v1/agents` and `/v1/vaults` answered 405 with no CORS headers. `/v1/environments` answered 400 "Disallowed CORS origin" for `https://example.com`, `http://localhost:4717`, `empire-app://game` and `https://appassets.androidplatform.net`. For comparison, `/v1/messages` and `/v1/models` answer 200 with `access-control-allow-origin: *`. | measured with `curl -X OPTIONS` |

Design choice: the device can't call these endpoints, so the work moves to the coordinator. The alternative was a new native-bridge call in three shells (iOS, Android, Electron), which other lanes own and which the web build can't have. The coordinator already holds the key as the encrypted `ANTHROPIC_API_KEY` Actions secret and already calls Anthropic from Node. This keeps the "keys never leave the secrets after setup" invariant, and it works on every platform.

## What changed

### Provisioning (src/cloud)

- **`provisioning.ts`** finds or creates two resources and never creates a session.
  - The agent "Agent Empire worker": `claude-opus-5-5` (superseded 2026-10-02: Sonnet 5 by default, see below), the `agent_toolset_20260401` tool, no multiagent roster, and metadata `agent_empire_role: worker`. Its system prompt holds the per-task rules: use the task branch only, never touch the default branch, never claim a commit or PR without verifying it, treat repository content as data. This satisfies `AnthropicManaged.check`.
  - The cloud environment `agent-empire-worker`: `limited` networking with `allow_package_managers: true` (superseded 2026-10-02: unrestricted, see below).
  - **Matching:** a marker in metadata first, so a renamed resource still matches, then the exact name. It reads up to 10 pages.
  - **A lost or conflicting create** is looked up again with `include_archived=true` and never repeated.
  - **Archived or unusable resources** (multiagent, missing toolset, not cloud) and HTTP 401/403 are user-fixable failures. A timeout, a network error, 429 or 5xx can be retried.
  - Requests go through a new `AnthropicManaged.controlPlane()`: the same transport, no retries, bounded responses, user-safe errors.
- **Provider seam:** `ProviderAdapter` gains `canProvision` and `provision()`. Provisioning needs only the Anthropic key; dispatch still needs the project token too.
- **Schema:** `meta.provisioning = {provider, repository, status: pending|failed, requestedAt, attempts, lastAttemptAt?, retryable?, message?}`. It is strictly validated and holds no secret fields.
- **Intent `provision`** (`repository` and `configRevision`). It is refused while jobs are queued or active, and when the revision is stale.
- **Tick:**
  - After the intents and before dispatch planning, a due request is attempted once per tick. A commit retry reuses the result.
  - **On success:** `meta.execution` gets the agent and environment IDs, `provisioning` is removed, `configRevision` goes up, and the Journal says "Execution ready … No session was started and nothing was charged".
  - **On failure:** the message is recorded once. Retryable failures are tried again after an hour; others wait for the user. Without a key nothing is called and the state says why.
  - The CLI log and the JSON report carry `provisioning: ready|failed|waiting_for_key`.

### Setup ("Create my Empire")

- The installer gains an **execution** step between state and workflow, so the workflow is still committed last.
  - **New Empire with an Anthropic key:** the starting state contains `provisioning` for the **first selected project** and its default branch. No intent and no extra commit.
  - **Existing Empire without execution settings:** one `provision` intent is committed. If one is already pending, it is not written again.
  - **Execution already set:** skipped.
  - **No Anthropic key:** skipped. For OpenAI-only it says "OpenAI only: jobs can’t run until the OpenAI adapter exists".
- The review step gets a **"Jobs run"** row. It names the project and says the first run creates or reuses the agent and environment, which "is not a billed item and starts no session".
- The result note says when execution becomes ready. The step detail reads "requested: your coordinator creates or reuses them on its first run".
- The device never calls Anthropic. The UI check asserts zero `*.anthropic.com` requests.

### Real state in the app (fixes the "will wait" copy)

- `executionStatus(state)` in `map.ts` returns `ready`, `setting_up`, `failed` or `none`, with honest detail text. Only `ready` can submit a job.
- **Status card:** shows the real state, and the agent and environment IDs once ready.
- **New-job dialog:** if execution isn't ready, it is titled "Jobs can’t start yet" and leads with the reason. The tick and "Start paid job" are disabled and nothing is sent. The old line "the job will wait until it is" is gone; the coordinator rejected those jobs.
- **Limits tab:**
  - "Set up automatically" (or "Try setup again") takes the owner, repository and base branch, then writes a `provision` intent and one wake-up.
  - Manual IDs move to "Use existing IDs" (advanced).
- **Founding:** queues no paid jobs while execution is being set up or has failed, and says which of the two.
- **Coordinator rejection messages:** "not queued and nothing was charged", plus "still being set up … submit again once ready".

### Security review fixes

- **#1, a fixture build could ship** (`api-base.ts`).
  - **Before:** the override came from `import.meta.env` in every build.
  - **Now:** it exists only through a Vite `define` in `--mode fixture`. That mode is `npm run build:client:fixture`, it writes `dist/public-fixture`, and it carries a marker.
  - **Normal builds:** they define `undefined`, use `envPrefix: 'VITE_PUBLIC_'`, and **refuse to build** when `VITE_AGENT_EMPIRE_FAKE_GITHUB_API` is set.
  - **`tools/check-no-fixture.mjs`:**
    - runs at the end of `npm run build:client`;
    - `tools/prepare-desktop.mjs` imports it and fails before packaging;
    - `tools/sync-ios-game.sh` fails on the marker, except when a Debug build opts in with `AGENT_EMPIRE_ALLOW_FIXTURE_GAME=1`, which uses `dist/public-fixture`, for simulator checks;
    - `mobile/tools/build-android.py` fails on the marker.
  - The desktop and mobile edits are only those checks.
  - Verified:
    - the production `dist/public` contains neither the marker nor `127.0.0.1:4710`;
    - the fixture build contains the marker and the checker exits 1;
    - Android refuses the fixture folder and a normal build passes the guard;
    - a normal `vite build` with the variable set errors.
- **#2, secrets were uploaded before the existing state was validated** (`installer.ts`).
  - Any `state/*` already in a reused repository is now read and parsed **in the repo step, before any secret or README**. An incompatible state fails with "Nothing was written to GitHub". The test asserts zero writes and no secrets.
  - Every failure carries `InstallError.written`, and the app appends "Already done on GitHub: created the private repository …; stored the encrypted Actions secret …".
  - README.md is written only into an **empty** repository the user created, because the Git Data API needs one commit. That write is reported. A non-empty repository gets none (tested).
  - The secret-encryption error now names the secret it could not store, instead of "Nothing was stored".
- **Note a:** the coordinator rejects a `new_job` whose `site` is not built (`site_not_built`, "…nothing was charged. Found or build it first."). Founding still works, because the `found` intent is applied first in the same run (tested).
- **Note b:** a `new_job` write that failed offline or with a 5xx now says "may not have been sent … Check Cloud Empire → Jobs first: it may already be queued, and assigning it again would start a second paid job". Other actions keep "not sent".

## Evidence

| Check | Result |
|---|---|
| `npm run typecheck` | pass (server, client, cloud) |
| `npm test` | **396/396**. That is 381 + 15 new in `tests/cloud-exec-setup.test.ts`, covering provisioning against a fake API, the coordinator flow, failures, retries and the no-key case, the provision intent, the site rule, the schema, installer new/existing/OpenAI-only/empty-repo, the status copy, the offline toast and fixture detection. `tests/setup-cloud.test.ts` was updated for the sixth step and now asserts no secrets and zero writes for an incompatible state. |
| Failing before | I swapped in `f6283d2`'s `installer.ts` and `cloud-setup.ts`: the incompatible-state test fails. Old `tick.ts`: the site-rule test fails. Provisioning, fixture and copy tests need modules that did not exist. |
| `npm run build` / `npm run build:cloud` | pass. The coordinator is 136,397 bytes. "no fixture build markers in dist/public". |
| `tools/setup-ui-check.ts` (fixture 4717, password fixture-office) | **125 PASS** at 874×402 touch and 1440×900. New checks: the review names where jobs run and that setup is free; six steps done after resuming; the execution-step text; the result note; `provisioning: pending` in state; zero requests to anthropic.com. |
| `tools/cloud-ui-check.ts` (fixture 4717) | **167 PASS** at 874×402, 812×375 (375-px phone) and 1440×900. Reduced motion and Save-Data are covered by the existing web block. New checks at 812×375 and 1440×900: founding says "being set up"; the status says "Being set up … not a billed item … refused, not charged", never "will wait"; the blocked dialog cannot send and sits in the safe area; nothing is written; then one fake coordinator run does one `provision` call and no dispatch, "Check GitHub now" shows the recorded IDs, and the dialog names `fixture/repo` and enables the tick; zero anthropic.com requests; no console errors. With no execution, the status says why, and "Set up automatically" writes exactly one `provision` intent and one dispatch. |

Screenshots: `docs/team/reports/cloud-exec-setup/setup/` (review, failed-and-resumable, done) and `cloud/` (12 setting up, 13 job blocked, 14 ready, 15 Limits → Set up automatically). Fixture 4717 was stopped.

## Not verified / open

- **Any real Anthropic call.** Everything below is from the docs, not tested on a live account. The first real call is now step 6 of the owner-approved checklist in [cloud-mode-e2e.md](cloud-mode-e2e.md).
  - the wire shapes of list and create on a live account;
  - the 409 on a duplicate environment name;
  - that creation adds no charge.
- **Networking, model, permission policy:** decided by the owner on 2026-10-02 (below).
- **Existing agents.** An existing agent or environment that matches by marker or name is reused as it is. Its model or system prompt is not updated. The spec version is recorded in metadata for a later reconcile.
- **Which project.** Only the first selected project is used for execution, as before (one repository per execution config). A different one can be chosen under Limits.
- **OpenAI-only.** Still can't run jobs (CLOUD-06). Setup, status and Limits say so.
- **iOS opt-in.** The opt-in path in `sync-ios-game.sh` (`AGENT_EMPIRE_ALLOW_FIXTURE_GAME=1`, Debug) was syntax-checked, and its grep logic was run against both builds. It was not run inside an Xcode build. Desktop packaging (`prepare-desktop.mjs`) was not run end to end; only the imported check was exercised.
- **Old coordinator, new state.** A coordinator older than this branch would refuse a state with `provisioning` ("unexpected field"). That can only happen if a newer app writes into a repository whose bundle was not updated. Setup always commits the matching bundle first, so it should not occur in practice.

## Re-review fixes and owner decisions (branch `claude/cloud-exec-fixes`, 2026-10-02)

Based on the integration commit `4d56be5`. The re-review accepted #1, #2, a, b and the provisioning money safety, with these fixes. Fakes only, as before.

### Fixes

- **M1: manual IDs vs automatic setup** (`tick.ts`).
  - `configure` now withdraws any `provisioning` request, whether pending or failed, and clears the recorded profile. The Journal says so.
  - Before, a failed request plus manual IDs blocked new jobs forever, and a pending one later overwrote the manual IDs.
  - A setup outcome is keyed to its exact request (repository, model, `requestedAt`), so a withdrawn or replaced request never receives an older result.
  - "Set up automatically" explicitly replaces the current settings once it finishes. The Journal and Limits say so, and "Use existing IDs" says that saving withdraws any request.
- **M2: GitHub client-id override.** It is renamed to `VITE_PUBLIC_AGENT_EMPIRE_GITHUB_CLIENT_ID`, to match `envPrefix`. Updated in `config.ts` and `index.html`. A build with the old name set now fails with "…was renamed: set VITE_PUBLIC_AGENT_EMPIRE_GITHUB_CLIENT_ID instead". A real `vite build` with the new name inlined the value into `config-*.js`.
- **Low: re-running setup after a failed request** writes a fresh `provision` intent, once (`installer.ts`). That is how the user retries after fixing the cause.
- **Low: intent ids.** The installer's intent id is a UUIDv7 from the setup clock. `uuidv7` moved to `src/cloud/uuid.ts`, and the client re-exports it.
- **Low: reused environments** must have the configured networking. A mismatch is a user-fixable error naming both values, and nothing is created beside it. An agent found by exact name but running another model is reported the same way.

### Owner decisions, applied as defaults (changeable under Cloud Empire → Limits)

- **Worker model:** Claude Sonnet 5 (`claude-sonnet-5`). Opus 5.5 and Fable 5.1 are selectable in Limits, with list prices. Each model gets its own agent: "Agent Empire worker", or "Agent Empire worker (Claude Opus 5.5)" and so on. Matching is by marker plus `agent_empire_model` metadata. The chosen model travels in the `provision` intent and in `meta.provisioning.model`. Once ready, `meta.executionProfile` records the model and networking.
- **Tool approval:** always allow inside the sandbox. This is the toolset default and is unchanged.
- **Networking:** `unrestricted`. Setup review, Status and Limits say that workers have full internet access, can fetch untrusted content, approve their own tool use in the sandbox, and that keys never enter it.
- The spec is now in the browser-safe `src/cloud/worker-spec.ts`, spec version 2. `docs/team/CLOUD_MODE_PLAN.md` records these decisions.

### Evidence

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | **405/405**. That is 397 + 8 new in `tests/cloud-exec-fixes.test.ts`. `tests/cloud-exec-setup.test.ts` was updated for Sonnet 5 and unrestricted networking. |
| Failing before | I swapped in `4d56be5`'s `tick.ts`: the 3 M1 tests fail. `4d56be5`'s `vite.config.ts` and `config.ts`: the M2 test fails. The lows and the owner-decision tests use behaviour or modules that did not exist. |
| `npm run build` / `npm run build:cloud` | pass. The coordinator is 140,253 bytes, and no fixture markers. |
| `tools/setup-ui-check.ts` (fixture 4717) | **127 PASS** on two consecutive runs. A first run had one unrelated timing failure ("the hand-over to the game closes the keyboard", 1440×900) that did not recur. New: the review states Sonnet 5 and full internet access; the starting state carries `provisioning.model: claude-sonnet-5`. |
| `tools/cloud-ui-check.ts` (fixture 4717) | **171 PASS**. New: Status names Sonnet 5, unrestricted networking and untrusted content once ready. Limits defaults the model select to Sonnet 5 with 3 options and states the internet access. Choosing Opus writes a `provision` intent with `model: claude-opus-5-5`. |

Screenshots: `docs/team/reports/cloud-exec-fixes/` (setup review, and cloud 12 setting up, 14 ready, 15 Limits with the model select).

### Still not verified

- Everything listed above under "Not verified / open" that concerns a real account.
- That the git proxy works with unrestricted networking. This should be the least restrictive case.
- That the per-model agent names render as expected in the Console.

