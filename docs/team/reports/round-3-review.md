# Round 3 review

Reviewed candidate: `9b17823031038e9bfb1d63be5a2e093eb58ca222` on `codex/team-review`.

No concrete blocker. No remaining confirmed paid-duplication, credential, reservation, or shutdown defect.

## Result

The earlier queue-preference finding is closed. Opening the packaged local city no longer writes `maxWorkers: 0` over a saved concurrency preference. Cloud submission still reserves before the paid POST, reuses a lost response’s task ID, and does not create a second session for that ID. The `82c0926` confirmation and host-scope guard, the timestamp regression, and the local/VPS budget-control hide are included in this candidate.

Documented limits in [docs/team/ROUND_3.md](../ROUND_3.md) are not defects: no real provider session was validated, outputs stay unverified, and this round does not claim mobile UI verification.

## Closed

Desktop startup with `requireExecutionSetup` used to call `queue.setLimit(0)`, and `setLimit` persisted that value. A new city default of 3, or an existing saved limit, was overwritten before the user chose concurrency. The in-memory approval flag already paused seating.

`02f3a92` keeps the pause transient. The saved `maxWorkers` is what `queue.json` retains; the effective limit is 0 only while `pauseOnStart` is set. Seating does not run during that pause. An explicit `queue.limit` clears the pause and, when the chosen number differs, writes that choice. Evidence: [src/server/queue.ts](../../../src/server/queue.ts#L80), [src/server/queue.ts](../../../src/server/queue.ts#L165), [src/server/server.ts](../../../src/server/server.ts#L277).

## Scope checked

A confirmed submission is admitted again after source lookup, then the ledger stores `dispatch_uncertain` and the full per-task reservation before `POST /v1/sessions`. The same task ID returns the saved record and does not create again. A different prompt or revision for that ID is rejected. Lost create responses stay uncertain across restart; polling and refresh do not invent a session. Shutdown rejects the in-flight operation and does not let it overwrite a ledger reopened by a new process. Evidence: [src/server/execution.ts](../../../src/server/execution.ts#L119), [src/server/execution.ts](../../../src/server/execution.ts#L252).

Idle, approval-paused, budget-paused, and unknown sessions keep a concurrency slot. Terminal tasks release the slot but still count toward the UTC-day allowance. A provider budget that does not match the saved reservation stays unknown and reserved. Stop writes intent before interrupt, archives only a confirmed idle session, and does not archive a running session when interrupt is unconfirmed. Background polling skips terminal records. `createdAt` stays the submission time; `updatedAt` moves on observation, including an explicit check of an already terminal task.

Setup and task HTTP responses carry credential flags, not raw keys. The ledger and sanitized provider errors do not contain the fixture secrets. The GitHub token is sent to Anthropic only inside an explicitly submitted session create, which the confirmation copy states. Remote windows have no preload and no Node integration. Launcher IPC is limited to the launcher frame.

The cloud panel persists the pending ID before send, resubmits that same ID and prompt, and releases it only for a proven pre-dispatch rejection. `82c0926` refuses send when the live host or repository/agent scope no longer matches that record. Stop and Forget use an in-app modal; Forget still requires that explicit confirmation and warns that an accepted task may remain billed. Paid submission still requires the checkbox. Cloud spending controls are hidden unless cloud mode is selected, so local and VPS setup does not present them as coverage. Status age is labeled separately from submission age.

## Checks

- `git rev-parse HEAD` was `9b17823031038e9bfb1d63be5a2e093eb58ca222`; worktree clean before this report. `dd5a935` is an ancestor. `02f3a92`, `82c0926`, `1952762`, and `9b17823` are in this candidate.
- Inspected the execution manager, Anthropic adapter, validation, server routes, queue pause, desktop window/vault boundaries, and the cloud confirmation/pending UI, including the commits after `82c0926`. Did not rerun the baseline audit.
- `npx tsx --test tests/execution.test.ts tests/execution-ui.test.ts`: 25 passed, 0 failed. Fake transports and temporary directories only. No real credentials, no port 4610, and no packaged app launch.

## Coordinator evidence, not repeated here

Coordinator reports `npm test` 138/138, typecheck, and `git diff --check` passed. Coordinator also reports a packaged macOS app opened a temporary empty Git project, rendered the bundled city, queued the founding brief without launching a worker, quit, and reopened the same loopback origin and queued task. A port-4617 fixture intercepted provider requests; browser and packaged-desktop QA submitted one fake session, showed unverified idle, and confirmed Stop archived it. This review did not run those full-suite, package, browser, or desktop checks.
