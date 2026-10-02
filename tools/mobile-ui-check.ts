/**
 * Mobile game shell acceptance against the isolated UI fixture only (never the protected 4610 session).
 *   npm run build:client && FIXTURE_PORT=4701 npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://localhost:4701/ npx tsx tools/mobile-ui-check.ts
 * Writes small screenshots to docs/team/reports/mobile/ and exits non-zero on any failed check.
 * MOBILE_UI_ONLY=lighting runs only the player-lighting (black silhouette) checks; =windows only the window checks.
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
  // tsx/esbuild wraps named functions in __name(); page.evaluate bodies need it defined in the page.
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
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

/**
 * With the menu open, nothing may be drawn over it: the backdrop must be the top element over every HUD
 * control, the close button must be hit-testable, and no bright overlay (e.g. a browser tap highlight,
 * which is not a DOM element) may be painted around the close button. The last check reads real pixels.
 */
async function menuCoverage(page: Page, label: string) {
  const hits = await page.evaluate(() => {
    const backdrop = document.querySelector('.backdrop');
    const close = document.querySelector<HTMLElement>('.game-menu header .close');
    const at = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    };
    const hud = ['#btn-menu', '#btn-management', '#hud .project', '#status-strip', '.radar-open'].map((s) => {
      const top = at(document.querySelector(s));
      return { s, covered: !!top && !!backdrop?.contains(top) };
    });
    const topAtClose = at(close);
    return { hud, closeOk: !!close && !!topAtClose && close.contains(topAtClose) };
  });
  check(`${label} backdrop covers the HUD under the menu`, hits.hud.every((h) => h.covered), hits.hud.filter((h) => !h.covered).map((h) => h.s).join(', '));
  check(`${label} menu close button is the top element at its position`, hits.closeOk);
  const box = await page.locator('.game-menu header .close').boundingBox();
  if (!box) return check(`${label} no overlay painted near the close button`, false, 'close button missing');
  const clip = { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 30), width: box.width + 80, height: box.height + 50 };
  const png = (await page.screenshot({ clip, animations: 'disabled' })).toString('base64');
  const bright = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    // The menu surface is dark (#15232a); a saturated teal/blue patch here is paint that does not belong to it.
    for (let i = 0; i < px.length; i += 4) if (px[i + 2] > 110 && px[i + 1] > 90 && px[i + 2] - px[i] > 50) n++;
    return n / (px.length / 4);
  }, png);
  check(`${label} no overlay painted near the close button`, bright < 0.02, `${(bright * 100).toFixed(1)}% teal pixels`);
}

/** Visible dialogs whose surface is light (the old cream theme); dark = background luminance under 0.2. */
async function lightDialogs(page: Page): Promise<string[]> {
  return page.evaluate(`(() => {
    const lum = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);
      if (a < 0.5) return null; const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    return [...document.querySelectorAll('#modal-root .modal')].filter((m) => m.getClientRects().length).filter((m) => {
      const cs = getComputedStyle(m); const head = m.querySelector('header');
      return [cs.backgroundImage, cs.backgroundColor, head && getComputedStyle(head).backgroundColor].filter(Boolean).map(lum).some((v) => v !== null && v > 0.2);
    }).map((m) => m.getAttribute('aria-label') || m.className);
  })()`);
}
const textFocused = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLInputElement | null;
  return !!a && (a.tagName === 'TEXTAREA' || a.isContentEditable || (a.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'submit'].includes(a.type)));
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
      await menuCoverage(page, label);
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
      // Windows of the first minutes use the dark design, and none opens the keyboard by itself on touch.
      await page.evaluate(() => document.getElementById('btn-settings')?.click());
      await page.waitForSelector('#modal-root .settings-modal');
      const lightSettings = await lightDialogs(page);
      check(`${label} settings window uses the dark design`, !lightSettings.length, lightSettings.join(', '));
      await page.locator('.settings-modal .btn', { hasText: 'Change your look' }).click();
      await page.waitForSelector('#modal-root .charsel');
      await page.waitForTimeout(250);
      const lightFounder = await lightDialogs(page);
      check(`${label} founder window uses the dark design`, !lightFounder.length, lightFounder.join(', '));
      check(`${label} founder window opens no keyboard (no auto-focused text field on touch)`, !(await textFocused(page)));
      await page.keyboard.press('Escape');
      await touchTap(page, center(parts.menu!));
      await page.locator('.game-menu .menu-item', { hasText: 'Controls' }).click();
      await page.waitForTimeout(200);
      const lightHelp = await lightDialogs(page);
      check(`${label} controls help uses the dark design`, !lightHelp.length, lightHelp.join(', '));
      for (let i = 0; i < 3 && (await page.locator('#modal-root .modal').count()); i++) await page.keyboard.press('Escape');
    }
    check(`${label} no console/page errors`, !errors.length, errors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
  }
}

