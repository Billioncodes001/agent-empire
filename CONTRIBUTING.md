# Contributing to Agent Empire

Thanks for helping. Agent Empire is MIT-licensed (see `LICENSE`); by contributing you agree your contribution is released under the same licence. Please follow the [code of conduct](CODE_OF_CONDUCT.md). Report security problems privately ([SECURITY.md](SECURITY.md)).

## Development setup

Requirements: Node.js 20 or newer (CI uses 24) and git. Desktop packaging also needs the desktop dependencies; mobile builds need Xcode or the Android SDK (see `docs/PLATFORMS.md`).

```sh
npm ci --ignore-scripts          # install without running the build in `prepare`
npm run dev                      # Vite + an office server on port 4600, password "dev"
```

Use only your own development office (`npm run dev`), or the isolated UI fixture:

```sh
npm run build:client
FIXTURE_PORT=4701 npx tsx tools/ui-fixture.ts
```

## The protected-session rule

Never point tests, scripts or agents at someone's **real** office. In particular, in the maintainer's environment the session on `localhost:4610`, its Pixel worker and the `.agent-office` save directory are protected and must not be touched by development work. Use the UI fixture, a temporary data directory, or your own dev server. The browser checks refuse port 4610.

## Checks before a pull request

```sh
npm run typecheck
npm test
npm run build
FIXTURE_URL=http://localhost:4701/ npx tsx tools/mobile-ui-check.ts   # with the UI fixture running
npm run build:client && npx tsx tools/pwa-check.ts                   # service worker and manifest
```

UI changes should be checked at desktop size and at 375 px phone width, with keyboard focus, `prefers-reduced-motion` and Save-Data in mind (`docs/team/DESIGN_STANDARD.md`).

## Rules for tests

- **No paid calls.** Tests and checks must never call a paid model provider, a real GitHub account, an app store or any cloud service. Use the fakes under `tools/` and `tests/` (for example `tools/fake-github-server.mts`).
- **No real credentials.** Use obviously fake values (`sk-ant-FAKE-fixture-only-…`, `*.example` addresses). Never commit `.env` files, keystores, certificates or private keys.
- **No fabricated results.** The city shows real agent work. Keep animation, rule-based monitoring, observed worker activity and verified outcomes distinct; never mark something done that was not verified.
- No automatic model downloads in tests.

## Pull requests

- Keep each pull request to one concern and describe how you tested it (commands and results; screenshots for UI).
- Do not change release keys, `release.yml` signing steps or pinned action SHAs without saying why. Actions are pinned to full commit SHAs.
- Fork pull requests run without repository secrets. That is intended.
