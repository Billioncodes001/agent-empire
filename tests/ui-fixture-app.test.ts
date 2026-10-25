/**
 * Device testing (v1.0.0-beta.1): the bundled apps (Android, iOS) sign in to the isolated UI fixture with a bearer
 * token from an app origin. The real server treats a bearer request as trusted (it can't be a browser forgery), so
 * onboarding writes work in the apps; the fixture must behave the same or app walks show "A same-origin Origin header
 * is required" instead of onboarding. Runs the fixture on an isolated port (never 4610); no real server, no workers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 5058;
const BASE = `http://127.0.0.1:${PORT}`;
const ANDROID = 'https://appassets.androidplatform.net';

async function waitUp(): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('fixture did not start');
}

test('app-origin bearer requests can write onboarding in the UI fixture, as on the real server', async (t) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tools/ui-fixture.ts'], {
    cwd: ROOT, env: { ...process.env, FIXTURE_PORT: String(PORT), FIXTURE_ONBOARDING: 'new' }, stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitUp();

  const login = await fetch(`${BASE}/api/device/login`, {
    method: 'POST', headers: { origin: ANDROID, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'fixture-pass', deviceName: 'Android' }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json() as { token: string };

  const progress = (headers: Record<string, string>) => fetch(`${BASE}/api/onboarding/progress`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ current: 'profile' }),
  });
  const app = await progress({ origin: ANDROID, authorization: `Bearer ${token}` });
  assert.notEqual(app.status, 403, 'a signed-in app device is trusted like a bearer request on the real server');
  assert.equal(app.headers.get('access-control-allow-origin'), ANDROID);

  // A foreign page without a bearer is still refused.
  const forged = await progress({ origin: 'https://evil.example' });
  assert.equal(forged.status, 403);
  // An unknown bearer is signed out, not trusted.
  const stale = await progress({ origin: ANDROID, authorization: 'Bearer notarealtokennotarealtoken' });
  assert.equal(stale.status, 401);
});