/**
 * Every in-game window on a landscape phone with a notch / Dynamic Island on one side (real env(safe-area-inset-*)
 * values through CDP Emulation.setSafeAreaInsetsOverride): the window sits inside the safe area and is centred in it,
 * big windows use the full safe height, header, close button and footer stay on screen, the close button is a
 * hit-testable >= 44px target, and nothing overflows sideways.
 */
type Insets = { top: number; right: number; bottom: number; left: number };
type WinSpec = { name: string; open: (page: Page) => Promise<unknown>; big?: boolean; shot?: boolean };
const WINDOWS: WinSpec[] = [
  { name: 'menu', shot: true, open: (p) => p.evaluate(() => document.getElementById('btn-menu')!.click()) },
  { name: 'help', open: (p) => p.evaluate(() => document.getElementById('btn-help')!.click()) },
  { name: 'settings', shot: true, open: (p) => p.evaluate(() => document.getElementById('btn-settings')!.click()) },
  { name: 'management', shot: true, open: (p) => p.evaluate(() => document.getElementById('btn-management')!.click()), big: true },
  { name: 'issues', shot: true, open: (p) => p.evaluate(() => document.getElementById('btn-issues')!.click()), big: true },
  { name: 'pulls', open: (p) => p.evaluate(() => document.getElementById('btn-pulls')!.click()), big: true },
  { name: 'queue', shot: true, open: (p) => p.evaluate(() => document.getElementById('btn-queue')!.click()) },
  {
    name: 'terminal',
    big: true,
    shot: true,
    open: async (p) => {
      await p.evaluate(() => document.getElementById('btn-queue')!.click());
      await p.locator('#modal-root .modal button', { hasText: 'Terminal' }).first().click();
      await p.waitForSelector('#modal-root .modal.term');
    },
  },
  {
    name: 'changes',
    big: true,
    shot: true,
    open: async (p) => {
      await p.evaluate(() => document.getElementById('btn-queue')!.click());
      await p.locator('#modal-root .modal button', { hasText: 'Terminal' }).first().click();
      await p.locator('#modal-root .modal.term button', { hasText: 'Changes' }).click();
      await p.waitForSelector('#modal-root .modal.desk-changes');
    },
  },
  { name: 'team', open: (p) => p.evaluate(() => document.getElementById('btn-team')!.click()) },
  { name: 'upgrade', open: (p) => p.evaluate(() => document.getElementById('btn-upgrade')!.click()) },
  { name: 'services', open: (p) => p.evaluate(() => document.getElementById('btn-services')!.click()) },
  { name: 'workers', open: (p) => p.evaluate(() => (document.querySelector('#status-strip .status-workforce') as HTMLElement).click()) },
];

