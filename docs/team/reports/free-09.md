# FREE-09: bigger city with free CC0 assets (CITY-05 and CITY-07 first slice)

Branch `claude/free-09-city`, based on `codex/empire-world` @ `e822739`. Author: Claude Opus 5.5 (Interface). Status: implemented on `claude/free-09-city`, awaiting independent review; not pushed.

## Requirements (recorded before coding)

From the coordinator brief, AGENTS.md, CITY_EXPANSION_PLAN.md, DESIGN_STANDARD.md and FREE_STACK.md section 7:

- **CITY-07 expanded districts.** Two new districts east of the founding district: **Meridian business district** (towers, low-rise offices, plaza) and **Harbour works** (a waterfront/industrial district with a quay, tanks, containers and a water tower). Both connect to the existing street grid by roads. They include purchasable plots, street furniture and street lighting. The buildings come from Kenney CC0 kits downloaded from kenney.nl. Each pack's CC0 licence is checked on its page and in the `License.txt` inside the archive. Pack, URL, licence and zip SHA-256 are recorded in `THIRD_PARTY_NOTICES.md` and `tools/city/sources.json`.
- **Optimized assets only.** One GLB per kit holds only the models we use. Tangents are dropped, normals are int8 and UVs are uint16 under `KHR_mesh_quantization`, and textures are stripped. Textures ship as an external WebP palette at 512² for desktop, with a 256² variant for phones and Save-Data, chosen like the avatar pipeline. Raw zips stay in the git-ignored `.cache/kenney/`.
- **Save schema stays backward compatible.** It gains an optional `city` block: owned plots and owned vehicles. An older save has no `city` block and loads unchanged: the original district with no plots and no garage vehicles. The empire save `version` stays 2. Host (`src/server/empire.ts`), cloud (`src/cloud/schema.ts`) and client normalise through one shared validator.
- **CITY-05 garage and persistent vehicle ownership.**
  - The **Meridian motor garage** stands on the business-district road nearest the founding district.
  - Its roller door opens physically for a person on foot or the driven sedan, and the interior has collision.
  - Four storage bays and two apron spawn slots.
  - Vehicles (Kenney Car Kit) are bought with **fictional city credits** through `applyCityAction`, never provider money, and recorded in the capital ledger.
  - Refusals cover: setup incomplete, unknown model, garage full, insufficient credits.
  - Owned vehicles persist with their bay. "Bring out" picks a free apron slot. A slot counts as occupied if a saved vehicle holds it or the client reports it blocked by the live sedan or the player. When every slot is occupied, the action is refused with a reason.
- **Deferred, documented:** CITY-06 authored door/seat entry for the new vehicle models, so purchased Kenney cars are parked and stored but not yet drivable (the executive sedan keeps its existing authored entry). Also deferred: CITY-08 helicopter and construction on bought plots.
- **Invariants preserved:**
  - both camera views
  - physical traversal (walk or drive between districts, with no teleports)
  - arrow-key remapping
  - funded workstation capacity
  - protected 4610, Pixel and `.agent-office`
  - fixture ports 4920+
- **Performance.**
  - Phone preset may regress by no more than +1.5 ms frame time.
  - Each district is instanced per model, frustum-culled per district, and drops street furniture beyond 170 m.
  - The Low preset hides furniture, and Save-Data uses phone textures.
  - Lamps are emissive, with no new dynamic lights.
  - Reduced motion is respected (no new ambient motion).
  - The splash keeps naming the city kits while they load.

## Plan (one commit per step)

1. Plan doc (this file).
2. Asset pipeline (`tools/city/build-city-assets.ts`, `tools/city/sources.json`), the built `src/client/public/models/city/*` with `manifest.json`, `THIRD_PARTY_NOTICES.md`, and a licence-manifest test.
3. Shared rules (`src/shared/city.ts`, `economy-rules.ts`) and host/cloud save normalisation. Tests: migration, purchases/refusals, apron occupancy.
4. World: `src/client/world/districts.ts` (layout, roads, plots, lighting, garage, parked vehicles, LOD), terrain/bounds/minimap extension, collisions, a garage dialog, and plot interaction. Extend `tests/traversal.test.ts` across districts and into the garage.
5. `tools/city-ui-check.ts` (refuses 4610), screenshots in `docs/team/reports/free-09/` at 1440x900 and 874x402, and perf JSON before and after.
6. Report results and update TASKS rows for CITY-05 and CITY-07.

