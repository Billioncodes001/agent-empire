# Round 1 integration verification

Verified on 2026-09-27. Runtime candidate: `0d20434de297ab0716411be124b58047e8555309`. Follow-up `8c93105` only clarifies that task rewards are once-per-task in Management and Founding; its production build also passes. `f6d3b9a` removes the final review finding by giving the decorative chief a fixed post independent of delegation; the full 86-test suite, typecheck and production build passed again afterward.

Claude Opus 5.5 implemented the client in VS Code Copilot (`28be374`, `7f45fe6`). Codex implemented server recovery and tests (`5868693`, `7f708b0`, contract `8eed09e`). Grok 4.7 independently reviewed the backend in VS Code Copilot and identified the dual manager-retry / task-requeue bypass. Codex reproduced it with fake workers and fixed both action orders while retaining one logical task/reward identity. See the separate reviewer report for its final candidate assessment.

Coordinator verification passed TypeScript checking, all **86 tests**, the production client/server build, and whitespace checks. The new runtime tests use temporary save directories, fake PTYs, and an authenticated WebSocket server on an ephemeral loopback port with external polling disabled. The reconnect freshness regression was observed failing before the receipt-time reset and passing afterward.

## Browser verification

CUA operated the unchanged production client through `tools/ui-fixture.ts` on port 4613. No browser-runtime store injection or terminal browser automation was used. This fixture emits synthetic wire messages and never executes commands or reads the real city.

- Working, idle, needs-input, turn-ended, interrupted, unknown and missing-evidence scenarios show the expected chief labels in the HUD and open Management dialog. Blocked workers are attention rather than active work.
- Stopping updates for more than 15 seconds or disconnecting removes live chief/count claims while dialogs remain open. Reconnection restores them on new evidence. Sidebar and Workers-dialog statuses explicitly become last-known; keyboard focus stays on the same worker button across that transition.
- Management opens on Overview, arrow keys change tabs, Tab/Shift+Tab wrap within the dialog, and Escape restores a keyboard opener. A nested terminal receives typing and Tab; Escape closes the terminal while leaving Management open. Settings opens character editing with the name field focused.
- Low graphics, first-person view and a remapped movement key persisted across reload. The fixture was restored to Medium, third-person and arrow-key defaults afterward.
- Selecting a map waypoint left the character position unchanged. Map access and location management remain available without teleporting.
- At 390×844, worker access remains available when the sidebar is hidden, and Management has no horizontal page overflow. Queue and Services retain meaningful accessible names when their visible text is hidden. The Accounts panel also fits at 768×1024. Temporary viewport overrides were reset.
- The final preview loaded its character/car/environment assets and produced no captured browser warnings or errors. Local screenshots are saved as `artifacts/round-1-management.png` and `artifacts/round-1-mobile.png` in the main checkout; artifacts are ignored by Git.

## Limits

No real provider task, permission decision, voice call, screen share, touch-hardware gesture, cloud deployment, or live-save migration was exercised. Reduced-motion behavior was inspected in CSS rather than through OS preference automation. Physical door/car/elevator behavior retains its automated regression coverage; this pass did not repeat the full live traversal walkthrough. The legacy `tests/browser-smoke.mjs` was deliberately not run because it targets the live preview and injects runtime state.

The existing port-4610 server and Pixel worker were preserved. Port 4613 is a synthetic review preview, not the user's saved city. Legacy workers lacking process evidence still require reviewed manual diagnosis; see [RECOVERY.md](../RECOVERY.md). Always-on cloud execution, synchronization and native packaging remain later milestones.
