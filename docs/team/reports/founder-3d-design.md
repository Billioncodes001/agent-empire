# Founder desk 3D design acceptance

2026-09-27. Scope: redesign the consultancy web interface while preserving client-job and approval semantics. Protected localhost:4610, Pixel, the live save and main dist were not used for testing.

## Design

Editable Figma: https://www.figma.com/design/ewvSQ9OFZGye6IhxtVpTvB?node-id=3-137 . Desktop 3:137, phone 3:339, interaction board 4:20 and brief/review overlays. Prototype reactions were inspected structurally; the live Three.js scene is implemented in code, not inside Figma. Adobe XD was not available in the app inventory and was not used.

Original procedural glass/bronze headquarters, surrounding architecture, plaza, facade details, reflection environment and shadows. Original inline SVG fallback. No downloaded/copy-pasted site assets. Ink/ivory/copper interface, editorial type, hover/focus feedback, metric update accents, scroll reveals and dialog entrances. Motion research drew on motionsites.ai and Build in Amsterdam.

The hero is explicitly an architectural illustration. Actual job, worker, capacity and chief reporting remain API-driven. It does not claim the illustrated building is the live simulation or turn decorative lights into worker status.

## Rendering and access

Lazy renderer loaded after first paint and visibility; 30 fps, capped DPR, instancing, static shadow updates. Pause/resume, three camera angles, pointer parallax, reduced-motion initial pause, Save-Data opt-in, hidden/offscreen suspension, bfcache cleanup/remount and WebGL-failure SVG fallback. The operational entry point is independent of the renderer.

## Verification

- Isolated preview: http://127.0.0.1:4622/consultancy.html, fake workers, concurrency zero, no Telegram/background services or paid product calls.
- Desktop and 375 × 812 mobile visually inspected; no horizontal overflow. Screenshots under ignored artifacts/founder-3d-*.png.
- New Cedar Works fixture brief → review → save → approval → queued. Dialog focus and Escape verified. Mobile brief dialog also inspected.
- Camera pause/resume, alternate views and paused resize inspected. Independent review found and resolved paused one-shot render throttling and stale camera selection after remount.
- Save-Data fixture starts with SVG and explicit Load 3D control; opt-in loads the renderer. Reduced-motion JavaScript fixture starts paused. CSS media rules inspected; OS preference was not changed.
- Forced WebGL failure keeps job form usable; normal preview console has no errors. Failure fixture has the expected Three.js constructor error.
- Figma desktop, phone, interaction board and overlays visually inspected. Native Claude Opus 5.5 authored the interface through the existing VS Code coordinator; Codex authored the Three.js scene and integration.

These checks concern the founder desk only. They do not establish cloud deployment, mobile/desktop package execution, autonomous chief staffing, or completion of the broader city roadmap.
