# Corporate outfits

Branch `claude/corporate-outfits`, based on `codex/empire-world` @ `4a0539d`. Owner request of 2026-10-02: the CEO and the chief of staff wear suits, every AI worker gets a default corporate outfit, and the owner can choose a worker's outfit when hiring it.

## What shipped

**Avatars.** Ten Microsoft Rocketbox business avatars (MIT) are built into `src/client/public/models/avatars/`. Each is a mesh-only GLB (7.0k–9.0k triangles, 80 Bip01 bones, 222–307 KiB) with external WebP textures at 1024² and 512². Every avatar also has a lossless 512² recolour mask.

| Role | Rule (src/shared/outfit.ts) |
| --- | --- |
| CEO (player, peers) | `look.style` selects one of the six suits: Business_Male_01 (black, red tie), Female_01 (black trouser suit), Male_02 (navy), Female_04 (pinstripe), Male_03 (charcoal, teal tie), Female_03 (taupe skirt suit). Male and female alternate, so a saved profile keeps the body it had before (even style was the male rig, odd style the female rig). |
| Chief of staff | Business_Female_03, or Business_Male_02 when the CEO wears a female avatar. It never wears the CEO's avatar, and it changes when the CEO changes suits. |
| AI workers (desk workers, sector managers and staff) | A stable FNV hash of the worker id picks from Male_05, Male_04, Male_06, Female_02, Female_01 or Male_03, unless the owner chose an outfit when hiring. |
| City residents | The worker list (they previously used the founder rigs). |

**Shared clips.** Animations live in `clips-male.glb` (1.3 MiB) and `clips-female.glb` (1.25 MiB). They are built from the licensed founder (Joe) and chief-of-staff (Marta) rigs with these rules:

- rotation tracks on every bone
- translation on `Bip01_Pelvis` only
- no scale tracks
- `neutral_bone` dropped
- constant tracks collapsed and linear keys reduced (≤0.0008 rad)
- int16-normalized quaternions

A clip never imposes Joe's bone lengths on another body. Every avatar's rest pose matches its clip rig within 0.04° on every bone, and the pelvis frame and hip height match exactly (male 0.895 m, female 0.923 m). A test checks this. The two source rigs moved from `public/models/` to `tools/avatars/rigs/` and are no longer shipped.

**Runtime (src/client/world/avatars.ts, human.ts).**

- Avatars and clips load lazily and are cached. Clones share geometry, textures and default materials.
- Phones (coarse pointer with a short side under 600 px) and Save-Data get the 512² textures. This works through a URL modifier on three's default loading manager, so the splash still counts and names these files.
- Recolouring clones only the body material and adds a mask and uniforms through `onBeforeCompile`. All recoloured bodies share one program (`customProgramCacheKey`). Each region is dyed to the chosen colour and shaded by its texel's brightness relative to the region mean, so folds, stripes and seams survive.
- The black-silhouette guard and texture repair still work. Repaired textures are copied into the shared materials, and recoloured copies are rebuilt afterwards.
- Bodies are normalised to their own height (1.73–1.82 m) instead of 1.78 m for everyone.
- Skinned bodies are no longer frustum-culled. A new hire that walked to its desk was invisible because its cached bounding sphere was stale. This was found in the fixture and fixed.

**Character select.** The `Character model` radiogroup (same aria label and roles) lists the six suits with a small suit/shirt/tie chip. `Random profile` and the turntable are kept. The visible section label reads "CEO suit".

**Hire dialog (P at an empty desk, "Hire with a task").**

- A collapsed `👔 Outfit` section defaults to "Default corporate attire".
- Opening it offers all ten avatars, then colour swatches for suit, shirt and tie. "Original" is the first swatch in each row. Labels follow the garment (Trousers, Blouse, Top), and tie colours appear only on avatars that wear a tie.
- A live turntable preview appears once an avatar is chosen. It is disposed when the dialog closes.
- The quick hire (E) and the board "ask" flow still hire in default attire.

**Protocol and persistence (additive, backward compatible).**

