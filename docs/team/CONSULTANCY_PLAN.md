# Persistent consultancy operation

User direction recorded before implementation, 2026-09-27. This takes priority over the next visual-only city slice; the city roadmap remains in scope.

The CEO brings overlapping jobs for multiple clients. The chief of staff tracks each brief, proposes a plan, seats workers at funded desks, requests decisions, reports progress and preserves state independently of an open game window. Telegram and the game must operate on the same authoritative records. Reopening the game reads current workers/workstations rather than recreating them from animations.

## Delivery sequence

1. **CONSULT-01: persistent job intake and controlled dispatch.** Client label, title, brief, immutable approved work items, explicit approval/rejection, stable job/task identities, queued/running/attention/review states and restart reconciliation. Initially reuse the existing single-repository local worker queue and its provider-budget/concurrency/workstation controls. No automatic cloud/local fallback. Queue completion means awaiting review, not verified client delivery. Expose authenticated HTTP API and a truthful chief summary; prove headless operation with fake workers and no game clients. A client label is not repository or tenant isolation.
2. **CONSULT-02: Telegram command adapter.** Private-chat owner allowlist, server-only bot token, durable update cursor and idempotent commands. Commands for intake, jobs, status and approvals share CONSULT-01. Send meaningful state-change summaries without raw prompts/secrets. No Telegram connection until the owner configures the bot; use a fake transport in tests. Polling requires a running host. Bot messages must never become shell commands.
3. **CONSULT-03: CEO interface and phone.** Easy client-job intake, reviewable chief plan and resource requests, approvals, job outcomes and live worker locations. Match the standing design standard. Web, desktop and mobile use the same API; the founder phone is another view.
4. **CONSULT-04: managed scaling and real planning.** Model-backed chief decomposes briefs and coordinates role-specific workers, dependencies, review and regrouping. Use a bounded action protocol, execution evidence, durable assignments and configurable spending/workstation limits. Approvals cover plan changes, cost/capacity increases and consequential external actions. Revalidate cost and available funds when applying an approved expansion. Cloud jobs and provider outputs must use their existing durable execution service. Hosting and provider capabilities remain explicit.
5. **CONSULT-05: employee life and organizational memory.** Persistent identities, skills and job assignments; coffee, breaks, desk meetings and gym trips visualize actual scheduling states. Never let an animation manufacture progress or waste paid tokens. Store reviewed project lessons and provenance; do not claim autonomous model training or unrestricted self-modification. Cross-client information stays scoped. Learn from accepted outcomes and failed approaches through reviewable memory.

## Current milestone boundaries

CONSULT-01/02 implement a deterministic chief workflow, not an autonomous reasoning chief. Work continues without a connected game while its execution host remains running. A powered-off laptop cannot host the coordinator or Telegram poller; provider-owned tasks may continue separately. No deployment, paid worker test, live city mutation or credential collection in chat is needed to build and test the service.

Protect localhost:4610, Pixel, live dist and saves. Independent author worktrees have one owner each. Review exact candidate code, then integrate. New gameplay/voice/city work remains planned until implemented and validated.
