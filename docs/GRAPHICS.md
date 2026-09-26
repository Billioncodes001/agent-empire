# Graphics and physical navigation

The scene uses meter-scale PBR geometry, local photographed material maps, an HDR environment, sun shadows and ambient occlusion. The coastal district has a bounded shoreline, rocks, perimeter roads, paths and a planted greenbelt. Scrolling out automatically raises the third-person camera; it no longer reveals an infinite flat green plane.

The old location/travel panel is removed. A circular local minimap tracks heading and destinations; G expands it, and selection sets a waypoint without moving the player. N switches first/third person. These shortcuts and the arrow movement keys are remappable. Management remains available for actual task assignment, construction and reports.

Glass entrances slide open on approach. Walking through headquarters triggers a visible walking transition with a short fade between the differently sized interior and exterior scenes. Home and business ground floors are directly walkable in the city. Businesses require completed construction plus a live assigned AI worker; simulated service staff cannot unlock them. Three visible workstations display up to three actual assigned workers in each business; the full workforce remains in the server reports.

Both adult rigs now contain original Rocketbox locomotion and seated clips, retargeted in Blender using Tidewater's world-space technique. The controller supplies horizontal motion and the clips supply hip, knee, heel/toe and arm movement. Playback follows measured movement speed, crossfades to idle when blocked, and uses a separate running clip. Seated workers use a recorded seated clip. Hand contact IK and detailed typing remain future work.

The Higgsfield-authored sedan now has a separate hinged driver door, a cut aperture/footwell, seats, steering wheel and transparent glazing. Entry/exit plays an approach, door opening, recorded seated/standing motion and door closing sequence. Exit is refused while moving or when the driver's side is obstructed. First person uses the driver-eye position and follows steering while retaining independent head look; third person follows the vehicle. Seated driving uses arm IK targets at the wheel. This is a composed animation sequence, not a dedicated vehicle-entry motion-capture take.

## Validation

`npm run typecheck`, `npm test`, and `npm run build` check the shipped model rigs, grounded animation bounds, independent skeletons, hinged door, movement/camera collision, entry eligibility, key migration, map projection and traversal state transitions.

`npm exec vite -- --host 127.0.0.1 --port 4611` serves `/visual-review.html`, a development-only graphics inspection page. It has explicit walk/run, doorway, vehicle and camera scenarios plus a playback speed control. It reuses production scene/controller/animation code, uses local construction fixtures, and starts no AI workers. The production Vite build excludes this page. Use it to inspect contacts and transitions, then check real server state and HUD behavior in the normal application.

This remains a developing 3D simulation. It does not claim photorealistic or GTA-level character interaction. Remaining art work includes sector-specific furniture/equipment, greater character variety, hand/foot IK, local reflection probes, weather, traffic, quality settings and mobile performance qualification. Vehicle state is still local to the browser; always-on cloud execution and laptop synchronization are separate unfinished systems.
