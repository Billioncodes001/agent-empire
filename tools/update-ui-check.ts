/**
 * In-app update UI acceptance (REL-03/05) against the isolated UI fixture and the local update fixture
 * (tools/update-fixture.ts, dev-signed). Never the protected 4610 session, never real GitHub, no paid calls.
 *
 *   npm run build:client && FIXTURE_PORT=4718 FIXTURE_PASSWORD=fixture-office npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://127.0.0.1:4718/ npx tsx tools/update-ui-check.ts        (screenshots: docs/team/reports/in-app-updates/)
 *
 * The page runs as the Android app: an emulated window.empireAndroid answers secure.* in memory and update.* in Node,
 * as a development (debug-variant) shell would, including nativeInfo.devReleaseKey: the production page in dist/public
 * trusts only the owner's key on its own, and the dev-signed fixture verifies only through that development key (REL-07).
 * where downloads go through desktop/update-store.cjs to the update fixture (real redirects, real sha256 checks).
 * The real shells are exercised on devices (docs/team/reports/in-app-updates.md).
 */
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startUpdateFixture } from './update-fixture';
import { FakeGitHub } from '../tests/fake-github';
import { seed, TOKEN } from './cloud-seed';
import { COORDINATOR_BUNDLE_PATH } from '../src/cloud/workflow';
import { DEV_RELEASE_PUBLIC_KEY } from './release/dev-key.mjs';

const require = createRequire(import.meta.url);
const updates = require('../desktop/update-store.cjs');
const base = process.env.FIXTURE_URL || 'http://127.0.0.1:4718/';
if (/:4610\b/.test(base)) throw new Error('never 4610');
const origin = new URL(base).origin;
const out = resolve(import.meta.dirname, '../docs/team/reports/in-app-updates');
mkdirSync(out, { recursive: true });
const failures: string[] = [];
const ok = (cond: unknown, name: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures.push(name);
};
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(out, `${name}.jpg`), type: 'jpeg', quality: 80, animations: 'disabled' });

/** Node side of the emulated shell: update.* behaves like the real shells (minus the files). */
function shell(fixture: ReturnType<typeof updates.fixtureMapper>, opts: { platform: 'android' | 'ios'; installedGame: string }) {
  const state = { installedGame: opts.installedGame, pending: null as string | null, bootOk: 0, installs: [] as string[], fetches: 0, hold: null as Promise<void> | null };
  async function call(method: string, params: Record<string, any>): Promise<unknown> {
    switch (method) {
      case 'update.fetch': {
        await state.hold;
        state.fetches++;
        const r = await updates.download(params.url, { fixture, etag: params.etag, maxBytes: updates.MAX_TEXT_BYTES });
        return { status: r.status, body: r.body.toString('utf8'), etag: r.etag };
      }
      case 'update.installGame': {
        const r = await updates.download(params.url, { fixture });
        if (createHash('sha256').update(r.body).digest('hex') !== params.sha256) throw new Error('The download does not match the signed release (sha256). Nothing was installed.');
        state.installs.push(params.version);
        state.pending = params.version;
        return { version: params.version };
      }
      case 'update.activate':
        if (!state.pending) throw new Error('No update is waiting.');
        state.installedGame = state.pending;
        state.pending = null;
        return true;
      case 'update.bootOk':
        state.bootOk++;
        return true;
      case 'update.nativeInfo':
        return { platform: opts.platform, shellVersion: '0.3.0', installedGame: state.installedGame, builtinGame: '0.1.0', pendingGame: state.pending, canInstallGame: true, canAutoUpdate: false, installSource: opts.platform === 'android' ? 'sideload' : 'testflight', devReleaseKey: DEV_RELEASE_PUBLIC_KEY };
      case 'update.openNative':
        return { action: 'store' };
    }
    throw new Error('Unknown method');
  }
  return { state, call };
}