async function topWindow(page: Page) {
  return page.evaluate(() => {
    const backs = [...document.querySelectorAll('#modal-root .backdrop')];
    const modal = backs[backs.length - 1]?.querySelector<HTMLElement>(':scope > .modal');
    if (!modal) return null;
    const box = (el: Element | null | undefined) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    };
    const close = modal.querySelector<HTMLElement>(':scope > header .close, .close');
    const header = modal.querySelector<HTMLElement>(':scope > header');
    const footer = modal.querySelector<HTMLElement>(':scope > footer');
    let closeHit = false;
    if (close) {
      const r = close.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      closeHit = !!top && close.contains(top);
    }
    const clipped = [header, footer].filter((el): el is HTMLElement => !!el && el.scrollWidth > el.clientWidth + 1).map((el) => el.tagName.toLowerCase());
    // Header items must not be drawn over each other (e.g. a title squeezed under the close button).
    const crowded: string[] = [];
    const items = header ? [...header.children].filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden') : [];
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i].getBoundingClientRect(), b = items[j].getBoundingClientRect();
      if (a.width && b.width && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)
        crowded.push(`${items[i].className || items[i].tagName}/${items[j].className || items[j].tagName}`);
    }
    // ...and the title keeps room to be read (not squeezed to nothing beside the other header items).
    const title = header?.querySelector('h2');
    if (title) {
      const w = title.getBoundingClientRect().width;
      if (w < Math.min(title.scrollWidth, 80) - 1) crowded.push(`title squeezed to ${w.toFixed(0)}px`);
    }
    return {
      cls: modal.className,
      modal: box(modal)!,
      close: box(close),
      header: box(header),
      footer: box(footer),
      closeHit,
      clipped,
      crowded,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
}

async function windowsCheck(browser: Browser, width: number, height: number, insets: Insets, side: string) {
  const label = `${width}x${height} ${side}`;
  const winOut = resolve(import.meta.dirname, '../docs/team/reports/phone-windows');
  mkdirSync(winOut, { recursive: true });
  const desktop = side === 'desktop';
  const phone = height <= 500;
  const { context, page, errors } = await open(browser, { width, height, touch: !desktop });
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride' as any, { insets });
    await page.waitForTimeout(100);
    const seen = await page.evaluate(() => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
      document.body.append(d);
      const c = getComputedStyle(d);
      const v = [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft].map((s) => parseFloat(s));
      d.remove();
      return v;
    });
    check(`${label} page sees the emulated safe-area insets`, seen.join() === [insets.top, insets.right, insets.bottom, insets.left].join(), seen.join('/'));
    const safe = { x: insets.left, y: insets.top, r: width - insets.right, b: height - insets.bottom };
    const inSafe = (r: { x: number; y: number; w: number; h: number }) => r.x >= safe.x - 0.5 && r.y >= safe.y - 0.5 && r.x + r.w <= safe.r + 0.5 && r.y + r.h <= safe.b + 0.5;
    for (const win of WINDOWS) {
      await win.open(page);
      await page.waitForSelector('#modal-root .backdrop > .modal', { timeout: 5000 }).catch(() => null);
      await page.waitForTimeout(260);
      const t = await topWindow(page);
      if (!t) {
        check(`${label} ${win.name}: window opens`, false);
        continue;
      }
      const m = t.modal;
      const fmt = (r: { x: number; y: number; w: number; h: number }) => `${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.w.toFixed(0)}x${r.h.toFixed(0)}`;
      const problems: string[] = [];
      if (!inSafe(m)) problems.push(`window ${fmt(m)} outside safe ${safe.x},${safe.y}-${safe.r},${safe.b}`);
      const off = m.x + m.w / 2 - (safe.x + safe.r) / 2;
      if (Math.abs(off) > 1.5) problems.push(`off-centre by ${off.toFixed(1)}px`);
      if (phone && win.big && m.h < safe.b - safe.y - 2 * 16 - 1) problems.push(`big window only ${m.h.toFixed(0)}px of ${safe.b - safe.y}px safe height`);
      if (!t.close) problems.push('no close button');
      else {
        if (!inSafe(t.close) || t.close.x + t.close.w > m.x + m.w + 0.5) problems.push(`close ${fmt(t.close)} not inside the window/safe area`);
        if (!desktop && (t.close.w < 44 - 0.5 || t.close.h < 44 - 0.5)) problems.push(`close ${t.close.w.toFixed(0)}x${t.close.h.toFixed(0)} < 44px`);
        if (!t.closeHit) problems.push('close button covered');
      }
      if (t.header && !inSafe(t.header)) problems.push(`header ${fmt(t.header)} off screen`);
      if (t.footer && !inSafe(t.footer)) problems.push(`footer ${fmt(t.footer)} off screen`);
      if (t.clipped.length) problems.push(`${t.clipped.join('+')} overflows sideways`);
      if (t.crowded.length) problems.push(`header items overlap: ${t.crowded.join(', ')}`);
      if (t.pageOverflow > 0) problems.push(`page scrollWidth +${t.pageOverflow}`);
      check(`${label} ${win.name}: inside safe area, centred, close/header/footer reachable`, !problems.length, problems.join('; ') || fmt(m));
      // Screenshots for the report: island on the left at 667 and 874, plus tablet and desktop.
      if (win.shot && ['left', 'tablet', 'desktop'].includes(side) && width !== 812)
        await page.screenshot({ animations: 'disabled', type: 'jpeg', quality: 72, path: resolve(winOut, `${win.name}-${width}x${height}-${side}.jpg`) });
      // Close by tapping the close button where it is drawn, as a finger would.
      const before = await page.locator('#modal-root .backdrop').count();
      if (t.close) await (desktop ? page.mouse.click(t.close.x + t.close.w / 2, t.close.y + t.close.h / 2) : touchTap(page, center({ ...t.close, name: 'close' })));
      await page.waitForTimeout(150);
      const after = await page.locator('#modal-root .backdrop').count();
      if (t.close) check(`${label} ${win.name}: tapping the close button closes it`, after < before || after === 0, `${before} -> ${after} windows`);
      for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(120);
      }
    }
    check(`${label} no console/page errors`, !errors.length, errors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
  }
}

