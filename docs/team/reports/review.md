# Review: baseline findings and setup-candidate conclusion

Author: Review role (Grok 4.7, VS Code Copilot). Branch `codex/team-review`. Product baseline `a444e5f` (audited source `8b13f52`). No product code was edited. The live `.agent-office` directory and port 4610 were not used.

## Checks actually run

On `a444e5f` in this worktree:

- `npm run typecheck` passed.
- `npm test` passed: 48 tests, 0 failures.

Not run: `npm run build`, `npm run test:browser`, any server, worker, or provider call. The passing suite does not construct `WorkerManager` together with `TaskQueue` restore, so it does not cover the restart split below. Candidate `f0fd860` was inspected with `git show` and `git diff` only. This branch was not switched.

## Confirmed bugs

### 1. High — restart resumes real work and then records it as failed

Trigger: the office process restarts, or a browser connects, while a queue task is `running`.

- `WorkerManager` calls `wakeAll()` at construction, and `resume()` relaunches the saved session. See [src/server/workers.ts](src/server/workers.ts#L131-L133) and [src/server/workers.ts](src/server/workers.ts#L204-L220).
- That manager is constructed before the queue. See [src/server/server.ts](src/server/server.ts#L170-L219).
- Every authenticated connection calls `workers.wakeAll()` again. See [src/server/server.ts](src/server/server.ts#L495).
- Queue restore then marks every saved `running` task `done` / `exited` with "The office restarted while it was running", and does not persist that change. The comment says the worker comes back asleep. See [src/server/queue.ts](src/server/queue.ts#L305-L308) and [src/server/queue.ts](src/server/queue.ts#L338-L343).
- The next empire tick treats any non-`done` outcome as manager `offline`. Completion credit requires `outcome === 'done'`. See [src/server/empire.ts](src/server/empire.ts#L332-L353) and [src/server/empire.ts](src/server/empire.ts#L363-L373).
- Welcome can therefore show a starting worker, an exited queue task, and a still-`working` saved manager until the 5-second tick. See [src/server/server.ts](src/server/server.ts#L473-L503) and [src/server/server.ts](src/server/server.ts#L783-L784).

Impact: a resumed agent can keep spending and committing while Management says the startup failed. Retry is then allowed and allocates a new job key, so a second attempt can overlap the first. A later successful turn is not credited, because the queue outcome is already `exited`.

Acceptance: with a local stub agent, not a paid provider, start one queued task, restart the server, and connect once. Pass only if that process is not resumed, the task is visibly interrupted, manager status is not `working` or `ready` before reconciliation, and retry is refused until the prior process is confirmed stopped. A second explicit retry must not create a second live attempt.

### 2. High — "on duty" is a preference flag, not an appointment

Trigger: load the client, finish founding, or walk out of headquarters. `delegated` defaults to true and founding sets it true. See [src/shared/empire.ts](src/shared/empire.ts#L216) and [src/server/empire.ts](src/server/empire.ts#L154).

- The radar appends "Chief of staff on duty" whenever `delegated` is true. See [src/client/ui/empire.ts](src/client/ui/empire.ts#L642).
- Management always says "administrative monitoring active", including when the chief appointment is pending or offline. See [src/client/ui/empire.ts](src/client/ui/empire.ts#L296-L300).
- Leaving headquarters sends `delegate: true` without checking the appointment. See [src/client/main.ts](src/client/main.ts#L205-L207).
- The office avatar only moves between two positions for that flag. See [src/client/world/city.ts](src/client/world/city.ts#L537).

Impact: the HUD claims a chief is on duty when no chief exists, or when the startup job is queued, blocked, or offline. Delegation does not start a supervisor. Rule-based reports may continue; that is not the same claim.

Acceptance: with `delegated: true` and chief status `pending`, `queued`, `needs_input`, or `offline`, the visible HUD and Management text must not say "on duty" or that a supervisor is active. A disconnected client must drop the live claim.

### 3. Medium — blocked and finished appointments are presented as active work

- A non-ready available manager, including `needs_input`, is labeled "on duty" at the door. See [src/client/navigation.ts](src/client/navigation.ts#L14) and [src/shared/empire.ts](src/shared/empire.ts#L243-L244).
- `ready` managers are shown with a typing pose even when no worker process is linked. See [src/client/world/city.ts](src/client/world/city.ts#L511-L524).

Impact: a trust or permission prompt looks like duty, and a finished appointment looks like someone typing. Entry and fictional revenue may still follow the current `managerAvailable` rule; this finding is the label and pose, not a request to change that rule.

Acceptance: `needs_input` is labeled as blocked and names the terminal. `ready` does not use a working pose or say a brief was verified. Door text matches that distinction.

## Not bugs

- Permission prompts are not auto-approved. A trust or login prompt is expected `needs_input`, not proof the chief is supervising.
- No ledger-identity bug was confirmed. Operating credits stay fictional; provider cost is separate. Downtime does not earn catch-up revenue.
- Queue job keys do prevent a second dispatch of the same pending startup key. That does not fix finding 1, because retry issues a new key while the resumed process can still be alive.

## Missing planned features

Not defects in the current local prototype: no continuously reasoning supervisor, audit log, or CEO/manager authorization; no cloud lease, hosted runner, or safe laptop sync; no artifact hash check that would make `ready` mean "brief verified". Server-run identity is not a durable lease.

## First slice, bound by the coordinator

Backend owns restart recovery and execution evidence. Interface owns HUD, Management, and accessibility. Neither edits `src/shared/` until the supervision projection is agreed. Do not change entry or economy rules while fixing labels. Review the exact combined product commit.

## Candidate `f0fd860`

Reviewed in place on `codex/team-setup-integration`. `git diff --name-status a444e5f..f0fd860` adds only:

- `docs/team/NEXT_ROUND.md`
- `docs/team/reports/backend.md`
- `docs/team/reports/interface.md`

Commit `f0fd860` itself adds `NEXT_ROUND.md`. The role reports arrive through its merge parents. No product code, workflow reset, or live-save change.

Conclusion: accept this documentation candidate as the setup handoff. `docs/team/NEXT_ROUND.md` is the binding decision and supersedes conflicting proposals in the two role reports. The next product round must follow it, not either report's slice alone.

Residual conflicts, already decided by that file:

- Interface section 2 is not sufficient. A client join of today's fields can still call a resumed worker active while the queue task is `exited`. Backend recovery and one agreed projection come first.
- Do not ship interface acceptance B4, "startup brief complete", or section 2's permission to say "on duty" for `needs_input`. `ready` means turn ended, not a verified artifact. `needs_input` is blocked attention.
- AI workforce chips count agent workers only. Shell workers do not.
- Browser proof uses an isolated fixture server. Do not inject the live store, and do not default the smoke test at port 4610 or the live `.agent-office` save.
- Backend's `SupervisionState` table is a proposal, not a frozen wire contract. Agree the smallest shared projection before either role edits `src/shared/`.

No product defect is introduced by `f0fd860`, because it does not change executable source. Findings 1–3 remain open on `a444e5f`.
