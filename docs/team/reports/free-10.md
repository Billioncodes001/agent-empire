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

## Limits

- Matching is word overlap, so it can miss synonyms. That is deliberate (simple, explainable).
- The heuristic screen is a pattern list, not a guarantee. The CEO approves every lesson and reads every plan prompt.
- Persistent employee identities/roles (the rest of CONSULT-05b) are not part of this slice.
