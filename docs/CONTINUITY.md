# One host, several devices

This describes the implemented single-host mode. The updated [first-time execution setup](EXECUTION_SETUP.md) makes it optional alongside Anthropic provider-hosted cloud tasks and local execution. A dedicated VPS is not a product requirement.

Agent Empire's first hosted architecture has **one owner and one running server per project**. Workers live on that host, not in the browser. Closing desktop, mobile or web clients does not cancel their processes. Turning off or restarting the host still interrupts jobs; recovery retains the process-safety rules in [RECOVERY.md](RECOVERY.md). This is not a distributed runner pool or a promise of exactly-once external side effects.

Use the same HTTPS host address on every device. The server's password authenticates this single-owner workspace and is equivalent to control of its agent terminals. Do not use it as a public, multi-tenant service. GitHub stores project code; it is not the always-on compute service.

## Reconnection

The server persists its identity and an ordered observation journal/checkpoint of city, worker and queue state. A new connection receives the current snapshot. The authenticated continuity feed returns ordered changes after a known revision or a replacement snapshot when that history is unavailable. Runtime status separately names the server run and reports persistence errors. Revisions observe work; replay never executes commands.

A disconnected client must show unknown/stale execution evidence. It must not fabricate job completion while offline. There is no offline command queue: rejoining refreshes state before further actions. Provider credentials, raw terminal output and authentication tokens are excluded from the continuity journal. Worker task text remains private project data; protect backups accordingly.

## Laptop files

Publish a worker after committing its work and stopping its process. A turn ending alone does not establish that the process stopped. Publication accepts only a clean managed worktree, pins its commit/base and creates an immutable, self-contained Git bundle. The authenticated manifest includes host identity, SHA-256 and size. Uncommitted changes stay on the host; ignored files, provider state and untracked secrets are not collected into a new commit by sync. Existing committed repository history is part of a full bundle, so do not commit secrets.

The local importer verifies host identity, bundle hash, reference, commit and base. The selected laptop repository must already contain the base commit. The importer keeps its own bare repository and detached review worktree under the project's Git common directory, in `agent-empire-sync/`. It never checks out, resets, stages, stashes or merges into the user's active tree. Its separate repository does not inherit the laptop repository's hooks or filters. Overlapping local paths are reported for manual review; this is not an automatic textual conflict resolver.

Receipts make repeated imports idempotent and preserve edits made in the review worktree. A changed/missing checkout, mismatched host or interrupted import lock is surfaced rather than overwritten. Inspect an interrupted import before removing its lock. Reconcile selected changes through a reviewed Git merge/cherry-pick when ready; no automatic merge is provided.

### Command line

Build the app, then run `node bin/agent-empire-sync.js --help`. Supply `AGENT_EMPIRE_SYNC_PASSWORD` through your shell/secret manager, not command arguments. The CLI holds the session cookie in memory and does not save credentials.

```sh
node bin/agent-empire-sync.js --server https://empire.example.com --repo /path/to/project
# Verify the displayed host identity, then repeat with:
node bin/agent-empire-sync.js --server https://empire.example.com --repo /path/to/project --trust-server HOST_ID
# Optionally publish one already stopped, clean worker and import published work:
node bin/agent-empire-sync.js --server https://empire.example.com --repo /path/to/project --publish WORKER_ID
```

Changing host identity requires deliberate review of the saved `host.json`; the tool never replaces an existing trust decision just because a command supplies another ID. Bundle downloads are capped at 128 MiB. Very large histories require a later incremental artifact design.

## Desktop

Install build dependencies with `npm ci --prefix desktop`, then `npm run desktop` or `npm run desktop:package`. Packaged output is in `release/` for the build machine's platform/architecture. This produces a development build; distribution signing/notarization and auto-update are separate work.

Connect to the same host as the browser and sign in. **File → Configure laptop synchronization** selects a repository and confirms the host identity. The app checks published work after sign-in on reopening. Optional periodic sync checks while the app is open. **Publish stopped worker work** explicitly publishes eligible work; **Synchronize published work** imports it; **Open sync inbox** opens the review worktrees. Remote content has no Node access or filesystem bridge. Voice/screen permissions are disabled in this first shell; use the browser for those features.

## Mobile and web

The same responsive client is delivered as an installable PWA. See its Connection settings for installation guidance. Mobile installability varies by browser; test Safari/Android on physical devices before release. Authenticated pages, API responses, city snapshots and terminals must never enter a service-worker cache. Offline navigation displays a public explanatory page, not a stale playable city.

Native Android and iOS HTTPS-host companion projects are now included; see [platform builds](PLATFORMS.md) for artifact availability and validation limits. Store publication, offline mobile city bundling, mobile background agent execution, multi-tenant accounts, browser-managed provider credentials, distributed job containers and cross-host failover remain outside this first hosted milestone. Mobile is a controller of the running host.

## Bundled local desktop and provider sessions

The desktop now also bundles a loopback server and world assets. This local mode ends when the app quits; it is different from connecting the shell to an independent VPS. The native launcher stores provider credentials using OS-backed encryption and starts local queues paused. Anthropic sessions already accepted continue in provider infrastructure after desktop exit, with a durable local task ledger for later polling. Their output import and city-save synchronization are not yet connected to the host bundle protocol above. See [execution setup](EXECUTION_SETUP.md).
