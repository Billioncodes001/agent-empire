/**
 * Where the app talks to GitHub's REST API: always https://api.github.com, except in a fixture build made with
 * VITE_AGENT_EMPIRE_FAKE_GITHUB_API pointing at a loopback fake (simulator checks; never a real deployment). The value
 * is fixed at build time and only a plain http://127.0.0.1 or http://localhost origin is accepted, so a page or a
 * stored setting can never send the GitHub token anywhere else.
 */
export const GITHUB_API = 'https://api.github.com';
const FAKE = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/;

export function githubApiBase(): string {
  const fake = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_AGENT_EMPIRE_FAKE_GITHUB_API?.trim();
  return fake && FAKE.test(fake) ? fake : GITHUB_API;
}
