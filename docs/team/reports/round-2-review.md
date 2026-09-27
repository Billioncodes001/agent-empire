# Round 2 review

Reviewed candidate: `928710b09d9842b4f5d391eecbd441b99e188f86` on `codex/team-review`.

Final correction on combined candidate `b6d663cc5b260223648ce577c65e978fe94165ee`. That candidate already contained backend `27589ca`, interface PWA `ea831c9`, shared contract `8d22dfb`, importer `3092eed`, and the two earlier importer fixes in `b6d663c`. `928710b` only refreshes repeated-sync conflict reports, stops lock cleanup from masking an import error, narrows two connection/offline sentences, and lets the disposable continuity fixture resume its own temp root.

## Result

No remaining confirmed finding. The stale repeated-import conflict count is closed on this candidate. Rejecting a bundle whose only head is not `HEAD` is the frozen contract, not a defect.

## Closed

A second import of the same artifact returned the first receipt’s conflict list. A laptop edit made after that import was not counted, so an explicit sync dialog could report no overlap while the review worktree and the dirty laptop file still shared a path. The checkout was not overwritten; the warning was stale.

`928710b` recomputes the current laptop overlap on reuse and returns it without writing a new checkout or changing the saved receipt’s worktree. The desktop dialog adds those counts for both new and reused receipts. Evidence: [src/server/device-sync.ts](../../../src/server/device-sync.ts#L74), [desktop/main.cjs](../../../desktop/main.cjs#L23). Covered by `repeat imports recompute overlaps after later laptop edits`.

Lock removal is now best-effort, so a failed `unlink` does not replace the import result. The offline page and connected-host sentence no longer claim that nothing from the office is stored, or that an open socket means live updates are arriving. The fixture resume path only accepts a disposable `empire-continuity-preview-*` directory under the system temp dir.

## Scope checked

Publishing requires a confirmed stopped worker with its own worktree, holds `publishing` until export returns, and refuses resume, removal, pull-request, and change operations while that flag is set. The artifact route is authenticated, POST requires a same-origin `Origin`, and export rechecks a clean self-contained `HEAD` bundle before the immutable directory is published. Incomplete temp exports are not listed. Evidence: [src/server/workers.ts](../../../src/server/workers.ts#L318), [src/server/server.ts](../../../src/server/server.ts#L421), [src/server/sync-artifacts.ts](../../../src/server/sync-artifacts.ts#L68).

The host lock is a local startup gate plus a PID/host owner file, not a distributed lease. The continuity journal keeps the last saved revision when a checkpoint write fails and does not mint a new host id on restart.

The service worker precaches only the public offline page and icon, with credentials omitted. Its fetch handler does not cache navigations, API responses, or other requests. Evidence: [src/client/public/sw.js](../../../src/client/public/sw.js#L23).

The importer still verifies size and hash before checkout, pins host identity before trust is stored, and checks out only under the isolated sync directory. Desktop remote content has no Node integration and no preload. Native menus perform explicit sync and publish.

## Checks

- `git rev-parse HEAD` was `928710b09d9842b4f5d391eecbd441b99e188f86`; worktree clean before this report. `a7c53d6` is an ancestor.
- Inspected `928710b` and the artifact, reservation, host-lock, journal, service-worker, importer, and desktop paths named above. Did not rerun the baseline audit.
- `npx tsx --test tests/device-sync.test.ts`: 8 passed, 0 failed. Includes dirty-tree preservation, trust refusal, hook non-execution, and the new repeated-overlap case.

## Coordinator evidence, not repeated here

Coordinator reports the full 108 tests, typecheck, and build passed. Coordinator also reports a desktop session on temporary server port 4614: signed in, published one stopped clean worker, imported into a temp laptop repo with a dirty overlapping file, reported the overlap, and left the original file unchanged. A second CLI import was idempotent. Coordinator additionally reports a browser outage showed unknown host status and the public offline page, then a restart kept the same host id with a new run id and a fresh revision. This review did not run those browser, desktop, full-suite, typecheck, or build checks, and did not touch port 4610, port 4614, or a live `.agent-office`.
