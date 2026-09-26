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

The office continues running real PTY processes. Agent completion is derived from existing hooks, not simulated timers. Sector tasks feed the existing queue. Simulated civic staffing currently affects coverage only; wages and revenue are not implemented.

## Next milestones

### 1. Deeper world simulation

Introduce a database-backed fixed-tick engine with event history and migrations. Add construction duration, wages, income, utility dependencies and service demand. Give workers persistent identities, roles, shifts, paths, needs and building assignments. Replace ambient loops with navigation and schedules. Define explicit formulas and balance tests for health, education and happiness.

Doorway traversal, business ground floors, a waypoint minimap, and retargeted walk/run/seated clips are implemented. Next add more parcels, car parking and road routing, vehicle synchronization, hand/foot contact IK, expanded appearance options, and specialized furnishing assets. HDR lighting, texture detail, human rigs and camera obstruction are implemented; next add audio zones, weather and adjustable quality/LOD budgets.

### 2. Chief of staff and reporting

Create a distinct supervisor task with a scoped brief, policy and audit log. It may dispatch approved backlog tasks, collect artifacts, summarize sector reports, and request decisions. It must preserve agent permission gates and spending limits. Add CEO ownership and delegated manager roles, including multiplayer permissions. Provide a daily briefing linked to actual commits, PRs, failures, usage and service events.

### 3. Durable cloud execution

GitHub is source control and an identity/integration option, not an always-on worker host. Deploy a continuously running backend and isolated job containers on selected compute infrastructure. Store tenant/job metadata in PostgreSQL and artifacts in object storage. Use durable queues, job leases, heartbeat/retry policies, idempotency keys, explicit terminal states and immutable event IDs. Losing a browser connection must never cancel a job; losing a runner must not silently restart a destructive command.

Use OAuth/GitHub App installation with least-privilege repository selection. Provider credentials belong in server-side encrypted secret storage, never browser localStorage or the repository. Let the user configure a supported agent provider and per-job/daily spending ceilings. A local-only onboarding route remains valuable for people who do not need cloud execution.

### 4. Desktop synchronization

Package the web client in a desktop shell after defining the transport and trust boundary. A local companion should pull completed branches into isolated worktrees, verify commit/artifact hashes, and surface conflicts for review. Do not overwrite dirty laptop files. Keep acknowledgments and server revisions so reconnects replay only missing events. Existing Git changes UI offers a useful review interface; it is not yet an automated sync engine.

### 5. Web/mobile delivery

The shared web client connects to the cloud backend. Add reconnect/resume tests, adaptive rendering, reduced-motion support, mobile navigation and accessibility. Consider a PWA first, then native mobile packaging if actual device testing supports it. No service worker should cache authenticated API responses or create the impression agents can run offline in a closed browser.

## Acceptance criteria for a cloud milestone

1. A real queued task finishes with all clients closed and produces an attributable artifact.
2. A restarted runner can recover or visibly fail a task without duplicating side effects.
3. Reconnecting desktop and web clients receive the same ordered state.
4. Dirty local files survive synchronization and conflicts are exposed.
5. Secrets do not appear in browser storage, Git, task logs or telemetry.
6. Spend limits, authority checks and approvals hold across retries and reconnects.

## Traversal and animation

`src/client/navigation.ts` defines shared entry eligibility and map projection. A business must be built and have a live `agent` worker whose sector assignment prefix matches; service staff, shells, offline agents and queued-but-not-started tasks cannot open an entrance. Home and headquarters are bootstrap exceptions.

`src/client/traversal.ts` owns timed headquarters doorway and vehicle entry/exit sequences. Scripted movement suspends controller input, preserves the selected view, clears held keys, and resumes collision-based movement afterward. The office interior uses a doorway fade because its floor plan is larger than its street shell. Home and business doors slide in place with corresponding collision changes. Exit remains possible if a worker disconnects while the player is inside.

`Human` crossfades independent `AnimationAction` instances. Locomotion time scales with actual controller displacement, so blocked movement returns to idle. Animation retargeting uses world-space bone orientation and vertical pelvis location; the controller supplies horizontal displacement. `tools/retarget-motion.py` records the Blender conversion process.

The minimap and full map only set a waypoint. They never change player position. New map/camera shortcuts migrate older complete key maps without discarding saved remaps. `visual-review.html` is a development-only scenario viewer and is excluded from production Vite entries; it uses the same scene, controller and traversal modules and never starts real workers.
