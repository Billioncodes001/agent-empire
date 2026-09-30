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
| CONSULT-03 | Founder desk | 3D redesign implemented and reviewed | Architectural Three.js hero, Figma desktop/mobile and interaction prototype, responsive brief/review/approval flows. [Design acceptance](reports/founder-3d-design.md). Founder phone, resource requests and credential wizard remain pending |
| CONSULT-04 | Model chief, scaling, dependencies and cloud jobs | Backlog | Current chief is deterministic and uses one host repository; automatic expansion and provider job unification are not implemented |
| CONSULT-05 | Employee routines and reviewed organizational memory | Backlog | Coffee/breaks/meetings/gym linked to scheduling, persistent roles and scoped lessons remain planned |

## Maintenance

| ID | Slice | State | Evidence / next dependency |
| --- | --- | --- | --- |
| MAINT-01 | Codebase audit fixes (server crash guard, safe saves, ledger, client leaks/a11y, share/voice, Android error page) | Reviewed and accepted; merged by PR #2 | [Report](reports/audit-fixes.md). Candidate 547e42c accepted with fixes; fixes 464e8d4 and 030e5c7 accepted. 201/201 tests, desktop + 375px browser check, macOS/Windows/Android packaging evidence. Windows runtime, Android authenticated login and iOS build remain unverified |

## Office life, organization and mobile game

Plan: [OFFICE_LIFE_AND_MOBILE_PLAN.md](OFFICE_LIFE_AND_MOBILE_PLAN.md).

| ID | Slice | State | Evidence / next dependency |
| --- | --- | --- | --- |
| MOBILE-01 | Splash, loading progress, game menu, Empire sign-in | Reviewed and accepted | [Report](reports/mobile-game.md). The loading bar is driven by real file counts. Menu on touch and the backtick key. Empire sign-in |
| MOBILE-02 | Landscape touch controls (joystick, jump, run, camera) | Reviewed and accepted | tools/mobile-ui-check.ts 113/113 at 667×375–1024×768 landscape, 375×812 portrait and desktop. Chrome device emulation only; no iOS WebKit landscape or physical-device run yet |
| MOBILE-03 | Phone HUD and camera framing | Reviewed and accepted | One-row top bar, compact minimap, safe-area insets |
| MOBILE-04 | Native launch screens (superseded by APP-03/04) | Superseded | iOS simulator build of the old companion succeeded on Xcode 27 / iOS 27. The user chose bundled game apps |
| APP-01 | Server device tokens, bearer auth, CORS for app origins | Reviewed and accepted | [Report](reports/app-device-auth.md). Security review accepted after fixes c791b97 |
| APP-02 | Client configurable server base and token | Planned | APP-01 |
| APP-03 | iOS bundled game app (native launch/connect, Keychain, scheme handler, landscape full-screen) | Planned | APP-01/02, MOBILE-01/02 |
| APP-04 | Android bundled game app | In progress | APP-01/02, MOBILE-01/02. First screen becomes the CLOUD-03 mode choice |
| CLOUD-01 | State repository schema and headless coordinator tick | Planned | [Cloud mode plan](CLOUD_MODE_PLAN.md). The user chose GitHub-hosted cloud mode (2026-09-30) |
| CLOUD-02 | Actions coordinator workflow and installer | Planned | CLOUD-01 |
| CLOUD-03 | First-launch setup: cloud accounts or own server | Planned | Replaces the APP-03 server-address-first connect screen |
| CLOUD-04 | Client cloud adapter (state repo snapshots and intents) | Planned | CLOUD-01, CLOUD-03 |
| CLOUD-05 | In-app shut down and start | Planned | CLOUD-02 |
| CLOUD-06 | OpenAI Agents adapter | Planned | — |
| APP-05 | Desktop bundled remote mode | Planned | APP-01/02 |
| LIFE-01 | Jump and landing animation, locomotion polish | Reviewed and accepted | [Report](reports/office-life.md). No idle clip in mid-air |
| LIFE-02 | Gym, cafeteria/breakfast, coffee amenities | Reviewed and accepted | Built from primitives on every HQ floor, with colliders and clearance tests |
| LIFE-03 | Worker routines driven by real states | Reviewed and accepted | Idle/done workers take breaks; stale/offline workers never walk. Review fixes 88cd160 |
| LIFE-04 | Task dependencies (`waitingOn`) | Backlog | Needs backend lane |
| LIFE-05 | Character variety and Blender pipeline | Backlog | Blender not installed on this host |
| ORG-01..06 | Executives, estimates, approval desk, marketing, research, onboarding | Backlog | Follows CONSULT-04 |
