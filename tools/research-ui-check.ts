/**
 * ORG-05 acceptance against isolated fixtures only (never the protected 4610 session).
 *   npm run build:client
 *   FIXTURE_PORT=4771 FIXTURE_RESEARCH=seed npx tsx tools/ui-fixture.ts
 *   PREVIEW_PORT=4772 PREVIEW_PUBLIC=dist/public PREVIEW_RESEARCH=seed npx tsx tools/consultancy-preview.ts
 *   FIXTURE_URL=http://localhost:4771/ PREVIEW_URL=http://127.0.0.1:4772/ npx tsx tools/research-ui-check.ts
 * The game fixture holds a real ResearchDesk over a real consultancy journal and approval inbox (synthetic reports, fake
 * queue, nothing runs). Checks: the research executive is staffed and its card lists reports and tool proposals, a
 * report opens as text with safe https links and the honest label, a proposal is approved in the inbox and only the
 * decision is recorded, asking creates an internal job awaiting approval, keyboard/Esc, reduced motion, no overflow,
 * no console errors; then the founder desk research section. Screenshots: docs/team/reports/org-05/.
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:4771/';
const preview = process.env.PREVIEW_URL || 'http://127.0.0.1:4772/';
for (const url of [base, preview]) if (/:4610\b/.test(url)) throw new Error('Refusing the protected 4610 session; use the isolated fixtures.');
const out = resolve(import.meta.dirname, '../docs/team/reports/org-05');
mkdirSync(out, { recursive: true });

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

type Office = {
  player: { pos: { set(x: number, y: number, z: number): void }; view: string; camYaw: number; facing: number; lookPitch: number };
  office: { executiveInteractables: { role: string; x: number; z: number; y: number }[] };
  executives: { report(): { role: string; visible: boolean; pose: string }[] };
  store: { org: { executives: { role: string; active: boolean; attention: number; summary: string }[] } | null; research: { reports: { jobId: string; status: string; tools: { decision: string }[] }[]; openProposals: number } | null };
};
const office = <T>(page: Page, fn: (o: Office) => T) => page.evaluate((src) => (0, eval)(`(${src})`)((window as unknown as { __office: unknown }).__office), fn.toString()) as Promise<T>;
const shot = (page: Page, name: string, tag: string) => page.screenshot({ path: resolve(out, `${name}-${tag}.jpg`), quality: 82 });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function pressE(page: Page, touch: boolean) {
  if (touch) await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e' })));
  else await page.keyboard.press('KeyE');
}

async function game(browser: Browser, size: { width: number; height: number; touch: boolean }, tag: string, decide: boolean) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, isMobile: size.touch, hasTouch: size.touch, reducedMotion: decide ? 'no-preference' : 'reduce' });
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
    await page.waitForFunction(() => (window as unknown as { __office: Office }).__office?.store.research, null, { timeout: 20_000 });
    await page.waitForTimeout(4000); // bodies stream in
    const start = await office(page, (o) => ({ exec: o.store.org?.executives.find((e) => e.role === 'research'), body: o.executives.report().find((e) => e.role === 'research'), reports: o.store.research!.reports.length, open: o.store.research!.openProposals }));
    check(`${tag}: research is staffed (Rule-based) with a seated body`, !!start.exec?.active && !!start.body?.visible && start.body.pose === 'sit', JSON.stringify(start.body));
    check(`${tag}: the research executive's attention is its open tool proposals`, start.exec?.attention === start.open && start.open === 2, `${start.exec?.attention}/${start.open}`);

    // Stand at the research desk and press E.
    await page.evaluate(() => {
      const o = (window as unknown as { __office: Office }).__office;
      const it = o.office.executiveInteractables.find((x) => x.role === 'research')!;
      o.player.view = 'third'; o.player.pos.set(it.x, it.y, it.z + 0.2); o.player.camYaw = 0; o.player.facing = 0; o.player.lookPitch = -0.2;
    });
    await page.waitForTimeout(1500);
    const hint = (await page.locator('#hint').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(`${tag}: the desk hint names Sam · Research`, /Sam · Research/.test(hint), hint);
    await pressE(page, size.touch);
    const card = page.locator('.exec-modal[data-role=research]');
    await card.waitFor({ timeout: 5000 }).catch(() => undefined);
    const text = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(`${tag}: E opens the research card: Rule-based, summary and tool proposals waiting`, /Rule-based/.test(text) && /1 report/.test(text) && /2 tool proposals waiting/.test(text), text.slice(0, 220));
    const rows = await card.locator('.research-row').count();
    check(`${tag}: the card lists every report with its state`, rows === start.reports && /Needs attention/.test(text) && /Awaiting your approval/.test(text) && /cites no source URL/.test(text), `${rows} rows`);
    check(`${tag}: report rows show feasibility, confidence, date and cost`, /Partly feasible/.test(text) && /Medium confidence/.test(text) && /\$0\.94 provider cost/.test(text));
    check(`${tag}: no horizontal overflow with the card open`, await noOverflow(page));
    await page.waitForTimeout(400);
    await shot(page, '01-research-card', tag);

    // Open the imported report.
    await card.locator('.research-row[data-status=imported]').evaluate((b) => (b as HTMLButtonElement).click());
    const report = page.locator('.research-modal');
    await report.locator('.research-report').waitFor({ timeout: 5000 }).catch(() => undefined);
    const rtext = (await report.innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(`${tag}: the report view says "Researched by Bea — not verified" and shows all four sections`, /Researched by Bea — not verified/i.test(rtext) && /Findings · 3 sources cited/i.test(rtext) && /What we can do now/i.test(rtext) && /What we can’t do yet and why/i.test(rtext) && /Proposed tools/i.test(rtext), rtext.slice(0, 200));
    const links = await report.locator('a').evaluateAll((as) => as.map((a) => ({ href: (a as HTMLAnchorElement).href, rel: a.getAttribute('rel'), target: a.getAttribute('target') })));
    check(`${tag}: report links are https anchors with rel=noopener`, links.length >= 5 && links.every((l) => l.href.startsWith('https://') && /noopener/.test(l.rel ?? '') && l.target === '_blank'), `${links.length} links`);
    check(`${tag}: no HTML from the report is injected (no script, iframe or inline handlers)`, await report.evaluate((el) => !el.querySelector('script,iframe,img,[onerror],[onclick],[style]')));
    check(`${tag}: no horizontal overflow with the report open`, await noOverflow(page));
    await page.waitForTimeout(400);
    await shot(page, '02-research-report', tag);

    if (decide) {
      // Tool proposal → inbox → approve; only the decision is recorded.
      const jobsBefore = ((await (await page.request.get(new URL('/__fixture/jobs', base).href)).json()) as { jobs: unknown[] }).jobs.length;
      await report.locator('.btn.primary', { hasText: 'Decide tool proposals' }).click();
      const inbox = page.locator('.inbox-modal');
      await inbox.waitFor({ timeout: 5000 }).catch(() => undefined);
      const itext = (await inbox.locator('.inbox-detail').innerText().catch(() => '')).replace(/\s+/g, ' ');
      check(`${tag}: the inbox opens on the tool proposal with URL, licence, enables and risk`, /Tool proposal/i.test(itext) && /Fixture Calendar SDK/.test(itext) && /MIT/.test(itext) && /Enables/i.test(itext) && /Risk/i.test(itext) && /nothing is installed/i.test(itext), itext.slice(0, 220));
      check(`${tag}: a tool proposal has no budget input`, (await page.locator('#inbox-budget').count()) === 0);
      await page.waitForTimeout(300);
      await shot(page, '03-tool-proposal-inbox', tag);
      await inbox.locator('.inbox-actions .btn.primary', { hasText: 'Approve proposal…' }).click();
      const ctext = (await inbox.locator('.inbox-confirm').innerText().catch(() => '')).replace(/\s+/g, ' ');
      check(`${tag}: approving asks to confirm and says nothing is installed`, /Nothing is installed or adopted/.test(ctext), ctext);
      await inbox.locator('.inbox-confirm .btn.primary').click();
      await page.waitForFunction(() => (window as unknown as { __office: Office }).__office.store.research?.reports.some((r) => r.tools.some((t) => t.decision === 'approved')), null, { timeout: 5000 }).catch(() => undefined);
      const after = await office(page, (o) => ({ open: o.store.research!.openProposals, att: o.store.org?.executives.find((e) => e.role === 'research')?.attention }));
      const jobsAfter = ((await (await page.request.get(new URL('/__fixture/jobs', base).href)).json()) as { jobs: unknown[] }).jobs.length;
      check(`${tag}: approval is recorded on the research card and nothing else happens`, after.open === 1 && after.att === 1 && jobsAfter === jobsBefore, JSON.stringify({ ...after, jobsBefore, jobsAfter }));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      check(`${tag}: Esc closes the inbox`, (await inbox.count()) === 0);

      // Ask a question from the research card (keyboard).
      await standAgain(page);
      await pressE(page, size.touch);
      await card.waitFor({ timeout: 5000 }).catch(() => undefined);
      const decided = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
      check(`${tag}: the card shows the recorded decision`, /1 tool proposal to decide/.test(decided) || /1 tool proposal waiting/.test(decided), decided.slice(0, 200));
      await page.locator('#research-question').fill('Which open-source OCR could read scanned invoices on our own server?');
      await page.locator('#research-question').focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => /Saved as an internal job/.test(document.querySelector('.research-status')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => undefined);
      const jobs = ((await (await page.request.get(new URL('/__fixture/jobs', base).href)).json()) as { jobs: { client: string; title: string; decision: string }[] }).jobs;
      const asked = jobs.find((j) => /OCR/.test(j.title));
      check(`${tag}: asking creates an Internal job awaiting approval (keyboard submit)`, asked?.client === 'Internal' && asked.decision === 'pending_approval', JSON.stringify(asked));
      await page.waitForTimeout(400);
      check(`${tag}: the new question is listed`, (await card.locator('.research-row').count()) === start.reports + 1);
      await shot(page, '04-research-asked', tag);
      await page.keyboard.press('Escape');
    }
    check(`${tag}: no console errors`, !errors.length, errors.slice(0, 4).join(' · '));
  } finally {
    await context.close();
  }
}

async function standAgain(page: Page) {
  for (let i = 0; i < 3 && (await page.locator('#modal-root .backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await page.evaluate(() => {
    const o = (window as unknown as { __office: Office }).__office;
    const it = o.office.executiveInteractables.find((x) => x.role === 'research')!;
    o.player.pos.set(it.x, it.y, it.z + 0.2); o.player.camYaw = 0; o.player.facing = 0;
  });
  await page.waitForTimeout(800);
}

async function founderDesk(browser: Browser, size: { width: number; height: number; touch: boolean }, tag: string) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.touch, hasTouch: size.touch });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  try {
    await page.goto(new URL('/login.html', preview).href);
    await page.locator('input[type=password]').fill('founder-preview');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    await page.goto(new URL('/consultancy.html', preview).href);
    await page.waitForSelector('#research-list .research-row', { timeout: 20_000 });
    const section = page.locator('.research-desk');
    await section.scrollIntoViewIfNeeded();
    const text = (await section.innerText()).replace(/\s+/g, ' ');
    check(`${tag}: founder desk lists the report with feasibility, confidence and the honest label`, /Researched by Bea — not verified/i.test(text) && /Partly feasible/.test(text) && /Medium confidence/.test(text) && /1 tool to decide/.test(text), text.slice(0, 220));
    check(`${tag}: founder desk has no horizontal overflow`, await noOverflow(page));
    await page.waitForTimeout(500);
    await shot(page, '05-founder-desk-research', tag);
    await section.locator('.research-row[data-status=imported]').first().click();
    const dlg = page.locator('#research-detail');
    await dlg.locator('.research-report').waitFor({ timeout: 5000 });
    const d = (await dlg.innerText()).replace(/\s+/g, ' ');
    check(`${tag}: the report dialog shows sections and recorded decisions`, /What we can’t do yet and why/i.test(d) && /Approved — decision recorded, nothing installed/.test(d) && /Waiting for your decision/.test(d), d.slice(0, 200));
    const links = await dlg.locator('a').evaluateAll((as) => as.every((a) => (a as HTMLAnchorElement).href.startsWith('https://') && /noopener/.test(a.getAttribute('rel') ?? '')));
    check(`${tag}: dialog links are https with rel=noopener`, links);
    await page.waitForTimeout(400);
    await shot(page, '06-founder-desk-report', tag);
    await page.keyboard.press('Escape');
    // Ask from the founder desk.
    const before = await page.locator('#research-list .research-row').count();
    await page.locator('#research-question').fill('Can we automate invoice reconciliation for small accountancies?');
    await page.locator('#research-ask').click();
    await page.waitForFunction(() => /Saved as an internal job/.test(document.getElementById('research-status')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => undefined);
    await page.waitForFunction((n) => document.querySelectorAll('#research-list .research-row').length === n + 1, before, { timeout: 8000 }).catch(() => undefined);
    const rows = await page.locator('#research-list .research-row').count();
    const internal = await page.locator('#jobs .job', { hasText: 'Internal' }).count();
    check(`${tag}: asking on the founder desk creates an Internal job awaiting approval`, rows === before + 1 && internal >= 1, `${rows} reports, ${internal} internal jobs`);
    await shot(page, '07-founder-desk-asked', tag);
    check(`${tag}: founder desk has no console errors`, !errors.length, errors.slice(0, 3).join(' · '));
  } finally { await ctx.close(); }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal'] });
try {
  // Phone landscape first (looks only, reduced motion), then desktop decides.
  await game(browser, { width: 874, height: 402, touch: true }, '874x402', false);
  await game(browser, { width: 1440, height: 900, touch: false }, '1440x900', true);
  await founderDesk(browser, { width: 874, height: 402, touch: true }, '874x402');
  await founderDesk(browser, { width: 1440, height: 900, touch: false }, '1440x900');
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
