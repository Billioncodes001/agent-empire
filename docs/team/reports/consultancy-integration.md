# Consultancy integration evidence

Candidate `6517da6` combines native backend `7af1506` with the founder desk, authenticated HTTP routes, Telegram adapter and persistence repairs. The development branch is updated only after independent review.

Final validation: **198/198 tests passed**, client/server typecheck passed, client Vite build and server TypeScript build succeeded in temporary output directories. This includes the real queue storage-failure regression added after candidate6517da6; product code is unchanged.

## Verified behavior

- Multiple synthetic client jobs retain separate approvals and work items. Approved plans are immutable; stable request and queue identities prevent duplicate dispatch on repeated approval/restart.
- A real isolated server with a fake PTY starts a worker without a WebSocket/game client. A second client stays pending. Interrupted work returns as needs attention after restart.
- Real queue persistence failure reports storage trouble, starts no worker, does not bind the in-memory row as durable evidence, and fails closed on restart. Maximum-size plans reload; modified saved plans/identities fail closed. Observer errors cannot roll back persisted approvals.
- Telegram has 12 fake-transport checks including private-owner authorization, cursor replay, stale approvals, storage errors, token redaction, and late poll/send completion after shutdown. No real Telegram connection or message was sent. Worker child environments omit Telegram host credentials.
- Founder desk tested at isolated localhost:4622: sign-in, new brief, review, save, explicit approve, decline, retained independent client, Escape/keyboard focus, city navigation and browser Back. No console errors. At 375 CSS pixels, document width is 375 with no horizontal overflow. Reduced-motion rules and Save-Data polling are present; no 3D dependency loads on this page.
- Screenshots are local ignored artifacts `artifacts/founder-desk-desktop.png` and `artifacts/founder-desk-mobile.png`. In-app browser phone screenshot has a capture-scale/blank-area defect; DOM width and rendered mobile content were inspected separately. Desktop capture renders normally.
- Client production build goes to `/tmp/agent-empire-consultancy-preview`, preserving the live `dist`. Main live port4610, Pixel and its save were not used or changed.

## Independent review

Native GPT-5.3-Codex authored the domain implementation; Grok4.7 reviewed exact7af1506 and identified queue-health plumbing, observer rollback and missing-ID fallback defects. Root repaired those in the integration candidate and added large-plan/fingerprint/identity validation. A duplicate native repair was stopped before applying its proposed edit.

A separate read-only review of the parent integration found Telegram shutdown, browser Back polling and non-localhost HTTP UUID issues. All were fixed; that reviewer approved exact6517da6 and independently passed32 targeted tests. Native Grok's final recheck is recorded separately in `consultancy-backend.md`.

## Remaining product work

This is a deterministic coordination foundation, not an autonomous model-backed chief. One execution host/repository serves all client labels; labels are not tenant isolation. The host must remain running. Packaged desktop quit and laptop shutdown stop local coordination. Existing provider-managed cloud tasks are not yet consultancy jobs. Model planning, independent client repositories, approved resource expansion, founder phone, worker lifestyles and reviewed memory are planned. Platform installers were not rebuilt or device-tested in this slice.

## Final resolution and integration

Grok rechecked exact6517da6 and accepted the three domain repairs and restore validation. It identified one remaining Medium in the capacity report, which could count an undurable queued row. Commit `033e5f8` fixes that: failed queue storage produces `queued: null`, a storage blocker and “queue count unavailable” in chief text. The real queue failure test asserts these API fields. A separate independent reviewer accepted exact033e5f81fb251c930db6cce7f9466c85725e638a and passed4/4 targeted server tests; typecheck also passed. Product code after6517da6 changes only this reviewed reporting repair and the matching client type. Main `codex/empire-world` was fast-forwarded after acceptance. No remaining actionable review findings for this slice. Native review history remains in `consultancy-backend.md`.

The full198-test run preceded the reporting-only repair; the4 affected server tests were rerun after it. A preserved Git stash holds root's intermediate source edits as a recovery copy. It is not pending work to apply over the integrated implementation.
