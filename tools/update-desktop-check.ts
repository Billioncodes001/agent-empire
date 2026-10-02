/**
 * Packaged macOS app, in-app game update end to end (REL-04), against the isolated UI fixture and the local update
 * fixture. Isolated --user-data-dir (never the real profile), mock keychain, driven over CDP.
 *
 *   npm run desktop:package
 *   FIXTURE_PORT=4720 FIXTURE_PASSWORD=fixture-office npx tsx tools/ui-fixture.ts
 *   UPDATE_FIXTURE_PORT=4721 UPDATE_GOOD=1.0.0-beta.2 UPDATE_BROKEN=1.0.0-beta.3 UPDATE_OLDER=0.1.1 npx tsx tools/update-fixture.ts
 *   USER_DATA=<scratch>/ud-updates FIXTURE_URL=http://127.0.0.1:4720 UPDATE_FIXTURE_URL=http://127.0.0.1:4721 \
 *     OUT_DIR=docs/team/reports/update-device-rerun npx tsx tools/update-desktop-check.ts
 *
 * Proves, with the versions the update fixture offers (GOOD = N+1, BROKEN = N+2, optional OLDER < N):
 *   - a tampered channel-stable.json is refused by the page (no prompt, the check reports the signature);
 *   - a genuine channel the page accepts, but a tampered channel-beta.json in the tagged release, is refused by the
 *     shell's own Ed25519 check when "Update game" is pressed (nothing installed);
 *   - the prompt, a real download/sha256/unzip/switch into game-bundles/<GOOD>, the restart into it with update.bootOk;
 *   - a broken BROKEN that never boots and is rolled back after 20 s, with a notice;
 *   - a downgrade to OLDER: never offered by the page, and refused by the shell when asked directly over the bridge.
 */
