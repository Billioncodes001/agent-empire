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

## Review fixes

The security review verdict was ACCEPT WITH FIXES. It found no unapproved send, no double send and no send outside the snapshot. Each fix has a test that failed before it.

1. **A campaign could get stuck forever** (`6ffa5dd`).
   - When a snapshot changed A→B→A, `raiseExternal` returned the resolved item A. Reconcile then fell back to ready and looped, rewriting `outreach.json` every 5 s.
   - Now only a still-pending item is reused. Otherwise a new item is raised, its stored source suffixed with the item sequence so it stays unique.
   - An unchanged campaign is not rewritten.
   - Test: the daily cap goes 200→100→200, a fresh pending item appears, and two reconciles leave the file byte-identical.
2. **One refusal could suppress the whole list** (`eed57bd`).
   - **5xx at the end of DATA** is a message problem. The campaign pauses with the reason, nobody is suppressed, the recipient stays pending, and the daily count is refunded.
   - **RCPT 5xx:**
     - Three in a row pause the campaign; resuming needs the CEO. The refusals in that streak go back to pending, and nobody is suppressed.
     - Only mailbox codes (550, 551, 553) are recorded as pending bounces, confirmed when a later send succeeds. 554 and other policy codes never suppress.
     - Refusals no longer reset the failure counter.
   - **Long lines and encoding:** `validateDraft` limits body lines to 900 bytes. `renderMessage` sends non-ASCII or long-line bodies quoted-printable, so no server needs 8BITMIME.
   - Tests: 552 at end of DATA pauses and suppresses nobody; three 550s pause, then resume sends all four; a 554 never suppresses; a 550 is suppressed only after the next success; long lines are refused; a non-ASCII body goes out quoted-printable.
3. **Lower-priority fixes** (`6ffa5dd`, `eed57bd`):
   - The external port is split into `check` and `apply`. The inbox saves the decision before outreach starts the send. Test: `approvals.json` already says approved when `apply` runs.
   - A bounce is confirmed in `outreach.json` first, and `restore()` re-applies confirmed bounces to `leads.json`. Test: suppression missing after a crash is repaired on restart.
   - Addresses are trimmed, NFC-normalised and lowercased, with C0 controls refused (`normalizeEmail`; `isEmailAddress` also refuses controls). Plus-addressing is distinct. Documented in `docs/OUTREACH.md`.
   - A draft subject containing `=?` is refused, and merge values used in the Subject have `=?` and `?=` broken apart, so the preview matches what clients display.
   - The inbox pins each sample's server footer (postal address and STOP line) below the scrolling body. `outreach-ui-check` asserts it, and `01-inbox-campaign-send-*` were re-shot.

## Merge with ORG-05 (`a1189d6`, `b992e51`, `488e33c`)

- **Approval kinds:** `external_action` (marketing_sales) and `tool_proposal` (research) sit side by side in `ApprovalKind`, `RAISED_BY`, `parseFile`, `approvalLine`, the decision branches and the inbox UI (icons, rows, footer).
- **Executives:** both are staffed. `org-ui-check` now expects four seated executives and none "Not staffed yet".
- **Consultancy:**
  - One attention hook remains: ORG-05's `itemIssue(jobKey)`. Outreach answers through `Outreach.itemIssue`, and the server chains `research.issue ?? outreach.itemIssue`.
  - Both ways of naming the artifact path work, and they compose: a reserved `options.id` from `newJobId()` (outreach) and the `{{jobId}}` prompt token (research).
- **Research now reads through the shared `src/server/artifacts.ts`:**
  - It calls `readArtifact(cfg.dir, task, 'research', jobId)`.
  - `parseArtifact` also accepts bytes (size cap, strict UTF-8).
  - Research rejects list-valued frontmatter.
  - `research-artifact.ts` was deleted after all its tests passed against the shared importer, including the race tests through `artifactTestHooks`.
  - Test changes:
    - message regexes;
    - a task without a branch now reads the project folder, which is the shared contract;
    - a bad id reports "not a consultancy job id".
- **Telegram:** `chiefCommands(…, research, outreach)`. The help lists both `/research` and `/optout`.

Re-run results:

| Check | Result |
| --- | --- |
| typecheck | clean |
| `npm test` | **706/706** |
| build | OK |
| `outreach-ui-check` | **62/62** |
| `research-ui-check` | **65/65** |
| `inbox-ui-check` | 47/47 |
| `org-ui-check` | 30/30 |
| `mobile-ui-check` | 411/411 |

Unrelated screenshots that the checks regenerated were reverted.

## Re-review fixes

The re-review verdict was ACCEPT WITH FIXES. Each fix has a test that failed before it.

1. **Refusals with a non-mailbox code could be skipped silently.**
   - When three RCPT refusals in a row paused the campaign, only pending bounces went back to pending. A refusal with any other code (for example 554 relay denied) stayed `refused`: the recipient was silently skipped and its day-count slot was never refunded.
   - The current streak's addresses are now tracked, and cleared on a success, a resume or a pause. On pause, every `refused` send in the streak goes back to pending, whatever its code, and its day-count slot is refunded.
   - Test: three 554s pause the campaign, all three are pending again, `sentToday` is 0, and nobody is suppressed.
2. **Bounce suppression is tighter.**
   - `SmtpError.enhanced` carries the RFC 3463 code from the reply (digits only).
   - A 550, 551 or 553 is a mailbox bounce only when that code is absent, 5.1.x or 5.2.x. A 5.7.x (policy or reputation) never suppresses.
   - Test: a 550 with 5.7.1 is not suppressed, and a 550 with 5.1.1 is.
3. **Minor:** a stored `tool_proposal` must carry string `name`, `url`, `licence`, `enables` and `risk` fields, with an https `url`. Otherwise the file is refused on restore, with a test.

Re-run results:

| Check | Result |
| --- | --- |
| typecheck | clean |
| `npm test` | **709/709** |
| build | OK |
| `outreach-ui-check` | **62/62** |

## Open issues
- **Reviewed:** independently reviewed and merged into `codex/empire-world` by PR #24. No real SMTP provider acceptance run was made.
- **Not built:** unsubscribe headers (`List-Unsubscribe`), per-campaign caps, and re-sending `unknown` recipients after the CEO checks them.
- **The in-game card links out** to the founder desk for pause and cancel. They aren't in the game itself.
