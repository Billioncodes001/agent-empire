# Agent Empire

An agent-powered office inside a growing simulated city. As the CEO you walk or drive around the founding district, develop service buildings and run a small rule-based executive team, while actual coding agents do the project work at headquarters desks.

Agent Empire is derived from [Agent Office](https://github.com/AgentSystemLabs/agent-office) and keeps its terminals, agent hooks, Git worktrees, task queue, GitHub boards, voice and usage tracking. The unmodified upstream source is preserved on `main` before the first development branch. Some internal names still say "office"; see [legacy names](docs/NAMING.md).

> **Free-first direction (2026-10-23):** the owner's goal is that a developer can use Agent Empire entirely for free, with free tools. Free tools become the default and the fallback for users without premium accounts. Premium stays available: users can link their Claude account (Pro/Max sign-in for Claude Code) and Anthropic or OpenAI API keys. See `docs/team/FREE_STACK.md`. This is **in progress**: nothing in this README depends on it yet.

## Where it runs

On first launch every app asks where the Empire should run. There are two modes:

- **Connect my own server.** This mode has every feature. The server is this repository's Node server (`npm start`, the Docker recipe in `deploy/`, or the desktop app's **Run on this computer**). Live terminals, local agents, voice, screen share and Telegram all need it. Work continues only while that server is running. Apps sign in with the office password and get a revocable device token. **Settings › App & connection › Signed-in devices** lists and revokes them.
- **Run in the cloud with my accounts.** The Empire lives in a private `agent-empire-state` repository in **your own GitHub**. A scheduled GitHub Actions workflow there is the coordinator. It keeps the city and the queued jobs moving while every app is closed, and it dispatches work to Anthropic Managed Agents with your API key, which it stores as a sealed Actions secret. Cloud mode reacts in minutes, not seconds. It has no live terminals, tunnels or local agents. The in-app shutdown and start controls pause and resume the coordinator. See [cloud mode](docs/team/CLOUD_MODE_PLAN.md).

Provider charges are real money and are always separate from the city's fictional credits.

## Apps

| Platform | What it is | Verified so far |
| --- | --- | --- |
| Web | The same client served by your server; installable as a PWA | Desktop and phone-width browser checks against isolated fixtures |
| iOS | Native app with the game bundled; native launch, Keychain sign-in, full-screen landscape | iPhone simulator walks with real taps. No physical device, TestFlight or signing yet |
| Android | Native app with the game bundled; immersive landscape, one native bridge | Pixel 7 / API 35 emulator walks with real taps. No physical device or Play signing yet |
| macOS / Windows | Electron app with the game bundled, shared setup, OS-encrypted secrets and **Run on this computer** | Packaged macOS app walked. Windows packaged and checked but not run. Unsigned |

**In-app updates:** apps check a signed release channel at launch and about every 6 hours. They offer a game update with a restart, an app update through the platform's own path, a server-version notice, or a coordinator update in cloud mode. Updates never change saves or settings. The owner's release key is pinned in every shell. No public release has been published yet. Build details are in [platform builds](docs/PLATFORMS.md) and [releasing](docs/RELEASING.md).

## Run a server locally

You need Node 20+, git, and a browser with WebGL. Actual agents need Claude Code (or the configured agent command), installed and authenticated. GitHub features need `gh auth login`.

```sh
npm ci
npm start -- --host 127.0.0.1 --port 4610 --password your-local-password
```

Open http://localhost:4610. `npm run dev` also starts the Vite development server on port 5173 with the development password `dev`.

## Playable now

- **Founding:** choose your character and two to seven starting buildings. Headquarters, home and the chief of staff are always included. Each selected business gets a manager appointment with a real queued startup brief and one service employee.
- **City economy:** service revenue, wages, founder dividends and rewards for completed AI tasks fund land, construction, hiring, upgrades, HQ floors and workstations. The rules are identical in server and cloud mode. See [economy rules](docs/ECONOMY.md).
- **Executives:** the chief of staff, operations, finance, marketing & sales and research each have a seated desk in the loft. They are **rule-based**: they summarise real queue, budget and inbox state and make no model calls.
- **Estimates and the approval inbox:** client jobs get an estimate before any work starts. Plans waiting for approval, budget increases for held jobs, outreach sends and research tool proposals collect in the CEO's inbox. The inbox is available in game, by Telegram (`/approvals`) and optionally by email. Nothing runs or is sent without your decision. See [approvals](docs/APPROVALS.md) and [consultancy](docs/CONSULTANCY.md).
- **Outreach and research:** marketing drafts email campaigns as internal jobs. You approve each send, and rate caps, suppression and opt-out apply ([outreach](docs/OUTREACH.md)). Research turns your questions into approved jobs whose reports must cite sources ([research executive](docs/RESEARCH_EXECUTIVE.md)).
- **Office life:** workers take breaks at the gym, cafeteria and coffee bar based on their real states. A queued task that depends on another task shows its worker "Waiting on X". Jumping, corporate attire and outfit customisation in the hire dialog are in.
- **Movement and views:** arrow keys by default, with remappable movement and actions. You can switch between first and third person (**N**). There is a minimap with waypoints (**G**). On touch screens you get a joystick, jump, run and camera controls. You can drive the car (**E** at the driver's door). A physical elevator connects the HQ floors.
- **Persistence:** server mode saves the city atomically in `.agent-office/empire.json`. Cloud mode saves it in your state repository.

Simulated service staff and credits are fictional. Actual coding agents and their monetary usage are shown separately.

## Not done yet

The following are not verified or not built yet:

- physical-device runs, app-store signing and distribution;
- a real (non-fake) GitHub cloud-mode run (owner-approved and pending);
- importing provider outputs into the city;
- cross-device save sync in server mode;
- automatic expansion;
- a model-driven chief of staff.

OpenAI as a cloud provider is built on the unmerged branch `claude/cloud-06-openai`, unreviewed and parked. The city is one fixed district: there is no traffic, citizen economy or dynamic weather. See [execution setup](docs/EXECUTION_SETUP.md), [continuity](docs/CONTINUITY.md), [architecture](docs/ARCHITECTURE.md), [graphics](docs/GRAPHICS.md), [asset attribution](THIRD_PARTY_NOTICES.md) and the [original office documentation](docs/UPSTREAM_README.md).

## Verify

```sh
npm run typecheck
npm test
npm run build            # client, server and the cloud coordinator bundle
```

UI acceptance uses isolated fixtures and never the live session. See [UI fixture](docs/team/UI_FIXTURE.md) and the `tools/*-ui-check.ts` scripts. No check starts paid agents or deploys services.
