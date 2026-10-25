/**
 * DEVTEST-02 browser matrix against an isolated UI fixture (never 4610): Playwright Chromium (Chrome channel), WebKit
 * and Firefox at 1440x900, 1024x768 (tablet), 874x402 (phone landscape, touch) and 375x812 (portrait: the rotate
 * screen). Checks sign-in page, HUD, city canvas, Settings, onboarding, the founder desk (consultancy.html), console
 * errors, keyboard focus in dialogs, reduced motion and Save-Data. Screenshots go to OUT (docs/team/reports/devtest-02/browsers).
 *   npm run build:client
 *   FIXTURE_PORT=5110 FIXTURE_ONBOARDING=new FIXTURE_ENGINES=free npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://localhost:5110/ npx tsx tools/browser-matrix-check.ts [chromium|webkit|firefox ...]
 * WebKit and Firefox need `npx playwright-core install webkit firefox`. Exits non-zero on any failed check.
 */
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:5110/';
if (/:4610\b/.test(base)) throw new Error('Refusing the protected 4610 session; use the UI fixture.');
const out = resolve(process.env.OUT || 'docs/team/reports/devtest-02/browsers');
mkdirSync(out, { recursive: true });
const engines: Record<string, { type: BrowserType; launch: Parameters<BrowserType['launch']>[0] }> = {
  chromium: { type: chromium, launch: { channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal'] } },
  webkit: { type: webkit, launch: { headless: true } },
  firefox: { type: firefox, launch: { headless: true } },
};
const wanted = process.argv.slice(2).filter((a) => a in engines);
const sizes = [
  { tag: '1440x900', width: 1440, height: 900, touch: false },
  { tag: '1024x768', width: 1024, height: 768, touch: true },
  { tag: '874x402', width: 874, height: 402, touch: true },
  { tag: '375x812', width: 375, height: 812, touch: true },
] as const;

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const IGNORED = /Failed to load resource|favicon|net::ERR_ABORTED|WebGL.*(performance|GPU stall)|GL_CLOSE_PATH|Alpha-premult/i;

async function open(browser: Browser, name: string, path: string, o: { width: number; height: number; touch: boolean; reduced?: boolean; saveData?: boolean }) {
  const context = await browser.newContext({
    viewport: { width: o.width, height: o.height }, deviceScaleFactor: 1, hasTouch: o.touch,
    ...(name === 'firefox' ? {} : { isMobile: o.touch }), reducedMotion: o.reduced ? 'reduce' : 'no-preference',
  });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  await context.addInitScript(() => localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } })));
  if (o.saveData) await context.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORED.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`); });
  await page.goto(new URL(path, base).toString());
  return { context, page, errors };
}

async function booted(page: Page) {
  return page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 }).then(() => page.evaluate(() => document.documentElement.dataset.boot), () => 'timeout');
}

/** Fraction of sampled canvas pixels that differ from the first one: a blank or failed WebGL canvas scores ~0. */
async function canvasVariety(page: Page) {
  const shot = await page.locator('#scene').screenshot({ type: 'png' }).catch(() => null);
  if (!shot) return 0;
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d')!; g.drawImage(img, 0, 0, 64, 64);
    const d = g.getImageData(0, 0, 64, 64).data; const colours = new Set<string>();
    for (let i = 0; i < d.length; i += 4) colours.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
    return colours.size;
  }, shot.toString('base64'));
}

async function run(name: string) {
  const browser = await engines[name].type.launch(engines[name].launch);
  const version = browser.version();
  console.log(`\n== ${name} ${version} ==`);
  try {
    for (const size of sizes) {
      const tag = `${name} ${size.tag}`;
      // ---- Sign-in page ----
      const l = await open(browser, name, '/login.html', size);
      await l.page.waitForLoadState('load');
      const login = await l.page.evaluate(() => ({ pw: !!document.querySelector('input[type=password]'), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
      check(`${tag} sign-in page renders a password field, no horizontal overflow`, login.pw && login.overflow <= 0, JSON.stringify(login));
      await l.page.screenshot({ path: resolve(out, `${name}-${size.tag}-01-sign-in.jpg`), quality: 75, type: 'jpeg' });
      check(`${tag} sign-in: no console errors`, l.errors.length === 0, l.errors.join(' | '));
      await l.context.close();

      // ---- Game: HUD, city, onboarding, Settings ----
      const g = await open(browser, name, '/', size);
      const boot = await booted(g.page);
      check(`${tag} game boots`, boot === 'ready' || boot === 'forced', String(boot));
      await g.page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 15_000 }).catch(() => {});
      await g.page.waitForTimeout(3000);
      if (size.width < size.height) {
        const hint = await g.page.evaluate(() => { const r = document.querySelector('.rotate-hint')?.getBoundingClientRect(); return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null; });
        check(`${tag} portrait shows the rotate screen`, !!hint && hint.w >= size.width - 1 && hint.h >= size.height - 1, JSON.stringify(hint));
        await g.page.screenshot({ path: resolve(out, `${name}-${size.tag}-02-rotate.jpg`), quality: 75, type: 'jpeg' });
        check(`${tag} game: no console errors`, g.errors.length === 0, g.errors.join(' | '));
        await g.context.close();
        continue;
      }
      const onboarding = await g.page.waitForSelector('.onboarding-modal', { timeout: 15_000 }).then(() => true, () => false);
      check(`${tag} onboarding is offered on a new install`, onboarding);
      if (onboarding) {
        const focusIn = await g.page.evaluate(() => !!document.activeElement?.closest('.onboarding-modal') && !document.activeElement?.closest('.ob-rail'));
        check(`${tag} onboarding: initial focus is inside the dialog, not on a step tab`, focusIn);
        let trapped = true;
        for (let i = 0; i < 12; i++) { await g.page.keyboard.press('Tab'); if (!(await g.page.evaluate(() => !!document.activeElement?.closest('.onboarding-modal')))) trapped = false; }
        check(`${tag} onboarding: Tab stays inside the dialog`, trapped);
        const ov = await g.page.evaluate(() => { const m = document.querySelector('.onboarding-modal') as HTMLElement; const r = m.getBoundingClientRect(); return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, right: Math.round(r.right - innerWidth), bottom: Math.round(r.bottom - innerHeight) }; });
        check(`${tag} onboarding fits the viewport`, ov.doc <= 0 && ov.right <= 0 && ov.bottom <= 0, JSON.stringify(ov));
        await g.page.screenshot({ path: resolve(out, `${name}-${size.tag}-02-onboarding.jpg`), quality: 75, type: 'jpeg' });
        await g.page.locator('.onboarding-modal').getByRole('button', { name: 'Close setup' }).click();
        await g.page.waitForTimeout(600);
      }
      await g.page.evaluate(() => document.querySelectorAll('#modal-root .backdrop').length && (document.querySelector('#modal-root .modal footer .btn.primary, #modal-root .modal .close') as HTMLElement | null)?.click());
      await g.page.keyboard.press('Escape');
      await g.page.waitForTimeout(500);
      const hud = await g.page.evaluate(() => ({ hud: !!document.querySelector('#hud, .hud, #topbar'), settings: !!document.getElementById('btn-settings'), canvas: !!document.querySelector('#scene') }));
      check(`${tag} HUD shows (top bar, Settings, city canvas)`, hud.settings && hud.canvas, JSON.stringify(hud));
      const variety = await canvasVariety(g.page);
      check(`${tag} the city renders (canvas is not blank)`, variety > 20, `${variety} colour buckets`);
      await g.page.screenshot({ path: resolve(out, `${name}-${size.tag}-03-city-hud.jpg`), quality: 75, type: 'jpeg' });
      await g.page.evaluate(() => (document.getElementById('btn-settings') as HTMLButtonElement | null)?.click());
      const settings = await g.page.waitForSelector('.settings-modal', { timeout: 10_000 }).then(() => true, () => false);
      check(`${tag} Settings opens`, settings);
      if (settings) {
        await g.page.waitForTimeout(500);
        const s = await g.page.evaluate(() => { const m = document.querySelector('.settings-modal') as HTMLElement; const r = m.getBoundingClientRect(); return { focus: !!document.activeElement?.closest('.settings-modal'), right: Math.round(r.right - innerWidth), doc: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
        check(`${tag} Settings: focus inside, fits the width`, s.focus && s.right <= 0 && s.doc <= 0, JSON.stringify(s));
        await g.page.screenshot({ path: resolve(out, `${name}-${size.tag}-04-settings.jpg`), quality: 75, type: 'jpeg' });
        await g.page.keyboard.press('Escape');
      }
      check(`${tag} game: no console errors`, g.errors.length === 0, g.errors.join(' | '));
      await g.context.close();

      // ---- Founder desk ----
      const c = await open(browser, name, '/consultancy.html', size);
      await c.page.waitForLoadState('load');
      await c.page.waitForTimeout(2500);
      const desk = await c.page.evaluate(() => ({ text: (document.body.innerText || '').trim().length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
      check(`${tag} founder desk renders without horizontal overflow`, desk.text > 40 && desk.overflow <= 0, JSON.stringify(desk));
      await c.page.screenshot({ path: resolve(out, `${name}-${size.tag}-05-founder-desk.jpg`), quality: 75, type: 'jpeg' });
      check(`${tag} founder desk: no console errors`, c.errors.length === 0, c.errors.join(' | '));
      await c.context.close();
    }

    // ---- Reduced motion + Save-Data at 1440x900 ----
    const r = await open(browser, name, '/', { width: 1440, height: 900, touch: false, reduced: true, saveData: true });
    const boot = await booted(r.page);
    await r.page.waitForSelector('.onboarding-modal', { timeout: 15_000 }).catch(() => {});
    await r.page.waitForTimeout(800);
    const rm = await r.page.evaluate(() => ({
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      saveData: (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true,
      anim: (() => { const e = document.querySelector('.ob-body > *'); return e ? getComputedStyle(e).animationName : 'n/a'; })(),
      videos: document.querySelectorAll('video').length,
    }));
    check(`${name} reduced motion + Save-Data: boots, dialog transitions off, no video`, (boot === 'ready' || boot === 'forced') && rm.reduced && rm.saveData && (rm.anim === 'none' || rm.anim === 'n/a') && rm.videos === 0, JSON.stringify({ boot, ...rm }));
    await r.page.screenshot({ path: resolve(out, `${name}-1440x900-06-reduced-savedata.jpg`), quality: 75, type: 'jpeg' });
    check(`${name} reduced motion + Save-Data: no console errors`, r.errors.length === 0, r.errors.join(' | '));
    await r.context.close();
    return version;
  } finally {
    await browser.close();
  }
}

const versions: Record<string, string> = {};
for (const name of wanted.length ? wanted : Object.keys(engines)) versions[name] = await run(name).catch((e) => { check(`${name} run completed`, false, String(e).slice(0, 300)); return 'error'; });
writeFileSync(resolve(out, `results-${Object.keys(versions).join('-')}.json`), JSON.stringify({ versions, results }, null, 2));
const failed = results.filter((x) => !x.ok);
console.log(`\nbrowser-matrix-check: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
