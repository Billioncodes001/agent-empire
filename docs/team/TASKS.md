# City expansion task ledger

Update on meaningful transitions only. Roadmap: [CITY_EXPANSION_PLAN.md](CITY_EXPANSION_PLAN.md). No feature below is implemented by this planning document.

| ID | Slice | Owner | Depends on | State | Acceptance / evidence |
| --- | --- | --- | --- | --- | --- |
| CITY-00 | Roadmap recorded before coding | Coordinator | — | Complete | Commit 30061f4 |
| CITY-01 | One-window coordinator and model-specific planning handoff | Coordinator + specialists | CITY-00 | Complete — planning trial | [Report](reports/city-expansion-coordination.md). Native UI confirms Interface Claude Opus 5.5, Backend retry GPT-5.3-Codex (23s), Review Grok 4.7 and completed coordinator session. First backend attempt cancelled; bounded retry succeeded. Parent consolidated scope/auth/privacy. No product edits |
| CITY-02 | Phone, contacts and truthful text chief call | Interface + Backend | CITY-01 | Ready for scoped implementation | Read-only rule-based report, existing authenticated transport, no task/reward writes; selected worker identity, current reports, unavailable state, preserved remaps, accessible controls and DESIGN_STANDARD.md evidence |
| CITY-03 | VoiceStudio discovery and first-launch voice setup | Backend + Interface | CITY-01 | Backlog | Installed-model health, microphone permission/test, skip/text fallback, explicit download choice |
| CITY-04 | Push-to-talk worker and chief conversation | Backend + Interface | CITY-02, CITY-03 | Pending integration and smoke test | MLX large-v3 and sherpa Whisper Tiny installed by user request; both default readiness checks pass. Turbo also installed. Transcribe a fixture and integrate; finalized transcript sent once, response/subtitles/audio/cancel |
| CITY-05 | Garage and persistent vehicle ownership | Backend + Interface | CITY-01 | Backlog | Save/restart, slots/credits, occupied spawn, physical garage entry |
| CITY-06 | Authored car entry/exit and sound timing | Interface | CITY-05 | Backlog | Door/hand/seat alignment, blocked exit, interruption recovery, camera continuity |
| CITY-07 | Expanded district layout and rendering | Interface + Backend | CITY-01 | Backlog | Roads/plots/save schema, altitude terrain coverage, measured graphics presets |
| CITY-08 | Helicopter boarding, flight and aerial camera | Interface + Backend | CITY-06, CITY-07 | Backlog | Actual flight/altitude, remapping, collisions/landing, uninterrupted city panorama |
| CITY-09 | Cross-device voice, continuity and platform acceptance | Backend + Review | Feature slices | Backlog | Provider outputs/save sync tracked separately; macOS/Windows/web/Android/iOS evidence without unsupported offline claims |

Known protected runtime: localhost:4610, Pixel and its save. Development should use isolated fixtures and ports. Proposed traffic/weather/service systems remain a later backlog, not silently added to the first feature slice.

## Consultancy operation

| ID | Slice | State | Evidence / next dependency |
| --- | --- | --- | --- |
| CONSULT-01 | Durable client jobs and approved local dispatch | Implemented and reviewed | Native backend 7af1506; combined candidate 6517da6; final reporting repair033e5f8 independently accepted. Authenticated API, duplicate-safe approval, queue identity, interrupted-work attention, storage failure checks; real server with fake worker runs without a game connection |
| CONSULT-02 | Owner-only Telegram commands and updates | Implemented; not connected to a real bot | Shared domain records, private owner allowlist, durable cursor, shutdown-generation guards, 12 fake-transport tests; host configuration still required |
| CONSULT-03 | Founder desk | Initial interface implemented | Brief/review/approval/decline and current capacity; desktop and 375px browser acceptance. Founder phone, resource requests and credential wizard remain pending |
| CONSULT-04 | Model chief, scaling, dependencies and cloud jobs | Backlog | Current chief is deterministic and uses one host repository; automatic expansion and provider job unification are not implemented |
| CONSULT-05 | Employee routines and reviewed organizational memory | Backlog | Coffee/breaks/meetings/gym linked to scheduling, persistent roles and scoped lessons remain planned |
