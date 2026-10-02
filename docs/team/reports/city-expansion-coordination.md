# CITY-01 coordination report

Planning only, 2026-09-27. Research started at `e67f7b2`; the roadmap baseline is `79fd05c`, recorded in `30061f4`. The coordinating Codex chat advanced documentation/configuration to `c1fa152` during this run. No product code, new worktrees, model downloads, recordings, paid product-provider calls, or live-save/server changes. The backend did issue read-only VoiceStudio discovery requests before cancellation; the native coordinator did not commit or push. Parent coordination committed and pushed the roadmap and agent configuration separately.

**Outcome (second trial, from `7bf404f`): CITY-01 planning coordination is complete. CITY-02 is ready for a bounded implementation assignment using the parent consolidation below.**

- Interface, Backend and Review have all returned results through native dispatch on their configured models.
- Parent review resolves the addendum below. Exact API types and tests are implementation work; no additional user approval is needed for these routine design decisions.
- The first trial is kept below as history.

## Delegation evidence

| Role | Requested (agent file) | Harness-reported model | Result |
| --- | --- | --- | --- |
| Empire Interface | Claude Opus 5.5 | `claude-opus-5.5` | Completed, 1 turn, read-only. **The agent reported its own model as "Claude Opus 4.8".** This conflict is unresolved. |
| Empire Backend | GPT-5.3-Codex | `gpt-5.3-codex` | **Cancelled after 389 s with 0 turns and no output.** Not retried with another model, per instruction. |
| Empire Review | Grok 4.7 | `grok-4.7` | Completed, read-only. The agent said its model was not exposed. |
| Empire Backend (retry, 2nd trial) | GPT-5.3-Codex | `gpt-5.3-codex` (requested explicitly; same model, not a substitute) | Completed, synchronous. The agent reported reading only `src/shared/protocol.ts` and `src/server/queue.ts`. It was told not to run terminal or network calls; the coordinator relied on that instruction and did not check the tool log. It was not asked to identify itself. |
| Empire Review (2nd trial) | Grok 4.7 | `grok-4.7` (requested explicitly) | Completed, synchronous. It was told to use no tools and reviewed only the supplied text. |

Parent UI verification: native subagent badges showed `city01-backend-retry` using GPT-5.3-Codex and completing in 23 seconds, and `city01-review-final` using Grok 4.7 and completing in 1 minute 8 seconds. The coordinator session then showed Completed. These observed harness labels provide routing evidence for the second trial, independent of model self-description. Interface, Backend and Review all returned through one native session. This proves a bounded planning handoff, not unattended operation, lower token cost, or a tested code integration workflow.

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

## First trial: Backend contract gap (history)

No final Backend findings were returned in the first trial. Review and the roadmap required Backend to define:

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

The consolidated contract relies on VoiceStudio facts already recorded in the roadmap. Discovery was also attempted by Backend, but it returned no final contract. At that first-trial checkpoint the streaming WebSocket was untested and no ASR model had been verified. Current installation readiness is recorded below and in the roadmap.

## First trial: review findings (history; Grok, code inspection only, no tests run)

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

## Second trial: Backend contract (GPT-5.3-Codex; details are provisional unless marked grounded)

- **Grounded in `src/server/queue.ts`:**
  - The queue removes duplicates by `jobKey` and by active issue.
  - Launch is journaled in two steps: mark `running` and persist, spawn, then persist the worker link.
  - `queue.json` is written atomically.
  - On restart, in-flight `running` tasks become interrupted, with reason `server_restart`.
  - Each retry increments `attempt`. It is blocked while the previous worker process is still running or its state is unknown.
- **Dispatch (provisional):**
  - Messages: `phone.call`, `phone.say` and `phone.cancel`, with `phone.state` pushed by the server.
  - A final `phone.say` must carry an `utteranceId`.
  - The duplicate-prevention key is `callId:utteranceId`. It maps to the queue `jobKey` `phone-{workerId}-{callId}-{utteranceId}`.
  - Permission is checked before the task is queued; a failure returns `phone.state{phase:error}`.
  - A task requires a durable queue acknowledgement. Reward eligibility must additionally follow verified execution outcomes; queueing alone never earns a reward.
