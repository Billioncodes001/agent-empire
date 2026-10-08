# ORG-03 report: CEO approval inbox and notifications

- **Branch:** `claude/org-03-inbox` (worktree-isolated). It was based on `claude/org-01-02` (`e3bb709`), then merged with `origin/codex/empire-world` at `8e0498d`.
- **Spec:** [ORG_PLAN.md § ORG-03](../ORG_PLAN.md). The user-facing guide is [docs/APPROVALS.md](../../APPROVALS.md).
- Not pushed.

## What was built

### Server
- **`src/server/approvals.ts`: `ApprovalInbox`**
  - The inbox is durable in `approvals.json`, written atomically.
  - There are two kinds: `job_plan`, raised by the chief of staff, and `budget_increase`, raised by finance.
  - Items carry the spec's fields (id, kind, raisedBy, title, detail, estimate, createdAt, status, decidedAt, decidedBy), plus jobId, spend, approved and suggested budgets, and the decided budget.
  - **Reconciled from consultancy state.** It runs on every consultancy change, on the 5-second timer and before each API call.
    - A plan decided on the founder desk or with `/approve consultancy-…` resolves its item.
    - A persisted `budgetHold` raises one item per hold, keyed by `reachedAt`.
    - A hold cleared elsewhere resolves its item.
  - **Decisions go through consultancy.**
    - Approving a `job_plan` calls `Consultancy.approve(budgetUsd)`; rejecting it calls `reject`.
    - Approving a `budget_increase` calls `raiseBudget`, which releases the held items, and the queue is pumped at once. The default budget is spend plus the remaining estimate top, rounded up (`suggestBudget`). A budget at or below spend is refused.
    - Rejecting a `budget_increase` records the decision and leaves the job held.
  - **Idempotent:** an already-decided item returns its existing decision.
  - **Old data:** a directory without `approvals.json` works. A corrupt file is preserved and blocks decisions with a 503.
- **Routes:** `GET /api/approvals` and `POST /api/approvals/:id/(approve|reject)`, authenticated like the other routes. Decisions need same-origin or a bearer token. The budget is validated as in ORG-02.
- **WebSocket:** `welcome.approvals` plus an `approvals` message, sent on change only.
- **OrgState:** chief of staff and finance `attention` count the pending inbox items each raised.

### Telegram
- `/approvals` lists what's pending.
- `/approve ID [budget]` and `/reject ID` work for inbox ids (`A3`, case-insensitive) and still accept consultancy job ids.
- Each new pending item sends one message. The first poll is a silent baseline, and announced ids persist in `telegram.json` (`notified`).
- Owner-only rules are unchanged.

### Email (optional)
- **`src/server/email.ts`** is a minimal SMTP client with no new dependency, behind `MailTransport`. It supports:
  - implicit TLS, or STARTTLS for `smtp://`;
  - AUTH PLAIN or LOGIN;
  - MAIL, RCPT and DATA with CRLF normalisation and dot-stuffing;
  - per-step and overall timeouts.
- Credentials are never sent unencrypted, except to localhost.
- Errors carry status codes only. The URL and password are never logged.
- **`EmailNotifier`:**
  - sends one email per new pending item, with a silent first-run baseline;
  - remembers what it sent in `email-notify.json`;
  - retries with backoff and never blocks the server.
- The status appears in `/api/consultancy/status.email` and on the founder desk: "Email: not configured / configured / last send failed".

### Game
- **Inbox tray** on the founder's desk in the HQ loft (`world/inbox-tray.ts`): a walnut-and-brass tray whose paper stack grows with the count, with a dot-matrix plaque showing the number. The plaque pulses gently, and stays still under reduced motion.
- **E at the tray** opens the inbox, from beside the CEO chair. The hint reads "CEO inbox · N waiting".
- **Inbox panel** (`ui/inbox.ts`):
  - a list and a detail view, showing the estimate with its basis, and spend against budget with a meter;
  - a budget input, pre-filled;
  - Approve and Decline, each with an inline confirmation that names the amount;
  - recent decisions.
  - On phones the list and detail are separate views with a back button.
- **HUD badge:** "📥 Inbox N", shown only while something waits. On touch layouts it stays visible next to Management.
- **Executive cards:** the chief of staff and finance cards link with "Open inbox".
- **Cloud mode** shows "The approval inbox isn't available in cloud mode yet."
- **Fixture:** `tools/ui-fixture.ts` now holds a real `ApprovalInbox` over a real consultancy journal in a temp directory, with a fake queue so nothing runs. It has one plan and one held job with a budget increase. `FIXTURE_APPROVALS=none` empties it.

## Evidence

**Tests.** Each was written before its code and run failing first:

| File | Tests |
| --- | --- |
| `approvals.test.ts` | 11 |
| `approvals-server.test.ts` | 4 (auth and Origin, validation, welcome and change-only messages, founder-desk consistency, email through the server) |
| `telegram-approvals.test.ts` | 2 |
| `email.test.ts` | 7 (a fake local SMTP server built on `net.createServer`, covering AUTH PLAIN and LOGIN, dot-stuffing, a 451 response, timeout, STARTTLS refusal and no secrets in errors or logs; plus a fake transport for notifier baseline, de-duplication, restart and backoff) |

No real network was used.

**Checks.** All ran against isolated fixtures on ports 4750–4755:

