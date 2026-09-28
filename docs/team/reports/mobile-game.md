# Mobile game shell (MOBILE-01, MOBILE-02, MOBILE-03)

Branch `claude/mobile-game`, baseline `aabee56`. This covers the web client only. **MOBILE-04 (native iOS/Android edits) was dropped** by a scope change: the apps will bundle the client, so `mobile/ios` and `mobile/android` are untouched.

## Implemented

**MOBILE-01: game shell**
- A branded splash (`#splash` in `index.html`) with inline critical CSS, so it paints before the ~820 kB bundle arrives. It uses the Empire tower mark, the dark/teal palette and safe-area padding.
- The progress bar is driven only by real work (`src/client/ui/loading.ts`, imported first by `main.ts`):
  - three.js `DefaultLoadingManager` item start and end, counted by kind: models, textures, sky lighting, audio and data. Every GLTF, texture and HDR loader in the client uses that manager.
  - The existing `canvas.dataset.assets === 'ready'` flag, which reserves the final 10%.
  - The stage text names what is pending, for example "Loading models 6/8 · audio & data 0/13" and "21 of 36 files".
  - There is no timer-driven progress. An "Enter anyway" button appears only when a file failed (the failed file is named) or when every file settled but the scene has not reported ready for 20 s.
  - `html[data-boot]` is `loading`, `ready` or `forced`.
- A game menu (`src/client/ui/game-menu.ts`):
  - Opened by a Menu button, which is the last top-bar control, or by the `` ` `` key. That key cannot be remapped (`validKey` rejects it), is ignored in text fields and terminals, and does not touch Esc semantics. Esc still closes the menu like any other modal.
  - Offers Resume, Map, Management, Settings (reuses `#btn-settings`), Controls, Chat (touch only) and Sign out.
  - Controls opens touch help on touch devices, with a link to the keyboard help.
  - Sign out asks for confirmation, then calls `POST /api/logout` and goes to `/login`, both resolved through the new `src/client/endpoint.ts` `hostUrl()`. That helper uses `meta[name=agent-empire-host]` or `window.AGENT_EMPIRE_HOST` if set, else the page origin, so a bundled app can point it at a remote host.
  - An "Office tools" section lists any top-bar buttons the current layout hides, by forwarding clicks to the real buttons, so nothing becomes unreachable on phones.
  - The Help list gains a `` ` `` row.
- The sign-in page and claim page are rebranded: dark HUD surface, tower mark, "Agent Empire · Sign in to your city". The `#password` / `#submit` / `#form` / `#error` ids and `login.ts` are unchanged. The layout is compact at landscape phone heights and uses `viewport-fit=cover` with safe-area padding.

**MOBILE-02: landscape touch controls** (`src/client/ui/touch.ts`, `src/client/touch-input.ts`)
- Touch mode is `html.ae-touch`, set from `(pointer: coarse)`; `?touch=1` or `?touch=0` overrides it.
- A floating analog joystick on the left 42% of the screen: the base jumps under the thumb. It maps to the existing forward, backward, left, right and run actions through `player.setAction`, so desktop keys and remapping are untouched.
  - The pure function `stickActions` has a dead zone (0.18), 8-way hysteresis (on 0.42 / off 0.30) and a run threshold at 0.8 deflection with hysteresis back at 0.72.
  - Directions are 8-way, not continuous, because they reuse the key actions.
- Jump, Use (E, the same interact path as before) and View buttons sit bottom-right.
  - Jump holds its action for at least 120 ms, so a quick tap registers.
  - The buttons never take focus on touch, which would swallow keyboard input.
- Dragging the scene outside the controls orbits the camera (third person) or looks around (first person); tapping the scene uses what you tap.
  - `player.ts` got a small input-only fix: the drag tracks a single `pointerId`, so the joystick finger no longer steers the camera.
  - `#scene` has `touch-action: none`.
- Controls hide while any modal is open (`html.ae-modal`) or a text field or terminal has focus (`html.ae-typing`). Held actions are released on hide, window blur and when the page is hidden.
- Portrait phones (≤560 px wide) get an opaque "Rotate your device" overlay; the splash also shows a rotate hint in portrait.
- The old 4-arrow `.empire-touch` buttons and their CSS are removed.
- All controls use `env(safe-area-inset-*)`, and so do modal backdrops, which now keep windows clear of a notch or Dynamic Island on either side.

**MOBILE-03: phone HUD** (touch mode only; desktop unchanged apart from the Menu button)
- A single-row top bar:
  - The project name only.
  - The status strip as one line: chief-of-staff state plus workforce counts. It still opens Management and the worker list.
  - Management and Menu buttons. Other tools move into the menu.
