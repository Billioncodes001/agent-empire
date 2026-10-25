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

## Capability matrix (local server vs cloud)

The table is the content of `src/shared/org-capabilities.ts`. Every "not in cloud mode" message in the game comes from it (`cloudGapMessage`), and a test checks that each gap has a specific reason and that the reason appears in its message.

| Feature | Local server | Cloud mode | Reason for the gap |
| --- | --- | --- | --- |
| Inbox: tool proposals | Raised from research reports; the decision is recorded only | **Works**: raised from cloud research and decided in the game | — |
| Inbox: lessons | Proposed by the CEO or the chief's model; approval makes them planning context | **Works** for lessons you write | The chief proposes none, because it has no model in cloud mode |
| Inbox: client plans | A saved job waits with its estimate | Not raised | Cloud mode has no consultancy journal or estimates. Each cloud job is approved when you submit it: the paid confirmation is checked against the current limits |
| Inbox: budget increases | Held items wait for a raise | Not raised | A cloud job can't spend more than the per-job allowance you confirmed: the session or run is capped at it, and the coordinator can't raise a running session's cap. Instead, raise Limits and submit a new job |
| Inbox: campaign sends | The exact message and every recipient, sent over SMTP | Not raised | See outreach |
| Inbox: chief proposals | Written by the chief's model | Not raised | No model in cloud mode |
| Executives | Rule-based, from the live queue, workers, jobs and usage | **Partial**: rule-based, from the snapshot (cloud jobs, spend ledger, research, inbox), labelled with its age | No live queue or desk workers; marketing has nothing to coordinate |
| Chief's planning brain | Off, free (Ollama) or premium (API key, daily cap) | Unavailable; the chief is rule-based | The free brain needs Ollama on your computer, and GitHub-hosted runners have none. A premium brain would need a model API key as another Actions secret and a cap the coordinator enforces. That is not built, and the coordinator calls no model. A Claude subscription is never relayed |
| Research | Question → internal job that needs approval → report read from the worktree | **Works**: question → paid cloud job you confirm → report read from the task branch → tool proposals | — |
| Email outreach | Leads, suppression and paced SMTP sends | Unavailable | The SMTP password would have to be an Actions secret. The coordinator runs every 15–60 minutes, so it can't pace sends or keep a daily cap. Leads and opt-outs are personal data, which git history would keep after deletion. There is no Telegram `/optout` |
| Organizational memory | Reviewed lessons, cited when the chief plans | **Partial**: add, edit, approve, decline, retire, export as Markdown | No plan cites lessons in cloud mode, because there is no planning brain |
| Telegram and email notifications | Announce items and decide them | Unavailable; the HUD badge shows the count | They need a bot token or SMTP password and an always-on poller |
| Founder desk page | `/consultancy.html` | Unavailable; use the in-game inbox, the executive cards and the Cloud Empire window | It is served by the office server's HTTP API |

## Design

- **Shared rules used by both sides**, as FREE-09 did:
  - `src/shared/text-safety.ts`: the hidden-character test and the heuristic screen (from `server/chief.ts`).
  - `src/shared/lesson-rules.ts`: `checkLesson`, `sameLesson`, and `lessonItemMatches`, the FREE-10 nonce/match guard (from `server/memory.ts`).
  - `src/shared/artifact-parse.ts`: the strict frontmatter parser (from `server/artifacts.ts`).
  - `src/shared/research-report.ts`: the worker prompt and the strict report parser (from `server/research.ts`).
  - In `src/shared/approvals.ts`: `RAISED_BY` (from `server/approvals.ts`) and the new `approvalFingerprint`.

  The server files re-export the moved code unchanged, and a test asserts that the server and the coordinator call the identical functions.
- **State:** `state/org.json` (`src/cloud/org.ts`, browser-safe) holds:
  - `approvals`: only `tool_proposal` and `lesson`; `validateOrg` refuses any other kind;
  - `lessons`: each with a nonce;
  - `research`: each report's summary, with sections clipped to 4,000 characters.

  The file is optional. A snapshot from an older coordinator has none and reads as an empty organization. An empty organization is never written, so existing Empires gain no commit until they use it. Readers fetch `STATE_PATHS`: the required files plus the optional ones.
- **Intents**, with strict allow-lists (`src/cloud/intents.ts`):
  - `approval_decision {approvalId, decision, seen}`. `seen` is the fingerprint of the item as it was displayed, and the coordinator applies the decision only if it still matches the item. Otherwise the decision is refused as "changed after you opened it".
    - Deciding an item the same way again is a duplicate and changes nothing. Deciding it the opposite way is refused.
    - A lesson must also pass `lessonItemMatches` (id, text, scope and nonce).
    - Neither kind moves money or city credits.
  - `lesson_propose {lesson: {text, scope, scopeValue?, supersedes?, source?}}`. It runs the shared `checkLesson` and refuses duplicates. An edit keeps the old lesson in use until it is approved. The nonce is derived from the intent id, so the coordinator stays deterministic.
  - `lesson_retire {lessonId}`. It takes effect at once, and a waiting lesson's inbox item becomes `resolved`.
  - `research {question, job: {id, configRevision, confirmPaid: true}}`. It uses the same `validateSubmit` and the same coordinator path (`queueJob`) as `new_job`, so the same checks apply: the current `configRevision`, execution ready, the queue and review caps, the per-job allowance and the daily limit.