## Results

**Districts (CITY-07).**

- **Meridian business district** has towers, low-rise offices, a parasol terrace and awnings.
- **Harbour works** has industrial halls, tanks, a water tower, a chimney, a container yard and a quay with a rail.
- Both connect through extensions of the z = 62/90/118/146/208 streets and a new avenue at x = 100, with kerbs and markings.
- Street furniture: lamps, signals, signs, dumpsters, cones and parked taxi/delivery cars.
- Four plots with FOR SALE/OWNED signs.
- Terrain extended to x = 225, with the harbour shore past the quay. The greenbelt moved east.
- City bounds are now x −55..150 and z 30..215. Skyline towers at z ≥ 152 became solid.
- The minimap shows the districts, streets, garage (G) and plots.
- The layout is pure (`src/client/world/district-layout.ts`) and shared with the tests.

**Garage (CITY-05).**

- The roller door lifts for a person or the sedan, and the walls and roof are solid. Inside: four bays and a kiosk, which opens the garage dialog with the interaction key.
- Prices: hatchback 9,000, van 14,000, coupe 16,000 and SUV 24,000 **fictional city credits**. Purchases go through the shared `applyCityAction` (host and cloud) as one capital ledger entry.
- Purchases are refused when setup is incomplete, the model is unknown, the garage is full, or credits are insufficient.
- Bring out and Store are free. The host skips kerb slots held by saved vehicles or reported blocked by the live sedan or the founder. When every slot is held, the action is refused with a reason.
- Ownership persists across restart (test).

**Save.** `EmpireState.city` is optional and `version` stays 2. Old saves load unchanged through the host, `validateEmpire` (cloud) and the client via `normalizeCity`. Malformed blocks are rejected.

**Assets.** Four Kenney CC0 packs (licence checked on the page and in `License.txt`), built from pinned official zips with SHA-256 recorded in `tools/city/sources.json` and `THIRD_PARTY_NOTICES.md`.

- Only the 38 models we use ship, in 2.0 MiB of GLB: no tangents, int8 normals and uint16 UVs (`KHR_mesh_quantization`), and no embedded images.
- Palettes are lossless WebP at 512² (desktop) and 256² (phone and Save-Data). The 256² set saves GPU memory rather than bytes.
- Tests check that every file is in the manifest with CC0, an official source and a matching checksum, and that every shipped model is used.

**Rendering.**

- Instanced per model and district; static streets, plots and the garage shell are batched.
- Furniture is hidden beyond 170 m and on Low.
- Lamps are emissive only, with no new lights.
- The only animation is the door.
- The splash names “city districts” while they load.

## Performance

Headless Chrome on ANGLE/Metal, vsync off, Medium preset, same viewpoints. Before is `e822739` exported to a scratch folder with its own fixture; after is this branch (`free-09/perf-*.json`). Mean frame time in ms (draw calls):

| View | Desktop 1440x900 | Phone 874x402 |
| --- | --- | --- |
| Founding street | 2.86 → 3.32 (266 → 367) | 2.28 → 2.50 (318 → 422) |
| Business street | 2.05 → 2.43 (66 → 150) | 1.68 → 1.94 (66 → 159) |
| Aerial | 3.36 → 3.16 (418 → 310) | 2.63 → 2.58 (418 → 373) |

The phone regresses by at most +0.26 ms, within the +1.5 ms budget. This was measured headless, not on a device.

## Checks

- typecheck: pass
- `npm test`: 826/826
- build: pass
- city-ui-check: 17/17 (port 4937)
- mobile-ui-check: 411/411
- outfit-ui-check: 29/29. Its texture checks now scope to `/avatars/`.
- life04-ui-check (waiting): 20/20

Unrelated screenshots were reverted.

## Deferred

- CITY-06: door and seat entry for the Kenney cars. They are parked, not drivable.
- CITY-08: the helicopter.
- Construction on plots.
- District names in the location label.
- Device runs.
