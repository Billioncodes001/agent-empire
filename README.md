# Agent Empire

An agent-powered office inside a growing simulated city. The CEO can visit home, drive around the founding district, develop service buildings, and delegate monitoring to a chief of staff while actual coding agents work in the original office.

This is the **first playable web prototype**, derived from [Agent Office](https://github.com/AgentSystemLabs/agent-office). It preserves its terminals, agent hooks, Git worktrees, task queue, GitHub boards, voice, and usage tracking. The unmodified upstream source is preserved on `main` before the first development branch.

## Run locally

Requires Node 20+, git, and Chrome/Safari/Firefox with WebGL. Actual agents require Claude Code (or the configured agent command) installed and authenticated. GitHub features require `gh auth login`.

```sh
npm ci
npm start -- --host 127.0.0.1 --port 4610 --password your-local-password
```

Open http://localhost:4610. Choose your character and walk through the headquarters’ glass exit to the street. Click the minimap (or press **G**) to set a waypoint; walk or drive there. **Management** opens sector construction and reports. `npm run dev` also provides the Vite development server on port 5173 with its development password `dev`.

## Playable now

- **Arrow-key movement** by default. Settings remaps movement and office actions, swaps conflicts, and saves mappings in the browser. Third-person camera follows at shoulder height; drag to orbit and scroll to zoom. **N** switches first / third person immediately, or choose a view in Settings. The first-person camera is 1.66 m above the ground. Scrolling out raises the camera into a district overview. **G** expands the live minimap; both shortcuts can be remapped.
- **Founding district:** waterfront, roads, pedestrian paths, trees, skyline, headquarters, and an accessible residence. Hospital, school, café, and energy campus can be built from Management. Entry requires completed construction and a live AI worker assigned through that sector’s task queue. Home and headquarters remain accessible.
- **Car:** walk to the driver’s door near headquarters and press **E**. The character opens the door and sits down; stop the car and press E to exit. Up accelerates, Down reverses, Left/Right steer, Shift boosts. Controls follow your saved mappings.
- **Home:** walk through the residence’s sliding doors and press the interact key (E by default) inside. Eat, rest, or use the research computer to open the actual worker queue.
- **City operations:** build sites, hire simulated service staff, track coverage and treasury, inspect sector reports, and assign real AI tasks by sector.
- **Chief of staff:** delegates monitoring, periodically reports sector status, and escalates real workers needing input. Walking out through the headquarters doorway enables delegation. It never approves agent permission prompts automatically.
- **Persistence:** the server saves district state atomically in `.agent-office/empire.json`. Existing workers and queue retain upstream persistence. All connected browsers receive district updates every five seconds.
- **Graphics:** HDR environment lighting and reflections, photographic PBR surfaces, ambient occlusion, reflective water, articulated glass façades, leaf-level vegetation, enclosed office lighting, and a modeled executive sedan. CEO, office workers, chief of staff and pedestrians all use animated human rigs sourced from Tidewater/Rocketbox. Static geometry is batched and leaves are instanced.
- **Character selection:** two human models and a profile accent. The accent identifies a profile in the UI; clothing and skin textures remain part of each model.
- **Compact HUD:** a circular minimap with an expanded waypoint map and translucent work controls keep the scene visible; there is no location selector.
- **Touch movement** for coarse-pointer browsers. Native mobile packaging is not implemented.

Simulation service staff and credits are fictional. Actual coding agents and their monetary usage are shown separately. New users share the existing office authentication model; dedicated CEO/manager roles are not implemented yet.

## Runtime limits

The server must remain running for agents and the simulation to continue. Closing only the browser is fine. Shutting down a laptop running the server stops work. GitHub authentication alone does not provide always-on compute. There is no deployed cloud service, account provisioning, automated laptop file synchronization, or native desktop/mobile app yet.

The city is an initial fixed district with instant construction, staffing coverage, and reports. Residents are ambient pedestrians; there is no full citizen economy, traffic routing, hospital scheduling, or emergent life simulation yet. The chief of staff currently uses deterministic monitoring rules rather than a separate reasoning agent. Home needs are browser-local and illustrative. Car state is local to a browser. There are two human presets with retargeted Rocketbox walk, run, sit-down, seated and stand-up clips. Businesses have furnished ground floors; sector-specific equipment, full citizen routines, traffic, dynamic weather/daylight, adaptive mobile graphics and advanced appearance customization remain future work. Headquarters uses a short doorway fade between its interior and street scene; the home and business ground floors are in the street scene. Car entry uses a hinged door and recorded seated motion; dedicated vehicle motion capture and contact IK remain future improvements. The background city is scenery beyond the current playable district.

See [graphics implementation and verification](docs/GRAPHICS.md), [architecture and next milestones](docs/ARCHITECTURE.md), [design research](docs/RESEARCH.md), [asset attribution](THIRD_PARTY_NOTICES.md), and the [original office documentation](docs/UPSTREAM_README.md).

## Verify

```sh
npm run typecheck
npm test
npm run build
# With the local preview on port 4610, password empire-local-preview, and Chrome installed:
npm run test:browser
```

The browser test writes screenshots into ignored `artifacts/`. It verifies automatic doorway traversal, map waypoints without teleporting, animated vehicle entry/exit, driving, camera switching, Management, key remapping and reload persistence. It does not start paid agents or deploy services.
