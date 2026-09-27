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
