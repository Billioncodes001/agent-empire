# CONSULT-01 backend handoff

This covers the domain slice only: `src/shared/consultancy.ts`, `src/server/consultancy.ts` and `tests/consultancy.test.ts`. Baseline was `6ebb68a`. The coordinator did not integrate or push anything and made no live calls.

## Timeline and evidence

| Step | Agent / model requested | Result |
| --- | --- | --- |
| 1. Author | Empire Backend, `gpt-5.3-codex`, worktree `agent-empire-team/backend` | **Commit `7af1506`** changed only the three owned files (+854 lines). The coordinator re-ran `npm run typecheck` (pass) and `npx tsx --test tests/consultancy.test.ts` (12/12 pass). |
| 2. Review of `7af1506` | Empire Review, `grok-4.7`, read-only | **Needs repair.** The API matched; findings are listed below. It inspected only and ran no tests. It reviewed commit objects from the main checkout, while the backend checkout was at `7af1506`. |
| 3. Repair pass | Empire Backend, `gpt-5.3-codex` | **Cancelled; no output.** Root declined the superseded write requests in the normal approval UI before any edit was applied. The coordinator then sent a queued stop (the harness has no subagent cancel). It confirmed a clean tree at `7af1506` and made no commit. |
| 4. Root repair | Root / parent session (not a coordinator dispatch) | Integration candidate **`6517da6`** in `agent-empire-team/integration`, parent `7af1506`, with the founder desk, Telegram and domain fixes. Root reports 196 tests plus a domain regression passing, founder desk manual checks at 375 px, and a separate approving review of `6517da6`. The coordinator did not re-run these. |
| 5. Recheck of `6517da6` | Empire Review, `grok-4.7`, read-only via `git show` only | The three findings are resolved; one new Medium finding; verdict **needs repair**. It inspected only and ran nothing. |

The routing labels come from the harness; this coordinator did not ask any model to identify itself. At the start of the recheck, the integration working tree also had an uncommitted change to `tests/consultancy-server.test.ts`; it was outside the exact6517da6 review. It was subsequently committed and tested by root.

## Findings on `7af1506`, rechecked in `6517da6`

1. **High: false queue health.** Consultancy read queue storage-error fields that don't exist, so it could adopt the ghost row that `TaskQueue.add` leaves after a failed persist. **Resolved.**
   - `server.ts:297` passes `queue.recoveryError` as `state().storageError`, and consultancy reads it at 507-511.
   - While it is set, `reconcile` does not bind rows, `add` errors are not stored as ids, and items show `needs_attention`.
2. **High: `onChange` throwing rolled back state that had already been persisted.** **Resolved.**
   - `notifyChange` (304-306) swallows observer errors after persistence.
   - Rollback happens only when `persist` throws.
3. **Medium: `findTask` fell back to `jobKey` when a recorded `queueTaskId` was missing.** **Resolved.** A recorded id is required (451-454); a missing or replacement id means `needs_attention` and is never requeued.
- **Restore and hash validation** (read, not run):
  - A corrupt or mismatched journal sets `recoveryError`, is never rewritten, and blocks writes and dispatch.
  - Journals written by `7af1506` are accepted.
  - The sha256 fingerprint rewrite stays in memory until the next successful persist.
- **Public API:** unchanged. `storageError` on the state port is an optional addition.

## Finding at 6517da6 (subsequently resolved)

- **Medium, `server.ts:306-312`:** the status and chief summary count raw queued rows even when `queue.recoveryError` is set. After a storage failure, a ghost row can therefore still be reported as queued.
  - Fix: while that error is set, leave those rows out of the count and report the error as the blocker.
  - Owner: root/integration, since it is outside the Backend-owned paths.
- **Queue ownership:** `queue.ts:104-105` still leaves the ghost row in memory. The consultancy side is protected against it, but the queue itself is unchanged.

## Status

- **Implemented:** author commit `7af1506`, plus root's repairs in `6517da6`.
- **Tested:**
  - by the coordinator: typecheck and 12 focused tests on `7af1506`
  - by root (claims not re-run here): 196 tests, one regression and browser checks on `6517da6`
- **Reviewed:** Grok accepts the three domain repairs, but its verdict on `6517da6` is needs repair, because of the status-count Medium.
- **Not done:** integration into main and pushing are left to root.
- **Later candidate, not reviewed here:** while this recheck was running, the integration branch moved past `6517da6`. It now has `4f31c6f`, then `2726d53`, then `033e5f8` ("Report queue capacity as unavailable after persistence failure"). The last one may address the remaining Medium. Only an exact-commit review of `033e5f8` can confirm that; this report makes no claim about it.

## Parent final resolution

After this native handoff, root completed `033e5f8`. A separate independent reviewer accepted exact `033e5f81fb251c930db6cce7f9466c85725e638a` and reran the four affected server tests successfully. The status count is now unknown (`null`) during queue storage failure, and both API and chief summary expose the blocker. Main was fast-forwarded after that acceptance. See [consultancy-integration.md](consultancy-integration.md) for complete validation and limits. The “needs repair” verdict above is the historical verdict on6517da6, not an unresolved finding in the final code.
