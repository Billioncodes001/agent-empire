# Round 4 review

Reviewed candidate: `5127bd77578ddf01f4da5a1c0c82276f8c4b6ef3` on `codex/team-review`.

No concrete blocker. No remaining confirmed camera or furnishing finding. The reception worktop mismatch is closed on this candidate.

Camera was accepted at `549615e`. Furnishing was reviewed from `913a2f5`. `5127bd7` adds the missing worktop footprint. Device-build files that arrived in the same fast-forward, including `25d1c5a` and `ffc282d`, are outside this review and were not inspected. Runtime limits recorded for those builds are not findings here.

## Camera

No confirmed issue. A held on-foot chord captures camera yaw only when the chord changes, so automatic recentering does not steer the player. `followPending` stays set until the heading error is gone, including after a brief arrow release. Drag cancels that pending follow and holds manual orbit; district overview does not auto-follow. Switching first and third person sets camera yaw from the current facing and does not turn a vehicle. The shoulder camera eases, then pulls in on that same frame if a collider is in the way. Opening a modal clears held movement and ignores pointer orbit. The top-bar button is visible and its label tracks the current view. Evidence: [src/client/player.ts](../../../src/client/player.ts#L263), [src/client/player.ts](../../../src/client/player.ts#L166), [src/client/player.ts](../../../src/client/player.ts#L360), [src/client/main.ts](../../../src/client/main.ts#L213), [src/client/index.html](../../../src/client/index.html#L36).

## Closed

At `913a2f5` the receptionist's lower work surface was visible and had no walk footprint. The counter collider did not cover that west surface, so a walker could pass through the desktop. The mesh is 0.5 by `length - 0.2`, centered at `y = 0.74` with thickness 0.04, so its visible top is 0.76.

`5127bd7` adds a footprint with that same center, width, and depth, and with top 0.76. It is copied into the office collider list before the elevation snapshot, so a floor change lifts it with the mesh. The existing clearance tests include every furnishing footprint, and this one does not enter the desk, door, stair, elevator, or board zones. Evidence: [src/client/world/furnishing.ts](../../../src/client/world/furnishing.ts#L76), [src/client/world/furnishing-layout.ts](../../../src/client/world/furnishing-layout.ts#L34), [src/client/world/office.ts](../../../src/client/world/office.ts#L513).

## Scope checked

Funded desk count and `setFloor` capacity are unchanged. Accessories are meshes inside the existing desk groups; they do not add seats or interactions. Evidence: [src/client/world/office.ts](../../../src/client/world/office.ts#L575), [src/client/world/furnishing.ts](../../../src/client/world/furnishing.ts#L168).

Meeting, reception, kitchen, storage, and print footprints sit on the floor and are pushed before elevation is captured. `setElevation` adds the floor offset to each captured top and bottom. Door, stair, elevator, loft-post, board, lounge, and coffee approaches remain outside those footprints. Chair and stool footprints cover the seat and backrest in either rotation.

Furnishing batches its own static meshes before the office pass. That pass does not merge across desk groups, so an unfunded desk can still be hidden. The reception sign is transparent and is not merged away. Evidence: [src/client/world/furnishing.ts](../../../src/client/world/furnishing.ts#L161), [src/client/world/batching.ts](../../../src/client/world/batching.ts#L22).

## Checks

- `git rev-parse HEAD` was `5127bd77578ddf01f4da5a1c0c82276f8c4b6ef3`; worktree clean before this report. `549615e` and `913a2f5` are ancestors. `5127bd7` is the worktop fix.
- Inspected the camera follow, view switch, occlusion, and view button, then the new furnishing meshes, footprints, office insertion, elevation snapshot, and static batching. Did not inspect platform projects or packaging.
- `npx tsx --test tests/camera.test.ts tests/office-furnishing.test.ts`: 18 passed, 0 failed. No port 4610, no credentials, and no browser automation.

## Coordinator evidence, not repeated here

Coordinator reports reception and meeting eye-level browser checks with no logged errors, plus typecheck, build, and the full suite. [docs/team/ROUND_4.md](../ROUND_4.md) records those checks and the device-build runtime limits. This review did not run typecheck, build, the full suite, browser QA, or a packaged app, and did not touch port 4610.
