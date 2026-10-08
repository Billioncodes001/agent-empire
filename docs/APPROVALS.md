# CEO approval inbox

The approval inbox collects every decision that waits for you, the CEO. It runs on your own server. It isn't available in cloud mode yet, and the game says so.

## What lands in the inbox

| Kind | Raised by | When | Approving does | Declining does |
| --- | --- | --- | --- | --- |
| `job_plan` (Client plan) | Alex · Chief of staff | A client plan is saved and waits for approval | The same approval as the founder desk: the plan goes to the task queue with the budget you set (default: the top of the estimate, rounded up) | Declines the plan; nothing from it starts |
| `budget_increase` (Budget increase) | Priya · Finance | A job's provider spend reached its approved budget, so its unstarted items are held | Raises the job's budget to the amount you choose and releases the held items | Records your decision; the job stays held |

Both executives are rule-based. They compute everything from the real consultancy jobs, the queue and provider-reported usage. No model is called.

The default for a budget increase is the spend so far plus the top of the estimate for the work not yet done, rounded up to whole dollars. A new budget must exceed both the spend so far and the current budget, and it is at most $100,000.

## Where you can decide

- **In the game.** Walk up to the founder's desk in the HQ loft. The brass inbox tray on it shows the pending count, and its paper stack grows with it. Stand beside the CEO chair and press **E**. The HUD also shows an **Inbox** badge with the count whenever something is waiting, and the chief of staff's and finance's executive cards have an **Open inbox** link. Approving asks you to confirm first, with the amount spelled out.
- **On the founder desk page** (`/consultancy.html`). Approving or declining a plan there resolves its inbox item.
- **In Telegram**, using the owner-only bot:
  - `/approvals` lists what's pending.
  - `/approve ID [budget]` and `/reject ID` work for every kind.
  - Inbox ids look like `A3`. Consultancy job ids (`consultancy-…`) still work for plans and resolve the matching inbox item. The two kinds of id never collide.

Decisions are idempotent. Deciding an item that is already decided returns the existing decision and changes nothing, whichever surface you use. Consultancy stays the source of truth for plans and budgets, so no plan is decided twice.

## Notifications

- **Telegram:** each new pending item sends one message. Items already pending when the bot first starts are a silent baseline, the same rule the job summary uses. Announced ids are remembered in `telegram.json`.
- **Email (optional):** each new pending item sends one plain-text email, as a notification only. It carries the title, kind, estimate or spend, and "Approve in the game, on the founder desk, or with /approve ID in Telegram." There is no link and no secret, and nothing can be approved from an email.

| Variable | Meaning |
| --- | --- |
| `AGENT_EMPIRE_SMTP_URL` | `smtps://user:pass@host:465` (implicit TLS) or `smtp://user:pass@host:587` (STARTTLS). URL-encode `@` in the user name as `%40`. |
| `AGENT_EMPIRE_NOTIFY_EMAIL` | The one address that receives notifications. |
| `AGENT_EMPIRE_NOTIFY_FROM` | Optional sender. It defaults to the SMTP user when that is an address, otherwise to the recipient. |

Set both of the first two, or neither. The built-in SMTP client has no dependency:

- It supports EHLO, STARTTLS, and AUTH PLAIN or LOGIN.
- It never sends credentials over an unencrypted connection, except to this machine (localhost).
- Each step has a timeout.
- The URL and password are never logged.

Failures are logged with the approval id and the SMTP status code only. The send is retried with backoff (5 s, 30 s, 2 min, 10 min, then every 30 min) and never blocks the server. Sent ids are remembered in `email-notify.json`, so a restart never mails twice. As with Telegram, what was pending when email was first set up is not mailed.

The founder desk page and `GET /api/consultancy/status` (`email.label`) show one of: "Email: not configured", "Email: configured" or "Email: last send failed".

## API

All routes need you to be signed in, like the other `/api` routes. Decisions also need a same-origin `Origin` header, or a device bearer token.

- `GET /api/approvals` returns `{ schemaVersion: 1, revision, items, pending, storageError? }`. Pending items come first, then recent decisions.
- `POST /api/approvals/:id/approve` takes an optional body `{ "budgetUsd": 25, "requestId": "…" }`. `budgetUsd` must be a finite number above 0 and at most 100000.
- `POST /api/approvals/:id/reject`

Each decision returns the item. The WebSocket `welcome` carries `approvals`, and an `approvals` message is sent whenever an item is raised or decided, and only then.

## Storage

The inbox is kept in `approvals.json` in the data directory, written atomically. Items are reconciled from `consultancy.json`, so they never drift:

- A plan approved from Telegram resolves here.
- A data directory from before the inbox gets items for its pending plans and current holds on first start.
- A corrupt `approvals.json` is preserved, not overwritten. Decisions are refused until it is repaired.
