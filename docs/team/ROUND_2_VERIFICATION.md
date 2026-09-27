# Round 2 verification: continuity and devices

Date: 2026-09-27. Product candidate: `928710b` (subsequent documentation/report commits do not change it).

## Implemented and checked

- Codex backend: one-host durable identity and bounded ordered observation journal; authenticated snapshots/history; exclusive project ownership; immutable stopped-worker Git artifacts. Claude Opus 5.5 in VS Code: PWA/offline and connection UI. Coordinator: importer/CLI, Electron shell and deployment recipe. Grok 4.7 in VS Code: independent integrated review, recorded separately in `reports/round-2-review.md`.
- `npm run typecheck`, `npm test` (**108/108**), `npm run build`, and `git diff --check` passed. Tests use temporary repositories and fake processes; no paid provider task was started. Coverage includes clients closing while a queued process finishes, ordered reconnect/restart state, auth/origin checks, owner locks, publication integrity, storage failures, isolated imports and repeated-import conflict refresh.
- Authenticated disposable server on loopback 4614: browser and native desktop joined the same host. A clean stopped fixture worker was published, imported through the desktop menu and imported again through the CLI. Its result differed from an overlapping local edit. Both the active local file and Git status remained unchanged. Repeat desktop sync reported zero new worktrees and the still-current overlap.
- The macOS arm64 Electron app was packaged and launched. Closing/reopening retained its selected host and authenticated session. Remote content has no Node filesystem bridge; native menus own publication, directory selection and sync. The ZIP is a development build, not signed/notarized distribution.
- Browser Settings showed matching host identity, checkpoint/revision and connection receipt age. At 390 × 844 the page had no horizontal overflow (390px document; 358px settings dialog).
- Stopping only the disposable server changed the open connection panel to unknown/reconnecting. Reload showed the public offline page. Restarting the same disposable project and selecting Try again restored the same host identity, a new runtime identity and fresh revision. The original live port-4610 server, worker and save were not restarted or migrated.

- The final Linux amd64 Docker image built successfully (358,791,638 bytes). A disposable non-root container with a new Git volume and `/bin/false` as agent command passed health/login checks, rejected anonymous continuity access, served public manifest/service-worker resources, returned an authenticated empty artifact list, and retained its host identity and session across restart while changing runtime identity (revision 3 → 4). It was stopped after the test. Existing unrelated containers were untouched.

## Boundaries

This is one owner and one continuously running host per project. Observation checkpoints do not make separate operational files transactional. A stopped host interrupts agents; recovery is explicit and does not promise exactly-once external effects. History retains 128 observations and falls back to a snapshot. Git bundles contain full committed history and are capped at 128 MiB; publication excludes dirty/running workers, shallow repositories, submodules and LFS pointers. Import does not merge; review worktree edits survive repeat sync. Manual diagnosis is required for an interrupted import/startup gate.

Physical iOS/Android installation, native mobile store packages, signed desktop releases, Windows/Linux desktop packaging, live paid-provider completion, public HTTPS deployment, backup restoration on a VPS and multi-tenant/distributed operation have not been verified. No Agent Empire production host has been deployed. The user has ruled out the existing Vantage VM. The subsequent execution design makes VPS hosting optional alongside provider-hosted and local modes; no purchase is planned by default. See `../EXECUTION_SETUP.md` for the next implementation boundary. No production routing, credentials, provider jobs or live save were changed.

The existing application password remains a single-owner trust boundary, not role-based accounts. Provider credentials stay on the host. Mobile/web clients control host processes; closing them cannot keep a stopped host running. The PWA caches only public offline assets, not authenticated pages, APIs or terminal output. Existing character/preferences storage is separate from that cache.

Screenshots and the macOS ZIP are local ignored artifacts in the main checkout's `artifacts/` directory. They are not committed to source control.
