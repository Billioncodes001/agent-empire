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

`npm run typecheck`, `npm run build`, `npm test` (150/150) and macOS packaging passed. The macOS ZIP was integrity-tested (SHA256 `25e1762862cc97383130fb52af62b913b6da8d17a23b4def7611e3939e4c6204`). The Windows development ZIP passed x64 native-module/Node-API and archive checks, with its client bytes matching final `main-DxV4csRx.js`; actual Windows runtime and local CLI worker behavior are not validated. Its SHA256 is `9d7e0bca3e684dd5f5e143f0c7532d9b1a89feb0c9edfbe3b9e25067c5610f1e`.

Android's HTTPS-host companion compiled, passed host-origin policy tests, APK alignment and development-signature checks. SHA256: `0b83a79a765ebe1b382afa4df88b7169e5cca0cb4f7d9477da5c7177c241802f`. Installation and process startup were observed on an isolated Android 35 emulator, with no AndroidRuntime errors logged. It needs a reachable authenticated HTTPS host and does not contain an offline world or local agents. Native touch/rotation/HTTPS gameplay acceptance remains unverified: the isolated SDK emulator window was not exposed by the available computer-use surface. No unsupported UI automation fallback was used.

iOS has a source Xcode project, not an IPA. Full Xcode/iOS SDK, simulator/device compilation and distribution signing remain unavailable/unverified. See [platform builds](../PLATFORMS.md) for explicit platform limitations and reproducible build commands.

Ignored deliverables are in the main checkout’s `artifacts/`: round4 macOS ZIP, Windows ZIP, Android APK and reception/meeting/native-desktop screenshots. No store publication, distribution signing, paid provider jobs, purchases, or live city migration was performed.

Grok’s review identified a minor missing reception lower-worktop collider; commit `5127bd7` matches the visible surface. Typecheck, production build and all 18 focused camera/furnishing tests passed again after this fix. Desktop artifacts were rebuilt from that final client.
