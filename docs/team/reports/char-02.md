# CHAR-02: missing character animations from free, openly licensed libraries

Branch `claude/char-02`, based on `origin/codex/empire-world` @ `1fb8e12` (CHAR-01 merged as PR #50). Author: Claude Opus 5.5 (Engineer). Not pushed.

## Requirements (recorded before coding)

The brief, AGENTS.md and the CHAR-01 audit (`reports/char-01.md`) set these requirements.

- Owner decision (2026-10-25): stay Mixamo-free and use free animation libraries. Keep the current characters and improve them only. No Mixamo, no Human Generator, no new bodies.
- Add the clips CHAR-01 found missing:
  - jump: take-off, airborne and landing;
  - stairs up and down;
  - a sit-in-vehicle (driving) pose, and get-in / get-out of a car;
  - turn in place, if a clean in-place clip exists.
- Sources must be CC0 or similarly permissive. Check the licence on the source page and inside the archive. Pin the URL and SHA-256 in `tools/avatars/sources.json`, add a reproducible build script and record everything in THIRD_PARTY_NOTICES.md.
- Clips must be in place: no foot sliding, pops or T-poses, with blended transitions. The CHAR-01 stride/cadence scaling and foot correction stay. Reduced motion gets no exaggerated motion.
- Keep the CHAR-01 invariants, both camera views and workstation capacity. Phone frame budget is +1.5 ms (FREE-09 method).
- Write failing-first tests for the state machine (jump phases, stairs, car seat, missing-clip fallback) and for clip provenance (licence and checksum). Extend `char-ui-check` with screenshots at 1440×900 and 874×402.

## Sources and licences

| Library | Licence check | Used |
| --- | --- | --- |
| **Quaternius, Universal Animation Library [Standard]**, [OpenGameArt](https://opengameart.org/content/universal-animation-library), [author page](https://quaternius.com/packs/universalanimationlibrary.html) | CC0 1.0 on the OpenGameArt page, on quaternius.com and in the archive's `License.txt` ("CC0 1.0 Universal") | `Jump_Start`, `Jump_Loop`, `Jump_Land`, `Driving_Loop` |
| Quaternius, Universal Animation Library 2 [Standard], [OpenGameArt](https://opengameart.org/content/universal-animation-library-2) | CC0 1.0 (page and `License.txt`) | Downloaded and inspected only. It has no stair, car or turn clip, so nothing from it is shipped or pinned. |

The archive is pinned in `tools/avatars/sources.json`:

- URL: `https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip`
- SHA-256: `18ff1a7215f4852b320203e8aaf02a1578b5c8eef9027fbaedfcedc7b85a3ac2`

THIRD_PARTY_NOTICES.md has a new section. The archive is a build input in the git-ignored `.cache/quaternius/`. Only rotation tracks and pelvis position ship; no mesh.

Nothing paid was used: no Higgsfield, Meshy, Mixamo, Human Generator or worker calls.

## Pipeline

Rebuild with `npx tsx tools/avatars/build-clips.mts`.

1. **Download and verify.** The script downloads the archive once and checks it against the pinned SHA-256 before writing it to the cache; a corrupt cached copy is deleted and fetched again (`tools/avatars/pinned.ts`). It lists it with `tools/city/zip-guard.ts` (no symlinks, no path escapes, size cap). It then extracts the archive and requires CC0 in its `License.txt`.
2. **Retarget** (`tools/avatars/retarget.ts`). This runs in node with three.js, not Blender, so the output is byte-for-byte reproducible (verified by rebuilding twice).
   - **Calibration.** Both rigs stand in a reference idle: the source's `Idle_Loop` and the target's own `idle_neutral_01`. Each mapped bone gets the source's world-space rotation delta from that idle, turned to the target's facing: `T = R·S·S_ref⁻¹·R⁻¹·T_ref`. At the source idle the Rocketbox body is exactly in its own idle, so the current characters keep their look.
   - **Pelvis.** The pelvis sits where the lower ankle reaches its scaled source height. It keeps the hips' shift over the feet (capped at 0.3 m) and never travels.
   - **Feet.** A build-time two-bone IK plants each ankle where the source's ankle is, scaled. The rigs' hip widths and leg lengths differ, and without this a landing foot slid 22 cm. It now moves less than 3 cm on every body.
   - **Arms.** The jump clips keep half of the source's arm swing (`calm: 0.5`). The original arms-out pose was too theatrical for people in suits.
   - **Driving seat.** `drive_seated` takes its hip position from the chair sit (`pelvisFrom`). The car seat and the driver placement were fitted to that pose.
3. **Write.** Output is `clips-extra-{male,female}.glb`: int16 quaternions with reduced keys, on the 52 mapped bones only, and shared buffer views. `clips-extra.json` records each file's bytes, SHA-256, licence, source page and clip mapping. `reduceKeys` moved to `tools/avatars/keys.ts` unchanged, and `build-avatars.ts` imports it.

| Shipped clip | Source (window) | Use |
| --- | --- | --- |
| `jump_start` | `Jump_Start` 0.07–0.50 s (the leap, without the crouch anticipation: the game's jump is instant) | Take-off, played once |
| `jump_air` | `Jump_Loop` | Airborne loop |
| `jump_land` | `Jump_Land` 0.03–0.80 s | Landing crouch and recovery, feet planted |
| `drive_seated` | `Driving_Loop` | At the wheel (hand and pedal IK stay on top) |

## Sizes

| File | Bytes | Gzip |
| --- | --- | --- |
| `clips-extra-male.glb` | 83 432 (81.5 KiB) | about 23 KiB |
| `clips-extra-female.glb` | 82 988 (81.0 KiB) | about 23 KiB |

- The base clip files (`clips-male.glb` / `clips-female.glb`, about 1.3 MB each) are unchanged. That is about 6 % more clip data per body.
- The extra files load **lazily**, after the body is ready, on their own loading manager, so they do not hold the splash.
- They are **skipped under Save-Data**. A failed download logs one warning, and the CHAR-01 behaviour plays.

## State machine

`src/client/world/anim-state.ts` holds pure functions, so every phase and fallback is unit-tested:

- `jumpPhase`:
  - `takeoff` while a rising jump is under 0.4 s old;
  - then `air`; a fall from a ledge goes straight to `air`;
  - then `land` while the landing timer runs.
- `stairsState`: `up` or `down` from grounded vertical speed while moving. Enter above 0.35 m/s, leave below 0.12 m/s.
- `selectMotion` picks the clip in this order:
  1. a transition clip;
  2. seated or driving: `drive_seated`, else the chair sit;
  3. jump phases: `jump_start` → `jump_air`, else the held run-flight frame (`airborne_flight`);
  4. landing while standing still: `jump_land`, else locomotion with the procedural dip;
  5. locomotion with the CHAR-01 walk/run hysteresis and the turn step.

  It never names a clip the body lacks; the last resort is the idle.

`Human` feeds the state machine and plays its choice:

- `jump_start` and `jump_land` play once and hold their last frame.
- Fades: 0.08 s into the take-off, 0.15 s into the air, 0.06 s into the landing and 0.25 s out of it.
- The procedural tuck shapes only the held fallback frame, and the landing dip runs only when no landing clip plays. The clips are never doubled up.
- The landing is decided once, at touchdown (`landWithClip`): the clip plays only after a hard touchdown (faster than 2.5 m/s) while standing still (0.5 m/s or less), with the clip present and motion allowed. Every other landing, such as a ledge caught on the way down or a landing at a run, gets the CHAR-01 procedural dip. The two never stack. The first frame the stride wins ends a clip landing, so stopping later never starts a late crouch.
- The state machine's inputs and its `has()` closure are allocated once per body and refilled every frame.
- Stairs add a small spine lean, eased in and out: +0.07 rad climbing, −0.03 rad descending. CHAR-01 foot IK still grounds the founder's feet on the treads, and stride scaling is unchanged.
- **Reduced motion** keeps the calm CHAR-01 jump (held frame and small dip) and halves the stair lean. It follows the OS setting live through `setHumanReducedMotion`.

## Tests

- `tests/char-02.test.ts` (9): jump phases, the jump clips and their fallbacks, reduced motion, stairs hysteresis, stairs and seat priority, car seat and fallback, missing transition → idle. The last test is provenance: every shipped `clips-*.glb` is named in the notices, the extra files match `clips-extra.json` byte count and SHA-256, the archive is pinned with its checksum in the notices, the licence is CC0 with no Mixamo source, and each file is under 100 KiB.
- `tests/char-02-clips.test.ts` (16):
  - all ten shipped bodies: clips finite and in place, hands under 1.5 m apart (no T-pose), feet above the floor;
  - landing feet moving under 3 cm and kept on the floor, crouch and recovery;
  - take-off and air add no height, the knee is drawn up in the air;
  - driving seat at the chair-sit height and spot, head no higher than in the chair;
  - a real `Human` running the player's jump physics: `idle → jump_start → jump_air → jump_land → idle`, with the CHAR-01 sequence without the clips or under reduced motion;
  - planted landing feet, stairs up, down and level, car seat with and without the clip.
- Both files were committed red at `869e7f8` (the module did not exist).

## Checks

| Check | Result |
| --- | --- |
| typecheck | pass |
| `npm test` | 1056 tests, 1055 pass, 1 skipped (actionlint), 0 fail |
| build | pass |
| `char-ui-check` (fresh fixture, 5184) | 60/60: CHAR-01's 42, plus 18 new for CHAR-02 |
| `city-ui-check` FREE-09 part (fresh fixture, 5185) | 23/23 |
| `city-ui-check` rides, `CITY_UI_ONLY=rides` (fresh fixture, 5186) | 25/25 |
| `mobile-ui-check` (5187) | 411/411 |
| `outfit-ui-check` (5188, `FIXTURE_WORKERS=5`) | 29/29 |
| `life04-ui-check`, waiting scenario (5189) | 20/20 |

The new `char-ui-check` section D runs at 1440×900 and at 874×402 (touch). At each size it checks:

- the lazy extra-clip requests (200);
- take-off, airborne and landing clips in a real jump, then back to the idle;
- `stairs: up` on the stride clip and `stairs: down` on the garage staircase;
- `drive_seated` in the sedan, with get-in and get-out screenshots;
- no console errors.

Section E checks that reduced motion keeps the held frame (no `jump_*` clip) and that Save-Data downloads no extra clips and falls back. `CHAR_ONLY=char02` runs only these sections.

Screenshots that the other checks regenerated were reverted (char-01, free-09, city-06-08, mobile, corporate-outfits, life-04, followups-1, phone-windows). All fixtures were stopped by their task ids. Only ports 5184–5190 were used (5181 was taken by another session and left alone). Port 4610, Pixel and `.agent-office` were not touched.

## Performance (FREE-09 method)

`CITY_UI_ONLY=perf PERF_OUT=char-02` (`tools/city-ui-check.ts` now accepts `char-02`), run against two fixtures:

- base `1fb8e12`, exported to `.cache/char02/base` (port 5190);
- this branch (port 5184).

Viewpoints, preset and headless Chrome on ANGLE/Metal are the same as CHAR-01. The machine was shared with other sessions, so each side ran twice in alternating order. Values are mean frame time in ms, averaged over the two runs (`char-02/perf-*.json`):

| View | Desktop before → after | Phone 874×402 before → after |
| --- | --- | --- |
| Founding street | 5.24 → 5.54 | 5.78 → 4.61 |
| Business street | 5.03 → 4.75 | 4.86 → 3.86 |
| Aerial | 7.13 → 6.90 | 6.52 → 5.27 |
| Helipad | 7.96 → 7.88 | 6.83 → 6.57 |

- Draw calls and triangles are identical. The phone views counted one texture more than base in both runs. The extra clip files carry no images, so that texture is not from this change; it was not traced further.
- Every phone view is inside the +1.5 ms budget; all are at or below base.
- Run-to-run noise on this shared machine was ±1.5 ms, larger than any difference measured. Single-run outliers (desktop helipad +1.6 ms in run 1, −1.8 ms in run 2) cancel out.
- The work per body is one more mixer action at a time and a pure-function lookup.

Measured headless, not on a device.

## Screenshots (`docs/team/reports/char-02/`, each at `1440x900` and `874x402`)

| # | State |
| --- | --- |
| 01 | Jump take-off (`jump_start`) |
| 02 | Airborne (`jump_air`, calmed arms) |
| 03 | Landing crouch (`jump_land`, feet planted) |
| 04 | Stairs up (stride clip, forward lean, feet on treads) |
| 05 | Stairs down |
| 06 | Getting into the sedan (Rocketbox side-sit transition, unchanged) |
| 07 | At the wheel (`drive_seated`, hand and pedal IK) |
| 08 | Getting out |
| 09 | Reduced-motion jump (held CHAR-01 frame), 874×402 only |
| 10 | Helicopter pilot in `drive_seated` (`10-helicopter-pilot-xray-*`: the opaque cabin shell is made see-through for this one shot, then restored) |

## Deferred, and why

- **Stairs clips.** Neither free CC0 Quaternius library has a stair clip; only the paid Pro tier lists more locomotion, and the owner asked for free libraries. Stairs are a state on the stride clip, with a lean layer and CHAR-01 foot IK. A CC0 stair clip, if one turns up, slots in through `selectMotion` with no other change.
- **Car get-in / get-out clips.** The free libraries have only front-facing chair sits (`Sitting_Enter`/`Exit`), which are wrong for a side car door. The existing Rocketbox side-sit transition with foot IK through the door (CHAR-01) stays.
- **Turn in place.** No clean in-place turn exists in either free library. Rocketbox's 90° turns carry root rotation, as CHAR-01 found. The CHAR-01 procedural turn step stays.
- **Head height in the sedan.** Measured in the fixture with a vertical ray against the sedan's triangles: 2.2 cm between the top of the skull (head bone + 0.12 m) and the roof. The hair reaches the roofline in the screenshots. This predates CHAR-02: the chair sit used before has the same hip spot, and the driving pose's head is no higher (tested). The value is reported by `char-ui-check`, not gated. More room belongs to the sedan model or the driver placement, outside this slice. The helicopter pilot has 25.8 cm, which is gated.
- **Peers' landing.** Remote players and workers play the same state machine, but a peer whose airborne flag flickers at the apex uses the existing landing grace. It was not separately screenshotted.

## Not verified

- Real devices: all evidence is headless Chrome with touch emulation. Nothing ran on Android, iOS or the desktop app.
- The perf numbers come from a shared, noisy machine (see above).
- `build-clips.mts` was run here with the archive already cached. Its first download path was exercised once at the start, when the zip was fetched from OpenGameArt and matched the pinned SHA-256.

## Review round 1 (changes requested on `4e072cf`)

Each fix has a failing-first test: the landings at `ddcd20f` and the pinned download at `e92b587`.

1. **Soft landings no longer stack the clip on the dip.**
   - `MotionInput.landClip` is set at touchdown by `landWithClip`, and `selectMotion` returns `jump_land` only when it is true.
   - A jump onto a 1 m ledge (touchdown about 2.2 m/s) now lands with the CHAR-01 dip. Pelvis low point: 0.836 m, against 0.865 m without the extra clips; it was 0.513 m before the fix.
   - Tests: `review: jumping onto a 1 m ledge…` and the pure `landWithClip` table.
2. **Landing while moving keeps the dip; no late crouch.**
   - The touchdown decision includes ground speed (≤ 0.5 m/s for the clip).
   - The first frame the stride wins ends a clip landing.
   - The probe's run-then-stop sequence is now `jump_air → run_neutral → idle_neutral_01`, with no `jump_land`.
   - Test: `review: landing at a run keeps the dip and stride…`.
3. **Small items:**
   - `tools/avatars/pinned.ts` verifies the archive before caching it and replaces a corrupt cached zip (`tests/char-02-pinned.test.ts`, 4 tests).
   - The `--inspect` debug code is removed. The rebuilt clips are byte-identical.
   - New char-ui-check section F: the helicopter pilot plays `drive_seated` with 25.8 cm of head clearance under the cabin roof (gated), with an x-ray screenshot. Sedan clearance (2.2 cm) is reported.
   - Scratch inputs are reused per frame.
   - The jump check now reads a per-frame clip log in the page, so a slow screenshot can no longer hide the 0.3 s airborne phase (that flake was seen once).
   - Report wording fixed: the texture count and the test header no longer claim reproducibility.
4. **Merged** `origin/codex/empire-world` @ `64585f8` (CITY-10 #55, FREE-07 #54). The one conflict was the `PERF_OUT` line in `tools/city-ui-check.ts`, which now accepts `char-01`, `char-02` and `city-10`.

**Checks after the fixes (on the merge):**

| Check | Result |
| --- | --- |
| typecheck | pass |
| `npm test` | 1165 tests, 1164 pass, 1 skipped (actionlint), 0 fail |
| build | pass |
| `char-ui-check` (fresh fixture, 5184) | 66/66 |
| `city-ui-check` FREE-09 part (5185) | 23/23 |
| `city-ui-check` rides (5186) | 25/25 |
| `mobile-ui-check` (5187) | 411/411 |
| `outfit-ui-check` (5188) | 29/29 |
| `life04-ui-check`, waiting (5189) | 20/20 |

Screenshots regenerated by the other checks were reverted. All fixtures were stopped by task id, and only ports 5184–5189 were used. Perf was not re-measured: the per-frame change only removes allocations.
