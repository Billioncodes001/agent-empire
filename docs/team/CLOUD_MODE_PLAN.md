# Cloud mode: the Empire lives in the user's GitHub

User decision recorded before implementation, 2026-09-30. This extends [EXECUTION_SETUP.md](../EXECUTION_SETUP.md), [CONTINUITY.md](../CONTINUITY.md) and [OFFICE_LIFE_AND_MOBILE_PLAN.md](OFFICE_LIFE_AND_MOBILE_PLAN.md). Items are planned unless marked verified.

## What the user asked for

First launch on any platform (iOS, Android, macOS, Windows, web) sets up the Empire. The user either links cloud accounts or connects their own server:

- **Link cloud accounts.** GitHub, plus Claude and/or OpenAI API access. The Empire then runs through provider cloud execution, with some capabilities limited.
- **Connect own server.** A server with the libraries and dependencies installed gives full capabilities.

In both modes the Empire keeps working when the app is closed. Reopening loads the Empire's current state, unless the user explicitly shut the Empire down in the app.

This correction supersedes the "server address first" connect screen from APP-03 ([ios-app.md](reports/ios-app.md)). That screen implemented `OFFICE_LIFE_AND_MOBILE_PLAN.md:66`, which wrongly carried over the old "mobile is a controller of a running host" framing (`PLATFORMS.md:35`, `CONTINUITY.md:47`).

## Decision

For users without a server, the Empire's always-on brain lives in **the user's own GitHub**. The options put to the user were the user's GitHub, the user's Cloudflare account, a hosted SaaS, or server/desktop only. The user chose GitHub. Agent Empire operates no infrastructure and never receives provider keys.

| Piece | Where it lives |
|---|---|
| Empire state (city, economy, ledger, jobs, continuity journal, approvals) | A private **state repository** in the user's GitHub account, e.g. `<user>/agent-empire-state`. It holds versioned JSON files written only by the coordinator; clients write only *intents* |
| Always-on coordinator | A scheduled **GitHub Actions workflow** in the state repository. It runs on a cron (every 5–15 minutes), on `workflow_dispatch`, and on `repository_dispatch` sent by the apps for faster reaction. A `concurrency` group ensures one run at a time. It uses the repository's own `GITHUB_TOKEN`, scoped to that repository |
| Agent work | Provider cloud sessions: Anthropic Managed Agents (adapter exists: `src/server/providers/anthropic-managed.ts`) and OpenAI Agents API (adapter to build). They work on the user-selected project repositories through the user's credentials |
| Provider API keys | **Encrypted GitHub Actions secrets** in the state repository. The client encrypts each value to the repository's public key with a libsodium sealed box before upload. Keys never pass through Agent Empire servers and are never stored on the phone after setup |
| GitHub sign-in | The GitHub **OAuth device flow**. GitHub's token endpoints send no CORS headers, so each native shell performs it: iOS URLSession, Android HttpURLConnection, Electron main process. The resulting user token is kept in the Keychain, Keystore or OS credential store. The web build falls back to a pasted fine-grained token. A GitHub OAuth App (client id) must be registered by the owner |
| Clients | They read state through `api.github.com` (which allows CORS). They write intents (new job, approval, shutdown) either as commits to `intents/` or as `repository_dispatch` events. They poll for changes |

**Limits of cloud mode, to be shown to the user:**
- It reacts in minutes rather than seconds.
- It uses the user's Actions minutes and provider usage.
- There are no live worker terminals or service tunnels, and no local CLI agents.
- Voice and screen share are limited.

A connected server keeps full capabilities.

**Shutdown:** "Shut down Empire" writes a shutdown intent. The coordinator then archives or interrupts provider sessions, records the state and disables the workflow. "Start Empire" re-enables it. Time while shut down earns no catch-up revenue (`ECONOMY.md:19`).

## Invariants

- **No live status from stale data.** State shown in the app is the last committed snapshot, with its age. Nothing is shown as live unless the coordinator recorded it.
- **No silent spending.** Setup never starts a paid task. Spending limits (concurrency, per-job, daily) are enforced by the coordinator before it dispatches anything.
- **Least privilege.** The state repository is private. Project repositories are selected explicitly. Changes go to branches and PRs, never straight to the default branch.
- **No subscription sign-in.** Claude and ChatGPT subscription sign-in is not offered; there is no documented third-party flow (`EXECUTION_SETUP.md:20`). API keys only.

## Slices

| ID | Slice | Owner | Acceptance |
| --- | --- | --- | --- |
| CLOUD-01 | State repository schema, and a coordinator core runnable headless in Actions | Backend | Versioned JSON schema with migrations. A deterministic tick (read intents → apply limits → dispatch/poll provider sessions → record results → commit) is unit-tested with fake providers and a fake GitHub |
| CLOUD-02 | Actions workflow and installer | Backend | Workflow file with cron, dispatch and concurrency. The installer creates the private state repository, uploads encrypted secrets and commits the workflow. Tested against a fake GitHub API, then one owner-approved real run |
| CLOUD-03 | First-launch setup in the shared client | Interface | Mode choice, then either the cloud path (GitHub device sign-in via the native bridge, repository selection, provider keys → sealed-box secrets, limits, review) or the server path (address and password, as in APP-03). Works in the iOS, Android and desktop shells; the web build uses a token fallback |
| CLOUD-04 | Client cloud adapter | Interface + Backend | The game store is fed from state-repository snapshots, and intents are written back. The HUD shows snapshot age and cloud-mode limits. Relaunch loads current state |
| CLOUD-05 | Shutdown and start | Backend + Interface | Explicit in-app control with a confirmation. Sessions are archived, the workflow disabled and the state recorded. Restart resumes |
| CLOUD-06 | OpenAI Agents adapter | Backend | Adapter behind the same interface as the Anthropic one, tested with fake transports |

APP-03 (iOS) and APP-04 (Android) keep the bundled game, secure storage and landscape full-screen. Their first screen becomes the CLOUD-03 mode choice. They gain a minimal native bridge (secure get/set/delete, GitHub device flow, sign-out) and expose nothing else.
