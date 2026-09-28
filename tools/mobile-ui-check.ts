/**
 * Mobile game shell acceptance against the isolated UI fixture only (never the protected 4610 session).
 *   npm run build:client && FIXTURE_PORT=4701 npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://localhost:4701/ npx tsx tools/mobile-ui-check.ts
 * Writes small screenshots to docs/team/reports/mobile/ and exits non-zero on any failed check.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:4701/';
if (/:4610\b/.test(base)) throw new Error('Refusing the protected 4610 session; use the UI fixture.');
const out = resolve(import.meta.dirname, '../docs/team/reports/mobile');
mkdirSync(out, { recursive: true });

type Rect = { x: number; y: number; w: number; h: number; name: string };
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function open(browser: Browser, opts: { width: number; height: number; touch: boolean; reduced?: boolean }) {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: 1,
    isMobile: opts.touch,
    hasTouch: opts.touch,
    reducedMotion: opts.reduced ? 'reduce' : 'no-preference',
  });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }));
    localStorage.setItem('agent-empire.execution.offered', '1');
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // The fixture serves no /api/* besides whoami; those 404s are fixture limits, reported but not failures.
  const fixture404 = new Set<string>();
  page.on('response', (r) => {
    if (r.status() === 404) (new URL(r.url()).pathname.startsWith('/api/') ? fixture404.add(new URL(r.url()).pathname) : errors.push(`404 ${r.url()}`));
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !(m.text().includes('404') && m.text().startsWith('Failed to load resource'))) errors.push(`console: ${m.text()}`);
  });
  page.on('close', () => fixture404.size && console.log(`      (fixture has no ${[...fixture404].join(', ')})`));
  await page.goto(base);
  const splashAtStart = await page.evaluate(() => {
    const s = document.getElementById('splash');
    return { present: !!s, stage: s?.querySelector('.splash-stage')?.textContent ?? '', boot: document.documentElement.dataset.boot ?? '' };
  });
  if (splashAtStart.present && opts.width === 874) await page.screenshot({ animations: 'disabled', path: resolve(out, `splash-${opts.width}x${opts.height}.png`) });
  await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
  await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 5_000 });
  // Dismiss anything the fixture opens on arrival (e.g. an execution offer) so the HUD is inspectable.
  for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  return { context, page, errors, splashAtStart };
}

async function rect(page: Page, selector: string, name = selector): Promise<Rect | null> {
  return page.evaluate(
    ([sel, label]) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).display === 'none') return null;
      return { x: r.left, y: r.top, w: r.width, h: r.height, name: label };
    },
    [selector, name] as const,
  );
}
const inside = (r: Rect, w: number, h: number) => r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= w + 0.5 && r.y + r.h <= h + 0.5;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, holdMs: number) {
  const cdp = await page.context().newCDPSession(page);
  const point = (p: { x: number; y: number }) => [{ x: p.x, y: p.y, id: 7, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }) });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(holdMs);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
async function touchTap(page: Page, at: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y, id: 9 }] });
  await page.waitForTimeout(40);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const player = (page: Page) =>
  page.evaluate(() => {
    const p = (window as any).__office.player;
    return { x: p.pos.x, y: p.pos.y, z: p.pos.z, grounded: p.grounded, yaw: p.camYaw, speed: p.speed, view: p.view };
  });

async function landscape(browser: Browser, width: number, height: number, full: boolean) {
  const label = `${width}x${height}`;
  const { context, page, errors, splashAtStart } = await open(browser, { width, height, touch: true });
  try {
    check(`${label} splash shown before assets`, splashAtStart.present, `stage "${splashAtStart.stage}"`);
    check(`${label} touch mode active`, await page.evaluate(() => document.documentElement.classList.contains('ae-touch')));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(`${label} no horizontal overflow`, overflow <= 0, `scrollWidth-innerWidth=${overflow}`);
    await page.evaluate(() => (window as any).__office.player.setView('third'));
    const parts = {
      stick: await rect(page, '.touch-stick-base', 'joystick'),
      jump: await rect(page, '.touch-jump', 'jump'),
      use: await rect(page, '.touch-use', 'use'),
      view: await rect(page, '.touch-view', 'view'),
      radar: await rect(page, '.radar', 'minimap'),
      project: await rect(page, '#hud .project', 'project'),
      status: await rect(page, '#status-strip', 'status strip'),
      controls: await rect(page, '#hud .topbar .controls', 'top-bar buttons'),
      menu: await rect(page, '#btn-menu', 'menu button'),
    };
    const shown = Object.values(parts).filter((r): r is Rect => !!r);
    check(`${label} all controls rendered`, shown.length === Object.keys(parts).length, Object.entries(parts).filter(([, r]) => !r).map(([k]) => k).join(', '));
    const outside = shown.filter((r) => !inside(r, width, height)).map((r) => r.name);
    check(`${label} controls inside viewport`, !outside.length, outside.join(', '));
    const clashes: string[] = [];
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i], b = shown[j];
      if ((a.name === 'top-bar buttons' && b.name === 'menu button') || (b.name === 'top-bar buttons' && a.name === 'menu button')) continue;
      if (overlap(a, b)) clashes.push(`${a.name}/${b.name}`);
    }
    check(`${label} no overlapping controls/HUD`, !clashes.length, clashes.join(', '));
    const topRow = [parts.project, parts.status, parts.controls].filter((r): r is Rect => !!r);
    const rowSpread = Math.max(...topRow.map((r) => r.y + r.h)) - Math.min(...topRow.map((r) => r.y));
    check(`${label} top bar is one row`, rowSpread <= 50, `height ${rowSpread.toFixed(0)}px`);
    const buttonSizes = [parts.jump, parts.use, parts.view, parts.menu].filter((r): r is Rect => !!r).map((r) => Math.min(r.w, r.h));
    check(`${label} touch targets >= 36px`, Math.min(...buttonSizes) >= 36, buttonSizes.map((n) => n.toFixed(0)).join('/'));
    await page.screenshot({ animations: 'disabled', path: resolve(out,`landscape-${label}.png`) });

    if (full && parts.stick && parts.jump) {
      // Joystick: walk, then run at full deflection.
      const before = await player(page);
      const c = center(parts.stick);
      await touchDrag(page, c, { x: c.x, y: c.y - 30 }, 700);
      const walked = await player(page);
      const dist = Math.hypot(walked.x - before.x, walked.z - before.z);
      check(`${label} joystick walk moves the player`, dist > 0.3, `${dist.toFixed(2)} m`);
      await page.waitForTimeout(400);
      const runStart = await player(page);
      let runState = '';
      const cdpDrag = touchDrag(page, c, { x: c.x + 5, y: c.y - 90 }, 900);
      await page.waitForTimeout(500);
      runState = (await page.evaluate(() => document.documentElement.dataset.stick)) ?? '';
      await cdpDrag;
      const ran = await player(page);
      check(`${label} full deflection runs`, runState === 'run', `stick=${runState}, ${Math.hypot(ran.x - runStart.x, ran.z - runStart.z).toFixed(2)} m`);
      check(`${label} joystick release stops`, (await page.evaluate(() => document.documentElement.dataset.stick)) === 'rest');
      // Jump: a short tap is held long enough to register.
      await page.waitForTimeout(500);
      await touchTap(page, center(parts.jump));
      const airborne = await page
        .waitForFunction(() => { const p = (window as any).__office.player; return !p.grounded && p.pos.y > 0.05; }, null, { timeout: 1500 })
        .then(() => true, () => false);
      check(`${label} Jump makes the player airborne`, airborne);
      // Camera orbit by dragging the right half of the scene.
      await page.waitForTimeout(900);
      const yaw0 = (await player(page)).yaw;
      await touchDrag(page, { x: width * 0.62, y: height * 0.45 }, { x: width * 0.42 + 0, y: height * 0.45 }, 50);
      const yaw1 = (await player(page)).yaw;
      check(`${label} right-side drag orbits the camera`, Math.abs(yaw1 - yaw0) > 0.3, `Δyaw ${(yaw1 - yaw0).toFixed(2)} rad`);
      // Menu opens from the touch button, hides controls, and closes with Escape.
      await touchTap(page, center(parts.menu!));
      const menuOpen = await page.getByRole('dialog', { name: 'Game menu' }).isVisible().catch(() => false);
      check(`${label} menu opens from Menu button`, menuOpen);
      check(`${label} touch controls hidden while menu open`, !(await rect(page, '.touch-jump')));
      const labels = await page.locator('.game-menu .menu-item strong').allTextContents();
      check(`${label} menu entries`, ['Resume', 'Map', 'Settings', 'Controls', 'Sign out'].every((l) => labels.includes(l)), labels.join(', '));
      const tools = await page.locator('.menu-tools .menu-item').count();
      check(`${label} hidden top-bar tools reachable from menu`, tools >= 5, `${tools} tools`);
      await page.screenshot({ animations: 'disabled', path: resolve(out,`menu-${label}.png`) });
      await page.keyboard.press('Escape');
      check(`${label} menu closes`, !(await page.getByRole('dialog', { name: 'Game menu' }).count()));
      check(`${label} controls return after menu`, !!(await rect(page, '.touch-jump')));
      // Chat from the menu hides controls while typing.
      await touchTap(page, center(parts.menu!));
      await page.locator('.game-menu .menu-item', { hasText: 'Chat' }).click();
      await page.waitForTimeout(100);
      check(`${label} controls hidden while typing chat`, !(await rect(page, '.touch-jump')) && (await page.evaluate(() => document.activeElement?.id)) === 'chat-input');
      await page.screenshot({ animations: 'disabled', path: resolve(out,`chat-${label}.png`) });
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      await page.waitForTimeout(50);
      check(`${label} chat panel closes on blur`, !(await rect(page, '#chat')));
    }
    check(`${label} no console/page errors`, !errors.length, errors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  await landscape(browser, 667, 375, true);
  await landscape(browser, 812, 375, false);
  await landscape(browser, 874, 402, true);
  await landscape(browser, 932, 430, false);
  await landscape(browser, 1024, 768, true);

  // Portrait phone: rotate prompt, with reduced motion honoured.
  {
    const { context, page, errors } = await open(browser, { width: 375, height: 812, touch: true, reduced: true });
    const hint = await rect(page, '.rotate-hint');
    check('375x812 portrait asks to rotate', !!hint && hint.w >= 375 && hint.h >= 812);
    const anim = await page.evaluate(() => getComputedStyle(document.querySelector('.rotate-icon')!).animationName);
    check('375x812 reduced motion stops rotate animation', anim === 'none', `animation-name ${anim}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check('375x812 no horizontal overflow', overflow <= 0);
    await page.screenshot({ animations: 'disabled', path: resolve(out,'portrait-375x812.png') });
    check('375x812 no console/page errors', !errors.length, errors.slice(0, 3).join(' | '));
    await context.close();
  }

  // Desktop: unchanged apart from the Menu button; Backquote opens the menu; Esc closes it.
  {
    const { context, page, errors } = await open(browser, { width: 1440, height: 900, touch: false });
    check('1440x900 touch mode off', !(await page.evaluate(() => document.documentElement.classList.contains('ae-touch'))));
    check('1440x900 touch controls hidden', !(await rect(page, '.touch-ui')) && !(await rect(page, '.touch-jump')));
    check('1440x900 side panel and chat still shown', !!(await rect(page, '#hud .side')) && !!(await rect(page, '#chat')));
    check('1440x900 minimap bottom-left as before', ((await rect(page, '.radar'))?.x ?? 999) < 40);
    check('1440x900 settings/help buttons still in top bar', !!(await rect(page, '#btn-settings')) && !!(await rect(page, '#btn-help')) && !!(await rect(page, '#btn-menu')));
    await page.locator('#scene').focus();
    await page.keyboard.press('Backquote');
    check('1440x900 Backquote opens menu', await page.getByRole('dialog', { name: 'Game menu' }).isVisible().catch(() => false));
    const tools = await page.locator('.menu-tools').count();
    check('1440x900 menu lists no duplicate tools on desktop', tools === 0);
    await page.screenshot({ animations: 'disabled', path: resolve(out,'desktop-menu-1440x900.png') });
    await page.keyboard.press('Escape');
    check('1440x900 Esc closes menu', !(await page.getByRole('dialog', { name: 'Game menu' }).count()));
    const before = await player(page);
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(500);
    await page.keyboard.up('ArrowUp');
    const after = await player(page);
    check('1440x900 arrow keys still move', Math.hypot(after.x - before.x, after.z - before.z) > 0.3);
    await page.screenshot({ animations: 'disabled', path: resolve(out,'desktop-1440x900.png') });
    check('1440x900 no console/page errors', !errors.length, errors.slice(0, 3).join(' | '));
    await context.close();
  }

  // Sign-in page: rebrand, ids kept, fits a landscape phone.
  {
    const context = await browser.newContext({ viewport: { width: 667, height: 375 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(new URL('/login.html', base).href);
    check('login keeps #password/#submit', (await page.locator('#password').count()) === 1 && (await page.locator('#submit').count()) === 1);
    check('login is Agent Empire branded', (await page.title()).includes('Agent Empire') && !(await page.content()).includes('Knock knock'));
    const submit = await rect(page, '#submit');
    check('login submit reachable at 667x375', !!submit, submit ? `bottom ${(submit.y + submit.h).toFixed(0)}` : '');
    await page.screenshot({ animations: 'disabled', path: resolve(out,'login-667x375.png') });
    await context.close();
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
