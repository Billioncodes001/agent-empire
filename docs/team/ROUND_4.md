# Round 4: character camera, furnished office and device builds

Baseline: f3f2f9e. Reference: user-supplied 15.6-second office walkthrough. The reference guided eye-level camera behavior and office density; existing human rigs and materials remain.

## Camera

- Character-follow heading eases behind the walking character and completes after a quick arrow tap is released. A held input chord keeps its own movement basis, preventing automatic camera rotation from steering the player in circles.
- Manual drag controls the camera, with a grace period before following resumes. District overview keeps its selected heading.
- First-person/third-person is a visible HUD button as well as the remappable N shortcut and Settings option. The preference persists across reloads. View switching does not rotate a vehicle.
- Camera easing is time-based; collider obstruction is resolved after smoothing so a camera previously behind a wall retracts immediately.

## Verification boundaries

13 camera tests cover held directions, brief turns, manual orbit, modal input, vehicle heading, wall obstruction and 30/60/120 fps. Browser QA used a disposable, authenticated port-4617 fixture with all workers disabled and provider requests intercepted. Both views and persistence were checked; a brief right-arrow turn visibly settled behind the character. The responsive HUD was checked at 390 by 844 pixels. No paid provider requests or live worker state changes.

The existing port-4610 preview, Pixel worker and saved city are preserved. Only isolated integration builds are used during this pass.

## Office furnishing

Claude Opus 5.5 implemented reception and visitor seating, an under-loft meeting area with display and chairs, printer/paper storage, cabinets, kitchen details and workstation accessories. Shared placement data drives the chair/table colliders. Five clearance tests check funded desks, stairs, elevator, exit, boards, lounge, coffee approach and furniture bounds. Furnishings enter the existing elevation snapshot and recursive static batching; workstation funding/capacity is unchanged.

The development-only graphics review adds Office eyes, Reception and Meeting viewpoints. Browser captures of reception and the meeting area rendered without logged errors; these are explicitly labeled construction fixtures, with no AI task execution. Packaged macOS local-city startup also rendered the final asset bundle and its visible first-person button. The saved founder and one paused founding task remained, with zero active workers; quitting stopped its loopback server.

## Build evidence

`npm run typecheck`, `npm run build`, `npm test` (150/150) and macOS packaging passed. The macOS ZIP was integrity-tested (SHA256 `d6c75eb970ebe1ac563c7631aad1ddc7379ccbf76a04b19a26322d68d5a0a577`). The Windows development ZIP passed x64 native-module/Node-API and archive checks, with its client bytes matching final `main-DAeoDxTZ.js`; actual Windows runtime and local CLI worker behavior are not validated. Its SHA256 is `7be8165c7895e71ac4a3325c698baa52d738be73134400fc090e783f2bb0343a`.

Android's HTTPS-host companion compiled, passed host-origin policy tests, APK alignment and development-signature checks. SHA256: `3db135b381064fca40f6fd7a879e8f992a97be23d89c1eeef749e8afb97de741`. It needs a reachable authenticated HTTPS host and does not contain an offline world or local agents. Native touch/rotation/HTTPS gameplay acceptance remains unverified: the isolated SDK emulator window was not exposed by the available computer-use surface. No unsupported UI automation fallback was used.

iOS has a source Xcode project, not an IPA. Full Xcode/iOS SDK, simulator/device compilation and distribution signing remain unavailable/unverified. See [platform builds](../PLATFORMS.md) for explicit platform limitations and reproducible build commands.

Ignored deliverables are in the main checkout’s `artifacts/`: round4 macOS ZIP, Windows ZIP, Android APK and reception/meeting/native-desktop screenshots. No store publication, distribution signing, paid provider jobs, purchases, or live city migration was performed.
