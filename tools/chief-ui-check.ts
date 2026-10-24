/**
 * FREE-02 acceptance against isolated fixtures only (never the protected 4610 session). The model is fake (no network).
 *   npm run build:client
 *   FIXTURE_PORT=4850 FIXTURE_CHIEF=1 FIXTURE_ENGINES=free npx tsx tools/ui-fixture.ts
 *   PREVIEW_PORT=4851 PREVIEW_CHIEF=1 PREVIEW_PUBLIC=dist/public npx tsx tools/consultancy-preview.ts
 *   FIXTURE_URL=http://localhost:4850/ PREVIEW_URL=http://127.0.0.1:4851/ npx tsx tools/chief-ui-check.ts
 * Checks: Settings brain section (off / free / premium, honest labels, cap), the chief card "Model-backed · <model> ·
 * proposals only", the inbox's model-proposed plan, the chief's review and a chief proposal, and the founder desk's
 * proposed plan and needs-attention request. Desktop 1440x900 and phone 874x402, reduced motion, no console errors.
 * Screenshots: docs/team/reports/free-02/.
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:4850/';
const preview = process.env.PREVIEW_URL || 'http://127.0.0.1:4851/';
for (const url of [base, preview]) if (/:4610\b/.test(url)) throw new Error('Refusing the protected 4610 session; use the isolated fixtures.');
const out = resolve(import.meta.dirname, '../docs/team/reports/free-02');
mkdirSync(out, { recursive: true });

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const flat = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

type Size = { width: number; height: number; touch: boolean };

async function game(browser: Browser, size: Size, tag: string) {
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

    // Settings → Chief of staff · planning brain.
    await page.evaluate(() => (document.getElementById('btn-settings') as HTMLButtonElement | null)?.click());
    const section = page.locator('.chief-brain-section');
    await section.waitFor({ timeout: 8000 }).catch(() => undefined);
    await page.waitForFunction(() => document.querySelector('.chief-status')?.getAttribute('data-ready') === 'true', null, { timeout: 8000 }).catch(() => undefined);
    await section.scrollIntoViewIfNeeded().catch(() => undefined);
    const st = flat(await section.innerText().catch(() => ''));
    check(`${tag}: Settings offers off / free local / premium with honest labels`, /Off · rule-based/i.test(st) && /Free · local model/i.test(st) && /Premium · your API key/i.test(st) && /Never city credits/i.test(st), st.slice(0, 160));
    check(`${tag}: the free brain says US$0 and names its local model`, /Free · gpt-oss:20b on this computer \(Ollama\) · US\$0/i.test(st));
    check(`${tag}: brain settings do not overflow`, !(await overflow(page)));
    await page.screenshot({ path: resolve(out, `01-brain-settings-free-${tag}.jpg`), quality: 82 });
    await section.locator('input[value=premium]').check({ force: true });
    await page.waitForTimeout(200);
    const prem = flat(await section.innerText());
    check(`${tag}: premium shows provider, model, price and a daily cap (default $2)`, /Daily cap/i.test(prem) && (await section.locator('input[name=dailyCapUsd]').inputValue()) === '2' && /price/i.test(prem));
    await section.locator('input[name=dailyCapUsd]').scrollIntoViewIfNeeded().catch(() => undefined);
    await page.screenshot({ path: resolve(out, `02-brain-settings-premium-${tag}.jpg`), quality: 82 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    for (let i = 0; i < 3 && (await page.locator('#modal-root .backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }

    // Management → Executives: the chief card.
    await page.evaluate(() => (document.querySelector('#status-strip .status-chief') as HTMLButtonElement | null)?.click());
    const card = page.locator('.exec-card[data-role=chief_of_staff]').first();
    await card.waitFor({ timeout: 8000 }).catch(() => undefined);
    await card.scrollIntoViewIfNeeded().catch(() => undefined);
    const c = flat(await card.innerText().catch(() => ''));
    check(`${tag}: chief card reads "Model-backed · gpt-oss:20b · proposals only"`, /Model-backed · gpt-oss:20b · proposals only/i.test(c), c.slice(0, 160));
    const others = await page.locator('.exec-card:not([data-role=chief_of_staff]) .empire-tag').allInnerTexts();
    check(`${tag}: the other executives stay Rule-based`, others.length >= 4 && others.every((t) => /Rule-based/i.test(t)), others.join(','));
    await page.screenshot({ path: resolve(out, `03-chief-card-${tag}.jpg`), quality: 82 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Inbox: the model-proposed plan, the chief proposal, then the reviewed job.
    await page.locator('#btn-inbox').click();
    const modal = page.locator('.inbox-modal');
    await modal.waitFor({ timeout: 5000 });
    // On a phone the inbox shows the list or the detail; step back to the list before picking another row.
    const pick = async (hasText: string, history = false) => {
      const back = modal.locator('.inbox-back');
      if (await back.isVisible().catch(() => false)) { await back.click(); await page.waitForTimeout(200); }
      if (history) { const box = modal.locator('details.inbox-history-box'); if (!(await box.evaluate((d) => (d as HTMLDetailsElement).open))) await box.locator('summary').click(); }
      await modal.locator(history ? '.inbox-history .inbox-row' : '.inbox-list:not(.inbox-history) .inbox-row', { hasText }).first().click();
      await page.waitForTimeout(300);
    };
    await pick('Northstar Studio');
    const plan = flat(await modal.locator('.inbox-detail').innerText());
    check(`${tag}: inbox plan is tagged model-backed with roles and order`, /Model-backed · gpt-oss:20b · proposals only/i.test(plan) && /Backend engineer/i.test(plan) && /parallel with the item before/i.test(plan) && /Estimate \(not a quote\)/i.test(plan), plan.slice(0, 200));
    // Review fix 2: every item's full prompt is on screen where the plan is approved.
    const prompts = await modal.locator('.inbox-detail pre.chief-prompt').allInnerTexts();
    check(`${tag}: the inbox shows all 4 full item prompts before approval`, prompts.length === 4 && prompts.every((p) => /^Role: /.test(p) && /Synthetic fixture\.$/.test(p.trim())), String(prompts.length));
    await modal.locator('.inbox-detail pre.chief-prompt').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(out, `04b-inbox-plan-prompts-${tag}.jpg`), quality: 82 });
    check(`${tag}: approving the plan is still the CEO's decision`, (await modal.locator('.inbox-actions .btn.primary', { hasText: 'Approve plan…' }).count()) === 1);
    await page.screenshot({ path: resolve(out, `04-inbox-proposed-plan-${tag}.jpg`), quality: 82 });
    await pick('repeated failures');
    const prop = flat(await modal.locator('.inbox-detail').innerText());
    check(`${tag}: a chief proposal shows the situation, the suggestion and "records your decision only"`, /Chief proposal/i.test(prop) && /Repeated failures/i.test(prop) && /records your decision only/i.test(prop) && /Dismiss…/i.test(prop), prop.slice(150, 600));
    await page.screenshot({ path: resolve(out, `05-inbox-chief-proposal-${tag}.jpg`), quality: 82 });
    await pick('Harbour Dental', true);
    const rev = flat(await modal.locator('.inbox-detail').innerText());
    check(`${tag}: the review summary and recommendation show, labelled as not an acceptance`, /Chief reviews/i.test(rev) && /Recommends changes/i.test(rev) && /not an acceptance/i.test(rev), rev.slice(0, 220));
    await modal.locator('.chief-reviews').scrollIntoViewIfNeeded().catch(() => undefined);
    check(`${tag}: inbox does not overflow`, !(await overflow(page)));
    await page.screenshot({ path: resolve(out, `06-inbox-review-${tag}.jpg`), quality: 82 });
    check(`${tag}: no console errors`, !errors.length, errors.slice(0, 4).join(' · '));
  } finally {
    await context.close();
  }
}

async function founderDesk(browser: Browser, size: Size, tag: string) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.touch, hasTouch: size.touch, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text()); });
  try {
    await page.goto(new URL('/login.html', preview).href);
    await page.locator('input[type=password]').fill('founder-preview');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    await page.goto(new URL('/consultancy.html', preview).href);
    await page.waitForSelector('.chief-plan-row', { timeout: 20_000 });
    const aside = flat(await page.locator('aside.chief').innerText());
    check(`${tag}: desk chief says model-backed and lists plan requests`, /Model-backed · gpt-oss:20b · proposals only/i.test(aside) && /Proposed · your approval/i.test(aside), aside.slice(0, 200));
    check(`${tag}: a malformed answer needs attention with the reason, nothing created`, /Needs attention/i.test(aside) && /not a usable plan/i.test(aside) && /Nothing was created/i.test(aside));
    await page.locator('aside.chief').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(out, `07-founder-desk-chief-${tag}.jpg`), quality: 82 });
    await page.locator('.chief-plan-row .quiet', { hasText: 'Review the proposed plan' }).first().click();
    const det = page.locator('#job-detail');
    await det.waitFor({ state: 'visible', timeout: 5000 });
    const d = flat(await det.innerText());
    check(`${tag}: proposed plan shows the model tag, roles, order and full prompts with the estimate`, /Proposed by the chief · Model-backed · gpt-oss:20b/i.test(d) && /Frontend engineer · after item 1/i.test(d) && /Role: Backend engineer\./i.test(d) && /Provider cost/i.test(d), d.slice(0, 240));
    await det.locator('.chief-proposed').scrollIntoViewIfNeeded().catch(() => undefined);
    check(`${tag}: desk does not overflow`, !(await overflow(page)));
    await page.screenshot({ path: resolve(out, `08-founder-desk-proposed-plan-${tag}.jpg`), quality: 82 });
    await page.keyboard.press('Escape');
    await page.locator('#new-job').click();
    await page.waitForTimeout(300);
    check(`${tag}: the intake offers "Ask the chief to propose the work items"`, await page.locator('#chief-option').isVisible());
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
  await founderDesk(browser, { width: 874, height: 402, touch: true }, '874x402');
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
