# Backend setup audit and implementation handoff

Date: 2026-09-27. Role: Codex backend. Branch: `codex/team-backend`.

Audited checkout: `a444e5f937de3c696975506e660244d933b7076f` (team setup over product baseline `8b13f52`). This report is the only intended change. The audit read README, architecture, research, team instructions, server/shared code, related client consumers and tests. No product server, project worker, provider call, deployment script, live `.agent-office` file, credential or sibling worktree was used.

## Outcome and first priority

The local prototype runs actual PTY agents and maintains useful queue and city state. It does not yet implement a continuously reasoning supervisor, durable cloud jobs or automatic laptop synchronization. The first backend round should make observed execution and restart interruptions truthful, then prevent overlapping retry/resume attempts. It should not add autonomous dispatch, provisioning or a new provider in the same round.

The most consequential defect is an inconsistent restart policy: worker restoration immediately resumes processes, while queue restoration marks their tasks stopped. The UI can therefore show an offline manager whose previous worker is running, and a retry can launch a second worker for the same work. This was reproduced with fake workers and a temporary queue file; the real provider lifecycle was not exercised.

## Implemented behavior and limitations

### Worker and provider lifecycle

- `WorkerManager.spawn` validates funded desks, occupancy and the optional hiring budget, optionally creates a Git worktree, then launches a real PTY (`src/server/workers.ts:165-203`). Workers are not simulated employees. The configured command/arguments apply to all workers (`src/server/config.ts:67-68`, `:130-131`); per-job provider/model selection and provider onboarding are absent.
- Claude-specific hooks report session start, user prompt, tool use, questions, permission requests and turn end (`src/server/workers.ts:396-456`). Hook delivery uses a loopback server plus per-worker token (`src/server/server.ts:141-164`). Startup timeout and terminal text can infer a trust/login blocker (`workers.ts:608-617`, `:710-726`). Those are observations/heuristics, not evidence of a particular credential problem.
- `WorkerStatus.done` means the turn ended. `Stop`, an idle notification, and OSC idle after working or a rejected/cancelled permission prompt can all produce it (`workers.ts:445-453`, `:646-651`). The queue treats this as `outcome: done`; it does not verify a requested file, passing tests, commit or PR. A completion reward and manager `ready` therefore attest to an observed turn ending, not verified deliverable acceptance.
- Non-Claude commands are marked idle at launch and do not receive the automatic Claude prompt/resume arguments (`workers.ts:539-581`). Current status, usage and task naming are Claude-oriented. A configured alternative CLI is not a complete Codex/Grok provider adapter.
- Worker identity, session, worktree and usage cursor are saved, but process/status/exit state and permission reason are not (`workers.ts:773-830`). Restoration sets each accepted record offline and immediately calls `wakeAll()` in the constructor (`:124-133`). Every browser connection also calls it (`server.ts:494-495`). An exited worker can restart simply because a person reconnects. Failed session resume may silently become a fresh session with a toast (`workers.ts:591-596`); the original prompt is not replayed by that path.

### Queue and restart audit

- `TaskQueue` seats tasks immediately on add/change and every ten seconds, with a default concurrency of three; zero pauses new seating. All busy agent workers count, including workers hired outside the queue. Funded desk capacity and the hiring budget are separate controls (`queue.ts:28-34`, `:62-65`, `:141-146`, `:231-289`). Pausing the queue does not stop existing work.
- A queue task has `queued | running | done` status plus an optional outcome, worker/branch/PR and timestamps (`src/shared/protocol.ts:165-197`). Missing workers finish as killed; exited/offline workers finish as exited (`queue.ts:205-228`). There is no execution-attempt ID, lease, process heartbeat, durable approval, cancellation handshake or structured restart reason.
- **P1 — overlapping work after restart:** running saves become `done / exited`, with error `The office restarted while it was running` (`queue.ts:338-344`), independently of the worker that `wakeAll()` resumed. `retry()` reuses the task ID but drops its worker association and does not inspect the old process (`:120-130`). A replacement can be seated while the earlier worker remains active. Manager retries similarly create a new job key (`empire.ts:230-238`) without coordinating the prior worker.
- **P1 — observer connection causes execution:** `server.ts:494-495` and `workers.ts:206-218` allow a read/reconnect to wake exited workers. `resume()` also bypasses the hiring-budget check in `spawn()`. Preserve existing permission prompts; do not present reconnect or a delegation toggle as permission to restart work.
- The stable manager `jobKey` deduplicates `add()` while a matching task remains in queue storage (`queue.ts:75-76`). This protects a useful partial-write recovery case, but is not durable exactly-once execution: finished tasks can be cleared, both worker/queue saves can be lost, and the two files are not transactional. Finished-history retention is unbounded until clear; the 100-task limit applies only to non-done tasks (`:80`, `:135-139`).
- A queue worktree prompt appends an instruction to commit, push and open a PR (`queue.ts:36`, `:272`). Startup briefs inherit that suffix in Git projects. This is existing prompt behavior, not authorization issued by this audit. Future supervisor policies must make artifact/publish scope explicit instead of assuming every bounded brief should publish.