import { chromium, type Page } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = process.env.FIXTURE_URL || 'http://127.0.0.1:4718';
const updates = process.env.UPDATE_FIXTURE_URL || 'http://127.0.0.1:4721';
const userData = resolve(process.env.USER_DATA || '');
if (!process.env.USER_DATA) throw new Error('Set USER_DATA to an isolated scratch folder.');
const app = resolve(import.meta.dirname, '../release/Agent Empire-darwin-arm64/Agent Empire.app/Contents/MacOS/Agent Empire');
const out = resolve(process.env.OUT_DIR || resolve(import.meta.dirname, '../docs/team/reports/in-app-updates'));
mkdirSync(out, { recursive: true });
const port = Number(process.env.CDP_PORT || 9333);
const failures: string[] = [];
const ok = (c: unknown, n: string) => (console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`), c || failures.push(n));
const shot = (p: Page, n: string) => p.screenshot({ path: resolve(out, `${n}.jpg`), type: 'jpeg', quality: 80 });
const state = () => JSON.parse(readFileSync(resolve(userData, 'game-bundles/state.json'), 'utf8'));
const fx = async (since?: number) => (await fetch(`${updates}/__fixture${since === undefined ? '' : `?since=${since}`}`)).json() as Promise<{ good: string; broken: string; older: string | null; count: number; requests: string[] }>;
const post = (path: string) => fetch(`${updates}/__fixture/${path}`, { method: 'POST' });
const esc = (v: string) => v.replace(/\./g, '\\.');

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

/** A bridge call made the way the page makes it (window.empireDesktop), answered through __empireNative. */
const bridge = async (page: Page, method: string, params: unknown) => {
  await page.evaluate('window.__name = window.__name || ((f) => f)'); // tsx wraps named functions in __name(); reloads drop the shim
  return page.evaluate(
    ([method, params]) =>
      new Promise<{ ok: boolean; value: unknown }>((res) => {
        const id = `s${Math.random().toString(36).slice(2, 9)}`;
        const n = (window as any).__empireNative;
        const done = { resolve: n.resolve, reject: n.reject };
        Object.defineProperty(window, '__empireNative', { configurable: true, value: { resolve: (i: string, v: unknown) => (i === id ? res({ ok: true, value: v }) : done.resolve(i, v)), reject: (i: string, v: unknown) => (i === id ? res({ ok: false, value: v }) : done.reject(i, v)) } });
        (window as any).empireDesktop.postMessage({ id, method, params });
      }),
    [method, params] as const,
  );
};

async function openUpdates(page: Page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => (document.getElementById('btn-menu') as HTMLButtonElement).click());
  await page.locator('.game-menu .menu-item', { hasText: /Check for updates|Update available/ }).click();
  await page.locator('.update-modal').waitFor({ timeout: 30_000 });
}
async function checkAgain(page: Page) {
  await page.locator('.update-modal footer .btn', { hasText: 'Check again' }).click();
  await page.waitForFunction(() => !document.querySelector('.update-modal .upgrade-status.busy'), null, { timeout: 60_000 });
  await page.waitForTimeout(500);
}

async function main() {
  const f0 = await fx();
  const { good, broken, older } = f0;
  console.log(`fixture: good ${good}, broken ${broken}, older ${older}`);
  // The page reads the tampered stable channel at launch and must refuse it.
  await post('tamper/page');
  await post(`latest/${good}`);
  const browser = await connect();
  let page = browser.contexts()[0].pages().find((p) => p.url().startsWith('empire-app://game')) ?? browser.contexts()[0].pages()[0];
  await page.waitForLoadState('domcontentloaded');
  ok(/empire-app:\/\/game/.test(page.url()), `packaged app loads the bundled game (${page.url()})`);
  await page.evaluate('window.__name = (f) => f');
  const built = (await page.evaluate(() => fetch('/game-version.json').then((r) => r.json()))).version;
  console.log('built-in game:', built);
  const login = await (await fetch(`${fixture}/api/device/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: process.env.FIXTURE_PASSWORD || 'fixture-office', deviceName: 'Desktop update check' }) })).json();
  for (const [key, value] of [['server.host', fixture], ['server.token', login.token], ['server.deviceId', login.deviceId], ['mode', 'server']]) await bridge(page, 'secure.set', { key, value });
  await page.evaluate(() => {
    // Skip the first-run character and execution dialogs (an open dialog rightly holds the update prompt back).
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }));
    localStorage.setItem('agent-empire.execution.offered', '1');
  });
  await page.reload();
  await waitBoot(page);
  ok(true, 'signed in to the isolated fixture server; the game booted');
  await page.bringToFront(); // the prompt waits while the window is hidden or occluded

  // 1. Tampered stable channel: the page's own signature check refuses it.
  await openUpdates(page);
  await checkAgain(page);
  const pageErr = (await page.locator('.update-modal .upgrade-status.error').innerText().catch(() => '')).trim();
  ok(/signature does not match/.test(pageErr) && (await page.locator('#toasts .update-toast').count()) === 0, `tampered channel-stable.json refused by the page: "${pageErr}"`);
  await shot(page, 'macos-01-tampered-channel-refused-by-page');

  // 2. Genuine stable channel, tampered release channel: the page offers, the shell refuses on its own check.
  await post('tamper/shell');
  await checkAgain(page);
  await page.locator('.update-modal .btn.primary', { hasText: 'Update game' }).waitFor({ timeout: 30_000 });
  const before = (await fx()).count;
  await page.locator('.update-modal .btn.primary', { hasText: 'Update game' }).click();
  await page.locator('.update-modal .upgrade-status.error').waitFor({ timeout: 60_000 });
  const shellErr = (await page.locator('.update-modal .upgrade-status.error').innerText()).trim();
  const shellReqs = (await fx(before)).requests;
  ok(/release’s signature does not match this app’s release key\. Nothing was installed/.test(shellErr) && !existsSync(resolve(userData, `game-bundles/${good}`)), `tampered channel-beta.json in v${good} refused by the shell: "${shellErr}"`);
  ok(shellReqs.some((r) => r.includes(`/download/v${good}/channel-beta.json.sig`)) && !shellReqs.some((r) => r.includes('.zip')), `the shell read v${good}/channel-beta.json(.sig) itself and downloaded no zip (${shellReqs.filter((r) => r.includes('channel-beta')).join(', ')})`);
  await shot(page, 'macos-02-tampered-release-refused-by-shell');
  await post('tamper/off');
  await page.keyboard.press('Escape');

  // 3. Genuine: the prompt, install, restart, bootOk.
  await page.reload();
  await waitBoot(page);
  await page.bringToFront();
  const toast = page.locator('#toasts .update-toast');
  await toast.waitFor({ timeout: 60_000 });
  ok(new RegExp(`Update available: Agent Empire ${esc(good)}`).test(await toast.innerText()), `the page verified the signed channel and prompted: ${(await toast.innerText()).replace(/\s+/g, ' ')}`);
  await shot(page, 'macos-03-prompt');
  await toast.locator('.btn.primary').click();
  const mark = (await fx()).count;
  await page.locator('.update-modal .btn.primary', { hasText: 'Update game' }).click();
  await page.locator('.update-modal .btn.primary', { hasText: 'Restart now' }).waitFor({ timeout: 180_000 });
  const installReqs = (await fx(mark)).requests;
  writeFileSync(resolve(out, 'macos-install-requests.txt'), `${installReqs.join('\n')}\n`);
  ok(installReqs.some((r) => r.includes(`/download/v${good}/channel-beta.json.sig`)) && installReqs.some((r) => r.includes(`agent-empire-game-${good}.zip`)), 'the shell verified the release channel (v<GOOD>/channel-beta.json.sig) before downloading the zip');
  ok(existsSync(resolve(userData, `game-bundles/${good}/index.html`)) && state().pending === good, `downloaded, sha256-checked and unpacked into game-bundles/${good} (pending)`);
  await shot(page, 'macos-04-installed');
  await page.locator('.update-modal .btn.primary', { hasText: 'Restart now' }).click();
  await page.waitForTimeout(1500);
  page = browser.contexts()[0].pages().find((p) => p.url().startsWith('empire-app://game'))!;
  await waitBoot(page);
  await page.waitForTimeout(1500);
  const s1 = state();
  ok(s1.active === good && s1.knownGood === good && !s1.trial, `restarted into ${good} and it reported booting (state ${JSON.stringify(s1)})`);
  ok((await page.evaluate(() => fetch('/game-version.json').then((r) => r.json()))).version === good, 'empire-app://game now serves the installed bundle');
  await page.evaluate(() => (document.getElementById('btn-settings') as HTMLButtonElement).click());
  await page.waitForFunction((g) => (document.querySelector('.update-settings')?.textContent ?? '').includes(`Game ${g}`), good, { timeout: 30_000 });
  await page.locator('.settings-modal .body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(800);
  await shot(page, 'macos-05-running-good');
  await page.keyboard.press('Escape');

  // 4. A broken release: installed, restarted into, never boots → rolled back after 20 s.
  await post(`latest/${broken}`);
  await openUpdates(page);
  await checkAgain(page);
  await page.locator('.update-modal .btn.primary', { hasText: 'Update game' }).click();
  await page.locator('.update-modal .btn.primary', { hasText: 'Restart now' }).waitFor({ timeout: 120_000 });
  await page.locator('.update-modal .btn.primary', { hasText: 'Restart now' }).click();
  const t0 = Date.now();
  await page.waitForTimeout(3000);
  page = browser.contexts()[0].pages().find((p) => p.url().startsWith('empire-app://game'))!;
  ok(new RegExp(`Broken update ${esc(broken)}`).test(await page.locator('body').innerText()) && state().trial?.version === broken, `restarted into the broken ${broken} (on trial)`);
  await shot(page, 'macos-06-broken-bundle');
  await page.waitForFunction(() => document.documentElement.dataset.boot === 'ready' || document.documentElement.dataset.boot === 'forced', null, { timeout: 120_000 }).catch(() => {});
  page = browser.contexts()[0].pages().find((p) => p.url().startsWith('empire-app://game'))!;
  await waitBoot(page);
  const s2 = state();
  ok(s2.active === good && s2.bad.includes(broken) && Date.now() - t0 >= 19_000, `no boot report for 20 s: rolled back to ${good} after ${((Date.now() - t0) / 1000).toFixed(1)} s (state ${JSON.stringify(s2)})`);
  const warn = page.locator('#toasts .toast.warn');
  await warn.waitFor({ timeout: 30_000 });
  ok(new RegExp(`didn’t start, so the app went back to ${esc(good)}`).test(await warn.innerText()), `the player is told: ${await warn.innerText()}`);
  await shot(page, 'macos-07-rolled-back');

  // 5. Downgrade: an older signed release is never offered, and the shell refuses it when asked directly.
  if (older) {
    await post(`latest/${older}`);
    await openUpdates(page);
    await checkAgain(page);
    const body = (await page.locator('.update-modal .body').innerText()).replace(/\s+/g, ' ');
    ok(/You’re up to date/.test(body) && (await page.locator('.update-modal .btn.primary', { hasText: 'Update game' }).count()) === 0, `older signed release ${older} is not offered by the page: "${body.slice(0, 160)}"`);
    await shot(page, 'macos-08-downgrade-not-offered');
    const ch = JSON.parse(await (await fetch(`${updates}/__assets/v${older}/channel-beta.json`)).text());
    const r = await bridge(page, 'update.installGame', { url: ch.game.url, sha256: ch.game.sha256, version: older });
    const msg = JSON.stringify(r.value);
    ok(!r.ok && /not newer/.test(msg) && !existsSync(resolve(userData, `game-bundles/${older}`)), `shell refuses update.installGame for ${older} over the bridge: ${msg}`);
    await page.keyboard.press('Escape');
  }
  await browser.close().catch(() => {});
}

main()
  .catch((e) => (console.error(e), failures.push(String(e))))
  .finally(() => {
    proc.kill();
    const shellLog = logs.join('');
    writeFileSync(resolve(out, 'macos-shell.txt'), shellLog);
    console.log(shellLog.split('\n').filter((l) => /update|Update|rolled|fixture/i.test(l)).slice(-12).join('\n'));
    console.log(failures.length ? `${failures.length} failed` : 'All desktop device checks passed');
    process.exit(failures.length ? 1 : 0);
  });
