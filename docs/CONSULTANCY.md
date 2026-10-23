# Run the consultancy

Open **Settings → App & connection → Open founder desk**, or `/consultancy.html` on the same office host. The founder desk is a lightweight page: the 3D city does not need to be open.

1. Choose **New client job**, enter the client, title and desired outcome, then review the brief.
2. Save it for approval. Saving alone does not start a worker.
3. Open the job, inspect every work item and choose **Approve & queue**. Provider use may be billed under the host's existing execution configuration. The current chief is a deterministic coordinator; the initial form makes one work item from the brief.
4. Track queued, running, attention and review states. A worker finishing a turn does not prove the requested outcome is complete. Review the actual changes/PR before delivering them to a client.

All jobs currently execute against this office host's repository. Different client labels organize work but do not create security boundaries or independent repositories. Approved tasks retain the existing funded-workstation, concurrency, budget and execution-mode gates. Provider-cloud mode holds this local queue; it does not silently launch another provider. Resource recommendations, automatic workstation purchases and model-authored multi-agent plans are later milestones.

## Telegram

The bridge is optional and disabled without explicit host configuration. Create a bot using Telegram's official **@BotFather**, then use the numeric Telegram account ID of the CEO as the owner allowlist. Keep the bot token in the host's secret environment, never in source control or a chat transcript.

Set these variables in the environment that launches the office server, then restart that server:

- `AGENT_EMPIRE_TELEGRAM_TOKEN`: the bot token from BotFather.
- `AGENT_EMPIRE_TELEGRAM_OWNER_ID`: the CEO's positive numeric Telegram user ID.

Use a dedicated bot for one execution host. Another polling service or a webhook on the same bot can prevent polling. The status on the founder desk distinguishes unconfigured, awaiting first connection and a successful poll. Configuration is currently through the host environment; an in-app credential setup wizard is not implemented.

Send the bot `/start` from the allowlisted account in a private chat. Supported commands:

| Command | Action |
| --- | --- |
| `/new Client \| Job title \| Brief` | Save a client job for approval |
| `/jobs` | List recent client jobs and states |
| `/job ID` | Inspect a brief; review full multi-item plans in the founder desk |
| `/approve ID` | Approve the immutable plan and queue its work |
| `/reject ID` | Decline a plan that has not started |
| `/status` | Current capacity and rule-based chief summary |
| `/help` | Command help |

Only the configured owner in their private chat can issue commands. Delayed commands older than ten minutes are rejected with a request to resend. The bridge remembers the Telegram cursor and sends compact updates when job states change. Unsolicited updates contain job identity, client/title and status, not worker terminal output or full prompts. Command replies can include a requested brief. Outbound delivery is at-least-once: a crash after sending a response but before saving its cursor can repeat the message; the domain command must remain idempotent. This is not a claim of exactly-once Telegram delivery.

## Approval inbox and email

Plans waiting for approval and budget increases for held jobs also appear in the CEO approval inbox: in the game at the founder's desk, through `/approvals` in Telegram, and optionally by email (`AGENT_EMPIRE_SMTP_URL`, `AGENT_EMPIRE_NOTIFY_EMAIL`). Approving in any of them is the same consultancy decision. See [APPROVALS.md](APPROVALS.md).

## Persistence and availability

`consultancy.json` holds durable jobs, decisions and queue identity evidence. `telegram.json` holds the bot/owner binding hash, update cursor and latest notification fingerprint; it contains no bot token. Existing city, worker and queue saves remain authoritative. Invalid storage fails closed instead of silently resetting or replaying work.

Closing the founder desk or 3D browser view does not stop a running host. Quitting the packaged desktop app stops its local server; powering off that laptop also stops its coordinator and Telegram bridge. Always-on coordination requires a host that remains running. Existing provider-managed tasks can have a separate lifecycle; they are not yet unified into consultancy jobs.

## Validation

Automated tests use fake workers and Telegram transport: no customer messages, provider charges or live city changes. A real configured bot, speech conversations, automatic expansion and cross-device deployments require their own acceptance checks. See `docs/team/CONSULTANCY_PLAN.md` for the next phases.

Protocol reference: [Telegram Bot API](https://core.telegram.org/bots/api).

## Server mode only

The founder desk, client jobs, estimates, the approval inbox, Telegram, email outreach and the research executive run on an office server (server mode). Cloud mode — the Empire in your own GitHub state repository — has cloud jobs you submit from the game with explicit paid confirmation, and in-app shut down and start, but no founder desk, consultancy journal, Telegram bridge or outreach. Its city economy follows the same rules (see [economy](ECONOMY.md#server-mode-and-cloud-mode)).
