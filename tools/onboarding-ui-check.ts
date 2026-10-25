/**
 * FREE-08 acceptance against isolated UI fixtures only (never the protected 4610 session):
 *   npm run build:client
 *   FIXTURE_PORT=4981 FIXTURE_ONBOARDING=new FIXTURE_ENGINES=free FIXTURE_CHIEF=1 npx tsx tools/ui-fixture.ts
 *   FIXTURE_PORT=4982 FIXTURE_ONBOARDING=legacy npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://localhost:4981/ LEGACY_URL=http://localhost:4982/ npx tsx tools/onboarding-ui-check.ts
 * Walks the first-run onboarding (company, workers, notifications, approvals), sends tests to the fixture's fake
 * Telegram/ntfy/SMTP servers only, checks that secrets are never shown back, keyboard focus, resume from Settings,
 * reduced motion, Save-Data, phone widths, and that an old install is not offered onboarding. Screenshots go to
 * docs/team/reports/free-08/; exits non-zero on any failed check. No real network send, no model, no paid call.
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:4981/';
const legacyBase = process.env.LEGACY_URL || 'http://localhost:4982/';
for (const u of [base, legacyBase]) if (/:4610\b/.test(u)) throw new Error('Refusing the protected 4610 session; use the UI fixture.');
const out = resolve(import.meta.dirname, '../docs/team/reports/free-08');
mkdirSync(out, { recursive: true });
const FAKE_TOKEN = `123456789:${'F'.repeat(35)}`;
const FAKE_PASS = 'fixture-smtp-password';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function open(browser: Browser, url: string, o: { width: number; height: number; touch: boolean; reduced?: boolean; saveData?: boolean }) {
  const context = await browser.newContext({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: 1, isMobile: o.touch, hasTouch: o.touch, reducedMotion: o.reduced ? 'reduce' : 'no-preference' });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  await context.addInitScript(() => localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } })));
  if (o.saveData) await context.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true } }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*40[34]/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(url);
  await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
  await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10_000 });
  return { context, page, errors };
}

const fixtureInfo = async (url: string) => (await (await fetch(new URL('/__fixture/onboarding', url))).json()) as { ntfy: string; smtpPort: number; hits: string[]; progress: { status: string; current: string } };
const modal = (p: Page) => p.locator('.onboarding-modal');
const stepTitle = (p: Page) => modal(p).locator('#ob-title').textContent();
async function next(p: Page) {
  await modal(p).locator('footer button.primary').click();
  await p.waitForTimeout(500);
}
/** Visible toasts that overlap the onboarding dialog's header or step rail (DEVTEST-02: they used to stack over the tabs). */
async function toastsOverHeader(p: Page) {
  return p.evaluate(() => {
    const m = document.querySelector('.onboarding-modal');
    const zones = [m?.querySelector('header'), m?.querySelector('.ob-rail')].filter(Boolean).map((e) => (e as HTMLElement).getBoundingClientRect());
    const toasts = [...document.querySelectorAll('#toasts .toast')].filter((t) => t.getClientRects().length && getComputedStyle(t).visibility !== 'hidden').map((t) => t.getBoundingClientRect());
    const hit = toasts.filter((t) => zones.some((z) => t.left < z.right && t.right > z.left && t.top < z.bottom && t.bottom > z.top));
    return { toasts: toasts.length, over: hit.length };
  });
}