- **Speech (provisional):**
  - Readiness values: `tts_ready | tts_only_text_input | unavailable`.
  - Missing ASR blocks voice capture and forces text input.
  - The retry proposed cancellation across all stages. Parent correction: call/playback cancellation and task cancellation are separate operations; an acknowledged durable task remains unless an explicit task-cancel request is accepted.
  - Audio is kept only temporarily.
- **Persistence (provisional):**
  - Garage and vehicles, phone unread/attention/consent, and plots are added as optional fields with defaults.
  - `SupervisionState` stays regenerated runtime evidence and is never saved as live truth.
  - The version is bumped only if the required shape changes.
- **Open questions:**
  - which source is authoritative for authentication
  - where the canonical reward trigger point is
  - the exact `phone.state.phase` values
  - whether the client or the server generates `utteranceId`

## Second trial: review (Grok; text only, no tools)

**Original text-only verdict:** resolve the addendum before assigning CITY-02. Parent consolidation below addresses the applicable requirements; these were proposal findings, not tested runtime defects.

- **High:**
  - Review interpreted missing ASR as a conflict. Parent correction: disabling voice capture while allowing text input satisfies both proposals.
  - `phone.say` lacks the `utteranceId` and `workerId` that the queue key needs.
  - Non-final `say` messages are not prevented from being queued.
  - The phase values are undecided and omit `interrupted` / `server_restart`. After a restart, the UI could still show "connected".
  - The authentication source and reward trigger are undecided.
  - `queue.json` may keep the typed text.
  - Microphone consent is only an optional saved field.
- **Medium:**
  - The chief's availability mapping and the `observedAt` stale threshold are undefined.
  - `phone.call.mode` is not explained.
  - Duplicate prevention by active issue could collide with non-phone work.
  - "Movement disabled" does not cover vehicles.
  - CITY-02 is phone UI, so the design standard applies to it now, not later.

## CITY-02 implementation boundary (parent consolidation)

1. Start with the phone shell, truthful contacts and a **read-only chief report**, explicitly labelled `source: rule_based`. No AI reasoning call, worker launch, task-queue write, reward, microphone capture, TTS or map expansion in this slice. This is the first usable increment, not the final voice-call experience.
2. Backend owns the shared protocol. Proposed phases are `dialing|awaiting|connected|reply|busy|unavailable|interrupted|failed|cancelled|ended`; finalize exact types with tests before Interface consumes them. A call becomes connected only on server acknowledgement. Disconnect/restart must invalidate an old connection immediately; a disconnected server cannot send a final event until transport returns.
3. Reuse existing authentication: `Auth.fromRequest(req)` validates the session for HTTP and WebSocket upgrade in `src/server/server.ts`; preserve the existing origin checks. Never trust a client-supplied worker ID as identity or permission. Future task dispatch must additionally validate the target against authoritative server project/worker state and existing task authority.
4. CITY-02 uses transient call state. There is no task journal write to erase on hang-up. Later worker-task prompts may persist in the existing durable task journal: do not delete task history on call end or promise it is transient. Microphone permission must be checked at capture time; saved setup preferences never authorize recording by themselves.
5. Missing ASR disables microphone capture and offers text. Call/playback cancellation does not cancel an already accepted worker task. Explicit task cancellation requires its own acknowledged result in CITY-04.
6. Define the chief availability mapping and freshness threshold from real evidence. Stop on-foot and vehicle movement while the phone captures input. Preserve key remaps and accessible keyboard/touch control.
7. CITY-04 will add finalized utterance IDs, duplicate prevention, target authorization and verified-result reward handling through the existing task service. Queue acknowledgement alone is not a completed job. Those requirements must be tested on the selected task path rather than assumed from the planning sketch.