### Manager and supervision semantics

- Founding/building creates durable manager appointments. Pending appointments receive one bounded real startup brief through the queue, keyed by site and appointment attempt (`empire.ts:118-126`, `:139-159`, `:262-282`). Dispatch occurs at server startup and after successful empire actions (`server.ts:519-525`, `:783`), not because delegation was newly enabled.
- Manager status is derived by matching `jobKey`: queued task -> queued; running task with non-exited worker -> working, except needs_input; done/done -> ready; other outcomes -> offline (`empire.ts:325-358`). Starting and idle both collapse to manager working. `ready` persists after the task/worker disappears; this is a historical appointment capability, not a resident AI process (`:330-336`). `taskId` and `workerId` are useful joins, not liveness proof.
- **P2 — supervision claim exceeds its signal:** `delegated` defaults true and is a saved preference (`src/shared/empire.ts:162`, `:216`). Changing it adds a report but does not start/stop a supervisor or the monitoring loop (`empire.ts:174-182`, `:425-439`). The HUD nevertheless derives “Chief of staff on duty” solely from that flag (`src/client/ui/empire.ts:642`); Management always says administrative monitoring active (`:296-300`). Backend startup reports also need wording that cannot imply verified brief acceptance.
- Ongoing reports are deterministic: attention-count changes generate prompts to open terminals; sector summaries occur every 30 simulated minutes; reports retain the last 80 entries (`empire.ts:114-116`, `:425-439`). Delegation does not gate those checks. The attention check compares counts, so one blocked worker replacing another at the same count produces no new aggregate escalation. There are no stable report IDs, source/evidence references, decision records or last-supervision-check field.
- Worker updates immediately broadcast to clients, but empire state normally reconciles every five seconds. Queue changes also call `empire.tick(..., 0)` (`server.ts:182-184`, `:219`, `:784`). A working -> needs_input change need not change queue state, so manager status may lag the worker by a tick. The first connection can receive restored empire state before its first reconciliation.

### Persistence, simulation and authority

