# CHAR-01: characters, object interaction, animation and controls on every device

Branch `claude/char-01`, based on `origin/codex/empire-world` @ `e93c63a` (PR #48 merged). Author: Claude Opus 5.5 (Engineer). Not pushed.

## Requirements (recorded before coding)

Sources: the coordinator brief (owner feedback from the Android emulator, `claude/device-testing` shot `android/36-flying.png`), AGENTS.md, DESIGN_STANDARD.md, the master Web Design Standard, reports/city-06-08.md and reports/free-09.md.

**What the owner saw.** On the Android emulator the founder stood on the parked executive sedan. The sedan was on the Meridian garage roof by the helipad, the prompt read "E Enter vehicle at driver's door", and her feet floated over the bonnet.

**Diagnosis before coding (from the code; the device tester is diagnosing the sequence separately).**

- D1. The sedan's collider is a ground-level box (`top: 1.55`, no `bottom`) whatever height the car stands at (`world/city.ts`). Bought cars use `poseBox(..., bottom = 0)` (`world/districts.ts`). A car standing anywhere above the street (the 6.3 m roof) has no solid body at its own height, so a walker passes into it.
- D2. Every collider is standable. The walker's blocker ignores a solid once the feet are within 5 cm of its top, and `groundAt` puts the feet on any top within 10 cm below them. A walker arriving over a car's footprint from above (a jump from the stairs, a fall, a collider that turns solid around them) stands on its roof.
- D3. The driven ride follows the controller pose (`Traversal.syncRide` copies `player.pos`, height included). A teleport of the player while driving drags the car with it. "Go to desk" from the PR board (`main.ts goToDesk`) does exactly that, at any height, and a test or fixture script that places the player does the same. That is the only route found by which a car reaches the roof. A car cannot drive up the staircase: every step is a solid column and a car never steps up. Tests confirm this instead of assuming it.

**Goal 1: interaction bugs.**

- R1. Vehicles (the sedan, bought cars and the helicopter) are solid to a walker from every side and at every height. Their colliders sit at the vehicle's own base height and are marked as vehicles. A walker never stands on, steps onto or lands on a vehicle. No step-up onto a bonnet or roof, whatever the vehicle's height.
- R2. A walker found inside a vehicle's footprint (a collider that turned solid around them, an older save, a script) is pushed out to the nearest clear side at the same floor height and is never stuck.
- R3. Vehicles cannot be driven up the garage staircase or onto the roof from any side or speed. Stair colliders are also marked walker-only, so a car can never climb them even if the step rules change. Teleports never move a ride: "Go to desk" is refused while driving or flying, with a toast.
- R4. Feet are grounded on slopes and stairs. The founder's root follows the eased step height, and a light foot IK lifts a foot that would sink into a stair tread. It runs for the founder only, at most two ground probes a frame, and not under the Low preset.
- R5. Regression tests fail before each fix: the sedan and bought cars at roof height, standing, jumping and falling onto a car, stuck inside a car, cars against the staircase from four sides, and teleport while driving.

**Goal 2: animation audit and fixes.**

- R6. Audit every state with screenshots (desktop and phone): idle, walk, run, the walk/run blend and hysteresis, start and stop, turning, stairs up and down, jump and landing, car entry and exit at the driver's door, driving, helicopter entry, exit and flying, sitting at desks, typing and amenities.
- R7. Fix what the audit finds: foot sliding, wrong clips, missing transitions, pops and T-poses.
- R8. Add missing clips where they matter. Preferred source: the pinned Microsoft Rocketbox repository (MIT). It is already used for every avatar and clip, so its clips share the skeleton and need no retargeting. Upstream has turn-in-place (90°), walk and run start/stop, door-handle and side-sit clips. It has no jump, stair or car-seat clip, so those stay procedural over the recorded layer. Anything new is pinned by SHA-256 in `tools/avatars/sources.lock.json` and recorded in THIRD_PARTY_NOTICES.md. No Mixamo clip is needed unless the audit shows otherwise. Human Generator meshes are not shipped unless their licence allows redistribution in an MIT repository.

**Goal 3: controls on all devices.**

- R9. Touch:
  - a dedicated Run button (tap to lock running, tap again to walk; it accelerates while driving and hides while flying, where Down descends), so the stick no longer has to be pushed to the edge;
  - a contextual Use button whose label says what it will do (Enter, Exit, Board, Use);
  - every keyboard action reachable on touch: View, map (minimap and menu), interact, chat (menu), menu, jump/climb, descend and exiting vehicles.

  Buttons appear only when relevant.
- R10. Gamepad, behind feature detection (`navigator.getGamepads`), polled once a frame and only while a pad is connected. It maps to the same actions through `PlayerController.setAction`, so remapped keys keep working:

  | Input | Action |
  | --- | --- |
  | Left stick or d-pad | Move (full deflection runs) |
  | Right stick | Camera |
  | A | Jump / climb |
  | X | Use |
  | Y | View |
  | B or LT | Run, fast or descend |
  | Back | Map |
  | Start | Menu |

  Pads are ignored while a window is open or text is being typed.
- R11. Keyboard remapping, both camera views, physical traversal, CITY-06/08 deferred colliders and exit floor/rail checks, workstation capacity, reduced motion and Save-Data are unchanged (invariants).
- R12. Layouts are checked at 1440×900, phone landscape 874×402 and 667×375, 375 px portrait (rotate screen) and tablet 1024×768. Touch targets are at least 44 px, with labels, visible focus and no motion under reduced motion.

**Performance and size.** Phone frame time no more than +1.5 ms against the base with the FREE-09 method. Clip files stay small: rotation tracks, pelvis translation only, through the existing avatar pipeline.

**Protected.** Never touch localhost:4610, Pixel or `.agent-office`. Fixture ports are 5070–5090, and only PIDs this task started are stopped. No paid worker calls. Stay out of `src/client/update/service.ts` and the existing button CSS (claude/device-testing): new touch styles go in a separate stylesheet.

## Plan

1. This record.
2. Failing tests: collisions, the stairs, teleport, the animation state machine, touch mapping and the gamepad.
3. Collision fixes: vehicle colliders, walker rules, depenetration, the "Go to desk" guard.
4. Touch Run, contextual Use, gamepad.
5. Animation fixes and any new clips.
6. `tools/char-ui-check.ts` with screenshots in `docs/team/reports/char-01/`, then perf and the full checks.

## Owner updates during the task

- **Keep the current characters.** No new bodies were designed; the `business-*.glb` bodies and their materials are unchanged. Human Generator, Higgsfield and Meshy were not used.
- **Mixamo is available but not used.** Adobe allows Mixamo animations in games but not their redistribution as standalone animation files. A clips GLB committed to a public MIT repository is a downloadable standalone animation file, so shipping Mixamo clips here would conflict with those terms. Nothing was downloaded. Every fix below uses the existing Microsoft Rocketbox clips (MIT, already pinned) plus procedural layers.

## Audit findings

The audit ran on the shipped bodies (tests on the CPU) and in the fixture (char-ui-check, screenshots below).

| State | Finding | Fix |
| --- | --- | --- |
| Object interaction (shot 36) | D1–D3 confirmed: the sedan collider stayed at street level whatever the car's height; every collider was standable; a teleport while driving dragged the car along. A car cannot climb the staircase: tests drive the sedan and all four kit cars into it from three directions, at both speeds, while steering. | Fixes 1–4 below |
| Run | Feet slid. Clips played at `speed / 3.8` for every body, but the recorded run strides are 2.35–2.95 m/s, so at 4.3 m/s up to 40 % of the ground speed was slide. | Fix 5 |
| Walk | Small slide (recorded walk strides are 1.06–1.39 m/s against a fixed 1.45). | Fix 5 |
| Turning from rest | Any change of direction from standing (e.g. Down) spun the idle pose about 180° in about 0.2 s. | Fix 6 |
| Stairs | The root followed the eased step height, but the leading foot sank into the tread. | Fix 7 |
| Walk/run blend, start/stop, jump/landing | Correct. Hysteresis 2.3/2.7 m/s, phase-matched cross-fade, held flight frame with tuck, landing dip with planted feet. Existing LIFE-01 tests still pass. | — |
| Car entry/exit, driving | Correct: walk to the door, hand on the handle, door swings, side sit-down clip with foot IK through the aperture, hands on the wheel, feet on the pedals (shots 07–10). | — |
| Helicopter, desks, typing, amenities | No defect found. Existing CITY-06/08 and LIFE checks pass. No new screenshots this round. | — |
| T-poses, wrong clips | None seen in any state the check visits (motion names asserted). | — |

## Fixes

1. **Vehicle colliders at the vehicle's own height** (`vehicleBox`, `sedanCollider` in `world/district-layout.ts`). Used by the sedan (`city.ts`), bought cars and the helicopter (`districts.ts`). Deferred colliders and `slotClear` are unchanged.
2. **Vehicles are never a floor, and are solid at every height to a walker.** In `player.ts`:
   - `Collider.vehicle` makes the blocker treat the body as a column;
   - `groundAt` and `ceilingAt` ignore vehicles;
   - the walker never steps up onto a vehicle.

   **Props are not landing pads.** In the air, a walker passes only over what is no higher than a step above where they left the floor (`launchY`). Stairs still work because they are climbed on foot, and helicopter flight is unaffected.
3. **Push-out.** A walker found inside a vehicle's footprint steps to the nearest clear side at the same floor height (`pushOutOfVehicles`).
4. **Stairs and teleports.**
   - Garage stair colliders are `walkOnly`, a wall to any car at any height.
   - `PlayerController.teleport()` is refused while driving, flying or scripted.
   - "Go to desk" now says "Park and step out first" instead of carrying the car; the reconnect spawn uses `teleport` too.
5. **Stride rate per body.** `strideSpeed()` measures each body's recorded walk and run foot speed once at load and caches it per avatar. Clips play at `speed / stride`, with cadence capped at 1.6× so a run never looks frantic. Run slide falls from up to 40 % to at most 13 % (female bodies at the cap); male bodies and walking have none.
6. **Turn on the spot.** Above 2.5 rad/s with no ground speed, the feet step (a slow walk cycle) instead of the idle spinning (`locomotionClip(speed, previous, turnRate)`).
7. **Light foot IK on stairs** (`Human.groundFeet`):
   - two floor probes a frame, for the founder only;
   - third person only, and not on the Low preset or in vehicles;
   - lifts a foot that would sink into a tread, seeding a knee bend first.

## Controls per device

| Device | Move | Run | Jump / climb | Descend | Use (enter, board, exit) | View | Map | Chat / menu |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Keyboard (remappable) | arrows | Shift | Space | Shift in flight | E | N | G | T / Menu |
| Touch (phone, tablet) | stick | **Run** lock (Fast in a car; hidden in flight) | Jump / Up | Down (flight only) | **Use**, labelled Enter / Board / Exit by context | View | minimap, Menu | Menu |
| Gamepad (new, feature-detected) | left stick or d-pad (full deflection runs) | B or LT | A | B or LT in flight | X | Y | Back | Start |

The pad drives `PlayerController.setAction`, so remapped keys keep working. Pads are ignored while a window is open or text is being typed. The right stick orbits (third person) or looks (first person).

Touch styles live in `src/client/ui/touch-controls.css`, not `style.css`. All touch buttons are at least 44 px and labelled, with `aria-pressed` on Run and reduced motion respected.

## Screenshots (`docs/team/reports/char-01/`)

| # | Shot |
| --- | --- |
| 01 | Sedan on the garage roof is solid: the founder stops at its tail on the deck |
| 02–05 | Idle, walk, run, jump apex (1440×900) |
| 06 | Feet on the garage stair treads |
| 07–10 | Sedan: hand on the door handle, sitting down, driving (boarded and driven with the gamepad), stepping out |
| 11 | Run lock with a small stick push at 874×402, 667×375 (reduced motion and Save-Data) and 1024×768 |
| 12–13 | Use reads Enter at the door; Exit and Fast while driving (each touch layout) |
| 14 | 375×812 portrait rotate screen |

## Performance (FREE-09 method)

`CITY_UI_ONLY=perf` from this branch's `city-ui-check`, against two fixtures:

- base `e93c63a`, exported to a scratch folder (port 5072);
- this branch (port 5071).

Same viewpoints, headless Chrome on ANGLE/Metal, Medium preset. Mean frame time in ms (`char-01/perf-*.json`):

| View | Desktop 1440×900 | Phone 874×402 |
| --- | --- | --- |
| Founding street | 4.62 → 5.10 | 4.55 → 4.24 |
| Business street | 3.72 → 3.88 | 3.35 → 3.16 |
| Aerial | 5.59 → 5.53 | 5.65 → 5.25 |
| Helipad | 7.01 → 7.08 | 6.92 → 5.78 |

Draw calls and triangles are identical, and every phone view is faster than base (run-to-run noise), so the phone stays well inside the +1.5 ms budget. The worst desktop difference is +0.48 ms with identical draw calls. Measured headless, not on a device.

## Assets and licences

No new assets. No downloads. No Higgsfield, Meshy or Mixamo credits or files. THIRD_PARTY_NOTICES.md is unchanged: the clips are still the pinned Rocketbox MIT set.

## Tests and checks

- New tests:
  - `tests/char-01.test.ts` (12): collisions, stairs, teleport, turn in place, touch Run mapping, gamepad mapping. Committed red at `6f1a8ed`.
  - `tests/char-01-anim.test.ts` (11): stride rate per shipped body, stair foot IK.
- typecheck: pass
- `npm test`: 1011 tests, 1010 pass, 1 skipped (actionlint), 0 fail
- build: pass
- `char-ui-check`: 42/42 (port 5071)
- `city-ui-check`:
  - FREE-09 part: 23/23 (fresh fixture, 5073)
  - rides part: 25/25 (fresh fixture, 5074)
- `mobile-ui-check`: 411/411 (5075)
- `outfit-ui-check`: 29/29 (5076)
- `life04-ui-check` (waiting): 20/20 (5077)

Screenshots regenerated by other checks were reverted, and no untracked files were left. Only ports 5071–5077 were used, each fixture stopped by its own task id. 4610, Pixel and `.agent-office` were not touched.

## Not done or not verified

- **Real devices.** All evidence is headless Chrome with touch emulation and a scripted gamepad. Nothing was run on an Android, iOS or desktop-app device, and no real controller was tested.
- **How the sedan reached the roof on Android.** The only route found in code is a teleport while driving, now refused. The device tester's report should confirm it.
- **New clips.** Rocketbox has start/stop and 90° turn clips, but they carry root rotation and forward travel that would fight the controller. The procedural turn step and stride matching gave the visible gain without them. There are no jump, stair or car-seat clips upstream.
- **Helicopter and desk states** were not re-screenshotted this round (no changes there; their checks pass).
- **Foot IK when descending stairs.** The trailing foot can float slightly while the body eases down a step; only sinking feet are corrected.
