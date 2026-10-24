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
| `tools/chief-ui-check.ts` (fixtures 4850/4851, fake model) | 36/36 (38/38 after review fixes) at 1440x900 and 874x402, reduced motion, no console errors |
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

## Review fixes (security review 2026-10-24: accept with fixes)

The failing-before tests are in `tests/chief-review-fixes.test.ts`: 6 tests, all failing on the reviewed code. They were committed first, and each fix has its own commit.

1. **Invisible characters.** Model-written titles, prompts, summaries, review text and proposals refuse:
   - format characters (zero-width, bidi overrides and isolates, soft hyphen);
   - Unicode tags (U+E0000–E007F);
   - line and paragraph separators;
   - private-use and unassigned code points;
   - every control character except newline and tab.
2. **Prompts at the point of approval.** The public plan now carries each item's full queued prompt.
   - The game inbox shows them as scrollable text. It offers no approve button for a model-proposed plan whose prompts aren't loaded.
   - **Telegram refuses `/approve` for model-proposed plans**, both by inbox id and by job id, and points to the game or the founder desk. `/reject` still works.
   - `/job` shows shortened prompts.
   - The Telegram notice no longer suggests `/approve`.
   - The founder desk already showed every prompt.
3. **No repeated paid reviews.** Review and stall keys go into a never-trimmed `seen` list in `chief.json`, which is rebuilt from records on restore. A full call queue now defers a review to a later pass instead of dropping it. Tested with 201 finished items: exactly 201 calls, and none after a restart.
4. **Usage-less paid answers** are charged the worst case. The worst case now counts 1 token per 2 ASCII characters and 1 per non-ASCII character. A failed paid call is charged the worst case (tested).
5. **"Model-backed" only when usable.** The free brain needs a cached Ollama check (refreshed every 30 s) showing Ollama running and the model downloaded. A failed call makes it not ready, so the chief falls back to Rule-based, until a successful call or a healthy check. For premium, the hold lasts until a successful call, 10 minutes or a settings save. A retry request is still accepted. Tests and previews that inject a fake model get no real probe.
6. **Heuristic screen.**
   - A bare `.env` now matches (`.env.example` doesn't).
   - Added verbs: include, commit, cat, echo, expose, copy, and "log the/it".
   - Token matching needs a qualifier (auth, API, session…), so design tokens don't match.
   - CHIEF.md, this report and the code comments call it a heuristic, not a guarantee.

**Re-run:**

| Check | Result |
| --- | --- |
| typecheck, build | pass |
| `npm test` | 777/777 |
| chief-ui-check | **38/38**. Adds the inbox showing all 4 full prompts, and screenshot `04b-inbox-plan-prompts-*` |
| inbox-ui-check / org-ui-check | 47/47, 30/30 |
| mobile-ui-check | **410/411**. The failure is "667x375 full deflection runs" (touch-stick timing). All my other fixtures were stopped, but the host wasn't idle: other sessions held the load average at 40–43, so this still isn't an idle-host result |

## Re-review fixes (2026-10-24: accept with fixes)

The failing-before tests are in `tests/chief-rereview.test.ts`: 4 tests, all failing on the previous code. Each fix has its own commit.

1. **Failure hold applies to queued calls.** A queued background review or stall checks for a failed call at the moment it would run. During a hold it is skipped: its record is removed and its key unmarked, so it retries after the hold without being spent. Tested with a provider that is down: 1 call, not 12, and the other 11 items are reviewed after recovery.
2. **Telegram refusal no longer depends on the chief's record.** `/approve <jobId>` is also refused when the inbox's `job_plan` item has `proposedBy`. A proposed plan whose job still awaits approval is never trimmed, and nothing is trimmed if the snapshot can't be read. Tested with 61 newer plans, including a command surface with no brain.
3. **The seen set shrinks.** Each reconcile pass drops keys whose job left the snapshot, or whose task left the queue or finished before the brain was enabled. A budget key is dropped once its hold changes. Pruning is skipped while the queue or consultancy reports a storage error. Tested: 16 keys become 8, with no re-reviews.
4. **The prompts shown are the queued ones.** After `office.create`, each plan item's prompt is copied from the saved job item, for example with `{{jobId}}` resolved. Tested.

**Re-run:**

| Check | Result |
| --- | --- |
| typecheck, build | pass |
| `npm test` | 781/781 |
| chief-ui-check | 38/38 |
| inbox-ui-check | 47/47 |

Only my own fixture ports (4870–4872) were used and stopped. Unrelated regenerated screenshots were reverted.
