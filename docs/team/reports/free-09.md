# FREE-09: bigger city with free CC0 assets (CITY-05 and CITY-07 first slice)

Branch `claude/free-09-city`, based on `codex/empire-world` @ `e822739`. Author: Claude Opus 5.5 (Interface). Status: plan recorded before code.

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
