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
