/**
 * Where the app talks to GitHub's REST API: always https://api.github.com, except in a fixture build.
 *
 * A fixture build is made only with `vite build --mode fixture` (npm run build:client:fixture), which writes to
 * dist/public-fixture, never to dist/public that desktop and mobile package. vite.config.ts then defines
 * `__AGENT_EMPIRE_FIXTURE__` with the loopback fake from VITE_AGENT_EMPIRE_FAKE_GITHUB_API and a marker string; in every
 * other build it is `undefined`, so neither the override nor the marker exists in shipped JavaScript. Packaging
 * (tools/check-no-fixture.mjs, tools/sync-ios-game.sh, mobile/tools/build-android.py) refuses any bundle with the marker.
 * Only a plain http://127.0.0.1 or http://localhost origin is accepted, so the GitHub token can never go elsewhere.
 */
export const GITHUB_API = 'https://api.github.com';
const FAKE = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/;

declare const __AGENT_EMPIRE_FIXTURE__: { marker: string; api: string } | undefined;

export function githubApiBase(): string {
  // `typeof` keeps this safe where the constant is not defined at all (Node tests run this file unbundled).
  const fixture = typeof __AGENT_EMPIRE_FIXTURE__ === 'object' && __AGENT_EMPIRE_FIXTURE__ ? __AGENT_EMPIRE_FIXTURE__ : null;
  return fixture && FAKE.test(fixture.api) ? fixture.api : GITHUB_API;
}
