# Third-party attribution

## Agent Office

This project derives from AgentSystemLabs/agent-office:
https://github.com/AgentSystemLabs/agent-office

Original Git history and source are preserved. Upstream package metadata declares MIT; at the copied revision the repository does not contain a standalone LICENSE file. No replacement upstream copyright notice has been invented. The original README is retained in docs/UPSTREAM_README.md.

## Tidewater / Microsoft Rocketbox

`src/client/public/models/chief-of-staff.glb` is Tidewater's `marta.glb`; `founder.glb` is its `joe.glb`. These are Microsoft Rocketbox avatars converted with idle and gesture animations by Tidewater's tools. The included Rocketbox license applies to both.

Sources:
- https://github.com/dgreenheck/tidewater
- https://github.com/microsoft/Microsoft-Rocketbox

Copyright Microsoft Corporation. MIT License text is included next to the asset as `LICENSE-Rocketbox.md`. Tidewater's MIT license is retained in `docs/LICENSE-Tidewater.txt` for the converted asset's provenance. The world-space retargeting approach in `tools/retarget-motion.py` is adapted from Tidewater’s MIT-licensed `tools/characters/convert.py`. Additional Microsoft Rocketbox FBX clips (`m_`/`f_walk_neutral`, `m_`/`f_run_neutral`, seated idle, left and neutral chair sit-down/stand-up) are baked into the two GLBs. Other district meshes are procedural code authored for Agent Empire; no Tidewater game screenshots are included in the application.

## Poly Haven surface and environment assets

The following files in `src/client/public/textures/` are [CC0](https://polyhaven.com/license). Color maps use sRGB; normals/roughness use linear sampling. Files are served locally at runtime.

| Local files | Source | Use |
| --- | --- | --- |
| `asphalt_02-*.jpg` | [Asphalt 02](https://polyhaven.com/a/asphalt_02) | 1K color, OpenGL normal and roughness |
| `concrete_wall_006-*.jpg` | [Concrete Wall 006](https://polyhaven.com/a/concrete_wall_006) | 1K color, OpenGL normal and roughness |
| `wood-*.jpg` | [Weathered Brown Planks](https://polyhaven.com/a/weathered_brown_planks), via Tidewater's credited prop textures | 1K color, normal and roughness |
| `oak-*.jpg` | [Wood Floor](https://polyhaven.com/a/wood_floor), Dimitrios Savva | 1K diffuse, OpenGL normal and roughness for the interior floor |
| `coastal-sky.hdr` | [Kloppenheim 06 Pure Sky](https://polyhaven.com/a/kloppenheim_06_puresky), Greg Zaal / Jarod Guest | 2K HDR image |

## Authored vehicle

`executive-sedan.glb` was authored for this project with Blender through Higgsfield 3D Jutsu. Its procedural source is `tools/build-sedan.py`; `tools/add-sedan-door.py` adds the independently hinged driver door, footwell, seats and steering wheel. The original low-poly catalog experiment was replaced; the delivered vehicle is authored geometry. The game loads only the `Executive_Sedan` root, excluding the preview studio floor, lights and camera.

[Editable Higgsfield project, revision 3](https://higgsfield.ai/3d-jutsu/e55a92fd-3a5a-4033-a80d-b73cc9d23629).