- A 96 px minimap at top right with the place label; key hints are hidden.
- The side panel is hidden; the workers are reachable from the status strip and Management.
- Chat is hidden until chosen from the menu. It then shows at top left and closes on blur.
- Toasts, the connection banner, traversal and lift hints, and screen-share thumbnails move clear of the controls.
- The interaction hint is centred between the joystick and the buttons.
- The third-person camera was left unchanged. At every tested size the character sits centre-frame, clear of both control clusters, so no FOV change was needed.

## Evidence

Evidence comes from the isolated fixture only (`FIXTURE_PORT=4701 npx tsx tools/ui-fixture.ts`). Port 4610, `.agent-office` and paid workers were never touched.

- `npm run typecheck`: pass.
- `npm test`: 207/207 pass. The baseline was 201; 6 new tests are in `tests/touch-input.test.ts`, including one that drives a real `PlayerController` through walk, run and release. The existing `camera.test.ts` still passes after the pointer-id change.
- `npm run build` (client and server): pass.
- `FIXTURE_URL=http://localhost:4701/ npx tsx tools/mobile-ui-check.ts`: **101/101 checks pass**. It uses Chrome through playwright-core with `isMobile` and `hasTouch`, and real CDP touch events.
  - Landscape sizes tested: 667×375, 812×375, 874×402, 932×430 and 1024×768.
  - At every landscape size:
    - The splash is present before assets load.
    - There is no horizontal overflow.
    - All controls are inside the viewport and none overlaps another control or the HUD (minimap, project, status, top-bar buttons).
    - The top bar is one row (44 px).
    - Touch targets are at least 36 px: Jump 74, Use 58, View 46, Menu 36.
  - At 667×375, 874×402 and 1024×768, also checked:
    - A joystick push moved the player about 1.5 m, and full deflection reported `run` (about 4.5 m).
    - Releasing the stick stops the player, and a Jump tap made the player airborne.
    - A right-side drag changed camera yaw by more than 1 rad.
    - The Menu opens and hides the controls; its entries are present and 8 hidden tools are reachable; Esc closes it and the controls return.
    - Chat from the menu focuses the input and hides the controls, and the panel closes on blur.
  - 375×812 portrait with reduced motion: the rotate overlay covers the screen and its animation is `none`.
  - 1440×900 desktop:
    - Touch UI is hidden, and the side panel, chat and bottom-left minimap are unchanged.
    - Settings, Help and Menu are in the top bar.
    - `` ` `` opens the menu (no tool duplicates) and Esc closes it.
    - Arrow keys still move the player.
  - Login at 667×375: the ids are kept, the page is branded, and Submit is visible.
  - There were no console or page errors at any size. The fixture's missing `/api/continuity/status` 404 is a fixture limit and is reported separately.
- Screenshots in `docs/team/reports/mobile/`:
  - `splash-874x402.png`
  - `landscape-667x375.png`, `landscape-932x430.png`, `landscape-1024x768.png`
  - `menu-667x375.png`, `chat-874x402.png`
  - `portrait-375x812.png`, `login-667x375.png`
  - `desktop-1440x900.png`, `desktop-menu-1440x900.png`
  - `ios-sim-safari-portrait.png`
- iOS Simulator (iPhone 18 Pro, iOS 27, mobile Safari to `http://localhost:4701/`): the page loaded and the rotate overlay showed in portrait (`ios-sim-safari-portrait.png`).

## Not verified / known limits

- **Landscape on the iOS Simulator was not exercised.** Only the headless CoreSimulator is running; there is no Simulator.app, so the device could not be rotated. The landscape evidence above is Chrome device emulation, not WebKit.
- No physical-device acceptance: real touch feel, notch or Dynamic Island insets on hardware, iOS Safari toolbar behaviour, and frame time on the low preset on a phone.
- Save-Data was not emulated. The splash is inline SVG and CSS and adds no media.
- The desk hint still lists keyboard-only actions (P/B/C/O/R/X). On touch only E (Use) or a tap is available, so prompting, shell, changes, PR and send-home have no touch path yet.
- The joystick is 8-way: analog magnitude selects walk or run, but direction is quantized because it reuses the key actions. Continuous steering would need an analog input in `PlayerController` (the other author's lane).
- No pinch-to-zoom for the third-person camera distance.
- Sign out: the fixture has no `/api/logout`, so only the confirmation dialog was exercised. The real server endpoint exists (`src/server/server.ts`).
- No new Higgsfield or video assets; the splash reuses the existing PWA tower mark. A motionsites.ai check yielded no concrete loader patterns.