Parent verification was source inspection of existing authentication and supervision persistence, not an implementation or runtime test of any proposed phone API.

## Dependencies and acceptance checks (planned implementation)

- **CITY-02**
  - Depends on the Backend phone protocol.
  - Checks:
    - movement stops while the phone is open
    - unavailable, busy and stale states render correctly
    - no success shows without a server `phone.state`
    - duplicate requests cannot create tasks or rewards in this read-only slice
    - a keyboard-only walkthrough passes
    - existing key remaps survive migration
    - disconnect/restart clears obsolete connected state
    - an unauthorised target is rejected
    - transient call state clears on end without changing durable task history
    - it meets [DESIGN_STANDARD.md](../DESIGN_STANDARD.md) and root `AGENTS.md`:
      - desktop and 375 px screenshots with no horizontal overflow
      - no console errors
      - Esc closes and focus is trapped, with visible focus
      - touch targets of at least 44 px
      - reduced-motion and Save-Data are respected
      - status is not shown by colour alone
      - text fallback and captions are present
    - The design standard applies to every later UI slice (03, 05–08) as well.
- **CITY-03/04**
  - Depend on the speech adapter plus CITY-02.
  - Checks:
    - consent is given before the microphone opens
    - the fake adapter passes end to end
    - missing ASR fails closed to text
    - call cancellation stops capture/playback; explicit task cancellation has a separate acknowledged outcome
    - finalized utterances dispatch at most once across duplicate/retry paths; restart preserves durable task state
    - queue acknowledgement does not award completion credits
    - there is no credential in the renderer
  - Installation update: Turbo, MLX Whisper large-v3 and sherpa Whisper Tiny are installed. The latter two were downloaded on the user's explicit request; both default readiness checks now pass. A real transcription smoke test and game integration remain pending. See the updated roadmap readiness section.
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

Assign CITY-02 to Interface and Backend in separate, verified worktrees at an exact baseline. Backend owns shared protocol files; Interface builds against that contract. Review the exact candidate commits before integration. CITY-03 can develop readiness and a fake speech adapter without an ASR download. Turbo and both requested default recognition models are now installed; transcription and dictation readiness checks pass. Proceed to fixture transcription and game integration testing without another model download. Vehicle, district and helicopter work remains sequenced backlog, not blocked on a new user approval.

## Parent review and corrections

- Cancellation coincided with a follow-up that asked the coordinator to bound research. Do not assume a follow-up can safely steer active child tasks in this harness. Put limits in the initial assignment and wait for native completion. A run that is still active must not be described as having returned a final result.
- The interface model's self-description is weaker evidence than the harness routing metadata. Keep the discrepancy, but do not run extra requests merely to ask a model its name. The first backend attempt did not complete; the bounded second attempt did, with native UI model evidence recorded above.
- Findings about absent phone/flight schemas are requirements for unimplemented features, not demonstrated exploitable defects in today's app. Do not persist supervision timestamps/phases as live evidence; the current monitoring design regenerates them. Version changes require an actual compatibility decision, not an automatic bump before a schema is agreed.
- Proposed triangle counts, flight distance curves, landing angles and per-frame pose thresholds are provisional. Validate them against measured hardware, frame rate, real assets and terrain before making them fixed acceptance limits.
- Future UI assignments must include root AGENTS.md and `docs/team/DESIGN_STANDARD.md`, added following the user's standing instruction during this run. The original feature roadmap remains recorded; completion of CITY-01 planning does not imply delivery of its requested gameplay features.
- This run proves one-window native dispatch and return for Interface, Backend and Review, not unattended or reliably cheaper orchestration. Implementation/integration handoffs still need verification on real candidate commits. Reuse recorded readiness facts and set limits in the initial assignment. Normal tool approvals remain enabled; VS Code and the active agent session must remain available.
