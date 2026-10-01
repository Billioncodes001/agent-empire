# Phone windows: safe-area layout in landscape

Branch `claude/phone-windows`, from `4d34b32`. Owner: interface author (Claude, isolated worktree).

## Problem

On the iPhone 18 Pro simulator in landscape (874x402 points, Dynamic Island on one side), the big in-game windows
(Management, Cloud Empire, Issues/PR boards, terminal, changes, settings, queue, help) sat off-centre and partly under
the island, with the close button at the screen edge. The HUD cloud mark (U+2601 text glyph) rendered tiny on iOS.

Measured cause, reproduced in Chrome with real `env(safe-area-inset-*)` values (CDP `Emulation.setSafeAreaInsetsOverride`):

- Windows sized with `vw` (`min(1000px, 96vw)` for Management/Cloud Empire, `96vw` for the menu and help) were wider than
  the backdrop's padded area. The backdrop grid track grew to fit and the window overflowed to the right, under the
  island or past the edge (874x402, island left: window 62..901, close button at x 844-878).
- The backdrop padding was `max(16px, inset)` per side, so with a notch on one side the frame was 62px there and 16px
  on the other: every window was off-centre by 8px (or more) relative to the visible area.
- Close buttons were 34x34 px.

Baseline run of the new check against `4d34b32`: every window failed at 667x375, 812x375 and 874x402 with the notch on
either side (off-centre, outside the safe area, header off screen, close < 44px).

## Change

`src/client/style.css` (all windows share `openModal` in `ui/dom.ts`, so no logic change was needed there):

- The backdrop is a single `minmax(0, 1fr)` grid cell inset by `safe-area inset + gap` on every side
  (`--sa-t/r/b/l` from `env()`, `--win-gap` 16px; 8px on landscape phones). Windows are centred in the visible area
  and capped at `max-width/max-height: 100%`, so no `vw`/`dvh` size can push one under the notch, island or home
  indicator; the body scrolls instead.
- Landscape phones (`orientation: landscape` and `max-height: 500px`): the big windows (boards, terminal, changes,
  PR/issue window, Management/Cloud Empire, map) take the full safe height, and headers/footers are tighter. The
  Management/Cloud Empire header stays on one row (title, freshness, close) instead of wrapping.
- Touch (`html.ae-touch`): window close buttons are 44x44, footer buttons are at least 44px tall.
- With no insets (desktop, iPad) the frame is the previous 16px. Desktop 1440x900 layout is unchanged.
- HUD cloud mark: `src/client/cloud/ui.ts` renders a `span.cloud-glyph` (CSS-masked SVG, 17x12) before the status
  text instead of the U+2601 text glyph. The text node keeps the status wording; the button's aria-label is unchanged.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | 371/371 pass |
| `npm run build` | pass |
| `tools/mobile-ui-check.ts` (fixture `FIXTURE_PORT=4715`) | 401/401 pass (149 existing + 252 new window checks) |
| `tools/cloud-ui-check.ts` (same fixture, fake GitHub) | ALL PASS (88 checks, 9 new) |

New window checks (`MOBILE_UI_ONLY=windows` runs only these): 13 windows (menu, help, settings, management, issues,
pulls, queue, terminal, changes, team, upgrade, services, workers) at 667x375 and 812x375 (44px notch), 874x402
(62px island, 20px home indicator) with the notch on the left, on the right and on both sides, plus 1024x768 tablet
and 1440x900 desktop. Each window must: lie inside the safe area; be centred in it (±1.5px); on phones, fill the safe
height if it is a big window; keep header and footer on screen; have a close button inside the window that is the top
element at its centre and 44x44 on touch; have no header item drawn over another and a readable title; not overflow
sideways (header, footer, page). The close button is then tapped where it is drawn and the window must close.
The page reading the emulated insets is itself asserted. A regression check was run: removing the Management
header fix makes the 667x375 runs fail ("title squeezed to 0px").

`tools/cloud-ui-check.ts` now runs the phone sizes with an emulated island/notch and asserts that Cloud Empire and the
job confirmation sit centred in the safe area with a reachable 44px close button, and that the HUD cloud mark is drawn
at a legible size. Its regex for the HUD value no longer expects the text glyph.

Screenshots: `phone-windows/*.jpg` (island on the left at 667x375 and 874x402, tablet, desktop) and
`phone-windows/cloud/*.jpg`.

## Device check (iPhone 18 Pro simulator, iOS 27.0)

Built `AgentEmpire` for `iphonesimulator` (Debug, `CODE_SIGN_IDENTITY=-`, SYMROOT in the session scratchpad) with this
branch's `dist/public`, installed and launched on the booted iPhone 18 Pro. The island was on the right in this
orientation. Screenshots (`xcrun simctl io booted screenshot`, downscaled to 1311px) in `phone-windows/device/`:

1. `ios-01-cloud-hud.jpg`: the app opened in a saved cloud session left from an earlier test; the drawn cloud mark is
   legible in the HUD.
2. `ios-02-cloud-empire.jpg`, `ios-03-cloud-menu.jpg`: Cloud Empire and the menu, centred with equal margins, clear of the
   island, close button in reach.
3. "Forget this device" (removes the stale simulator test sign-in), then setup, then "Connect my own server" against the
   fixture `http://127.0.0.1:4715` with the fixture password.
4. `ios-04-management.jpg`, `ios-05-menu.jpg`, `ios-06-issues.jpg`, `ios-07-settings.jpg`: Management, the game menu,
   Issues board (full safe height) and Settings, all inside the safe area and centred.

The device build predates the final Management-header tweak, which only applies at widths up to 760px (not the
874-point iPhone 18 Pro); the browser checks cover it at 667x375. This is simulator execution, not a physical device.

## Notes

- `tools/mobile-ui-check.ts` still writes its older screenshots to `docs/team/reports/mobile/`; those were not
  refreshed in this change.
- Nothing ran against the protected 4610 session; no paid calls; no model downloads.