/**
 * The player's torso on screen: mean luminance (0..1) and the share of near-black pixels, sampled from a real
 * screenshot (the WebGL buffer is not preserved). A black silhouette (ios-04 in cloud-mode) reads ~0.03 / ~100%.
 */
async function playerPixels(page: Page) {
  const box = await page.evaluate(() => {
    const o = (window as unknown as { __office: { me: { root: { position: { clone(): { y: number; project(c: unknown): { x: number; y: number } } } } }; camera: unknown } }).__office;
    const at = (dy: number) => { const p = o.me.root.position.clone(); p.y += dy; const s = p.project(o.camera); return { x: (s.x + 1) / 2 * innerWidth, y: (1 - s.y) / 2 * innerHeight }; };
    const chest = at(1.3), hips = at(0.95);
    const h = Math.max(6, hips.y - chest.y), w = Math.max(4, h * 0.45);
    return { x: Math.round(chest.x - w / 2), y: Math.round(chest.y), width: Math.round(w), height: Math.round(h) };
  });
  const png = (await page.screenshot({ clip: box, animations: 'disabled' })).toString('base64');
  const stats = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, dark = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      sum += l; n++; if (l < 0.08) dark++;
    }
    return { mean: sum / n, dark: dark / n };
  }, png);
  return { ...stats, box };
}
const litPlayer = (s: { mean: number; dark: number }) => s.mean > 0.15 && s.dark < 0.4;
const fmt = (s: { mean: number; dark: number }) => `mean luminance ${s.mean.toFixed(2)}, near-black ${(s.dark * 100).toFixed(0)}%`;

/**
 * Black-silhouette regression (followups-1). Scenarios: a normal load; the character's embedded textures and the
 * sky lighting failing once and recovering (the splash must wait and hand over "ready", never early); and both
 * failing for good, where the player has to choose "Enter anyway" and the body must still not be black.
 */