async function overflow(p: Page) {
  return p.evaluate(() => {
    const m = document.querySelector('.onboarding-modal') as HTMLElement | null;
    return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, modal: m ? m.scrollWidth - m.clientWidth : -1, right: m ? Math.round(m.getBoundingClientRect().right - window.innerWidth) : 0 };
  });
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal'] });
  try {
    const info0 = await fixtureInfo(base);
    check('fixture starts with nothing sent to the fake servers', info0.hits.length === 0, info0.hits.join(' | '));

    // ---- Review 3: closing onboarding on step 1 keeps the execution offer ----
    const early = await open(browser, base, { width: 1440, height: 900, touch: false });
    await early.page.waitForSelector('.onboarding-modal', { timeout: 20_000 });
    check('opening onboarding alone does not mark the execution offer seen', (await early.page.evaluate(() => localStorage.getItem('agent-empire.execution.offered'))) !== '1');
    await modal(early.page).getByRole('button', { name: 'Finish later' }).click();
    await early.page.waitForTimeout(600);
    check('closing on step 1 keeps the execution offer for later', (await early.page.evaluate(() => localStorage.getItem('agent-empire.execution.offered'))) !== '1');
    await early.context.close();

    // ---- Desktop 1440x900: first run after founding ----
    const d = await open(browser, base, { width: 1440, height: 900, touch: false });
    const p = d.page;
    const offered = await p.waitForSelector('.onboarding-modal', { timeout: 20_000 }).then(() => true, () => false);
    check('a new install is offered onboarding after founding', offered);
    await p.waitForTimeout(700);
    check('dialog is a labelled modal dialog', (await modal(p).getAttribute('role')) === 'dialog' && (await modal(p).getAttribute('aria-modal')) === 'true' && (await modal(p).getAttribute('aria-labelledby')) === 'ob-title');
    check('step 1 is the company profile, "step 1 of 4"', (await stepTitle(p)) === 'Your company' && /step 1 of 4/.test((await modal(p).locator('.empire-eyebrow').textContent()) ?? ''));
    check('focus starts inside the dialog, on the step heading', await p.evaluate(() => document.activeElement?.classList.contains('ob-heading') ?? false));
    check('the rail marks the current step', (await modal(p).locator('.ob-step[aria-current=step]').count()) === 1);
    check('the free path is labelled', /Free · nothing here costs money/.test((await modal(p).locator('.ob-body').textContent()) ?? ''));
    check('no step tab has focus on step 1 (the heading does)', await p.evaluate(() => !document.activeElement?.closest('.ob-rail')));
    // The step-1 screenshot shows the initial focus, so it is taken before the Tab presses below move it along the rail.
    await p.screenshot({ path: resolve(out, '01-company-1440x900.jpg'), quality: 82 });
    // Tab stays inside the dialog.
    let trapped = true;
    for (let i = 0; i < 25; i++) { await p.keyboard.press('Tab'); if (!(await p.evaluate(() => !!document.activeElement?.closest('.onboarding-modal')))) trapped = false; }
    check('Tab keeps focus inside the dialog (25 presses)', trapped);
    await modal(p).getByLabel('Company name').fill('Northwind Studio');
    await modal(p).getByLabel('What you do').fill('Booking software for clinics');
    await modal(p).getByLabel('Website (optional)').fill('javascript:alert(1)');
    await next(p);
    check('an invalid website is refused with a plain message', /must start with https/.test((await modal(p).locator('.ob-status').textContent()) ?? '') && (await stepTitle(p)) === 'Your company');
    await modal(p).getByLabel('Website (optional)').fill('https://northwind.example');
    await next(p);
    check('saving moves to step 2 (workers)', (await stepTitle(p)) === 'Who does the work');

    // ---- Workers ----
    await p.waitForSelector('.ob-engine-list', { timeout: 10_000 });
    const engines = (await modal(p).locator('.ob-body').textContent()) ?? '';
    check('workers: free and paid paths are both stated', /Free · Qwen Code with a local model/.test(engines) && /Costs money · Claude Code uses your own Claude subscription/.test(engines));
    check('workers: no Claude login or token field; links to the existing flows', !(await modal(p).locator('input[type=password]').count()) && /never asks for your Claude password or token/.test(engines)
      && (await modal(p).getByRole('button', { name: 'Open Linked accounts…' }).count()) === 1 && (await modal(p).getByRole('button', { name: 'Sign in to Claude…' }).count()) === 1);
    check('workers: model downloads stay behind the Linked accounts confirmation', /Models download only from Linked accounts, after you confirm the name, size and licence/.test(engines) && !(await modal(p).locator('button:has-text("Download")').count()));
    check('workers: default engine choice is labelled', (await modal(p).locator('select[aria-label="Default engine for new hires"]').count()) === 1);
    await p.screenshot({ path: resolve(out, '02-workers-1440x900.jpg'), quality: 82 });
    await modal(p).getByRole('button', { name: 'Open Linked accounts…' }).click();
    const linked = await p.waitForSelector('.linked-accounts', { timeout: 10_000 }).then(() => true, () => false);
    check('"Open Linked accounts…" opens the existing panel above onboarding', linked);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
    check('closing Linked accounts returns to onboarding', (await modal(p).count()) === 1 && (await p.locator('.linked-accounts').count()) === 0);
    await modal(p).getByRole('button', { name: 'Skip this step' }).click();
    await p.waitForTimeout(500);
    check('a step can be skipped', (await stepTitle(p)) === 'How the office reaches you' && (await modal(p).locator('.ob-step[data-state=skipped]').count()) === 1);
    check('answering the Workers step marks the execution offer seen', (await p.evaluate(() => localStorage.getItem('agent-empire.execution.offered'))) === '1');

    // ---- Notifications ----
    const fx = await fixtureInfo(base);
    await p.screenshot({ path: resolve(out, '03-notifications-empty-1440x900.jpg'), quality: 82 });
    const body = modal(p).locator('.ob-body');
    const tg = body.locator('fieldset.ob-channel').nth(0), nt = body.locator('fieldset.ob-channel').nth(1), em = body.locator('fieldset.ob-channel').nth(2);
    check('each channel says it is free', /Free · Telegram bots are free/.test((await tg.textContent()) ?? '') && /Free · ntfy\.sh is free/.test((await nt.textContent()) ?? '') && /Free · with your own mail account/.test((await em.textContent()) ?? ''));
    await tg.getByLabel('Bot token').fill(FAKE_TOKEN);
    await tg.getByLabel('Your Telegram user ID').fill('4242');
    await nt.getByLabel('Server').fill(fx.ntfy);
    await nt.getByRole('button', { name: 'Use a random topic' }).click();
    const topic = await nt.getByLabel('Topic').inputValue();
    check('a random, long ntfy topic is suggested', /^empire-[a-z2-9]{20}$/.test(topic), topic);
    await em.getByLabel('SMTP server').fill('127.0.0.1');
    await em.getByLabel('Port').fill(String(fx.smtpPort));
    await em.getByLabel('User name').fill('bot@example.com');
    await em.getByLabel('SMTP password').fill(FAKE_PASS);
    await em.getByLabel('Send to').fill('ceo@example.com');
    check('nothing is sent while typing', (await fixtureInfo(base)).hits.length === 0);
    for (const [box, name, rx] of [[tg, 'telegram', /telegram: POST \/bot<token>\/sendMessage 4242/], [nt, 'ntfy', new RegExp(`ntfy: POST / ${topic}`)], [em, 'email', /smtp: RCPT TO:<ceo@example\.com>/]] as const) {
      const before = (await fixtureInfo(base)).hits.length;
      await p.evaluate(() => { const st = document.querySelector('.ob-status'); if (st) { st.textContent = ''; st.removeAttribute('data-tone'); } });
      await box.getByRole('button', { name: 'Save and send test' }).click();
      await p.waitForFunction(() => /^Sent a test/.test(document.querySelector('.ob-status')?.textContent ?? '') || document.querySelector('.ob-status')?.getAttribute('data-tone') === 'error', null, { timeout: 10_000 }).catch(() => {});
      const hits = (await fixtureInfo(base)).hits;
      check(`${name}: "Save and send test" reaches only the fake ${name} server, once`, hits.length > before && hits.slice(before).some((h) => rx.test(h)), `${await modal(p).locator('.ob-status').textContent()} | ${hits.slice(before).join(' | ')}`);
      await p.waitForTimeout(300);
    }
    const html = await p.content();
    check('no secret is shown back after saving', !html.includes(FAKE_TOKEN) && !html.includes(FAKE_PASS) && (await body.locator('input[type=password]').evaluateAll((els) => els.every((e) => (e as HTMLInputElement).value === ''))));
    check('saved secrets are shown only as present', (await body.locator('.ob-secret-state[data-present=true]').count()) === 2 && /Saved · type to replace/.test((await tg.getByLabel('Bot token').getAttribute('placeholder')) ?? ''));
    check('saved channels say they do not deliver in this preview', /saved, not delivering in this preview/.test((await tg.textContent()) ?? ''));
    const t1 = await toastsOverHeader(p);
    check('1440x900: "test sent" toasts never cover the dialog header or step tabs', t1.toasts > 0 && t1.over === 0, JSON.stringify(t1));
    await p.screenshot({ path: resolve(out, '04-notifications-saved-and-tested-1440x900.jpg'), quality: 82, fullPage: false });
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await p.screenshot({ path: resolve(out, '04b-notifications-email-1440x900.jpg'), quality: 82 });
    await next(p);

    // ---- Approvals ----
    check('step 4: approvals', (await stepTitle(p)) === 'What needs your approval');
    const rules = await modal(p).locator('.ob-rules tbody tr').count();
    check('who approves what is listed (read-only)', rules >= 6 && /Only your own Telegram account/.test((await modal(p).locator('.ob-rules').textContent()) ?? ''));
    await p.waitForTimeout(500);
    check('chief premium cap is prefilled from the chief settings', /^\d+(\.\d+)?$/.test(await modal(p).getByLabel('Chief’s daily premium cap (US$)').inputValue()));
    await modal(p).getByLabel('Daily budget for all workers (US$)').fill('25');
    await p.screenshot({ path: resolve(out, '05-approvals-1440x900.jpg'), quality: 82 });
    await next(p);
    check('finishing shows a summary', (await stepTitle(p)) === 'Your office is set up' && /Workers · skipped/.test((await modal(p).locator('.ob-summary').textContent()) ?? ''));
    await p.screenshot({ path: resolve(out, '06-finished-1440x900.jpg'), quality: 82 });
    await next(p);
    check('Close closes the dialog', (await modal(p).count()) === 0);
    check('the separate execution offer did not stack on top', (await p.locator('.exec-offer').count()) === 0);
    check('desktop: no console errors', d.errors.length === 0, d.errors.join(' | '));
    await d.context.close();

    const done = await fixtureInfo(base);
    check('progress is saved on the host as done', done.progress.status === 'done', JSON.stringify(done.progress));

    // ---- Phone landscape 874x402, reduced motion + Save-Data: not offered again; re-open from Settings ----
    const m = await open(browser, base, { width: 874, height: 402, touch: true, reduced: true, saveData: true });
    await m.page.waitForTimeout(4000);
    check('a finished setup is not offered again', (await modal(m.page).count()) === 0);
    await m.page.evaluate(() => (document.getElementById('btn-settings') as HTMLButtonElement | null)?.click());
    await m.page.waitForSelector('.onboarding-section', { timeout: 10_000 });
    check('Settings has a Company setup entry with progress', /3 of 4 steps answered|4 of 4 steps answered/.test((await m.page.locator('.onboarding-section').textContent()) ?? ''));
    await m.page.locator('.onboarding-section button').click();
    await m.page.waitForSelector('.onboarding-modal .ob-heading', { timeout: 10_000 });
    await m.page.waitForTimeout(500);
    check('re-opened from Settings', (await modal(m.page).count()) === 1);
    const anim = await m.page.evaluate(() => getComputedStyle(document.querySelector('.ob-body > *')!).animationName);
    check('reduced motion: step transitions are off', anim === 'none', anim);
    const o1 = await overflow(m.page);
    check('874x402: no horizontal overflow', o1.doc <= 0 && o1.modal <= 0 && o1.right <= 0, JSON.stringify(o1));
    await m.page.screenshot({ path: resolve(out, '07-reopened-874x402.jpg'), quality: 82 });
    const touchTargets = await m.page.evaluate(() => [...document.querySelectorAll('.onboarding-modal footer button:not([hidden]), .onboarding-modal .ob-step')].filter((b) => b.getClientRects().length).every((b) => (b as HTMLElement).getBoundingClientRect().height >= 40));
    check('phone: buttons and steps are touch-sized (≥40 px)', touchTargets);
    check('Save-Data: the dialog loads no images or video', (await modal(m.page).locator('img, video, canvas').count()) === 0);
    check('phone: no console errors', m.errors.length === 0, m.errors.join(' | '));
    await m.context.close();

    // ---- Phone landscape 667x375 (portrait shows the game's rotate hint by design; see mobile-ui-check) ----
    const s = await open(browser, base, { width: 667, height: 375, touch: true });
    // Re-opening from Settings on the 874 run makes the unfinished setup resumable, so this page load may offer it by
    // itself; Settings › Company setup then reuses that dialog instead of stacking a second one (DEVTEST-02).
    // A player can't reach Settings over the dialog; when it was offered, use it as it is.
    await s.page.waitForTimeout(4000);
    if (!(await modal(s.page).count())) {
      await s.page.evaluate(() => (document.getElementById('btn-settings') as HTMLButtonElement | null)?.click());
      await s.page.waitForSelector('.onboarding-section button', { timeout: 10_000 });
      await s.page.evaluate(() => (document.querySelector('.onboarding-section button') as HTMLButtonElement).click());
    }
    await s.page.waitForSelector('.onboarding-modal .ob-heading', { timeout: 10_000 });
    await s.page.waitForTimeout(800);
    check('667x375: one onboarding dialog is open', (await modal(s.page).count()) === 1, String(await modal(s.page).count()));
    await s.page.waitForFunction(() => document.querySelectorAll('.onboarding-modal .ob-step').length === 4, null, { timeout: 10_000 });
    await s.page.evaluate(() => (document.querySelectorAll('.onboarding-modal .ob-step')[2] as HTMLButtonElement).click());
    await s.page.waitForFunction(() => document.querySelector('#ob-title')?.textContent === 'How the office reaches you', null, { timeout: 10_000 }).catch(() => {});
    await s.page.waitForTimeout(600);
    check('667x375: the screenshot shows the notifications step', (await stepTitle(s.page)) === 'How the office reaches you', (await stepTitle(s.page)) ?? '');
    const o2 = await overflow(s.page);
    check('667x375: notifications step without horizontal overflow', o2.doc <= 0 && o2.modal <= 0 && o2.right <= 0, JSON.stringify(o2));
    await s.page.screenshot({ path: resolve(out, '08-notifications-667x375.jpg'), quality: 82 });
    // Phone: send tests (the channels were saved on the desktop run) and check where the toasts land.
    for (const i of [0, 1]) {
      await s.page.locator('.onboarding-modal fieldset.ob-channel').nth(i).getByRole('button', { name: 'Save and send test' }).click();
      await s.page.waitForTimeout(700);
    }
    const t2 = await toastsOverHeader(s.page);
    check('667x375: "test sent" toasts never cover the dialog header or step tabs', t2.toasts > 0 && t2.over === 0, JSON.stringify(t2));
    await s.page.screenshot({ path: resolve(out, '08b-notifications-toasts-667x375.jpg'), quality: 82 });
    check('667x375: no console errors', s.errors.length === 0, s.errors.join(' | '));
    await s.context.close();

    // ---- Same-origin rule on the fixture's onboarding writes ----
    const evil = await fetch(new URL('/api/settings', base), { method: 'PUT', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ profile: { name: 'Evil' } }) });
    check('a cross-origin settings write is refused (403)', evil.status === 403, String(evil.status));

    // ---- Old install: never offered ----
    const l = await open(browser, legacyBase, { width: 1440, height: 900, touch: false });
    await l.page.waitForTimeout(6000);
    check('an old install is not offered onboarding', (await modal(l.page).count()) === 0);
    await l.page.evaluate(() => (document.getElementById('btn-settings') as HTMLButtonElement | null)?.click());
    await l.page.waitForSelector('.onboarding-section', { timeout: 10_000 });
    await l.page.evaluate(() => document.querySelector('.onboarding-section')?.scrollIntoView({ block: 'center' }));
    await l.page.waitForTimeout(400);
    check('an old install can still open it from Settings', /0 of 4 steps answered/.test((await l.page.locator('.onboarding-section').textContent()) ?? ''));
    await l.page.screenshot({ path: resolve(out, '09-legacy-settings-entry-1440x900.jpg'), quality: 82 });
    check('legacy: no console errors', l.errors.length === 0, l.errors.join(' | '));
    await l.context.close();
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nonboarding-ui-check: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