const BRIDGE = (platform: 'android' | 'ios', config: Record<string, unknown>, secure: Record<string, string>) => `
  window.AGENT_EMPIRE_APP = Object.freeze(${JSON.stringify({ platform, deviceName: 'Fixture device', ...config })});
  const store = ${JSON.stringify(secure)};
  const answer = (m) => {
    const N = () => window.__empireNative;
    const done = (fn, v) => setTimeout(() => N() && N()[fn](m.id, v), 5);
    if (m.method.startsWith('update.')) {
      window.__shellCall(m.method, m.params || {}).then((r) => { done('resolve', r); if (m.method === 'update.activate') setTimeout(() => location.reload(), 60); }, (e) => done('reject', String(e && e.message || e)));
      return;
    }
    switch (m.method) {
      case 'secure.get': return done('resolve', store[m.params.key] ?? null);
      case 'secure.set': store[m.params.key] = m.params.value; return done('resolve', true);
      case 'secure.delete': delete store[m.params.key]; return done('resolve', true);
      default: return done('resolve', true);
    }
  };
  ${platform === 'android' ? `window.empireAndroid = { postMessage(json) { answer(JSON.parse(json)); } };` : `window.webkit = { messageHandlers: { empire: { postMessage(m) { answer(m); } } } };`}
`;

async function deviceLogin() {
  const r = await fetch(new URL('/api/device/login', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: process.env.FIXTURE_PASSWORD || 'fixture-office', deviceName: 'Update check' }) });
  if (!r.ok) throw new Error(`fixture device login failed (${r.status})`);
  return (await r.json()) as { token: string; deviceId: string };
}

async function newContext(browser: import('playwright-core').Browser, size: { w: number; h: number; touch: boolean; reduced?: boolean }) {
  const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch, deviceScaleFactor: 1, reducedMotion: size.reduced ? 'reduce' : 'no-preference', extraHTTPHeaders: size.reduced ? { 'Save-Data': 'on' } : {} });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }));
    localStorage.setItem('agent-empire.execution.offered', '1');
  });
  return context;
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket|ERR_/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function waitBoot(page: Page) {
  await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 180_000 });
  await page.waitForTimeout(600);
}

const toastVisible = (page: Page) => page.locator('#toasts .update-toast').count();
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const inViewport = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    return !!r && r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
  }, selector);

