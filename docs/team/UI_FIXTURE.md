# Isolated interface verification

Run `npm run build:client`, then `npx tsx tools/ui-fixture.ts` from a dedicated checkout. The simulation is at <http://localhost:4613/> and scenario controls at <http://localhost:4613/__fixture>. `FIXTURE_PORT` can select another unused local port; port 4610 is explicitly refused.

The fixture serves the production client with synthetic WebSocket messages. It never imports the real server, reads `.agent-office`, starts workers, executes terminal commands, or writes city data. Its terminal only echoes keystrokes. Economy buttons display a fixture notification rather than perform purchases. Use a disposable founder profile on this separate origin.

Use the controls page to choose `working`, `idle`, `needs_input`, `turn_ended`, `interrupted`, `unknown`, `missing`, `stale`, or `disconnected`. Each selection first publishes that scenario; `stale` then stops publications, and `disconnected` closes/refuses sockets. Pick a normal scenario to restore publications/connections. Keep Management open while changing scenarios to verify in-dialog freshness. A turn ending must not be presented as verified work or process exit.

Manual browser checks use CUA against this fixture, without runtime store injection. Check HUD/Management consistency, keyboard focus and nested dialogs, terminal Tab input, small-screen worker access, map, camera and settings controls. Fixture observations validate presentation and input behavior; server regression tests validate actual recovery and economy rules. This fixture is not a playable saved city or a cloud backend.

Do not use the legacy `tests/browser-smoke.mjs` for this workflow: it targets the live preview and mutates runtime state. Do not restart or alter the real office merely to refresh this test page.