- Empire version 2 validates core save fields, preserves migration backups and writes a temporary file before rename (`empire.ts:33-110`, `:444-449`). Invalid empire data stops loading instead of silently replacing the city. Atomic replacement is not a multi-file transaction or an fsync/power-loss durability guarantee.
- Queue and worker files are direct writes that suppress write errors; invalid JSON starts with empty state (`queue.ts:305-349`, `workers.ts:791-834`). Queue restart normalization is initially only in memory. There is no persistence-health signal for the interface, and no shared revision across worker, queue, usage and empire state. Treat disk failure and crash recovery as unverified durability, not successfully saved work.
- Browser reconnect gets current snapshots, with worker/queue in `welcome` and a separate empire message (`server.ts:473-492`). WebSocket ping/pong checks browser connections, not job health (`:785-794`). There is no event cursor/replay or command acknowledgment/idempotency contract; disconnected sends are discarded by `src/client/net.ts:72-73`.
- Service headcount, coverage, wages, credits and founder dividends are simulation. Hourly revenue eligibility includes managers working, needing input, or ready (`src/shared/empire.ts:243-249`). Thus permission-blocked startup can still enable fictional operating income; do not display it as paid AI productivity. Task rewards are once per task ID (`empire.ts:363-390`). Simulation advances by tick seconds, with no downtime catch-up (`:315-317`); animations do not prove worker execution.
- Provider usage is inferred from Claude transcripts and the code's price table. The optional daily budget warns/blocks new hiring; it is not a hard cap on active or resumed work (`src/server/usage.ts:291-317`, `workers.ts:168-170`, `:206-213`). Task labels may make separate Haiku calls without session persistence (`src/server/tasks.ts:133-160`); this path is not wired to the worker usage ledger or its budget gate. Do not claim the displayed ledger captures every auxiliary provider charge.
- Authenticated same-origin WebSocket access exists (`server.ts:426-439`), but the action handler uses a client-provided display name, with no CEO/manager authorization layer (`:444`, `:516-525`). Permission/question hooks flag human input and are not auto-approved by empire code. Keep these gates; delegated oversight must not gain authority to type approval responses.
- Existing `deploy/aws.sh` and `deploy/provision.sh` can install a single office on EC2 through SSH with a system service. They are source artifacts, not evidence of a deployed/verified cloud platform. This audit did not run them. Multi-tenant isolated runners, encrypted secret management, durable job leases and safe desktop synchronization remain roadmap work.

## Interface coordination: what is available now

Interface ownership stays with Claude. Backend owns the agreed `src/shared/` change, implemented once after coordinator agreement. Grok should review the exact integrated candidate, including mixed-snapshot and restart cases.

| Display/interaction | Derive from current state | Limit or backend requirement |
| --- | --- | --- |
| Delegation preference | `empire.delegated` | Label as requested oversight, not AI availability. |
| Chief startup assignment | `sectors[id=hq].manager`; join `jobKey` to queue, `workerId` to workers | Distinguish no appointment, queued, starting/idle, working, input required, turn ended, stopped/failed. Do not call `ready` a live supervisor. |
| Human action | `WorkerInfo.status === needs_input`, `activity`, linked worker ID | Open its terminal; `acked` is not approval. Typed blocker kind needs a new backend field. |
| Stopped/restarted task | `status`, `outcome`, `error`, timestamps | Can show current error verbatim; do not permanently parse English error text as a restart enum. |
| Queue hold | `maxWorkers === 0`; usage budget/pause fields; active workers | Exact per-task scheduling reason requires a server field. Generic queued is safer than guessing. |
| Last received city snapshot | Client receipt time; `EmpireState.updatedAt` | `updatedAt` changes on every flush, including unrelated actions; it is not job heartbeat or monitoring time. |
| Actual AI counts | Filter `workers` by `kind === agent` and status | Current empire workforce counters do not filter kind; use server correction before treating them as authoritative AI-only counts. |
| Simulation finances | Sector/economy fields, employee accounts, ledger | Always label credits separately from `Usage.cost` (USD). |
| Verified deliverable | Optional branch and PR links | No brief file/hash/test verification exists. Turn-ended and verified artifact need separate fields/milestones. |
| Connectivity | `Net.up` / `onStatus` | Immediately mark data offline/stale on disconnect. Connected alone cannot prove a supervisor or runner is healthy. |

## Proposed first bounded implementation round (not implemented)

Deliver truthful rule-based monitoring and explicit restart interruption, without new provider calls, automated task dispatch or cloud dependencies.

1. Add an ephemeral, typed `SupervisionState` wire snapshot in shared code; keep the persisted empire save at version 2. Publish after workers and queue have reconciled, then on relevant worker/queue changes and a successful monitoring tick. Avoid publishing old saved manager status as fresh startup state.
2. Remove unconditional worker wake-up from constructor/connect. Restore processes as stopped/unknown observations and interrupted queue work as terminal `done / exited` plus a structured optional interruption record. Explicit user resume/retry commands become the execution boundary. Before retiring/retrying a previous worker, prove it stopped; uncertain process ownership blocks retry with a useful reason. Local restart recovery does not claim cloud lease guarantees.
3. Guard queue-owned interrupted workers against independent `worker.resume`: direct the user to one queue recovery action. A retry preserves the logical task/reward ID, records an attempt, and cannot seat a replacement while the prior attempt runs. Manager retries use the same guard instead of bypassing it with a new job key. Pending permission questions remain questions, never implicit consent.
4. Surface existing budget/concurrency gates on recovery as well as spawn, document that the budget remains a hiring gate, and retain user-controlled worktree cleanup. Separate `rule-based monitoring` from `chief startup`, and change backend-generated “brief completed” claims to observed turn-ended wording until artifact verification exists.
5. Make queue/worker save replacement atomic and expose failures rather than emitting a false saved/recovered claim. Preserve malformed files for diagnosis. A durable database/event log is a later milestone; do not claim this removes all multi-file crash windows.

