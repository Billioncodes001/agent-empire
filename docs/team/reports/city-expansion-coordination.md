# CITY-01 coordination report

Planning only, 2026-09-27. Research started at `e67f7b2`; the roadmap baseline is `79fd05c`, recorded in `30061f4`. The coordinating Codex chat advanced documentation/configuration to `c1fa152` during this run. No product code, new worktrees, model downloads, recordings, paid product-provider calls, or live-save/server changes. The backend did issue read-only VoiceStudio discovery requests before cancellation; the native coordinator did not commit or push. Parent coordination committed and pushed the roadmap and agent configuration separately.

**Outcome: not ready to assign CITY-02..08.** Interface contracts were returned and reviewed. Backend contracts are missing because that dispatch was cancelled without output.

## Delegation evidence

| Role | Requested (agent file) | Harness-reported model | Result |
| --- | --- | --- | --- |
| Empire Interface | Claude Opus 5.5 | `claude-opus-5.5` | Completed, 1 turn, read-only. **The agent reported its own model as "Claude Opus 4.8".** This conflict is unresolved. |
| Empire Backend | GPT-5.3-Codex | `gpt-5.3-codex` | **Cancelled after 389 s with 0 turns and no output.** Not retried with another model, per instruction. |
| Empire Review | Grok 4.7 | `grok-4.7` | Completed, read-only. The agent said its model was not exposed. |

The named custom agents were dispatched natively from one session. Model routing is only partly proven. The harness labels match the requested models, but one self-report contradicts its label, and the Backend route produced nothing.

## Interface contract (proposed, not implemented)

- **Phone:** `closed → opening → open(home|contacts|messages|tasks|map|reports|call) → closing`.
  - While open, movement is disabled and keys are cleared.
  - It joins the existing `modalOpen()` gate in `src/client/ui/dom.ts`.
  - Focus is trapped, Esc closes it, and touch targets are at least 44 px.
- **Contact:** `{workerId, siteId, name, status, freshness, availability}`.
  - Built only from real workers and the chief.
  - Freshness must come from `evidence()` in `src/client/ui/status.ts`, carrying `observedAt`. It must not come directly from `store.workers`. The chief's phases need an explicit mapping to availability.
- **Call:** `dialing → awaiting server ack → connected(source) → reply|busy|unavailable|failed|cancelled → ended`.
  - The UI shows "connected" only after the server acknowledges.
  - `source` is `rule_based|agent`.
- **Messages the client expects:**
  - `phone.call{callId, workerId, mode}`
  - `phone.say{callId, text, final}`
  - `phone.cancel{callId}`
  - `phone.state{callId, phase, source, taskId?, workerId, reply?, error?, at}`

  These do not exist in `src/shared/protocol.ts`, where the existing `voice` and `chat` messages are peer features. **Backend must own and confirm them.**
- **Voice client:** `setup → consent → ptt-held → transcribing → final transcript (sent once) → speaking + subtitles`. Cancel and text fallback are available at every step. Missing ASR fails closed.
- **Traversal:** `on-foot|entering|seated|exiting|flying|landing` with `{vehicleId, seat, t0, fromPose}`.
  - Interruptions reverse from the current pose, with no teleport.
  - The flight camera is a separate mode: `clamp(8 + alt × 0.6, 8, 125)`. It does not replace street zoom (2.5–125 m).
  - This extends today's four `Traversal` kinds in `src/client/traversal.ts`.
- **Plots:** metres, +Y up, `{id, district, x, z, w, d, entrance:{x,z}}`.
  - The existing HQ (-24, 48) and home (24, 48) positions, and their door offsets from `entrance()`, stay unchanged.
  - `CITY` and `MAP_BOUNDS` must be reconciled.
- **Assets:** 1 unit = 1 m, glTF +Y up, a humanoid rig about 1.75 m tall.
  - Licences are CC0, MIT or Rocketbox, recorded in `THIRD_PARTY_NOTICES.md`.
  - Vehicles are at most 60k triangles with 2k textures; the city uses instancing.
  - Frame budgets are set only after measurement.

## Backend contract: unknown (required before assignment)

No Backend findings exist. Review and the roadmap require Backend to define:

- **Typed phone/call messages:**
  - an idempotency key per final utterance
  - a permission check against the target worker
  - `source`, plus one task owner through the existing queue and task path
  - no task row or reward without a queue ack
  - restart recovery
- **Speech adapter** (mic → ASR → dispatch → TTS):
  - readiness states `installed|loaded|ready|error` and a fake adapter
  - Electron bridge limits and cancellation, with no credentials in the renderer
  - a paired authenticated HTTPS host for web and mobile
