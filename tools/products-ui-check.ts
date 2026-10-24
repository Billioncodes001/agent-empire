/**
 * FREE-06 acceptance against the isolated products preview only (never the protected 4610 session; fake gh, no GitHub).
 *   npm run build
 *   PREVIEW_PORT=4910 PREVIEW_PUBLIC=dist/public npx tsx tools/products-preview.ts
 *   PREVIEW_URL=http://127.0.0.1:4910/ npx tsx tools/products-ui-check.ts
 * Checks: Settings → Products (office default first, linked product with GitHub name, branch, worker and task counts),
 * the create flow's typed confirmation (fake gh), the product on worker cards and queue rows, the hire dialog's product
 * chooser, and the founder desk's product chooser creating a job bound to the product. Desktop 1440x900 and phone
 * 874x402, reduced motion, no console errors. Screenshots: docs/team/reports/free-06/.
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4910/';
if (/:4610\b/.test(base)) throw new Error('Refusing the protected 4610 session; use the isolated products preview.');
const out = resolve(import.meta.dirname, '../docs/team/reports/free-06');
mkdirSync(out, { recursive: true });
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`); };
const flat = (s: string) => s.replace(/\s+/g, ' ');
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
type Size = { width: number; height: number; touch: boolean };

async function signIn(browser: Browser, size: Size) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, isMobile: size.touch, hasTouch: size.touch, reducedMotion: 'reduce' });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }));
    localStorage.setItem('agent-empire.execution.offered', '1');
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(new URL('/login', base).href);
  await page.locator('input[type=password]').fill('products-preview');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  return { context, page, errors };
}

async function closeModals(page: Page) {
  for (let i = 0; i < 5 && (await page.locator('#modal-root .backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
}

async function game(browser: Browser, size: Size, tag: string, create: boolean) {
  const { context, page, errors } = await signIn(browser, size);
  try {
    await page.goto(base);
    await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
    await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 15_000 }).catch(() => undefined);
    await closeModals(page);
    // A fresh preview empire asks for its founding plan first (HQ only here). The queue is paused and the preview cannot
    // launch a process, so nothing runs; it only gets the dialog out of the way.
    const found = page.locator('button', { hasText: 'Found my city' });
    if (await found.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
      await found.click();
      await page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => /Found my city/.test(b.textContent ?? '')), null, { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      await closeModals(page);
    }

    // Settings → Products.
    await page.evaluate(() => (document.getElementById('btn-settings') as HTMLButtonElement | null)?.click());
    const section = page.locator('.products-section');
    await section.waitFor({ timeout: 8000 });
    await page.waitForSelector('.product-card[data-product=harbour-dental]', { timeout: 8000 });
    await section.scrollIntoViewIfNeeded();
    const cards = await section.locator('.product-card').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.product));
    check(`${tag}: the office repository is the default product, listed first`, cards[0] === 'office', cards.join(','));
    const office = flat(await section.locator('.product-card[data-product=office]').innerText());
    check(`${tag}: the office card says default and shows its GitHub name and branch`, /Default · this office’s repository/i.test(office) && /fixture-user\/northstar-office/.test(office) && /main/.test(office), office);
    const alpha = flat(await section.locator('.product-card[data-product=harbour-dental]').innerText());
    check(`${tag}: the linked product shows client, GitHub name, branch, 1 worker and 1 unfinished task`, /Harbour Dental site/.test(alpha) && /Harbour Dental/.test(alpha) && /fixture-user\/harbour-dental-site/.test(alpha) && /1 worker\b/.test(alpha) && /1 unfinished task\b/.test(alpha), alpha);
    check(`${tag}: the panel says working directories are separate, not a sandbox`, /not a sandbox/i.test(await section.innerText()));
    check(`${tag}: products panel does not overflow`, !(await overflow(page)));
    await page.screenshot({ path: resolve(out, `01-products-panel-${tag}.jpg`), quality: 82 });
    const createForm = section.locator('form[aria-label="Create a GitHub repository"]');
    await createForm.scrollIntoViewIfNeeded();
    check(`${tag}: the create form says gh is reused, nothing new is stored, and the throttle`, /no new credentials are asked for or stored/i.test(await createForm.innerText()) && /\d\/3 this hour/.test(await createForm.innerText()));
    await page.screenshot({ path: resolve(out, `02-products-forms-${tag}.jpg`), quality: 82 });

    if (create) {
      await createForm.locator('input[name=name]').fill('Atlas storefront');
      await createForm.locator('input[name=client]').fill('Atlas Commerce');
      await createForm.locator('input[name=repo]').fill('atlas-storefront');
      await createForm.locator('button[type=submit]').click();
      const dialog = page.locator('.product-confirm');
      await dialog.waitFor({ timeout: 5000 });
      const yes = dialog.locator('button.danger');
      check(`${tag}: creating asks for confirmation; the button stays disabled until the name is typed`, await yes.isDisabled() && /private repository “atlas-storefront”/.test(await dialog.innerText()));
      await dialog.locator('input').fill('atlas-storefront');
      await page.waitForTimeout(300);
      await page.screenshot({ path: resolve(out, `03-create-confirmation-${tag}.jpg`), quality: 82 });
      await yes.click();
      await page.waitForSelector('.product-card[data-product=atlas-storefront]', { timeout: 15_000 }).catch(() => undefined);
      const made = flat(await section.locator('.product-card[data-product=atlas-storefront]').innerText().catch(() => ''));
      check(`${tag}: the created product appears as private on GitHub (fake gh) with its own folder`, /Created on GitHub · private/.test(made) && /fixture-user\/atlas-storefront/.test(made), made);
      const throttle = await section.locator('.product-throttle').innerText();
      check(`${tag}: the throttle now counts the creation and names the next allowed time`, /1\/3 this hour/.test(throttle) && /Next creation allowed at/.test(throttle), throttle);
      await section.locator('.product-card[data-product=atlas-storefront]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(out, `04-created-product-${tag}.jpg`), quality: 82 });
    }
    await closeModals(page);

    // Worker card and queue row show the product.
    const workers = flat(await page.evaluate(() => document.getElementById('workers')?.textContent ?? ''));
    check(`${tag}: the worker card shows its product`, /📦 Harbour Dental site/.test(workers), workers.slice(0, 160));
    await page.locator('#btn-queue').click({ force: true }).catch(() => page.evaluate(() => (document.getElementById('btn-queue') as HTMLButtonElement).click()));
    await page.waitForFunction(() => document.querySelectorAll('.queue-list li').length >= 2, null, { timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    const rows = await page.locator('.queue-list li').allInnerTexts();
    check(`${tag}: the product's queue row names it; the office task has no product label`, rows.some((r) => /Accessibility pass/.test(r) && /📦 Harbour Dental site/.test(r)) && rows.some((r) => /Office: tidy/.test(r) && !/📦/.test(r)), rows.map(flat).join(' | ').slice(0, 300));
    check(`${tag}: queue does not overflow`, !(await overflow(page)));
    await page.screenshot({ path: resolve(out, `05-queue-rows-${tag}.jpg`), quality: 82 });
    await closeModals(page);

    // Hire dialog product chooser (desktop only: desk targeting needs the keyboard).
    if (!size.touch) {
      await page.waitForTimeout(4000);
      const candidates = await page.evaluate(() => {
        const o = (window as unknown as { __office: { office: { interactables: { kind: string; deskId?: string; x: number; z: number }[] }; store: { workerAtDesk(id: string): unknown } } }).__office;
        const desks = o.office.interactables.filter((it) => it.kind === 'desk' && it.deskId);
        return desks.filter((it) => !desks.some((n) => Math.hypot(n.x - it.x, n.z - it.z) < 3 && o.store.workerAtDesk(n.deskId!))).map((x) => ({ x: x.x, z: x.z }));
      });
      await page.evaluate(() => { const o = (window as unknown as { __office: { player: { pos: { set(x: number, y: number, z: number): void }; view: string; camYaw: number; lookPitch: number; facing: number } } }).__office; o.player.view = 'first'; o.player.pos.set(-1.5, 0, -8); o.player.camYaw = Math.PI; o.player.facing = Math.PI; o.player.lookPitch = -0.12; });
      await page.waitForTimeout(2000);
      let found = false;
      // Stand at each free desk and turn until the desk (not a nearby worker) is the target.
      outer: for (const c of candidates.slice(0, 12)) for (const yaw of [Math.PI, 0, Math.PI / 2, -Math.PI / 2]) {
        await page.evaluate((q) => { const o = (window as unknown as { __office: { player: { pos: { set(x: number, y: number, z: number): void }; view: string; camYaw: number; facing: number } } }).__office; o.player.view = 'first'; o.player.pos.set(q.x, 0, q.z); o.player.camYaw = q.yaw; o.player.facing = q.yaw; }, { ...c, yaw });
        if (await page.waitForFunction(() => /Desk \d+ · empty/.test(document.getElementById('hint')?.textContent ?? ''), null, { timeout: 2500 }).then(() => true, () => false)) { found = true; break outer; }
      }
      check(`${tag}: an empty desk is available to hire at`, found, `${candidates.length} candidates; hint “${await page.locator("#hint").textContent().catch(() => "")}”`);
      if (found) {
        await page.keyboard.press('KeyP');
        await page.waitForSelector('.product-choice:not([hidden]) #product-choice', { timeout: 10_000 }).catch(() => undefined);
        const opts = await page.locator('#product-choice option').allInnerTexts();
        check(`${tag}: the hire dialog offers the products, the office by default`, opts.length >= 2 && /this office/.test(opts[0]) && opts.some((o) => /Harbour Dental site/.test(o)) && (await page.locator('#product-choice').inputValue()) === 'office', opts.join(','));
        await page.locator('#product-choice').selectOption('harbour-dental').catch(() => undefined);
        await page.waitForTimeout(800);
        await page.screenshot({ path: resolve(out, `06-hire-dialog-product-${tag}.jpg`), quality: 82 });
        await closeModals(page);
      }
    }
    check(`${tag}: no console errors`, !errors.length, errors.slice(0, 4).join(' · '));
  } finally {
    await context.close();
  }
}

async function founderDesk(browser: Browser, size: Size, tag: string) {
  const { context, page, errors } = await signIn(browser, size);
  try {
    await page.goto(new URL('/consultancy.html', base).href);
    await page.locator('#new-job').click();
    await page.waitForSelector('#product-option:not([hidden])', { timeout: 8000 }).catch(() => undefined);
    check(`${tag}: the founder desk brief offers a product chooser`, await page.locator('#product-option').isVisible());
    const opts = await page.locator('#product-select option').allInnerTexts();
    check(`${tag}: the chooser lists the office first and the linked product`, /this office/.test(opts[0] ?? '') && opts.some((o) => /Harbour Dental site/.test(o)), opts.join(','));
    await page.locator('#brief-form input[name=client]').fill('Harbour Dental');
    await page.locator('#brief-form input[name=title]').fill(`Reminder emails ${tag}`);
    await page.locator('#brief-form textarea[name=brief]').fill('Synthetic preview brief: send appointment reminders. Nothing runs.');
    await page.locator('#product-select').selectOption('harbour-dental');
    await page.screenshot({ path: resolve(out, `07-founder-desk-product-${tag}.jpg`), quality: 82 });
    await page.locator('#save-job').click();
    await page.waitForTimeout(300);
    check(`${tag}: the review step names the product`, /Product: Harbour Dental site/.test(await page.locator('#brief-review').innerText()));
    await page.locator('#save-job').click();
    await page.waitForTimeout(1200);
    const jobs = await page.evaluate(async () => (await (await fetch('/api/consultancy/jobs', { credentials: 'same-origin' })).json()).jobs as { title: string; productId?: string; decision: string }[]);
    const job = jobs.find((j) => j.title === `Reminder emails ${tag}`);
    check(`${tag}: the saved job is bound to the product and still awaits approval`, job?.productId === 'harbour-dental' && job?.decision === 'pending_approval', JSON.stringify(job));
    check(`${tag}: founder desk does not overflow`, !(await overflow(page)));
    await page.screenshot({ path: resolve(out, `08-founder-desk-job-${tag}.jpg`), quality: 82 });
    check(`${tag}: founder desk has no console errors`, !errors.length, errors.slice(0, 3).join(' · '));
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal'] });
try {
  await game(browser, { width: 1440, height: 900, touch: false }, '1440x900', true);
  await game(browser, { width: 874, height: 402, touch: true }, '874x402', false);
  await founderDesk(browser, { width: 1440, height: 900, touch: false }, '1440x900');
  await founderDesk(browser, { width: 874, height: 402, touch: true }, '874x402');
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
