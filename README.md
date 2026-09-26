# Agent Empire

An agent-powered office inside a growing simulated city. The CEO can visit home, drive around the founding district, develop service buildings, and delegate monitoring to a chief of staff while actual coding agents work in the original office.

This is the **first playable web prototype**, derived from [Agent Office](https://github.com/AgentSystemLabs/agent-office). It preserves its terminals, agent hooks, Git worktrees, task queue, GitHub boards, voice, and usage tracking. The unmodified upstream source is preserved on `main` before the first development branch.

## Run locally

Requires Node 20+, git, and Chrome/Safari/Firefox with WebGL. Actual agents require Claude Code (or the configured agent command) installed and authenticated. GitHub features require `gh auth login`.

```sh
npm ci
npm start -- --host 127.0.0.1 --port 4610 --password your-local-password
```

Open http://localhost:4610. Choose your character, then use **Office ↔ City**, **Go home**, and **Operations**. `npm run dev` also provides the Vite development server on port 5173 with its development password `dev`.

## Playable now

- **Arrow-key movement** by default. Settings remaps movement and office actions, swaps conflicts, and saves mappings in the browser. Third-person camera is the default; drag to orbit and scroll to zoom.
- **Founding district:** waterfront, roads, pedestrian paths, trees, skyline, headquarters, and an accessible residence. Hospital, school, café, and energy campus can be built from Operations.
- **Car:** walk close to the car near headquarters and choose Enter / exit car. Up accelerates, Down reverses, Left/Right steer, Shift boosts. Controls follow your saved mappings.
- **Home:** approach the residence and press the interact key (E by default). Eat, rest, or use the research computer to open the actual worker queue.
- **City operations:** build sites, hire simulated service staff, track coverage and treasury, inspect sector reports, and assign real AI tasks by sector.
- **Chief of staff:** delegates monitoring, periodically reports sector status, and escalates real workers needing input. Leaving through the travel buttons enables delegation. It never approves agent permission prompts automatically.
- **Persistence:** the server saves district state atomically in `.agent-office/empire.json`. Existing workers and queue retain upstream persistence. All connected browsers receive district updates every five seconds.
- **Visual foundation:** physically lit city materials, softer shadows, tone mapping, and an animated human chief-of-staff model adapted from Tidewater's licensed Rocketbox assets.
- **Touch movement** for coarse-pointer browsers. Native mobile packaging is not implemented.

Simulation service staff and credits are fictional. Actual coding agents and their monetary usage are shown separately. New users share the existing office authentication model; dedicated CEO/manager roles are not implemented yet.

## Runtime limits

The server must remain running for agents and the simulation to continue. Closing only the browser is fine. Shutting down a laptop running the server stops work. GitHub authentication alone does not provide always-on compute. There is no deployed cloud service, account provisioning, automated laptop file synchronization, or native desktop/mobile app yet.

The city is an initial fixed district with instant construction, staffing coverage, and reports. Residents are ambient pedestrians; there is no full citizen economy, traffic routing, hospital scheduling, or emergent life simulation yet. The chief of staff currently uses deterministic monitoring rules rather than a separate reasoning agent. Home needs are browser-local and illustrative. Car state is local to a browser. Most avatars retain the upstream stylized models; the chief is the first realistic model integration.

See [architecture and next milestones](docs/ARCHITECTURE.md), [design research](docs/RESEARCH.md), [asset attribution](THIRD_PARTY_NOTICES.md), and the [original office documentation](docs/UPSTREAM_README.md).

## Verify

```sh
npm run typecheck
npm test
npm run build
# With the local preview on port 4610, password empire-local-preview, and Chrome installed:
npm run test:browser
```

The browser test writes screenshots into ignored `artifacts/`. It verifies navigation, movement, the dashboard, home interactions, car driving, key remapping and reload persistence. It does not start paid agents or deploy services.
