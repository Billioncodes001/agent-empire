# Office life world slices: LIFE-01, LIFE-02, LIFE-03

World author, worktree `office-life-world`, branch `claude/office-life-world`, base `aabee56`. Written 2026-09-28. Plan: [OFFICE_LIFE_AND_MOBILE_PLAN.md](../OFFICE_LIFE_AND_MOBILE_PLAN.md).

## Summary

| Slice | Status | Evidence |
| --- | --- | --- |
| LIFE-01 Locomotion polish | Implemented, unit-tested and browser-checked | `tests/models.test.ts` (+9 tests), `jump-midair.png`, per-frame jump probe in the fixture |
| LIFE-02 Office amenities | Implemented, unit-tested and browser-checked | `tests/office-furnishing.test.ts` (+2 tests), `gym.png`, `cafeteria.png`, `coffee-bar.png`, `phone-375-cafeteria.png` |
| LIFE-03 Worker routines from real states | Implemented against today's statuses, unit-tested and fixture-checked | `tests/office-life.test.ts` (13 tests), the fixture flows below, `worker-*.png` |
| LIFE-04 `waitingOn` | **Not implemented** (backend). The client accepts an optional `waitingOn: { id?, name }` on a worker and shows "Waiting on <name>"; the server never sends it yet | `planRoutine` tests |

`npm run typecheck` passes. `npm test`: 225 tests, 225 pass (baseline was 201). `npm run build` passes.

## LIFE-01: jump, airborne, landing, walk/run

- **No idle clip in the air.** A second action on `run_neutral` is held at its flight frame (`RUN_FLIGHT_PHASE` 0.16, both feet off the floor on both rigs; tested). A procedural layer tucks the knees while rising, reaches the legs down while falling and lifts the arms for balance. Take-off is detected on the first rising frame and latched until touchdown, so the pose never flickers.
- **Landing.** Touchdown after a real flight (over 0.12 s) drops the hips 3–8.5 cm, scaled by fall speed, and recovers over 0.3 s. A seeded knee bend plus foot IK keeps both feet planted at ankle height. Short step-downs get no dip.
- **Peers.** Remote players use the same path with a 0.15 s landing grace, so interpolation at the apex doesn't read as a landing.
- **Walk ↔ run.** Hysteresis (walk to run above 2.7 m/s, back below 2.3 m/s), a 0.3 s phase-synchronised cross-fade, and a 0.08 s fade out of flight into the stride.
- **Numerical hygiene.** `rotate()` and `placeFoot()` now reuse scratch objects and normalise quaternions. Every new `Human` field tolerates `undefined`, because `models.test.ts` builds bare instances.

Tests (both rigs): the flight frame has both feet up; a 6.4 m/s jump has zero idle frames while airborne, feet tucked more than 12 cm, a 2.5–9.5 cm dip, and feet within 3 cm of rest after the touchdown frame. Speed noise inside the hysteresis band never switches clips. A walk→run→walk ramp switches exactly twice, and per-frame foot travel across the blends stays below 1.35× steady running. Amenity poses don't drift on held frames, and props are put away afterwards. The existing clip-name, bone-independence and typing-IK assertions are unchanged and green.

Browser (fixture, local avatar read directly, 20 fps headless): the sequence was `idle → airborne → landing → idle`, with **0 idle frames above 5 cm** and a 1.07 m apex. `canvas.dataset.motion` is written at the top of the frame, before the avatar updates, so it lags one frame. It previously read `me.root.children[0]`, which was the name sprite and not the body, so it now uses `Person.motion`.

## LIFE-02: amenities (every HQ floor)

All floors share one office layout (`office.setFloor` only moves it), so every floor gets them. The amenities are built from primitives using the measured PBR `SURFACE` and `solid()` materials. No new binary assets, so `THIRD_PARTY_NOTICES.md` is unchanged.