| Check | Result |
| --- | --- |
| typecheck | clean |
| `npm test` | 641/641 |
| `npm run build` (including `check-trust`) | OK |
| `tools/inbox-ui-check.ts` (new) | **35/35** |
| `org-ui-check` | 32/32 |
| `mobile-ui-check` | 411/411 |
| `life04-ui-check` (`FIXTURE_SCENARIO=waiting`) | 16/16 |
| `outfit-ui-check` | 29/29 |

Screenshots are in `org-03/`. Screenshots that the other checks regenerated were reverted.

| Screenshot | Sizes |
| --- | --- |
| tray | 1440x900, 874x402, 375x812 |
| list | all three |
| budget detail | all three |
| confirmation | desktop |
| after approval | desktop |
| cloud message | desktop |

## Review fixes

The security review verdict was ACCEPT WITH FIXES. Each fix has a test that failed before it, except where noted.

1. **A declined budget increase was a dead end** (`129ec85`, UI `57bec24`).
   - A `rejected` `budget_increase` now carries `reopenable` while the very hold it was raised for still stands.
   - Approving it records a new decision with the new actor and time, plus a note: "Reopened after decline on … by …". It uses the same budget validation and calls `raiseBudget` exactly once.
   - In the game, Recent decisions shows "Still held · Approve increase…". The detail offers only "Approve increase…", with confirmation.
   - Telegram `/approve A5 [budget]` works on such items. The decline reply now says how to release the job later.
   - Tests: inbox, Telegram, and `inbox-ui-check` (decline, then reopen and approve).
2. **The HUD wrapped to two rows at 1440** (`4bf9649`).
   - At 1680 px and below, Join voice, Share screen and Inbox become icon buttons. Their `aria-label` and `title` are kept, and the row is tightened.
   - At 1360 px and below, Services also becomes an icon button.
   - `inbox-ui-check` asserts a single row and accessible names at 1280, 1440 and 1920. Screenshots: `07-hud-one-row-*`.
3. **STARTTLS response injection** (`0512e2a`). Anything left unread after the STARTTLS 220 aborts the send before the handshake, and `attach()` clears plaintext state. Test: a fake server pipelines a reply after the 220, and no AUTH is sent.
4. **A failing email blocked the queue** (`0512e2a`).
   - A 5xx, or 5 failed attempts, gives up on that item. The give-up is logged, persisted in `email-notify.json` as `gaveUp`, and shown in the status as "last send failed".
   - The next item is sent.
5. **Telegram decisions now pump the queue and re-publish the inbox**, like the HTTP route (`129ec85`).
6. **A hold that clears is recorded as approved outside the inbox only with evidence of a raise**: the job's approved budget is above the one the hold was reached at. Otherwise the item is `resolved` (`129ec85`).
7. **A plan created with `/new` is no longer announced twice.** Its inbox key is recorded silently, and the reply names the approval id (`129ec85`).

Also added, as regression coverage; these already passed:
- a subject with CR/LF stays one header line;
- bearer-device auth on `/api/approvals`, including decisions without an Origin, and a bad token gets 401;
- the game and Telegram approving the same item call `raiseBudget` once.

Re-run results:

| Check | Result |
| --- | --- |
| typecheck | clean |
| `npm test` | **650/650** |
| build | OK |
| `inbox-ui-check` | **44/44** |
| `org-ui-check` | 32/32 |
| `mobile-ui-check` | **411/411** |

## Re-review fixes

The re-review verdict was ACCEPT WITH FIXES. Each fix has a test that failed before it.

1. **Email retries gave up too early** (`75a00cb`).
   - A notification is given up at once only when the server answers 5xx to MAIL FROM, RCPT TO or DATA.
   - Connection errors, timeouts, 4xx and TLS problems retry with backoff up to the 30-minute cap. A notification is given up after 24 hours.
   - A 535 AUTH failure pauses the queue and gives nothing up. The status reads "Email: sign-in failed — check AGENT_EMPIRE_SMTP_URL", and the queue resumes when sign-in works.
   - Status returns to "configured" after a later success. `lastFailedAt` stays.
   - Tests cover four cases:
     - offline for 20 minutes, then delivered, with the backoff reaching 30 minutes;
     - 535: nothing given up, a single paused retry, and both items resume once fixed;
     - 550 to RCPT TO: that item is given up and the next is sent;
     - the 24-hour cap.
2. **The HUD row was fragile at 1280** (`8a206c3`).
   - At 1440 px and below, Issues, PRs, Queue, Services and Invite are icon buttons that keep their count badges, `aria-label` and `title`.
   - At 1360 px and below, the gap, padding and badges are tighter.
   - The voice and share buttons' titles now follow their state.
   - `inbox-ui-check` now shows every conditional tool at once at 1280, 1440 and 1920: Mute (as in voice), Invite, Upgrade, Services count 3, Queue 12 and Inbox 12. It asserts one row with nothing clipped: 75 px spare at 1280 and 128 px at 1440.
   - Screenshots: `08-hud-all-tools-*`.

Re-run results:

| Check | Result |
| --- | --- |
| typecheck | clean |
| `npm test` | **653/653** |
| build | OK |
| `inbox-ui-check` | **47/47** |
| `mobile-ui-check` | **411/411** |

## Open issues
- **375x812 portrait:** the game asks you to rotate. The inbox layout was checked under the rotate prompt using DOM clicks.
- **Cloud mode:** the cloud-mode message was checked by marking the store as cloud in the running fixture, not with the cloud build.
- **Duplicate Telegram message:** a new plan produces both the existing job summary update and the new approval message.
- **Email transport:** email was verified against a local fake SMTP server only. A real provider needs its own acceptance run.
