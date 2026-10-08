# ORG-05: Research executive

This report covers the research executive, built on branch `claude/org-05-research` from `a5a3b5b`. It's awaiting independent review. The user guide is [docs/RESEARCH_EXECUTIVE.md](../../RESEARCH_EXECUTIVE.md) (docs/RESEARCH.md was already the design-research log, so this guide sits beside it and is linked from it).

## What was built

**Research is staffed.** Sam · Research is now active and rule-based, and has a seated body in the loft.
- The summary line counts reports in four states: in, in progress, awaiting approval, and needing attention.
- Sam's attention count is the open tool proposals Sam raised.

**Asking a question.** There are three ways to ask: the founder desk Research section, the research card's question box, or Telegram `/research <question>`.
- Each question becomes a consultancy job for client `Internal`, with one item and an estimate. It goes into the approval inbox like any plan.
- Asking is idempotent per request id, so Telegram replays are safe.
- The item prompt names `docs/empire/research/<jobId>.md`. Consultancy replaces a `{{jobId}}` token before saving and fingerprinting. Plans without the token are unchanged, and existing journals load unchanged.

**Importing the report** (`src/server/research.ts`). A report is imported only when its queue task finishes with outcome `done`.
- Parsing is strict:
  - the frontmatter keys are exactly question, feasibility and confidence, each with an allowed value;
  - the four required sections each appear exactly once;
  - every Findings bullet cites a URL;
  - Proposed tools is either `None.` or a five-column table with https URLs, at most 10 rows, with no duplicate tools.
- If a report is rejected, its consultancy item becomes `needs_attention` with the reason, through the new `itemIssue` port.
- A report is re-read only after a new attempt finishes. An accepted report is never re-imported.
- The index is stored in `research.json`.

**The importer** (`src/server/research-artifact.ts`). It has the exact ORG-04a contract: `readArtifact(task, kind, jobId, { projectDir }) → {ok, frontmatter, body} | {ok:false, reason}`.
- It reads the worker's worktree first, and falls back to the worker's branch through `git ls-tree`/`cat-file`.
- It checks every path component with lstat: no symlinks, in the worktree or on the branch (mode 120000).
- It rejects `..`, unsafe job ids and unsafe branch names.
- The size cap is 256 KB.
- The parse requires strict UTF-8 frontmatter.

**Tool proposals.** There's a new approval kind, `tool_proposal`, raised by research. It carries a `tool` field: name, URL, licence, enables and risk.
- `ApprovalInbox.raise()` is idempotent by source `tool:<jobId>:<n>`.
- A decision is only recorded, and it's mirrored on the research card. No job is created, no task is queued and nothing is installed.
- The inbox shows a tool proposal's facts with a safe link, has no budget input, and uses confirmation copy that says nothing is installed.
- Telegram `/approvals`, `/approve` and `/reject` work for tool proposals.

**UI.**
- The research card (E at Sam's desk) has a question box, a list of reports and a report view. The report view has four sections and the label "Researched by <worker> — not verified".
- The founder desk has a Research section and a paper report dialog.
- All worker text is rendered as text nodes. Only https links are shown as anchors, with `rel="noopener noreferrer"` and `target=_blank`.

**Wire.** `welcome.research`, the `research` message, and the routes `GET/POST /api/research` and `GET /api/research/reports/:jobId`.

## Tests and checks

| Check | Result |
|---|---|
| typecheck (server, client, cloud) | clean |
| `npm test` | 670/670. The new `tests/research.test.ts` has 16 tests: importer safety (symlinked dir, symlinked file, committed symlink, `..`, unsafe branch, size, wrong kind folder), strict parse reasons, the source-URL rule, feasibility and confidence validation, tool proposals created once across re-import and reload, decisions only recorded, outcome-gated import, retry re-import, old data dirs and a corrupt index, Telegram `/research`, and the org projection. Also the `org-server` API test, plus the org tests updated for research being staffed. |
| `npm run build` | ok |
| `tools/research-ui-check.ts` | 44/44, desktop 1440×900 and phone 874×402 (touch, reduced motion) |
| inbox-ui-check | 47/47 |
| org-ui-check | 32/32 (updated: research is now seated, marketing alone is unstaffed) |
| mobile-ui-check | 411/411 |

All checks ran against isolated fixtures on ports 4771–4776 (`FIXTURE_RESEARCH=seed`, `PREVIEW_RESEARCH=seed`). Nothing touched 4610, Pixel or `.agent-office`. There were no network calls, no paid calls and no new dependencies. Screenshots are in [org-05/](org-05/). Regenerated screenshots belonging to other slices were reverted.

## Open issues

- **Importer swap.** The coordinator should swap `research-artifact.ts` for ORG-04a's `artifacts.ts` once that merges. ORG-04a's version may accept a different options argument for the project dir.
- **Merge conflicts with ORG-04a.** Expect conflicts in the `ApprovalKind` union, in `parseFile` kind validation, and in the `decide` branch. ORG-04a adds `external_action` in those places.
- **Sources aren't checked.** The URLs are the worker's citations and the Empire doesn't fetch them. The UI says so.
- **Report import timing.** Import needs the queue task to still be present with its branch. If a task is cleared before the 5 s reconcile, its report is not imported.
- **Hint wording.** The desk hint reads "2 waiting for you". That's the existing generic executive hint.
