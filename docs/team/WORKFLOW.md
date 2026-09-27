# Agent Empire team workflow

## Roles and isolation

The integration branch is `codex/empire-world`. The initial audited source is `8b13f52`.

| Role | Agent | Branch | Ownership |
| --- | --- | --- | --- |
| Interface | Claude Opus 5.5 through VS Code Copilot | `codex/team-interface` | Client UI, visual hierarchy, accessibility and interaction presentation |
| Backend | Codex | `codex/team-backend` | Server execution, persistence, reporting, cloud/synchronization architecture and backend tests |
| Review | Grok 4.7 through VS Code Copilot | `codex/team-review` | Independent findings and regression review; no product changes |

Each role has its own sibling worktree. Never edit another role's checkout, change its branch, or touch the live `.agent-office` directory. The existing Pixel worker and the preview on port 4610 are outside this team’s tasks.

## First assignment: establish a shared implementation plan

Read README.md, docs/ARCHITECTURE.md, docs/RESEARCH.md and the relevant source. Produce only your role's report under `docs/team/reports/`. This first session is deliberately a planning and verification pass; implementation follows the agreed interfaces. Do not launch paid project workers, provision cloud resources, change credentials, install extensions, push, merge, or deploy.

Reports must distinguish implemented behavior from plans. Include source references, known limitations, the first concrete implementation slice, acceptance checks, and dependencies on another role. Commit only your report on your own branch. If unable to commit, leave the report saved and describe the blocker.

## Integration protocol

1. Start every new round from the latest tested integration commit. One writer per worktree.
2. Agree changes to `src/shared/` and dependencies before editing them. Interface and backend agents must not independently change the same protocol.
3. Each author runs relevant checks, reviews its diff, and makes a scoped commit. Include commands/results and any unverified behavior in the handoff.
4. The coordinator creates a candidate integration branch/worktree and merges the author commits there. Grok reviews the exact candidate commit and reports findings by severity with file/line evidence.
5. Fix material findings and run `npm run typecheck`, `npm test`, and `npm run build` on the candidate. UI changes also require a browser check.
6. Only then merge the candidate into `codex/empire-world`. Keep `main` and the existing draft PR lifecycle separate. Never use automatic blind merges, force-push, or reset another agent's work.

## Audit baseline

The app is a local 3D prototype, not an always-on cloud platform. There is no provider OAuth onboarding, hosted worker runtime, safe automatic laptop synchronization, or desktop/mobile package. Chief-of-staff startup work is bounded; ongoing monitoring is rule-based. Service-worker wages and city revenue are fictional credits.

At the audit the HUD said "Chief of staff on duty" while the chief assignment was offline; Pixel required trust/login input. Do not treat a delegated flag or an animated person as evidence of a running AI job. All 48 automated tests and TypeScript checks passed at the baseline.
