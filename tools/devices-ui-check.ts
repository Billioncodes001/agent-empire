/**
 * Settings › Signed-in devices against the isolated UI fixture only (never the protected 4610 session).
 *   npm run build:client && FIXTURE_PORT=4824 FIXTURE_DEVICES=1 npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://localhost:4824/ npx tsx tools/devices-ui-check.ts
 * Browser page (cookie session): both seeded devices listed with platform and last seen, revoke asks first, Never mind
 * keeps the device, Revoke removes it. Desktop 1440×900 and phone 874×402. Screenshots: docs/team/reports/consistency/.
 * The app-mode "This device" row (bearer session) is covered by tests/devices-ui.test.ts; booting the page in app mode
 * needs a native shell's secure store, which the fixture does not provide.
 */
import { chromium, type Browser } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:4824/';
if (/:4610\b/.test(base)) throw new Error('Refusing the protected 4610 session; use the isolated fixture.');
const out = resolve(import.meta.dirname, '../docs/team/reports/consistency');
mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

async function openSettings(browser: Browser, size: { width: number; height: number }, app?: { token: string; deviceId: string }) {
  const touch = size.width < 1000;
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }));
    localStorage.setItem('agent-empire.execution.offered', '1');
  });
  if (app) await context.addInitScript({ content: `window.AGENT_EMPIRE_APP = ${JSON.stringify({ host: new URL(base).origin, token: app.token, platform: 'desktop', deviceId: app.deviceId })};` });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*404/.test(m.text())) errors.push(m.text()); });
  await page.goto(base);
  await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
  await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10_000 });
  for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await page.evaluate(() => (document.getElementById('btn-settings') as HTMLElement).click());
  await page.locator('.devices-card .device-row').first().waitFor({ timeout: 10_000 });
  await page.locator('.devices-card').scrollIntoViewIfNeeded();
  return { context, page, errors };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  for (const size of [{ width: 1440, height: 900 }, { width: 874, height: 402 }]) {
    const tag = `${size.width}x${size.height}`;
    const { context, page, errors } = await openSettings(browser, size);
    const rows = await page.locator('.devices-card .device-row').allInnerTexts();
    check(`${tag}: browser lists the seeded devices with platform and last seen`, rows.length >= 2 && rows.some((r) => /iPhone[\s\S]*iOS · last seen/.test(r)) && rows.some((r) => /Android device[\s\S]*Android · last seen/.test(r)), rows.join(' | '));
    check(`${tag}: no row is marked this device on a cookie session`, !(await page.locator('.devices-card .device-this').count()));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    check(`${tag}: no horizontal overflow`, !overflow);
    await page.screenshot({ path: resolve(out, `devices-settings-${size.width}.png`) });
    await page.locator('.device-row[data-device="fx-android"] .btn').click();
    const dialog = page.locator('[role=alertdialog]');
    await dialog.waitFor();
    check(`${tag}: revoke asks for confirmation first`, /Revoke Android device\?/.test(await dialog.innerText()));
    await page.screenshot({ path: resolve(out, `devices-confirm-${size.width}.png`) });
    await dialog.getByRole('button', { name: 'Never mind' }).click();
    await page.waitForTimeout(300);
    check(`${tag}: Never mind keeps the device`, (await page.locator('.device-row[data-device="fx-android"]').count()) === 1);
    if (size.width === 874) {
      await page.locator('.device-row[data-device="fx-android"] .btn').click();
      await page.locator('[role=alertdialog]').getByRole('button', { name: 'Revoke device' }).click();
      await page.waitForFunction(() => !document.querySelector('.device-row[data-device="fx-android"]'), null, { timeout: 5000 }).catch(() => {});
      check(`${tag}: Revoke removes the device from the list`, (await page.locator('.device-row[data-device="fx-android"]').count()) === 0);
    }
    check(`${tag}: no console errors`, !errors.length, errors.join(' | '));
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failing` : 'all device checks pass');
process.exit(failed ? 1 : 0);