async function serverMode(browser: import('playwright-core').Browser, fixture: any, size: { tag: string; w: number; h: number; touch: boolean; reduced?: boolean }) {
  const session = await deviceLogin();
  const context = await newContext(browser, size);
  const sh = shell(fixture, { platform: 'android', installedGame: '0.1.0' });
  let release!: () => void;
  sh.state.hold = new Promise<void>((r) => (release = r));
  await context.exposeFunction('__shellCall', (m: string, p: Record<string, unknown>) => sh.call(m, p));
  await context.addInitScript({ content: BRIDGE('android', { mode: 'server', host: origin, token: session.token, deviceId: session.deviceId }, { mode: 'server', 'server.host': origin, 'server.token': session.token }) });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(base);
  await waitBoot(page);
  ok(sh.state.bootOk === 1, `${size.tag} the page reports update.bootOk once it boots`);

  // Gating: a dialog is open when the update arrives → no prompt until it closes; typing → still none.
  await page.evaluate(() => (document.getElementById('btn-settings') as HTMLButtonElement).click());
  await page.waitForSelector('.settings-modal');
  release();
  await page.waitForFunction(() => /Update available|Checking/.test(document.querySelector('.update-settings')?.textContent ?? ''), null, { timeout: 30_000 });
  await page.waitForFunction(() => /Update available/.test(document.querySelector('.update-settings')?.textContent ?? ''), null, { timeout: 30_000 });
  const settingsText = (await page.locator('.update-settings').innerText()).replace(/\s+/g, ' ');
  ok(/Game 0\.1\.0/.test(settingsText) && /Android app 0\.3\.0/.test(settingsText) && /(Stable|Beta) channel/.test(settingsText) /* a pre-release build defaults to Beta */, `${size.tag} Settings shows installed game and app versions and the channel (${settingsText.slice(0, 120)})`);
  ok(await page.locator('.update-settings [role=radio]').count() === 2, `${size.tag} Settings has the Stable / Beta channel choice`);
  await page.locator('.settings-modal .body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await shot(page, `${size.tag}-01-settings-updates`);
  await page.waitForTimeout(2000);
  ok((await toastVisible(page)) === 0, `${size.tag} no update prompt while a dialog is open`);
  await page.evaluate(() => {
    (document.querySelector('.settings-modal .close') as HTMLButtonElement).click();
    // The chat field where the layout shows it; a text field in the HUD otherwise (phones hide chat until opened).
    let field = document.getElementById('chat-input') as HTMLInputElement;
    if (!field.getClientRects().length) {
      field = Object.assign(document.createElement('input'), { id: 'typing-probe', type: 'text' });
      field.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:70';
      document.getElementById('hud')!.append(field);
    }
    field.focus();
  });
  await page.waitForTimeout(2500);
  ok((await toastVisible(page)) === 0, `${size.tag} no update prompt while typing`);
  ok(await page.evaluate(() => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '')), `${size.tag} (a text field had focus during that check)`);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.getElementById('typing-probe')?.remove();
  });
  await page.waitForSelector('#toasts .update-toast', { timeout: 6000 });
  const toastText = await page.locator('#toasts .update-toast').innerText();
  ok(/Update available: Agent Empire 0\.1\.1/.test(toastText), `${size.tag} HUD prompt names the new version (${toastText.replace(/\s+/g, ' ')})`);
  ok(await inViewport(page, '#toasts .update-toast'), `${size.tag} the prompt is fully on screen`);
  ok(await noOverflow(page), `${size.tag} no horizontal overflow with the prompt`);
  await shot(page, `${size.tag}-02-update-toast`);

  // Keyboard: the prompt's buttons are reachable and open the dialog with the release notes.
  await page.locator('#toasts .update-toast .btn.primary').focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.update-modal');
  const dialog = await page.locator('.update-modal').innerText();
  ok(/Agent Empire 0\.1\.1 is available/.test(dialog) && /What’s new in 0\.1\.1/.test(dialog) && /signed over-the-air update/.test(dialog), `${size.tag} the dialog shows the version and release notes`);
  ok(sh.state.installs.length === 0, `${size.tag} nothing is installed before the player accepts`);
  ok(await inViewport(page, '.update-modal'), `${size.tag} the updates dialog fits the screen`);
  await shot(page, `${size.tag}-03-update-dialog`);
  await page.locator('.update-modal .btn.primary', { hasText: 'Update game' }).click();
  await page.waitForSelector('.update-modal .btn.primary:has-text("Restart now")', { timeout: 120_000 });
  ok(sh.state.installs.join() === '0.1.1', `${size.tag} accepting installs exactly the offered version (sha256 checked)`);
  await shot(page, `${size.tag}-04-installed-restart`);
  await page.locator('.update-modal .btn.primary', { hasText: 'Restart now' }).click();
  await page.waitForEvent('load', { timeout: 30_000 });
  await waitBoot(page);
  ok(sh.state.bootOk === 2, `${size.tag} the restarted game reports booting`);
  await page.evaluate(() => (document.getElementById('btn-settings') as HTMLButtonElement).click());
  await page.waitForFunction(() => /Up to date|Not checked|Checking/.test(document.querySelector('.update-settings')?.textContent ?? ''), null, { timeout: 30_000 });
  await page.waitForFunction(() => !/Checking/.test(document.querySelector('.update-settings')?.textContent ?? ''), null, { timeout: 30_000 });
  const after = (await page.locator('.update-settings').innerText()).replace(/\s+/g, ' ');
  ok(/Game 0\.1\.1/.test(after) && /Up to date/.test(after), `${size.tag} after the restart: game 0.1.1, up to date (forward only) (${after.slice(0, 120)})`);
  await page.locator('.settings-modal .body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await shot(page, `${size.tag}-05-after-restart`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  // Menu entry.
  await page.evaluate(() => (document.getElementById('btn-menu') as HTMLButtonElement).click());
  await page.waitForSelector('.game-menu');
  ok((await page.locator('.game-menu .menu-item', { hasText: 'Check for updates' }).count()) === 1, `${size.tag} the menu has “Check for updates”`);
  await shot(page, `${size.tag}-06-menu-entry`);
  ok(errors.length === 0, `${size.tag} no page errors (${errors.slice(0, 3).join(' | ')})`);
  await context.close();
}

