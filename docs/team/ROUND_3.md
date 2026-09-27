# Round 3: optional provider cloud and bundled desktop

Baseline: dd5a935. User approved implementation of provider-owned execution with local/VPS alternatives. Vantage is excluded; no infrastructure purchases. Preserve the live 4610 process, Pixel worker, dist and save.

- Codex backend: reference-only execution config, durable task intent/reservations, Anthropic Managed Agents transport, conservative reconciliation and explicit stop/archive. Fake transport coverage; no real credentials or paid calls.
- Claude Opus 5.5 in VS Code: first-use execution offer, mode/repository/environment/budget setup, read-only check, separate cloud task panel and explicit paid confirmation. Pending IDs persist before dispatch, scope to host/repository/agent identity, and retain ambiguous submissions.
- Coordinator: bundled desktop server/assets, OS-encrypted credential vault, launcher and authenticated HTTP integration, worker gates, integration QA, documentation and packaging. Paid confirmation snapshot, native confirmation replacement and host-change guard reviewed during integration.
- Grok 4.7 in VS Code: independent review. Its initial queue-preference finding was fixed with a transient launch pause that preserves saved concurrency. A regression proves setup does not arm pending founding work.

## Evidence

All automated tests use temporary repositories, fake transports/workers or local fixtures. No real provider execution has been validated. Native Electron's bundled PTY module loaded and launched a harmless local shell fixture successfully.

Packaged macOS arm64 app opened a new empty Git project at `/tmp/agent-empire-desktop-qa.IYYk2N`, rendered the bundled city and founder model, and queued the chief-of-staff brief without launching a worker. Quitting stopped its loopback server. Reopening restored the same 127.0.0.1:60500 origin, founder and queued task. No remote Agent Empire host was required for that city.

A separate port-4617 fixture intercepts every GitHub/Anthropic request. Browser QA saved setup and ran read-only checks with zero sessions, then reviewed repository/token-sharing/budget/task details and explicitly submitted one fake session. The UI showed Running, then Idle with outputs unverified. The packaged desktop connected to this same fixture, recovered the same task and confirmed Stop, which archived it and removed the Stop action. Screenshots are in ignored main-checkout artifacts/round3-*.png.

The in-app browser stalled on a native window.confirm during QA. The product now uses its own accessible modal for Stop/Forget; the revised stop flow passed in the native desktop. A fresh 390px test could not complete while that browser dialog remained stalled, so this round does not claim mobile UI verification. Existing responsive CSS remains; physical mobile and browser deployment tests are pending.

## Delivery boundary

This is an unsigned development app and first Anthropic adapter. Users need supported Claude Platform API access, pre-created single-agent/environment references and a repository-scoped GitHub token. No embedded provider account OAuth or automatic resource provisioning. OpenAI/GitHub workflow adapters remain disabled. Provider outputs/PRs are unverified and are not yet imported through the existing host Git-bundle synchronizer. Cloud tasks are not yet mapped to civic workers or rewards. Cross-device city-save storage, a standalone web credential service and native mobile packages remain pending. Local queued agents need explicit concurrency after setup; provider budgets are not exact/account-wide billing caps.

Final combined automated validation: `npm run typecheck`, `npm test` (138/138), `npm run desktop:package`, and `git diff --check`. Provider timestamp regression confirms `updatedAt` is the latest check time; UI labels it separately from submission age.
