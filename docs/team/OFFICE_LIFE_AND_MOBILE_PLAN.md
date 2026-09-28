# Office life, organization and mobile game

User direction recorded before implementation, 2026-09-28. Baseline: `af0ce3c`. This extends [CITY_EXPANSION_PLAN.md](CITY_EXPANSION_PLAN.md) and [CONSULTANCY_PLAN.md](CONSULTANCY_PLAN.md). Items are planned unless explicitly marked verified.

## What the user asked for

**Characters and movement**
- Better-looking people, and believable run, jump and landing animation.
- Workers who look and behave like staff at a real organization. Each has a personal laptop or workstation, and what they are doing shows live on their screen.

**Office life**
- A gym, a coffee bar, breakfast and a cafeteria, plus other recreational areas.
- When a worker is waiting on another worker (two workers on one project, one waiting for the other's update), it uses the time for the gym, coffee or other recreation, as in a real office.

**Organization at scale**
- The founder is the CEO. Under the CEO are a chief of staff and administrative executives, each owning a function.
- The company can run many products at once. The practical limit is the connected provider credits and models, not a fixed cap.
- Administration estimates cost and calendar time for each piece of work before it starts: build, iteration, testing and real-world testing. No rushing.
- Administration also runs marketing, sales and lead sourcing. Anything needing CEO approval waits on the CEO's desk and triggers a Telegram or email notification.
- First-run setup collects the information needed to operate. The CEO can also talk to the company by voice.

**Self-improvement**
- A deployed Empire keeps extending what it can do. For an unfamiliar job it researches forums, GitHub and model hubs for tools and workarounds, and reports honestly what is and isn't feasible yet.

**Mobile game**
- iOS and Android are a landscape mobile game connected to a real-time server.
- On-screen touch controls fit every screen, with a camera and point of view arranged for phones.
- A proper splash screen, loading screen with progress, and game menu.
- Tested on device simulators.

## Invariants that still apply

- **No fake work.** An animation never implies work that didn't happen (AGENTS.md, CONSULT-05). A worker walks to the gym only because the server reports it waiting on a dependency, idle, or with its turn ended. The HUD and the worker's screen say which. Recreation never spends tokens and never delays a runnable task.
- **Screens show real data.** Screens show real PTY output or real task state. A placeholder is labelled as a placeholder.
- **Estimates are estimates.** Cost and time estimates are labelled as such and revised against actual provider spend. City credits stay separate from provider money.
- **CEO sign-off on outward actions.** Creating email or social accounts, sending outreach, spending money or publishing needs explicit CEO approval per action, with credentials the CEO owns and provides. It also must respect each platform's terms: no CAPTCHA bypass, no fake identities.
- **Honest self-improvement.** It means reviewed tools, prompts and organizational memory with provenance. It does not mean unrestricted self-modification or claims of AGI or ASI. Unknown or impossible work is reported as such, with evidence.
- **Protected session.** Protect localhost:4610, Pixel and its save. Test with the UI fixture (`tools/ui-fixture.ts`) or isolated servers. No paid worker calls in tests.

## Slices

| ID | Slice | Depends on | Acceptance |
| --- | --- | --- | --- |
| MOBILE-01 | Game shell: splash, loading progress, game menu, Empire branding on sign-in | — | The splash shows until assets are ready, and the loading bar tracks real asset progress. The menu offers resume, settings, controls help, map and sign out. Keyboard and touch accessible. Reduced-motion honoured |
| MOBILE-02 | Landscape touch controls | MOBILE-01 | A virtual joystick with analog walk and run. Buttons for jump, interact and view, plus a camera drag area. Safe-area insets respected; nothing clipped at 667×375 through 932×430 in landscape. Portrait asks to rotate. Controls hide while typing or when a modal is open. Arrow and key remapping still works on desktop |
| MOBILE-03 | Phone HUD and camera | MOBILE-02 | A compact top bar (one row plus overflow menu), a smaller minimap, and the chat and status strip kept clear of the controls. The third-person camera is framed for a wide, short screen. Frame time is measured on the low preset |
| MOBILE-04 | Native shells | MOBILE-01 | iOS and Android launch screens in brand colours, landscape preferred, and no blank white web view before load or on errors. iOS error parity with the Android fix. Simulator and emulator evidence recorded separately from device acceptance |
| LIFE-01 | Locomotion polish | — | Jump start, airborne and landing poses, with no idle clip mid-air. Run and walk blending checked. `models.test.ts` stays green |
| LIFE-02 | Office amenities | — | Gym (treadmill, bike, weights, mats), cafeteria and breakfast counter with tables, and an expanded coffee bar. Each has seats and use spots registered as colliders and interactions, and `office-furnishing.test.ts` clearance checks are extended |
| LIFE-03 | Worker routines from real states | LIFE-02 | A pure, tested scheduler maps each worker's real server state to a place and activity. **working/starting:** at desk, typing. **needs_input:** at desk with an attention cue. **idle or done:** coffee, cafeteria or gym by a stable per-worker choice. **waiting on a dependency:** recreation, with the reason on the name card. **offline/exited:** absent or asleep at desk. Workers walk there on clear aisles (waypoint graph) and play sit or stand clips. They return to the desk as soon as the state becomes working |
| LIFE-04 | Dependencies between tasks | CONSULT-01 | A queue task can wait on another task. The server reports `waitingOn`, and the queue never starts a blocked task. This is the real signal LIFE-03 visualizes |
| LIFE-05 | Character variety | LIFE-01 | More licensed rigs and outfits (Rocketbox or other MIT/CC0 sources recorded in THIRD_PARTY_NOTICES). Profile look choices honoured. Blender retarget pipeline documented. Blender is not installed on the build host yet |
| ORG-01 | Executive roster | CONSULT-04 | Chief of staff plus administrative executives (operations, finance/estimation, marketing and sales, research), with offices and desks in HQ, each owning the task families they approve or run |
| ORG-02 | Estimates before work | ORG-01 | Each job gets a costed, calendar-time plan (build, iteration, testing, field testing) from the estimation executive. The plan is revised against actual usage. The CEO approves the budget before dispatch |
| ORG-03 | CEO approval desk and notifications | CONSULT-02/03 | One approval inbox in the game (CEO desk), Telegram and email. Email needs an owner-configured SMTP/provider account |
| ORG-04 | Marketing, sales and lead sourcing | ORG-03 | Drafted campaigns and lead lists. Every external account, message or post is an approval item executed with owner credentials |
| ORG-05 | Research and capability growth | ORG-01 | A research executive investigates unfamiliar jobs (docs, GitHub, forums, model hubs), records findings with sources, proposes tools for approval, and reports feasibility honestly. It is bounded by budget |
| ORG-06 | Onboarding and voice | CITY-03/04 | First-run setup collects the company profile, provider accounts, budgets, notification channels and approval rules. Voice uses the VoiceStudio adapter already planned |

## Order

MOBILE-01 → MOBILE-02 → LIFE-01 → LIFE-02 → LIFE-03 (using existing idle/done/needs_input states first) → MOBILE-03/04 → LIFE-04 → ORG slices in the CONSULT-04 sequence. The ORG slices are server and runtime work owned by the backend lane. The mobile and life slices are interface and world work.
