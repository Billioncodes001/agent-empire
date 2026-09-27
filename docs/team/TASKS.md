# City expansion task ledger

Update on meaningful transitions only. Roadmap: [CITY_EXPANSION_PLAN.md](CITY_EXPANSION_PLAN.md). No feature below is implemented by this planning document.

| ID | Slice | Owner | Depends on | State | Acceptance / evidence |
| --- | --- | --- | --- | --- | --- |
| CITY-00 | Roadmap recorded before coding | Coordinator | — | Complete | Commit 30061f4 |
| CITY-01 | One-window coordinator and model-specific planning handoff | Coordinator + specialists | CITY-00 | Ready for bounded validation | Actual delegation/results; compact consolidated contract report; no product edits |
| CITY-02 | Phone, contacts and truthful text chief call | Interface + Backend | CITY-01 | Backlog | Selected worker identity, current reports, unavailable state, accessible controls |
| CITY-03 | VoiceStudio discovery and first-launch voice setup | Backend + Interface | CITY-01 | Backlog | Installed-model health, microphone permission/test, skip/text fallback, explicit download choice |
| CITY-04 | Push-to-talk worker and chief conversation | Backend + Interface | CITY-02, CITY-03 | Blocked for real ASR smoke test | No ASR model installed; use fake adapter during development; finalized transcript sent once, response/subtitles/audio/cancel |
| CITY-05 | Garage and persistent vehicle ownership | Backend + Interface | CITY-01 | Backlog | Save/restart, slots/credits, occupied spawn, physical garage entry |
| CITY-06 | Authored car entry/exit and sound timing | Interface | CITY-05 | Backlog | Door/hand/seat alignment, blocked exit, interruption recovery, camera continuity |
| CITY-07 | Expanded district layout and rendering | Interface + Backend | CITY-01 | Backlog | Roads/plots/save schema, altitude terrain coverage, measured graphics presets |
| CITY-08 | Helicopter boarding, flight and aerial camera | Interface + Backend | CITY-06, CITY-07 | Backlog | Actual flight/altitude, remapping, collisions/landing, uninterrupted city panorama |
| CITY-09 | Cross-device voice, continuity and platform acceptance | Backend + Review | Feature slices | Backlog | Provider outputs/save sync tracked separately; macOS/Windows/web/Android/iOS evidence without unsupported offline claims |

Known protected runtime: localhost:4610, Pixel and its save. Development should use isolated fixtures and ports. Proposed traffic/weather/service systems remain a later backlog, not silently added to the first feature slice.
