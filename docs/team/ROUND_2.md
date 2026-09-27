# Round 2: continuity and device delivery

Baseline: a7c53d6. Keep the user's live 4610 server, worker and save untouched. Reuse role worktrees; no paid jobs, cloud purchases or live migration for testing.

The first runnable cloud boundary is a single-owner, continuously running host. Closing any client does not stop server jobs; stopping the host still interrupts processes and requires explicit recovery. No multi-tenant/distributed lease or guaranteed exactly-once side-effect claim.

- Backend/Codex: durable host identity/revisions and authenticated continuity snapshot/history; immutable committed Git artifacts with hashes, auth and tests. Own server/shared except device-sync files.
- Interface/Claude in VS Code: mobile/desktop-installable PWA, public offline explanation with no authenticated caching, connection and installation UI. Use agreed optional continuity contract. No package/shared/server edits.
- Coordinator: local artifact importer and CLI, desktop shell, deployment recipe, integration and browser/native checks. Import only into isolated worktrees; never overwrite or auto-merge dirty laptop files. Pin host identity, verify hashes and preserve explicit conflicts.
- Grok in VS Code: review exact integrated changes and concrete trust/data-loss boundaries; findings resolved before merge.

Deliverable must distinguish tested local functionality, prepared deployment, and actual hosted service. Mobile delivery is an installable web app first; App Store/Play Store signing is a separate milestone. Desktop packaging must have no Node access in remote content. Provider credentials remain server-side. Test with temporary repositories, fake workers and loopback endpoints.
