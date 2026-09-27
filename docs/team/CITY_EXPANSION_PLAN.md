# Agent Empire: next city phase

Recorded before feature implementation, 2026-09-27. Baseline: `79fd05c`. This document records the user's requested direction and breaks it into reviewable work. Items below are planned unless explicitly marked verified.

## Product purpose and existing commitments

Visualize the user's collaboration with real AI workers as a believable, explorable city. The user is the founder/CEO; the chief of staff coordinates information across sectors. A city character, wage animation or report badge must never imply real work occurred without execution evidence.

Preserve arrow defaults and remapping, first/third-person views, automatic character/camera turns, physical doors and the expandable minimap. Owned, completed business buildings require an assigned worker to enter; home and HQ remain accessible. Selected starter businesses receive managers, with a default chief-of-staff assignment. Workers have no arbitrary lifetime cap, but hiring needs funded workstation capacity and execution concurrency/budget limits. Earn fictional city credits to buy land, fund workstations, add floors and improve services. Keep these separate from real provider charges.

Desktop, web, Android and iOS remain product targets. Local world assets and local speech are distinct from cloud task continuity and cross-device synchronization; closing the app cannot keep local compute running. Preserve existing cloud execution/synchronization work and explicitly track its unfinished parts.

## Requested features and acceptance boundaries

| Work | User-visible result | Acceptance boundary |
| --- | --- | --- |
| Larger city | Connected residential, business, civic, commercial, industrial and waterfront districts, roads, sidewalks, landmarks and purchasable plots | Seeded/persisted layout; navigable street connections; buildings correspond to economic/worker state; no endless green ground or obvious scene edge from altitude |
| Helicopter and aerial travel | Walk to a helipad, board a chopper, take off, fly, hover, land and exit; cockpit and chase views | Actual altitude and flight state, remappable controls, safe landing checks, building/terrain collision and restart recovery; camera pulls back progressively with altitude so the skyline and whole city can be seen |
| City rendering at altitude | Continuous street-to-sky view with coherent skyline, roads, terrain and distant coastline | District streaming, instancing, distance detail, frustum culling, shadow/fog tuning and measured low/medium/high settings; building entrances still match street coordinates |
| Founder phone | Open a physical phone with contacts, messages, tasks, navigation and sector reports | Opening it stops movement input appropriately; accessible keyboard/touch controls; contacts reference real worker IDs and fresh status; unread/attention states persist |
| Call the chief of staff | Phone conversation about priorities, blockers, sector activity and approvals while away from HQ | Reuse actual reporting/task service; distinguish rule-based reports from a live reasoning agent; show unavailable/busy/stale states; never fabricate a completed call or task |
| Talk to workers | Approach a worker or call them, speak, see a transcript and hear a reply with subtitles | Explicit target, finalized transcript dispatched once, interruption/cancel support, preserved task permissions, visible provider/worker state and text fallback |
| First-launch voice setup | Select local VoiceStudio or optional paid service, microphone, language, push-to-talk and worker voice; test transcript and playback | Capability/model readiness shown accurately; skip and revisit in Settings; consent before recording; model downloads offered with size and explicit choice; no user voice clone required for recognition |
| Garage and ownership | Home/company garage stores owned cars and aircraft; choose a vehicle, park it, repair or upgrade it | Persistent ownership, slots, vehicle condition/location and spending; occupied spawn detection; return/recovery rules; garage doors and entry physically usable |
| Vehicle entry/exit animation | Approach the handle, open the correct door, grasp, pivot, sit, place hands/feet and close the door; reverse sequence when exiting | Authored rig clips plus hand/foot targets; seat alignment, blocked-door checks, animation interruption recovery, no teleport/pop or clipping through the vehicle; camera follows the transition |

The requested inspiration is GTA-style freedom, traversal, scale and camera behavior. Use original/licensed assets; this does not imply importing GTA game assets or adding unrelated crime/combat systems.

## Additional proposed city systems

These are candidates after the requested foundation, not features already delivered: traffic lanes and pedestrian crossings; ambient NPC schedules tied to staffed buildings; day/night lighting and weather; public transit and delivery/service vehicles; parks, waterfront recreation and accessible interiors; power/connectivity and municipal-service dependencies; maintenance, property upgrades and construction stages; GPS routes and contextual interactions; photo mode and city overview. Each must improve navigation, atmosphere or understanding of actual work rather than burying the agent-management purpose.

## Development coordination

