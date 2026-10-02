# LIFE-04: Dependencies and recreation while waiting

Branch `claude/life-04-waiting`, based on `codex/empire-world` at `fa5c6e0`. This is a candidate for independent review. It is not merged and not pushed.

## What shipped

**Server**
- `QueueTask.dependsOn`, `blockedBy` and `deskId`, plus `WorkerInfo.waitingOn {id, name, taskId}` in `src/shared/protocol.ts`. The pure dependency rules are in `src/shared/dependencies.ts`.
- `TaskQueue.add(..., dependsOn)` rejects unknown ids, lists of more than 8, self-dependencies and cycles, and drops duplicates.
- `seat()` skips a blocked task. That task never takes a desk or a worker slot, and later independent tasks still run.
- If a dependency ends without `outcome: 'done'`, or goes missing, the dependent task is held: `failed`, with `error: 'dependency <id> did not finish'`. The hold carries down the chain and the held task never runs on its own.
- Retry refuses while a dependency is still failed, and drops dependencies the CEO has removed. Remove refuses on a task that a queued task waits on. `clear()` keeps finished dependencies that queued tasks still need.
- Continuity: a task that unblocks prefers the desk of the worker that finished its dependency. If that finished worker is still at its desk, unwatched and recyclable, it is sent home and the desk is held for the task. The new worker gets the same roster name and colour (a new optional `persona` argument on `WorkerManager.spawn`). If the desk is being watched, or the send-home fails, the task goes to any free desk and is never held back.
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
| `npm test` | 572/572 (baseline 561 + 11 new in `tests/life-04.test.ts`) |
| New tests on the base source | fail: the modules are missing (failing before) |
| `npm run build` | pass |
| `mobile-ui-check` (fixture :4741) | 411/411 |
| `life04-ui-check` (fixture :4742, waiting) | 16/16: amenity and name card, Bea typing, queue blocked and held rows, no console errors, reduced motion with no walk phase |

Screenshots are in `docs/team/reports/life-04/`: `waiting-amenity-{1440x900,874x402}.png` and `queue-blocked-{1440x900,874x402}.png`. Regenerated screenshots outside that folder were reverted.

## Not verified / open issues
- These are fixture-only UI checks. The server wiring of `waitingOn` (`server.ts` broadcast diffing) has no end-to-end test with a real server and real workers. Only the pure projection and the queue are unit-tested.
- The continuity send-home of the dependency's worker adds a short wait (until its process stops, at most about 5 s) before the dependent starts, even when other desks are free.
- The persona name is reused only when it's a roster name nobody else holds. Otherwise the next free name is used.
- `parallel: true` semantics (runs beside the previous item and joins at the next ordered item) are my reading of "opt out". They need the coordinator's confirmation.
- There is no UI for adding a dependency to a free-text task. Only consultancy items and API callers set `dependsOn`.
- The in-world queue whiteboard doesn't distinguish blocked tasks.
- The 375px portrait width wasn't captured for this slice. `mobile-ui-check` covers the general layouts.
- Cloud mode is out of scope.
