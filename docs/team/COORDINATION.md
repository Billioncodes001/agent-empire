# Development coordination

This is the workflow actually used since the cloud-mode rounds (PRs #5 onward). It replaced the earlier VS Code Agents window with fixed lanes (`../agent-empire-team/{interface,backend,review,integration}` on `codex/team-*` branches). Those checkouts are historical and are no longer the integration path. The first planning trial is recorded in [reports/city-expansion-coordination.md](reports/city-expansion-coordination.md).

## Roles

| Role | Where | Owns |
| --- | --- | --- |
| Coordinator | A dedicated session on the main checkout | Plans, assignments, the [task ledger](TASKS.md), integration branches and PRs |
| Author | Its own git worktree on a `claude/<slice>` branch, created from the current `origin/codex/empire-world` | Only the paths named in its assignment, its tests and its report in `reports/` |
| Reviewer | A separate session that reads the exact candidate commit | A review verdict (ACCEPT, ACCEPT WITH FIXES, or REJECT) with findings; it does not edit the candidate |

Every assignment carries an ID, a baseline commit, the goal, the owned paths, the acceptance checks and the maximum scope. A completion report carries:

- the commit SHA;
- the checks that were run, with their counts;
- screenshots where there is UI;
- unresolved risks;
- anything deliberately left undone.

## Flow

1. **Requirements first.** The coordinator records the requirements in a plan under `docs/team/` (for example [ORG_PLAN.md](ORG_PLAN.md) or [CLOUD_MODE_PLAN.md](CLOUD_MODE_PLAN.md)) and adds a row to [TASKS.md](TASKS.md).
2. **Author.** The author works in an isolated worktree, commits on `claude/<slice>`, writes `reports/<slice>.md` and does not push unless asked.
3. **Independent review** of the exact candidate. Fixes go back to the author, and changed commits are re-reviewed.
4. **Integration.** The coordinator merges the accepted candidate into `claude/<slice>-integration` with a normal merge. The coordinator re-runs typecheck, `npm test`, the builds and the affected UI checks there, then opens a PR into `codex/empire-world`.
5. **Merge.** The PR is merged into `codex/empire-world`, the development branch. TASKS.md then names the PR.
6. **Promotion.** `codex/empire-world` reaches `main` only through a separate promotion PR.

Never force-push, reset a shared branch, or auto-merge without review. One writer per path; shared contracts (for example `src/shared/protocol.ts` or the native bridge) have one designated owner per round.

## Safety rules (unchanged)

- The live localhost:4610 session, the Pixel worker, its `.agent-office` save and the live build are protected. Use isolated fixtures on other ports (see [UI_FIXTURE.md](UI_FIXTURE.md)) and disposable data directories.
- Never fabricate completion or status. Make no paid product-worker or provider calls for tests, no automatic model downloads, and no cloud infrastructure changes without owner approval.
- For UI acceptance, check desktop and phone widths (375 px and 874×402 landscape) and save screenshots. Also check console errors, keyboard and focus behaviour, reduced motion and Save-Data. Report platform build evidence separately from device execution.
- Revert unrelated regenerated screenshots before committing.
- Keep normal tool approvals. No timer polling or nested agent chains. Only set up a recurring automation if the owner asks for one.
