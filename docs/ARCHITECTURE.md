# Architecture and implementation roadmap

## Current boundaries

- `src/shared/empire.ts`: shared site catalog, action types, versioned district state.
- `src/server/empire.ts`: authoritative construction, staffing, bounded report history, real workforce counters, atomic saves. One simulated minute passes per server second; there is no fabricated catch-up after downtime.
- `src/server/server.ts`: authenticated WebSocket commands and five-second state broadcasts, integrated with existing worker manager and queue.
- `src/client/world/city.ts`: procedural district, colliders, landmarks, vehicle, ambient residents and construction visibility.
- `src/client/world/human.ts`: cached GLTF assets, independent cloned rigs, evaluated-skeleton normalization, walking/seated/interaction poses.
- `src/client/world/materials.ts`, `vegetation.ts`, `batching.ts`: photographed PBR surfaces, instanced leaves and material-based static batches.
- `src/client/player.ts`: eye-height first person, shoulder camera with collider obstruction, walking/driving collision.
- `src/client/ui/empire.ts`: operations, minimap, home needs, sector task entry and touch movement.
- `src/client/controls.ts`: arrow defaults, saved mapping validation and canonical office-action routing.

The office continues running real PTY processes. Agent completion is derived from existing hooks, not simulated timers. Sector tasks feed the existing queue. Civic staff earn simulated wages and produce service revenue after a manager starts. Successful real queued tasks earn a separate, once-only completion reward. Founder dividends, capital spending and reinvestment reconcile in the city ledger.

## Next milestones

### 1. Deeper world simulation

Introduce a database-backed fixed-tick engine with event history and migrations. Wages, income, founding grants and upgrades are implemented with fixed rates. Next add construction duration, utility dependencies and service demand. Managers and employee earnings have persistent identities; next add shifts, paths, needs and richer roles. Replace ambient loops with navigation and schedules. Define explicit formulas and balance tests for health, education and happiness.

Doorway traversal, business ground floors, a waypoint minimap, and retargeted walk/run/seated clips are implemented. Next add more parcels, car parking and road routing, vehicle synchronization, hand/foot contact IK, expanded appearance options, and specialized furnishing assets. HDR lighting, texture detail, human rigs and camera obstruction are implemented; next add audio zones, weather and automatic quality/LOD adaptation.

### 2. Chief of staff and reporting

The chief now has a scoped startup task and ongoing administrative reports. Next add an active supervisor policy and audit log. It may dispatch approved backlog tasks, collect artifacts, summarize sector reports, and request decisions. It must preserve agent permission gates and spending limits. Add CEO ownership and delegated manager roles, including multiplayer permissions. Provide a daily briefing linked to actual commits, PRs, failures, usage and service events.

### 3. Durable cloud execution

Implemented for one owner and one host: a stable server identity, bounded ordered observation journal, current-state reconnect snapshots, persistence health, conservative process ownership, and authenticated immutable Git artifacts. A Docker recipe is prepared for an existing VPS. Browser closure does not stop host workers; host loss still interrupts execution. These observation checkpoints are separate from execution saves, not a cross-file transaction or distributed lease. See [continuity](CONTINUITY.md) and [recovery](RECOVERY.md).

GitHub is source control and an identity/integration option, not an always-on worker host. The later multi-tenant architecture needs isolated job containers on selected compute infrastructure. Store tenant/job metadata in PostgreSQL and artifacts in object storage. Use durable queues, job leases, heartbeat/retry policies, idempotency keys, explicit terminal states and immutable event IDs. Losing a browser connection must never cancel a job; losing a runner must not silently restart a destructive command.

Use OAuth/GitHub App installation with least-privilege repository selection. Provider credentials belong in server-side encrypted secret storage, never browser localStorage or the repository. Let the user configure a supported agent provider and per-job/daily spending ceilings. A local-only onboarding route remains valuable for people who do not need cloud execution.

### 4. Desktop synchronization

Implemented: a sandboxed Electron shell and CLI importer authenticate to a chosen host, pin its identity, verify bounded Git bundles and import committed work into separate review worktrees. Receipts make repeated imports idempotent, and current overlapping local paths are reported without changing the active branch, index or edits. Desktop can check published work when reopened and periodically while open. Publication requires a clean stopped managed worker; merges remain explicit. Native macOS arm64 packaging has been tested. Distribution signing, notarization, auto-update, Windows/Linux packaging verification and incremental artifacts remain future work.

