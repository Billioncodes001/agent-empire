/**
 * FREE-10 acceptance against isolated fixtures only (never the protected 4610 session). The model is fake (no network).
 *   npm run build:client
 *   FIXTURE_PORT=4930 FIXTURE_CHIEF=1 FIXTURE_ENGINES=free npx tsx tools/ui-fixture.ts
 *   PREVIEW_PORT=4931 PREVIEW_CHIEF=1 PREVIEW_PUBLIC=dist/public npx tsx tools/consultancy-preview.ts
 *   FIXTURE_URL=http://localhost:4930/ PREVIEW_URL=http://127.0.0.1:4931/ npx tsx tools/memory-ui-check.ts
 * Checks: the game inbox's lesson item (decision only, provenance, model tag, approve → in use), the plan's "Based on
 * lessons", and the founder desk's Memory panel (list, filters, provenance, add a note → inbox, edit → re-approval,
 * retire, Markdown export). Desktop 1440x900 and phone 874x402, reduced motion, no console errors, no overflow.
 * Screenshots: docs/team/reports/free-10/.
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:4930/';
const preview = process.env.PREVIEW_URL || 'http://127.0.0.1:4931/';
for (const url of [base, preview]) if (/:4610\b/.test(url)) throw new Error('Refusing the protected 4610 session; use the isolated fixtures.');
const out = resolve(import.meta.dirname, '../docs/team/reports/free-10');
mkdirSync(out, { recursive: true });

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const flat = (s: string) => s.replace(/\s+/g, ' ');
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
type Size = { width: number; height: number; touch: boolean };

async function game(browser: Browser, size: Size, tag: string, approve: boolean) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, isMobile: size.touch, hasTouch: size.touch, reducedMotion: 'reduce' });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }));
    localStorage.setItem('agent-empire.execution.offered', '1');
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*404/i.test(m.text())) errors.push(`console: ${m.text()}`); });
  try {
    await page.goto(base);
    await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
    await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10_000 });
    for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    await page.locator('#btn-inbox').click();
    const modal = page.locator('.inbox-modal');
    await modal.waitFor({ timeout: 5000 });
    const pick = async (hasText: string) => {
      const back = modal.locator('.inbox-back');
      if (await back.isVisible().catch(() => false)) { await back.click(); await page.waitForTimeout(200); }
      await modal.locator('.inbox-list:not(.inbox-history) .inbox-row', { hasText }).first().click();
      await page.waitForTimeout(300);
    };
    await pick('Ask workers to open a pull request');
    const d = flat(await modal.locator('.inbox-detail').innerText());
    check(`${tag}: the lesson item shows text, scope, provenance and the model tag`, /Lesson · A\d+/i.test(d) && /Ask workers to open a pull request/.test(d) && /Company-wide/.test(d) && /Chief review · Review of/.test(d) && /Model-backed · gpt-oss:20b · proposals only/.test(d), d.slice(0, 260));
    check(`${tag}: approving is decision only and never reaches worker prompts`, /never goes into a worker prompt by itself/.test(d) && (await modal.locator('.inbox-actions .btn.primary', { hasText: 'Approve lesson…' }).count()) === 1 && !(await modal.locator('#inbox-budget').count()));
    check(`${tag}: the provenance links to the job on the founder desk`, /consultancy\.html\?job=/.test((await modal.locator('.lesson-facts a').first().getAttribute('href')) ?? ''));
    await page.screenshot({ path: resolve(out, `01-inbox-lesson-${tag}.jpg`), quality: 82 });
    await modal.locator('.inbox-actions .btn.primary', { hasText: 'Approve lesson…' }).click();
    const confirm = flat(await modal.locator('.inbox-confirm').innerText());
    check(`${tag}: the confirmation says what approving does`, /The chief may cite it as planning context/.test(confirm), confirm);
    await page.screenshot({ path: resolve(out, `02-inbox-lesson-confirm-${tag}.jpg`), quality: 82 });
    if (approve) {
      await modal.locator('.inbox-confirm .btn.primary').click();
      await page.waitForTimeout(600);
      const decided = flat(await modal.locator('.inbox-detail').innerText());
      check(`${tag}: approving in the inbox puts the lesson in use`, /Approved by /.test(decided) && /is in use/.test(decided), decided.slice(-160));
    } else await modal.locator('.inbox-confirm .btn', { hasText: 'Cancel' }).click();
    await pick('Northstar Studio');
    const plan = modal.locator('.inbox-detail .chief-lessons');
    const line = flat(await plan.locator('summary').innerText().catch(() => ''));
    check(`${tag}: the proposed plan shows "Based on lessons L1"`, /Based on lessons L1/.test(line), line);
    await plan.locator('summary').click().catch(() => undefined);
    await plan.scrollIntoViewIfNeeded().catch(() => undefined);
    check(`${tag}: the lesson text is shown as context, not added to prompts`, /double-booking test/.test(await plan.innerText()) && (await modal.locator('pre.chief-prompt', { hasText: 'double-booking test for one slot' }).count()) === 0);
    check(`${tag}: inbox does not overflow`, !(await overflow(page)));
    await page.screenshot({ path: resolve(out, `03-inbox-plan-lessons-${tag}.jpg`), quality: 82 });
    check(`${tag}: no console errors (game)`, !errors.length, errors.slice(0, 4).join(' · '));
  } finally { await context.close(); }
}

async function desk(browser: Browser, size: Size, tag: string, mutate: boolean) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.touch, hasTouch: size.touch, reducedMotion: 'reduce', acceptDownloads: true });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (dlg) => void dlg.accept());
  try {
    await page.goto(new URL('/login.html', preview).href);
    await page.locator('input[type=password]').fill('founder-preview');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    await page.goto(new URL('/consultancy.html', preview).href);
    await page.waitForSelector('#memory-list .lesson', { timeout: 20_000 });
    const panel = page.locator('#memory');
    await panel.scrollIntoViewIfNeeded();
    const text = flat(await panel.innerText());
    check(`${tag}: Memory lists lessons with status, scope and provenance`, /Approved · in use/i.test(text) && /Waiting for your approval/i.test(text) && /Retired/i.test(text) && /Client · Harbour Dental/i.test(text) && /CEO note/.test(text), text.slice(0, 200));
    check(`${tag}: Memory explains it is reviewed, cited and never self-modifying`, /never added to worker prompts automatically/.test(text) && /Nothing here trains a model/.test(text));
    check(`${tag}: a waiting lesson says it is unused until approved in the inbox`, /Not used until you approve it: decide A\d+ in the game inbox/.test(text));
    check(`${tag}: Memory does not overflow`, !(await overflow(page)));
    await page.screenshot({ path: resolve(out, `04-memory-panel-${tag}.jpg`), quality: 82 });
    await page.locator('#memory-filter-status').selectOption('proposed');
    const statuses = await page.locator('#memory-list .lesson').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.status));
    check(`${tag}: the status filter shows only waiting lessons`, statuses.length > 0 && statuses.every((s) => s === 'proposed'), statuses.join(','));
    await page.locator('#memory-filter-status').selectOption('all');
    await page.locator('#memory-filter-scope').selectOption('client');
    const scopes = await page.locator('#memory-list .lesson .lesson-scope').allInnerTexts();
    check(`${tag}: the scope filter shows only client lessons`, scopes.length === 1 && /Client/i.test(scopes[0]), scopes.join(','));
    await page.locator('#memory-filter-scope').selectOption('all');
    if (mutate) {
      await page.locator('#memory-text').fill('Accessibility passes use a keyboard and a screen reader.');
      await page.locator('#memory-scope').selectOption('role');
      await page.locator('#memory-scope-value select').selectOption('qa_tester');
      await page.locator('#memory-add').click();
      await page.waitForFunction(() => /waits for your approval/.test(document.getElementById('memory-status')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => undefined);
      check(`${tag}: a CEO note goes to the inbox and is not used until approved`, /L\d+ waits for your approval \(A\d+ in the game inbox or Telegram\)\. It is not used until then\./.test(await page.locator('#memory-status').innerText()));
      await page.screenshot({ path: resolve(out, `05-memory-add-note-${tag}.jpg`), quality: 82 });
      const approved = page.locator('#memory-list .lesson[data-status=approved]', { hasText: 'double-booking' }).first();
      await approved.locator('button', { hasText: 'Edit…' }).click();
      const area = page.locator('#memory-list .lesson-edit textarea');
      await area.fill('Booking work always includes double-booking and cancellation tests for one slot.');
      check(`${tag}: editing explains the old lesson stays in use until the edit is approved`, /stays in use until you approve it/.test(await page.locator('#memory-list .lesson-edit').innerText()));
      await page.screenshot({ path: resolve(out, `06-memory-edit-${tag}.jpg`), quality: 82 });
      await page.locator('#memory-list .lesson-edit button[type=submit]').click();
      await page.waitForFunction(() => /Edit L\d+ waits for your approval/.test(document.getElementById('memory-status')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => undefined);
      check(`${tag}: the edit is a new proposal; the original stays approved`, /Edit L\d+ waits/.test(await page.locator('#memory-status').innerText()) && (await page.locator('#memory-list .lesson[data-status=approved]', { hasText: 'double-booking test for one appointment slot' }).count()) === 1);
      const harbour = page.locator('#memory-list .lesson[data-status=approved]', { hasText: 'QA testers start' }).first();
      await harbour.locator('button', { hasText: 'Retire…' }).click();
      await page.waitForTimeout(800);
      check(`${tag}: retiring takes effect straight away`, (await page.locator('#memory-list .lesson[data-status=retired]', { hasText: 'QA testers start' }).count()) === 1);
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.locator('#memory-export').click()]);
      check(`${tag}: export downloads the memory as Markdown`, download.suggestedFilename() === 'agent-empire-memory.md');
    }
    // The plan the chief proposed with lessons: "Based on lessons …" in the job detail.
    await page.locator('.chief-plan-row .quiet', { hasText: 'Review the proposed plan' }).first().click();
    const det = page.locator('#job-detail');
    await det.waitFor({ state: 'visible', timeout: 5000 });
    const lessons = det.locator('.chief-lessons');
    await lessons.locator('summary').click().catch(() => undefined);
    await lessons.scrollIntoViewIfNeeded().catch(() => undefined);
    const lt = flat(await lessons.innerText().catch(() => ''));
    check(`${tag}: the founder desk plan shows "Based on lessons" with the cited text`, /Based on lessons L\d/.test(lt) && /not added to the prompts below/.test(lt), lt.slice(0, 200));
    await page.screenshot({ path: resolve(out, `07-desk-plan-lessons-${tag}.jpg`), quality: 82 });
    await page.keyboard.press('Escape');
    check(`${tag}: founder desk has no console errors`, !errors.length, errors.slice(0, 3).join(' · '));
  } finally { await ctx.close(); }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal'] });
try {
  await game(browser, { width: 1440, height: 900, touch: false }, '1440x900', false);
  await game(browser, { width: 874, height: 402, touch: true }, '874x402', true);
  await desk(browser, { width: 1440, height: 900, touch: false }, '1440x900', true);
  await desk(browser, { width: 874, height: 402, touch: true }, '874x402', false);
} finally { await browser.close(); }
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
