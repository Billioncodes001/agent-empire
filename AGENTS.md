# Agent Empire project instructions

## User's design standard

Apply the user's standing Web Design Standard to all UI work. On this development machine, read `~/.claude/PAI/USER/WEB_DESIGN_STANDARD.md`; that master takes precedence over its mirrors. The project interpretation is in `docs/team/DESIGN_STANDARD.md`. The user's direct task instructions remain authoritative.

Research leading examples and motionsites.ai before visual implementation. Adapt ideas with original/licensed assets; do not copy site code or assets. Aim for realistic, coherent 3D environments and distinctive interface art direction, with purposeful motion, accessible controls and measured performance. The user permits installing needed design libraries and spending Higgsfield credits on custom visual assets; do not reinterpret that as permission to start unrelated paid worker tasks or deploy services.

## Current coordination

Read `docs/team/COORDINATION.md`, the relevant plan under `docs/team/` and the assigned row of `docs/team/TASKS.md`. Record requirements before coding. The workflow in use: a coordinator session assigns bounded slices; each author works in its own git worktree on a `claude/<slice>` branch from the current `codex/empire-world`; a separate reviewer checks the exact candidate; the coordinator merges the accepted candidate into a `claude/<slice>-integration` branch, re-runs the checks and opens a PR into `codex/empire-world`; promotion to `main` is a separate PR. Verify your worktree, branch and owned paths before editing; role labels do not prove model identity or isolation.

Independent authors need separate worktrees; shared contracts have one designated owner. Preserve other agents' changes. Only integrate a scoped, tested result after independent review of the candidate. Authors do not push unless asked. Never force-push, and never reset or rewrite shared branches or other agents' work; resetting your own isolated worktree to a reviewed commit is fine.

## Product invariants

The city visualizes real agent work. Distinguish animation, rule-based monitoring, observed worker activity and verified outcomes. Keep fictional city credits separate from provider spending. Preserve funded workstation capacity, durable assignments for business entry, arrow-key remapping, both camera views, physical traversal and safe task retry/synchronization behavior.

The existing localhost:4610 session, Pixel worker, `.agent-office` save and live build are protected during development. Use isolated fixtures and a designated preview. No fabricated completion/status, paid product-worker calls for tests, automatic model downloads or cloud infrastructure changes.

For UI acceptance, verify desktop and 375px phone width, save screenshots, check console errors, keyboard/focus behavior, reduced-motion and Save-Data. Report platform build evidence separately from actual device execution. Planning/documentation work does not establish visual acceptance of unbuilt features.
