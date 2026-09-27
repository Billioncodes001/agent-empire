# First-time setup and execution choices

Product decision, 2026-09-27: a VPS is optional. Users bring their own supported provider account/API access and choose where jobs execute. Do not purchase infrastructure by default. Vantage is excluded from all Agent Empire hosting. This document defines the next implementation; the current runtime still connects to a single running Agent Empire host.

## Setup flow

1. Create the character and choose the founding buildings. Keep existing defaults and funded-workstation rules. Allow exploring the locally installed world before connecting a provider; pending AI work must stay visibly pending.
2. Connect GitHub and select specific repositories. Explain branch/PR permissions and keep changes separate from the default branch until reviewed.
3. Connect one or more AI providers. Present official browser sign-in only where the integration supports it; otherwise offer a provider API credential through protected desktop/server storage. Never request the user's account password, reuse another application's session cookies, or assume subscription login grants general API access.
4. Choose execution: provider-hosted cloud sessions (target default), supported GitHub task workflows, this computer, or the user's own Agent Empire VPS. Validate the provider/account/environment combination before enabling jobs. API model access alone is not proof of a hosted executor.
5. Set real-money controls: maximum concurrent jobs, per-job allowance, daily allowance, time limits and action approvals. Label estimates and provider-enforced limits separately. In-game worker capacity and credits must never imply unlimited real compute or pay API charges.
6. Show a review of the repository, provider, execution location, billing owner, permissions and closure behavior. Connection checks must not silently start a paid task. Submit a user-authorized test only with its explicit cost boundary.

Local execution continues only while the local runner remains active and awake. Provider-hosted and VPS tasks continue independently of the game client, subject to service limits, approvals and failures. Keep the mode selectable later, without implying an active process can migrate between hosts.

## Provider capabilities checked

- Anthropic: Claude Managed Agents (beta) provides managed cloud sandboxes, autonomous tool execution and persisted sessions/events. It uses Claude Platform access. This is distinct from a plain Messages API request and from a Claude consumer subscription. [Overview](https://platform.claude.com/docs/en/managed-agents/overview), [quickstart](https://platform.claude.com/docs/en/managed-agents/quickstart).
- OpenAI: Agents API exposes a managed Codex harness with session orchestration/recovery and a choice of execution environment, including OpenAI-hosted sandboxes. Model, tool and sandbox usage are billed separately according to API pricing. [Overview](https://developers.openai.com/api/docs/guides/agents-api/overview).
- Codex product login: official Codex clients support ChatGPT subscription sign-in and API-key authentication for local work; Codex cloud requires ChatGPT sign-in. This does not establish an embeddable third-party OAuth flow for Agent Empire. Do not present one until documented integration support is verified. [Authentication](https://learn.chatgpt.com/docs/auth).
- GitHub: Copilot cloud agent and Actions-backed agentic workflows are possible task executors, subject to account access, permissions and usage limits. Agentic Workflows is in public preview. [Cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent), [workflows](https://docs.github.com/en/copilot/concepts/agents/about-github-agentic-workflows).

These are supported product surfaces to evaluate, not completed Agent Empire adapters or a guarantee of access on every user account. Recheck availability and authentication before implementing each adapter. A provider login/API key never means unlimited agents, unlimited tokens or unlimited runtime.

## Task and synchronization contract

Create and persist a stable logical task ID before dispatch; record executor, provider session ID, source commit, branch, event cursor and cost evidence. Model states must distinguish queued, dispatch uncertain, running, waiting for approval, completed, failed and cancelled. Never retry an uncertain dispatch blindly: reconcile with provider state or require a decision when the provider offers no idempotent creation. Switching providers must not duplicate an active task.

Dispatch when the user assigns work, not on an app-close callback. Desktop crashes, lost connectivity and phone suspension must not lose already accepted jobs. An offline assignment can be saved locally as not submitted; dispatch only after reconnection under the selected approval policy.

On reconnect, fetch provider events and GitHub results from the last acknowledged cursor, update reports from evidence and reconcile task IDs before applying rewards. Cloud jobs must use their own execution credentials; no required tool may depend on the closed desktop app remaining reachable. Persist outputs to the authorized branch/PR and recoverable artifact store before disposing of a sandbox. Provider retention, account limits and approval pauses remain visible.

Reuse the existing hash-verified isolated importer where its artifact contract applies. GitHub branches and provider artifacts need adapters rather than pretending to be the existing host endpoint. Preserve dirty local files and require review before merging. Resolve city-save conflicts separately from repository code; choose and implement a durable cross-device save service instead of assuming GitHub source history stores all game state.

## Offline and credential boundary

Desktop must package the game assets and local simulation/save support. The existing Electron remote-page shell and public-offline PWA do not yet provide that full offline experience. Web/mobile assets may be cached independently, but provider keys, private terminal content and authenticated API responses must not enter public/offline caches.

Desktop credentials belong in the OS credential store; VPS credentials belong in its protected secret store. Web/mobile need a supported short-lived authorization flow or a managed backend with protected credential storage. Such a backend can be serverless and does not require buying a VPS, but is still infrastructure we must implement. Do not copy raw API keys into browser localStorage, Git, game saves, logs or synchronization artifacts.

Provider-hosted execution should be the initial adapter milestone. Retain the existing single-host/VPS transport as an optional path and local execution for users who prefer it. No new provider session, account connection, infrastructure purchase or credential migration is authorized merely by saving these setup preferences.
