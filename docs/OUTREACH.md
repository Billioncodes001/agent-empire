# Email outreach

Email outreach is the first channel of Jordan, the marketing & sales executive. Jordan is rule-based: it coordinates and never writes. A worker drafts each campaign. You approve the drafting job first, and later you approve the exact message and the full recipient list. Nothing is emailed before that second approval. Outreach runs on your own server; it isn't available in cloud mode, because the coordinator would need your SMTP password as an Actions secret, runs only every 15–60 minutes (no pacing or daily cap), and leads and opt-outs would stay in the state repository's git history. The marketing card says so in cloud mode.

## Your responsibilities

- **Lawful basis.** You are responsible for having a lawful basis to email each contact, under the rules that apply to you (for example CAN-SPAM, GDPR/PECR or CASL). Every lead records a `source` (where the address came from) and a `basis` (for example "existing customer", "inbound inquiry", "conference contact"). A lead without both is refused.
- **No scraping or buying.** The Empire never scrapes, guesses or buys addresses. Leads come only from your own CSV import. A worker may propose leads inside a draft, but a proposed lead is never emailed until you accept it.
- **Opt-outs.** The Empire doesn't read replies, because there is no IMAP. When someone replies STOP, add the address to the suppression list on the founder desk, or send `/optout name@example.com` to the Telegram bot. A suppressed address is never emailed again by any campaign, including one already sending.
- **Sender identity.** Every email ends with a fixed footer that the worker cannot change: your identity and postal address, the sender address, and "Reply STOP to stop receiving these emails".

## Settings

Set these on the execution host, then restart it.

| Variable | Meaning |
| --- | --- |
| `AGENT_EMPIRE_SMTP_URL` | The same SMTP server as email notifications (`smtps://user:pass@host:465` or `smtp://…:587` with STARTTLS). Required. |
| `AGENT_EMPIRE_OUTREACH_FROM` | The sender address, for example `hello@yourfirm.example`. Required. |
| `AGENT_EMPIRE_OUTREACH_ADDRESS` | Your sender identity and physical postal address, on one line (at most 300 characters). Required; printed in every footer. |
| `AGENT_EMPIRE_OUTREACH_NAME` | Optional sender display name. |
| `AGENT_EMPIRE_OUTREACH_DAILY_CAP` | Messages per UTC day across all campaigns, 1 to 10000. Default 200. |
| `AGENT_EMPIRE_OUTREACH_INTERVAL_SEC` | Seconds between messages, 2 to 3600. Default 10. |

Without the three required settings, sending is disabled and the founder desk says which one is missing. Drafts and leads still work. Error messages never show the SMTP URL or password.

## How a campaign runs

1. **Import leads** on the founder desk (`/consultancy.html#outreach`) or with `POST /api/outreach/leads/import {"csv": "…"}`. The header row must name `name,email,company,source,basis`; an optional `tags` column takes words separated by `;` or spaces. Each refused row is reported with its line and reason. Leads are kept in `leads.json`, de-duplicated by address. An address is trimmed, Unicode NFC-normalised and lowercased before it is stored or compared, and an address with control characters is refused. Plus-addressing (`ann+news@…`) counts as a different address from `ann@…`, so opt out each form a person uses.
2. **Brief a campaign** (New campaign). This creates an internal consultancy job with client "Internal" and an estimate. Approve it like any job, on the founder desk, in the game inbox or with Telegram.
3. **The worker drafts** one file, `docs/empire/campaigns/<jobId>.md`, with strict frontmatter:

   ```
   ---
   subject: One line, at most 150 characters
   audience: [customers]
   proposedLeads:
     - Name | email@example.com | Company | source | basis
   ---
   Plain-text body. Only {{name}} and {{company}} merge fields.
   ```

   `audience` lists lead tags, lead ids (`L3`) or `all`. When the task finishes with outcome done, the server reads the file from the worker's worktree, from its committed branch, or from the project folder for a task without a worktree. A missing, oversized (over 256 KB), symlinked or invalid file makes the item need attention, with the reason. Nothing is guessed. The imported draft is labelled "Drafted by <worker> — not verified".
4. **Jordan raises a campaign send** in the inbox (an `external_action` item). It shows the exact subject and body rendered for 2 recipients, footer included; every recipient; how many were excluded as suppressed, invalid or unconfirmed; the sender; and the pace and daily cap.
5. **You approve or decline.** Your decision is saved before anything is sent. Approving sends exactly that frozen snapshot. If anything changes before you decide (a new lead, an opt-out, a sender setting), the old item is resolved and a new one replaces it. Approving an out-of-date item is refused and sends nothing. No budget applies to a send. Telegram `/approve A7` and `/reject A7` work too.

## Sending

- Body lines may be at most 900 bytes; a longer line makes the draft need attention. A body with non-ASCII text or long lines is sent quoted-printable, so no server needs 8BITMIME. A literal `=?…?=` is refused in a draft subject and broken apart in merge values, so the preview matches what mail clients display.
- One message per recipient, with the recipient alone in `To`. There are never CC or BCC lists. Merge values lose line breaks and control characters, so a name or company can't add a header.
- At most one message per interval and the daily cap per UTC day. When the cap is reached, sending resumes after midnight UTC.
- Each recipient's result is saved in `outreach.json`: sent, refused, failed, suppressed or unknown.
  - **Refused:** the server answered 5xx to `RCPT TO` for that recipient. Only a mailbox error (550, 551, 553) adds the address to suppression as a bounce, and only once a later message is accepted, which shows the server itself is fine. Other codes, such as a 554 relay or policy refusal, never suppress anyone.
  - **Three refusals in a row** pause the campaign until you resume it. The refusals in that streak go back to pending, nobody is suppressed, and they are retried when you resume.
  - **The message itself refused** (a 5xx after the text, for example 552 for size or content): the campaign pauses, nobody is suppressed, and that recipient stays pending.
  - **Failed:** connection or 4xx problems before the message was sent, three times.
  - **Unknown:** the message text was sent but no final reply arrived, or the server stopped during a send. The server may have accepted it, so it is never re-sent automatically. Check before sending again.
- A send is recorded as in flight before it starts. After a restart, nobody already sent or in flight is emailed again.
- A sign-in failure or a refused sender address pauses the campaign with the reason. Five failed sends in a row also pause it.
- On the founder desk you can **pause**, **resume** or **cancel** a campaign. Cancelling never emails anyone not yet sent to.

Outreach email and approval notifications are separate. Notifications go only to `AGENT_EMPIRE_NOTIFY_EMAIL`, and their record is `email-notify.json`. Outreach goes only to approved recipients, from `AGENT_EMPIRE_OUTREACH_FROM`, and its record is `outreach.json`. City credits are never involved.

## API

All routes need you to be signed in. Changes also need a same-origin `Origin` header or a device bearer token.

- `GET /api/outreach`: status, leads, suppression and campaigns with counts.
- `POST /api/outreach/leads/import {csv}`, `POST /api/outreach/leads/:id/accept`, `POST /api/outreach/leads/:id/decline` (proposed leads only).
- `POST /api/outreach/suppression {email, reason: "opt_out" | "blocked"}`. Bounces come only from SMTP refusals.
- `POST /api/outreach/campaigns {requestId, title, brief}`.
- `POST /api/outreach/campaigns/:id/(pause|resume|cancel)`.

A corrupt `leads.json` or `outreach.json` is preserved and stops outreach until it is repaired.
