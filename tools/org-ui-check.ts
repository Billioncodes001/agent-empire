/**
 * ORG-01/02 acceptance against isolated fixtures only (never the protected 4610 session).
 *   npm run build:client && FIXTURE_PORT=4742 npx tsx tools/ui-fixture.ts
 *   PREVIEW_PORT=4743 PREVIEW_PUBLIC=dist/public npx tsx tools/consultancy-preview.ts
 *   FIXTURE_URL=http://localhost:4742/ PREVIEW_URL=http://127.0.0.1:4743/ npx tsx tools/org-ui-check.ts
 * Checks: executives seated in the loft (not at workstations), E at an executive desk opens its card with the
 * Rule-based label, the Management "Executives" section, the founder desk's estimate + basis + editable budget,
 * and no console errors; desktop 1440x900 and phone 874x402 / 375 px. Screenshots: docs/team/reports/org-01-02/.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:4742/';
const preview = process.env.PREVIEW_URL || 'http://127.0.0.1:4743/';
for (const url of [base, preview]) if (/:4610\b/.test(url)) throw new Error('Refusing the protected 4610 session; use the isolated fixtures.');
const out = resolve(import.meta.dirname, '../docs/team/reports/org-01-02');
mkdirSync(out, { recursive: true });

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

interface Opened { context: BrowserContext; page: Page; errors: string[] }
async function open(browser: Browser, url: string, size: { width: number; height: number; touch: boolean }): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, isMobile: size.touch, hasTouch: size.touch });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }));
    localStorage.setItem('agent-empire.execution.offered', '1');
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*404/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { const p = new URL(r.url()).pathname; if (r.status() === 404 && !p.startsWith('/api/')) errors.push(`404 ${p}`); });
  await page.goto(url);
  return { context, page, errors };
}

async function enterGame(page: Page) {
  await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
  await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10_000 });
  for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
}

type Office = {
  player: { pos: { set(x: number, y: number, z: number): void; y: number }; view: string; camYaw: number; facing: number; lookPitch: number };
  office: { floor: number; executiveInteractables: { role: string; x: number; z: number; y: number }[]; desks: Map<string, unknown> };
  executives: { report(): { role: string; visible: boolean; avatar: string; pose: string; y: number }[] };
  city: { chief: { position: { y: number; z: number }; traverse(f: (o: { name: string; userData: Record<string, unknown> }) => void): void } };
  me: { wearing: { avatar: string } };
  store: { org: { executives: { role: string; active: boolean; attention: number }[] } | null };
};

/** Stands in the loft aisle behind an executive's chair, looking at the desk and over it to the glass. */
async function standAt(page: Page, role: string, view: 'first' | 'third' = 'third') {
  await page.evaluate(([r, v]) => {
    const o = (window as unknown as { __office: Office }).__office;
    const it = o.office.executiveInteractables.find((x) => x.role === r)!;
    o.player.view = v;
    o.player.pos.set(it.x, it.y, it.z + 0.2);
    o.player.camYaw = 0; o.player.facing = 0; o.player.lookPitch = -0.2;
  }, [role, view] as const);
  await page.waitForTimeout(1500);
}