Suggested contract to agree before coding:

| Field | Meaning |
| --- | --- |
| `SupervisionState.schemaVersion: 1` | Wire contract version; separate from `EmpireState.version`. |
| `serverRunId`, `observedAt` | New runtime identity on every server start; timestamp of this projection. Not an execution lease. |
| `delegationRequested: boolean` | Copy of the user's delegation preference only. |
| `monitor.mode: rule_based`, `monitor.lastCheckAt?: number` | Last successful worker/queue monitoring pass in this runtime. Absent until one runs; never inherited from the save. |
| `chiefStartup: { managerId?, taskId?, workerId?, phase, reason? }` | `phase`: unassigned, pending, queued, starting, idle, working, needs_input, turn_ended, interrupted, failed or unknown. Joined current evidence; no autonomous-chief-active state in this release. |
| `attention: { workerId, taskId?, kind, observedAt }[]` | `kind`: setup, permission, question or unknown. Emit only supported evidence, not parsed guesses; transition identity prevents same-count blockers being missed. |
| `QueueTask.interruption?: { reason: server_restart, at: number }` | Structured fact in addition to existing status/outcome, retained across saves/reconnects. |
| `QueueTask.attempt`, `WorkerInfo.processState` | Distinct retry attempt plus observed running/stopped/unknown process state; do not infer a running process from historical manager status. |

The interface should use its local receipt age and disconnect state to label freshness. A proposed initial stale threshold is 15 seconds (three expected monitoring ticks), configurable/tested rather than a provider timeout. The new snapshot should carry joined data so the interface does not derive contradictory supervision claims from separately arriving frames. Existing old-client displays must remain conservative; adding fields alone cannot fix the current HUD string.

Acceptance tests for this round, using injected process adapters, fake clocks and temporary data directories:

- Startup and browser connect/reconnect make zero spawn/resume/provider calls; a restored running queue job is visibly interrupted before the first usable supervision snapshot.
- Retry while a prior process is running/unknown is refused. After confirmed stop, one explicit retry creates exactly one new attempt; repeated commands cannot duplicate it. Independent resume cannot bypass the queue recovery policy, desk capacity or hiring budget.
- Delegation true with no chief, offline chief, queued startup, permission request or completed startup never reports a continuously running AI supervisor. Rule-based monitoring can remain active independently.
- A restored manager does not advertise working/ready before reconciliation. Starting and idle workers remain distinguishable from working. Shell workers do not increment AI counts.
- Switching the blocked worker while keeping attention count constant produces the correct per-worker evidence. Opening a terminal or marking it acknowledged does not resolve or approve the request.
- Disconnect immediately removes live claims; stale monitoring is visible without claiming the runner failed. Reconnect yields one internally consistent projection with the current `serverRunId`.
- Simulate save failure and interruption between queue/empire writes; preserve the prior valid files, report persistence failure, avoid duplicate manager dispatch and preserve once-only reward identities. Keep legacy-save migration fixtures.
- Run `npm run typecheck`, `npm test`, `npm run build`; integrate Claude's UI labels and run browser checks against disposable fixtures. Grok reviews that exact candidate commit before the integration branch is updated.

## Later milestones and release gates (plans only)

