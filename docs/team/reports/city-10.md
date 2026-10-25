# CITY-10: the city architect

Branch `claude/city-09-architect` (the branch name predates the ID change), from `codex/empire-world` at `cb70e5f`. Design: [CITY_ARCHITECT.md](../CITY_ARCHITECT.md). Screenshots: [city-10/](city-10/).

## Requirements

Owner request, in their words: "it automatically continues building itself on the server… a memory file… for users that pick setting it up on a server… continue working on its open world design, continue building structures, buildings, office assets, even when user is offline… through maybe an API key… make sure not to exhaust the user's API credit… little updates per day… reviews, improvements, fixes… for buildings."

The coordinator's seven decisions are recorded in the design doc and kept: data only; rules / free local / premium engines with US$0.05/day and US$1/month caps and worst-case charging; one run a day plus Run now, idempotent across restarts; the world journal; auto-apply with an inbox summary, undo, revert-day and pause; own-server only, off by default; the game re-validates and renders with shipped assets only.

Coordinator answers during the slice (2026-10-25): use CITY-10; skip the onboarding card (Settings is the only entry point for now); keep the fallback rule (a cap or a failed call still grows the day with rule-based growth at US$0 and says why; a malformed answer is a rejected run with no changes).

## Design, as built

| Part | Where | What it does |
| --- | --- | --- |
| Document and rules | `src/shared/world.ts` | Schema of `<dataDir>/world/additions.json`; catalogue of 14 shipped Kenney CC0 models plus 2 procedural plants; 7 lots and 4 façade/terrace anchors; keep-clear boxes; `placementProblem`, `applyChanges` (all or nothing), `undoChange`, `invalidAdditions`, caps (48 total, per kind, 5 a day, ≤ 5 a run) |
| Rule-based growth | `src/shared/world-generator.ts` | Deterministic per seed (local day + revision); repairs first, then fills lots below their density target; honours avoid-rules |
| Journal | `src/shared/world-journal.ts` | Style guide seeded from the districts, run entries (30, then monthly summaries, ≤ 64 KB), ideas, avoid-rules, `journal.md`, the model's JSON data block |
| Service | `src/server/architect.ts` | Settings, engines, money, cadence, strict parsing of model answers, undo/revert, 30-day history, storage safety |
| Host | `src/server/server.ts` | `/api/architect*` (same-origin POSTs), `{t:'architect'}` broadcast, once-a-minute scheduler, inbox both ways |
| Inbox | `src/shared/approvals.ts`, `src/server/approvals.ts`, `src/client/ui/inbox.ts` | New `architect_summary` kind (raised by the chief of staff, tagged "City architect · Rule-based" or the model). Keep changes records it; Revert this day undoes the run after the decision is saved |
| Game | `src/client/world/architect.ts` (+10 lines in `districts.ts`, 9 in `city.ts`) | Validates again with the live district colliders, instanced per model from the already-loaded kit templates, colliders that turn solid only once nobody stands inside, the "Built by the city architect · day · reason" hint, Low and Save-Data show buildings only |
| Settings | `src/client/ui/architect.ts` | "Let the city grow while you're away": on/off, engine, hour, changes per run, caps, pause/resume, Run now, recent runs with Undo and Revert, "Don't build" rules, journal download, estimates labelled |

Fictional city credits are never touched (deliberate choice: none). The architect never calls `claude -p` and never uses a Claude subscription token; premium uses the chief's API-key provider through `llm.ts`.

## Evidence

### Tests (written first: `53a1ff0` committed red)

- `tests/world.test.ts` (14): catalogue equals the manifest; every lot is clear of roads, kerbs, plots and signs, the garage, its door, kerb slots, stairs, helipad, the quay and every district placement and collider; anchors are clear; the hidden-character filter equals FREE-02's; document validation and every rejection rule; caps per kind, total, per run and per day; atomic runs; move/remove/anchor rules; undo and revert; rule-based growth across 120 seeds × 30 days always valid against the live colliders; determinism and repair.
- `tests/world-journal.test.ts` (5): seeding, size limits and monthly summaries, avoid-rules from undo and from the owner, export and data block, malformed journals refused.
- `tests/architect.test.ts` (17): off by default and settings validation; cloud mode unavailable; a rule-based run end to end; cadence at the local hour, idempotent across restarts, Run now once; a restart mid-call is `interrupted` with its worst-case charge kept; pause/resume; premium worst case charged before the call and replaced by the reported cost; no usage or a failed call keeps the worst case; daily and monthly caps block the call and fall back to rules; the month rolls over; missing price/key/model and Ollama down fall back; 14 malformed or malicious answers each become a rejected run with the world unchanged; the prompt's delimited data block; undo, avoid-rule, revert-day and the inbox; 30-day pruning (410); owner avoid-rules honoured over six days; a corrupt `additions.json` refused and preserved; the real `ApprovalInbox` (Keep, Revert this day, restart).
- `tests/architect-server.test.ts` (1): the API over the real host (off by default, Origin check, Run now, once a day, inbox item, undo, journal export, broadcast, decline reverts).

