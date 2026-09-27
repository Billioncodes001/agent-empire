# Round 1 review

Reviewed candidate: `0d20434de297ab0716411be124b58047e8555309` on `codex/team-review`.

Delta from `20310463f307a646720a70d4992c935ce8ebd3bb`: backend recovery fix `7f708b0`, interface `28be374` and `7f45fe6`, narrow-screen control names `838fd90`, recovery guide, cached workforce presentation `d359c29`, and reconnect receipt reset `0d20434`.

Not in this checkout, not reviewed as code: integration copy commit `8c93105`. Coordinator describes it as wording only: Management and Founding say a queued task earns 500 simulation credits once when an agent turn ends. No logic change claimed.

## Result

The prior manager-retry / old-task requeue finding is closed on this candidate. One low presentation residual remains. No other confirmed material finding in this delta.

## Closed

Manager retry no longer mints a new job key while the interrupted task stays independently retryable. If the current task still exists, Management calls `queue.retry` on that id. Sibling attempts in the same `empire-manager-{site}` family block the other control and block seating. A superseded legacy key cannot be requeued or auto-seated. A second completed turn of the same task id does not pay again.

Evidence: [src/server/empire.ts](src/server/empire.ts#L241), [src/server/queue.ts](src/server/queue.ts#L138), [src/server/queue.ts](src/server/queue.ts#L199). Covered by the both-order, legacy-sibling, and once-only reward tests below.

Unknown or running prior attempts stay blocked. HUD and Management use the supervision projection. Missing, disconnected, and stale evidence, including a reconnect before the new snapshot, do not show a live chief or live workforce counts. Cached worker pills and desk bubbles are labeled last-known or unknown. Typing pose requires a fresh running agent turn. Delegation is labeled as a preference. Turn-ended copy does not say the brief was verified.

## Confirmed finding

Low — the unlabeled headquarters figure still changes post when delegation is requested.

Trigger: leave headquarters. Traversal sends `delegate` enabled, and the city update moves that figure from `(8, 0, 9)` to `(5, 0, 9)` even if the chief phase is interrupted, offline, or the client evidence is stale.

Source: [src/client/main.ts](src/client/main.ts#L209), [src/client/world/city.ts](src/client/world/city.ts#L380), [src/client/world/city.ts](src/client/world/city.ts#L540).

Observable impact: the figure’s name is hidden and it does not type. HUD and Management do not follow the move, and it does not launch work or pay a reward. A viewer can still see a person take the other post solely because delegation was requested. Round 1 says an avatar must not infer an active supervisor from that preference. Fix is to stop keying that position on `delegated`.

## Checks

- `git rev-parse HEAD` was `0d20434de297ab0716411be124b58047e8555309`; worktree clean before this report.
- Read the recovery, status, HUD, Management, pose, and reconnect diffs. Did not rerun the baseline audit.
- `npx tsx --test tests/backend-runtime.test.ts tests/status.test.ts tests/economy.test.ts`: 47 passed, 0 failed. Includes both recovery orders, legacy sibling block, once-only reward, stale/disconnect chief labels, and reconnect not reviving old evidence.

## Limitations

Did not rerun the full 86-test suite, typecheck, build, browser-smoke, or a live provider. Did not touch `.agent-office` or port 4610. Coordinator reports those checks passed, plus isolated-fixture checks for phase labels, stale dialogs, focus trap, terminal Tab, settings persistence, waypoint movement, and 390/768 layouts. Those browser results were not repeated here. `8c93105` was not in the tree.
