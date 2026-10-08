/**
 * Focus and scroll survive live re-renders — against the isolated UI fixture only (never the protected 4610 session).
 *   npm run build:client && FIXTURE_PORT=4795 FIXTURE_SCENARIO=waiting npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://localhost:4795/ npx tsx tools/queue-focus-check.ts
 * The fixture republishes workers, queue, empire and org every 3 s. For the task queue (Retry on the held row, ↓ on a
 * queued row), the approval inbox (a row button, through re-broadcast approvals) and the district map (Manage), the
 * check focuses a button inside the live list, waits through at least two updates, and asserts that the very same
 * element is still connected and focused and that the scroll container's scrollTop did not move. No screenshots.
 */
import { chromium, type Browser, type Page } from 'playwright-core';

const base = process.env.FIXTURE_URL || 'http://localhost:4795/';
if (/:4610\b/.test(base)) throw new Error('Refusing the protected 4610 session; use the UI fixture.');

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0];
process.on('unhandledRejection', (e) => { check('unexpected error', false, message(e)); process.exitCode = 1; });

type Store = { on(topic: string, fn: () => void): () => void; emit(topic: string): void; approvals: { items: unknown[] } | null };
type Win = { __office: { store: Store; empireUI: { openMap(): void } }; __qf?: { el: HTMLElement; scroller: HTMLElement | null; top: number; events: number; off: () => void } };

async function open(browser: Browser, width: number, height: number, touch: boolean) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch });
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

/**
 * Focuses the button `selector` matches, scrolls its nearest scrolling ancestor so the button sits low in it (a
 * non-zero scrollTop whenever the list overflows), and starts counting `topic` events.
 */
async function arm(page: Page, selector: string, topic: string) {
  await page.waitForSelector(selector, { timeout: 30_000 });
  return page.evaluate(([sel, t]) => {
    const w = window as unknown as Win;
    const el = document.querySelector<HTMLElement>(sel)!;
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    el.focus({ preventScroll: true });
    const state = { el, scroller, top: scroller?.scrollTop ?? 0, events: 0, off: () => {} };
    state.off = w.__office.store.on(t, () => { state.events++; });
    w.__qf = state;
    return { focused: document.activeElement === el, label: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '', top: state.top, scrolls: !!scroller };
  }, [selector, topic] as const);
}