Fake model clients only; every test file replaces `fetch` with a thrower.

### UI check (`tools/architect-ui-check.ts`, fixture `FIXTURE_ARCHITECT=1`, port 5142): 19/19

Covers: off and empty at start; Settings copy; turning it on and saving by keyboard; Run now applies at most 3 rule-based changes at US$0; the game renders exactly what the host reports; a second run refused; the hint; Low and Save-Data show buildings only; no horizontal overflow at 874x402 and 375 px; the phone inbox lists each change with Undo; the desktop inbox shows the tag, engine, cost, Keep and Revert; Undo removes one addition and adds an avoid-rule; Revert this day empties the day; no console errors (desktop, phone, Save-Data).

`ARCH_UI_ONLY=max` against `FIXTURE_ARCHITECT=max` (47 additions): 4/4, all rendered, none skipped, no console errors.

### Screenshots (`docs/team/reports/city-10/`)

| File | Shows |
| --- | --- |
| `02-after-1440x900.jpg` / `01-before-1440x900.jpg` | Same viewpoint after a run and after Revert this day (the new street lamp at the right) |
| `12-max-harbour-1440x900.jpg`, `13-max-meridian-1440x900.jpg` (+ `-phone-874x402`) | The fully grown world: a workshop shed, trees, shrubs, lamps and dumpsters in Harbour works; café parasols, awnings, trees and lamps on the Meridian north verge |
| `05-hint-1440x900.jpg` | "Built by the city architect · 2026-10-25 · A street lamp so the Meridian north-east verge is lit at night" |
| `03-settings-off-1440x900.jpg`, `04-settings-after-run-1440x900.jpg`, `06-settings-phone-874x402.jpg`, `08-settings-375.jpg` | Settings before and after a run, phone and 375 px |
| `09-inbox-summary-1440x900.jpg`, `07-inbox-phone-874x402.jpg` | The daily summary with per-change Undo, Keep changes and Revert this day |
| `10-undo-1440x900.jpg`, `11-reverted-1440x900.jpg` | After one Undo; after Revert this day |

### Performance (FREE-09 method, `CITY_UI_ONLY=perf PERF_OUT=city-10`)

Headless Chrome on ANGLE/Metal, vsync off, Medium preset, the FREE-09 viewpoints plus Harbour. Before: this build's fixture with no architect file. After: the same build with the maximal world (47 of 48 additions; the kind caps stop the 48th). Run back to back. Mean frame time in ms (draw calls). Files: `city-10/perf-before.json`, `city-10/perf-after.json`.

| View | Desktop 1440x900 | Phone 874x402 |
| --- | --- | --- |
| Founding | 5.79 → 4.59 (385 → 405) | 4.46 → 4.75 (440 → 460) |
| Business | 3.70 → 3.98 (181 → 198) | 3.57 → 3.22 (195 → 213) |
| Aerial | 5.07 → 5.72 (322 → 343) | 5.60 → 5.41 (385 → 406) |
| Helipad | 6.47 → 7.11 (436 → 454) | 6.58 → 6.15 (493 → 511) |
| Harbour | 3.75 → 4.25 (144 → 161) | 2.95 → 3.02 (147 → 165) |

Phone regression at most **+0.29 ms** (founding), within the +1.5 ms budget; three phone views were faster, which is run-to-run noise. Cost of the maximal world: +17 to +21 draw calls, about +7,000 triangles, +5 textures (sign text). Measured headless, not on a device.

Deviation from the FREE-09 method: "before" is the same build without additions rather than the base build in a scratch folder. With no additions file the layer builds nothing, so the comparison isolates the cost the architect can add.

### Checks

- `npm run typecheck`: pass
- `npm test`: 1,033 tests, 1,032 pass, 0 fail, 1 skipped (actionlint not installed)
- `npm run build`: pass
- architect-ui-check: 19/19, plus max 4/4
- city-ui-check: 23/23; rides part (`CITY_UI_ONLY=rides`, fresh fixture): 25/25
- mobile-ui-check: 411/411
- inbox-ui-check: 47/47
- onboarding-ui-check: 51/51
- chief-ui-check: 38/38

Screenshots regenerated by the other checks were reverted. Ports used: 5141–5152, all stopped afterwards; 4610, Pixel and `.agent-office` were never touched. No paid calls, no downloads, no new assets.

## Deferred / not verified

- **Onboarding step**: deferred by the coordinator until devtest-02 merges.
- **Interior office decor**: no indoor models are shipped; the "office decor" anchors are building façades and the café terrace. Needs a pinned CC0 pack and its own decision.
- **Founding district growth** and **cloud mode** (shows "not available in cloud mode").
- **Real model runs**: the free and premium engines were exercised only with fake clients. A real Ollama or paid answer was not tried, so the quality of model-proposed changes is unknown; the rules make bad answers harmless (rejected), not good.
- **Device runs**: desktop and phone were checked headless at their viewport sizes, not on real phones.
- **Perf baseline**: same build with and without additions (see above), not the base build.
- **Scheduler over real days**: covered by tests with an injected clock; a host has not been left running past 03:00.
