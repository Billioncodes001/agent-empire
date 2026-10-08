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
| APP-02 | Client configurable server base and token | Reviewed and accepted | [iOS report](reports/ios-app.md). A single endpoint helper adds the bearer token only for the signed-in server; WebSocket subprotocol token |
| APP-03 | iOS bundled game app (launch, bridge, Keychain, scheme handler, landscape full-screen) | Reviewed and accepted | [Report](reports/ios-app.md), [polish](reports/mobile-polish.md). iPhone 18 Pro simulator walk with real taps. Open: the first tap on the founder name field opens no keyboard on the simulator; check on a real device. No device, TestFlight or signing yet |
| APP-04 | Android bundled game app | Reviewed and accepted | [Report](reports/android-app.md), [polish](reports/mobile-polish.md). Pixel 7 / API 35 emulator walk with real taps. Not run: API < 30, physical device, Play signing |
| CLOUD-01 | State repository schema and headless coordinator tick | Reviewed and accepted | [Report](reports/cloud-coordinator.md). Three money-safety review rounds. Fake GitHub/Anthropic only; first real run follows the report's checklist with owner approval |
| CLOUD-02 | Actions coordinator workflow and installer | Reviewed and accepted (fakes only) | [Report](reports/cloud-mode-e2e.md), [execution setup](reports/cloud-exec-setup.md). "Create my Empire" runs a resumable installer; the coordinator bundle ships in the client; fixture builds are refused at packaging. The coordinator provisions the Anthropic agent and environment from the sealed key. Owner defaults (2026-10-02): Sonnet 5, sandbox self-approval, unrestricted networking. Prices verified against the official pricing page on 2026-10-02. First real run: owner-approved checklist |
| CLOUD-03 | First-launch setup: cloud accounts or own server | Reviewed and accepted | [Report](reports/first-launch-setup.md). Mode choice, the server path end to end, and the cloud path through GitHub device sign-in (client id Ov23li3G3aR4rgZ0lCJ3), repositories, keys (libsodium sealed box), limits and review |
| CLOUD-04 | Client cloud adapter (state repo snapshots and intents) | Reviewed and accepted (fakes only) | Snapshots with ETag polling and honest age labels; UUIDv7 intents checked by the coordinator's parser; cloud-aware founding with explicit paid confirmation |
| CLOUD-05 | In-app shut down and start | Reviewed and accepted (fakes only) | Menu control with a full-effect confirmation; shutdown and start intents plus a wake-up dispatch |
| CLOUD-06 | OpenAI Agents adapter | Planned | — |
| APP-05 | Desktop bundled app (macOS/Windows) | Reviewed and accepted | [Report](reports/desktop-app.md). Bundled game, shared setup with a desktop-only "Run on this computer" card (main-process confirmation only), safeStorage bridge. Packaged-macOS CDP walk done; Windows packaged and checked but not run; unsigned |
| LIFE-01 | Jump and landing animation, locomotion polish | Reviewed and accepted | [Report](reports/office-life.md). No idle clip in mid-air |
| LIFE-02 | Gym, cafeteria/breakfast, coffee amenities | Reviewed and accepted | Built from primitives on every HQ floor, with colliders and clearance tests |
| LIFE-03 | Worker routines driven by real states | Reviewed and accepted | Idle/done workers take breaks; stale/offline workers never walk. Review fixes 88cd160 |
| LIFE-04 | Task dependencies and recreation while waiting (`waitingOn`) | Reviewed and accepted | [Report](reports/life-04.md). Queue dependencies (held on failure, never auto-run), sequential client-job steps with `parallel` opt-out, desk continuity from the dependency's branch, server `waitingOn` → recreation with "Waiting on X — at the coffee bar". Review ACCEPT WITH FIXES (critical send-home retry loop, continuity scope, identity honesty, reservations, stuck items) → re-review ACCEPT; two leftovers fixed by coordinator. 579/579 tests, life04-ui-check 16/16, mobile 411/411. Not built: UI to add dependencies to free-text tasks; whiteboard blocked rows |
| LIFE-05 | Character variety and Blender pipeline | Backlog | Blender not installed on this host |
| REL-06 | In-app update device re-run after the security fixes | Reviewed and accepted | [Report](reports/update-device-rerun.md). macOS packaged app and iPhone 18 Pro simulator pass every check; Android 15 emulator passes except the shell's own signature check, which then fell open. Fixed: genuine Android updates refused (Keystore), unreadable dark-dialog status lines, Android now verifies with its own RFC 8032 verifier (security review ACCEPT, 1,407-case differential vs OpenSSL), rollback notice held until the splash is gone. The last two are unit-tested, not re-run on a device. Release gate: shells still pin the public dev key until the owner pins the real one |
| LIFE-06 | Corporate attire (CEO/chief suits, worker default outfit, hire-dialog customisation) | Reviewed and accepted | [Report](reports/corporate-outfits.md). Rocketbox business avatars (MIT) via a TypeScript pipeline; review ACCEPT WITH FIXES, the medium (failed clip/model downloads cached for the session) fixed with a retry and a test. 559/559 tests, 19/19 outfit and 411/411 mobile checks on the merged tree. Open (low): frustum culling disabled for skinned bodies; old rigs still in `tools/avatars/rigs/`. Not run on the iPhone simulator |
| ORG-01..03 | Executive roster and offices, estimates before work, CEO approval inbox and notifications | Requirements recorded ([ORG_PLAN.md](ORG_PLAN.md)) | Rule-based executives this round (no model calls); server mode only. ORG-01/02 author assigned 2026-10-02; ORG-03 after |
| ORG-04..06 | Marketing/sales, research, onboarding/voice | Backlog | After ORG-03 |

## Releases and in-app updates

Plan: [RELEASE_PLAN.md](RELEASE_PLAN.md). Owner steps: [RELEASING.md](../RELEASING.md).

| ID | Slice | State | Evidence / next dependency |
| --- | --- | --- | --- |
| REL-01 | Unified version (1.0.0-beta.1), version sync and tag rules | Reviewed and accepted | [Report](reports/release-pipeline.md) |
| REL-02 | `release.yml`: signed game bundle and channel, desktop/Android/iOS builds, signing gated on secrets in a protected `release` environment | Reviewed and accepted | Every action pinned to a verified SHA; dry runs use `--dev`. No GitHub run yet. The owner must create the environment, the secrets and the real signing key |
| REL-03 | Client update service and prompt | Reviewed and accepted | [Report](reports/in-app-updates.md). Signature checked before trust; forward-only; stable-feed round-trip test |
| REL-04 | Native bundle store, rollback, native update paths | Reviewed and accepted | Shells verify the channel signature themselves (Android 8–12: page check plus sha256). Windows feeds Squirrel only a verified package. Device re-run after the fixes is still pending |
| REL-05 | Coordinator update prompt; server version notice | Reviewed and accepted | Explicit confirmation only; never offers a lower version |