- `WorkerInfo.outfit?` and `worker.spawn.outfit?` are new.
- The server sanitizes outfits: known avatar only, `#rrggbb` colours only, and no tie colour on a tieless avatar.
- `workers.json` stores the outfit, and restore sanitizes it. A legacy or tampered entry falls back to the default and never blocks the restore.
- The server MIME map now has `.webp` and `.glb`.
- **Cloud mode schema is unchanged.** Cloud jobs never create a desk body (`store.workers` stays empty in cloud mode). A job there has no body to dress, so I added no intent or job field. Cloud-mode sector managers wear the default worker rule.

## Build pipeline

`npm run build:avatars` runs `tools/avatars/build-avatars.ts`. It is TypeScript only and adds no new npm dependencies: three's FBXLoader and TGALoader run in Node, and a small deterministic GLB writer (`tools/avatars/glb.ts`) replaces glTF-Transform.

- **System tool:** WebP encoding uses `cwebp` (libwebp 1.6.0 here; `brew install webp`).
- **Inputs:** the FBX and TGA files at Rocketbox commit `0943055db6ec570bcef9f2c8b41c9e5467c808f9` download into the git-ignored `.cache/rocketbox/` and must match `tools/avatars/sources.lock.json` (59 SHA-256 entries). Specular maps are not downloaded.
- **Reproducibility:** two consecutive builds produced byte-identical outputs (120 files).
- **Masks (`tools/avatars/masks.ts`):** these are derived from the mesh, not painted by hand.
  1. Body triangles are rasterized into texture space and grouped into UV islands.
  2. Hands and shoes are excluded by skin weights.
  3. A tie is a narrow piece on the chest centre line.
  4. Shirts are light, low-saturation islands, and bare skin is excluded by tone.
  5. Five avatars need small documented island overrides (M04 shirt sleeves under a waistcoat, M05 purple shirt, F02 striped top, F03 dark top).
- **Flags:** `--debug` writes false-colour mask previews, `--only=` builds a subset, and `--relock` records new checksums after a deliberate pin change.
- **Blender:** not needed. The FBXLoader path worked for all ten avatars.

## Checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` | 497/497 (405 on base). New: models.test.ts runs every existing body test on all 10 avatars (adult scale and independent bones, grounded locomotion/sit clips, typing IK wrists and fingers, held vehicle pose, flight frame, jump/landing, walk↔run continuity, amenity poses), plus clip-file rules, rest-pose and hip-height match, and shipped files (dielectric materials, both texture sizes, masks, regions). tests/outfit.test.ts covers CEO parity, the chief rule, stable worker defaults, sanitizing, persistence across a restart with a tampered save, and the shader hook into three's chunks. |
| `npm run build` | pass |
| `tools/mobile-ui-check.ts` (fixture :4734) | 411/411, including all 10 lighting checks |
| `tools/outfit-ui-check.ts` (fixture :4719, `FIXTURE_WORKERS=5`) | 19/19, no console errors or missing assets at desktop or phone size |

**Change to the lighting check.** It now uses the taupe suit (style 5). It samples the chest, and a black suit is legitimately near-black there even when lit; with style 0 it failed for that reason alone. With the taupe suit, normal and transient loads measure luminance 0.38 with 0% near-black, and the permanent failure measures 0.28. The permanent-failure splash again names "character textures", after a fix in `ui/loading.ts`.

**Fixture additions.** `tools/ui-fixture.ts` gains `FIXTURE_WORKERS=n`, which seats display-only staff, and a display-only hire answer to `worker.spawn`. Nothing runs and no provider is called.

## Screenshots (docs/team/reports/corporate-outfits/)

- `01-character-select-1440x900.jpg`: suit catalog
- `01b-character-select-female-ceo-1440x900.jpg`: female CEO selected
- `02-ceo-in-game-1440x900.jpg`: black suit, red tie
- `03-chief-of-staff-1440x900.jpg`: taupe skirt suit for a male CEO
- `04-desk-workers-default-attire-1440x900.jpg`: desk staff in default attire
- `05a-hire-dialog-outfit-1440x900.jpg`: outfit picker with a burgundy, sky-blue and gold preview
- `05b-customised-worker-1440x900.jpg`: the hired worker typing in that outfit
- `06-phone-landscape-812x375.jpg`: pinstripe CEO, 512² textures
- `lighting-*-874x402.jpg`: the three lighting scenarios

## Performance

Measured with headless Chrome (Metal), vsync off, same fixture content (1 worker), base build vs this branch. Raw data is in `perf-before.json` and `perf-after.json`.

