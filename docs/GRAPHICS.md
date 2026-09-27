# Graphics and physical navigation

The scene uses meter-scale PBR geometry, local photographed material maps, an HDR environment, sun shadows and ambient occlusion. The coastal district has a bounded shoreline, rocks, perimeter roads, paths and a planted greenbelt. Scrolling out automatically raises the third-person camera; it no longer reveals an infinite flat green plane.

The old location/travel panel is removed. A circular local minimap tracks heading and destinations; G expands it, and selection sets a waypoint without moving the player. N switches first/third person. These shortcuts and the arrow movement keys are remappable. Management remains available for actual task assignment, construction and reports.

Glass entrances slide open on approach. Walking through headquarters triggers a visible walking transition with a short fade between the differently sized interior and exterior scenes. Home and business ground floors are directly walkable in the city. Businesses require completed construction plus a live assigned AI worker or a durable manager appointment whose real startup task has completed; simulated service staff cannot unlock them. Three visible workstations display up to three actual assigned workers in each business; the full workforce remains in the server reports.

Both adult rigs now contain original Rocketbox locomotion and seated clips, retargeted in Blender using Tidewater's world-space technique. The controller supplies horizontal motion and the clips supply hip, knee, heel/toe and arm movement. Playback follows measured movement speed, crossfades to idle when blocked, and uses a separate running clip. Seated workers blend a recorded clip with an ergonomic forward reach, two-arm keyboard IK, wrist alignment and staggered finger taps. Walking accelerates and brakes smoothly; switching between walk/run preserves stride phase. The character balances its upper body slightly while turning; recorded leg and foot motion stays intact.

The Higgsfield-authored sedan now has a separate hinged driver door, a cut aperture/footwell, seats, steering wheel and transparent glazing. Entry/exit plays an approach, door opening, recorded seated/standing motion and door closing sequence. Exit is refused while moving or when the driver's side is obstructed. First person uses the driver-eye position and follows steering while retaining independent head look; third person follows the vehicle. Seated driving uses arm IK targets at the wheel. This is a composed animation sequence, not a dedicated vehicle-entry motion-capture take.

## Validation

`npm run typecheck`, `npm test`, and `npm run build` check the shipped model rigs, grounded animation bounds, independent skeletons, hinged door, movement/camera collision, entry eligibility, key migration, map projection and traversal state transitions.

`npm exec vite -- --host 127.0.0.1 --port 4611` serves `/visual-review.html`, a development-only graphics inspection page. It has explicit walk/run, doorway, vehicle and camera scenarios plus a playback speed control. It reuses production scene/controller/animation code, uses local construction fixtures, and starts no AI workers. The production Vite build excludes this page. Use it to inspect contacts and transitions, then check real server state and HUD behavior in the normal application.

This remains a developing 3D simulation. It does not claim photorealistic or GTA-level character interaction. Remaining art work includes sector-specific furniture/equipment, greater character variety, terrain-adaptive foot IK, local reflection probes, weather, traffic and mobile performance qualification. Vehicle state is still local to the browser; always-on cloud execution and laptop synchronization are separate unfinished systems.

The founding expansion adds a recreation centre and a purchasable Innovation studio parcel using the same material and architecture system. Building upgrades add visible roof panels and planted frontage.

## Headquarters and quality profiles

Settings offers Low (1× resolution, no dynamic shadows/AO/ocean reflections), Medium (up to 1.25×, 1024px shadows), and High (up to 2×, 2048px shadows, SSAO and ocean reflections). Presets also limit ambient pedestrians to 2/4/8. Pixel ratios are capped by the device ratio. Switches resize GPU targets without reloading the city; the choice persists in browser settings. The loaded human and surface assets remain consistent across profiles. This is manual quality control, not an automatic frame-rate guarantee.

`tools/build-workstation.py` generates the original dual-monitor workstation in Blender: stands, desktop computer, ventilation, docking hub, keyboard and mouse. Static parts are joined by material before GLB export. The two display meshes stay independent; both show the assigned worker's live terminal canvas. The build script accepts the output GLB path after `--`.

The headquarters skyline has a ten-level structural shell; operational floors are commissioned with simulation credits. Once commissioned floors exceed the shell, the tower grows. Only funded floors appear in the elevator directory. Each operational floor has sixteen potential desk positions, populated in purchase order. One physical floor interior is rendered at the appropriate world elevation (6.4 metres per level, including the mezzanine). Furniture collision, worker meshes, keyboard targeting and sound sources follow the current floor. Other workers continue running on the server. Floor interiors currently reuse one architectural plan; wall artwork and the chief's visible avatar stay on the ground floor.

The elevator opens on approach, walks the player into its cab, closes opaque sliding doors, travels vertically, opens at the destination and walks the player out. Travel temporarily uses the cab eye view and restores the chosen first/third-person view afterward. Only floor 1 has a street exit. Development review includes explicit Elevator and Typing scenarios; these use fixtures and run no paid workers.
