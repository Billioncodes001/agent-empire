# Grok review assignment

Work only in the `codex/team-review` worktree. Read WORKFLOW.md first.

Your first deliverable is `docs/team/reports/review.md`: independently review the current baseline against the user's intended product and find concrete correctness gaps. Prioritize supervision status, restart recovery, real-versus-simulated work, persistence, revenue rules, and integration risks. Findings require severity, exact file/line evidence, trigger, impact, and a practical acceptance test. Separate confirmed bugs from missing planned features; do not invent findings.

Inspect relevant source and tests. You may run `npm run typecheck` and `npm test` if dependencies are available. Do not edit product code, start project workers, change credentials, or contact external services. Include checks actually executed. Commit only your report. Do not push or merge. Later review rounds will identify the exact candidate commit to review after the authors finish.