| | Desktop 1440×900 before → after | Phone emulation 812×375 before → after |
| --- | --- | --- |
| Bytes for people (avatars, clips, textures) | 13.47 → 9.18 MiB | 13.47 → 6.54 MiB |
| All `/models/` bytes | 16.50 → 12.2–13.0 MiB | 16.50 → 9.2–9.6 MiB |
| Frame time, mean / p95 | 3.9 / 4.8 → 4.1 / 4.9 ms | 3.0 / 3.7 → 3.3 / 4.9 ms |
| Triangles drawn | 806.6k → 819.9k | 819.8k → 833.1k |

The shipped `dist/public` people assets are now 12 MB for all ten avatars, both texture sets, masks and clips, replacing 13.7 MB. Only the avatars actually worn are downloaded. The small frame-time increase comes from the unculled skinned bodies.

## Not done or unverified

- **Lowpoly 33-bone variant:** not built. The Rocketbox `Export/` folder has only the hipoly mesh, and these avatars (7–9k triangles) are about the size of the rigs they replace (7.1k and 9.3k). Phones get the 512² texture set instead. A meshoptimizer LOD (three ships the simplifier) is possible later.
- **KTX2:** not used. There is no `toktx` or `basisu` and no new dependencies; WebP is used instead.
- **iPhone 18 Pro simulator:** not run by the author; run afterwards by the coordinator (2026-10-02, see "iPhone follow-up" below).

## iPhone follow-up (coordinator, 2026-10-02)

Debug simulator build of `codex/empire-world` after PR #9, installed fresh on the iPhone 18 Pro simulator (iOS 27). The update re-run had left a downloaded `1.0.0-beta.2` game bundle (older code) active in the app, which the shell rightly prefers over the built-in `1.0.0-beta.1`; the app was reinstalled to drop it.

- **Works on iOS WebKit:** the founder card shows the suit catalogue with textured previews (black suit, pinstripe, taupe skirt suit), switching suits re-dresses the preview, and the CEO walks the city in the chosen suit. No black silhouettes.
- **Bug fixed: founder card clipped in phone landscape.** The preview had a fixed 360px height inside a ~261px card body at 874×402, so the figure's legs and the last suit row were cut off. In landscape at heights ≤ 520px the preview now fills the body and the options scroll beside it.
- **Bug fixed: name field unusable with the keyboard open.** About 113px stay visible above an iPhone landscape keyboard. The card body was 23px tall, the name field sat below it and Return did nothing. When less than 200px is visible above the keyboard (`html.ae-kb-tight`, set by `keyboard.ts` from the visual viewport, so it works on iOS where media queries can't see the keyboard), the founder card shows only the name field, Continue and, on the returning-player dialog, Close. The title, suits and accents return when the keyboard closes. Tablets and portrait phones keep the whole card (review finding).
- **Checks:** `tools/outfit-ui-check.ts` adds 10 checks. At 874×402, 812×375 and 667×375 it checks that the preview fits, that scrolling the options column brings the last suit on screen, and that the name field and Continue are fully visible with the keyboard open. The keyboard is simulated as the Android app sees it, by shrinking the viewport while the field has focus and waiting for `ae-kb`. A tablet check at 1024×768 confirms the card keeps its title and suits with the keyboard open. 8 of these fail without the CSS fix (21/29) and all pass with it (29/29). Independent review: ACCEPT WITH FIXES, fixes applied. `mobile-ui-check` 411/411. The fixed layout was confirmed on the simulator, including scrolling the suit list. `06b-character-select-phone-874x402.jpg`.
- **Observed, not changed:**
  - The simulator's first tap on a control often only focuses it, as seen before on the name field. Check on a real device.
  - iOS keeps Keychain items across an uninstall, so a reinstalled app resumes its old server session (here a stopped test server, so it kept reconnecting, which is correct for an unreachable host). Whether a reinstall should start signed out is a product decision.
- **Recolour quality:** the mask rules are heuristics, checked visually in the debug previews and the screenshots above. Painted details such as M03's tie knot on the shirt front and F02's two-tone jacket and trousers take the shirt or suit colour together.
- **Specular and roughness:** these are constant per material (body 0.78, head 0.58). The Rocketbox specular maps are not converted.