- **Gym corner** (x 10.4–15.0, z −9.9…−4.5): rubber tile floor, two treadmills, a spin bike, a two-tier dumbbell rack with kettlebells, two mats with towels, a stability ball and a water station. It sits east of the elevator approach, west of the services-board approach and south of the queue board.
- **Cafeteria and breakfast** (x −17.95…−13.6, z 1.7–7.2): a breakfast counter under the west window with cereal and granola dispensers, juice and milk, bowls and plates, pastries under a cloche, a bread board and a fruit bowl. Two tables with four chairs each, set for breakfast, a menu board and copper pendants.
- **Coffee bar upgrade** (on the existing bar): twin-group espresso machine, grinder, warming cups, syrups, a milk pitcher, a glass pastry case, takeaway cups, a chalk menu and copper pendants. It adds no new light; every added light costs every lit material on the floor.
- **Colliders:** `AMENITY_COLLIDERS` is part of `FURNISHING_COLLIDERS`, so physics, camera and the existing clearance tests cover it. **Interactions:** `gym` and `cafeteria` hints (E), alongside the coffee machine. **Use spots:** 4 coffee, 8 cafeteria chairs, 2 treadmills, the bike, the dumbbell rack and 2 mats, each with an approach point.
- **Tests added:** no overlap with any other furniture or with each other, and everything inside its zone. At least 1.2 m of aisle between the cafeteria and the desks. The breakfast counter stays inside the west wall. Unique spot ids. Every approach is clear. Standing spots are clear, and seats sit in exactly their own equipment. Coffee spots are in the kitchen aisle, and chairs face their table. The existing desk, exit, stairs, elevator, loft, board, TV and coffee approach checks all still pass with the amenities included.

## LIFE-03: routines from real states

- **`world/routines.ts`** (pure) `planRoutine()` maps status, processState, freshness, optional `waitingOn`, worker id and time to `{ place, activity, reason }`:
  - **working:** desk. It types only when the existing `typingPose` gate allows.
  - **starting:** desk, booting.
  - **needs_input:** desk, attention.
  - **idle or done:** stays at the desk for a 6 s dwell, then goes to an amenity chosen by FNV hash of the id plus the break's start. The choice is fixed for the whole break and moves on every 12 minutes. The reason reads "Idle — on a coffee break" or "Turn finished — at the gym".
  - **waitingOn:** an amenity, with "Waiting on <name> — …".
  - **stale (any status), offline, exited, unknown:** placed at the desk, never walked. `'away'` is in the `Place` type but unused: offline workers stay asleep at the desk as today.
- **`world/navgrid.ts`** (pure) is a 0.2 m occupancy grid grown by a 0.3 m walker radius, with 8-connected A* (no corner cutting) and line-of-sight smoothing. **`world/office-nav.ts`** derives obstacles from the shared layout: every desk and desk chair, all furniture and amenities, the kitchen, lounge, plants, lift, stairs and loft posts. At runtime it also adds every live office collider between ankle and head height.
- **`world/worker-life.ts`** is the runtime controller. The worker stands up (`sit_stand_up_chair_01`, chair rolls back), walks out behind the chair and along the aisles, and steps onto the spot. On the spot it:
  - sits (`sit_down_chair_01`) and eats at a cafeteria chair;
  - walks in place on a treadmill belt;
  - pedals with foot and hand IK on the bike;
  - curls at the rack;
  - stretches on a mat;
  - holds a cup and sips at the coffee spots.

  When the state becomes working again, the worker leaves the spot, walks back, sits, and only then types. Typing and its sound are gated on being seated at the desk.
- **Spot sharing:** each worker has a usual spot and skips spots held by others. When an amenity is full, the worker waits at the desk.
- **Labels:** the name card shows the reason while away and "Back to the desk" while returning.
- **Screen:** the desk screen keeps showing the worker's real terminal texture, which is its last real frame while idle. No new screen content is fabricated.
- **Reduced motion** (`prefers-reduced-motion`): bodies are placed directly, with no walking.
- **Low preset:** the IK-heavy pedal and eating hand layers are skipped.
- **Allocations:** the walk and pose loops allocate nothing per frame. Plans are re-evaluated at 4 Hz, and paths are computed only on departure or a change of goal.
- **`main.ts`** changes are contained: the `OfficeLife` instance, one `sync` in `syncWorkers` in place of the typing/sound lines, `remove` in both teardown paths, `update` before the worker loop, `life` on `__office`, the remote-peer landing grace, the gym and cafeteria hints and REACH entries, and the `dataset.motion` fix.

