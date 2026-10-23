# Third-party attribution

## Agent Office

This project derives from AgentSystemLabs/agent-office:
https://github.com/AgentSystemLabs/agent-office

Original Git history and source are preserved. Upstream package metadata declares MIT; at the copied revision the repository does not contain a standalone LICENSE file. No replacement upstream copyright notice has been invented. The original README is retained in docs/UPSTREAM_README.md.

## Tidewater / Microsoft Rocketbox

`tools/avatars/rigs/chief-of-staff.glb` is Tidewater's `marta.glb`; `tools/avatars/rigs/founder.glb` is its `joe.glb`. These are Microsoft Rocketbox avatars converted with idle and gesture animations by Tidewater's tools. The included Rocketbox license applies to both. They are no longer shipped: they are the animation sources from which `npm run build:avatars` derives the shared clip files `src/client/public/models/avatars/clips-male.glb` and `clips-female.glb` (rotation tracks, pelvis translation only).

### Corporate avatars

`src/client/public/models/avatars/` holds ten Microsoft Rocketbox avatars converted by `tools/avatars/build-avatars.ts` (mesh-only GLBs, resized WebP textures, generated recolour masks): `Business_Male_01`, `Business_Male_02`, `Business_Male_03`, `Business_Male_04`, `Business_Male_05`, `Business_Male_06`, `Business_Female_01`, `Business_Female_02`, `Business_Female_03` and `Business_Female_04`, from `Assets/Avatars/Professions/` of https://github.com/microsoft/Microsoft-Rocketbox at commit `0943055db6ec570bcef9f2c8b41c9e5467c808f9` (file checksums in `tools/avatars/sources.lock.json`). The source FBX/TGA files are build inputs only and are not committed. MIT License, Copyright (c) 2020 Microsoft; the license text ships as `src/client/public/models/LICENSE-Rocketbox.md`.

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

## Recorded world sounds

Locally shipped CC0 footsteps by Kenney; engine idle by RichieMcMullen; engine start by prometheus888; onboard driving by Joseph SARDIN / BigSoundBank; car doors by looneybits / OpenGameArt. Per-file sources, direct download provenance, edits and licenses are documented in `src/client/public/audio/README.md`. No audio in this set was generated through ElevenLabs.

`tools/refine-sedan.py` is the local Blender refinement pass: real wheel apertures, separate steer/spin pivots, sprung body, cabin fixtures, door-handle marker and brake lamps. It rebuilds the original authored geometry without fetching third-party models.

## Sealed-box encryption libraries

The first-launch cloud setup bundles two npm packages to encrypt provider API keys for GitHub Actions secrets (libsodium-compatible `crypto_box_seal`, see `src/client/setup/sealed-box.ts`):

- [tweetnacl](https://github.com/dchest/tweetnacl-js) 1.0.3 — public domain ([Unlicense](https://unlicense.org)).
- [blakejs](https://github.com/dcposch/blakejs) 1.2.1 — MIT License, Copyright (c) 2022 Blakejs contributors. The full license text ships in the package (`node_modules/blakejs/LICENSE`).

## Public redistribution review (FREE-03, 2026-10-23)

Checked before the repository goes public under MIT (`LICENSE`):

| Component | Licence | Public redistribution |
| --- | --- | --- |
| Agent Office (upstream code and history) | MIT, declared in upstream `package.json` | Compatible. **Flag:** the copied upstream revision has no standalone LICENSE or copyright line, so the MIT grant rests on package metadata. Attribution above stays; asking upstream to add a LICENSE file would remove the ambiguity. |
| Microsoft Rocketbox avatars, Tidewater conversions | MIT (licence files shipped next to the assets) | Compatible |
| Poly Haven textures and HDR | CC0 | Compatible |
| World sounds (Kenney, Freesound, BigSoundBank, OpenGameArt) | CC0 per file (`src/client/public/audio/README.md`) | Compatible |
| Executive sedan | Authored for this project; geometry is rebuilt by the repository's own Blender scripts | Covered by this repository's MIT licence |
| tweetnacl, blakejs | Unlicense, MIT | Compatible |
| npm dependencies (`package-lock.json`, 161 packages) | MIT, Apache-2.0, ISC, BSD-3-Clause, 0BSD, Unlicense; MPL-2.0 only in build-time `lightningcss` and `dompurify` (dev) | All OSI-approved; nothing copyleft is bundled into the shipped game |

Nothing found prevents public redistribution. SignPath Foundation additionally requires that every shipped component be OSI-licensed; the asset licences above (MIT, CC0) are accepted as open content but should be listed in the SignPath application (`docs/DISTRIBUTION.md`).
