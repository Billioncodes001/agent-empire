# FREE-02: the thinking chief (CONSULT-04)

Branch `claude/free-02-chief`, from `8512264`. Author: Claude Opus 5.5 (FREE-02 author). Status: **candidate**. It needs an independent review before integration (a security review is suggested: prompt injection and paid calls). Nothing is pushed. User guide: [docs/CHIEF.md](../../CHIEF.md).

## What changed

- **`src/server/chief.ts`** (new): `ChiefBrain`, built on the shared `llm.ts` client. `llm.ts` is reused, not forked.
  - **Modes:** off (default) / free (Ollama) / premium (an Anthropic or OpenAI key, a model id and the price per million tokens).
  - **Serial call queue:** at most 12 waiting calls.
  - **Durable `chief.json`.** A call interrupted by a restart becomes needs attention and is never re-run.
- **Planning:**
  - The brief is delimited by random markers.
  - The JSON is checked against a strict schema: unknown fields are refused; there are fixed roles, phases and bounds (8 items, 2000-character prompts); and dependencies must equal the queue's ordered/parallel semantics.
  - A heuristic unsafe-prompt screen (a pattern list, not a guarantee) runs over every prompt.
  - A valid plan becomes `Consultancy.create` (pending approval, with the ORG-02 estimate). The existing `job_plan` approval then carries `proposedBy`.
  - Everything else needs attention with the reason; nothing is created.
- **Review:** after an item's task finishes with outcome `done`, the chief reviews it from bounded evidence (git shortstat, PR, branch; the transcript summary is reported as not available). It gives a recommendation, a summary and concerns. It doesn't change any job or ledger state. Only work that finishes after the brain is enabled is reviewed.
- **Coordination:** a held dependency, a repeat failure or a budget hold raises a new `chief_proposal` approval kind (idempotent by source). Deciding it records the decision. The optional `retry_held` action runs `queue.retry` after the saved approval, behind a staleness check that answers 409.
- **Budget:**
  - Free is US$0.
  - Premium has a daily cap (default $2, editable). A worst-case check runs before each call, and the brain pauses at the cap with a visible notice.
  - A failed paid call counts at its worst case.
  - It's never city credits.
- **Labels:** the chief executive becomes `monitor: 'model_backed'` with its model only while the brain is ready. The card reads "Model-backed · ‹model› · proposals only". Rule-based remains the fallback.
- **Telegram:**
  - `/plan Client | Title | Brief` proposes a plan; approval uses the existing `/approve`.
  - `/job` shows roles, order and reviews.
  - A failed plan sends a notice with the reason, and reviews send silent notices.
- **UI:**
  - The Settings brain section.
  - In the inbox: the model tag, the proposed plan's structure, chief reviews, and chief proposals (Approve & retry… / Dismiss…).
  - On the founder desk: the "Ask the chief" option, plan requests (including needs attention), and the job detail's roles, order and reviews.

## `claude -p`: not included

The brief is untrusted, and `claude -p` is an agent with tools. A reliably tool-less invocation wasn't verifiable here, and running it would need the FREE-01 gate and scrub for a hidden background process. Premium uses API keys only (see CHIEF.md).

## Evidence

| Check | Result |
| --- | --- |
| typecheck, build | pass |
| `npm test` | all pass. New: `tests/chief.test.ts` (19) and `tests/chief-server.test.ts` (2). They use a fake model (valid, malformed ×6, injection ×5, oversized, timeout), with `fetch` stubbed to throw so a real call would fail the test. They cover the budget cap and reset, that a review never auto-accepts, idempotent proposals and requests, the 409 on a stale action, rule-based fallback, restart, and Telegram `/plan` |
| `tools/chief-ui-check.ts` (fixtures 4850/4851, fake model) | 36/36 at 1440x900 and 874x402, reduced motion, no console errors |
| inbox-ui-check / org-ui-check | 47/47, 30/30 |
| mobile-ui-check | **409–410/411**. Only "full deflection runs" (touch-stick speed) fails, at a different viewport each run (667, 874 or 1024). It's a timing flake under host load and doesn't touch the files changed here; a re-run on an idle host is needed |

Screenshots are in `docs/team/reports/free-02/`:

- brain settings, free and premium;
- the chief card;
- the inbox's proposed plan, chief proposal and review;
- the founder desk's chief panel and proposed plan;

each at 1440x900 and 874x402. Unrelated regenerated screenshots were reverted. No real model, Ollama, paid API, port 4610, Pixel or `.agent-office` was touched.

## Limits

- The unsafe screen is a pattern list, not a guarantee. The CEO still reads every prompt.
- Small local models may often fail the strict schema. That shows as needs attention, which is the intended behaviour.
- There's no `response_format` hint yet (`llm.ts` doesn't send one).
- Worker transcript summaries aren't available, so reviews say so.
- Premium cost is an estimate from the price the user enters.
- The founder desk polls `/api/chief`. Telegram notices depend on the existing poller.
