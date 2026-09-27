# Claude interface assignment

Work only in the `codex/team-interface` worktree. Read WORKFLOW.md first.

Your first deliverable is `docs/team/reports/interface.md`. Audit the current UI and propose a focused first implementation round. Priorities: truthful chief/worker state in the HUD; clear management reports without obstructing the world; a coherent restrained visual hierarchy; keyboard and small-screen usability. Preserve first/third-person views, arrow defaults and remapping, physical door traversal, minimap/waypoints, and graphics presets. Do not reintroduce teleport/location selectors or fake live data.

Inspect `src/client/ui/empire.ts`, `hud.ts`, `settings.ts`, the styles, `main.ts`, and shared state types. Document exact files to change, status mapping from existing fields, and browser acceptance scenarios. Identify any backend fields needed before implementation. Do not alter product code in this setup pass. Commit only the report. Do not push or merge.