/** Waits until `events` updates have arrived (plus a frame), then reports whether focus and scroll stayed put. */
async function settle(page: Page, events: number) {
  await page.waitForFunction((n) => ((window as unknown as Win).__qf?.events ?? 0) >= n, events, { timeout: 30_000 });
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const s = (window as unknown as Win).__qf!;
    s.off();
    const active = document.activeElement as HTMLElement | null;
    return {
      events: s.events,
      same: active === s.el,
      connected: s.el.isConnected,
      active: active ? `${active.tagName.toLowerCase()} ${active.getAttribute('aria-label') ?? active.textContent?.trim().slice(0, 30) ?? ''}` : 'none',
      top: s.scroller?.scrollTop ?? 0,
      before: s.top,
    };
  });
}

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [w, h, touch, tag] of [[1440, 900, false, '1440x900'], [874, 402, true, '874x402']] as const) {
    let opened: Awaited<ReturnType<typeof open>> | undefined;
    try {
      opened = await open(browser, w, h, touch);
      const { page, errors } = opened;

      // Task queue: the held row's Retry, then a queued row's ↓, each through two server publishes.
      await page.evaluate(() => (document.getElementById('btn-queue') as HTMLElement).click());
      // The queue moves focus to its task box 30 ms after opening; let that happen before taking focus elsewhere.
      await page.waitForTimeout(500);
      for (const [sel, what] of [['.queue-list li.held .queue-actions button[title^="Retry"]', 'Retry'], ['.queue-list li.queued .queue-actions button[aria-label="Move down"]:not([disabled]), .queue-list li.queued .queue-actions button[aria-label="Remove"]', 'queued row']] as const) {
        const armed = await arm(page, sel, 'queue');
        check(`${tag}: queue ${what} button focused`, armed.focused, `${armed.label} · scrollTop ${armed.top}${armed.scrolls ? '' : ' (list fits, no scroller)'}`);
        const r = await settle(page, 2);
        check(`${tag}: queue ${what} keeps focus through ${r.events} updates`, r.same && r.connected, `active: ${r.active}`);
        check(`${tag}: queue scroll unchanged`, r.top === r.before, `${r.before} → ${r.top}`);
      }
      // A finished row whose worker goes home: [🖥️ Terminal, ↻ Requeue, ✕] → [↻ Requeue, ✕]. The Terminal element must
      // go away, never become Requeue (a press that started on Terminal would otherwise re-hire a worker).
      const swap = await page.evaluate(() => {
        const s = (window as unknown as { __office: { store: Store & { queue: { tasks: { id: string; status: string; workerId?: string }[]; maxWorkers: number }; workers: Map<string, unknown> } } }).__office.store;
        const t = s.queue.tasks.find((x) => x.status === 'done');
        const wid = [...s.workers.keys()][0];
        if (!t || !wid) return null;
        const set = (workerId: string) => { s.queue = { ...s.queue, tasks: s.queue.tasks.map((x) => (x.id === t.id ? { ...x, workerId } : x)) }; s.emit('queue'); };
        const row = () => document.querySelector<HTMLElement>(`.queue-list li[data-task="${CSS.escape(t.id)}"]`)!;
        set(wid);
        const keys = (r: HTMLElement) => [...r.querySelectorAll<HTMLElement>('.queue-actions [data-key]')].map((b) => b.dataset.key).join(',');
        const before = keys(row());
        const terminal = row().querySelector<HTMLElement>('[data-key="terminal"]');
        const again = row().querySelector<HTMLElement>('[data-key="requeue"], [data-key="retry"]');
        set('fixture-gone-home');
        const after = keys(row());
        const requeue = row().querySelector<HTMLElement>('[data-key="requeue"], [data-key="retry"]');
        return { before, after, terminalGone: !!terminal && !terminal.isConnected, requeueReused: !!again && again === requeue, terminalNotReused: [...row().querySelectorAll('button')].every((b) => b !== terminal) };
      });
      check(`${tag}: queue Terminal → gone never repurposes the Terminal button`, !!swap && swap.terminalGone && swap.terminalNotReused && swap.requeueReused && !swap.after.includes('terminal'), JSON.stringify(swap));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#modal-root .backdrop'), null, { timeout: 5000 });

      // District map: Manage on the last site, through empire/worker publishes.
      await page.evaluate(() => (window as unknown as Win).__office.empireUI.openMap());
      {
        const armed = await arm(page, '.map-locations .map-location:last-child button[aria-label^="Manage"]', 'empire');
        check(`${tag}: map Manage button focused`, armed.focused, armed.label);
        const r = await settle(page, 2);
        check(`${tag}: map Manage keeps focus through ${r.events} updates`, r.same && r.connected, `active: ${r.active}`);
        check(`${tag}: map scroll unchanged`, r.top === r.before, `${r.before} → ${r.top}`);
      }
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#modal-root .backdrop'), null, { timeout: 5000 });

      // Approval inbox: the fixture only sends approvals on change, so replay the current inbox as fresh objects
      // twice (what a server broadcast delivers) while the regular 3 s publishes keep arriving.
      await page.waitForFunction(() => (window as unknown as Win).__office.store.approvals?.items.length, null, { timeout: 20_000 });
      // The HUD badge opens the inbox; it is hidden on small layouts, so click it programmatically.
      await page.evaluate(() => (document.getElementById('btn-inbox') as HTMLElement).click());
      {
        const armed = await arm(page, '.inbox-list li:last-child .inbox-row', 'approvals');
        check(`${tag}: inbox row focused`, armed.focused, armed.label.slice(0, 60));
        for (let i = 0; i < 2; i++) {
          await page.evaluate(() => {
            const s = (window as unknown as Win).__office.store;
            s.approvals = JSON.parse(JSON.stringify(s.approvals));
            s.emit('approvals');
          });
          await page.waitForTimeout(3100);
        }
        const r = await settle(page, 2);
        check(`${tag}: inbox row keeps focus through ${r.events} broadcasts`, r.same && r.connected, `active: ${r.active}`);
        check(`${tag}: inbox scroll unchanged`, r.top === r.before, `${r.before} → ${r.top}`);
      }
      check(`${tag}: no console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    } catch (e) {
      check(`${tag}: check run completed`, false, message(e));
    } finally { await opened?.context.close().catch(() => undefined); }
  }
} catch (e) {
  check('check run completed', false, message(e));
} finally { await browser.close().catch(() => undefined); }

if (!results.length) check('check run completed', false, 'no checks ran');
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
