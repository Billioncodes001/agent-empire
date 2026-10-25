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
/** CHAR-02 states (jump phases, stairs, car seat) are saved to their own folder. CHAR_ONLY=char02 runs only those. */
const out2 = resolve(import.meta.dirname, '../docs/team/reports/char-02');
mkdirSync(out2, { recursive: true });
const only = process.env.CHAR_ONLY;

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
/** CHAR-02: a value the founder's Human records in userData (clip, jump, stairs). */
const humanData = (page: Page, key: string) => page.evaluate((k) => {
  const x = (window as unknown as { __office: O }).__office;
  let v: unknown;
  const walk = (n: { userData: Record<string, unknown>; children?: unknown[] }) => { if (k in n.userData) v = n.userData[k]; (n.children as typeof n[] | undefined)?.forEach(walk); };
  walk(x.me.root as never);
  return v as string | null | undefined;
}, key);
/**
 * CHAR-02 review: vertical clearance above the founder's skull inside a ride. A ray straight up from the head bone is
 * tested against every triangle of the ride's meshes (world space); `roof` is the lowest surface above the head and
 * `gap` the room left above the top of the skull (head bone + 0.12 m). Rotors and glass count as roof.
 */
const headClearance = (page: Page, key: string) => page.evaluate((k) => {
  type M = { isMesh?: boolean; matrixWorld: { elements: number[] }; geometry?: { index: { array: ArrayLike<number> } | null; attributes: { position: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } } }; children: M[]; updateMatrixWorld(f: boolean): void };
  const o = (window as unknown as { __office: { me: { root: unknown }; city: { rides(): { key: string; object: M }[] } } }).__office;
  let head: { getWorldPosition(v: unknown): { x: number; y: number; z: number }; position: { clone(): unknown } } | null = null;
  const find = (n: { name?: string; children?: unknown[] }) => { if (n.name === 'Bip01_Head') head = n as never; (n.children as typeof n[] | undefined)?.forEach(find); };
  find(o.me.root as never);
  const ride = o.city.rides().find((r) => r.key === k);
  if (!head || !ride) return { roof: null, gap: -1, head: null };
  const h = (head as { getWorldPosition(v: unknown): { x: number; y: number; z: number }; position: { clone(): unknown } }).getWorldPosition((head as { position: { clone(): unknown } }).position.clone());
  ride.object.updateMatrixWorld(true);
  let roof: number | null = null;
  const tx = (e: number[], x: number, y: number, z: number) => [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
  const visit = (m: M) => {
    if (m.isMesh && m.geometry) {
      const p = m.geometry.attributes.position, e = m.matrixWorld.elements, idx = m.geometry.index?.array;
      const n = idx ? idx.length : p.count;
      const v = (i: number) => { const j = idx ? idx[i] : i; return tx(e, p.getX(j), p.getY(j), p.getZ(j)); };
      for (let i = 0; i + 2 < n; i += 3) {
        const a = v(i), b = v(i + 1), c = v(i + 2);
        const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
        if (Math.abs(d) < 1e-9) continue;
        const w1 = ((b[2] - c[2]) * (h.x - c[0]) + (c[0] - b[0]) * (h.z - c[2])) / d;
        const w2 = ((c[2] - a[2]) * (h.x - c[0]) + (a[0] - c[0]) * (h.z - c[2])) / d;
        const w3 = 1 - w1 - w2;
        if (w1 < 0 || w2 < 0 || w3 < 0) continue;
        const y = w1 * a[1] + w2 * b[1] + w3 * c[1];
        if (y > h.y && (roof === null || y < roof)) roof = y;
      }
    }
    m.children.forEach(visit);
  };
  visit(ride.object);
  const r = roof as number | null;
  return { roof: r === null ? null : Math.round(r * 1000) / 1000, gap: r === null ? -1 : Math.round((r - h.y - 0.12) * 1000) / 1000, head: Math.round(h.y * 1000) / 1000 };
}, key);
const state = (page: Page) => o(page, (x) => ({ x: x.player.pos.x, y: x.player.pos.y, z: x.player.pos.z, speed: x.player.speed, driving: x.player.driving, traversal: x.traversal.state }));
async function hold(page: Page, key: string, ms: number) { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); }

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal'] });
try {
  // ---------------------------------------------------------------- A. Desktop 1440x900: collisions and animation audit
  if (only !== "char02") {
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
  for (const l of only === "char02" ? [] : layouts) {
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
  if (only !== "char02") {
    const s = await open(browser, { width: 375, height: 812, touch: true });
    await s.page.waitForTimeout(4000);
    const hint = await s.page.evaluate(() => { const e = document.querySelector('.rotate-hint'); return !!e && getComputedStyle(e).display !== 'none'; });
    check('375x812 portrait shows the rotate screen', hint);
    const overflow = await s.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check('375x812: no horizontal overflow', !overflow);
    await shot(s.page, '14-portrait-rotate-375x812');
    await s.context.close();
  }
  // ---------------------------------------------------------------- D. CHAR-02: CC0 clips at 1440x900 and 874x402
  for (const l of [{ name: '1440x900', width: 1440, height: 900, touch: false }, { name: '874x402', width: 874, height: 402, touch: true }]) {
    const s = await open(browser, { width: l.width, height: l.height, touch: l.touch });
    const extraRequests: string[] = [];
    s.page.on('response', (r) => { if (/clips-extra-(male|female)\.glb/.test(r.url())) extraRequests.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    await enterGame(s.page);
    await s.page.waitForFunction(() => {
      let ok = false;
      const walk = (n: { userData: Record<string, unknown>; children?: unknown[] }) => { if (Array.isArray(n.userData.extraClips)) ok = true; (n.children as typeof n[] | undefined)?.forEach(walk); };
      walk((window as unknown as { __office: O }).__office.me.root as never);
      return ok;
    }, null, { timeout: 30_000 });
    check(`${l.name}: the founder's extra clips loaded lazily (one small file per body)`, extraRequests.length >= 1 && extraRequests.every((r) => r.startsWith('200')), extraRequests.join(', '));
    const clip = () => humanData(s.page, 'clip');
    const shot2 = (name: string) => s.page.screenshot({ path: resolve(out2, `${name}-${l.name}.jpg`), quality: 80 });
    const waitClip = (name: string, timeout = 3000) => s.page.waitForFunction((n) => {
      let c = '';
      const walk = (x: { userData: Record<string, unknown>; children?: unknown[] }) => { if (typeof x.userData.clip === 'string') c = x.userData.clip; (x.children as typeof x[] | undefined)?.forEach(walk); };
      walk((window as unknown as { __office: O }).__office.me.root as never);
      return c === n;
    }, name, { timeout, polling: 'raf' }).then(() => true, () => false);

    // Jump: take-off, airborne, landing, back to standing.
    await place(s.page, { x: 40, z: 92, yaw: Math.PI / 2, dist: 4.2, pitch: 0.12 }, 1500);
    await s.page.keyboard.down('Space');
    const took = await waitClip('jump_start', 1500);
    await s.page.keyboard.up('Space');
    if (took) await shot2('01-jump-takeoff');
    const air = await waitClip('jump_air', 1500);
    if (air) await shot2('02-jump-airborne');
    const land = await waitClip('jump_land', 2000);
    if (land) await shot2('03-jump-landing');
    check(`${l.name}: a jump plays take-off, airborne and landing clips`, took && air && land, `${took} ${air} ${land}`);
    const stood = await waitClip('idle_neutral_01', 3000);
    check(`${l.name}: back to the idle after landing`, stood, await clip());

    // Stairs up and down the garage staircase.
    await place(s.page, { x: 84.1, z: 85.2, yaw: Math.PI, dist: 3.6, pitch: 0.22 }, 600);
    await s.page.keyboard.down('ArrowUp');
    const up = await s.page.waitForFunction(() => {
      let st: unknown = null;
      const walk = (x: { userData: Record<string, unknown>; children?: unknown[] }) => { if ('stairs' in x.userData) st = x.userData.stairs; (x.children as typeof x[] | undefined)?.forEach(walk); };
      walk((window as unknown as { __office: O }).__office.me.root as never);
      return st === 'up';
    }, null, { timeout: 4000, polling: 'raf' }).then(() => true, () => false);
    await s.page.evaluate(() => { const x = (window as unknown as { __office: O }).__office; x.player.camYaw = x.player.facing - Math.PI / 2; x.player.camPitch = 0.08; x.player.camDist = 3.4; });
    await s.page.waitForTimeout(250);
    await shot2('04-stairs-up');
    check(`${l.name}: climbing the stairs is the stairs-up state on the stride clip`, up && (await clip()) === 'walk_neutral', `${up} ${await clip()}`);
    await s.page.waitForTimeout(900);
    await s.page.keyboard.up('ArrowUp');
    await s.page.waitForTimeout(400);
    // Turn round and walk down.
    await s.page.evaluate(() => { const x = (window as unknown as { __office: O }).__office; x.player.facing += Math.PI; x.player.camYaw = x.player.facing - Math.PI; x.player.updateCamera(true); });
    await s.page.keyboard.down('ArrowDown');
    await s.page.waitForTimeout(150);
    await s.page.keyboard.up('ArrowDown');
    await s.page.keyboard.down('ArrowUp');
    const down = await s.page.waitForFunction(() => {
      let st: unknown = null;
      const walk = (x: { userData: Record<string, unknown>; children?: unknown[] }) => { if ('stairs' in x.userData) st = x.userData.stairs; (x.children as typeof x[] | undefined)?.forEach(walk); };
      walk((window as unknown as { __office: O }).__office.me.root as never);
      return st === 'down';
    }, null, { timeout: 4000, polling: 'raf' }).then(() => true, () => false);
    await s.page.evaluate(() => { const x = (window as unknown as { __office: O }).__office; x.player.camYaw = x.player.facing - Math.PI / 2; x.player.camPitch = 0.08; x.player.camDist = 3.4; });
    await s.page.waitForTimeout(250);
    await shot2('05-stairs-down');
    await s.page.keyboard.up('ArrowUp');
    check(`${l.name}: walking down the stairs is the stairs-down state`, down, String(await humanData(s.page, 'stairs')));

    // Car: get in (Rocketbox side sit), the CC0 driving seat, get out.
    await place(s.page, { x: 3.2, z: 45.2, yaw: Math.PI / 2, dist: 5, pitch: 0.22 }, 900);
    await s.page.keyboard.press('e');
    await s.page.waitForTimeout(1700);
    await shot2('06-car-get-in');
    await s.page.waitForFunction(() => (window as unknown as { __office: O }).__office.traversal.state === 'driving', null, { timeout: 10_000 });
    await s.page.waitForTimeout(700);
    await s.page.evaluate(() => { const x = (window as unknown as { __office: O }).__office; x.player.camYaw = x.player.facing - Math.PI / 2; x.player.camDist = 3.4; x.player.camPitch = 0.28; });
    await s.page.waitForTimeout(300);
    await shot2('07-car-seat-driving');
    check(`${l.name}: the car seat plays the driving pose`, (await clip()) === 'drive_seated', await clip());
    // The sedan cabin predates CHAR-02 (the chair sit reached the roofline too); its clearance is reported, not gated.
    const rideKey = await s.page.evaluate(() => (window as unknown as { __office: { player: { ride: { id: string } } } }).__office.player.ride.id);
    console.log(`INFO  ${l.name}: sedan (${rideKey}) driver head clearance ${JSON.stringify(await headClearance(s.page, rideKey))}`);
    await s.page.keyboard.press('e');
    await s.page.waitForTimeout(900);
    await shot2('08-car-get-out');
    await s.page.waitForFunction(() => (window as unknown as { __office: O }).__office.traversal.state === 'walking', null, { timeout: 10_000 });
    check(`${l.name}: console has no errors`, s.errors.length === 0, s.errors.slice(0, 3).join(' | '));
    await s.context.close();
  }

  // ---------------------------------------------------------------- F. CHAR-02: the helicopter pilot seat
  for (const l of [{ name: '1440x900', width: 1440, height: 900, touch: false }, { name: '874x402', width: 874, height: 402, touch: true }]) {
    const s = await open(browser, { width: l.width, height: l.height, touch: l.touch });
    await enterGame(s.page);
    await s.page.waitForFunction(() => {
      let ok = false;
      const walk = (n: { userData: Record<string, unknown>; children?: unknown[] }) => { if (Array.isArray(n.userData.extraClips)) ok = true; (n.children as typeof n[] | undefined)?.forEach(walk); };
      walk((window as unknown as { __office: O }).__office.me.root as never);
      return ok;
    }, null, { timeout: 30_000 });
    // Buy the helicopter once per fixture (fictional city credits; the fixture server applies it).
    const owned = await s.page.evaluate(() => !!(window as unknown as { __office: { store: { empire: { city?: { helicopter?: boolean } } } } }).__office.store.empire.city?.helicopter);
    if (!owned) await s.page.evaluate(() => (window as unknown as { __office: { net: { send(m: unknown): void } } }).__office.net.send({ t: 'empire.action', action: { kind: 'buy-helicopter', nonce: 'char02-heli-1' } }));
    await s.page.waitForFunction(() => !!(window as unknown as { __office: { store: { empire: { city?: { helicopter?: boolean } } } } }).__office.store.empire.city?.helicopter, null, { timeout: 8000 });
    await s.page.waitForTimeout(800);
    // Stand at the pilot's door (the walk there is covered by city-ui-check rides) and board.
    await s.page.evaluate(() => {
      const o = (window as unknown as { __office: O & { city: { rides(): { key: string; spec: { door: number[] }; object: { position: V3; rotation: { y: number } } }[] } } }).__office;
      const r = o.city.rides().find((x) => x.key === 'helicopter')!;
      const d = r.spec.door, a = r.object.rotation.y, c = Math.cos(a), sn = Math.sin(a);
      o.player.pos.set(r.object.position.x + d[0] * c + d[2] * sn, r.object.position.y, r.object.position.z - d[0] * sn + d[2] * c);
      o.player.updateCamera(true);
    });
    await s.page.waitForTimeout(500);
    await s.page.keyboard.press('e');
    await s.page.waitForFunction(() => (window as unknown as { __office: O }).__office.traversal.state === 'flying', null, { timeout: 12_000 });
    await s.page.waitForTimeout(1200);
    const clip = await humanData(s.page, 'clip');
    check(`${l.name}: the helicopter pilot sits in the driving pose`, clip === 'drive_seated', String(clip));
    const clearance = await headClearance(s.page, 'helicopter');
    check(`${l.name}: the pilot's head clears the cabin roof`, clearance.roof !== null && clearance.gap > 0.02, JSON.stringify(clearance));
    await s.page.evaluate(() => { const x = (window as unknown as { __office: O }).__office; x.player.camYaw = x.player.facing - Math.PI / 2; x.player.camDist = 5.5; x.player.camPitch = 0.12; });
    await s.page.waitForTimeout(400);
    await s.page.screenshot({ path: resolve(out2, `10-helicopter-pilot-${l.name}.jpg`), quality: 80 });
    await s.page.keyboard.press('e');
    await s.page.waitForFunction(() => (window as unknown as { __office: O }).__office.traversal.state === 'walking', null, { timeout: 12_000 });
    check(`${l.name}: helicopter pilot section has no console errors`, s.errors.length === 0, s.errors.slice(0, 3).join(' | '));
    await s.context.close();
  }

  // ---------------------------------------------------------------- E. CHAR-02 reduced motion and Save-Data
  for (const v of [{ name: 'reduced-motion', reducedMotion: true, saveData: false }, { name: 'save-data', reducedMotion: false, saveData: true }]) {
    const s = await open(browser, { width: 874, height: 402, touch: true, reducedMotion: v.reducedMotion, saveData: v.saveData });
    const extraRequests: string[] = [];
    s.page.on('request', (r) => { if (/clips-extra-/.test(r.url())) extraRequests.push(r.url()); });
    await enterGame(s.page);
    await place(s.page, { x: 40, z: 92, yaw: Math.PI / 2, dist: 4.2, pitch: 0.12 }, 2500);
    const seen = new Set<string>();
    await s.page.keyboard.down('Space');
    for (let i = 0; i < 40; i++) { seen.add(String(await humanData(s.page, 'clip'))); await s.page.waitForTimeout(30); }
    await s.page.keyboard.up('Space');
    if (v.reducedMotion) {
      check('reduced motion: a jump keeps the calm held frame, no wide-armed clips', seen.has('airborne_flight') && ![...seen].some((c) => c.startsWith('jump_')), [...seen].join(','));
      await s.page.screenshot({ path: resolve(out2, '09-jump-reduced-motion-874x402.jpg'), quality: 80 });
    } else {
      check('Save-Data: the extra clips are not downloaded and the jump falls back', extraRequests.length === 0 && seen.has('airborne_flight'), `${extraRequests.length} requests; ${[...seen].join(',')}`);
    }
    check(`${v.name}: console has no errors`, s.errors.length === 0, s.errors.slice(0, 3).join(' | '));
    await s.context.close();
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
