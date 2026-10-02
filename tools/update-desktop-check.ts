/**
 * Packaged macOS app, in-app game update end to end (REL-04), against the isolated UI fixture and the local update
 * fixture. Isolated --user-data-dir (never the real profile), mock keychain, driven over CDP.
 *
 *   npm run desktop:package
 *   FIXTURE_PORT=4718 FIXTURE_PASSWORD=fixture-office npx tsx tools/ui-fixture.ts
 *   UPDATE_FIXTURE_PORT=4721 npx tsx tools/update-fixture.ts
 *   USER_DATA=<scratch>/ud-updates npx tsx tools/update-desktop-check.ts
 *
 * Proves: the prompt from a real signed channel fetch, a real download/sha256/unzip/switch into game-bundles/0.1.1,
 * the restart into it with update.bootOk, then a broken 0.1.2 that never boots and is rolled back after 20 s.
 */
import { chromium, type Page } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = process.env.FIXTURE_URL || 'http://127.0.0.1:4718';
const updates = process.env.UPDATE_FIXTURE_URL || 'http://127.0.0.1:4721';
const userData = resolve(process.env.USER_DATA || '');
if (!process.env.USER_DATA) throw new Error('Set USER_DATA to an isolated scratch folder.');
const app = resolve(import.meta.dirname, '../release/Agent Empire-darwin-arm64/Agent Empire.app/Contents/MacOS/Agent Empire');
const out = resolve(import.meta.dirname, '../docs/team/reports/in-app-updates');
const port = Number(process.env.CDP_PORT || 9333);
const failures: string[] = [];
const ok = (c: unknown, n: string) => (console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`), c || failures.push(n));
const shot = (p: Page, n: string) => p.screenshot({ path: resolve(out, `${n}.jpg`), type: 'jpeg', quality: 80 });
const state = () => JSON.parse(readFileSync(resolve(userData, 'game-bundles/state.json'), 'utf8'));

rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });
const proc = spawn(app, [`--user-data-dir=${userData}`, '--use-mock-keychain', `--remote-debugging-port=${port}`, `--empire-update-fixture=${updates}`], { stdio: ['ignore', 'pipe', 'pipe'] });
const logs: string[] = [];
proc.stdout.on('data', (d) => logs.push(String(d)));
proc.stderr.on('data', (d) => logs.push(String(d)));

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('no CDP');
}


const waitBoot = (page: Page) => page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 180_000 });

async function main() {
  const browser = await connect();
  let page = browser.contexts()[0].pages().find((p) => p.url().startsWith('empire-app://game')) ?? browser.contexts()[0].pages()[0];
  await page.waitForLoadState('domcontentloaded');
  ok(/empire-app:\/\/game/.test(page.url()), `packaged app loads the bundled game (${page.url()})`);
  // Sign in to the fixture server through the app's own bridge (secure.set), as the setup does.
  await page.evaluate('window.__name = (f) => f'); // tsx wraps named functions in __name()
  const login = await (await fetch(`${fixture}/api/device/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: process.env.FIXTURE_PASSWORD || 'fixture-office', deviceName: 'Desktop update check' }) })).json();
  await page.evaluate(
    async ([host, token, deviceId]) => {
      const call = (method: string, params: unknown) =>
        new Promise((res) => {
          const id = `s${Math.random().toString(36).slice(2, 9)}`;
          const n = (window as any).__empireNative;
          const done = { resolve: n.resolve, reject: n.reject };
          Object.defineProperty(window, '__empireNative', { configurable: true, value: { resolve: (i: string, v: unknown) => (i === id ? res(v) : done.resolve(i, v)), reject: (i: string, v: unknown) => (i === id ? res(v) : done.reject(i, v)) } });
          (window as any).empireDesktop.postMessage({ id, method, params });
        });
      await call('secure.set', { key: 'server.host', value: host });
      await call('secure.set', { key: 'server.token', value: token });
      await call('secure.set', { key: 'server.deviceId', value: deviceId });
      await call('secure.set', { key: 'mode', value: 'server' });
      // Skip the first-run character and execution dialogs (an open dialog rightly holds the update prompt back).
      localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }));
      localStorage.setItem('agent-empire.execution.offered', '1');
    },
    [fixture, login.token, login.deviceId] as const,
  );
  await page.reload();
  await waitBoot(page);
  ok(true, 'signed in to the isolated fixture server; the game booted');
  await page.bringToFront(); // the prompt waits while the window is hidden or occluded
  console.log('visibility:', await page.evaluate(() => document.visibilityState));
  const toast = page.locator('#toasts .update-toast');
  await toast.waitFor({ timeout: 60_000 }).catch(async (e) => {
    await page.evaluate(() => (document.getElementById('btn-settings') as HTMLButtonElement).click());
    await page.waitForTimeout(1500);
    console.log('settings:', (await page.locator('.update-settings').innerText().catch(() => '?')).replace(/\s+/g, ' '));
    throw e;
  });
  ok(/Update available: Agent Empire 0\.1\.1/.test(await toast.innerText()), `the real shell fetched and verified the signed channel: ${(await toast.innerText()).replace(/\s+/g, ' ')}`);
  await shot(page, 'device-macos-01-prompt');
  await toast.locator('.btn.primary').click();
  await page.locator('.update-modal .btn.primary', { hasText: 'Update game' }).click();
  await page.locator('.update-modal .btn.primary', { hasText: 'Restart now' }).waitFor({ timeout: 180_000 });
  ok(existsSync(resolve(userData, 'game-bundles/0.1.1/index.html')) && state().pending === '0.1.1', 'downloaded, sha256-checked and unpacked into game-bundles/0.1.1 (pending)');
  await shot(page, 'device-macos-02-installed');
  await page.locator('.update-modal .btn.primary', { hasText: 'Restart now' }).click();
  await page.waitForTimeout(1500);
  page = browser.contexts()[0].pages().find((p) => p.url().startsWith('empire-app://game'))!;
  await waitBoot(page);
  await page.waitForTimeout(1500);
  const s1 = state();
  ok(s1.active === '0.1.1' && s1.knownGood === '0.1.1' && !s1.trial, `restarted into 0.1.1 and it reported booting (state ${JSON.stringify(s1)})`);
  ok((await page.evaluate(() => fetch('/game-version.json').then((r) => r.json()))).version === '0.1.1', 'empire-app://game now serves the installed bundle');
  await page.evaluate(() => (document.getElementById('btn-settings') as HTMLButtonElement).click());
  await page.waitForFunction(() => /Game 0\.1\.1/.test(document.querySelector('.update-settings')?.textContent ?? ''), null, { timeout: 30_000 });
  await page.locator('.settings-modal .body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(800);
  await shot(page, 'device-macos-03-running-0.1.1');
  await page.keyboard.press('Escape');

  // A broken release: installed, restarted into, never boots → rolled back to 0.1.1 after 20 s.
  await fetch(`${updates}/__fixture/latest/0.1.2`, { method: 'POST' });
  await page.evaluate(() => (document.getElementById('btn-menu') as HTMLButtonElement).click());
  await page.locator('.game-menu .menu-item', { hasText: 'Check for updates' }).click();
  await page.locator('.update-modal .btn.primary', { hasText: 'Update game' }).waitFor({ timeout: 60_000 });
  await page.locator('.update-modal .btn.primary', { hasText: 'Update game' }).click();
  await page.locator('.update-modal .btn.primary', { hasText: 'Restart now' }).waitFor({ timeout: 120_000 });
  await page.locator('.update-modal .btn.primary', { hasText: 'Restart now' }).click();
  const t0 = Date.now();
  await page.waitForTimeout(3000);
  page = browser.contexts()[0].pages().find((p) => p.url().startsWith('empire-app://game'))!;
  ok(/Broken update 0\.1\.2/.test(await page.locator('body').innerText()) && state().trial?.version === '0.1.2', 'restarted into the broken 0.1.2 (on trial)');
  await shot(page, 'device-macos-04-broken-bundle');
  await page.waitForFunction(() => document.documentElement.dataset.boot === 'ready' || document.documentElement.dataset.boot === 'forced', null, { timeout: 120_000 }).catch(() => {});
  page = browser.contexts()[0].pages().find((p) => p.url().startsWith('empire-app://game'))!;
  await waitBoot(page);
  const s2 = state();
  ok(s2.active === '0.1.1' && s2.bad.includes('0.1.2') && Date.now() - t0 >= 19_000, `no boot report for 20 s: rolled back to 0.1.1 after ${((Date.now() - t0) / 1000).toFixed(0)} s (state ${JSON.stringify(s2)})`);
  const warn = page.locator('#toasts .toast.warn');
  await warn.waitFor({ timeout: 30_000 });
  ok(/didn’t start, so the app went back to 0\.1\.1/.test(await warn.innerText()), `the player is told: ${await warn.innerText()}`);
  await shot(page, 'device-macos-05-rolled-back');
  await browser.close().catch(() => {});
}

main()
  .catch((e) => (console.error(e), failures.push(String(e))))
  .finally(() => {
    proc.kill();
    console.log(logs.join('').split('\n').filter((l) => /update|Update|rolled/i.test(l)).slice(-10).join('\n'));
    console.log(failures.length ? `${failures.length} failed` : 'All desktop device checks passed');
    process.exit(failures.length ? 1 : 0);
  });
