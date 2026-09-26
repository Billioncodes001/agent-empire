# Grounded 3D graphics pass

The original distant city camera and stylized people made the prototype read as a toy diorama. This pass replaces that presentation while preserving the real agent office and authoritative district state.

## Implemented

- Physically based materials throughout the office and city; photographed color/normal/roughness maps at meter-scaled UV density.
- HDR sky, PMREM image-based illumination/reflections, ACES output, sun shadows and screen-space ambient occlusion.
- Curtain-wall architecture with recessed cores, floor slabs, mullions, porticos, service spines, rooftop equipment and architectural signage. The house has front glazing, an open doorway and an accessible interior. Sector visibility still follows actual construction state.
- Palm fronds, branching trees and individual instanced leaves, benches, kerbs, crosswalks, paving joints, drainage grilles and a reflective waterfront. The surrounding skyline is scenery.
- Enclosed office ceiling, task lighting, wood flooring, neutral furniture and potted palms.
- Independent adult human rigs for the CEO, peers, chief, workers and pedestrians. The model's skeleton is evaluated before calculating its size; this avoids a 100x scale error from stale cloned bone matrices. Idle clips are native to the assets; locomotion and seated/typing poses are procedural.
- Authored GLB sedan with modeled wheels, trim, cabin, mirrors, grille and lamps; it uses the existing driving/collision system.
- Eye-height first person and close third person. The shoulder camera retracts before collider obstacles. District overview is an explicit toggle, rather than the default street camera.
- Collapsible translucent HUD and a direct camera-switch button. Existing arrow defaults and saved remapping remain intact.

## Performance and verification

Static siblings are merged by material within their own construction/visibility group. Leaves use an InstancedMesh; human clones share texture and geometry data, but not skeletons. Assets are local, so no external API is required to render the world. Initial asset load is exposed through the scene canvas's `data-assets` attribute for repeatable QA.

Automated checks cover actual GLB dimensions after animation, independent skeletons, sedan export boundaries, arrow input, camera eye height/obstruction, walking/driving collision, construction/state persistence, reporting and key mappings. `npm run typecheck`, `npm test` and `npm run build` are the core checks.

Manual desktop-browser checks cover first/third person, orbit, office/city/home travel, home meals, the real research queue, operations and character settings. Screenshots are saved locally in ignored `artifacts/realistic-*.png`. A settled street view measured about 60 fps on this development machine; this is not a device-independent performance guarantee. Native/mobile graphics have not been qualified.

## Remaining work

This is a more realistic 3D foundation, not a claim of photorealistic game quality. Add motion-captured locomotion and seated IK, varied wardrobes, detailed interior furniture/props, richer terrain, dynamic weather/daylight, local reflection probes, level-of-detail streaming and device-specific quality settings. Current window reflections use the HDR environment; water reflects the scene. The car has no detailed first-person cockpit. The two human models cannot yet change clothing, skin or hair independently.
