# CITY-09: the city architect

Owner request (2026-10-25), in their words: "it automatically continues building itself on the server… a memory file… for users that pick setting it up on a server… continue working on its open world design, continue building structures, buildings, office assets, even when user is offline… through maybe an API key… make sure not to exhaust the user's API credit… little updates per day… reviews, improvements, fixes… for buildings."

Base: `codex/empire-world` at `cb70e5f`. Branch: `claude/city-09-architect`. Report: [reports/city-09.md](reports/city-09.md).

> ID note: `TASKS.md` already lists a backlog row `CITY-09 · Cross-device voice, continuity and platform acceptance`. The coordinator assigned this slice as CITY-09 as well. The architect row is added separately and the clash is flagged for the coordinator; the existing row is not renamed here.

## Decisions (made by the coordinator; kept as written)

1. **Data only, never code.** The architect edits one declarative, versioned document, `<dataDir>/world/additions.json`, whose schema lives in `src/shared/world.ts`. It may place, move or remove instances of shipped models on allowed lots, put office-building decor on defined anchors, and add landscaping, lights, signs (sanitised, length-capped text) and repairs. Every change is validated by the same shared rules on the server and in the game. Invalid changes are rejected, never guessed. Model output is untrusted: a strict JSON schema, and the FREE-02 invisible-character and length filters.
2. **Engines and cost**, on `llm.ts` and the chief's engine settings:
   - *Rule-based growth* (no model): a deterministic generator that follows the style guide. US$0 and the default fallback.
   - *Free local model* (Ollama, the chief's local model): US$0.
   - *Premium API key* (the chief's provider, model and price): default caps US$0.05/day and US$1/month, both CEO-editable. Worst-case charging as in FREE-02. It pauses itself at a cap and says so, and never calls when no budget is left. Costs are labelled as estimates.
   - Never `claude -p` with the user's subscription; no Claude tokens (FREE_STACK §9).
3. **Cadence.** At most one run per local day, at a configurable hour (default 03:00), plus **Run now**. At most N changes per run (default 3). The last-run day is persisted before the run starts, so restarts never run a day twice.
4. **Memory: the world journal.** `<dataDir>/world/journal.json` plus a readable `journal.md`: a style guide seeded from the current districts, what was built (when, why), an ideas backlog and owner feedback (undo and "don't build X" become avoid-rules). Size-capped; old entries are summarised. It reaches the model prompt as a clearly marked data block, as FREE-10 lessons do. A new install seeds it from the current world on first use.
5. **Auto-apply, visible and reversible.** Changes apply automatically. Each run writes one inbox item, **City architect daily summary** (changes, cost, engine). Undo one change, revert a whole day, pause and resume. Undo history is kept for 30 days. The city labels the additions ("Built by the city architect"). Provider money never passes the caps; fictional city credits are never touched (deliberate choice: none).
6. **Where it runs.** Own-server installs only (a local office host or a VPS). Off by default. Offered as an optional card at the end of onboarding and in Settings as "Let the city grow while you're away". Cloud mode shows "not available in cloud mode".
7. **Client.** The game loads the additions, validates them again and renders them instanced with the shipped kit models, after the district kits have loaded, with no new downloads. Old saves and installs without the file load unchanged. Desktop and phone; Save-Data and Low quality thin or skip decor.

## The additions document (`src/shared/world.ts`)

```ts
interface WorldDocument { schema: 1; revision: number; additions: WorldAddition[] }
interface WorldAddition {
  id: string;                 // "W12"
  model: CatalogId;           // e.g. "streets/light-square"
  x: number; z: number;       // world metres, multiples of 0.25
  yaw: 0 | 1 | 2 | 3;         // quarter turns
  lot?: LotId;                // exactly one of lot / anchor
  anchor?: AnchorId;
  text?: string;              // signs only: 1–24 of A–Z 0–9 space . , ' & -
  day: string; runId: string; engine: 'rules' | 'free' | 'premium';
  reason: string;             // at most 140 characters, screened
  addedAt: number;
}
```

- **Catalogue**: 16 entries. 14 are models already shipped in the Kenney CC0 kits (no new download): small buildings at kiosk scale, café parasols and awnings, dumpsters, containers and tanks, two lamp types and the street sign. Two are original procedural plants (a round tree and a shrub) built from primitive geometry in the game. Footprints are copied from the kit manifest; a test fails if they drift.
- **Lots**: seven rectangles in the Meridian business district and Harbour works, each with the kinds it allows. A test proves every lot is clear of the roads and kerbs, the plots and their signs, the garage, its door, kerb slots, staircase and helipad, every district placement and collider, and the quay. The founding district (spawn, headquarters) has no lots.
- **Anchors**: fixed façade and terrace points for office-building decor (awnings, parasols); one addition per anchor, exact pose.
- **Rules** (`placementProblem`, `applyChanges`): known model; finite position on the 0.25 m grid; inside a lot that allows its kind and district, or exactly on an anchor that allows it; clear of every keep-clear box; no overlap with other additions; sign text only on signs and sanitised; avoid-rules; caps per kind and in total (48), and per day (5). The game additionally checks every addition against the live district colliders.
- **Atomic runs**: a run's changes apply all together or not at all. One invalid change rejects the whole run with the reason; nothing partial is written.
- **Repairs**: the rule engine first fixes additions that became invalid (moved within their lot, else removed), labelled "Repair".

## Engines, money and cadence (`src/server/architect.ts`)

| Engine | Cost | When it runs |
| --- | --- | --- |
| Rule-based growth | US$0 | Default. Also the fallback when the chosen model engine is not ready or a premium cap is reached (the summary says so). |
| Free local model | US$0 | The chief's local Ollama model. Not ready (Ollama down, model missing) → rule-based that day. |
| Premium API key | estimate, capped | The chief's provider, model and price. No price, key or model → rule-based. |

- Before each premium call the worst case (input-token bound × input price + 900 output tokens × output price) is checked against today's and this month's remaining budget. If it does not fit, no call is made. The worst case is **charged before the call** and replaced by the provider-reported cost only when usage is reported; a failed call or one without usage keeps the worst case. A restart mid-call therefore never under-counts.
- Malformed, unsafe or invalid model output is a **rejected run**: nothing changes, the reason is recorded and the day counts as done.
- The scheduler checks once a minute. A run is due when the architect is on, not paused, the local hour is at or after the run hour and today has no run. A host that was off at 03:00 runs once when it comes back that day. **Run now** performs today's run early; once today's run exists it is refused.
- The run record (status `running`) and the last-run day are saved before any work. A restart finds a `running` run and marks it `interrupted`; it is never retried that day.

## The journal (`src/shared/world-journal.ts`)

- Seeded on first use from the current districts: the business district (towers, café terraces, warm lamps) and Harbour works (containers, tanks, sturdy lamps, hardy trees), density targets per lot, and three starter ideas.
- Each run adds an entry (day, engine, changes with reasons, cost label). At most 60 entries; older ones are summarised by month (at most 24 summaries). Ideas at most 20, avoid-rules at most 40, and the whole file at most 64 KB.
- **Owner feedback**: undoing a placement adds an avoid-rule for that model in that lot; reverting a day does so for each placement; Settings adds "Don't build …" for a model. The generator and the validator both honour avoid-rules. They can be removed in Settings.
- `journal.md` is regenerated on each change and downloadable from Settings.

## Visibility and reversibility

- Inbox item `architect_summary` (raised by the chief of staff, **Rule-based** or **Model-backed** tag): the run's changes with reasons, engine and cost. **Keep changes** records the acknowledgement. **Revert this day…** undoes every change of that run. Each change has its own **Undo**.
- Settings → *Let the city grow while you're away*: on/off, engine, run hour, changes per run, daily and monthly caps, pause/resume, Run now, recent runs with Undo and Revert day, avoid-rules, journal download, and spend shown as estimates.
- In the city, walking up to an addition shows "Built by the city architect · 2026-10-25 · reason". Additions are never shown as agent work or verified outcomes.

## API (own-server host only; POSTs need a same-origin Origin)

- `GET /api/architect` → state (settings, engine status, budget, runs, world, journal summary).
- `POST /api/architect/settings`, `/run`, `/undo {changeId}`, `/revert {runId}`, `/avoid {model, lot?}`, `/avoid/remove {id}`.
- `GET /api/architect/journal.md`.
- The state is also broadcast to game clients as `{ t: 'architect', state }`.

## Performance budget

At most 48 additions, instanced per model (one draw call per model primitive, not per instance), at most 4 signs. Low quality shows buildings only; Save-Data drops decor, plants, lamps and signs. Acceptance: phone frame time within +1.5 ms on the FREE-09 method with a maximal world.

## Tests (written first)

Schema validation and every rejection rule; money caps (daily, monthly), changes per run, total instances; worst-case charging and pause at the cap; per-day idempotency across restarts; undo and revert-day; journal limits and avoid-rules; the rule-based generator producing only valid layouts across many seeds; malformed and malicious model output becoming a rejected run; server-only gating. Fake model clients only.

## Out of scope / deferred

- Interior office decor (no indoor models are shipped; would need a new pinned pack). The anchors are building façades and terraces.
- Cloud mode (GitHub Actions) and the cloud coordinator.
- Growing the founding district.
