/**
 * LIFE-04 acceptance against the isolated UI fixture only (never the protected 4610 session).
 *   npm run build:client && FIXTURE_PORT=4742 FIXTURE_SCENARIO=waiting npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://localhost:4742/ npx tsx tools/life04-ui-check.ts
 * Checks the waiting worker walks to an amenity with "Waiting on Bea — at the …" on its name card, that the working
 * worker types at its desk, that reduced motion places the waiting worker without walking, and that the queue panel shows
 * the blocked row ("Waiting on …") and the held row with Retry/Remove. Screenshots go to docs/team/reports/life-04/.
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:4742/';
if (/:4610\b/.test(base)) throw new Error('Refusing the protected 4610 session; use the UI fixture.');
const out = resolve(import.meta.dirname, '../docs/team/reports/life-04');
mkdirSync(out, { recursive: true });

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0];
// Any stray rejection becomes a FAIL line and a non-zero exit, never a bare Node stack trace.
process.on('unhandledRejection', (e) => { check('unexpected error', false, message(e)); process.exitCode = 1; });

/** Screenshots are evidence, not the check itself: a slow WebGL frame on a busy machine reports FAIL instead of crashing. */
async function shot(page: Page, name: string) {
  try {
    await page.screenshot({ path: resolve(out, name), timeout: 90_000, animations: 'disabled' });
    check(`screenshot ${name}`, true);
  } catch (e) { check(`screenshot ${name}`, false, message(e)); }
}

type QueueRows = { blocked: string; held: string; retry: number; remove: number };
/**
 * The queue modal rebuilds its whole list on every workers/queue/empire event (the fixture republishes every 3 s), so
 * a resolved row can be detached between Playwright's actionability steps ("waiting for element to be stable" →
 * "Element is not attached to the DOM"). Wait for explicit DOM state, then read both rows and scroll in one
 * synchronous evaluate against whichever list is current.
 */
async function readQueue(page: Page): Promise<QueueRows> {
  await page.waitForFunction(() => !!document.querySelector('.queue-list li.blocked .queue-meta') && !!document.querySelector('.queue-list li.held'), null, { timeout: 30_000 });
  return page.evaluate(() => {
    const blocked = document.querySelector<HTMLElement>('.queue-list li.blocked')!;
    const held = document.querySelector<HTMLElement>('.queue-list li.held')!;
    blocked.scrollIntoView({ block: 'nearest' });
    return {
      blocked: blocked.querySelector<HTMLElement>('.queue-meta')!.innerText,
      held: held.innerText,
      retry: [...held.querySelectorAll('button')].filter((b) => b.textContent?.includes('Retry')).length,
      remove: held.querySelectorAll('button[aria-label="Remove"]').length,
    };
  });
}

type Snap = { id: string; phase: string; place: string; activity: string; reason: string; typing: boolean };
const lifeOf = (page: Page, id: string) => page.evaluate((wid) => {
  const o = (window as unknown as { __office: { life: { snapshot(): Snap[] } } }).__office;
  return o.life.snapshot().find((l) => l.id === wid) ?? null;
}, id) as Promise<Snap | null>;

async function open(browser: Browser, width: number, height: number, touch: boolean, reducedMotion = false) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }));
    localStorage.setItem('agent-empire.execution.offered', '1');
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*404/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(base);
  await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
  await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10_000 });
  for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  return { context, page, errors };
}

