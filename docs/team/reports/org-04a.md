# ORG-04a report: email outreach (marketing & sales, first channel)

- **Branch:** `claude/org-04a-outreach` (worktree-isolated), based on `origin/codex/empire-world` at `a5a3b5b`. Not pushed.
- **Spec:** [ORG_PLAN.md § Round 2](../ORG_PLAN.md). The user-facing guide is [docs/OUTREACH.md](../../OUTREACH.md).

## What was built

### Shared artifact importer (`src/server/artifacts.ts`)
This is the contract that ORG-05 also uses. It is deliberately small:

- `readArtifact(projectDir, task, kind: 'campaigns' | 'research', jobId)` returns `{ ok: true, frontmatter, body, source, path }` or `{ ok: false, reason }`, and never throws.
- `parseArtifact(text)` parses text already in hand.
- `artifactPath(kind, jobId)` returns `docs/empire/<kind>/<jobId>.md`.

It reads only for a task with `status: done` and `outcome: done`, and a `jobId` matching `consultancy-<12 hex>`. The source is the worker's worktree (`.agent-office/worktrees/<slug>` from `office/<slug>`), otherwise the committed blob on that branch, otherwise the project folder for a task without a worktree.

The worktree read walks each path component with `lstat`: no symlinks, folders first, then one regular file of at most 256 KB, and the real path must be inside the real root. It is race-safe, per the coordinator's review:

