# Codebase audit fixes (PR #2)

Author branch: `claude/empire-audit-fixes`, based on integration commit `be62b1d`. Candidate reviewed: `547e42c`. Review fixes: `464e8d4` and `030e5c7`. PR: [#2](https://github.com/Billioncodes001/agent-empire/pull/2) into `codex/empire-world`. The draft PR #1 (`codex/empire-world` → `main`) is untouched.

Author: Claude (Claude Code). Reviewer: a separate Claude review agent. Grok was not reachable from this session, so this is not the Grok review the workflow names.

## What changed

The fixes were found by an audit of the upstream Agent Office base (`main`, `d4ff929`) and ported onto this branch. Hunks were dropped where the empire code no longer had the bug, and the empire art direction was kept. The PR description lists every change. In summary:

- **Server**
  - The WebSocket message handler can no longer crash the process.
  - Config, decor and usage are saved through `writeJsonAtomic`. A corrupt `config.json` stops startup instead of minting a new password.
  - Per-worker usage is carried across `/clear`, and the ledger books growth only, measured from a persisted high-water mark.
  - The Changes PR cache expires.
  - Upgrade rollback works, and a failed rollback stays flagged instead of being silently cleared.
- **Client**
  - Held action keys don't repeat, and Enter/Space act on focused buttons. IME-safe chat, a whoami timeout, and a diff refetch after reconnect.
  - Voice reuses its mic sender. Screen share reuses its sender, which was measured with two Chrome peers: 1 → 2 → 3 transceivers before, 1 → 1 → 1 after.
  - Leaving peers' characters and laptops are disposed.
  - The queue form keeps focus, and dialogs protect typed text. The share viewer opens the clicked share.
  - Layout and accessibility fixes: toast layering, `aria-live`, footer wrap, dvh.
  - The chief panel reads "Connecting…" until the first connection, and "Disconnected" after a real drop.
- **Android:** a failed load hides the WebView, so only the companion's own message shows. Any new allowed load shows it again.

## Review

The candidate at `547e42c` was **ACCEPT WITH FIXES**. All but one finding was fixed in `464e8d4`:

- **High:** the ledger clamp dropped a downward cost-state correction, and the next scan then booked the dip again. Fixed with the persisted `booked` high-water mark; covered by `tests/usage-booking.test.ts`.
- **Medium:** 'connecting' was keyed on `receivedAt`, which is reset on every drop. It is now keyed on whether the client ever connected; test updated.
- **Low:** Android Back after a failure could leave a blank view. Fixed.
- **Low:** a failed rollback could be cleared, and `.upgrade/old` deleted. Fixed.
- **Low, accepted as-is:** if GitHub stays unreachable for more than 5 minutes, "Open PR…" can reappear. A retry then shows gh's "already exists" error.

The re-review of `464e8d4` confirmed the ledger and status fixes and was **ACCEPT WITH FIXES**. `030e5c7` addresses its findings:

- **Medium:** a successful upgrade left `.upgrade/old` behind and triggered a false "never restored" warning, and the in-memory flag was lost on restart. A failed rollback now writes `.upgrade/NEEDS_RESTORE`. On start, the office restores that error, refuses to upgrade and keeps the stage. Without the marker, the stage is cleaned. Checked with a scratch `Upgrader` in both states.
- **Low:** the old transcript's tail is now booked at the `/clear` switch itself.
- **Low (device check):** the WebView callback order was checked on the API 35 emulator. With an offline host, Reload keeps "Host unavailable" and the view stays hidden.

Final check of `030e5c7`: **ACCEPT**. No Critical, High or Medium issue remains in `be62b1d..030e5c7`. The reviewer relied on the emulator evidence above for the Android callback order.

## Checks

- `npm run typecheck` passes, `npm test` passes 201/201, and `npm run build` passes on `030e5c7`.
- **Browser, headless Chrome:** desktop 1440 px and phone 375 px. No console or page errors, no horizontal overflow, and no top-bar control off-screen. The founder setup dialog fits at 375 px.
- **macOS app:** packaged and launched with an isolated `--user-data-dir`. The launcher and local city load with no page errors. The real profile was not modified. Founding setup was not completed.
- **Windows x64 ZIP:** PE, Node-API and archive checks pass. **Not executed on Windows.**
- **Android APK:** built and installed on an isolated API 35 emulator.
  - HTTP, self-signed and unreachable hosts are refused with the companion's own message, and Reload and rotation work. No crashes.
  - **Authenticated login to a trusted HTTPS host is not tested.**
- **iOS:** not built. Only Command Line Tools are installed on this host.
- **Live Agent Office check** (`main` base, throwaway clone): GitHub boards loaded the real PR #1, and one real Claude worker answered a one-line prompt. No paid worker calls were made against the Empire build.
- localhost:4610, Pixel and its save were not touched.

## Not included

- Lighting, tone mapping, camera collision and first-person hands from the `main` audit. Empire has its own HDR/PBR look and camera.
- The queue-stall fix. Empire restores workers `offline`.
- The `main`-based branch `claude/codebase-audit-improvements-46869a` is kept local. Pushing it to `main` would conflict with PR #1's lifecycle.
