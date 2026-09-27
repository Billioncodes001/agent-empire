# Agent Empire

An agent-powered office inside a growing simulated city. The CEO can visit home, drive around the founding district, develop service buildings, and delegate monitoring to a chief of staff while actual coding agents work in the original office.

This is the **first playable web prototype**, derived from [Agent Office](https://github.com/AgentSystemLabs/agent-office). It preserves its terminals, agent hooks, Git worktrees, task queue, GitHub boards, voice, and usage tracking. The unmodified upstream source is preserved on `main` before the first development branch.

## Run locally

Requires Node 20+, git, and Chrome/Safari/Firefox with WebGL. Actual agents require Claude Code (or the configured agent command) installed and authenticated. GitHub features require `gh auth login`.

```sh
npm ci
npm start -- --host 127.0.0.1 --port 4610 --password your-local-password
```

Open http://localhost:4610. Choose your character, complete the one-time founding plan and walk through the headquarters’ glass exit to the street. Click the minimap (or press **G**) to set a waypoint; walk or drive there. **Management** opens sector construction and reports. `npm run dev` also provides the Vite development server on port 5173 with its development password `dev`.

## Playable now

- **First launch:** choose two to seven starting buildings. Headquarters, home and the chief of staff are included; optionally add the hospital, academy, café, energy campus and recreation centre. Selected businesses get a manager assignment, a real queued startup brief and one service employee. Existing saves retain their district and treasury.
- **City economy:** service revenue, individual employee earnings, founder dividends and completed AI-task rewards fund land, construction, hiring and upgrades. Management shows the reconciled ledger, manager status and founder wallet. Credits are fictional; provider charges are separate. See [economy rules](docs/ECONOMY.md).

- **Arrow-key movement** by default. Settings remaps movement and office actions, swaps conflicts, and saves mappings in the browser. Third-person camera follows the character’s turns at shoulder height, finishing the turn after you release movement. Drag to look around and scroll to zoom. The visible **First person / Third person** button or **N** switches views immediately; Settings also lets you choose a view. The first-person camera is 1.66 m above the ground. Scrolling out raises the camera into a district overview. **G** expands the live minimap; both shortcuts can be remapped.
- **Founding district:** waterfront, roads, pedestrian paths, trees, skyline, headquarters, and an accessible residence. Hospital, school, café, energy campus and recreation centre can be built from Management. The Innovation studio requires purchasing its land first. Entry requires completed construction and an actual assigned worker or a manager whose startup has completed. Home and headquarters remain accessible.
- **Car:** walk to the driver’s door near headquarters and press **E**. The character opens the door and sits down; stop the car and press E to exit. Up accelerates, Down brakes before selecting reverse, Left/Right steer, Shift allows a higher cruising speed. Controls follow your saved mappings.
- **Home:** walk through the residence’s sliding doors and press the interact key (E by default) inside. Eat, rest, or use the research computer to open the actual worker queue.
- **City operations:** build sites, hire simulated service staff, track coverage and treasury, inspect sector reports, and assign real AI tasks by sector.
- **Chief of staff:** delegates monitoring, periodically reports sector status, and escalates real workers needing input. Walking out through the headquarters doorway enables delegation. It never approves agent permission prompts automatically.
- **Persistence:** the server saves district state atomically in `.agent-office/empire.json`. Existing workers and queue retain upstream persistence. All connected browsers receive district updates every five seconds.
- **Headquarters:** a skyscraper shell with paid operational floors and a physical elevator. New cities start with four furnished desks; existing saves keep their sixteen desks. Buy computer workstations and additional floors from **HQ**, then walk to the elevator to travel. Each floor has room for sixteen desks. Purchased workstations replace the fixed worker ceiling, while queue concurrency and provider budgets remain separate controls.
- **World audio:** recorded surface footsteps, door latches, ignition, engine load and road noise; cabin filtering in first person, smooth RPM changes and no footsteps while driving. Sound volume and mute apply to these recordings.
- **Graphics settings:** Low, Medium and High apply immediately and persist on this device. Medium is the default laptop profile; High adds contact shading and ocean reflections.
- **Graphics:** HDR environment lighting and reflections, photographic PBR surfaces, ambient occlusion, reflective water, articulated glass façades, leaf-level vegetation, enclosed office lighting, and a modeled executive sedan. CEO, office workers, chief of staff and pedestrians all use animated human rigs sourced from Tidewater/Rocketbox. Static geometry is batched and leaves are instanced.
- **Character selection:** two human models and a profile accent. The accent identifies a profile in the UI; clothing and skin textures remain part of each model.
- **Compact HUD:** a circular minimap with an expanded waypoint map and translucent work controls keep the scene visible; there is no location selector.
- **Touch movement** for coarse-pointer browsers. Native mobile packaging is not implemented.
- **Installable web app:** over HTTPS or localhost, browsers that support it can install the office from **Settings › App & connection** (or the browser menu; iPhone/iPad use Share › Add to Home Screen). The installed app is the same web client and still needs a live connection to the office host. Its service worker only shows a public “can’t reach your office host” page when a page load fails; it never stores app pages, API responses, terminal output, snapshots or credentials, so nothing from the office is available offline. Settings also shows device-offline versus host-unreachable state, a **Reconnect now** control and, when the host reports it, host persistence status (single host, saved revision, receipt age on this device).

Simulation service staff and credits are fictional. Actual coding agents and their monetary usage are shown separately. New users share the existing office authentication model; dedicated CEO/manager roles are not implemented yet.

## Desktop and provider execution

`npm ci --prefix desktop` and `npm run desktop:package` build the development desktop app with bundled world assets and a local city runtime. Its launcher offers a local Git project, protected provider credentials, or connection to an existing host. Local setup starts with the work queue paused. Git is required.

Settings → App & connection offers execution setup and cloud tasks. The first adapter supports Anthropic Managed Agents with pre-created agent/environment references, repository selection, connection checks, budget reservations and explicit paid submission. Accepted sessions run independently of the closed app. OpenAI and GitHub workflow adapters remain disabled. Provider output import and cross-device city saves are still pending. See [setup and exact limits](docs/EXECUTION_SETUP.md).

## Runtime limits

For local/VPS execution, the server must remain running for its workers and the simulation to continue. Closing only the browser is fine. Shutting down a laptop running the server stops work. GitHub authentication alone does not provide always-on compute. The first single-owner continuity and synchronization milestone is implemented: a durable host journal, authenticated committed-work artifacts, an isolated laptop importer, a development Electron desktop app, and a mobile/web PWA. A Docker deployment recipe is included; no production Agent Empire host has been deployed yet. Account provisioning, native mobile store packages and distributed city state remain future work. See [continuity and device setup](docs/CONTINUITY.md).

The city is an initial fixed district with instant construction, staffing coverage, and reports. Residents are ambient pedestrians; there is no full citizen economy, traffic routing, hospital scheduling, or emergent life simulation yet. The chief of staff has a real AI startup brief and deterministic ongoing monitoring; it is not a continuously reasoning autonomous executive. Home needs are browser-local and illustrative. Car state is local to a browser. The economy has defined simulation rates and a finite set of parcels; it is not a full market economy. There are two human presets with retargeted Rocketbox walk, run, sit-down, seated and stand-up clips. Businesses have furnished ground floors; sector-specific equipment, full citizen routines, traffic, dynamic weather/daylight, automatic performance adaptation and advanced appearance customization remain future work. Headquarters uses a short doorway fade between its interior and street scene; the home and business ground floors are in the street scene. Car entry uses a hinged door and recorded seated motion; dedicated vehicle motion capture and foot contact IK remain future improvements. The background city is scenery beyond the current playable district.

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
