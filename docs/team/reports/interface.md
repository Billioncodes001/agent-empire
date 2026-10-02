# Interface report: first-round plan

Author: Interface role (Claude Opus 5.5, VS Code Copilot). Branch `codex/team-interface`, based on `a444e5f` (audited source `8b13f52`).
Scope: a planning and verification pass only. I changed no product code, started no workers or servers, and did not touch `.agent-office`.

Labels used in this report: **[Implemented]** is current behaviour read from source. **[Plan]** is proposed work. **[Unverified]** is inferred from code and not yet checked in a browser.

---

## 1. Current UI audit

### 1.1 Chief of staff and worker state (highest priority)

- **[Implemented] The HUD reports a flag as if it were activity.** The radar status line appends `· Chief of staff on duty` whenever `store.empire.delegated` is true ([src/client/ui/empire.ts](../../../src/client/ui/empire.ts#L642)). It ignores the chief's actual assignment, `sectors[hq].manager.status`. This is the audit defect: the HUD said "on duty" while the manager was `offline`.
- **[Implemented] `delegated` does nothing on the server.** `Empire.action({kind:'delegate'})` only writes a report line ([src/server/empire.ts](../../../src/server/empire.ts#L174-L182)). In the client it only moves the chief's avatar between two positions ([src/client/world/city.ts](../../../src/client/world/city.ts#L537)). No supervisor process depends on it.
- **[Implemented] Walking through the HQ door sets `delegated` without telling the user.** The traversal callback sends `delegate: true` ([src/client/main.ts](../../../src/client/main.ts#L205-L207)).
- **[Implemented] The Management modal overstates the chief.** It always shows the heading "Chief of staff · administrative monitoring active" and says the chief "tracks every sector … real worker blockers" ([src/client/ui/empire.ts](../../../src/client/ui/empire.ts#L296)). The only ongoing monitoring is `Empire.tick`, which runs deterministic rules every 5 s ([src/server/empire.ts](../../../src/server/empire.ts#L315)).
- **[Implemented] "ready" is shown as if work were happening.** Manager status `ready` means the startup-brief task finished with `outcome === 'done'` ([src/server/empire.ts](../../../src/server/empire.ts#L342-L356)). No process is live after that. The UI shows "Ready for work · startup completed" ([src/client/ui/empire.ts](../../../src/client/ui/empire.ts#L357)). `managerAvailable()` counts `ready` as available for entrances and revenue ([src/shared/empire.ts](../../../src/shared/empire.ts#L243-L244)), and `entranceAccess` shows "on duty" for non-ready statuses ([src/client/navigation.ts](../../../src/client/navigation.ts#L14)).
- **[Implemented] Empire state has no staleness indicator.** Empire state arrives in 5 s broadcasts. The Management modal says "LIVE SERVER STATE" ([src/client/ui/empire.ts](../../../src/client/ui/empire.ts#L281)) even while disconnected. The only disconnect signal is the `#conn` banner ([src/client/main.ts](../../../src/client/main.ts#L255)).
- **[Implemented] Workforce counts can lag by up to 5 s.** They come from `empire.workforce`, recomputed each tick. `store.workers` and `store.queue` update immediately and are the better source for the HUD.

### 1.2 Management and reports

- **[Implemented] Management is one long modal with a backdrop.** It stacks 7 metrics in a 4-column grid, the brief, every sector card, the ledger, payroll and 18 reports ([src/client/ui/empire.ts](../../../src/client/ui/empire.ts#L248-L509)). Opening it hides the world and disables player input, because `onModalChange` sets `player.enabled = false` ([src/client/main.ts](../../../src/client/main.ts#L886)).
- **[Implemented] Reports are unstructured.** `EmpireReport = {at, sector, text}`, where `sector` is a display string such as "Chief of staff" or "Treasury" ([src/shared/empire.ts](../../../src/shared/empire.ts#L135-L139)). There is no kind, severity, site ID or task/worker link, so the client can only list reports in time order. It must not parse the free text.
- **[Implemented] Management has no keyboard shortcut.** It is reachable only from the topbar button.

### 1.3 Visual hierarchy

- **[Implemented] [src/client/style.css](../../../src/client/style.css) layers three themes.** The original thick-bordered cartoon theme (lines 1–610) is followed by a light "calm" override ([line 612](../../../src/client/style.css#L612)) and then a dark "cinematic" HUD override ([line 647](../../../src/client/style.css#L647)). The result is inconsistent surfaces:
  - Dark: map, founding, HUD panels.
  - Light paper: Management, Headquarters, Settings.
  - Dark quality cards inside the light Settings modal.
- **[Implemented] The topbar holds up to 14 buttons.** Emoji-only and text buttons are mixed, and `Management` and `HQ · Floor n` are appended at runtime ([src/client/ui/empire.ts](../../../src/client/ui/empire.ts#L22-L29), [src/client/tower.ts](../../../src/client/tower.ts#L16)). The buttons wrap on narrow widths.
- **[Implemented] Radar status text is hard to read.** It is 9 px at 0.65 opacity ([src/client/style.css](../../../src/client/style.css#L674)), which is likely below WCAG AA contrast. **[Unverified]**

### 1.4 Keyboard, accessibility and small screens

- **[Implemented] `openModal` has incomplete dialog handling** ([src/client/ui/dom.ts](../../../src/client/ui/dom.ts#L47)). It handles Esc and backdrop clicks. It does not:
  - move focus into the dialog;
  - trap Tab;
  - restore focus to the opener;
  - set `aria-modal`.

  Keyboard users start each dialog at the canvas.
- **[Implemented] Emoji-only buttons get emoji as their accessible name.** This affects `#btn-decor` 🖼️, `#btn-upgrade` ⬆️, `#btn-mute` 🔇, and the voice/share buttons at ≤800 px where their `span` is hidden ([src/client/index.html](../../../src/client/index.html#L17-L31)).
- **[Implemented] Worker status disappears on small screens.** At ≤800 px `.side` (people and workers) is `display:none`, and at ≤900 px chat is also hidden ([src/client/style.css](../../../src/client/style.css#L285-L286)).
- **[Implemented] Touch controls may overlap chat.** The touch pad sits bottom-right (`right:15px; bottom:20px`) and chat was moved there too (`right:20px; bottom:22px`) ([src/client/style.css](../../../src/client/style.css#L643), [line 663](../../../src/client/style.css#L663)). On a coarse-pointer device wider than 900 px, they probably overlap. **[Unverified]**
- **[Implemented] There is no `prefers-reduced-motion` handling.** The `needs_input` pill pulses indefinitely ([src/client/style.css](../../../src/client/style.css#L94)).
- **[Implemented] Adding a key action is a migration trap.** `sanitizeKeys` returns defaults if a saved map lacks any action other than `map` or `camera` ([src/client/controls.ts](../../../src/client/controls.ts#L48-L68)). A new action added naively would wipe every user's remaps.

### 1.5 Existing behaviour to preserve (confirmed in source)

- First/third-person views and the `N` toggle.
- Arrow-key defaults, remapping and conflict swap.
- Physical door traversal ([src/client/traversal.ts](../../../src/client/traversal.ts)).
- Minimap and full map that only set waypoints.
- Graphics presets.
- No teleport or location selector. The smoke test asserts that no `Office ↔ City` or `Go home` button exists ([tests/browser-smoke.mjs](../../../tests/browser-smoke.mjs#L22-L23)).

---

## 2. Status mapping from existing fields

These are pure client functions using only fields that already exist. No backend change is needed for slice 1.

- **Chief** = `store.empire.sectors.find(s => s.id === 'hq').manager`.
- **Task** = `store.queue.tasks.find(t => t.jobKey === manager.jobKey)`.
- **Worker** = `store.workers.get(manager.workerId ?? task.workerId)`.
- **Connection** = `net.onStatus`.
- **Freshness** = client receipt time of the last `empire` message.

Rules are evaluated top to bottom; the first match wins. The same function is reused for every sector manager.

| # | Condition | Tone | Label | Detail / action |
|---|---|---|---|---|
| 1 | Socket down, or no `empire` message for more than 15 s | `unknown` | Status unknown | "Reconnecting…"; the last known value is shown greyed |
| 2 | `!setup.completed` | `idle` | Not appointed | "Complete founding setup" |
| 3 | No `manager` | `idle` | Not appointed | — |
| 4 | `pending` with `error` set | `attention` | Startup not dispatched | `error`; **Retry** (`retry-manager`) |
| 5 | `pending` | `idle` | Startup pending dispatch | — |
| 6 | `queued` and `queue.maxWorkers === 0` | `attention` | Startup queued · queue paused | Opens Queue |
| 7 | `queued` | `idle` | Startup queued | "Position n of m" from queued-task order |
| 8 | `working` and worker `starting` | `active` | Starting agent | Worker name; **Open terminal** |
| 9 | `working` and worker `working` | `active` | Writing startup brief | Worker name, `activity`; **Open terminal** |
| 10 | `needs_input` | `attention` | Needs your input | **Open terminal** (`workerId`); announced once through `aria-live` |
| 11 | `ready` | `idle` | Idle · startup brief complete | "Finished {timeAgo(task.finishedAt)} · no active job"; **Assign task** |
| 12 | `offline` | `attention` | Offline | `error`, for example "Manager task is no longer in the queue"; **Retry** |

Separate rules:

- `delegated` becomes its own neutral line, "Oversight: delegated to chief (reports only)" or "Oversight: CEO". It never adds "on duty".
- Only rows 8–10 may use the words "working", "active" or "on duty", and only when a linked worker exists in `store.workers` with `starting`, `working` or `needs_input`.
- The workforce chip is derived from `store.workers` and `store.queue`:
  - **active**: `status ∈ {starting, working}`
  - **need input**: `status === needs_input`
  - **done, unreviewed**: `status === done && !acked`
  - **queued**: queue tasks with `status === 'queued'`

  It shows AI spend (`store.usage.today.cost`) next to credits only as a separate, labelled figure, so it is not confused with fictional credits.

---

## 3. First implementation slice

Goal: truthful state, a non-obstructing report view, and baseline keyboard and small-screen fixes. No changes to `src/shared/` or `src/server/`.

| File | Change |
|---|---|
| `src/client/ui/status.ts` (new) | Pure functions `managerStatus(sector, queue, workers, conn, now)` and `workforceSummary(workers, queue)`, returning `{tone, label, detail, action?}`. They have no DOM or store imports, so they can be tested. |
| `src/client/state.ts` | Add client-only `connected: boolean` and `empireReceivedAt: number` to `Store`. Set them in `apply('empire')` and from `net.onStatus`. Add a `'connection'` topic. |
| `src/client/index.html` | Add a `#status-strip` container (`role="status"`, `aria-live="polite"`) under the project panel. Add `aria-label`s to emoji-only buttons. |
| `src/client/ui/hud.ts` | Add `renderStatusStrip()`, which shows the chief chip, workforce chip and oversight line, subscribed to `empire`, `workers`, `queue` and `connection`. Add a `Management` row and a `Briefing` row to `openHelp`. |
| `src/client/ui/empire.ts` | Remove the "Chief of staff on duty" text from the radar stats. Use `managerStatus()` in sector cards. Rewrite the chief brief copy to describe rule-based monitoring. Replace the "LIVE SERVER STATE" eyebrow with a freshness label ("Updated 3 s ago" / "Disconnected"). Split Management into a `role="tablist"` with Overview / Sectors / Accounts / Reports tabs. Keep the dialog name "Empire operations", the close label "Close operations" and the button name "Management", which the smoke test uses. |
| `src/client/ui/briefing.ts` (new) | A non-modal briefing drawer: an `aside` on the right, 340 px wide on desktop, and a bottom sheet capped at 45 vh on ≤700 px. It contains attention items (chief and manager rows 4, 6, 10 and 12, plus workers with `needs_input`) and the latest reports in time order. The unread count uses a local `lastSeen` in `localStorage`. It does not use `openModal`, so the world keeps rendering and moving. Esc closes it and returns focus to the canvas. |
| `src/client/ui/dom.ts` | Update `openModal`: set `aria-modal="true"`, focus the first focusable element if focus is not already inside, trap Tab, and restore focus to the previous `activeElement` on close unless it is `#scene`, which `backToGame` already handles. Callers that focus their own target (terminal/xterm, prompt textarea) keep their focus because they run after `openModal`. |
| `src/client/controls.ts` | Add `manage: 'KeyJ'` and `briefing: 'KeyL'` with labels. **Extend the `map`/`camera` migration branch to all newly added actions** so existing saved remaps survive. Choose fallbacks in the same way, avoiding occupied keys. |
| `src/client/main.ts` | Handle `KeyJ` → `empireUI.openOperations()` and `KeyL` → toggle the briefing drawer in the keydown switch ([src/client/main.ts](../../../src/client/main.ts#L802)). Wire `net.onStatus` to the store. Mount the briefing drawer. When the door traversal auto-delegates, show a one-time toast: "Oversight delegated to chief of staff — reports only; approvals stay with you." The auto-delegation itself stays unless the coordinator decides otherwise (see §5). |
| `src/client/style.css` | Consolidate design tokens in one block: HUD surface, modal surface, text, muted, and tone colours for idle, active, attention and unknown. Make Management, Headquarters and Settings modals use the same dark translucent surface as map and founding. Set radar stats to at least 11 px at full opacity. Add a status-strip layout that stays visible at ≤800 px. Move the touch pad to bottom-left, above the radar, or move chat, so they cannot overlap. Add `@media (prefers-reduced-motion: reduce)` to disable pulse, pop and toast animations. Add a visible `:focus-visible` ring on `.btn`. |
| `tests/status.test.ts` (new) | Unit tests covering every row of the §2 table and the workforce summary. |
| `tests/navigation.test.ts` | Add a case: a saved full key map without `manage`/`briefing` keeps every existing remap. |
| `tests/browser-smoke.mjs` | Read URL and password from `EMPIRE_URL` / `EMPIRE_PASSWORD`, defaulting to the current values. Add the §4 assertions. The coordinator must approve this change first, because Review may also use this file. |

**Deferred to slice 2:**
- Topbar overflow ("Tools" disclosure for Issues, PRs, Services, Queue, Invite, Upgrade and Decor at ≤800 px).
- The in-world chief avatar reflecting status tone.
- Report filtering, which needs the backend fields in §5.

---

## 4. Acceptance checks

### Automated

1. `npm run typecheck`, `npm test` and `npm run build` pass on the candidate. The baseline was 48 tests.
2. `tests/status.test.ts`: every row in §2 maps to the expected tone and label. The words "on duty", "working" and "active" appear only for rows 8–10. `delegated: true` combined with an `offline` manager yields "Offline".
3. Key migration: a saved map from the current version (without `manage`/`briefing`) keeps its custom bindings, and the new actions get non-conflicting keys.

### Browser scenarios

These run against an **isolated fixture server, not port 4610**. Proposed fixture:
- a scratch git repo under `/tmp`;
- `npm run build && node bin/agent-office.js /tmp/empire-ui-fixture --host 127.0.0.1 --port 4620 --password empire-ui-fixture --agent <harmless stub>`;
- `EMPIRE_URL=http://127.0.0.1:4620 npm run test:browser`.

States that need real agent hooks (`working`, `needs_input`, `ready`) are rendered by injecting a crafted `empire` message through `window.__office.store.apply(...)`. This is client-side only. The next 5 s broadcast overwrites it, so each assertion runs right after injection.

| ID | Scenario | Pass condition |
|---|---|---|
| B1 | Chief offline while `delegated` is true | Status strip reads "Chief of staff · Offline" with a Retry control. The DOM contains no "on duty" (`document.body.innerText`). Radar stats contain only the map and view hints. |
| B2 | Queue paused (limit 0 in the Queue window before founding) | Chief shows "Startup queued · queue paused". Clicking it opens Queue. |
| B3 | Injected `needs_input` with a matching worker | Attention tone. `aria-live` region text updates once. "Open terminal" opens the terminal for that `workerId`. |
| B4 | Injected `ready` | "Idle · startup brief complete", "no active job", and a relative finish time. |
| B5 | Stop the fixture server | Within 2 s, `#conn` is visible, the chip shows "Status unknown" and Management shows "Disconnected". After restart the status recovers without a reload. |
| B6 | Briefing drawer (`L` and button) | Drawer opens. `modalOpen()` is false. Holding ArrowUp with focus on the canvas changes `#scene[data-position]`. The drawer covers at most 360 px on a 1440 px viewport. Esc closes it and focus returns to `#scene`. |
| B7 | Management (`J` and button) | Dialog "Empire operations" opens. Tabs work with arrow keys. Build, hire, upgrade, buy land, retry, assign task, reinvest and delegate are all still reachable. "Close operations" closes it and focus returns to the opener. |
| B8 | Modal focus (Settings, Help, Map, Headquarters, Queue, terminal) | Focus moves inside on open and Tab stays inside. Esc closes and focus is restored. The terminal still receives typed input. |
| B9 | Viewports 390×844 (touch), 768×1024 (touch) and 1440×1000 | `scrollWidth <= innerWidth`. Status strip is visible. Bounding boxes of topbar, radar, touch pad, chat, hint and status strip do not intersect. Every topbar button has a non-emoji accessible name. |
| B10 | Reduced motion (`page.emulateMedia({ reducedMotion: 'reduce' })`) | Computed `animation-name` is `none` on `.pill.needs_input` and `.toast`. |
| B11 | Regression: existing smoke flow | Door exit and entry, waypoint without teleport, car entry, driving and exit, `N` view switch, remap persistence across reload. No `Office ↔ City` or `Go home` button. The Graphics preset selection persists across reload. |
| B12 | Truthfulness spot check | Every number in the chip equals a value derived from `window.__office.store.workers` and `store.queue`. No displayed count comes from a literal. |

### Manual

- Check HUD text contrast (radar, status strip, drawer) with Chrome DevTools against WCAG AA 4.5:1.
- Take screenshots in first and third person with the drawer open, to confirm the centre of the world stays visible.

---

## 5. Dependencies, decisions and limits

### Backend requests (not needed for slice 1)

These are optional, backward-compatible additions to `src/shared/empire.ts`. They must be agreed first, per WORKFLOW.md §Integration 2:

1. `EmpireReport` gains `kind?: 'attention' | 'status' | 'treasury' | 'task' | 'system'`, `site?: SiteId`, `taskId?: string`, `workerId?: string` and `source?: 'simulation' | 'execution'`. These enable filtering and clickable reports, and clearly separate simulated reports from observed execution. Without them the drawer lists reports in time order with no links.
2. If a real supervisor is introduced, add a `chief` block: `{ mode: 'rule-based' | 'supervising', lastEvaluatedAt, activeTaskId? }`. Until then the UI states "rule-based monitoring".
3. Optionally, a verified brief artifact path on `SectorManager`, so "startup brief complete" can link to the file.

### Coordinator or backend decisions

- **Should `managerAvailable()` treat `ready` as available** for entrances and hourly revenue? This is economy semantics owned by backend. The interface will label it "Idle" either way.
- **Should walking out of HQ keep auto-delegating?** I propose keeping it, with a one-time toast.
- **May `tests/browser-smoke.mjs` be parameterised by environment variable?** It is shared with Review.

### Known limits

- Slice 1 cannot show live chief reasoning, because none exists.
- States that depend on hooks can only be browser-tested by client-side injection unless a real agent runs. Real agents are out of scope for this team session.
- The fixture's `--agent` stub command format has not been verified.

### Blockers

None for writing this report. Implementation waits for coordinator approval of this plan and of the smoke-test parameterisation.