async function lightingCheck(browser: Browser, scenario: 'normal' | 'transient' | 'permanent') {
  const label = `lighting ${scenario}`;
  const context = await browser.newContext({ viewport: { width: 874, height: 402 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  // The CEO in the taupe skirt suit (style 5): the chest sample below measures lighting, and a black or navy suit
  // is legitimately near-black there even when perfectly lit.
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 5 } }));
    localStorage.setItem('agent-empire.execution.offered', '1');
  });
  // GLTFLoader decodes embedded images with createImageBitmap; failing it reproduces the iOS texture failure.
  if (scenario !== 'normal') await context.addInitScript((failures: number) => {
    const real = window.createImageBitmap.bind(window);
    let n = 0;
    (window as unknown as { createImageBitmap: unknown }).createImageBitmap = (...a: Parameters<typeof createImageBitmap>) => (n++ < failures ? Promise.reject(new Error('decode failed (test)')) : real(...a));
  }, scenario === 'permanent' ? 1e9 : 13);
  const page = await context.newPage();
  let skyRequests = 0;
  if (scenario !== 'normal') await page.route('**/coastal-sky.hdr', (r) => (scenario === 'permanent' || skyRequests++ === 0 ? r.abort() : r.continue()));
  try {
    const t0 = Date.now();
    await page.goto(base);
    if (scenario === 'permanent') {
      await page.waitForSelector('.splash-enter', { timeout: 60_000 });
      const early = await page.evaluate(() => ({ boot: document.documentElement.dataset.boot, splash: !!document.getElementById('splash'), warn: document.querySelector('.splash-warn')?.textContent ?? '' }));
      check(`${label}: splash stays up on failure and offers Enter anyway`, early.boot === 'loading' && early.splash, early.warn);
      check(`${label}: failure names the character textures`, /character textures/.test(early.warn), early.warn);
      await page.screenshot({ animations: 'disabled', path: resolve(lightOut, 'permanent-splash-874x402.png') });
      await page.locator('.splash-enter').click();
    }
    await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
    const boot = await page.evaluate(() => document.documentElement.dataset.boot);
    const state = () => page.evaluate(() => {
      const o = (window as unknown as { __office: { me: { materialsReady: boolean }; scene: { environment: unknown } } }).__office;
      return { materials: o.me.materialsReady, env: !!o.scene.environment, pending: (document.getElementById('scene') as HTMLCanvasElement).dataset.pending ?? '' };
    });
    const atHandover = await state();
    if (scenario === 'permanent') check(`${label}: entered only by the explicit choice`, boot === 'forced');
    else check(`${label}: splash hands over ready with textured player and sky lighting`, boot === 'ready' && atHandover.materials && atHandover.env, `${boot} ${JSON.stringify(atHandover)} after ${Date.now() - t0} ms`);
    for (let i = 0; i < 3 && (await page.locator('#modal-root .backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    await page.waitForTimeout(800);
    const px = await playerPixels(page);
    check(`${label}: player is lit, not a black silhouette`, litPlayer(px), fmt(px));
    if (scenario === 'transient') check(`${label}: sky was retried after the failure`, skyRequests >= 2, `${skyRequests} requests`);
    if (scenario === 'permanent') check(`${label}: still reports what is missing`, /character/.test(atHandover.pending) && /sky/.test(atHandover.pending), atHandover.pending);
    await page.screenshot({ animations: 'disabled', path: resolve(lightOut, `${scenario}-874x402.png`) });
  } finally {
    await context.close();
  }
}
const lightOut = resolve(import.meta.dirname, '../docs/team/reports/followups-1');
mkdirSync(lightOut, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  if (!process.env.MOBILE_UI_ONLY || process.env.MOBILE_UI_ONLY === 'lighting') {
    for (const scenario of ['normal', 'transient', 'permanent'] as const) await lightingCheck(browser, scenario);
  }
  if (!process.env.MOBILE_UI_ONLY) {
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
    await menuCoverage(page, '1440x900');
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
    // Desktop keeps its autofocus: the founder window starts in the name field.
    await page.locator('#btn-settings').click();
    await page.locator('.settings-modal .btn', { hasText: 'Change your look' }).click();
    await page.waitForSelector('#modal-root .charsel');
    await page.waitForTimeout(250);
    check('1440x900 founder window autofocuses the name field on desktop', (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Your name');
    const lightDesk = await lightDialogs(page);
    check('1440x900 founder window uses the dark design', !lightDesk.length, lightDesk.join(', '));
    await page.keyboard.press('Escape');
    check('1440x900 no console/page errors', !errors.length, errors.slice(0, 3).join(' | '));
    await context.close();
  }

  // First-launch setup, as a static copy of the game with no server behind it shows it (whoami answers 404):
  // fits every landscape phone, keeps touch-sized targets, no horizontal overflow, honours reduced motion.
  for (const [w, hgt] of [[667, 375], [874, 402], [932, 430]] as const) {
    const context = await browser.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, reducedMotion: w === 667 ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/whoami', (r) => r.fulfill({ status: 404, body: 'static copy' }));
    await page.goto(base);
    await page.waitForSelector('.su-hero-title', { timeout: 20_000 });
    const tag = `${w}x${hgt} setup`;
    const start = await rect(page, '.su-hero .su-primary');
    check(`${tag}: start button on screen and touch-sized`, !!start && inside(start, w, hgt) && start.h >= 44);
    check(`${tag}: game bundle not loaded before a choice`, !(await page.evaluate(() => performance.getEntriesByType('resource').some((e) => /three\.module/.test(e.name)))));
    if (w === 667) check(`${tag}: reduced motion stops the title animation`, (await page.evaluate(() => getComputedStyle(document.querySelector('.su-letter')!).animationName)) === 'none');
    await page.tap('.su-hero .su-primary');
    await page.waitForTimeout(400);
    const cards = [await rect(page, '.su-card-cloud', 'cloud card'), await rect(page, '.su-card-server', 'server card')];
    // Fully visible means inside the panel's scroll area (not hidden under its footer), not merely inside the viewport.
    const area = await rect(page, '.su-panel:not(.su-leave) .su-body', 'body');
    check(`${tag}: both mode cards fully visible without scrolling`, !!area && cards.every((c) => !!c && inside(c, w, hgt) && c.y >= area.y - 0.5 && c.y + c.h <= area.y + area.h + 0.5),
      cards.map((c) => c && `${c.name} bottom ${(c.y + c.h).toFixed(0)}`).join(', ') + (area ? `, visible to ${(area.y + area.h).toFixed(0)}` : ''));
    const back = await rect(page, '.su-panel:not(.su-leave) .su-back', 'back');
    check(`${tag}: Back reachable and touch-sized`, !!back && inside(back, w, hgt) && back.h >= 44);
    await page.tap('.su-card-server');
    await page.waitForTimeout(400);
    const next = await rect(page, '.su-panel:not(.su-leave) .su-foot .su-primary', 'continue');
    check(`${tag}: server address and Continue on screen`, !!(await rect(page, '#su-address')) && !!next && inside(next, w, hgt));
    check(`${tag}: no horizontal overflow`, (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
    check(`${tag}: no page errors`, !errors.length, errors.slice(0, 3).join(' | '));
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
  }

  // In-game windows against the notch / Dynamic Island on either side (phone-windows report).
  if (!process.env.MOBILE_UI_ONLY || process.env.MOBILE_UI_ONLY === 'windows') {
  for (const [w, hgt, inset, bottom] of [[667, 375, 44, 21], [812, 375, 44, 21], [874, 402, 62, 20]] as const) {
    await windowsCheck(browser, w, hgt, { top: 0, right: 0, bottom, left: inset }, 'left');
    await windowsCheck(browser, w, hgt, { top: 0, right: inset, bottom, left: 0 }, 'right');
  }
  await windowsCheck(browser, 874, 402, { top: 0, right: 62, bottom: 20, left: 62 }, 'both');
  await windowsCheck(browser, 1024, 768, { top: 0, right: 0, bottom: 0, left: 0 }, 'tablet');
  await windowsCheck(browser, 1440, 900, { top: 0, right: 0, bottom: 0, left: 0 }, 'desktop');
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