Tests: every combination of status, freshness, typing, waitingOn and time leaves the desk only for fresh idle, done or waiting states, and always gives a reason. Typing happens only on a fresh running turn. Stale, offline, exited and unknown states are always placed without a walk. The amenity choice is stable and rotates slowly, and 30 ids cover all three amenities. No two workers take one spot. Every desk (all 16) reaches every spot (18) and back, with each leg clear of every obstacle by 12 cm and routes under 60 m. The last step onto a spot meets only its own equipment. A walled-off goal returns null. With stand-in bodies: idle → dwell → walk → using, never typing away from the desk, and typing events `[true, false, true]`. Going stale mid-walk places the body at the desk. Reduced motion never walks.

### Fixture flows (`FIXTURE_PORT=4702`, synthetic worker at desk-1)

| Scenario | Observed |
| --- | --- |
| working | seated + typing at desk-1 |
| idle | seated 6.1 s (dwell) → standUp 1.8 s → walk → enterSpot → using at `coffee-bar-west`, name card "Idle — on a coffee break" |
| working again | leaveSpot → walk ~15 s → sitDown → seated + typing (typing only after seated) |
| turn_ended | break again ("Turn finished — on a coffee break") |
| disconnected while on the break | placed at desk immediately (`seated`, activity `unknown`, "Status unknown — shown at desk"), no walk, still seated 4 s later |
| reduced motion, idle → working | `seated → using` after the dwell, then `seated+typing`; no walk phase |

The fixture's single worker always hashes to the coffee bar. The gym and cafeteria poses were checked with **pose previews**: the same model placed by script with the controller paused, labelled "Pose preview — scripted, not a server state". Those images are not server states.

## Performance

Headless Chrome with vsync off, 1280×800, medium preset. Each cell is the average ms/frame over 600 frames, then draw calls. The baseline is the unmodified `aabee56` client served by a second fixture on 4703. Two interleaved rounds:

| Camera | Baseline | This change |
| --- | --- | --- |
| Spawn | 3.34 / 3.38 ms · 760 | 3.49 / 3.62 ms · 816 |
| Gym view | 2.72 / 2.81 ms · 406 | 3.07 / 3.52 ms · 450 |
| Cafeteria view | 3.39 / 3.44 ms · 449 | 3.74 / 3.92 ms · 503 |
| Coffee view | 3.32 / 3.52 ms · 459 | 3.73 / 3.87 ms · 523 |
| Desks overview | 5.62 / 5.68 ms · 740 | 5.92 / 5.99 ms · 818 |

That is roughly +0.2–0.6 ms and +44–78 draw calls. It was about +82–137 before three changes: baking the chair transforms so all chairs batch, dropping the planned extra point light, and taking tabletop props out of the shadow pass. While the worker walked, desk-view frames stayed in the same range. Console: only the fixture's pre-existing 404s (`/api/continuity/status`, `/api/execution/setup`) and the expected WebSocket failure in the `disconnected` scenario.

## Screenshots (`docs/team/reports/office-life/`)

`gym.png`, `cafeteria.png`, `coffee-bar.png`, `jump-midair.png`, `worker-at-desk-typing.png`, `worker-walking.png`, `worker-at-amenity.png`, `pose-preview-{bike,treadmill,weights,cafeteria}.png`, `phone-375-cafeteria.png`.

## Known limits and not verified

- **LIFE-04 is backend work.** Nothing sends `waitingOn`; the client path is unit-tested only.
- **Status freshness:** `idle` is also the state of a freshly started agent waiting for its first prompt. After the 6 s dwell it takes a break; that is still a real idle state.
- **Bike pose:** the rider sits slightly behind the saddle and leans; it reads as cycling but is not retargeted. **Treadmill:** the belt texture does not scroll. **Weights:** the curl is a forearm rotation, not recorded motion.
- **Cafeteria chairs:** stepping in from beside the chair can clip the chair corner for a few frames.
- **Crowding:** workers do not avoid each other while walking. Paths avoid furniture, not people or the player.
- **Blender** is not installed on this host. No new rigs or clips were made (LIFE-05); every pose is recorded clips plus procedural layers.
- **Not measured:** performance on a real device or GPU (headless only), the low preset specifically, and Save-Data (nothing here fetches assets). No iOS or Android device run.
- **Screen previews:** the phone screenshot shows the world at 375 px width only. The HUD at that width belongs to the mobile lane.
