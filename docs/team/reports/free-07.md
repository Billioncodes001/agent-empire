# FREE-07: organization features in cloud mode

Branch `claude/free-07-cloud-org`, from `origin/codex/empire-world` at `60d7ace` (PR #39, FREE-04, merged). Author: Claude (Engineer lane). Not pushed; it needs an independent review.

## Requirements (recorded before coding)

From the assignment, [FREE_PLAN.md](../FREE_PLAN.md) (rules 1–6 and the FREE-07 row), [CLOUD_MODE_PLAN.md](../CLOUD_MODE_PLAN.md), [free-04.md](free-04.md), [APPROVALS.md](../../APPROVALS.md), [CHIEF.md](../../CHIEF.md), [MEMORY.md](../../MEMORY.md), [OUTREACH.md](../../OUTREACH.md), [RESEARCH_EXECUTIVE.md](../../RESEARCH_EXECUTIVE.md), [CONSULTANCY.md](../../CONSULTANCY.md) and AGENTS.md:

1. In cloud mode (no office host; state in the user's GitHub state repository; the coordinator in `src/cloud/` on Actions) the approval inbox, the executives and chief of staff, research, outreach and organizational memory either **work through the state repository and the coordinator**, or **say in the UI, specifically, which part can't and why**. No broken button and no silent no-op.
2. Start from an honest **capability matrix** (local server vs cloud), with a reason for every gap.
3. Rules and validation that both sides apply live in `src/shared/` and are **used by the server and the coordinator** (as FREE-09 did with `economy-rules.ts`).
4. **Money safety and approvals.**
   - Decisions are idempotent: deciding an already decided item changes nothing.
   - A cloud intent can't approve anything the CEO hasn't seen: a decision names the exact content it was shown, and the coordinator refuses a mismatch.
   - Paid work in cloud keeps the existing `confirmPaid` + current `configRevision` rule and every coordinator limit.
   - Model output stays a proposal (no model runs in cloud in this slice).
   - Lessons keep the FREE-10 guard: a decision applies only to the exact proposal (id, text, scope and nonce) it was raised for.
   - The cloud intent allow-lists stay strict: every new kind lists its exact fields; unknown fields are refused.
5. **Claude compliance** (FREE_STACK §9): never collect or relay Claude tokens; cloud uses only secret *names*. This slice adds no secret at all.
6. **Tests:** no real GitHub or network; fake APIs as in the existing cloud tests. Failing-before tests for cloud inbox decisions, idempotency, intent validation and the matrix-driven UI messages.
7. **UI:** extend the cloud UI checks with `tools/cloud-org-ui-check.ts`: isolated fixture, refuses port 4610, screenshots at 1440x900 and 874x402 in `docs/team/reports/free-07/`.
8. **Hard limits:** never 4610, Pixel or `.agent-office`; own ports 5000–5015 only; no paid call, no dispatch, no GitHub settings or secrets, no force-push; no broad refactor of `server.ts` or settings UI (FREE-08 and CITY-06/08 run in parallel).
