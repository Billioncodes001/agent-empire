/**
 * CHAR-01 acceptance against the isolated UI fixture only (never the protected 4610 session).
 *   npm run build && FIXTURE_PORT=5071 npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://localhost:5071/ npx tsx tools/char-ui-check.ts
 * Use a fresh fixture: it buys nothing, but moves the sedan. Screenshots go to docs/team/reports/char-01/.
 * Exits non-zero on any failed check.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:5071/';
if (/:4610\b/.test(base)) throw new Error('Refusing the protected 4610 session; use the UI fixture.');
const out = resolve(import.meta.dirname, '../docs/team/reports/char-01');
mkdirSync(out, { recursive: true });

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(out, `${name}.jpg`), quality: 80 });

interface Opened { context: BrowserContext; page: Page; errors: string[] }
async function open(browser: Browser, opts: { width: number; height: number; touch: boolean; reducedMotion?: boolean; saveData?: boolean; pad?: boolean }): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1, isMobile: opts.touch, hasTouch: opts.touch, reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference' });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }));
    localStorage.setItem('agent-empire.execution.offered', '1');
  });
  if (opts.saveData) await context.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true } }));
  if (opts.pad) await context.addInitScript(() => {
    // A scripted standard gamepad: window.__pad holds its axes and pressed buttons.
    const w = window as unknown as { __pad: { axes: number[]; pressed: number[] } };
    w.__pad = { axes: [0, 0, 0, 0], pressed: [] };
    const pad = () => ({ id: 'Scripted pad', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(), axes: w.__pad.axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: w.__pad.pressed.includes(i), touched: false, value: w.__pad.pressed.includes(i) ? 1 : 0 })) });
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad(), null, null, null] });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*404/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { const p = new URL(r.url()).pathname; if (r.status() === 404 && !p.startsWith('/api/')) errors.push(`404 ${p}`); });
  await page.goto(base);
  return { context, page, errors };
}
async function enterGame(page: Page) {
  await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
  await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 15_000 });
  for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await page.waitForFunction(() => (window as unknown as { __office: { city: { districts?: { loaded: boolean } } } }).__office.city.districts?.loaded, null, { timeout: 60_000 });
}

type V3 = { x: number; y: number; z: number; set(x: number, y: number, z: number): void };
type O = {
  player: { pos: V3; view: string; camYaw: number; camPitch: number; camDist: number; facing: number; grounded: boolean; driving: boolean; speed: number; teleport(x: number, y: number, z: number): boolean; setView(v: string): void; updateCamera(s?: boolean): void; setAction(a: string, p: boolean): void; vehicle: { stop(): void }; drivingSpeed: number };
  me: { root: { userData: Record<string, unknown>; children: { userData: Record<string, unknown> }[] } };
  city: { car: { position: V3; rotation: { y: number } }; carCollider: { minX: number; maxX: number; minZ: number; maxZ: number; top: number; bottom?: number } };
  traversal: { state: string };
};
const o = <T>(page: Page, f: (o: O) => T) => page.evaluate(`(${f.toString()})(window.__office)`) as Promise<T>;
/** Walking places by script (the founder is on foot; a refused teleport would leave them where they were). */
async function place(page: Page, p: { x: number; y?: number; z: number; yaw: number; view?: 'first' | 'third'; dist?: number; pitch?: number }, settle = 900) {
  await page.evaluate((v) => {
    const x = (window as unknown as { __office: O }).__office;
    x.player.setView(v.view ?? 'third');
    x.player.teleport(v.x, v.y ?? 0, v.z);
    x.player.facing = v.yaw; x.player.camYaw = v.yaw - Math.PI;
    if (v.dist) x.player.camDist = v.dist;
    if (v.pitch) x.player.camPitch = v.pitch;
    x.player.updateCamera(true);
  }, p);
  await page.waitForTimeout(settle);
}
const motion = (page: Page) => page.evaluate(() => {
  const x = (window as unknown as { __office: O }).__office;
  let m = '';
  const walk = (n: { userData: Record<string, unknown>; children?: unknown[] }) => { if (typeof n.userData.motion === 'string') m = n.userData.motion; (n.children as typeof n[] | undefined)?.forEach(walk); };
  walk(x.me.root as never);
  return m;
});
const state = (page: Page) => o(page, (x) => ({ x: x.player.pos.x, y: x.player.pos.y, z: x.player.pos.z, speed: x.player.speed, driving: x.player.driving, traversal: x.traversal.state }));
async function hold(page: Page, key: string, ms: number) { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); }

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal'] });
try {
  // ---------------------------------------------------------------- A. Desktop 1440x900: collisions and animation audit
  {
    const s = await open(browser, { width: 1440, height: 900, touch: false, pad: true });
    await enterGame(s.page);
    // Shot 36: the sedan standing on the garage roof (the state the device tester reached). It must be solid up there.
    await s.page.evaluate(() => { const x = (window as unknown as { __office: O }).__office; x.city.car.position.set(80, 6.3, 80); x.city.car.rotation.y = 0; });
    await place(s.page, { x: 80, y: 6.3, z: 74, yaw: 0, dist: 6, pitch: 0.3 }, 1200);
    const col = await o(s.page, (x) => ({ ...x.city.carCollider }));
    check('the sedan parked on the roof has a collider at roof height', col.bottom === 6.3 && Math.abs(col.top - 7.85) < 1e-6, JSON.stringify(col));
    await hold(s.page, 'ArrowUp', 3000);
    const roof = await state(s.page);
    const inside = roof.x > col.minX - 0.25 && roof.x < col.maxX + 0.25 && roof.z > col.minZ - 0.25 && roof.z < col.maxZ + 0.25;
    check('walking into the sedan on the roof stops at its side, feet on the deck (shot 36)', !inside && roof.z > 76.5 && Math.abs(roof.y - 6.3) < 0.02, JSON.stringify(roof));
    for (let i = 0; i < 4; i++) { await s.page.keyboard.down('ArrowUp'); await hold(s.page, 'Space', 150); await s.page.waitForTimeout(600); await s.page.keyboard.up('ArrowUp'); }
    const jumped = await state(s.page);
    check('jumping at the sedan never lands on it', Math.abs(jumped.y - 6.3) < 0.02, JSON.stringify(jumped));
    await shot(s.page, '01-sedan-on-roof-solid-1440x900');
    await s.page.evaluate(() => { const x = (window as unknown as { __office: O }).__office; x.city.car.position.set(5, 0, 45); });

    // Animation audit on the avenue: idle, walk, run, turn on the spot, stop.
    await place(s.page, { x: 40, z: 92, yaw: Math.PI / 2, dist: 4.2, pitch: 0.18 }, 1500);
    check('idle clip at rest', (await motion(s.page)) === 'idle_neutral_01', await motion(s.page));
    await shot(s.page, '02-idle-1440x900');
    await s.page.keyboard.down('ArrowUp'); await s.page.waitForTimeout(1200);
    check('walk clip while walking', (await motion(s.page)) === 'walk_neutral', await motion(s.page));
    await shot(s.page, '03-walk-1440x900');
    await s.page.keyboard.down('ShiftLeft'); await s.page.waitForTimeout(1200);
    check('run clip while running', (await motion(s.page)) === 'run_neutral', await motion(s.page));
    await shot(s.page, '04-run-1440x900');
    await s.page.keyboard.up('ShiftLeft'); await s.page.keyboard.up('ArrowUp'); await s.page.waitForTimeout(900);
    check('back to idle after stopping', (await motion(s.page)) === 'idle_neutral_01', await motion(s.page));
    // A reversal from rest is a fast turn on the spot: the feet step.
    await s.page.keyboard.down('ArrowDown');
    const turning: string[] = [];
    for (let i = 0; i < 6; i++) { turning.push(await motion(s.page)); await s.page.waitForTimeout(25); }
    await s.page.keyboard.up('ArrowDown');
    check('turning on the spot steps instead of spinning the idle pose', turning.slice(0, 4).includes('walk_neutral'), turning.join(','));
    await s.page.waitForTimeout(800);
    // Jump apex.
    await s.page.keyboard.down('Space'); await s.page.waitForTimeout(260); await s.page.keyboard.up('Space');
    check('airborne pose at the top of a jump', (await motion(s.page)) === 'airborne', await motion(s.page));
    await shot(s.page, '05-jump-apex-1440x900');
    await s.page.waitForTimeout(900);

    // Stairs: halfway up the garage staircase, feet on the treads.
    await place(s.page, { x: 84.1, z: 85.2, yaw: Math.PI, dist: 3.6, pitch: 0.22 }, 600);
    await hold(s.page, 'ArrowUp', 2600);
    const stairs = await state(s.page);
    check('climbing the garage stairs', stairs.y > 1.5 && stairs.y < 6.2, JSON.stringify(stairs));
    await s.page.evaluate(() => { const x = (window as unknown as { __office: O }).__office; x.player.camYaw = x.player.facing - Math.PI / 2; x.player.camPitch = 0.08; x.player.camDist = 3.4; });
    await s.page.waitForTimeout(500);
    await shot(s.page, '06-stairs-feet-1440x900');

    // Car: walk to the sedan's driver door, enter, drive, the cockpit, exit.
    await place(s.page, { x: 3.2, z: 45.2, yaw: Math.PI / 2, dist: 5, pitch: 0.22 }, 900);
    check('the touch/gamepad Use label names the car entry', (await s.page.evaluate(() => document.querySelector('.touch-use .touch-label')?.textContent)) === 'Enter');
    // Board with the gamepad's X button.
    await s.page.evaluate(() => { const w = window as unknown as { __pad: { pressed: number[] } }; w.__pad.pressed = [2]; window.dispatchEvent(new Event('gamepadconnected')); });
    await s.page.waitForTimeout(150);
    await s.page.evaluate(() => { (window as unknown as { __pad: { pressed: number[] } }).__pad.pressed = []; });
    await s.page.waitForTimeout(1300);
    await shot(s.page, '07-car-door-reach-1440x900');
    await s.page.waitForTimeout(1500);
    await shot(s.page, '08-car-sitting-down-1440x900');
    await s.page.waitForFunction(() => (window as unknown as { __office: O }).__office.traversal.state === 'driving', null, { timeout: 10_000 });
    check('gamepad X boards the sedan', true);
    // Drive forward with the gamepad's left stick.
    const before = await state(s.page);
    await s.page.evaluate(() => { (window as unknown as { __pad: { axes: number[] } }).__pad.axes = [0, -1, 0, 0]; });
    await s.page.waitForTimeout(1800);
    await s.page.evaluate(() => { (window as unknown as { __pad: { axes: number[] } }).__pad.axes = [0, 0, 0, 0]; });
    const after = await state(s.page);
    check('gamepad left stick drives', Math.hypot(after.x - before.x, after.z - before.z) > 2, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    await shot(s.page, '09-driving-1440x900');
    const goTo = await s.page.evaluate(() => (window as unknown as { __office: O }).__office.player.teleport(0, 0, 8));
    check('a teleport is refused while driving', goTo === false);
    await s.page.evaluate(() => (window as unknown as { __office: O }).__office.player.vehicle.stop());
    await s.page.keyboard.press('e');
    await s.page.waitForFunction(() => (window as unknown as { __office: O }).__office.traversal.state === 'walking', null, { timeout: 10_000 });
    await s.page.waitForTimeout(1200);
    check('the founder steps out beside the car', (await state(s.page)).y < 0.05);
    await shot(s.page, '10-car-exit-1440x900');
    check('desktop console has no errors', s.errors.length === 0, s.errors.slice(0, 3).join(' | '));
    await s.context.close();
  }

  // ---------------------------------------------------------------- B. Touch layouts
  const layouts = [
    { name: 'phone-874x402', width: 874, height: 402 },
    { name: 'phone-667x375', width: 667, height: 375 },
    { name: 'tablet-1024x768', width: 1024, height: 768 },
  ];
  for (const l of layouts) {
    const s = await open(browser, { width: l.width, height: l.height, touch: true, reducedMotion: l.name === 'phone-667x375', saveData: l.name === 'phone-667x375' });
    await enterGame(s.page);
    await place(s.page, { x: 40, z: 92, yaw: Math.PI / 2, dist: 4.6, pitch: 0.2 }, 1200);
    const boxes = await s.page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.touch-btn:not([hidden])')].map((b) => { const r = b.getBoundingClientRect(); return { cls: b.className, label: b.getAttribute('aria-label'), x: r.x, y: r.y, w: r.width, h: r.height }; }));
    const small = boxes.filter((b) => b.w < 44 || b.h < 44);
    check(`${l.name}: touch buttons are at least 44 px and labelled`, boxes.length >= 4 && !small.length && boxes.every((b) => !!b.label), JSON.stringify(small));
    const overlap = boxes.some((a, i) => boxes.some((b, j) => j > i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
    const outside = boxes.some((b) => b.x < 0 || b.y < 0 || b.x + b.w > l.width || b.y + b.h > l.height);
    check(`${l.name}: buttons do not overlap and stay on screen`, !overlap && !outside, JSON.stringify(boxes.map((b) => [b.cls, Math.round(b.x), Math.round(b.y)])));
    const overflow = await s.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(`${l.name}: no horizontal overflow`, !overflow);
    // Run lock: tap Run, then a small push on the stick runs.
    await s.page.locator('.touch-run').tap();
    const pressed = await s.page.locator('.touch-run').getAttribute('aria-pressed');
    const zone = await s.page.locator('.touch-stick-zone').boundingBox();
    const cx = zone!.x + 90, cy = zone!.y + zone!.height - 80;
    const cdp = await s.context.newCDPSession(s.page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx, y: cy - 26, id: 1 }] });
    await s.page.waitForTimeout(1300);
    const running = await state(s.page);
    await shot(s.page, `11-touch-run-${l.name}`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check(`${l.name}: the Run button runs at a small stick push`, pressed === 'true' && running.speed > 3.4, `pressed ${pressed}, speed ${running.speed.toFixed(2)}`);
    await s.page.locator('.touch-run').tap();
    // Contextual Use beside the sedan, Fast while driving, Exit to leave.
    await place(s.page, { x: 3.2, z: 45.2, yaw: Math.PI / 2, dist: 5, pitch: 0.22 }, 900);
    check(`${l.name}: Use reads Enter at the driver's door`, (await s.page.locator('.touch-use .touch-label').textContent()) === 'Enter');
    await shot(s.page, `12-touch-enter-${l.name}`);
    await s.page.locator('.touch-use').tap();
    await s.page.waitForFunction(() => (window as unknown as { __office: O }).__office.traversal.state === 'driving', null, { timeout: 10_000 });
    await s.page.waitForTimeout(300);
    const labels = await s.page.evaluate(() => [document.querySelector('.touch-use .touch-label')?.textContent, document.querySelector('.touch-run .touch-label')?.textContent]);
    check(`${l.name}: driving shows Exit and Fast`, labels[0] === 'Exit' && labels[1] === 'Fast', labels.join(','));
    await shot(s.page, `13-touch-driving-${l.name}`);
    await s.page.locator('.touch-use').tap();
    await s.page.waitForFunction(() => (window as unknown as { __office: O }).__office.traversal.state === 'walking', null, { timeout: 10_000 });
    check(`${l.name}: Exit leaves the car`, true);
    check(`${l.name}: console has no errors`, s.errors.length === 0, s.errors.slice(0, 3).join(' | '));
    await s.context.close();
  }

  // ---------------------------------------------------------------- C. 375 px portrait asks to rotate
  {
    const s = await open(browser, { width: 375, height: 812, touch: true });
    await s.page.waitForTimeout(4000);
    const hint = await s.page.evaluate(() => { const e = document.querySelector('.rotate-hint'); return !!e && getComputedStyle(e).display !== 'none'; });
    check('375x812 portrait shows the rotate screen', hint);
    const overflow = await s.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check('375x812: no horizontal overflow', !overflow);
    await shot(s.page, '14-portrait-rotate-375x812');
    await s.context.close();
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
