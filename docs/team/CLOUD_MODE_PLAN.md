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

## Native bridge contract (one owner: interface lane)

The bundled game detects a shell by `window.AGENT_EMPIRE_APP.platform` (`'ios' | 'android' | 'desktop'`), injected before any page script runs. Calls are asynchronous request/response messages. Each request carries an `id`, and the shell answers through `window.__empireNative.resolve(id, result)` or `window.__empireNative.reject(id, message)`.

| Call | Meaning |
| --- | --- |
| `secure.get(key)` / `secure.set(key, value)` / `secure.delete(key)` | Keychain (iOS), Android Keystore-encrypted storage, or Electron safeStorage. Keys come from a fixed allowlist: `mode`, `server.host`, `server.token`, `server.deviceId`, `github.token`, `github.login`, `state.repo` |
| `github.deviceFlow({clientId, scopes})` | The native side runs GitHub's OAuth device flow. It shows the user code and opens `https://github.com/login/device` in the system browser, then polls. It returns `{token, login}` and never persists the token itself unless the page calls `secure.set` |
| `app.signedOut(reason)` | The page tells the shell to clear its session keys |
| `app.openExternal(url)` | Opens an `https` URL in the system browser, only after a user gesture |

Transport: iOS uses `webkit.messageHandlers.empire.postMessage`. Android uses a single `@JavascriptInterface` object that is exposed only to the bundled origin `https://appassets.androidplatform.net` and checks the origin on every call. Electron uses `contextBridge` through the preload script. Nothing else is exposed. Provider API keys pass through the page only during setup, on their way to sealed-box encryption. They are never given to `secure.set`.

APP-03 (iOS) and APP-04 (Android) keep the bundled game, secure storage and landscape full-screen. Their first screen becomes the CLOUD-03 mode choice. They gain a minimal native bridge (secure get/set/delete, GitHub device flow, sign-out) and expose nothing else.

### Desktop additions (APP-05 round 2)

| Item | Contract |
| --- | --- |
| Transport | `window.empireDesktop.postMessage(request)`, exposed by the Electron preload through `contextBridge`, only for the top frame of the app origin |
| Origin | `empire-app://game`, the same origin as the iOS app (already in the server's `APP_ORIGINS`) |
| `app.runLocal()` | Desktop only. No parameters from the page. The shell shows its native confirmation, starts the bundled server on loopback, signs in natively, stores `mode=local`, and resolves `{mode: 'local', host, token, deviceId}`. The page adopts that session (as in server mode, platform `desktop`) and opens the game without a reload. A rejection whose message starts with `cancelled:` means the player declined: the page stays on the mode choice quietly. Other rejections are shown. The page calls it with a long timeout (10 minutes) because the player reads a native dialog first. The page refuses an answer whose `host` is not a loopback origin |
| `AGENT_EMPIRE_APP.localAvailable` | Desktop only. When `true`, the setup's mode choice shows a third card, "Run on this computer" (full capabilities while the app is open; local workers stop when you quit; uses this computer's CLI agent logins). Phones and the web never show it |
| `mode: 'local'` | Accepted in the injected config and in secure storage on desktop only, and treated like server mode with a session. Without a session it returns to the mode choice |

## Execution defaults (owner decisions, 2026-10-02)

Automatic execution setup (the coordinator finds or creates the Anthropic agent and environment; [cloud-exec-setup](reports/cloud-exec-setup.md)) uses these defaults. All three can be changed under Cloud Empire → Limits.

| Decision | Default | How it is shown |
|---|---|---|
| Worker model | **Claude Sonnet 5** (`claude-sonnet-5`). Opus 5.5 (`claude-opus-5-5`) and Fable 5.1 (`claude-fable-5-1`) stay selectable. Each model gets its own agent, so changing the model never edits an agent a running session may use | Setup review ("Jobs run … with Claude Sonnet 5"), Limits (model select with list prices), Status once ready |
| Tool approval | **Always allow inside the sandbox** (the Managed Agents toolset default) | Setup review, Status and Limits: "approves its own tool use inside the sandbox" |
| Environment networking | **Unrestricted** (full outbound internet, minus Anthropic's safety blocklist) | Setup review, Status and Limits: "full internet access … can also fetch untrusted content … your keys never enter it". An existing environment named `agent-empire-worker` with other networking is reported, never silently reused |

Manually entered IDs (Limits → Use existing IDs) withdraw any automatic setup request. "Set up automatically" replaces the current settings once it finishes, and says so.

## GitHub Actions as the job sandbox (FREE-04, 2026-10-24)

A second provider adapter, `github-actions` (`src/cloud/actions-adapter.ts`), sits behind the same `ProviderAdapter`; `ProviderRouter` picks the adapter from `meta.execution.provider` and from the session id (`ghrun_<run id>` vs `sesn_…`), never from which keys exist. Each job is one `workflow_dispatch` run of the generated job workflow (`src/cloud/job-workflow.ts`) in the project repository. The money-safety rules are unchanged: the job is committed as `dispatching` with its reservation before the dispatch; a request that may have reached GitHub (network error, timeout, 5xx, or no run id returned) becomes `dispatch_uncertain` and is never retried; a 4xx proves no run started and requeues. A finished run is read through one small, schema-checked result artifact (`result.json`, at most 4 KB, from an artifact of at most 16 KB), and becomes `awaiting_review`; credits move only on accept. Free and Claude-subscription runs reserve no money (a zero-cent `run_caps` reservation still holds the slot) and record `costCents = 0` with the basis `free_run` or `claude_plan`; API-key runs record `engine_reported_estimate`, kept apart from observed costs in the ledger. See [reports/free-04.md](reports/free-04.md).
