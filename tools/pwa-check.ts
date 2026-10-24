/**
 * FREE-03 PWA acceptance: the built web game served by the real office server over HTTPS, in Chrome.
 *   npm run build && npx tsx tools/pwa-check.ts
 * Starts its own office (dist/server, --self-signed, a throwaway project directory, a no-op agent command, a random
 * password) on 127.0.0.1:PWA_PORT (default 4791), so it never touches a real office, worker or save. No paid calls.
 * Asserts: the manifest is valid and installable (Chrome's own installability check), the service worker registers
 * and controls the page, /api requests always bypass the worker and never enter CacheStorage, only fingerprinted
 * /assets/ files are cached, and a failed page load shows the offline page. Screenshots go to docs/team/reports/free-03/.
 */
import { chromium, type Response as PwResponse } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(import.meta.dirname, '..');
const port = Number(process.env.PWA_PORT || 4791);
if (port === 4610) throw new Error('Refusing the protected 4610 session.');
const origin = `https://127.0.0.1:${port}`;
const out = resolve(ROOT, 'docs/team/reports/free-03');
mkdirSync(out, { recursive: true });
if (!existsSync(resolve(ROOT, 'dist/server/server/cli.js')) || !existsSync(resolve(ROOT, 'dist/public/sw.js'))) throw new Error('Run `npm run build` first.');

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const project = mkdtempSync(resolve(tmpdir(), 'empire-pwa-check-'));
const password = randomBytes(12).toString('hex');
const server = spawn(process.execPath, [resolve(ROOT, 'dist/server/server/cli.js'), project, '--port', String(port), '--host', '127.0.0.1', '--self-signed', '--agent', '/usr/bin/true'], {
  env: { ...process.env, AGENT_OFFICE_PASSWORD: password, AGENT_OFFICE_CLAIM_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const profile = mkdtempSync(resolve(tmpdir(), 'empire-pwa-profile-'));
const stop = async () => {
  if (server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
  }
  for (const dir of [project, profile]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the throwaway self-signed certificate, for the readiness probe only
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${origin}/api/health`)).ok) break;
  } catch {}
  if (i > 100 || server.exitCode !== null) { await stop(); throw new Error(`office did not start:\n${serverLog}`); }
  await new Promise((r) => setTimeout(r, 150));
}

// A persistent (non-incognito) profile: Chrome never treats an incognito page as installable.
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 },
  args: ['--ignore-certificate-errors', '--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = context.pages()[0] ?? (await context.newPage());
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  const responses: PwResponse[] = [];
  page.on('response', (r) => responses.push(r));

  // Manifest, as served by the office before sign-in.
  const manifestRes = await page.request.get(`${origin}/manifest.webmanifest`);
  const manifest = await manifestRes.json();
  check('manifest is served as application/manifest+json', /manifest\+json/.test(manifestRes.headers()['content-type'] || ''));
  check('manifest: standalone display, root start_url and scope', manifest.display === 'standalone' && manifest.start_url === '/' && manifest.scope === '/');
  const sizes = (manifest.icons || []).map((i: { sizes: string; purpose?: string }) => `${i.sizes}:${i.purpose || 'any'}`);
  check('manifest: 192, 512 and maskable icons', ['192x192:any', '512x512:any', '512x512:maskable'].every((s) => sizes.includes(s)), sizes.join(' '));
  for (const icon of manifest.icons) check(`icon ${icon.src} is public`, (await page.request.get(origin + icon.src)).status() === 200);

  await page.goto(`${origin}/login`);
  await page.fill('#password', password);
  await Promise.all([page.waitForURL(`${origin}/`), page.click('#submit')]);
  check('manifest linked from the game page', (await page.locator('link[rel="manifest"]').getAttribute('href')) === '/manifest.webmanifest');

  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  check('service worker registered with scope /', scope === `${origin}/`, scope);
  await page.reload({ waitUntil: 'load' });
  check('service worker controls the page after reload', await page.evaluate(() => !!navigator.serviceWorker.controller));

  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: { errorId: string }[] };
  check('Chrome reports the app as installable', installabilityErrors.length === 0, installabilityErrors.map((e) => e.errorId).join(', ') || 'no errors');

  // API calls made by the page while the worker controls it.
  responses.length = 0;
  const api = await page.evaluate(async () => {
    const r = await fetch('/api/whoami', { credentials: 'same-origin' });
    return { status: r.status };
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const apiResponses = responses.filter((r) => new URL(r.url()).pathname.startsWith('/api/'));
  check('/api/whoami answered by the server', api.status === 200, String(api.status));
  check('every /api response bypassed the service worker', apiResponses.length > 0 && apiResponses.every((r) => !r.fromServiceWorker()), `${apiResponses.length} api responses`);
  const fromSw = responses.filter((r) => r.fromServiceWorker()).map((r) => new URL(r.url()).pathname);
  check('reload serves fingerprinted build files from the worker', fromSw.some((p) => /^\/assets\/[\w.-]+-[\w-]{8}\.js$/.test(p)), fromSw.slice(0, 4).join(' '));
  // The worker also answers the page navigation itself (network-first, passed through); nothing else outside /assets/.
  check('outside /assets/ the worker only passes the page navigation through', fromSw.every((p) => p.startsWith('/assets/') || p === '/'), fromSw.filter((p) => !p.startsWith('/assets/')).join(' '));

  const cached = await page.evaluate(async () => {
    const all: Record<string, string[]> = {};
    for (const name of await caches.keys()) all[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
    return all;
  });
  const paths = Object.values(cached).flat();
  check('CacheStorage holds no /api, page, model, texture or audio response', paths.length > 0 && !paths.some((p) => /^\/(api|models|textures|audio)\//.test(p) || p === '/' || p.endsWith('.html') && p !== '/assets/pwa/offline-v1.html'), `${paths.length} entries in ${Object.keys(cached).join(', ')}`);
  check('static cache holds only fingerprinted /assets/ files', (cached['agent-empire-static-v1'] || []).every((p) => /^\/assets\/[\w.-]+-[\w-]{8}\.\w+$/.test(p)));
  await page.screenshot({ path: resolve(out, 'pwa-01-game-controlled-1280x800.jpg'), quality: 70 });

  // Offline: the page fails, the worker shows the explanation page.
  await context.setOffline(true);
  await page.goto(`${origin}/`).catch(() => {});
  const offlineText = await page.locator('body').innerText().catch(() => '');
  check('offline page load shows the offline explanation', /offline|can.t reach|cannot reach|not reachable/i.test(offlineText), offlineText.slice(0, 80).replace(/\s+/g, ' '));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: resolve(out, 'pwa-02-offline-page-375x812.jpg'), quality: 70 });
  await context.setOffline(false);

  // Back online at phone width: the game loads again under the worker.
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  check('back online, the game page loads under the worker', await page.evaluate(() => !!navigator.serviceWorker.controller && !!document.querySelector('canvas, #app, main')));
  await page.screenshot({ path: resolve(out, 'pwa-03-game-online-375x812.jpg'), quality: 70 });

  const swErrors = consoleErrors.filter((e) => /service ?worker|sw\.js|manifest/i.test(e));
  check('no service-worker or manifest console errors', swErrors.length === 0, swErrors.join(' | '));
} finally {
  await context.close();
  await stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PWA checks passed`);
process.exit(failed.length ? 1 : 0);