- **Research import:** after the read-only observation phase, the coordinator reads `docs/empire/research/<jobId>.md` from the task branch of each research job whose turn has finished.
  - The read uses `readBranchFile`: the GitHub contents API with the project token. It accepts regular files only, up to 256 KB, and makes at most 5 reads per run. A commit retry reuses the results.
  - A failed read is retried next run.
  - A missing or invalid report needs attention, with the parser's reason. So does a failed or cancelled job.
  - An imported report is never read again. Each proposed tool raises one inbox item.
- **Game:**
  - `CloudNet` emits `approvals`, `org` and `research` from the snapshot, in the server's message shapes, so the existing inbox, executive cards and research panel show cloud data.
  - Actions send intents:
    - inbox decisions go through the confirmation step, then show "sent to your coordinator", with no second decision while one is in flight;
    - research questions go through the existing paid-job confirmation dialog;
    - lessons go through the new cloud memory panel, opened from the chief's card.
  - The inbox lists the four kinds that are not raised in cloud mode, each with its reason.
  - Each executive card carries its specific gap note, and the marketing card no longer links to the founder desk.
- **Claude compliance:** no secret, token or credential is added or read. Branch reads use the coordinator's existing project token.

## Evidence

| Check | Result |
| --- | --- |
| Typecheck (server, client, cloud) | Clean |
| `npm test` | 1040 of 1041 pass, 0 fail. The 1 skip is the existing actionlint test (actionlint isn't installed). 10 tests are new, in `tests/free-07-cloud-org.test.ts` |
| `build`, `build:cloud` | OK |
| `tools/cloud-org-ui-check.ts` (new) | 50/50 |
| `cloud-ui-check` | 171/171 |
| `inbox-ui-check` | 47/47; its cloud assertion was updated to the FREE-07 behaviour |
| `chief-ui-check` | 38/38 |
| `memory-ui-check` | 38/38 |
| `mobile-ui-check` | 411/411 |

- **Failing first:** the new tests fail against the pre-FREE-07 sources (`git checkout 3a8a0aa -- src`), because the shared modules and the intents don't exist there. To be honest: most of the coordinator code was written before its tests. The tests were then written from the requirements, not from the code.
- **No network:**
  - The tests use `MemoryStateStore` and `FakeProvider`, which keeps task-branch files in memory.
  - The UI check seeds the state repository with the real installer and real coordinator ticks into an in-memory `api.github.com` (a Playwright route). The real coordinator imports the research report through `readBranchFile`.
  - The page started no provider session.
- **Ports:**
  - The fixtures ran on 5007 (plain) and 5008 (chief), with the preview on 5009, and only those PIDs were stopped.
  - Nothing touched 4610, Pixel or `.agent-office`.
  - Screenshots regenerated by the other checks were reverted, and their new untracked files deleted.
  - The inbox check mutates fixture state, so it was re-run on a fresh fixture.
- **Merge:** `origin/codex/empire-world` (54eed58) merged with no conflicts. It already included FREE-08, CITY-06/08, CHAR-01, the release-assets rename, the device-testing fixes and the toast placement.

### Screenshots

All are in [free-07/](free-07/), at 1440x900 and 874x402:

- `*-01-cloud-inbox.jpg`: a tool proposal and a lesson, with "Not raised in cloud mode" and its reasons.
- `*-02-decision-sent.jpg`: a decision waiting for the coordinator.
- `*-03-chief-card.jpg`: the rule-based chief built from cloud jobs, the brain gap, and the memory link.
- `*-04-memory.jpg`: lessons in use and waiting, and an invalid lesson refused in the game.
- `*-05-marketing-card.jpg`: the outreach gap.
- `*-06-research-report.jpg`: a report imported from the task branch.
- `*-07-research-confirm.jpg`: the paid confirmation for a cloud research question.

## Deferred / not verified

- **No real GitHub run.** The contents-API read (`GET /repos/{o}/{r}/contents/{path}?ref=<branch>`) follows GitHub's documented API: the `type: file` field, the size, the base64 content and the 404 behaviour. It has only been exercised through fakes. A first real run should ask one research question and check the import.
- **Phone checks** use Chrome device emulation, not a real device. Reduced motion was on for the phone run. Save-Data and a full keyboard walk of the new memory panel were not checked separately.
- **Lessons** are not cited by any plan in cloud mode, because there is no brain. A cloud planning brain (an API-key secret and a coordinator cap) would be its own slice and needs an owner decision.
- **Outreach in cloud** is not built and needs an owner decision: the SMTP secret, personal data in git history, and pacing.
- **Retiring a lesson** in the memory panel uses the browser's `confirm()` dialog. It is plain, but it works on touch.
- **The fingerprint** is FNV-1a. It guards against stale views, not forgery: anyone who can forge an intent can already write the state repository.
