# Cloud mode end to end: CLOUD-02 wiring, CLOUD-04 adapter, CLOUD-05 shutdown/start

Branch `claude/cloud-mode-e2e`, based on `2da4548`. Also adds the desktop "Run on this computer" card requested mid-task (page side of APP-05 round 2).

Everything here is verified against **fake GitHub APIs only** (in-memory in tests, Playwright routes in Chrome, and a loopback server for the iOS simulator) with the real coordinator tick and a fake provider. **No real GitHub repository, secret, workflow run or provider session was created. No paid call was made.** The first real run is owner-approved and follows the procedure at the end.

## What works now

### CLOUD-02: "Create my Empire" runs the real installer

- `src/cloud/installer.ts` is now stepwise and resumable. Steps, each reported to the setup screen:
  1. **repo**: use or create the private `<login>/agent-empire-state`. A repository the user created on GitHub is reused, even an empty one (it gets a first commit through the Contents API). A token that cannot create repositories is told to create it. Public or foreign repositories are refused before any secret is sent. GitHub's asynchronous `auto_init` is waited for.
  2. **secrets**: the chosen `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `PROJECT_GITHUB_TOKEN` as sealed-box ciphertext (the existing tweetnacl + blakejs sealer). Classic project tokens are refused before any network call. An unusable repository key is reported plainly (found on the simulator).
  3. **state**: the coordinator bundle plus the initial state from `src/cloud/schema.ts`, in one commit. An existing Empire is kept, and only if the coordinator can parse it; otherwise nothing is installed on top of it.
  4. **workflow**: the workflow YAML, committed **last**, so no scheduled run starts before the state exists.
  5. **verify**: read back and parse with the coordinator's rules.
- Every step checks what is already there. "Try again" after a failure continues: the repository is created once, unchanged files are skipped, the existing state is kept. Commits use the Git Data API with `force: false` and retry on a moved branch.
- Setup never starts paid work. No job, no intent, no `repository_dispatch`, no workflow enable/run (asserted in unit tests and both UI checks).
- **Bundle shipping.** `npm run build:client` now also builds the coordinator and `tools/ship-coordinator.mjs` copies it to `dist/public/cloud/agent-empire-coordinator.mjs` with `cloud/coordinator.json` (bytes and SHA-256). The app loads and checks it before any GitHub call, so an HTML fallback page or a truncated file is never committed. It is committed to `coordinator/agent-empire-coordinator.mjs`, where the workflow runs it.
- **Setup UI additions.**
  - Optional project-token field with `PROJECT_TOKEN_GUIDANCE`.
  - Schedule choice 15/20/30/60 (default 30) with the monthly Actions minutes against the account's plan (from `GET /user` → `plan.name`; Free 2,000 / Pro and Team 3,000). It warns when the choice exceeds the plan.
  - The review shows the schedule and minutes.
  - Per-step progress with "already done" for skipped steps.
- The old `intents/setup.json` (not a valid intent; the coordinator would have rejected it) and the `pendingWorkflow` gate are gone.

### CLOUD-04: the game is fed from the state repository

- `src/client/cloud/repo.ts` (`CloudRepo`):
  - Reads the branch head with `If-None-Match`. An unchanged head is a single 304, which doesn't count against the rate limit.
  - On a change, it reads the commit and the tree and downloads only changed `state/*` blobs (cached by sha).
  - Pending intents are counted from the tree.
  - All requests use `cache: 'no-store'` and `credentials: 'omit'`.
  - Errors are classified (`unauthorized`, `rate_limited`, `offline`, `invalid_state` for a newer schema or a missing Empire, and so on).
- `src/client/cloud/net.ts` (`CloudNet extends Net`) replaces the WebSocket in cloud mode, so `main.ts`, the city, HUD and management keep using the same store.
  - **Polling:** every 60 s while visible; immediately on focus, visibility, pageshow or coming back online; every 15 s for 3 minutes after an action. A hidden page does not poll.
  - **Relaunch:** the snapshot saved on this device is shown at once, labelled "Saved", then GitHub's (`loadSavedSnapshot`).
  - **Mapping** (`map.ts`): the empire state goes to `store.empire`, jobs to the office queue board, and the ledger to provider spend (USD).
- **Honesty.**
  - `store.evidence()` is never fresh in cloud mode (new reason `snapshot`).
  - The HUD strip always shows `☁ Snapshot 12 min ago` (or `☁ Saved · …`, `Waiting for first run`, `Coordinator overdue`, `Empire shut down`, `Shutting down`), with job counts "as of snapshot".
  - The connection banner says "Can’t reach GitHub".
  - Management swaps live supervision for "Recorded: …, as of the cloud snapshot N min ago; not live."
- **Actions are intents.**
  - Each action is `intents/<uuidv7>.json`, validated with the coordinator's own `parseIntent` before it leaves the device, created with the Contents API (409 is retried) and followed by `repository_dispatch`.
  - Supported: new job, accept and reject, cancel, limits, execution settings (`configure`; without it jobs only wait), and city actions (`empire_action`).
  - A new job always goes through a confirmation. It names the per-job allowance, today's reserved and used against the daily allowance, the billing, where it runs, and the `configRevision` it was checked against. It sends `confirmPaid: true` only after the explicit tick.
  - The coordinator's verdict (applied or rejected, with its journal message) is shown when the intent is consumed.
- **Server-only features explain themselves.** Voice, screen share, issue and PR boards, services, invite, upgrade and pictures are marked `aria-disabled`, and a click opens "Needs your own server". Desk, terminal and chat messages are explained and never sent. The queue opens Cloud Jobs.
- **Cloud Empire window:** Status, Jobs, New job, Limits (with execution settings), Journal.

### CLOUD-05: Shut down / Start

- Menu and the Status tab show "Shut down Empire" (or "Start Empire" when shut down). The confirmation says:
  - active sessions are interrupted and archived;
  - the workflow is disabled: no runs, no Actions minutes, no new provider spending;
  - city time stops, with no catch-up;
  - it takes effect on the next run.
- **Shutdown** writes a `shutdown` intent and dispatches `agent-empire-shutdown`. When the coordinator records `disable_requested`, the app disables the workflow itself once.
- **Start** enables the workflow first, then writes the `start` intent and dispatches `agent-empire-start`. If enabling fails, nothing is written.
- "Forget this device" (replaces Sign out in cloud mode) clears the token, mode, repository and the saved snapshot. The Empire keeps running.

### Launch

- Cloud mode with a stored token opens the game straight away.
- Without one (a browser after the page closed), an "Open your Empire" screen asks for a token (or the device flow in apps) and checks that the repository is visible and private.

### Desktop "Run on this computer" (coordinator request)

- `native.ts`:
  - `app.runLocal()` takes no parameters and has a 10-minute timeout.
  - It refuses a non-loopback `host`.
  - It is desktop only; `webNative` rejects it.
  - `ShellInfo.localAvailable` and `mode: 'local'` are desktop only.
- The mode choice shows a third card only when the desktop shell sets `localAvailable`. A `cancelled:` rejection stays quiet; other rejections are shown. On success the page adopts the session (platform `desktop`) and opens the game without a reload.
- `decideLaunch`: on desktop, `local` with a session goes to the game; without a session it goes to Welcome. Phones ignore `local`.
- `CLOUD_MODE_PLAN.md` bridge contract updated: desktop transport, origin, `app.runLocal`, `localAvailable`, `mode: 'local'`.

## Evidence

| Check | Result |
|---|---|
| `npm run typecheck` | pass (server, client, cloud) |
| `npm test` | **361/361**. The 345 from before, minus 5 obsolete `setup-cloud` tests for `intents/setup.json` and `pendingWorkflow`, plus 21 new: 7 setup (installer via UI path, resume, empty repository, auto_init wait, refusals, schedule estimate, project token), 10 `cloud-client` (uuidv7, ETag polling, error classes, intents with confirmPaid and configRevision, stale-revision rejection by the real tick, 409 retry, mapping and staleness labels, CloudNet saved-snapshot relaunch and server-only refusal, shutdown and start with the app finishing the disable), 4 `setup-local` |
| `npm run build` / `npm run build:cloud` | pass. The coordinator (120,099 bytes) ships in `dist/public/cloud/` |
| `tools/setup-ui-check.ts` (fixture 4707) | **113 PASS**, at 874×402 touch and 1440×900. The real installer runs against the fake GitHub: it fails once at secrets (502), resumes, the repository is created once, the shipped bundle is committed, the 15-minute schedule is used, and nothing is started. The cloud game opens on "Waiting for first run". The server path runs in its own context. The desktop three-card choice: cancel stays quiet, then the fixture sign-in opens the game. Screenshots in `reports/setup/` (`10-create-failed-resumable`, `10b-create-done`, `10c-cloud-game-first-run`, `desktop-01/02`) |
| `tools/cloud-ui-check.ts` (fixture 4708) | **79 PASS**, at 874×402 and 812×375 (375-px phone, landscape) touch, and 1440×900. The repository is seeded by real ticks. Checks: HUD age marker, never "live", server-only explanations with no write, jobs statuses, accept (one UUIDv7 intent plus one dispatch), paid-job confirmation (disabled until ticked; the intent carries `confirmPaid` and `configRevision`; no provider call from the app), shutdown confirmation and dispatch, Escape closes, offline relaunch shows the "Saved" snapshot and the "Can’t reach GitHub" banner, no console errors. Web unlock with reduced motion and Save-Data; the token is never in localStorage. Screenshots in `reports/cloud-mode/` |
| **iOS simulator (iPhone 18 Pro, iOS 27), real app shell** | A Debug app with a fixture client build (`VITE_AGENT_EMPIRE_FAKE_GITHUB_API=http://127.0.0.1:4710`), against `tools/fake-github-server.mts`. Walked: setup token path → repos → key → limits (`ios-01`, 30 min = 72% of Free) → review → create. The first attempt failed at secrets because the fixture server's key wasn't X25519 (`ios-02`; this led to the plain-error fix). After fixing the fixture, Try again resumed (`ios-03`): the server log shows the secret PUT and one state+bundle commit, an unchanged workflow, no dispatch. Then founder → cloud HUD "☁ Snapshot 14 min ago · 2 active · 1 need you · 1 queued" (`ios-04`), Jobs (`ios-05`), Management with cloud supervision (`ios-06`), menu (`ios-07`), shutdown confirmation and sent (`ios-08/09`; the server log shows `PUT intents/01a0f585-….json` and `POST dispatches`), and relaunch straight into the cloud game from the Keychain (`ios-10`). The normal Debug build was reinstalled afterwards |

Fixtures 4707, 4708 and 4710 were stopped. The `localhost:4610` session was not touched.

## Not verified / known gaps

- **Anything on real GitHub or Actions.** The first-real-run checklist below still applies in full.
- **Device flow on a real account in cloud mode.** Only the token path was walked in the simulator. The device flow is covered by the existing bridge tests and the desktop report.
- **CORS details of real api.github.com:** `ETag` exposure, the `If-None-Match` preflight, and Contents PUT from WKWebView and Android WebView. Fake servers sent permissive CORS.
- **Desktop and Android serving `cloud/*.mjs` and `.json`.** iOS maps both (`GameSchemeHandler`). The desktop `app-protocol.cjs` serves "only extensions on a fixed MIME list"; the desktop author must confirm `.mjs` and `.json` are on it, or "Create my Empire" reports the coordinator as missing. Android was not run.
- **Pre-existing modal safe-area issue on iOS landscape**, not introduced here. Large `.empire-modal` windows (Management, and Cloud Empire, which reuses its CSS) sit off-centre, under the Dynamic Island, with the close button at the edge (`ios-05`, `ios-06`). Owned by the interface/mobile lane.
- **The ☁ glyph** in the HUD renders small on iOS. It is cosmetic.
- **Execution settings**: superseded by [cloud-exec-setup](cloud-exec-setup.md). Setup with an Anthropic key now asks the coordinator to find or create the Anthropic agent and environment on its first run; IDs can still be entered by hand under Cloud Empire → Limits. Without execution settings the coordinator *rejects* new jobs (it never let them wait; the old dialog copy was wrong and is fixed).
- **OpenAI-only setups** store the key, but there is no OpenAI adapter yet (CLOUD-06), so jobs can't run.
- **"Ask me before each job"** in setup is not a coordinator setting. Every cloud job is already confirmed explicitly in the app.
- **Plan minute allowances** (2,000 / 3,000) are from memory, as the coordinator report said. Recheck against github.com/pricing.
- **Changing the schedule** after install means running setup again (as before).

## Owner-approved first real run (updated procedure)

Do it on a **throwaway GitHub account** or a disposable `agent-empire-state`, with a low-limit Anthropic key, from a normal (non-fixture) build.

1. **Preconditions.**
   - Confirm the pinned SHAs in `src/cloud/workflow.ts`: checkout v4.2.2 and setup-node v4.4.0.
   - `npm run build`; confirm `dist/public/cloud/coordinator.json` matches the bundle.
2. **Token (web path) or device flow (app).**
   - For a fine-grained token: create `agent-empire-state` private first, then a token limited to it plus one test project. Repository permissions, read and write: Contents, Secrets, Workflows, Actions, Pull requests. Metadata: read.
   - Record which permissions turned out to be required.
3. **Setup.**
   - Choose the 60-minute schedule, $1 per job and $2 a day, one project. Add a fine-grained `PROJECT_GITHUB_TOKEN` for that project only.
   - Watch all five steps reach done.
   - **Expect:** the repository is private; Settings → Secrets lists only the chosen names; three commits (initial, state + coordinator, workflow); no Actions run started.
4. **Resume check.** Run Create again from a second device or browser. Every step should be "already done" except secrets (re-uploaded), and the state must be unchanged.
5. **First runs.**
   - Trigger `workflow_dispatch` from the Actions tab once, or wait for the cron.
   - **Expect:** `state/heartbeat.json` is written. The app shows "Snapshot N min ago" within a minute of a poll.
   - Verify the ETag 304 in the browser devtools Network panel.
6. **Execution: the first real Anthropic call (owner-approved; cloud-exec-setup).** The coordinator's first run uses the owner's `ANTHROPIC_API_KEY` secret to list, then create, an agent "Agent Empire worker" and an environment `agent-empire-worker` (control-plane calls only; no session).
   - **Before:** in the Claude Console, note the existing agents and environments of the key's workspace.
   - **Expect:** the run log line `execution setup: ready (agent created, environment created)`; `state/meta.json` gets `execution` with an `agent_…` and an `env_…` ID and loses `provisioning`; the Journal says "Execution ready … No session was started and nothing was charged". In the Console: exactly one new agent (model `claude-opus-5-5`, built-in toolset, metadata `agent_empire_role: worker`) and one new cloud environment (limited networking, package managers allowed), and **no session**. Billing shows no new charge.
   - **Idempotence:** "Set up automatically" under Limits, then the next run: the log says `reused` for both, nothing new appears in the Console.
   - **Record:** whether `limited` networking with `allow_package_managers` lets the session's git proxy clone and push (checked in step 7), and the exact HTTP status the API gives for a duplicate environment name (assumed 409).
   - If the key lacks Managed Agents access, expect a `provisioning.status: failed` with the provider's HTTP status and no retry until "Set up automatically" is chosen again.
7. **One paid job, approved by the owner.**
   - New job → confirmation → tick → start.
   - **Expect:** an intent file, a `repository_dispatch` run, then `dispatching` / `running`, the session budget equal to the allowance, a branch `agent-empire/task-<id>`, then "Ready for review".
   - Accept it, and see the 500 credits applied.
8. **Shutdown and start.**
   - Shut down: active sessions are archived and the workflow is disabled (by the coordinator with `actions: write`, otherwise by the app after `disable_requested`).
   - Start: the workflow is enabled, a start intent is written, the city clock restarts with no catch-up.
9. **The coordinator report's checklist items 3–9** (default-branch pinning, concurrency, 422 on a non-fast-forward, task-branch lookup, the Anthropic L4 behaviours, budget, Actions minutes after a day). Record the evidence in this report.
10. **Clean up.** Shut down, revoke the tokens, delete the throwaway repository.