- **Save schema:**
  - raise `EmpireState.version` from 2
  - preserve `SupervisionState` as regenerated runtime evidence; do not restore a previously saved projection as live truth
  - migration tests for vehicles, garage slots, condition, location, phone unread state, consent and plots

The consolidated contract relies on VoiceStudio facts already recorded in the roadmap. Discovery was also attempted by Backend, but it returned no final contract. The streaming WebSocket is untested, and no ASR model is installed.

## Review findings (Grok, code inspection only, no tests run)

- **High:**
  - The phone and speech protocol does not exist, and there is no idempotency or permission check, so tasks could be dispatched twice.
  - There is no save versioning or migration for the new state.
  - The contact freshness model bypasses `evidence()`.
- **Medium:**
  - The traversal state machine is new behaviour, not existing behaviour.
  - Adding phone/talk keys to `sanitizeKeys` needs a migration, otherwise it resets remapped bindings. There is no touch binding.
  - Flight zoom must be kept separate from street zoom.
  - The landing slope check needs terrain data beyond `vehicleOverlaps`.
  - Changing plot dimensions can move doors.
  - The mobile host and renderer credential policy are unspecified.
- **Low:** `player.enabled` and `modalOpen()` can get out of sync.
- **Coordinator correction:** Review said CITY-02..08 IDs are missing. The IDs are in `TASKS.md`, not in the roadmap.

## Dependencies and acceptance checks (to hold once the Backend contract exists)

- **CITY-02**
  - Depends on the Backend phone protocol.
  - Checks:
    - movement stops while the phone is open
    - unavailable, busy and stale states render correctly
    - no success shows without a server `phone.state`
    - one final utterance creates exactly one dispatch, including after a duplicate or retry
    - a keyboard-only walkthrough passes
    - existing key remaps survive migration
- **CITY-03/04**
  - Depend on the speech adapter plus CITY-02.
  - Checks:
    - consent is given before the microphone opens
    - the fake adapter passes end to end
    - missing ASR fails closed to text
    - cancel works at every stage
    - there is no credential in the renderer
  - Real ASR smoke testing stays blocked because no model is installed.
- **CITY-05/06**
  - Depend on the save schema.
  - Checks:
    - a blocked door is refused
    - an interrupted sequence recovers with pose jumps no larger than 0.05 m per frame
    - an occupied spawn is refused
    - ownership, location and condition survive a reload, with migration tests
- **CITY-07**
  - Depends on the plot schema.
  - Checks:
    - every entrance is on a sidewalk reachable by road
    - the HQ and home doors are unchanged
    - the assigned-worker entry rule still holds
- **CITY-08**
  - Depends on CITY-06 and CITY-07.
  - Checks:
    - landing is refused on slopes over 10° or on collision
    - the altitude camera curve is tested and separate from street zoom
    - state is recovered after a restart

## Next step (not started)

Dispatch Backend again on its configured model for the same read-only contract task. Then send its result and this Interface contract to Review. Only then mark CITY-01 complete and assign CITY-02.

## Parent review and corrections

- Cancellation coincided with a follow-up that asked the coordinator to bound research. Do not assume a follow-up can safely steer active child tasks in this harness. Put limits in the initial assignment and wait for native completion. A run that is still active must not be described as having returned a final result.
- The interface model's self-description is weaker evidence than the harness routing metadata. Keep the discrepancy, but do not run extra requests merely to ask a model its name. The backend model route appeared in the UI, but completion is unverified.
- Findings about absent phone/flight schemas are requirements for unimplemented features, not demonstrated exploitable defects in today's app. Do not persist supervision timestamps/phases as live evidence; the current monitoring design regenerates them. Version changes require an actual compatibility decision, not an automatic bump before a schema is agreed.
- Proposed triangle counts, flight distance curves, landing angles and per-frame pose thresholds are provisional. Validate them against measured hardware, frame rate, real assets and terrain before making them fixed acceptance limits.
- Future UI assignments must include root AGENTS.md and `docs/team/DESIGN_STANDARD.md`, added following the user's standing instruction during this run. The original feature roadmap remains recorded; CITY-01 being incomplete does not remove its requested features.
- This run proves one-window native dispatch and return for Interface and Review, not unattended or reliably cheaper orchestration. Backend completion and implementation/integration handoffs still need bounded verification. The next planning task is limited to six tool rounds and one discovery batch; reuse the recorded readiness facts.