async function game(browser: Browser, size: { width: number; height: number; touch: boolean }, tag: string) {
  const s = await open(browser, base, size);
  try {
    await enterGame(s.page);
    await s.page.waitForFunction(() => !!(window as unknown as { __office: Office }).__office?.store.org, null, { timeout: 20_000 });
    await s.page.waitForTimeout(5000); // bodies stream in
    const report = await s.page.evaluate(() => {
      const o = (window as unknown as { __office: Office }).__office;
      let chief = '';
      o.city.chief.traverse((x) => { if (x.name === 'Realistic human') chief = String(x.userData.avatar); });
      return { execs: o.executives.report(), chiefY: o.city.chief.position.y, chief, me: o.me.wearing.avatar, org: o.store.org!.executives, desks: [...o.office.desks.keys()] };
    });
    const staffed = report.execs.filter((e) => e.visible);
    // ORG-05 staffed research: operations, finance and research sit in the loft; marketing & sales is still empty.
    check(`${tag}: operations, finance and research are seated in the loft`, staffed.length === 3 && staffed.every((e) => e.pose === 'sit' && e.y === 3), JSON.stringify(staffed));
    check(`${tag}: unstaffed roles have no body`, report.execs.filter((e) => ['marketing_sales'].includes(e.role)).length === 0);
    check(`${tag}: the chief of staff sits at its loft desk`, report.chiefY === 3);
    const suits = [report.chief, ...staffed.map((e) => e.avatar)];
    check(`${tag}: executives wear distinct suits, never the CEO's`, new Set(suits).size === suits.length && !suits.includes(report.me), `${report.me} vs ${suits.join(',')}`);
    check(`${tag}: no executive takes a funded workstation`, !report.desks.some((d) => !/^desk-\d+$/.test(d)));

    // The suite from the stair landing (you look along -sin(yaw), -cos(yaw)), then from the floor below through the glass.
    const shot = async (x: number, y: number, z: number, tx: number, tz: number, pitch: number, name: string) => {
      await s.page.evaluate(([px, py, pz, yaw, lp]) => {
        const o = (window as unknown as { __office: Office }).__office;
        o.player.view = 'first'; o.player.pos.set(px, py, pz); o.player.camYaw = yaw; o.player.facing = yaw; o.player.lookPitch = lp;
      }, [x, y, z, Math.atan2(-(tx - x), -(tz - z)), pitch] as const);
      await s.page.waitForTimeout(2500);
      await s.page.screenshot({ path: resolve(out, `${name}-${tag}.jpg`), quality: 82 });
    };
    await shot(9.6, 3, 12.4, 13.5, 9.3, -0.18, '01-loft-executives');
    await shot(13.2, 0, 3.2, 13.2, 9, 0.42, '01b-executives-through-the-glass');

    await standAt(s.page, 'finance');
    const hint = await s.page.locator('#hint').innerText().catch(() => '');
    check(`${tag}: the desk hint names the executive and says Rule-based`, /Priya · Finance/.test(hint) && /Rule-based/.test(hint), hint.replace(/\s+/g, ' '));
    if (size.touch) await s.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e' })));
    else await s.page.keyboard.press('KeyE');
    const card = s.page.locator('.exec-modal');
    await card.waitFor({ timeout: 5000 }).catch(() => undefined);
    const text = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(`${tag}: E opens the finance card with the Rule-based label, summary and attention`, /Priya · Finance/.test(text) && /Rule-based/.test(text) && /Today \$1\.20 of \$10\.00/.test(text) && /reached the approved budget/.test(text), text.slice(0, 200));
    const overflow = await s.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(`${tag}: no horizontal overflow with the card open`, !overflow);
    await s.page.screenshot({ path: resolve(out, `02-executive-card-${tag}.jpg`), quality: 82 });
    await s.page.keyboard.press('Escape');
    await s.page.waitForTimeout(300);

    // Management → Executives.
    await s.page.evaluate(() => (document.querySelector('#status-strip .status-chief') as HTMLButtonElement | null)?.click());
    const section = s.page.locator('section[aria-labelledby=empire-executives]');
    await section.waitFor({ timeout: 5000 }).catch(() => undefined);
    await section.scrollIntoViewIfNeeded().catch(() => undefined);
    const sec = (await section.innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(`${tag}: Management lists five executives, marketing "Not staffed yet"`, (await section.locator('.exec-card').count()) === 5 && (sec.match(/Not staffed yet/g) ?? []).length >= 1, sec.slice(0, 160));
    check(`${tag}: Management executives are labelled rule-based`, /rule-based/i.test(sec));
    await s.page.screenshot({ path: resolve(out, `03-management-executives-${tag}.jpg`), quality: 82 });
    check(`${tag}: no console errors`, !s.errors.length, s.errors.slice(0, 4).join(' · '));
  } finally {
    await s.context.close();
  }
}

async function founderDesk(browser: Browser, size: { width: number; height: number; touch: boolean }, tag: string) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.touch, hasTouch: size.touch });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  try {
    // Sign in to the isolated preview with its documented fixture password.
    await page.goto(new URL('/login.html', preview).href);
    await page.locator('input[type=password]').fill('founder-preview');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    await page.goto(new URL('/consultancy.html', preview).href);
    await page.waitForSelector('#jobs .job', { timeout: 20_000 });
    await page.locator('#jobs .job', { hasText: 'Your approval' }).first().click();
    const est = page.locator('#job-detail .estimate');
    await est.waitFor({ timeout: 5000 }).catch(() => undefined);
    const text = (await est.innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(`${tag}: founder-desk review shows the estimate with its basis`, /Provider cost/.test(text) && /\$\d+\.\d\d–\$\d+\.\d\d/.test(text) && /Rough default — no history yet/.test(text), text.slice(0, 200));
    check(`${tag}: each item shows its phase`, /Iteration/i.test(text) && /Field testing/i.test(text));
    const budget = await page.locator('#budget-input').inputValue().catch(() => '');
    check(`${tag}: the budget is editable and defaults to the top of the range`, budget === '12', budget);
    await est.scrollIntoViewIfNeeded().catch(() => undefined);
    check(`${tag}: no horizontal overflow`, !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
    await page.screenshot({ path: resolve(out, `04-founder-desk-estimate-${tag}.jpg`), quality: 82 });
    check(`${tag}: founder desk has no console errors`, !errors.length, errors.slice(0, 3).join(' · '));
  } finally {
    await ctx.close();
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal'] });
try {
  await game(browser, { width: 1440, height: 900, touch: false }, '1440x900');
  await game(browser, { width: 874, height: 402, touch: true }, '874x402');
  await founderDesk(browser, { width: 1440, height: 900, touch: false }, '1440x900');
  await founderDesk(browser, { width: 375, height: 812, touch: true }, '375x812');
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