### 5. Web/mobile delivery

The shared web client connects to the office host. Implemented: an installable manifest with local icons, a service worker limited to a public offline explanation page for failed page loads (no caching of app HTML, API, terminals, snapshots or credentials), device-offline versus host-unreachable status with an immediate reconnect control, reduced-motion support and keyboard/small-screen access to workforce status. Host continuity status (`continuity.status` / `/api/continuity/status`) is displayed with receipt age measured on the device; a connected socket is never presented as evidence of cloud hosting. Browser outage/restart and desktop synchronization were tested against an authenticated disposable local server; responsive layout was checked at 390 × 844. Still to do: physical iOS/Android installation, public HTTPS deployment verification, adaptive rendering and native mobile packaging if device testing supports it. Agents cannot run offline in a closed browser or on a stopped host.

## Acceptance criteria for a cloud milestone

1. A real queued task finishes with all clients closed and produces an attributable artifact.
2. A restarted runner can recover or visibly fail a task without duplicating side effects.
3. Reconnecting desktop and web clients receive the same ordered state.
4. Dirty local files survive synchronization and conflicts are exposed.
5. Secrets do not appear in browser storage, Git, task logs or telemetry.
6. Spend limits, authority checks and approvals hold across retries and reconnects.

## Traversal and animation

`src/client/navigation.ts` defines shared entry eligibility and map projection. A business must be built and have a live `agent` worker whose sector assignment prefix matches, or a manager appointment with completed real startup work; service staff, shells, offline agents and queued-but-not-started tasks cannot open an entrance. Home and headquarters are bootstrap exceptions.

`src/client/traversal.ts` owns timed headquarters doorway and vehicle entry/exit sequences. Scripted movement suspends controller input, preserves the selected view, clears held keys, and resumes collision-based movement afterward. The office interior uses a doorway fade because its floor plan is larger than its street shell. Home and business doors slide in place with corresponding collision changes. Exit remains possible if a worker disconnects while the player is inside.

`Human` crossfades independent `AnimationAction` instances. Locomotion time scales with actual controller displacement, so blocked movement returns to idle. Animation retargeting uses world-space bone orientation and vertical pelvis location; the controller supplies horizontal displacement. `tools/retarget-motion.py` records the Blender conversion process.

The minimap and full map only set a waypoint. They never change player position. New map/camera shortcuts migrate older complete key maps without discarding saved remaps. `visual-review.html` is a development-only scenario viewer and is excluded from production Vite entries; it uses the same scene, controller and traversal modules and never starts real workers.


## Founding and economy implementation

Version-two empire state stores the one-time founding plan, parcel ownership, building levels, durable manager appointments, cumulative accounts, reward identities and ledger. The server migrates version-one state with a backup. `TaskQueue.jobKey` makes manager startup dispatch idempotent across restarts; failed startup remains visible and retryable. Queue updates drive completion rewards immediately, and the existing simulation timer settles operating hours. Both use server state and atomic empire persistence. See [ECONOMY.md](ECONOMY.md) for formulas, cash reconciliation and limits.

The client opens founding setup after character creation once the authoritative server state arrives. It closes only when the server confirms completion, and a simultaneous founder completion updates every connected client. The main Management view provides assignment status, projected operating rates, individual earnings, capital purchases, upgrades and reinvestment. Arbitrary parcel placement, continuously reasoning executives, provider provisioning and a market economy remain future work.


Headquarters expansion is authoritative in `Empire.state.office`. Pure layout helpers resolve stable desk IDs lazily, avoiding an ever-growing shared static array. WorkerManager gates both spawning and restoration against funded workstations; TaskQueue receives the same live capacity. The client reuses a sixteen-position room at the active floor elevation and creates worker rigs only for that floor. `Tower` owns the elevator sequence and preserves the camera preference; `Office.setFloor` updates desk identities, physical collisions and interaction targets. Other players retain real world heights; voice and rendering isolate different floors. The graphics controller changes resolution, shadow targets and SSAO in place, with city reflection/crowd controls alongside it.