| Milestone | Backend deliverable | Acceptance evidence |
| --- | --- | --- |
| Durable job foundation | PostgreSQL job/attempt/approval records, transactions/outbox, immutable ordered event IDs, command idempotency keys, versioned migrations, explicit succeeded/failed/cancelled/interrupted states and artifact manifests | Kill/restart the service between each transition and delivery. Exactly one logical attempt/approval/reward is recorded; duplicate messages are harmless; failed migrations retain a restorable backup. Turn end alone cannot mark an artifact verified. |
| Isolated cloud execution | Provider adapter capability matrix, selected compute runner, per-job workspace/container, resource/network policy, expiring lease and fencing token, authenticated heartbeat, bounded retries and explicit uncertain outcome | Close every browser and the originating laptop; an authorized fixture task finishes remotely with attributable commit/hash. Kill a runner mid-side-effect; stale fencing tokens cannot commit state; uncertain effects require reconciliation instead of blind retry. Cancel is acknowledged by a stopped process, not just a UI flag. |
| Identity, authority and spend | CEO/manager roles, scoped GitHub App or OAuth repository access, encrypted server-side secrets, rotation/revocation, immutable approval audit, provider/job/day limits and auxiliary-call accounting | Cross-tenant/repository access fails; revoked/expired credentials cannot launch jobs; retries/reconnects cannot reuse an invalid approval; secret fixtures never appear in browser storage/logs/Git. Budget reservations account for concurrent and auxiliary calls, with documented residual provider billing limits. |
| Reconnect and evidence | Server revisions/cursors, resumable event stream, snapshot/replay boundary, operation acknowledgments, artifact verification and authoritative monitoring health | Two clients disconnected at different points converge to the same ordered state. Duplicate/out-of-order events neither regress state nor create jobs. Missing/corrupt artifacts prevent accepted completion; stale evidence is visible. |
| Safe desktop companion | Opt-in repository mapping, authenticated transport, immutable manifest hashes, fetch completed branches into a separate local worktree, persisted synchronization cursors and receipts | Dirty tracked, staged, untracked and ignored laptop files remain byte-for-byte unchanged. Conflicts/divergent bases produce a reviewable separate checkout. Reject wrong repo, traversal paths, symlink escapes and hash mismatches. Interrupt/reconnect/repeat a transfer without partial overwrite or repeated integration. |
| Reviewable integration and packaging | Preview commit/diff and source job; explicit integration command, precondition recheck and rollback record; desktop/PWA packaging only after sync protocol is stable | A concurrent local edit invalidates integration preconditions; no force-push/reset/automatic stash-discard. Approved integration is reversible and records base/head/result. Web/desktop report the same job evidence; offline mode never pretends to run provider jobs. |

Choose cloud vendor, provider authentication mode, data retention and monetary ceilings with the coordinator before implementation/provisioning. These are architecture decisions, not blockers for the local status round. The user must authorize any later paid infrastructure or credential action through that concrete implementation workflow.

## Checks actually performed and remaining blockers

- `npm run typecheck`: passed (server and client TypeScript).
- `npm test`: passed, 48 tests, zero failures/skips. Fixtures use temporary directories/fake queue workers; the funded-desk WorkerManager assertion does not construct a manager or launch a PTY.
- Additional read-only source audit plus a temporary `tsx --input-type=module` reproduction: seeded a running queue task, supplied a fake prior worker in working state, restored the queue, asserted outcome exited, retried, and observed a second fake worker. Passed. The fixture was removed and no product/test file was added.
- `git diff --cached --check`: passed before commit. Build and browser preview were intentionally not invoked for this report-only change. No live provider, crash-kill, actual restart, real Git cleanup or cloud/sync behavior was tested.

Existing coverage validates founding, paused-queue job-key deduplication, manager projection, earnings deduplication, migrations and capacity (`tests/economy.test.ts:83-190`, `:238-282`; `tests/empire.test.ts:11-43`; `tests/headquarters.test.ts:54-73`). It does not exercise WorkerManager restart plus queue restoration, browser-triggered wake-up, permission/cancel completion semantics, save failures or durable event recovery. Passing 48 tests does not resolve these findings.

No blocker prevents delivering this report. Product implementation waits for the coordinator/interface agreement on the shared supervision and recovery contract. Grok should prioritize the restart overlap, reconnect side effects and false completion claims, then verify that any fix preserves permission gates, worktree contents and existing save compatibility.
