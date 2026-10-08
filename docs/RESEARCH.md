# Research executive

Sam · Research is a rule-based executive. It files your questions as internal jobs, imports the worker's report when the job finishes, and raises one inbox item per proposed tool. Sam doesn't call a model. The workers write the reports, and nothing in a report is verified by the Empire.

## Asking a question

There are three ways to ask:

- **Founder desk** (`/consultancy.html`): use the **Research** section.
- **In the city**: go upstairs to the loft, walk to Sam's desk and press **E**. The research card has a question box.
- **Telegram**: send `/research <question>` to your owner-only bot.

Each question becomes a consultancy job for the client **Internal**. The job has one item and an estimate. Like any job, it needs your approval in the inbox, on the founder desk, or with `/approve A<n>`. Nothing runs and nothing is spent until you approve it.

## What the worker writes

The worker writes one file in its worktree, `docs/empire/research/<jobId>.md`, and commits it:

```markdown
---
question: Can we offer appointment booking for dental practices?
feasibility: partial        # feasible | partial | not_yet | unknown
confidence: medium          # low | medium | high
---
## Findings
- One claim per bullet, each citing a source (https://…).
## What we can do now
## What we can't do yet and why
## Proposed tools
| Name | URL | Licence | Enables | Risk |
|---|---|---|---|---|
| … | https://… | MIT | … | … |
```

If no tools are proposed, the Proposed tools section says `None.` instead of the table. The prompt asks the worker to be honest: it should report infeasibility with evidence, and it must not invent sources.

## Import

The report is imported only when the task finishes with outcome `done`. It's read from the worker's worktree, or from its branch if the worktree is gone. The importer applies these limits:

- symlinks and `..` are refused;
- files over 256 KB are refused;
- the parse is strict.

A report is rejected, and the item shows **Needs attention** with the reason, if any of these are true:

- the file is missing;
- the frontmatter is missing or has an unknown key;
- `feasibility` or `confidence` has an invalid value;
- a section is missing or appears twice;
- a Findings bullet has no source URL;
- a tool has no https URL.

When you retry the task, the report is read again after the new attempt finishes. An accepted report is never re-imported.

The report index is kept in `research.json` in the data directory. A data directory from before ORG-05 starts empty.

## Reading reports

The research card and the founder desk list every report with its question, feasibility, confidence, date and provider cost. Each report carries the label "Researched by <worker> — not verified". Report text is always rendered as text. Links appear only for `https` URLs, as anchors with `rel="noopener noreferrer"`.

## Tool proposals

Each proposed tool becomes a **Tool proposal** item in the inbox, raised by Sam. It shows:

- the tool's name and link;
- its licence;
- what it enables;
- its risk.

When you approve or decline a tool proposal, only your decision is recorded, and it shows on the research card. **Nothing is installed or adopted automatically.** Adopting a tool is later work that goes through the normal reviewed flow. Telegram `/approve A<n>` and `/reject A<n>` work for tool proposals too.

## API

These routes need sign-in. A POST also needs a same-origin request.

- `GET /api/research` returns the report index.
- `GET /api/research/reports/:jobId` returns one report, with its sections.
- `POST /api/research` with `{ "question": "…", "requestId": "…" }` asks a question. It's idempotent per `requestId`.
