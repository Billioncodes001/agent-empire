> **Historical (2026-10-23).** This is the handoff from the first team-setup round, kept for the record. The current workflow is in [COORDINATION.md](COORDINATION.md) and the current state in [TASKS.md](TASKS.md).

# Coordinator handoff after team setup

The first round produced role reports, not product changes. Claude and Grok ran through VS Code Copilot; Codex ran as the backend collaborator from the coordinating Codex chat. All use separate Git worktrees. A model appearing in a picker is not the verification: the authored reports and scoped commits are the handoffs.

## Agreed first implementation boundary

Backend owns restart recovery and truthful execution evidence. Interface owns consistent HUD/Management status, connection freshness, dialog accessibility and responsive presentation. Review owns independent findings and verification of the integrated result. Neither author changes a shared wire contract independently.

1. Backend first makes reconnect read-only: reconnecting a client must not spawn or resume a worker. Restored interrupted jobs remain visibly interrupted until an explicit recovery action. Retrying must not overlap a still-running or unknown prior attempt. Preserve permission prompts, funded-desk limits and budget gates.
2. Agree the smallest supervision projection with interface before editing shared types. Distinguish delegation preference, rule-based monitoring, startup-job phase, observed process state, attention requests and evidence freshness. Server run identity is not a durable cloud lease.
3. Interface then uses that projection consistently in the HUD, Management and briefings. Disconnection or stale evidence must remove live claims. Until a continuously reasoning supervisor actually exists, use explicit rule-based-monitoring wording.
4. Grok reviews the exact combined product commit. Pass typecheck, relevant regression tests, production build and browser scenarios before integration.

## Corrections and decisions applied to the initial proposals

- A worker turn ending does not prove the requested artifact exists, passed checks, or was accepted. `ready` must not be relabeled "verified brief complete" without additional evidence. A PTY can remain alive after a turn ends; do not claim "no process" from manager status alone.
- `needs_input` is blocked work requiring user attention, not active reasoning. An absent/idle linked worker needs an explicit conservative state, not a fallthrough into an active label. Count only agent workers in AI workforce chips.
- Delegation records intent and changes presentation; the existing flag does not establish an autonomous supervisor. Leaving HQ may retain that intent behavior, but its wording must be truthful.
- Keep the accepted entry rule: owned and built business plus an assigned worker/manager; HQ and home stay accessible. A durable appointment can remain assigned between jobs. Do not silently change the economy or entry policy while fixing status labels.
- UI fixtures must be isolated from port 4610 and the live `.agent-office` save. Provide fixture data through a dedicated test harness/server. Do not alter the live browser's runtime store to manufacture a passing result. No real provider jobs are needed for these regression tests.
- Existing role reports are proposals and audit findings, not an authorization to deploy, purchase compute, accept new service agreements or bypass approvals. A tested cloud implementation and concrete provider choice are later milestones.

## Worktree locations

Sibling folder `../agent-empire-team/` contains `interface/`, `backend/`, `review/`, and `integration/`. `Agent Empire Team.code-workspace` is a human overview of the integration checkout and three role worktrees. Start agent editing sessions in their single-role folder, not the multi-root overview.

Before the next round, update clean role branches to the accepted integration baseline with a normal merge; do not reset or discard role work. Keep each original role session available for follow-up. The coordination workflow needs an active coordinator; it is not an unattended scheduler or the game's future cloud worker runtime.
