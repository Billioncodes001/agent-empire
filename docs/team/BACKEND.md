# Codex backend assignment

Work only in the `codex/team-backend` worktree. Read WORKFLOW.md first.

Your first deliverable is `docs/team/reports/backend.md`. Audit worker/manager lifecycle, queue restart behavior, persistence and current status contracts. Define the first bounded implementation round for truthful supervision and restart visibility, then outline the cloud execution and safe desktop synchronization milestones with acceptance tests. Distinguish actual provider jobs from simulated staffing/revenue and preserve all permission gates.

Inspect `src/server/empire.ts`, `workers.ts`, `queue.ts`, `server.ts`, `src/shared/empire.ts`, related tests and docs/ARCHITECTURE.md. Explain what the interface can derive today versus fields requiring backend changes. Do not provision anything, read credentials, launch project workers, or change product code in this setup pass. Commit only the report. Do not push or merge.
