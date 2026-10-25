/**
 * FREE-09 (CITY-05/07) acceptance against the isolated UI fixture only (never the protected 4610 session).
 *   npm run build && FIXTURE_PORT=4937 npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://localhost:4937/ npx tsx tools/city-ui-check.ts
 * Screenshots go to docs/team/reports/free-09/; exits non-zero on any failed check.
 * CITY_UI_ONLY=perf measures frame time only (PERF_LABEL names the run, e.g. before/after) at the same viewpoints,
 * which also works against an older build's fixture that has no districts.
 * CITY-06/08: CITY_UI_ONLY=rides runs only the driving/flying section; its screenshots and perf JSON go to
 * docs/team/reports/city-06-08/ (PERF_OUT=city-06-08 sends perf runs there too).
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:4937/';
if (/:4610\b/.test(base)) throw new Error('Refusing the protected 4610 session; use the UI fixture.');
const out = resolve(import.meta.dirname, '../docs/team/reports/free-09');
mkdirSync(out, { recursive: true });
const rideOut = resolve(import.meta.dirname, '../docs/team/reports/city-06-08');
mkdirSync(rideOut, { recursive: true });
// CHAR-01/02: PERF_OUT=char-01 (or char-02) sends perf runs to docs/team/reports/char-01/ (char-02/).
const perfOut = process.env.PERF_OUT === 'city-06-08' ? rideOut : /^char-0[12]$/.test(process.env.PERF_OUT ?? '') ? resolve(import.meta.dirname, `../docs/team/reports/${process.env.PERF_OUT}`) : out;
const only = process.env.CITY_UI_ONLY;

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

interface Opened { context: BrowserContext; page: Page; errors: string[]; urls: string[] }
async function open(browser: Browser, opts: { width: number; height: number; touch: boolean; saveData?: boolean; reducedMotion?: boolean }): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1, isMobile: opts.touch, hasTouch: opts.touch, reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference' });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }));
    localStorage.setItem('agent-empire.execution.offered', '1');
  });
  if (opts.saveData) await context.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true } }));
  const page = await context.newPage();
  const errors: string[] = [], urls: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*404/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    urls.push(path);
    if (r.status() === 404 && !path.startsWith('/api/')) errors.push(`404 ${path}`);
  });
  await page.goto(base);
  return { context, page, errors, urls };
}

async function enterGame(page: Page) {
  await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
  await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 15_000 });
  for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
}

type Office = { player: { pos: { x: number; z: number; set(x: number, y: number, z: number): void }; view: string; camYaw: number; camPitch: number; camDist: number; lookPitch: number; facing: number; updateCamera(snap?: boolean): void }; city: { districts?: { loaded: boolean; group: { visible: boolean } } }; renderer: { info: { render: { triangles: number; calls: number }; memory: { geometries: number; textures: number } } } };
/** Places the founder and the camera; `view` first looks along yaw, third orbits behind at `dist`/`pitch`. */
async function place(page: Page, v: { x: number; z: number; yaw: number; view: 'first' | 'third'; dist?: number; pitch?: number; look?: number }, settle = 1800) {
  await page.evaluate((p) => {
    const o = (window as unknown as { __office: Office }).__office;
    o.player.view = p.view;
    o.player.pos.set(p.x, 0, p.z);
    o.player.camYaw = p.yaw;
    o.player.facing = p.yaw;
    o.player.lookPitch = p.look ?? -0.05;
    if (p.dist) o.player.camDist = p.dist;
    if (p.pitch) o.player.camPitch = p.pitch;
    o.player.updateCamera(true);
  }, v);
  await page.waitForTimeout(settle);
}

const VIEWS = {
  aerial: { x: 100, z: 120, yaw: -Math.PI * 0.75, view: 'third', dist: 120, pitch: 0.95 },
  business: { x: 70, z: 90, yaw: -Math.PI / 2, view: 'first', look: 0.12 },
  harbour: { x: 62, z: 175, yaw: -Math.PI / 2, view: 'first', look: 0.05 },
  garage: { x: 72, z: 97, yaw: 0, view: 'first', look: 0.02 },
  founding: { x: 0, z: 90, yaw: -Math.PI / 2, view: 'third', dist: 9, pitch: 0.25 },
  // CITY-08: the garage roof and helipad from the avenue corner (also a plain viewpoint on older builds).
  helipad: { x: 96, z: 98, yaw: Math.PI * 0.8, view: 'third', dist: 18, pitch: 0.42 },
} as const;