- It opens with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`.
- `fstat` must show a regular file whose dev/ino equal the earlier `lstat`, which catches a swapped file or parent folder.
- It reads at most MAX+1 bytes and closes in `finally`. Nothing is ever read by name after the checks.

On a branch, `git ls-tree` must show a blob of mode 100644 or 100755 within the cap; mode 120000 (a symlink) is refused. Frontmatter is a strict YAML subset (scalars, quoted scalars, inline and block lists, unique keys), and every error carries its line number. Kind-specific fields are validated by the caller.

### Outreach (`src/server/outreach.ts`, `src/shared/outreach.ts`)
- **Leads**
  - CSV import with RFC 4180 quoting. The header needs `name,email,company,source,basis`; `tags` is optional.
  - Each row is validated: a valid address, required `source` and `basis`, and no CR/LF or control characters. Refused rows are reported with their line and reason.
  - Leads are kept in `leads.json`, de-duplicated by lowercase address.
  - Worker-proposed leads are stored `proposed` and are never recipients until the CEO accepts them, or imports the same address.
- **Suppression:** opt-out, bounce and blocked. It is checked when the snapshot is built and again at the moment of each send. A 5xx to `RCPT TO` or to the end of DATA adds a bounce.
- **Campaigns**
  - Each campaign is an internal consultancy job (client "Internal", estimate, CEO approval). `Consultancy.newJobId()` and `create(..., { id })` reserve the job id, so the prompt can name `docs/empire/campaigns/<jobId>.md`.
  - The draft contract is strict:
    - frontmatter `subject`, `audience` and optional `proposedLeads`, and no other keys;
    - a plain-text body with no HTML, and only `{{name}}`/`{{company}}` in the subject or body.
  - An invalid or missing artifact puts the campaign in `needs_attention`, and the consultancy item in `needs_attention` with the reason (the new `itemAttention` port). A retry clears it.
  - The drafting task binding (`{id, attempt, branch, workerName, done}`) is persisted when first seen. So, per the coordinator's request, a draft is still imported from the committed branch if the queue forgets the task first.
  - The label reads "Drafted by <worker> — not verified".
- **Approval**
  - A frozen snapshot (subject, body, server footer, from, cap, interval, recipients, exclusions) is hashed with sha256 and raised by marketing_sales as an `external_action` (`ApprovalInbox.raiseExternal`). The item carries 2 rendered samples and the full recipient list.
  - Any change resolves the old item as superseded and raises a new one. Approving a stale item is refused with 409.
  - Rejecting records the decision. A budget on a send is refused.
- **Sending**
  - It uses the ORG-03 SMTP client. `SmtpError.uncertain` is set when the text was written after DATA but no final reply arrived.
  - One recipient per message. The interval (default 10 s) and the daily cap (default 200) are global, per UTC day.
  - `in_flight` is saved before each send. A restart turns it into `unknown`, and an `unknown` is never re-sent.
  - Transient failures that are definitely not sent are retried 3 times, then marked failed.
  - A sign-in failure or a refused sender pauses the campaign. The CEO can pause, resume or cancel.
- **Config:** `AGENT_EMPIRE_OUTREACH_FROM` and `AGENT_EMPIRE_OUTREACH_ADDRESS` plus `AGENT_EMPIRE_SMTP_URL` are required, and the status says what is missing. `AGENT_EMPIRE_OUTREACH_DAILY_CAP`, `_INTERVAL_SEC` and `_NAME` are optional.
- **Wiring**
  - Routes under `/api/outreach` (same-origin or bearer for changes).
  - Telegram `/optout <email>`, and `/approve A7` / `/reject A7` for sends.
  - `OrgState.marketing_sales` is active: "N campaigns · sending · drafting · leads · proposed to accept · sends waiting", and its attention is the pending sends.

### UI
- **Founder desk → Email outreach:**
  - campaign cards with real per-recipient counts, the unverified label, the draft and server footer, the reason a draft needs attention, the approval id, pause/resume/cancel, and the per-recipient log;
  - leads, with CSV paste or file, the lawful-basis and no-scraping statements, and proposed leads to accept or decline;
  - suppression, with the no-IMAP note.
- **Game inbox:** a campaign send shows both exact sample messages on paper, every recipient, exclusions, the sender, the pace and the unverified label. Approving needs a confirmation that names the count and the sender.
- **Marketing & sales card:** staffed and rule-based, with a "Leads & campaigns ↗" link. Its suit changed to `business-f01`, because `business-f03` collided with the chief's. Found by org-ui-check; covered by `executive-suits.test.ts`.

## Evidence

| Check | Result |
| --- | --- |
| typecheck | clean |
| `npm test` | **678/678** |
| build | OK |
| `outreach-ui-check` (new) | **60/60** |
| `inbox-ui-check` | 47/47 |
| `org-ui-check` | 32/32 (updated: marketing & sales staffed) |
| `mobile-ui-check` | **411/411** |

New tests:
- `artifacts.test.ts` (6): parse grammar; done-only; symlink file, folder and worktree; `..` and bad ids or branches; size; UTF-8; branch fallback and committed symlink; race cases (FIFO swap without hanging, swap to a `/dev/zero` symlink, swapped parent folder, growth past the cap).
- `outreach.test.ts` (16): CSV validation; draft import and labels; needs-attention reasons; strict contract; exact frozen snapshot with the footer always last; supersede on change; suppression wins (pre-snapshot, at send, bounce); rate and daily cap; restart with in-flight treated as unknown; uncertain, transient and sign-in failures; pause and cancel; header injection; disabled config; proposed leads; persisted binding with branch import; Telegram `/optout` and `/approve`.
- `outreach-server.test.ts`: routes, auth and Origin, the full flow through the inbox and a fake transport.
- `executive-suits.test.ts`.

Only fake transports were used, with no real recipient, no SMTP or Telegram network and no paid calls. The fixtures were `ui-fixture` (`FIXTURE_OUTREACH=1`) and `consultancy-preview` (`PREVIEW_OUTREACH=1`) on ports 4760–4765. Unrelated screenshots that the checks regenerated were reverted.

Screenshots are in `org-04a/`:

| Screenshot | Sizes |
| --- | --- |
| `01-inbox-campaign-send` | 1440x900, 874x402 |
| `02-inbox-confirm-send` | 1440x900 |
| `03-marketing-card` | 1440x900, 874x402 |
| `04-founder-outreach` | 1440x900, 874x402, 375x812 |
| `05-founder-leads` | 1440x900, 874x402, 375x812 |
| `06-founder-paused` | 1440x900 |

## Open issues
- **ORG-05 reconciliation:** ORG-05 merges its own `research-artifact.ts` and a `tool_proposal` kind. The coordinator should fold it onto `artifacts.ts`, and add `tool_proposal` beside `external_action` in `ApprovalKind`, `RAISED_BY` and `parseFile`.
- **No independent review yet.** No real SMTP provider acceptance run was made.
- **Not built:** unsubscribe headers (`List-Unsubscribe`), per-campaign caps, and re-sending `unknown` recipients after the CEO checks them.
- **The in-game card links out** to the founder desk for pause and cancel. They aren't in the game itself.
