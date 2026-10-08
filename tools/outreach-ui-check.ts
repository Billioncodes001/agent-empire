/**
 * ORG-04a acceptance against isolated fixtures only (never the protected 4610 session; no real SMTP or Telegram).
 *   npm run build:client
 *   FIXTURE_OUTREACH=1 FIXTURE_PORT=4760 npx tsx tools/ui-fixture.ts
 *   PREVIEW_OUTREACH=1 PREVIEW_PORT=4761 PREVIEW_PUBLIC=dist/public npx tsx tools/consultancy-preview.ts
 *   FIXTURE_URL=http://localhost:4760/ PREVIEW_URL=http://127.0.0.1:4761/ npx tsx tools/outreach-ui-check.ts
 * Game: the inbox shows the campaign send (exact samples, every recipient, exclusions, sender, cap) and approving it
 * needs a confirmation; the marketing & sales card is staffed and links to the founder desk. Founder desk: campaigns
 * with real counts and honest labels, CSV import with validation, opt-outs, proposed leads, pause/resume, phone
 * layouts, no overflow, keyboard focus and no console errors. Phone sizes only look; the desktop run decides.
 * Screenshots: docs/team/reports/org-04a/.
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:4760/';
const preview = process.env.PREVIEW_URL || 'http://127.0.0.1:4761/';
for (const url of [base, preview]) if (/:4610\b/.test(url)) throw new Error('Refusing the protected 4610 session; use the isolated fixtures.');
const out = resolve(import.meta.dirname, '../docs/team/reports/org-04a');
mkdirSync(out, { recursive: true });

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const squash = (s: string) => s.replace(/\s+/g, ' ');
const noOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function game(browser: Browser, size: { width: number; height: number; touch: boolean }, tag: string, decide: boolean) {
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
  try {
    await page.goto(base);
    await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
    await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10_000 });
    for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    await page.waitForFunction(() => (window as unknown as { __office: { store: { approvals: unknown } } }).__office?.store.approvals, null, { timeout: 20_000 });

    await page.evaluate(() => document.getElementById('btn-inbox')?.click());
    const modal = page.locator('.inbox-modal');
    await modal.waitFor({ timeout: 5000 });
    const row = modal.locator('.inbox-row', { hasText: 'Campaign send' }).first();
    check(`${tag}: the inbox lists the campaign send, raised by Jordan`, (await row.count()) === 1 && /Jordan · Marketing & sales/.test(await row.innerText()), squash(await row.innerText().catch(() => '')));
    await row.click();
    const detail = modal.locator('.inbox-detail');
    const text = squash(await detail.innerText());
    check(`${tag}: two exact sample messages with the server footer and STOP line`, (await detail.locator('.inbox-sample').count()) === 2 && (text.match(/Reply STOP to stop receiving these emails\./g) ?? []).length === 2 && /Northwind Studio Ltd, 14 Harbour Row/.test(text), text.slice(0, 160));
    check(`${tag}: each sample pins the server footer (address and STOP line) below its scrolling body`, (await detail.locator('.inbox-sample-footer').count()) === 2 && /Reply STOP/.test(await detail.locator('.inbox-sample-footer').first().innerText()));
    check(`${tag}: merge fields are filled per recipient`, /You are invited, Ann Lee/.test(text) && /customers like Harbor Labs/.test(text));
    check(`${tag}: recipient count, exclusions, sender, pace and the unverified label`, /4 · one message each/.test(text) && /1 suppressed · 0 invalid/.test(text) && /hello@northwind-fixture\.example/.test(text) && /at most 200 a day/.test(text) && /Drafted by Wren — not verified/.test(text), text.slice(0, 400));
    await detail.locator('.inbox-recipients summary').click();
    check(`${tag}: the full recipient list is shown, without the opted-out address`, (await detail.locator('.inbox-recipients li').count()) === 4 && !/dev@client-fixture/.test(await detail.innerText()));
    check(`${tag}: no budget input for a send`, (await detail.locator('#inbox-budget').count()) === 0);
    check(`${tag}: no horizontal overflow`, await noOverflow(page));
    await page.screenshot({ path: resolve(out, `01-inbox-campaign-send-${tag}.jpg`), quality: 82 });
    if (decide) {
      await detail.getByRole('button', { name: 'Approve send…' }).click();
      const confirm = squash(await detail.locator('.inbox-confirm').innerText());
      check(`${tag}: approving asks for confirmation naming the count and sender`, /Send exactly this message to 4 recipients/.test(confirm) && /hello@northwind-fixture\.example/.test(confirm), confirm);
      check(`${tag}: focus moves to the confirm button`, await page.evaluate(() => document.activeElement?.textContent === 'Confirm send'));
      await page.screenshot({ path: resolve(out, `02-inbox-confirm-send-${tag}.jpg`), quality: 82 });
      await detail.getByRole('button', { name: 'Confirm send' }).click();
      await page.waitForFunction(() => /Approved by/.test(document.querySelector('.inbox-detail')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => undefined);
      check(`${tag}: the send is recorded as approved`, /✓ Approved by Fixture CEO/.test(await detail.innerText()), squash(await detail.innerText()).slice(0, 120));
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Management → Executives: marketing & sales is staffed and rule-based, with a link to the founder desk.
    await page.evaluate(() => (document.querySelector('#status-strip .status-chief') as HTMLButtonElement | null)?.click());
    const card = page.locator('.exec-card[data-role="marketing_sales"]').first();
    await card.waitFor({ timeout: 5000 }).catch(() => undefined);
    await card.scrollIntoViewIfNeeded().catch(() => undefined);
    const cardText = squash(await card.innerText().catch(() => ''));
    check(`${tag}: the marketing & sales card is staffed, rule-based, with real counts`, /Jordan · Marketing & sales/.test(cardText) && /Rule-based/.test(cardText) && /1 campaign/.test(cardText) && /5 leads/.test(cardText) && /1 proposed to accept/.test(cardText), cardText);
    check(`${tag}: the card links to leads and campaigns on the founder desk`, (await card.locator('a[href="/consultancy.html#outreach"]').count()) === 1);
    await card.screenshot({ path: resolve(out, `03-marketing-card-${tag}.jpg`), quality: 82 }).catch(() => page.screenshot({ path: resolve(out, `03-marketing-card-${tag}.jpg`), quality: 82 }));
    check(`${tag}: no console errors`, !errors.length, errors.slice(0, 4).join(' · '));
  } finally {
    await context.close();
  }
}

async function founderDesk(browser: Browser, size: { width: number; height: number; touch: boolean; reduce?: boolean }, tag: string, act: boolean) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.touch, hasTouch: size.touch, reducedMotion: size.reduce ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  try {
    await page.goto(new URL('/login.html', preview).href);
    await page.locator('input[type=password]').fill('founder-preview');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    await page.goto(new URL('/consultancy.html#outreach', preview).href);
    await page.waitForSelector('#campaigns .campaign', { timeout: 20_000 });
    const status = squash(await page.locator('#outreach-status').innerText());
    check(`${tag}: the status line says sending is enabled, the sender, the cap and the pace`, /Outreach sending: enabled/.test(status) && /hello@northstar-preview\.example/.test(status) && /of 200 sent today/.test(status) && /every 3600 s/.test(status), status);
    const cards = page.locator('#campaigns .campaign');
    check(`${tag}: four campaigns`, (await cards.count()) === 4);
    const sending = squash(await page.locator('.campaign[data-state="sending"]').innerText());
    check(`${tag}: the sending campaign reports real counts and the unverified label`, /Drafted by Wren — not verified/.test(sending) && /Recipients 4/i.test(sending) && /Sent 1/i.test(sending) && /Pending 3/i.test(sending), sending.slice(0, 260));
    const waiting = squash(await page.locator('.campaign[data-state="awaiting_approval"]').innerText());
    check(`${tag}: the waiting campaign points to its approval id`, /Waiting for you: A\d+/.test(waiting) && /\/approve A\d+/.test(waiting), waiting.slice(0, 200));
    const attention = squash(await page.locator('.campaign[data-state="needs_attention"]').innerText());
    check(`${tag}: an invalid draft needs attention with the reason`, /Needs attention: .*only \{\{name\}\} and \{\{company\}\}/.test(attention), attention.slice(0, 200));
    const drafting = squash(await page.locator('.campaign[data-state="drafting"]').innerText());
    check(`${tag}: a drafting campaign says nothing was sent`, /No send approved yet/.test(drafting));
    const ledger = squash(await page.locator('.ledger').innerText());
    check(`${tag}: the lawful-basis, no-scraping and no-IMAP statements are shown`, /responsible for having a lawful basis/.test(ledger) && /never scrapes or buys addresses/.test(ledger) && /doesn't read replies/.test(ledger) && /\/optout/.test(ledger));
    check(`${tag}: proposed leads wait for acceptance`, /2 leads proposed by a worker — unconfirmed/.test(ledger));
    check(`${tag}: no horizontal overflow`, await noOverflow(page));
    await page.locator('#outreach').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(out, `04-founder-outreach-${tag}.jpg`), quality: 82 });
    await page.locator('.ledger').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(out, `05-founder-leads-${tag}.jpg`), quality: 82 });
    if (act) {
      // CSV import: one valid row, one refused (no basis), with the reason.
      await page.locator('#lead-csv').fill('name,email,company,source,basis\nHana Ito,hana@client-preview.example,Sora,inbound inquiry,existing customer\nIvo Re,ivo@client-preview.example,Vale,conference,');
      await page.locator('#import-leads').click();
      await page.waitForFunction(() => !document.getElementById('import-report')?.hidden, null, { timeout: 5000 });
      const rep = squash(await page.locator('#import-report').innerText());
      check(`${tag}: CSV import reports added and refused rows with reasons`, /Imported 1 new lead/.test(rep) && /line 3: basis is required/.test(rep), rep);
      // Opt-out.
      await page.locator('#optout-email').fill('cleo@client-preview.example');
      await page.locator('#optout-form button[type=submit]').click();
      await page.waitForFunction(() => /never be emailed again/.test(document.getElementById('optout-report')?.textContent ?? ''), null, { timeout: 5000 });
      check(`${tag}: an opt-out lands on the suppression list`, /cleo@client-preview\.example/.test(await page.locator('#suppression-list').innerText()));
      // Accept a proposed lead.
      await page.getByRole('button', { name: 'Accept fay@client-preview.example' }).click();
      await page.waitForFunction(() => !/Accept fay@/.test(document.getElementById('proposed')?.innerHTML ?? ''), null, { timeout: 5000 });
      check(`${tag}: accepting a proposed lead confirms it`, /1 lead proposed by a worker/.test(await page.locator('#proposed').innerText()));
      // Pause and resume, by keyboard.
      const pause = page.getByRole('button', { name: 'Pause sending' });
      await pause.focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('.campaign[data-state="paused"]', { timeout: 5000 });
      check(`${tag}: pause stops the campaign and says who paused it`, /Paused by CEO/.test(await page.locator('.campaign[data-state="paused"]').innerText()));
      check(`${tag}: keyboard focus returns to the campaign actions`, await page.evaluate(() => document.activeElement?.closest('.campaign') !== null));
      await page.screenshot({ path: resolve(out, `06-founder-paused-${tag}.jpg`), quality: 82 });
      await page.getByRole('button', { name: 'Resume sending' }).click();
      await page.waitForSelector('.campaign[data-state="sending"]', { timeout: 5000 });
      check(`${tag}: resume continues the campaign`, true);
      // New campaign dialog: saved as an internal drafting job for approval.
      await page.locator('#new-campaign').click();
      await page.locator('#campaign-title').fill('Holiday hours');
      await page.locator('#campaign-brief').fill('Tell customers about holiday opening hours. Fixture only.');
      await page.locator('#save-campaign').click();
      await page.waitForFunction(() => /Holiday hours/.test(document.getElementById('campaigns')?.textContent ?? ''), null, { timeout: 5000 });
      const saved = squash(await page.locator('#outreach-status').innerText());
      await page.waitForFunction(() => /Campaign draft: Holiday hours/.test(document.getElementById('jobs')?.textContent ?? ''), null, { timeout: 12_000 }).catch(() => undefined);
      const job = squash(await page.locator('#jobs .job', { hasText: 'Campaign draft: Holiday hours' }).innerText().catch(() => ''));
      check(`${tag}: a new campaign creates an internal drafting job for approval`, /^Internal Campaign draft: Holiday hours Your approval/i.test(job) && /Saved “Holiday hours”/.test(saved), `${job} | ${saved}`);
    }
    check(`${tag}: founder desk has no console errors`, !errors.length, errors.slice(0, 3).join(' · '));
  } finally {
    await ctx.close();
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal'] });
try {
  await game(browser, { width: 874, height: 402, touch: true }, '874x402', false);
  await game(browser, { width: 1440, height: 900, touch: false }, '1440x900', true);
  await founderDesk(browser, { width: 375, height: 812, touch: true, reduce: true }, '375x812', false);
  await founderDesk(browser, { width: 874, height: 402, touch: true }, '874x402', false);
  await founderDesk(browser, { width: 1440, height: 900, touch: false }, '1440x900', true);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