async function frameTimes(page: Page, ms = 4000) {
  return page.evaluate((duration) => new Promise<{ mean: number; p95: number; frames: number }>((done) => {
    const t: number[] = [];
    const start = performance.now();
    const tick = (now: number) => {
      t.push(now);
      if (now - start < duration) requestAnimationFrame(tick);
      else {
        const d = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
        done({ mean: d.reduce((a, b) => a + b, 0) / d.length, p95: d[Math.floor(d.length * 0.95)], frames: d.length });
      }
    };
    requestAnimationFrame(tick);
  }), ms);
}

async function perf(browser: Browser, label: string) {
  const report: Record<string, unknown> = { label, base, note: 'Headless Chrome, ANGLE/Metal, vsync and frame cap disabled; Medium preset (default). Same viewpoints in every run.' };
  for (const [name, size] of [['desktop-1440x900', { width: 1440, height: 900, touch: false }], ['phone-874x402', { width: 874, height: 402, touch: true }]] as const) {
    const s = await open(browser, size);
    try {
      await enterGame(s.page);
      await s.page.waitForTimeout(6000);
      const views: Record<string, unknown> = {};
      for (const view of ['founding', 'business', 'aerial', 'helipad'] as const) {
        await place(s.page, VIEWS[view], 2500);
        const frames = await frameTimes(s.page);
        const info = await s.page.evaluate(() => { const r = (window as unknown as { __office: Office }).__office.renderer.info; return { triangles: r.render.triangles, calls: r.render.calls, geometries: r.memory.geometries, textures: r.memory.textures }; });
        views[view] = { frames, renderer: info };
        console.log(`perf ${label} ${name} ${view}: mean ${frames.mean.toFixed(2)} ms, p95 ${frames.p95.toFixed(2)} ms · ${JSON.stringify(info)}`);
      }
      report[name] = views;
    } finally {
      await s.context.close();
    }
  }
  writeFileSync(resolve(perfOut, `perf-${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
}

const unthrottled = only === 'perf' ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal', ...unthrottled] });
const funds = (page: Page) => page.evaluate(() => (window as unknown as { __office: { store: { empire: { funds: number } } } }).__office.store.empire.funds);
/** Waits until CSS animations (dialog fade/pop) have finished, so screenshots show the settled UI. */
const settled = (page: Page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !document.getElementById('modal-root')?.contains((a.effect as KeyframeEffect | null)?.target as Node ?? null)), null, { timeout: 5000 }).then(() => page.waitForTimeout(150));
/** The dialog is the dark, opaque style and nothing (HUD, hint, minimap) covers its title or close button. */
const dialogOnTop = (page: Page) => page.evaluate(() => {
  const d = document.querySelector('#modal-root [role=dialog]') as HTMLElement;
  const covered = [d.querySelector('h2')!, d.querySelector('.close')!].some((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !hit || !d.contains(hit);
  });
  // Opacity of the painted background: the colour, or the least opaque stop of a gradient background.
  const cs = getComputedStyle(d);
  const alphas = (s: string) => [...s.matchAll(/rgba?\(([^)]*)\)/g)].map((m) => { const p = m[1].split(','); return p.length > 3 ? Number(p[3]) : 1; });
  const color = alphas(cs.backgroundColor)[0] ?? 0;
  const alpha = color > 0 ? color : Math.min(...alphas(cs.backgroundImage));
  return { covered, dark: d.classList.contains('ae-dark'), alpha, opacity: getComputedStyle(d).opacity, text: d.textContent ?? '' };
});
const dialog = (page: Page) => page.locator('#modal-root [role=dialog][aria-labelledby=city-dialog-title]');

// ---------------------------------------------------------------- CITY-06/08: driving bought cars, flying the helicopter
type RideView = { key: string; spec: { id: string; door: number[]; half: { w: number; l: number } }; object: { position: { x: number; y: number; z: number }; rotation: { y: number }; userData: Record<string, unknown> } };
type Live = Office & { traversal: { state: string }; net: { send(m: unknown): void }; city: { rides(): RideView[] }; player: Office['player'] & { pos: { y: number }; ride: { id: string }; drivingSpeed: number; flight: { landed: boolean; spool: number }; driving: boolean } };
const live = (page: Page) => page.evaluate(() => {
  const o = (window as unknown as { __office: Live }).__office;
  return { state: o.traversal.state, ride: o.player.ride.id, x: o.player.pos.x, y: o.player.pos.y, z: o.player.pos.z, speed: o.player.drivingSpeed, landed: o.player.flight.landed, view: o.player.view };
});
/** Stands the founder at a ride's driver's door, facing it (the walk there is covered by traversal tests). */
async function toDoor(page: Page, key: string) {
  await page.evaluate((k) => {
    const o = (window as unknown as { __office: Live }).__office;
    const r = o.city.rides().find((x) => x.key === k)!;
    const d = r.spec.door, a = r.object.rotation.y, c = Math.cos(a), s = Math.sin(a);
    o.player.pos.set(r.object.position.x + d[0] * c + d[2] * s, r.object.position.y, r.object.position.z - d[0] * s + d[2] * c);
    o.player.camYaw = a + Math.PI * 0.6;
    o.player.updateCamera(true);
  }, key);
  await page.waitForTimeout(500);
}
const waitState = (page: Page, state: string, timeout = 12_000) =>
  page.waitForFunction((s) => (window as unknown as { __office: Live }).__office.traversal.state === s, state, { timeout });
async function hold(page: Page, key: string, ms: number) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}
async function buyFleet(page: Page) {
  await page.evaluate(() => {
    const o = (window as unknown as { __office: Live }).__office;
    o.net.send({ t: 'empire.action', action: { kind: 'buy-vehicle', model: 'hatchback', nonce: 'rides-check-hatch-1' } });
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as unknown as { __office: Live }).__office.net.send({ t: 'empire.action', action: { kind: 'vehicle-spawn', vehicle: 'vehicle-1', blocked: [] } }));
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as unknown as { __office: Live }).__office.net.send({ t: 'empire.action', action: { kind: 'buy-helicopter', nonce: 'rides-check-heli-1' } }));
  await page.waitForFunction(() => {
    const c = (window as unknown as { __office: { store: { empire: { city?: { helicopter?: boolean; vehicles: { apron?: number }[] } } } } }).__office.store.empire.city;
    return c?.helicopter && c.vehicles[0]?.apron !== undefined;
  }, null, { timeout: 8000 });
  await page.waitForTimeout(800);
}
async function rides(browser: Browser) {
  // A. Desktop 1440x900: drive the bought hatchback, park it, climb to the helipad, fly and land.
  {
    const s = await open(browser, { width: 1440, height: 900, touch: false });
    await enterGame(s.page);
    await s.page.waitForFunction(() => (window as unknown as { __office: Office }).__office.city.districts?.loaded, null, { timeout: 60_000 });
    // The heliport kiosk dialog before purchase.
    await place(s.page, { x: 80.2, z: 74.6, yaw: 0, view: 'first', look: -0.25 }, 300);
    await s.page.evaluate(() => { const o = (window as unknown as { __office: Live }).__office; o.player.pos.set(80.2, 6.3, 74.8); });
    await s.page.waitForTimeout(800);
    await s.page.keyboard.press('e');
    await dialog(s.page).waitFor({ timeout: 5000 });
    await settled(s.page);
    const heliText = (await dialog(s.page).textContent()) ?? '';
    check('rooftop kiosk opens the heliport dialog with the price in fictional credits and flying instructions', /Meridian rooftop helipad/.test(heliText) && /45,000 city credits/.test(heliText) && /Space climbs, Left Shift descends/.test(heliText) && /never charge your AI provider/.test(heliText));
    await s.page.screenshot({ path: resolve(rideOut, '01-heliport-dialog-1440x900.jpg'), quality: 82 });
    await s.page.keyboard.press('Escape');
    await buyFleet(s.page);
    // Drive the hatchback from its kerb slot.
    await place(s.page, { x: 60, z: 92, yaw: 0, view: 'third', dist: 6, pitch: 0.2 }, 200);
    await toDoor(s.page, 'vehicle-1');
    const hint = await s.page.locator('.traversal-hint').textContent();
    check('the bought car shows its boarding hint', /Drive the city hatchback/.test(hint ?? ''), hint ?? '');
    await s.page.keyboard.press('e');
    await s.page.waitForTimeout(1600);
    await s.page.screenshot({ path: resolve(rideOut, '02-hatchback-door-1440x900.jpg'), quality: 82 });
    await waitState(s.page, 'driving');
    const seated = await live(s.page);
    check('entering the hatchback drives it with its own spec', seated.ride === 'hatchback', JSON.stringify(seated));
    const start = await s.page.evaluate(() => { const r = (window as unknown as { __office: Live }).__office.city.rides().find((x) => x.key === 'vehicle-1')!; return { x: r.object.position.x, z: r.object.position.z }; });
    await hold(s.page, 'ArrowUp', 2600);
    await s.page.screenshot({ path: resolve(rideOut, '03-driving-hatchback-third-1440x900.jpg'), quality: 82 });
    await s.page.keyboard.down('ArrowDown');
    await s.page.waitForFunction(() => Math.abs((window as unknown as { __office: Live }).__office.player.drivingSpeed) < 0.3, null, { timeout: 8000 });
    await s.page.keyboard.up('ArrowDown');
    await s.page.keyboard.press('n');
    await s.page.waitForTimeout(900);
    await s.page.screenshot({ path: resolve(rideOut, '04-driving-hatchback-cockpit-1440x900.jpg'), quality: 82 });
    check('first person while driving the hatchback', (await live(s.page)).view === 'first');
    await s.page.keyboard.press('n');
    await s.page.waitForTimeout(400);
    await s.page.evaluate(() => (window as unknown as { __office: Live }).__office.player.vehicle.stop());
    await s.page.keyboard.press('e');
    await waitState(s.page, 'walking');
    await s.page.waitForTimeout(1200);
    const parked = await s.page.evaluate(() => {
      const o = (window as unknown as { __office: Live & { office: { colliders: { minX: number; maxX: number; minZ: number; maxZ: number; top: number }[] } } }).__office;
      const r = o.city.rides().find((x) => x.key === 'vehicle-1')!;
      const solid = o.office.colliders.some((c) => c.top > 1.5 && r.object.position.x > c.minX && r.object.position.x < c.maxX && r.object.position.z > c.minZ && r.object.position.z < c.maxZ);
      return { x: r.object.position.x, z: r.object.position.z, solid };
    });
    check('exiting parks the hatchback where it was left, and it is solid there', Math.hypot(parked.x - start.x, parked.z - start.z) > 3 && parked.solid, `${JSON.stringify(start)} → ${JSON.stringify(parked)}`);
    await s.page.screenshot({ path: resolve(rideOut, '05-hatchback-parked-1440x900.jpg'), quality: 82 });
    // Walk up the garage staircase (physical traversal) to the roof.
    await place(s.page, { x: 84.1, z: 85.2, yaw: 0, view: 'third', dist: 5, pitch: 0.25 }, 600);
    await hold(s.page, 'ArrowUp', 7000);
    const roof = await live(s.page);
    check('the staircase climbs to the helipad deck', Math.abs(roof.y - 6.3) < 0.1, JSON.stringify(roof));
    await s.page.screenshot({ path: resolve(rideOut, '06-staircase-landing-1440x900.jpg'), quality: 82 });
    await toDoor(s.page, 'helicopter');
    await s.page.keyboard.press('e');
    await waitState(s.page, 'flying');
    check('boarding the helicopter at the pilot door', (await live(s.page)).ride === 'helicopter');
    await s.page.keyboard.down('Space');
    await s.page.waitForTimeout(7500);
    await s.page.keyboard.up('Space');
    await hold(s.page, 'ArrowRight', 900);
    await s.page.waitForTimeout(1500);
    const air = await live(s.page);
    check('the helicopter spools up, lifts off and climbs', air.y > 20 && !air.landed, JSON.stringify(air));
    check('the flight hint names the climb, descend and camera keys', /Space Climb · Left Shift Descend/.test((await s.page.locator('.traversal-hint').textContent()) ?? ''));
    await s.page.screenshot({ path: resolve(rideOut, '07-flying-third-1440x900.jpg'), quality: 82 });
    await s.page.keyboard.press('n');
    await s.page.waitForTimeout(900);
    await s.page.screenshot({ path: resolve(rideOut, '08-flying-cockpit-1440x900.jpg'), quality: 82 });
    check('first person while flying', (await live(s.page)).view === 'first');
    await s.page.keyboard.press('n');
    await s.page.keyboard.down('ShiftLeft');
    await s.page.waitForFunction(() => (window as unknown as { __office: Live }).__office.player.flight.landed, null, { timeout: 40_000 });
    await s.page.keyboard.up('ShiftLeft');
    const landed = await live(s.page);
    check('descending lands back on the rooftop pad', Math.abs(landed.y - 6.3) < 0.05, JSON.stringify(landed));
    await s.page.waitForTimeout(600);
    await s.page.keyboard.press('e');
    await waitState(s.page, 'walking');
    check('the pilot steps out onto the pad', Math.abs((await live(s.page)).y - 6.3) < 0.1);
    await place(s.page, VIEWS.helipad, 300);
    await s.page.evaluate(() => { const o = (window as unknown as { __office: Live }).__office; o.player.pos.set(96, 0, 98); o.player.updateCamera(true); });
    await s.page.waitForTimeout(1500);
    await s.page.screenshot({ path: resolve(rideOut, '09-helipad-garage-1440x900.jpg'), quality: 82 });
    check('no console errors or missing assets (desktop driving and flying)', !s.errors.length, s.errors.slice(0, 5).join(' · '));
    await s.context.close();
  }
  // B. Phone landscape 874x402 with touch: drive with the joystick, fly with Up/Down.
  {
    const s = await open(browser, { width: 874, height: 402, touch: true });
    await enterGame(s.page);
    await s.page.waitForFunction(() => (window as unknown as { __office: Office }).__office.city.districts?.loaded, null, { timeout: 60_000 });
    await place(s.page, { x: 60, z: 92, yaw: 0, view: 'third', dist: 6, pitch: 0.2 }, 200);
    await toDoor(s.page, 'vehicle-1').catch(() => {});
    const has = await s.page.evaluate(() => (window as unknown as { __office: Live }).__office.city.rides().some((r) => r.key === 'vehicle-1'));
    if (has) {
      await toDoor(s.page, 'vehicle-1');
      await s.page.locator('.touch-use').click();
      await waitState(s.page, 'driving');
      const z0 = await live(s.page);
      const zone = await s.page.locator('.touch-stick-zone').boundingBox();
      const cx = zone!.x + zone!.width * 0.35, cy = zone!.y + zone!.height * 0.6;
      await s.page.mouse.move(cx, cy);
      await s.page.mouse.down();
      await s.page.mouse.move(cx, cy - 70, { steps: 4 });
      await s.page.waitForTimeout(2200);
      await s.page.screenshot({ path: resolve(rideOut, '10-driving-phone-874x402.jpg'), quality: 82 });
      await s.page.mouse.up();
      const z1 = await live(s.page);
      check('phone 874x402: the joystick drives the bought car', Math.hypot(z1.x - z0.x, z1.z - z0.z) > 2, `${JSON.stringify(z0)} → ${JSON.stringify(z1)}`);
      await s.page.evaluate(() => (window as unknown as { __office: Live }).__office.player.vehicle.stop());
      await s.page.locator('.touch-use').click();
      await waitState(s.page, 'walking');
    } else check('phone 874x402: the bought hatchback from the desktop run is in this session', false);
    await place(s.page, { x: 80, z: 76, yaw: 0, view: 'third', dist: 6, pitch: 0.2 }, 200);
    await s.page.evaluate(() => { const o = (window as unknown as { __office: Live }).__office; o.player.pos.set(80, 6.3, 76); });
    await toDoor(s.page, 'helicopter');
    await s.page.locator('.touch-use').click();
    await waitState(s.page, 'flying');
    const up = s.page.locator('.touch-jump'), down = s.page.locator('.touch-down');
    check('phone 874x402: flying shows Up and Down buttons', (await up.textContent())?.includes('Up') === true && await down.isVisible());
    const ub = await up.boundingBox();
    await s.page.mouse.move(ub!.x + ub!.width / 2, ub!.y + ub!.height / 2);
    await s.page.mouse.down();
    await s.page.waitForTimeout(6000);
    await s.page.mouse.up();
    const air = await live(s.page);
    check('phone 874x402: holding Up lifts the helicopter', air.y > 12, JSON.stringify(air));
    const phoneHint = (await s.page.locator('.traversal-hint').textContent()) ?? '';
    check('phone 874x402: the flight hint names the on-screen Up and Down buttons', /Up Climb · Down Descend/.test(phoneHint), phoneHint);
    await s.page.screenshot({ path: resolve(rideOut, '11-flying-phone-874x402.jpg'), quality: 82 });
    const fit = await s.page.evaluate(() => [...document.querySelectorAll('.touch-btn')].every((b) => { const r = b.getBoundingClientRect(); return (b as HTMLElement).hidden || (r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight); }) && document.documentElement.scrollWidth <= innerWidth);
    check('phone 874x402: every touch button is on screen in flight', fit);
    const db = await down.boundingBox();
    await s.page.mouse.move(db!.x + db!.width / 2, db!.y + db!.height / 2);
    await s.page.mouse.down();
    await s.page.waitForFunction(() => (window as unknown as { __office: Live }).__office.player.flight.landed, null, { timeout: 40_000 }).catch(() => {});
    await s.page.mouse.up();
    check('phone 874x402: holding Down lands on the pad', Math.abs((await live(s.page)).y - 6.3) < 0.05);
    check('no console errors (phone driving and flying)', !s.errors.length, s.errors.slice(0, 5).join(' · '));
    await s.context.close();
  }
  // C. 375 px portrait: the rotate hint, and the heliport dialog fits.
  {
    const s = await open(browser, { width: 375, height: 812, touch: true });
    await enterGame(s.page);
    await s.page.waitForFunction(() => (window as unknown as { __office: Office }).__office.city.districts?.loaded, null, { timeout: 60_000 });
    await s.page.evaluate(() => { const o = (window as unknown as { __office: Live }).__office; o.player.pos.set(80.2, 6.3, 74.8); o.player.updateCamera(true); });
    await s.page.waitForTimeout(600);
    await s.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e' })));
    await dialog(s.page).waitFor({ timeout: 5000 });
    await settled(s.page);
    const fit = await s.page.evaluate(() => { const r = document.querySelector('#modal-root [role=dialog]')!.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; });
    check('375 px: the heliport dialog fits without sideways overflow', fit);
    await s.page.screenshot({ path: resolve(rideOut, '12-heliport-dialog-375.jpg'), quality: 82 });
    check('no console errors (375 px)', !s.errors.length, s.errors.slice(0, 5).join(' · '));
    await s.context.close();
  }
  // D. Reduced motion and Save-Data: the rotor is a static disc and nothing new is downloaded.
  {
    const s = await open(browser, { width: 1440, height: 900, touch: false, saveData: true, reducedMotion: true });
    await enterGame(s.page);
    await s.page.waitForFunction(() => (window as unknown as { __office: Office }).__office.city.districts?.loaded, null, { timeout: 60_000 });
    await s.page.waitForTimeout(500);
    const rotor = await s.page.evaluate(() => (window as unknown as { __office: Live }).__office.city.rides().find((r) => r.key === 'helicopter')!.object.userData.rotor);
    check('reduced motion: the main rotor shows as a static disc', rotor === 'disc', String(rotor));
    const extra = s.urls.filter((u) => /\.(glb|gltf|webp|png|jpe?g|mp4|webm)$/.test(u) && /heli|ride|garage/i.test(u));
    check('Save-Data: no helicopter or vehicle downloads beyond the city kits', !extra.length, extra.join(', '));
    check('no console errors (reduced motion, Save-Data)', !s.errors.length, s.errors.slice(0, 5).join(' · '));
    await s.context.close();
  }
}
try {
  if (only === 'perf') await perf(browser, process.env.PERF_LABEL || 'after');
  else if (only === 'rides') await rides(browser);
  else {
    // 1. Desktop: districts load, views, garage purchase / spawn, plot purchase, keyboard, traversal.
    {
      const s = await open(browser, { width: 1440, height: 900, touch: false });
      await enterGame(s.page);
      await s.page.waitForFunction(() => (window as unknown as { __office: Office }).__office.city.districts?.loaded, null, { timeout: 60_000 });
      const owned = await s.page.evaluate(() => (window as unknown as { __office: { store: { empire: { city?: { vehicles: unknown[] } } } } }).__office.store.empire.city?.vehicles.length ?? 0);
      if (owned) throw new Error('The fixture already holds garage vehicles from an earlier run; restart tools/ui-fixture.ts.');
      check('district kits load (desktop 512² palettes)', s.urls.some((u) => u === '/models/city/commercial.webp') && !s.urls.some((u) => u.endsWith('-phone.webp')));
      for (const [i, view] of (['aerial', 'business', 'harbour', 'garage'] as const).entries()) {
        await place(s.page, VIEWS[view], 2500);
        await s.page.screenshot({ path: resolve(out, `0${i + 1}-${view}-1440x900.jpg`), quality: 82 });
      }
      // Physical traversal: hold the forward key along the z = 90 street from the founding district.
      await place(s.page, { x: 40, z: 90, yaw: -Math.PI / 2, view: 'third', dist: 6, pitch: 0.2 }, 800);
      const x0 = await s.page.evaluate(() => (window as unknown as { __office: Office }).__office.player.pos.x);
      await s.page.locator('#scene').focus().catch(() => {});
      await s.page.keyboard.down('ArrowUp');
      await s.page.waitForTimeout(12000);
      await s.page.keyboard.up('ArrowUp');
      const x1 = await s.page.evaluate(() => (window as unknown as { __office: Office }).__office.player.pos.x);
      check('walking east crosses into the business district (no teleport)', x1 > Math.max(x0 + 5, 55), `x ${x0.toFixed(1)} → ${x1.toFixed(1)}`);
      // Garage: walk-in position at the kiosk, interaction key, buy, bring out, refuse when full.
      await place(s.page, { x: 81.8, z: 84.3, yaw: 0, view: 'first', look: -0.2 }, 1200);
      const hint = await s.page.locator('.traversal-hint').textContent();
      await s.page.waitForTimeout(300);
      check('the location label names the garage', (await s.page.locator('#hud').textContent())?.includes('Meridian motor garage') ?? false);
      check('the kiosk shows its interaction hint', /Garage: buy, bring out or store vehicles/.test(hint ?? ''), hint ?? '');
      await s.page.keyboard.press('e');
      await dialog(s.page).waitFor({ timeout: 5000 });
      check('the interaction key opens the Meridian motor garage dialog', (await dialog(s.page).locator('h2').textContent()) === 'Meridian motor garage');
      check('the dialog says city credits are fictional', /never charge your AI provider/.test((await dialog(s.page).textContent()) ?? ''));
      await settled(s.page);
      {
        const d = await dialogOnTop(s.page);
        check('desktop: the garage dialog is dark, opaque and uncovered', d.dark && d.alpha >= 0.95 && d.opacity === '1' && !d.covered, JSON.stringify({ ...d, text: undefined }));
        check('the dialog shows no internal slice IDs and explains how to drive bought cars (CITY-06)', !/CITY-\d|FREE-\d/.test(d.text) && /walk to its driver's door and press E/.test(d.text) && !/later update/.test(d.text));
      }
      const before = await funds(s.page);
      await dialog(s.page).locator('[data-key=buy-hatchback]').click();
      await s.page.waitForFunction(() => document.querySelector('[data-key="out-vehicle-1"]'), null, { timeout: 5000 });
      const after = await funds(s.page);
      check('buying the City hatchback spends 9,000 fictional credits and parks it in bay 1', before - after === 9000 && /City hatchback · bay 1/.test((await dialog(s.page).textContent()) ?? ''), `${before} → ${after}`);
      await settled(s.page);
      await s.page.screenshot({ path: resolve(out, '05-garage-purchase-1440x900.jpg'), quality: 82 });
      await dialog(s.page).locator('[data-key="out-vehicle-1"]').click();
      await s.page.waitForFunction(() => /outside, kerb slot/.test(document.querySelector('.city-dialog')?.textContent ?? ''), null, { timeout: 5000 });
      check('Bring out moves it to a free kerb slot', true);
      for (const m of ['van', 'coupe', 'suv']) {
        await dialog(s.page).locator(`[data-key=buy-${m}]`).click();
        await s.page.waitForTimeout(400);
      }
      const full = await dialog(s.page).locator('[data-key=buy-hatchback]');
      check('a full garage refuses further purchases', (await full.isDisabled()) && (await full.textContent()) === 'Garage full', await full.textContent() ?? '');
      await s.page.keyboard.press('Escape');
      check('Escape closes the dialog', (await dialog(s.page).count()) === 0);
      await place(s.page, { x: 72, z: 97, yaw: 0, view: 'first', look: 0.02 }, 2500);
      const parked = await s.page.evaluate(() => (window as unknown as { __office: { city: { districts: { garageCars: { children: { name: string }[] } } } } }).__office.city.districts.garageCars.children.map((c) => c.name));
      check('owned vehicles are placed in their bays and on the kerb', parked.length === 4, parked.join(' | '));
      await s.page.screenshot({ path: resolve(out, '06-garage-vehicles-1440x900.jpg'), quality: 82 });
      // Plot purchase at its sign.
      await place(s.page, { x: 74, z: 199.2, yaw: 0, view: 'first', look: -0.1 }, 1200);
      await s.page.keyboard.press('e');
      await dialog(s.page).waitFor({ timeout: 5000 });
      await dialog(s.page).locator('[data-key=plot-harbour-yard]').click();
      await s.page.waitForFunction(() => /You own this parcel/.test(document.querySelector('.city-dialog')?.textContent ?? ''), null, { timeout: 5000 });
      check('a plot can be bought at its sign', true);
      await s.page.keyboard.press('Escape');
      await s.page.waitForTimeout(1500);
      await s.page.screenshot({ path: resolve(out, '07-plot-owned-1440x900.jpg'), quality: 82 });
      check('no console errors or missing assets (desktop)', !s.errors.length, s.errors.slice(0, 5).join(' · '));
      await s.context.close();
    }
    // 2. Phone landscape 874x402: aerial and street views, the garage dialog fits.
    {
      const s = await open(browser, { width: 874, height: 402, touch: true });
      await enterGame(s.page);
      await s.page.waitForFunction(() => (window as unknown as { __office: Office }).__office.city.districts?.loaded, null, { timeout: 60_000 });
      check('phones get the 256² palettes', s.urls.some((u) => u === '/models/city/commercial-phone.webp') && !s.urls.includes('/models/city/commercial.webp'));
      await place(s.page, VIEWS.aerial, 2500);
      await s.page.screenshot({ path: resolve(out, '08-aerial-phone-874x402.jpg'), quality: 82 });
      await place(s.page, VIEWS.business, 2500);
      check('phone: the location label names the business district, not the waterfront', ((await s.page.locator('#hud').textContent()) ?? '').includes('Meridian business district'));
      await s.page.screenshot({ path: resolve(out, '09-business-phone-874x402.jpg'), quality: 82 });
      await place(s.page, { x: 81.8, z: 84.3, yaw: 0, view: 'first', look: -0.2 }, 1200);
      await s.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e' })));
      await dialog(s.page).waitFor({ timeout: 5000 });
      const fit = await s.page.evaluate(() => {
        const r = document.querySelector('#modal-root [role=dialog]')!.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
      });
      check('phone 874x402: the garage dialog fits without sideways overflow', fit);
      await settled(s.page);
      {
        const d = await dialogOnTop(s.page);
        check('phone 874x402: the garage dialog is dark, opaque and above the HUD', d.dark && d.alpha >= 0.95 && d.opacity === '1' && !d.covered, JSON.stringify({ ...d, text: undefined }));
        const scrolls = await s.page.evaluate(() => { const b = document.querySelector('.city-dialog') as HTMLElement; const r = (document.querySelector('#modal-root [role=dialog]') as HTMLElement).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && getComputedStyle(b).overflowY === 'auto'; });
        check('phone 874x402: the dialog fits the viewport and its list scrolls inside it', scrolls);
      }
      await s.page.screenshot({ path: resolve(out, '10-garage-dialog-phone-874x402.jpg'), quality: 82 });
      check('no console errors (phone)', !s.errors.length, s.errors.slice(0, 5).join(' · '));
      await s.context.close();
    }
    // 3. Save-Data and reduced motion on a desktop-sized window.
    {
      const s = await open(browser, { width: 1440, height: 900, touch: false, saveData: true, reducedMotion: true });
      await enterGame(s.page);
      await s.page.waitForFunction(() => (window as unknown as { __office: Office }).__office.city.districts?.loaded, null, { timeout: 60_000 });
      check('Save-Data loads the 256² palettes', s.urls.includes('/models/city/streets-phone.webp') && !s.urls.includes('/models/city/streets.webp'));
      check('no console errors (Save-Data, reduced motion)', !s.errors.length, s.errors.slice(0, 5).join(' · '));
      await s.context.close();
    }
    // The FREE-09 section fills the garage and spends the fixture's credits, so the CITY-06/08 section needs its own
    // fresh fixture: run it with CITY_UI_ONLY=rides.
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
if (results.length) {
  writeFileSync(resolve(only === 'rides' ? rideOut : out, 'checks.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
}
process.exit(failed.length ? 1 : 0);
