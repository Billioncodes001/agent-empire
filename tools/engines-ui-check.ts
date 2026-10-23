/**
 * FREE-01 acceptance against the isolated UI fixture only (never the protected 4610 session):
 *   npm run build:client && FIXTURE_PORT=4821 FIXTURE_WORKERS=3 FIXTURE_ENGINES=free npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://localhost:4821/ npx tsx tools/engines-ui-check.ts
 * Checks the Settings linked-accounts panel, the confirmed (synthetic) model download, the hire dialog's engine choice,
 * engine labels on the worker card, name plate and terminal header, and "status unknown". Screenshots go to
 * docs/team/reports/free-01/; exits non-zero on any failed check. The fixture never runs a CLI, Ollama or a model.
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:4821/';
if (/:4610\b/.test(base)) throw new Error('Refusing the protected 4610 session; use the UI fixture.');
const out = resolve(import.meta.dirname, '../docs/team/reports/free-01');
mkdirSync(out, { recursive: true });

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function open(browser: Browser, o: { width: number; height: number; touch: boolean; reduced?: boolean; saveData?: boolean }) {
  const context = await browser.newContext({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: 1, isMobile: o.touch, hasTouch: o.touch, reducedMotion: o.reduced ? 'reduce' : 'no-preference' });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }));
    localStorage.setItem('agent-empire.execution.offered', '1');
  });
  if (o.saveData) await context.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true } }));
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

async function openSettings(page: Page) {
  await page.evaluate(() => (document.getElementById('btn-settings') as HTMLButtonElement | null)?.click());
  await page.waitForSelector('.linked-accounts .engine-card', { timeout: 15_000 });
  await page.locator('.linked-accounts').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  try {
    // ---- Desktop 1440x900 ----
    const d = await open(browser, { width: 1440, height: 900, touch: false });
    const p = d.page;
    await p.waitForTimeout(6000); // let lazily loaded staff and desks settle, as the outfit check does
    // Hire dialog engine choice at an empty desk.
    const candidates = await p.evaluate(() => {
      const o = (window as unknown as { __office: { office: { interactables: { kind: string; deskId?: string; x: number; z: number }[] }; store: { workerAtDesk(id: string): unknown } } }).__office;
      const desks = o.office.interactables.filter((it) => it.kind === 'desk' && it.deskId);
      return desks.filter((it) => !desks.some((n) => Math.hypot(n.x - it.x, n.z - it.z) < 3 && o.store.workerAtDesk(n.deskId!))).map((x) => ({ id: x.deskId!, x: x.x, z: x.z }));
    });
    let desk: { id: string } | null = null;
    for (const c of candidates) {
      await p.evaluate((q) => { const o = (window as unknown as { __office: { player: { pos: { set(x: number, y: number, z: number): void }; view: string } } }).__office; o.player.view = 'first'; o.player.pos.set(q.x, 0, q.z); }, c);
      if (await p.waitForFunction(() => /Desk \d+ · empty/.test(document.getElementById('hint')?.textContent ?? ''), null, { timeout: 5000 }).then(() => true, () => false)) { desk = c; break; }
    }
    check('an empty desk is available to hire at', !!desk, `${candidates.length} candidates; modals ${await p.locator('#modal-root .backdrop').count()}; hint “${await p.locator('#hint').textContent().catch(() => '')}”`);
    if (desk) {
      await p.keyboard.press('KeyP');
      await p.waitForFunction(() => { const s = document.querySelector('#engine-choice') as HTMLSelectElement | null; return !!s && !s.disabled; }, null, { timeout: 10_000 });
      const chosen = await p.evaluate(() => { const s = document.querySelector('#engine-choice') as HTMLSelectElement; return { text: s.selectedOptions[0]?.textContent ?? '', note: document.querySelector('.engine-note')?.textContent ?? '', disabled: [...s.options].filter((o) => o.disabled).map((o) => o.textContent) }; });
      check('no healthy premium: the free engine is offered with its label', /^Qwen Code · gpt-oss:20b \(local\) · free$/.test(chosen.text) && /Free · /.test(chosen.note), JSON.stringify(chosen));
      check('unready premium engines are listed but not selectable, with reasons', chosen.disabled.some((t) => /Claude Code · your Claude account — not ready/.test(t ?? '')));
      await p.screenshot({ path: resolve(out, '06-hire-dialog-engine-choice-1440x900.jpg'), quality: 82 });
      const before = await p.locator('#workers li[data-worker]').count();
      await p.fill('#modal-root textarea', 'Fixture hire on the free engine');
      await p.locator('#modal-root button[type=submit]').click();
      await p.waitForFunction((n) => document.querySelectorAll('#workers li[data-worker]').length > n, before, { timeout: 10_000 }).catch(() => {});
      const hired = await p.evaluate(() => [...document.querySelectorAll('#workers li[data-worker] .engine')].map((e) => e.textContent));
      check('the hire carries the chosen engine to the worker card', hired.filter((t) => t === 'Qwen Code · gpt-oss:20b (local)').length >= 2, hired.join(' | '));
    }
    await openSettings(p);
    const panel = (await p.locator('.linked-accounts').textContent()) ?? '';
    check('panel shows Claude Code login state from CLI output', /Claude Code · premium/.test(panel) && /Not signed in/.test(panel), '');
    check('panel offers "Sign in to Claude" and says the Empire never sees credentials', /Sign in to Claude/.test(panel) && /never signs you in or sees your Claude credentials/.test(panel));
    check('panel shows Qwen Code, Ollama with models, and Codex', /Qwen Code · free/.test(panel) && /Running · v0\.40\.10/.test(panel) && /Downloaded: gpt-oss:20b/.test(panel) && /Codex CLI · optional/.test(panel));
    check('RAM recommendation with sizes, licence and tag caveat', /32 GB memory/.test(panel) && /qwen3-coder:30b/.test(panel) && /19 GB download · Apache-2\.0/.test(panel) && /Verify the tag exists/.test(panel));
    check('API keys listed by name only', /ANTHROPIC_API_KEY · not set/.test(panel) && /GROQ_API_KEY/.test(panel));
    await p.locator('.hosted-free summary').click();
    const terms = (await p.locator('.hosted-free').textContent()) ?? '';
    check('free hosted keys are opt-in with data-use terms shown', /opt-in/.test(terms) && /human reviewers may read them/.test(terms) && /has not verified them/.test(terms));
    await p.screenshot({ path: resolve(out, '01-settings-linked-accounts-1440x900.jpg'), quality: 82 });

    // Explicit, confirmed download (synthetic progress), then cancel.
    await p.locator('.model-recs button:has-text("Download (19 GB)")').click();
    const dialog = p.locator('[role=alertdialog]');
    await dialog.waitFor({ timeout: 5000 });
    const ask = (await dialog.textContent()) ?? '';
    check('download asks first, showing name, size and licence', /qwen3-coder:30b/.test(ask) && /19 GB/.test(ask) && /Apache-2\.0/.test(ask));
    await p.screenshot({ path: resolve(out, '02-download-confirmation-1440x900.jpg'), quality: 82 });
    await dialog.locator('button.danger').click();
    await p.waitForSelector('.pull-progress progress', { timeout: 8000 });
    await p.waitForTimeout(1500);
    const prog = (await p.locator('.pull-progress').textContent()) ?? '';
    check('download progress is shown with a cancel button', /qwen3-coder:30b: downloading/.test(prog) && (await p.locator('.pull-progress button:has-text("Cancel download")').count()) === 1, prog);
    await p.locator('.pull-progress').scrollIntoViewIfNeeded();
    await p.screenshot({ path: resolve(out, '03-download-progress-1440x900.jpg'), quality: 82 });
    await p.locator('.pull-progress button').click();
    await p.waitForFunction(() => /cancelled/.test(document.querySelector('.pull-progress')?.textContent ?? ''), null, { timeout: 8000 }).then(() => check('download can be cancelled', true), () => check('download can be cancelled', false));
    const sel = p.locator('.engine-default select');
    check('default engine select is labelled', (await sel.getAttribute('aria-label')) === 'Default engine for new hires');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
    check('Escape closes Settings', (await p.locator('.linked-accounts').count()) === 0);

    // Engine labels and status unknown on the worker card (HUD list), name plate and terminal header.
    const rows = await p.evaluate(() => [...document.querySelectorAll('#workers li[data-worker]')].map((li) => ({ id: (li as HTMLElement).dataset.worker, engine: li.querySelector('.engine')?.textContent ?? '', pill: li.querySelector('.pill')?.textContent ?? '', cost: li.querySelector('.cost')?.textContent ?? '' })));
    const qwen = rows.find((r) => r.engine === 'Qwen Code · gpt-oss:20b (local)');
    const codex = rows.find((r) => r.engine === 'Codex · gpt-oss:20b (local)');
    check('worker card shows "Qwen Code · gpt-oss:20b (local)" with US$0 spend', !!qwen && qwen.cost === 'US$0', JSON.stringify(qwen));
    check('an engine that cannot report shows "status unknown"', !!codex && /status unknown/.test(codex.pill), JSON.stringify(codex));
    check('Claude worker card says "your Claude account"', rows.some((r) => r.engine === 'Claude Code · your Claude account'));
    const plates = await p.evaluate(() => [...(window as unknown as { __office: { workerViews: Map<string, { plate: string }> } }).__office.workerViews.values()].map((v) => v.plate));
    check('name plates carry the engine', plates.some((t) => /· Qwen Code \(local\)$/.test(t)) && plates.some((t) => /· Claude Code$/.test(t)), plates.join(' | '));
    await p.evaluate(() => (document.getElementById('workers') as HTMLElement | null)?.scrollIntoView());
    await p.screenshot({ path: resolve(out, '04-worker-card-engine-labels-1440x900.jpg'), quality: 82 });
    if (qwen?.id) {
      await p.evaluate((id) => (document.querySelector(`#workers li[data-worker="${id}"]`) as HTMLElement | null)?.click(), qwen.id);
      await p.waitForSelector('.modal.term .engine-tag', { timeout: 8000 });
      const head = (await p.locator('.modal.term header').textContent()) ?? '';
      check('terminal header shows the engine', /Qwen Code · gpt-oss:20b \(local\)/.test(head), head);
      await p.screenshot({ path: resolve(out, '05-terminal-header-engine-1440x900.jpg'), quality: 82 });
      await p.locator('.modal.term button.close').click();
      await p.waitForTimeout(500);
    }

    check('desktop: no console errors', d.errors.length === 0, d.errors.join(' | '));
    await d.context.close();

    // ---- Phone landscape 874x402, reduced motion + Save-Data ----
    const m = await open(browser, { width: 874, height: 402, touch: true, reduced: true, saveData: true });
    await openSettings(m.page);
    const overflow = await m.page.evaluate(() => { const el = document.querySelector('.linked-accounts') as HTMLElement; return el.scrollWidth - el.clientWidth; });
    check('phone: linked accounts fit without horizontal overflow', overflow <= 1, `${overflow}px`);
    const tap = await m.page.evaluate(() => Math.min(...[...document.querySelectorAll('.linked-accounts button')].map((b) => b.getBoundingClientRect().height).filter((h) => h > 0)));
    check('phone: buttons are at least 32 px tall', tap >= 32, `${tap}px`);
    await m.page.screenshot({ path: resolve(out, '07-settings-linked-accounts-874x402.jpg'), quality: 82 });
    await m.page.keyboard.press('Escape');
    await m.page.waitForTimeout(300);
    await m.page.evaluate(() => (document.getElementById('workers') as HTMLElement | null)?.scrollIntoView());
    await m.page.screenshot({ path: resolve(out, '08-worker-card-engine-labels-874x402.jpg'), quality: 82 });
    check('phone (reduced motion, Save-Data): no console errors', m.errors.length === 0, m.errors.join(' | '));
    await m.context.close();
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
void main();
