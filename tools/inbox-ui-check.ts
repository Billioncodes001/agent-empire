/**
 * ORG-03 acceptance against the isolated UI fixture only (never the protected 4610 session).
 *   npm run build:client && FIXTURE_PORT=4750 npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://localhost:4750/ npx tsx tools/inbox-ui-check.ts
 * The fixture holds a real ApprovalInbox over a real consultancy journal in a temp directory (fake queue, nothing
 * runs): one client plan and one budget increase for a held job. Checks: the tray on the CEO desk shows the count,
 * E opens the inbox, the HUD badge, executive card links, approving the budget increase (with confirmation) releases
 * the held item, keyboard focus and Esc, the cloud-mode message, reduced motion, no overflow and no console errors.
 * Phone sizes run first and only look; the desktop run decides. Screenshots: docs/team/reports/org-03/.
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:4750/';
if (/:4610\b/.test(base)) throw new Error('Refusing the protected 4610 session; use the isolated fixture.');
const out = resolve(import.meta.dirname, '../docs/team/reports/org-03');
mkdirSync(out, { recursive: true });

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

type Office = {
  player: { pos: { set(x: number, y: number, z: number): void }; view: string; camYaw: number; facing: number; lookPitch: number };
  office: { floor: number; inboxTray: { count: number | null; interactable: { x: number; z: number; y: number } }; executiveInteractables: { kind: string; role?: string; x: number; z: number; y: number }[] };
  store: { approvals: { pending: number; items: { id: string; kind: string; status: string }[] } | null; cloud: unknown };
};
const office = (p: Page) => p.evaluate(() => {
  const o = (window as unknown as { __office: Office }).__office;
  return { tray: o.office.inboxTray.count, pending: o.store.approvals?.pending ?? null, items: o.store.approvals?.items ?? [] };
});

async function pressE(page: Page, touch: boolean) {
  if (touch) await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e' })));
  else await page.keyboard.press('KeyE');
}

async function run(browser: Browser, size: { width: number; height: number; touch: boolean; reduce?: boolean }, tag: string, decide: boolean) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, isMobile: size.touch, hasTouch: size.touch, reducedMotion: size.reduce ? 'reduce' : 'no-preference' });
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
    await page.waitForFunction(() => (window as unknown as { __office: Office }).__office?.store.approvals, null, { timeout: 20_000 });
    if (size.height > size.width) check(`${tag}: portrait asks to rotate (the game plays in landscape)`, await page.locator('.rotate-hint').isVisible());
    const start = await office(page);
    const pending = start.pending ?? 0;
    check(`${tag}: the tray on the CEO desk shows the pending count`, start.tray === pending && pending >= 1, `tray ${start.tray}, pending ${pending}`);

    const badge = page.locator('#btn-inbox');
    const badgeText = (await badge.innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(`${tag}: the HUD badge is visible with the count`, (await badge.isVisible()) && badgeText.includes(String(pending)), badgeText);

    // Stand at the tray (beside the CEO chair) and look at the desk.
    await page.evaluate(() => {
      const o = (window as unknown as { __office: Office }).__office;
      const it = o.office.inboxTray.interactable;
      o.player.view = 'first';
      o.player.pos.set(it.x + 0.2, it.y, it.z + 0.35);
      const yaw = Math.atan2(-((it.x - 1.1 + 0.58) - (it.x + 0.2)), -((it.z - 0.95) - (it.z + 0.35)));
      o.player.camYaw = yaw; o.player.facing = yaw; o.player.lookPitch = -0.55;
    });
    await page.waitForTimeout(2000);
    const hint = (await page.locator('#hint').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(`${tag}: the hint names the CEO inbox and its count`, /CEO inbox · \d+ waiting/.test(hint) && /Open inbox/.test(hint), hint);
    await page.screenshot({ path: resolve(out, `01-inbox-tray-${tag}.jpg`), quality: 82 });

    await pressE(page, size.touch);
    const modal = page.locator('.inbox-modal');
    await modal.waitFor({ timeout: 5000 }).catch(() => undefined);
    const rows = await modal.locator('.inbox-list:not(.inbox-history) .inbox-row').count();
    check(`${tag}: E opens the inbox listing every pending item`, rows === pending, `${rows} rows`);
    check(`${tag}: no horizontal overflow with the inbox open`, !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
    await page.waitForTimeout(450);
    await page.screenshot({ path: resolve(out, `02-inbox-list-${tag}.jpg`), quality: 82 });

    // The budget increase in detail.
    const budgetRow = modal.locator('.inbox-row', { has: page.locator('[data-kind="budget_increase"]') }).first();
    await budgetRow.evaluate((b) => (b as HTMLButtonElement).click()); // DOM click: in portrait the rotate prompt covers the game, the layout is still checked
    const detail = modal.locator('.inbox-detail');
    const text = (await detail.innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(`${tag}: detail shows spend against the approved budget and a budget input`, /Spent so far/.test(text) && /\$3\.20 of the approved \$3\.00/.test(text) && (await page.locator('#inbox-budget').isVisible()), text.slice(0, 160));
    check(`${tag}: detail says where else to approve`, /\/approve A\d+ in Telegram/.test(text));
    await page.waitForTimeout(450);
    await page.screenshot({ path: resolve(out, `03-inbox-budget-detail-${tag}.jpg`), quality: 82 });

    if (decide) {
      // Review fix 1: decline first; the job stays held and the increase can still be approved from Recent decisions.
      await modal.locator('.inbox-actions .btn', { hasText: 'Decline…' }).click();
      await modal.locator('.inbox-confirm .btn.danger').click();
      await page.waitForFunction(() => (window as unknown as { __office: Office }).__office.store.approvals?.items.some((i) => i.kind === 'budget_increase' && i.status === 'rejected'), null, { timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(300);
      const heldJobs = (await (await page.request.get(new URL('/__fixture/jobs', base).href)).json()) as { jobs: { client: string; budgetHold?: unknown; items: { held?: boolean }[] }[] };
      const stillHeld = heldJobs.jobs.find((j) => j.client === 'Harbor Labs');
      check(`${tag}: declining keeps the job held`, !!stillHeld?.budgetHold && stillHeld.items.some((i) => i.held));
      const reopenRow = modal.locator('.inbox-history .inbox-row', { hasText: 'Approve increase…' });
      check(`${tag}: the declined increase shows "Approve increase…" in Recent decisions`, await reopenRow.isVisible());
      await reopenRow.click();
      const reopenText = (await detail.innerText().catch(() => '')).replace(/\s+/g, ' ');
      check(`${tag}: the declined increase can still be approved, with no second decline`, /Declined by/.test(reopenText) && (await modal.locator('.inbox-detail .btn', { hasText: 'Approve increase…' }).count()) === 1 && (await modal.locator('.inbox-detail .btn', { hasText: 'Decline…' }).count()) === 0, reopenText.slice(0, 160));
      await page.waitForTimeout(300);
      await page.screenshot({ path: resolve(out, `04b-inbox-declined-reopen-${tag}.jpg`), quality: 82 });
      // Keyboard: Tab moves within the dialog and focus is visible on a control in it.
      await page.locator('#inbox-budget').fill('10');
      await page.locator('#inbox-budget').focus();
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('.inbox-modal') ? (document.activeElement as HTMLElement).textContent : null);
      check(`${tag}: Tab keeps focus inside the inbox`, !!focused, String(focused));
      await page.keyboard.press('Enter'); // "Approve increase…"
      const confirm = modal.locator('.inbox-confirm');
      await confirm.waitFor({ timeout: 3000 }).catch(() => undefined);
      const ctext = (await confirm.innerText().catch(() => '')).replace(/\s+/g, ' ');
      check(`${tag}: approving a spend increase asks for confirmation first`, /from \$3\.00 to \$10\.00/.test(ctext), ctext);
      await page.waitForTimeout(450);
    await page.screenshot({ path: resolve(out, `04-inbox-confirm-${tag}.jpg`), quality: 82 });
      await confirm.locator('.btn.primary').click();
      await page.waitForFunction(() => {
        const s = (window as unknown as { __office: Office }).__office.store.approvals;
        return s?.items.some((i) => i.kind === 'budget_increase' && i.status === 'approved');
      }, null, { timeout: 5000 }).catch(() => undefined);
      const jobs = (await (await page.request.get(new URL('/__fixture/jobs', base).href)).json()) as { jobs: { client: string; approvedBudgetUsd?: number; budgetHold?: unknown; items: { held?: boolean }[] }[] };
      const harbor = jobs.jobs.find((j) => j.client === 'Harbor Labs');
      check(`${tag}: approval raised the budget and released the held item`, harbor?.approvedBudgetUsd === 10 && !harbor.budgetHold && !harbor.items.some((i) => i.held), JSON.stringify(harbor && { b: harbor.approvedBudgetUsd, hold: !!harbor.budgetHold, held: harbor.items.map((i) => !!i.held) }));
      const after = await office(page);
      check(`${tag}: tray and badge count down`, after.tray === pending - 1 && after.pending === pending - 1, `tray ${after.tray}`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: resolve(out, `05-inbox-approved-${tag}.jpg`), quality: 82 });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      check(`${tag}: Esc closes the inbox`, (await modal.count()) === 0);

      // Executive card → inbox.
      await page.evaluate(() => {
        const o = (window as unknown as { __office: Office }).__office;
        const it = o.office.executiveInteractables.find((x) => x.kind === 'executive' && x.role === 'chief_of_staff')!;
        o.player.view = 'third'; o.player.pos.set(it.x, it.y, it.z + 0.2); o.player.camYaw = 0; o.player.facing = 0; o.player.lookPitch = -0.2;
      });
      await page.waitForTimeout(1200);
      await pressE(page, size.touch);
      const link = page.locator('.exec-modal [data-open-inbox]');
      await link.waitFor({ timeout: 4000 }).catch(() => undefined);
      check(`${tag}: the chief's card links its waiting plan into the inbox`, (await link.count()) === 1);
      await link.click().catch(() => undefined);
      await modal.waitFor({ timeout: 3000 }).catch(() => undefined);
      check(`${tag}: the card link opens the inbox`, (await modal.count()) === 1 && (await page.locator('.exec-modal').count()) === 0);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);

      // Cloud mode: the inbox explains it is not available (branch exercised by marking the store as cloud).
      await page.evaluate(() => { (window as unknown as { __office: Office }).__office.store.cloud = { snapshot: null }; });
      await page.locator('#btn-inbox').evaluate((b) => (b as HTMLButtonElement).click()).catch(() => undefined);
      await modal.waitFor({ timeout: 3000 }).catch(() => undefined);
      const cloudText = (await modal.innerText().catch(() => '')).replace(/\s+/g, ' ');
      check(`${tag}: cloud mode says the inbox is not available yet`, /The approval inbox isn't available in cloud mode yet\./.test(cloudText), cloudText.slice(0, 120));
      await page.waitForTimeout(450);
    await page.screenshot({ path: resolve(out, `06-inbox-cloud-${tag}.jpg`), quality: 82 });
      await page.keyboard.press('Escape');
      await page.evaluate(() => { (window as unknown as { __office: Office }).__office.store.cloud = null; });
    } else {
      // Phone: the list → detail → back flow.
      const back = modal.locator('.inbox-back');
      if (await back.isVisible()) {
        await back.evaluate((b) => (b as HTMLButtonElement).click());
        check(`${tag}: back returns from detail to the list`, await modal.locator('.inbox-side').isVisible());
      }
      await page.keyboard.press('Escape');
    }
    check(`${tag}: no console errors`, !errors.length, errors.slice(0, 4).join(' · '));
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal'] });
try {
  await run(browser, { width: 874, height: 402, touch: true }, '874x402', false);
  await run(browser, { width: 375, height: 812, touch: true, reduce: true }, '375x812-reduced-motion', false);
  await run(browser, { width: 1440, height: 900, touch: false }, '1440x900', true);
  // Review fix 2: the desktop tool row stays on one line.
  for (const width of [1280, 1440, 1920]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
    await ctx.addInitScript(() => { localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } })); localStorage.setItem('agent-empire.execution.offered', '1'); });
    const page = await ctx.newPage();
    try {
      await page.goto(base);
      await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
      await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10_000 });
      for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
      await page.waitForTimeout(1500);
      const row = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('#hud .topbar .controls > button')].filter((b) => (b as HTMLElement).getClientRects().length) as HTMLElement[];
        return { tops: [...new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top)))], unlabeled: btns.filter((b) => !b.getAttribute('aria-label') && !b.textContent?.trim()).map((b) => b.id) };
      });
      check(`${width}x900: the HUD tools fit on one row`, row.tops.length === 1, `rows at ${row.tops.join(', ')}`);
      check(`${width}x900: every HUD tool keeps an accessible name`, !row.unlabeled.length, row.unlabeled.join(','));
      await page.screenshot({ path: resolve(out, `07-hud-one-row-${width}x900.jpg`), quality: 82, clip: { x: 0, y: 0, width, height: 140 } });
      // Re-review fix 2: every conditionally shown tool at once (in voice → Mute, Invite, Upgrade, counts, two-digit badges).
      await page.evaluate(() => {
        for (const id of ['btn-mute', 'btn-team', 'btn-upgrade', 'btn-inbox']) document.getElementById(id)?.classList.remove('hidden');
        const set = (sel: string, text: string) => { const el = document.querySelector<HTMLElement>(sel); if (el) { el.textContent = text; el.classList.remove('hidden'); } };
        set('#btn-inbox .svc-count', '12');
        set('#btn-queue .svc-count', '12');
        set('#btn-services .svc-count', '3');
        set('#btn-voice > span', 'Leave voice');
      });
      await page.waitForTimeout(200);
      const crowded = await page.evaluate(() => {
        const c = document.querySelector<HTMLElement>('#hud .topbar .controls')!;
        const box = c.getBoundingClientRect();
        const btns = [...c.querySelectorAll<HTMLElement>(':scope > button')].filter((b) => b.getClientRects().length);
        const clipped = btns.filter((b) => { const r = b.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.right > window.innerWidth; }).map((b) => b.id);
        return { tops: [...new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top)))], clipped, overflow: c.scrollWidth - c.clientWidth, spare: Math.round(parseFloat(getComputedStyle(c).maxWidth) - box.width), count: btns.length };
      });
      check(`${width}x900: with every conditional tool shown, still one row and nothing clipped`, crowded.tops.length === 1 && !crowded.clipped.length && crowded.overflow <= 1, `${crowded.count} tools, rows ${crowded.tops.join(',')}, clipped [${crowded.clipped.join(',')}], spare ${crowded.spare}px`);
      await page.screenshot({ path: resolve(out, `08-hud-all-tools-${width}x900.jpg`), quality: 82, clip: { x: 0, y: 0, width, height: 140 } });
    } finally { await ctx.close(); }
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