async function cloudMode(browser: import('playwright-core').Browser, fixture: any) {
  const { gh } = await seed();
  const full = 'founder/agent-empire-state';
  const before = gh.files(full)[COORDINATOR_BUNDLE_PATH];
  const commits = () => gh.writes.filter((w) => /\/(trees|commits|refs\/heads\/.*)$/.test(w)).length;
  const commitsBefore = commits();
  const context = await newContext(browser, { w: 1440, h: 900, touch: false });
  const sh = shell(fixture, { platform: 'ios', installedGame: '0.1.1' });
  await context.exposeFunction('__shellCall', (m: string, p: Record<string, unknown>) => sh.call(m, p));
  await context.addInitScript({ content: BRIDGE('ios', {}, { mode: 'cloud', 'state.repo': full, 'github.token': TOKEN, 'github.login': 'founder' }) });
  await context.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': 'Authorization, Content-Type, If-None-Match, X-GitHub-Api-Version, Accept', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE' } });
    const res = await gh.handle(new URL(req.url()), { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined });
    const headers: Record<string, string> = { ...cors };
    res.headers.forEach((v, k) => (headers[k] = v));
    return route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
  });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(base);
  await waitBoot(page);
  await page.waitForSelector('#toasts .update-toast', { timeout: 60_000 });
  const toastText = await page.locator('#toasts .update-toast').innerText();
  ok(/Coordinator update available: 0\.1\.1/.test(toastText), `cloud: the prompt offers the coordinator update (${toastText.replace(/\s+/g, ' ')})`);
  ok(gh.files(full)[COORDINATOR_BUNDLE_PATH] === before && commits() === commitsBefore, 'cloud: nothing is committed automatically');
  await shot(page, 'cloud-01-coordinator-toast');
  await page.locator('#toasts .update-toast .btn.primary').click();
  await page.waitForSelector('.update-modal .update-card:has-text("Coordinator update available")');
  await shot(page, 'cloud-02-coordinator-dialog');
  await page.locator('.update-modal .btn', { hasText: 'Update coordinator' }).click();
  await page.waitForSelector('.cloud-confirm[aria-label^="Update your coordinator"]');
  const confirmText = await page.locator('.cloud-confirm').innerText();
  ok(/checked against the signed release/.test(confirmText) && /no paid work starts/.test(confirmText), 'cloud: a clear confirmation says what is committed and what is not');
  await shot(page, 'cloud-03-coordinator-confirm');
  await page.locator('.cloud-confirm .btn.primary').click();
  await page.waitForSelector('.update-modal .update-card:has-text("Coordinator 0.1.1")', { timeout: 30_000 });
  const files = gh.files(full);
  const shipped = await (await fetch(new URL('cloud/agent-empire-coordinator.mjs', base))).text();
  ok(files[COORDINATOR_BUNDLE_PATH] === shipped, 'cloud: the committed bundle is the signed release’s coordinator');
  ok(JSON.parse(files['coordinator/coordinator.json'] ?? '{}').version === '0.1.1', 'cloud: coordinator.json records the version');
  await shot(page, 'cloud-04-coordinator-updated');
  ok(errors.length === 0, `cloud: no page errors (${errors.slice(0, 3).join(' | ')})`);
  await context.close();
}

async function main() {
  const port = Number(process.env.UPDATE_FIXTURE_PORT || 4720);
  const fx = await startUpdateFixture({ port, game: resolve(import.meta.dirname, '../dist/public') });
  const fixture = updates.fixtureMapper(fx.origin);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    await serverMode(browser, fixture, { tag: 'desktop-1440x900', w: 1440, h: 900, touch: false });
    await serverMode(browser, fixture, { tag: 'narrow-375x812-reduced-motion', w: 375, h: 812, touch: false, reduced: true });
    await serverMode(browser, fixture, { tag: 'phone-landscape-812x375', w: 812, h: 375, touch: true });
    await cloudMode(browser, fixture);
  } finally {
    await browser.close();
    fx.server.close();
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll update UI checks passed');
  process.exit(failures.length ? 1 : 0);
}
void main();