Use one VS Code Agents window to access the project's sessions. A dedicated Empire coordinator owns the task ledger, dependencies, compact handoffs, integration and review. Claude Opus 5.5 is the requested interface/world author; Codex owns runtime, economy/persistence and voice adapters; Grok reviews exact candidate commits. Verify model availability in the active harness; do not silently substitute or claim a model was used from a role label alone.

Separate independent writers by worktree; multiple chats in one session can share a worktree and are not automatically isolated. Reuse clean existing role worktrees after checking their current commits. The coordinator assigns one bounded task with acceptance checks, owned paths and a baseline; workers return commit IDs, checks and blockers. Shared schemas/assets are agreed first. Read-only research may run concurrently. Only one author owns a file at a time; only the coordinator integrates. Failed material review returns to the author before integration.

Save progress on completion, a blocker, or an approval request. Use concise completion handoffs, not repeated screenshot/status polling. Cap active authors at two plus one reviewer; avoid recursive delegation and repeated full-repository scans. Native tool completions should wake the coordinator while its session is active. A session list alone does not automatically route tasks across model harnesses, and this is not an always-on service after VS Code closes. Validate dispatch/return with a planning-only task before feature work.

## VoiceStudio discovery (verified, read-only)

Owned source: `Billioncodes001/voice-lab`, local checkout `../voice-lab`. Backend `http://localhost:3900` reports healthy v0.5.6 on MPS. OmniVoice weights are installed (about 3.27 GB); engine package availability is not model readiness. No ASR/dictation model is installed. A saved demo voice exists. No recording, generation or model download was performed in this planning pass.

The running schema provides `POST /v1/audio/speech` (JSON, WAV supported, input up to 4,096 characters) and `POST /v1/audio/transcriptions` (multipart file, optional language/model/format). Batch transcription does not support `stream:true`; a separate streaming WebSocket is advertised but not tested. Treat installed/loaded/ready/error states separately.

Implement a separate worker-speech adapter: microphone → ASR → chosen worker/task service → TTS → positional audio and subtitles. Existing `src/client/voice.ts` handles peer WebRTC; it is not an AI speech adapter. Electron should use a narrowly scoped local bridge with request limits/cancellation and no credentials in the renderer. Web/mobile need an explicitly paired authenticated HTTPS host; their localhost is their own device. No claim of offline mobile inference until models are actually packaged and device-tested. Audio is transient by default. Local speech avoids external speech-provider fees; model reasoning and cloud execution have their own costs and limits.

## Delivery order

1. **Coordination and contracts:** save this backlog; prove bounded coordinator delegation in one Agents window; agree world, vehicle ownership and speech contracts. No product-code work until these notes exist.
2. **Phone plus voice foundation:** phone/contact UI and truthful text calls; local service health/model setup; push-to-talk transcription and spoken responses when an ASR model is available. Fake adapters permit development without downloads or charges. Ship a narrow end-to-end founder → chief call before expanding every contact.
3. **Garage and vehicle interactions:** ownership/persistence, a usable garage, authored car entry/exit with collision checks and sound timing.
4. **Expanded city:** district layout and streaming first, then architecture/roads/terrain detail and economy-linked construction. Establish performance baselines before scaling asset counts.
5. **Helicopter:** implement boarding, flight physics, controls, camera, altitude detail and landing against the expanded city; retain the same world coordinates and saves.
6. **Device and continuity pass:** reconcile cloud outputs/worker rewards and device saves; verify desktop builds, responsive web, touch controls and reachable-host voice on Android/iOS. Do not equate source projects or packaged archives with device acceptance.

## Verification and current gaps

Each slice needs appropriate unit/integration tests, typecheck/build, visual interaction checks, save/restart checks and an independent review of its exact commit. Measure frame time/memory at street, district and helicopter altitudes on low/medium/high; set platform-specific budgets after measuring hardware, rather than promising universal frame rates. Asset licenses, rig scale/orientation, audio routing and model download sizes belong in the handoff.

Current verified baseline: turn fix and 162 passing tests; a packaged macOS local city; Windows archive/native-target checks without a Windows run; Android HTTPS companion build with limited emulator evidence; iOS source without a signed IPA. Provider output import, cross-device city-save storage and voice model readiness remain outstanding. A rule-based chief report is not an autonomous chief reasoning continuously. Preserve the live port-4610 runtime, Pixel worker and city save during isolated development.

## References

- [VS Code Agents window](https://code.visualstudio.com/docs/agents/run/agents-window)
- [VS Code subagents](https://code.visualstudio.com/docs/agents/run/subagents)
- [VS Code sessions](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions)
- VoiceStudio running `/openapi.json`, `/health`, `/models`, `/dictation/models` and `/v1/audio/voices`, inspected 2026-09-27.