/** Puts the first-person camera a few metres from a worker, looking at it. */
async function lookAtWorker(page: Page, id: string, distance: number) {
  await page.evaluate(([wid, d]) => {
    const o = (window as unknown as { __office: { workerViews: Map<string, { model: { root: { getWorldPosition(v: object): { x: number; y: number; z: number }; position: { clone(): object } } } }>; player: { pos: { set(x: number, y: number, z: number): void }; view: string; camYaw: number; lookPitch: number; facing: number } } }).__office;
    const root = o.workerViews.get(wid as string)!.model.root;
    const p = root.getWorldPosition(root.position.clone());
    const fx = 0.6, fz = 0.8;
    o.player.view = 'first';
    o.player.pos.set(p.x + fx * (d as number), p.y, p.z + fz * (d as number));
    o.player.camYaw = Math.atan2(fx, fz);
    o.player.facing = o.player.camYaw;
    o.player.lookPitch = -0.1;
  }, [id, distance] as const);
  await page.waitForTimeout(2000);
}

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [w, h, touch, tag] of [[1440, 900, false, '1440x900'], [874, 402, true, '874x402']] as const) {
    let opened: Awaited<ReturnType<typeof open>> | undefined;
    try {
      opened = await open(browser, w, h, touch);
      const { page, errors } = opened;
      await page.waitForFunction(() => {
        const o = (window as unknown as { __office?: { life: { snapshot(): Snap[] } } }).__office;
        const c = o?.life.snapshot().find((l) => l.id === 'fixture-cyrus');
        return !!c && c.place !== 'desk' && c.phase === 'using';
      }, null, { timeout: 90_000 }).catch(() => undefined);
      const cyrus = await lifeOf(page, 'fixture-cyrus');
      const bea = await lifeOf(page, 'fixture-bea');
      check(`${tag}: waiting worker is at an amenity`, !!cyrus && cyrus.place !== 'desk' && cyrus.phase === 'using', JSON.stringify(cyrus));
      check(`${tag}: name card names the blocking worker`, /^Waiting on Bea — at the (coffee bar|cafeteria|gym)$/.test(cyrus?.reason ?? ''), cyrus?.reason ?? '');
      check(`${tag}: waiting worker never types`, cyrus?.typing === false);
      check(`${tag}: working worker types at its desk`, bea?.place === 'desk' && bea.typing === true, JSON.stringify(bea));
      await lookAtWorker(page, 'fixture-cyrus', 3.2);
      await shot(page, `waiting-amenity-${tag}.png`);
      await page.evaluate(() => (document.getElementById('btn-queue') as HTMLElement).click());
      const q = await readQueue(page);
      check(`${tag}: queue shows the blocked task waiting on its dependency`, q.blocked.includes('Waiting on “Build checkout API”'), q.blocked.split('\n')[0]);
      check(`${tag}: queue shows the held task with Retry and Remove`, /Held — dependency “Draft launch email copy” did not finish/.test(q.held)
        && q.retry === 1 && q.remove === 1, q.held.replace(/\s+/g, ' ').slice(0, 120));
      await shot(page, `queue-blocked-${tag}.png`);
      check(`${tag}: no console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    } catch (e) {
      check(`${tag}: check run completed`, false, message(e));
    } finally { await opened?.context.close().catch(() => undefined); }
  }
  // Reduced motion: the waiting worker is placed at the amenity without a walking phase.
  let opened: Awaited<ReturnType<typeof open>> | undefined;
  try {
    opened = await open(browser, 874, 402, true, true);
    const { page, errors } = opened;
    await page.waitForFunction(() => {
      const c = (window as unknown as { __office?: { life: { snapshot(): Snap[] } } }).__office?.life.snapshot().find((l) => l.id === 'fixture-cyrus');
      return !!c && c.place !== 'desk';
    }, null, { timeout: 30_000 }).catch(() => undefined);
    const phases = new Set<string>();
    for (let i = 0; i < 10; i++) { phases.add((await lifeOf(page, 'fixture-cyrus'))?.phase ?? 'none'); await page.waitForTimeout(100); }
    check('reduced motion: waiting worker teleports (never walks)', !phases.has('walk') && phases.has('using'), [...phases].join(','));
    check('reduced motion: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    check('reduced motion: check run completed', false, message(e));
  } finally { await opened?.context.close().catch(() => undefined); }
} catch (e) {
  check('check run completed', false, message(e));
} finally { await browser.close().catch(() => undefined); }

if (!results.length) check('check run completed', false, 'no checks ran');
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
