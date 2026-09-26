# Design research

- [Agent Office](https://github.com/AgentSystemLabs/agent-office): preserve real worker terminals, isolated worktrees, queue, hooks and GitHub integration as the productive core.
- [Tidewater](https://github.com/dgreenheck/tidewater): coastal atmosphere, recognizable landmarks, natural materials, realistic characters, layered environment detail and contextual interactions. It uses its own WebGPU/WGSL engine, so the renderer is not a drop-in Three.js replacement. Inspected its environment convolution, atmosphere, vegetation and character implementation. This renderer uses Three.js PMREM/HDR image lighting, photographed PBR surfaces, instanced leaves and two licensed Rocketbox rigs. Tidewater's custom sky/cloud/terrain shaders are not copied or claimed as implemented.
- [Cities: Skylines II — City Services](https://www.paradoxinteractive.com/games/cities-skylines-ii/features/city-services-districts-policies): service coverage and citizen demand should make infrastructure meaningful.
- [Cities: Skylines II — Economy and Production](https://www.paradoxinteractive.com/games/cities-skylines-ii/features/economy-production): budgets, households, businesses and services should form a measurable economy. Current credits are only a construction/hiring budget.
- [The Sims 4 manual](https://eaassets-a.akamaihd.net/eahelp/manuals/the-sims-4-ps4-na.pdf): personal needs and routines inform the home's meal/rest interactions; richer life simulation is future work.
- [GitHub Codespaces lifecycle](https://docs.github.com/en/codespaces/about-codespaces/deep-dive): inactivity timeouts mean Codespaces cannot be treated as guaranteed uninterrupted compute. Use dedicated runners for durable work.

Design principle: the world makes actual work legible. A fictional hospital staffing bar cannot stand in for an AI job result, and an animated character cannot prove a remote worker is alive. Always distinguish simulated state from observed execution state.

## Visual reference pass

- [MotionSites](https://motionsites.ai): studied its cinematic composition, dark translucent navigation and restrained typographic hierarchy. These informed the revised HUD; no template source, protected scene, video or gallery artwork is bundled.
- [Poly Haven](https://polyhaven.com): HDR sky and photographed asphalt/concrete/wood provide real surface response. Sources and licenses are recorded in THIRD_PARTY_NOTICES.md.
- Higgsfield 3D Jutsu: authored and rendered an executive sedan using Blender geometry, then loaded the portable GLB in the game. It is real geometry, not a video backdrop. The editable modeling script is in tools/build-sedan.py.
