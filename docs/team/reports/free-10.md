# FREE-10: organizational memory (CONSULT-05 memory part)

Branch `claude/free-10-memory`, from `e822739`. Author: Claude Opus 5.5 (FREE-10 author). Status: **candidate**, needs independent review (suggested focus: prompt injection through lesson text, and the "never active without approval" path). Nothing pushed. User guide: [docs/MEMORY.md](../../MEMORY.md).

## What changed

- **`src/shared/memory.ts`**: lesson types, scopes, `relevantLessons` (deterministic word-overlap matching; client lessons only for the same client; at most 5 lessons / 2,500 characters), Markdown export.
- **`src/server/memory.ts`** (`LessonMemory`, `lessons.json`): CEO notes, chief proposals (idempotent by source key, duplicate text folded), edit as a new proposal that replaces the old lesson only when approved, immediate retire, use counts, strict restore (a bad file is preserved and memory goes read-only).
- **Inbox**: a new `lesson` kind (decision only, no budget). The decision is saved first; memory then activates or retires the lesson. A pending item is resolved when its lesson is retired or replaced. `reconcile` raises missing items and finishes decisions a restart cut off.
- **Chief** (`chief.ts`): approved, relevant lessons go into the planning prompt as a separately delimited data block with ids. The plan may cite only ids it was given (`lessons`); anything else needs attention. The plan records the lessons given and cited. Reviews, and unblock proposals for repeated failures, may carry one `lesson`. It is validated as untrusted text (length, unknown fields, invisible characters, the FREE-02 heuristic screen; a client lesson is bound to the job's client). A refused lesson leaves the review intact with a note. Lessons are never injected into worker prompts.
- **API**: `/api/memory` (list, export.md, add, edit, retire). There is no direct approve endpoint.
- **UI**: game inbox lesson detail (text, scope, provenance link, model tag, "Approve lesson…"), "Based on lessons L…" on proposed plans (inbox and founder desk), review lesson notes, and a founder-desk **Memory** panel (filters, provenance links, add, edit with re-approval, retire, Markdown export). `?job=` / `?research=` deep links open the cited source.
- Rule-based mode: the panel works; the chief makes no calls and uses no lessons.

## Evidence

| Check | Result |
| --- | --- |
| typecheck, build | pass |
| `npm test` | 824/824. New: `tests/memory.test.ts` (11) and one `/api/memory` server test in `tests/chief-server.test.ts`. They use a fake model with `fetch` stubbed to throw. Covered: proposal → inbox → approve/decline/retire; never active without approval; stale approve 409; citation in plans, plus refusal of uncited ids; hidden characters, unsafe text, extra fields, cross-client, oversized and bad-role lessons refused; scope matching; edit re-approval; restart/crash finishing; old data dirs; corrupt file read-only |
| `tools/memory-ui-check.ts` (4930/4931, fake model) | 38/38 at 1440x900 and 874x402, reduced motion, no console errors, no overflow |
| chief-ui-check (4932/4933) | 38/38 |
| inbox-ui-check (4934) | 47/47 |
| mobile-ui-check (4934) | 411/411 |

Screenshots: `docs/team/reports/free-10/` (inbox lesson and confirmation, plan "Based on lessons", Memory panel, add note, edit, desk plan lessons). Unrelated regenerated screenshots were reverted. No real model, Ollama, paid API, port 4610, Pixel or `.agent-office` was touched, and no dependencies were added.

## Review fixes

The security review result was **accept with fixes** (one critical). Each fix below has a regression test in `tests/memory-review.test.ts` that failed before the fix, and each fix is its own commit.

1. **Critical — a stale approval could activate a lesson that was never reviewed** (`aede279`).
   - Each proposal now carries a random nonce. The nonce is part of the inbox source (`lesson:L1:<nonce>`) and of the item's `lesson` payload.
   - `raiseLesson` reuses an existing item only when it matches the same proposal: lesson id, text, scope and nonce.
   - `reconcile`, `actions().check` and `apply` act on a decision only when all of these hold:
     - the item is of kind `lesson`;
     - its lesson id, text and scope are the lesson's own;
     - its nonce matches;
     - it was created at or after the lesson was proposed.
   - When the item doesn't match, the lesson gets a fresh nonce and a new pending item, and a mismatched pending item is resolved.
   - Both reported paths are tested:
     - lessons.json reset, so a new L1 meets the old approved A-item for L1;
     - approvals.json reset, so a stale `approvalId` points at an unrelated approved item.
2. **Important — Telegram `/approve` could approve unseen text** (`516a58c`). `approvalLine`, which `/approvals` uses, now prints the full lesson text, and for an edit the full text it replaces.
3. **Note — product names matched substrings** (`e991920`). They now match whole words only: "app" no longer matches "happy", and "Clinic Calendar" matches "clinic-calendar".

Re-run results:

| Check | Result |
| --- | --- |
| typecheck, build | pass |
| `npm test` | 828/828 |
| memory-ui-check | 38/38 |
| inbox-ui-check | 47/47 |

## Limits

- Matching is word overlap, so it can miss synonyms. That is deliberate (simple, explainable).
- The heuristic screen is a pattern list, not a guarantee. The CEO approves every lesson and reads every plan prompt.
- Persistent employee identities/roles (the rest of CONSULT-05b) are not part of this slice.
