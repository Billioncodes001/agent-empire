# LIFE-04: Dependencies and recreation while waiting

Branch `claude/life-04-waiting`, based on `codex/empire-world` at `fa5c6e0`. This is a candidate for independent review. It is not merged and not pushed.

## What shipped

**Server**
- `QueueTask.dependsOn`, `blockedBy` and `deskId`, plus `WorkerInfo.waitingOn {id, name, taskId}` in `src/shared/protocol.ts`. The pure dependency rules are in `src/shared/dependencies.ts`.
- `TaskQueue.add(..., dependsOn)` rejects unknown ids, lists of more than 8, self-dependencies and cycles, and drops duplicates.
- `seat()` skips a blocked task. That task never takes a desk or a worker slot, and later independent tasks still run.
- If a dependency ends without `outcome: 'done'`, or goes missing, the dependent task is held: `failed`, with `error: 'dependency <id> did not finish'`. The hold carries down the chain and the held task never runs on its own.
- Retry refuses while a dependency is still failed, and drops dependencies the CEO has removed. Remove refuses on a task that a queued task waits on. `clear()` keeps finished dependencies that queued tasks still need.
- Continuity (as revised in review): a task that unblocks takes the dependency's desk if it's free, otherwise any free desk at once. See "Review fixes" for the full rule.
- `src/server/waiting.ts` is a pure `projectWaitingOn()`. `server.ts` adds `waitingOn` to `welcome` and `worker.update`, and re-sends a worker only when its `waitingOn` changes, on queue or worker events.
- Persistence: the new fields are saved in `queue.json`. On load, `blockedBy` is recomputed rather than read, and a file with a dependency cycle is refused, like other invalid files. Old files load unchanged (tested).
- Consultancy: approved item N depends on item N−1. With `parallel: true` an item runs beside the item before it, and the next ordered item waits for the whole parallel run (`itemDependencies`). Old journal fingerprints are unchanged, and blocked items show as `queued`.

**Client**
- `routines.ts` uses the server's `WaitingOn` type, and the name card reads "Waiting on Bea — at the coffee bar". The `main.ts` cast is gone.
- In the queue panel, a blocked row reads "Waiting on “<title>”" with a dashed amber border. A held row reads "Held — dependency “<title>” did not finish. Retry or remove it." and has ↻ Retry and ✕.

**Fixture:** `FIXTURE_SCENARIO=waiting` (`tools/ui-fixture.ts`) seats Cyrus (finished item 1, waiting) and Bea (working on item 2). Item 3 is blocked, and one held task is included. `waitingOn` comes from the real projection. `tools/life04-ui-check.ts` is the slice's UI check.

## Checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` | 578/578 after the review fixes (baseline 561 + 17 in `tests/life-04.test.ts`) |
| New tests on the base source | fail: the modules are missing (failing before) |
| `npm run build` | pass |
| `mobile-ui-check` (fixture :4741) | 411/411 |
| `life04-ui-check` (fixture :4742, waiting) | 16/16: amenity and name card, Bea typing, queue blocked and held rows, no console errors, reduced motion with no walk phase |

Screenshots are in `docs/team/reports/life-04/`: `waiting-amenity-{1440x900,874x402}.png` and `queue-blocked-{1440x900,874x402}.png`. Regenerated screenshots outside that folder were reverted.

## Not verified / open issues
- These are fixture-only UI checks. The server wiring of `waitingOn` (`server.ts` broadcast diffing) has no end-to-end test with a real server and real workers. Only the pure projection and the queue are unit-tested.
- The real `WorkerManager.spawn` path (name and colour reused only when the branch exists) is covered only through the queue fake and a real-git `Worktrees` test. There is no `WorkerManager` test for it.

## Review fixes (independent review: ACCEPT WITH FIXES)

Commits `84ec8be` (fixes 1–4) and `53e4f54` (fix 5 and all tests). Against the pre-fix code, 8 of the new tests fail (one ran for 83 s, which is the reported freeze). All of them pass now.

1. **Critical: send-home retry loop.** `sendHome` no longer pumps when it fails. Both an `{error}` result and a rejection or throw from `kill` back that worker off for 60 s (`SEND_HOME_BACKOFF_MS`), with one toast per failure. The pump timer retries. `QueueWorkers.workerBusy` (publishing, opening a PR or stopping) excludes the worker from every send-home. Test: errors that come back without awaiting, rejections and throws each produce one kill and one toast across 20 pumps, and B then seats at another free desk.
2. **Continuity follows the spec.** A free dependency desk is taken first, then any free funded desk at once. Only when no desk is free is the dependency's worker sent home, and only if it is `done`, with no viewers, not busy and recyclable. Offline (resumable) workers never are. Tests cover the free-desk, offline, viewers and busy cases.
3. **Identity is honest.** If the queue uses worktrees and a finished dependency's branch still exists, the successor's worktree starts from that branch (`Worktrees.create(slug, baseRef)`, branch names validated). It also records `worktree.continues {branch, title}`, and only then is the predecessor's name and colour reused. Otherwise the worktree starts from HEAD under a fresh name. Either way the prompt gets one factual line: the title, branch and PR URL, plus a "branch no longer available" note when it falls back to HEAD. The worker card reads "continues “<title>” · …" (`workerTaskLine`). Tests cover both paths and a real temporary git repo (branch-tip start, unsafe names rejected).
4. **Reservations are re-checked.** A kept reservation is dropped when its desk is no longer funded. Reservations whose send-home has finished are released when the worker limit or a hiring pause stops seating. Tests cover both block causes and the unfunded desk.
5. **Consultancy items no longer get stuck.** An item whose queue task was seen finishing `done` is remembered (`finishedOk` in the journal). Once cleared from the queue it counts as satisfied and shows as `awaiting_review`. A prerequisite that vanished without ever being seen to finish makes the next item `needs_attention` with a clear reason, and nothing is dispatched. Tested.

Re-run after the fixes:
- typecheck: 0 errors
- `npm test`: 578/578
- build: exit 0
- `mobile-ui-check`: 411/411
- `life04-ui-check`: 16/16

The life-04 screenshots were refreshed and regenerated screenshots in other folders were reverted.
- `parallel: true` semantics (runs beside the previous item and joins at the next ordered item) are my reading of "opt out". They need the coordinator's confirmation.
- There is no UI for adding a dependency to a free-text task. Only consultancy items and API callers set `dependsOn`.
- The in-world queue whiteboard doesn't distinguish blocked tasks.
- The 375px portrait width wasn't captured for this slice. `mobile-ui-check` covers the general layouts.
- Cloud mode is out of scope.
