/**
 * CITY-10 acceptance for the city architect, against the isolated UI fixture only (never the protected 4610 session).
 *   npm run build && FIXTURE_PORT=5141 FIXTURE_ARCHITECT=1 npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://localhost:5141/ npx tsx tools/architect-ui-check.ts
 * The fixture's architect is real and starts off; "Run now" runs rule-based growth (no model, no network).
 * Screenshots go to docs/team/reports/city-10/ at 1440x900 and 874x402 (plus a 375 px Settings check); exits non-zero
 * on any failed check.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:5141/';
if (/:4610\b/.test(base)) throw new Error('Refusing the protected 4610 session; use the UI fixture.');
const out = resolve(import.meta.dirname, '../docs/team/reports/city-10');
mkdirSync(out, { recursive: true });

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

interface Opened { context: BrowserContext; page: Page; errors: string[] }
async function open(browser: Browser, o: { width: number; height: number; touch: boolean; saveData?: boolean }): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: 1, isMobile: o.touch, hasTouch: o.touch });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }));
    localStorage.setItem('agent-empire.execution.offered', '1');
  });
  if (o.saveData) await context.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true } }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*404/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { const p = new URL(r.url()).pathname; if (r.status() === 404 && !p.startsWith('/api/')) errors.push(`404 ${p}`); });
  await page.goto(base);
  await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
  await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 15_000 });
  for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await page.waitForFunction(() => (window as any).__office?.city?.districts?.loaded, null, { timeout: 60_000 });
  return { context, page, errors };
}

type View = { x: number; z: number; yaw: number; view: 'first' | 'third'; dist?: number; pitch?: number; look?: number };
async function place(page: Page, v: View, settle = 1500) {
  await page.evaluate((p) => {
    const o = (window as any).__office;
    o.player.view = p.view; o.player.pos.set(p.x, 0, p.z); o.player.camYaw = p.yaw; o.player.facing = p.yaw; o.player.lookPitch = p.look ?? -0.05;
    if (p.dist) o.player.camDist = p.dist;
    if (p.pitch) o.player.camPitch = p.pitch;
    o.player.updateCamera(true);
  }, v);
  await page.waitForTimeout(settle);
}
let focus: View | undefined;
const YARD: View = { x: 133, z: 140, yaw: Math.PI, view: 'third', dist: 30, pitch: 0.55 };
const stats = (page: Page) => page.evaluate(() => ({ ...(window as any).__office.city.architect.stats }));
const api = (page: Page, path: string, body?: unknown) => page.evaluate(async ([p, b]) => {
  const r = await fetch(p as string, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, body] as const);
const settled = (page: Page) => page.waitForTimeout(450);
const openSettings = async (page: Page) => {
  await page.evaluate(() => document.getElementById('btn-settings')!.click());
  await page.waitForSelector('.architect-section .architect-form', { timeout: 10_000 });
  await page.locator('.architect-section').scrollIntoViewIfNeeded();
  await settled(page);
};
const closeModal = async (page: Page) => { for (let i = 0; i < 3 && (await page.locator('#modal-root .backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); } };
const openInboxItem = async (page: Page) => {
  await page.evaluate(() => document.getElementById('btn-inbox')!.click());
  const row = page.locator('[data-approval]', { hasText: 'City architect daily summary' }).first();
  await row.waitFor({ timeout: 10_000 });
  await row.click();
  await page.waitForSelector('.architect-facts', { timeout: 5000 });
  await settled(page);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal'] });
// ARCH_UI_ONLY=max (against FIXTURE_ARCHITECT=max): the fully grown world, desktop and phone, for the report.
if (process.env.ARCH_UI_ONLY === 'max') {
  try {
    for (const [label, size] of [['1440x900', { width: 1440, height: 900, touch: false }], ['phone-874x402', { width: 874, height: 402, touch: true }]] as const) {
      const m = await open(browser, size);
      await m.page.waitForFunction(() => (window as any).__office.city.architect.stats.rendered > 0, null, { timeout: 15_000 });
      const st = await stats(m.page);
      const host = (await api(m.page, '/api/architect')).json;
      check(`max world rendered in full (${label})`, st.rendered === host.world.additions.length && st.skipped === 0, JSON.stringify(st));
      await place(m.page, { x: 112, z: 158, yaw: Math.PI * 0.85, view: 'third', dist: 30, pitch: 0.55 }, 2000);
      await m.page.screenshot({ path: resolve(out, `12-max-harbour-${label}.jpg`), quality: 82 });
      await place(m.page, { x: 74, z: 42, yaw: Math.PI * 0.8, view: 'third', dist: 26, pitch: 0.5 }, 2000);
      await m.page.screenshot({ path: resolve(out, `13-max-meridian-${label}.jpg`), quality: 82 });
      check(`no console errors with the max world (${label})`, m.errors.length === 0, m.errors.join(' | '));
      await m.context.close();
    }
  } finally { await browser.close(); }
  writeFileSync(resolve(out, 'checks-max.json'), `${JSON.stringify({ base, results }, null, 2)}\n`);
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  process.exit(bad.length ? 1 : 0);
}
try {
  // ---- Desktop: before, enable, run, after, hint ----
  const d = await open(browser, { width: 1440, height: 900, touch: false });
  const st0 = await api(d.page, '/api/architect');
  check('fixture architect starts off and empty', st0.json?.settings.enabled === false && st0.json?.world.additions.length === 0, JSON.stringify(st0.json?.settings));
  await place(d.page, YARD);
  check('no additions are drawn without the architect', (await stats(d.page)).rendered === 0);
  await openSettings(d.page);
  await d.page.locator('.architect-section').screenshot({ path: resolve(out, '03-settings-off-1440x900.jpg'), quality: 85 });
  check('Settings names the feature and says it is off', /Let the city grow while you’re away/.test(await d.page.locator('.architect-section').innerText()) && /Off\./.test(await d.page.locator('.architect-status').innerText()));
  // Keyboard: the toggle and Save are reachable and operable without a pointer.
  await d.page.locator('.architect-toggle input').focus();
  await d.page.keyboard.press('Space');
  await d.page.locator('.architect-form button[type=submit]').focus();
  await d.page.keyboard.press('Enter');
  await d.page.waitForSelector('.architect-form [data-action=run]', { timeout: 5000 });
  check('turning it on by keyboard saves the setting', (await api(d.page, '/api/architect')).json?.settings.enabled === true);
  await d.page.locator('.architect-form [data-action=run]').click();
  await d.page.waitForFunction(() => (window as any).__office.city.architect.stats.rendered > 0, null, { timeout: 15_000 });
  await settled(d.page);
  await d.page.locator('.architect-section').screenshot({ path: resolve(out, '04-settings-after-run-1440x900.jpg'), quality: 85 });
  const st1 = (await api(d.page, '/api/architect')).json;
  const run = st1.runs[0];
  check('Run now applied rule-based changes (at most 3), US$0', run.status === 'applied' && run.engine === 'rules' && run.changes.length >= 1 && run.changes.length <= 3 && /US\$0/.test(run.costLabel), `${run.changes.length} changes, ${run.costLabel}`);
  check('the game renders every addition the host reports', (await stats(d.page)).rendered === st1.world.additions.length, JSON.stringify(await stats(d.page)));
  // From Node, not the page: an intentional 409 must not count as a console error.
  const againRes = await fetch(new URL('/api/architect/run', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const again = { status: againRes.status, json: await againRes.json().catch(() => null) };
  check('a second run the same day is refused', again.status === 409 && /already ran today/.test(again.json?.error ?? ''));
  await closeModal(d.page);
  // Look at the most prominent addition (the seed picks the lots), from the south-east, close enough to read.
  const rank = (m: string) => (/building-/.test(m) ? 0 : /container|tank|parasol|awning|tree/.test(m) ? 1 : 2);
  const pick = [...st1.world.additions].sort((a: { model: string }, b: { model: string }) => rank(a.model) - rank(b.model))[0];
  focus = { x: pick.x + 3, z: pick.z + 3, yaw: Math.PI * 0.75, view: 'third', dist: 14, pitch: 0.42 };
  await place(d.page, focus);
  await d.page.screenshot({ path: resolve(out, '02-after-1440x900.jpg'), quality: 82 });
  // Walk up to the first addition: the hint labels it as the architect's, not agent work.
  const first = st1.world.additions[0];
  await place(d.page, { x: first.x + 1.2, z: first.z + 1.2, yaw: Math.PI * 0.75, view: 'third', dist: 7, pitch: 0.3 }, 1200);
  const hint = await d.page.locator('.traversal-hint').innerText().catch(() => '');
  check('walking up shows "Built by the city architect"', /^Built by the city architect · \d{4}-\d{2}-\d{2} · /.test(hint), hint);
  await d.page.screenshot({ path: resolve(out, '05-hint-1440x900.jpg'), quality: 82 });
  // Low quality: buildings only.
  const buildings = st1.world.additions.filter((a: { model: string }) => /building-/.test(a.model)).length;
  await d.page.evaluate(() => (window as any).__office.city.architect.setQuality('low'));
  check('Low quality keeps only buildings', (await stats(d.page)).rendered === buildings, `${(await stats(d.page)).rendered} vs ${buildings}`);
  await d.page.evaluate(() => (window as any).__office.city.architect.setQuality('medium'));

  // ---- Save-Data: buildings only ----
  const s = await open(browser, { width: 1440, height: 900, touch: false, saveData: true });
  await s.page.waitForTimeout(800);
  check('Save-Data keeps only buildings', (await stats(s.page)).rendered === buildings, `${(await stats(s.page)).rendered} vs ${buildings}`);
  check('no console errors with Save-Data', s.errors.length === 0, s.errors.join(' | '));
  await s.context.close();

  // ---- Phone 874x402: Settings and the inbox summary ----
  const p = await open(browser, { width: 874, height: 402, touch: true });
  await openSettings(p.page);
  await p.page.screenshot({ path: resolve(out, '06-settings-phone-874x402.jpg'), quality: 82 });
  const overflow = await p.page.evaluate(() => { const m = document.querySelector('#modal-root [role=dialog]') as HTMLElement; return m.scrollWidth - m.clientWidth; });
  check('phone Settings has no horizontal overflow', overflow <= 1, `${overflow}px`);
  await closeModal(p.page);
  await openInboxItem(p.page);
  await p.page.screenshot({ path: resolve(out, '07-inbox-phone-874x402.jpg'), quality: 82 });
  check('phone inbox shows the change list with Undo buttons', (await p.page.locator('.architect-facts .architect-changes button', { hasText: 'Undo' }).count()) === run.changes.length);
  check('no console errors on the phone', p.errors.length === 0, p.errors.join(' | '));
  await p.context.close();

  // ---- 375 px: Settings fits ----
  const n = await open(browser, { width: 375, height: 812, touch: true });
  await openSettings(n.page);
  const narrow = await n.page.evaluate(() => { const m = document.querySelector('#modal-root [role=dialog]') as HTMLElement; return { over: m.scrollWidth - m.clientWidth, page: document.documentElement.scrollWidth - innerWidth }; });
  check('375 px Settings has no horizontal overflow', narrow.over <= 1 && narrow.page <= 1, JSON.stringify(narrow));
  await n.page.locator('.architect-section').screenshot({ path: resolve(out, '08-settings-375.jpg'), quality: 82 });
  await n.context.close();

  // ---- Desktop: inbox summary, undo one change, revert the day ----
  await openInboxItem(d.page);
  const detail = await d.page.locator('#modal-root').innerText();
  check('inbox summary: City architect tag, engine, cost, Keep and Revert actions', /City architect · Rule-based/.test(detail) && /Rule-based growth · US\$0/.test(detail) && /Keep changes…/.test(detail) && /Revert this day…/.test(detail));
  await d.page.screenshot({ path: resolve(out, '09-inbox-summary-1440x900.jpg'), quality: 82 });
  const before = (await stats(d.page)).rendered;
  await d.page.locator('.architect-facts .architect-changes button', { hasText: 'Undo' }).first().click();
  await d.page.waitForFunction((b) => (window as any).__office.city.architect.stats.rendered === b - 1, before, { timeout: 8000 });
  await d.page.waitForSelector('.architect-facts [data-undone=true]', { timeout: 5000 });
  await settled(d.page);
  await d.page.screenshot({ path: resolve(out, '10-undo-1440x900.jpg'), quality: 82 });
  const st2 = (await api(d.page, '/api/architect')).json;
  check('undo removed exactly one addition and became an avoid-rule', st2.world.additions.length === before - 1 && st2.journal.avoid.some((r: { source: string }) => r.source === 'undo'));
  if (st2.world.additions.length > 0) {
    await d.page.locator('#modal-root button', { hasText: 'Revert this day…' }).click();
    await d.page.locator('#modal-root button', { hasText: 'Confirm revert' }).click();
    await d.page.waitForFunction(() => (window as any).__office.city.architect.stats.rendered === 0, null, { timeout: 8000 });
    await settled(d.page);
    await d.page.screenshot({ path: resolve(out, '11-reverted-1440x900.jpg'), quality: 82 });
    const st3 = (await api(d.page, '/api/architect')).json;
    check('Revert this day removed the rest of the day', st3.world.additions.length === 0 && st3.runs[0].reverted === true);
    // The reverted world is the world before the run: the "before" picture, from the same viewpoint as "after".
    await closeModal(d.page);
    await place(d.page, focus!);
    await d.page.screenshot({ path: resolve(out, '01-before-1440x900.jpg'), quality: 82 });
  }
  check('no console errors on desktop', d.errors.length === 0, d.errors.join(' | '));
  await d.context.close();
} finally {
  await browser.close();
}
writeFileSync(resolve(out, 'checks.json'), `${JSON.stringify({ base, results }, null, 2)}\n`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
