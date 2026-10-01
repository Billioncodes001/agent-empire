/**
 * Screenshots of every setup step against the isolated fixture (never 4610), with:
 *  - an in-page fake iOS bridge (window.webkit.messageHandlers.empire answering through window.__empireNative),
 *  - a fake api.github.com (Playwright route; no request leaves the machine; write calls are counted).
 * Also drives the server path end to end against the fixture's device login (FIXTURE_PASSWORD=fixture-office).
 * Usage: npm run build:client && FIXTURE_PORT=4707 FIXTURE_PASSWORD=fixture-office npx tsx tools/ui-fixture.ts
 *        FIXTURE_URL=http://127.0.0.1:4707/ npx tsx tools/setup-ui-check.ts   (writes docs/team/reports/setup/*.jpg)
 */
import { chromium, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://127.0.0.1:4707/';
if (/:4610\b/.test(base)) throw new Error('never 4610');
const out = resolve(process.env.OUT || 'docs/team/reports/setup');
mkdirSync(out, { recursive: true });
const sizes = [{ w: 874, h: 402, touch: true }, { w: 1440, h: 900, touch: false }];
const failures: string[] = [];
const ok = (cond: unknown, name: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures.push(name); };

const FAKE_BRIDGE = `
  window.AGENT_EMPIRE_APP = Object.freeze({ platform: 'ios', deviceName: 'Fixture iPhone' });
  window.__bridgeLog = []; const store = {};
  window.webkit = { messageHandlers: { empire: { postMessage(m) {
    window.__bridgeLog.push({ method: m.method, key: m.params && m.params.key });
    const N = () => window.__empireNative;
    setTimeout(() => {
      switch (m.method) {
        case 'secure.get': return N().resolve(m.id, store[m.params.key] ?? null);
        case 'secure.set': store[m.params.key] = m.params.value; return N().resolve(m.id, true);
        case 'secure.delete': delete store[m.params.key]; return N().resolve(m.id, true);
        case 'github.deviceFlow': return setTimeout(() => N().resolve(m.id, { token: 'gho_FAKEFIXTURETOKEN000000000000000000', login: 'octo-founder' }), 600);
        default: return N().resolve(m.id, true);
      }
    }, 20);
  } } } };
  window.__secureStore = store;
`;

const repos = Array.from({ length: 9 }, (_, i) => ({
  name: ['city-planner', 'storefront', 'mobile-app', 'data-pipeline', 'docs-site', 'infra', 'ml-lab', 'website', 'agent-empire-state'][i],
  owner: { login: i === 5 ? 'founder-org' : 'octo-founder' }, private: i % 3 !== 1, default_branch: 'main',
  description: ['Zoning and permits service', 'Online shop', 'iOS and Android client', 'Nightly ETL', 'Public docs', 'Terraform', 'Experiments', 'Marketing site', 'state'][i],
  pushed_at: new Date(Date.now() - (i + 1) * 3 * 86400000).toISOString(), permissions: { push: i !== 6, admin: i === 0 },
}));

/**
 * Phone-sized runs use real touch input: Playwright's tap() in a hasTouch context sends CDP Input.dispatchTouchEvent
 * (touchstart/touchend and the browser's own click synthesis), like a finger in WKWebView or Android WebView.
 * A touch-only failure (e.g. a preventDefault on touchstart suppressing the click) fails this check.
 */
async function press(page: Page, touch: boolean, selector: string) {
  const target = page.locator(selector).first();
  if (!touch) return target.click();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`nothing to tap: ${selector}`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

/** Visible dialogs whose surface is light (the old cream theme). Dark = background luminance under 0.2. */
const LIGHT_DIALOGS = `(() => {
  const lum = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);
    if (a < 0.5) return null; const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  return [...document.querySelectorAll('#modal-root .modal')].filter((m) => m.getClientRects().length).map((m) => {
    const cs = getComputedStyle(m); const head = m.querySelector('header'); const hs = head ? getComputedStyle(head) : null;
    const surfaces = [cs.backgroundImage, cs.backgroundColor, hs && hs.backgroundColor].filter(Boolean).map(lum).filter((v) => v !== null);
    return { name: m.getAttribute('aria-label') || m.className, light: surfaces.some((v) => v > 0.2) };
  }).filter((d) => d.light).map((d) => d.name);
})()`;
const TEXT_FOCUSED = `(() => { const a = document.activeElement; return !!a && (a.tagName === 'TEXTAREA' || a.isContentEditable || (a.tagName === 'INPUT' && !['button','checkbox','radio','range','submit'].includes(a.type))); })()`;
/** Body text sizes on the current setup step (px): the lede and every paragraph/hint in the panel body. */
const SETUP_TEXT = `(() => { const p = document.querySelector('.su-panel:not(.su-leave)'); if (!p) return null;
  const px = (sel) => [...p.querySelectorAll(sel)].filter((e) => e.getClientRects().length && e.textContent.trim()).map((e) => parseFloat(getComputedStyle(e).fontSize));
  const html = getComputedStyle(document.documentElement); const su = getComputedStyle(document.querySelector('.su'));
  return { lede: px('.su-head .su-lede'), body: px('.su-body p, .su-body .su-hint, .su-card-points'),
    adjust: [html.textSizeAdjust || html.webkitTextSizeAdjust, su.textSizeAdjust || su.webkitTextSizeAdjust] }; })()`;

async function fakeGitHub(page: Page, writes: string[]) {
  await page.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() !== 'GET') writes.push(`${req.method()} ${url.pathname}`);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (url.pathname === '/user') return json(200, { login: 'octo-founder', name: 'Octo Founder' });
    if (url.pathname === '/user/repos') return json(200, repos);
    return json(404, { message: 'Not Found (fixture)' });
  });
}

async function run() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const size of sizes) {
    const tag = `${size.w}x${size.h}`;
    // ---- App (fake iOS bridge): the full cloud path and the server path ----
    {
      const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch, deviceScaleFactor: size.touch ? 1.5 : 1 });
      await context.addInitScript({ content: 'window.__name = (f) => f;' });
      await context.addInitScript({ content: FAKE_BRIDGE });
      await context.addInitScript({ content: "window.__touches=0;addEventListener('touchstart',()=>window.__touches++,{capture:true,passive:true});" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      const writes: string[] = [];
      await fakeGitHub(page, writes);
      await page.goto(base);
      await page.waitForSelector('.su-hero-title');
      await page.waitForTimeout(1600);
      const shot = async (name: string) => {
        await page.waitForTimeout(450);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.querySelector('.su')!.scrollWidth > innerWidth);
        ok(!overflow, `${tag} ${name}: no horizontal overflow`);
        await page.screenshot({ path: resolve(out, `${tag}-${name}.jpg`), type: 'jpeg', quality: 82 });
      };
      await shot('01-welcome');
      ok(await page.evaluate(() => document.getElementById('splash')?.style.display === 'none'), `${tag} splash hidden during setup`);
      await press(page, size.touch, 'text=Set up my Empire');
      if (size.touch) ok(await page.evaluate(() => (window as unknown as { __touches: number }).__touches > 0), `${tag} the setup is driven by real touch events`);
      await page.waitForSelector('.su-card-cloud');
      await shot('02-mode');
      const textMode = await page.evaluate(SETUP_TEXT);
      // keyboard: Tab reaches the first card with a visible focus ring
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement?.className ?? '');
      ok(/su-btn|su-card/.test(focused), `${tag} keyboard focus moves into the choices (${focused})`);
      await press(page, size.touch, '.su-card-cloud');
      await shot('03-github-device');
      const textGitHub = await page.evaluate(SETUP_TEXT);
      await press(page, size.touch, 'text=Sign in with GitHub');
      await page.waitForSelector('.su-linked');
      await shot('04-github-linked');
      await press(page, size.touch, '.su-panel:not(.su-leave) .su-foot .su-primary');
      await page.waitForSelector('.su-repo');
      ok(!(await page.locator('.su-repo:has-text("agent-empire-state")').count()), `${tag} the state repo is not offered as a project`);
      await press(page, size.touch, 'label[for="su-r-octo-founder-city-planner"]');
      await press(page, size.touch, 'label[for="su-r-octo-founder-mobile-app"]');
      await shot('05-repos');
      await press(page, size.touch, '.su-panel:not(.su-leave) .su-foot .su-primary');
      await page.fill('#su-key-anthropic', 'sk-ant-FAKE-fixture-only-000000000000');
      await page.fill('#su-key-openai', 'not-a-key');
      await shot('06-providers-error');
      ok(await page.locator('.su-panel:not(.su-leave) .su-foot .su-primary').isDisabled(), `${tag} a malformed key blocks advancing`);
      await page.fill('#su-key-openai', '');
      await press(page, size.touch, '.su-panel:not(.su-leave) .su-foot .su-primary');
      // Back to the keys step: it is re-rendered from the setup state with the typed key in the field.
      await page.waitForSelector('#su-daily');
      await press(page, size.touch, '.su-panel:not(.su-leave) .su-foot .su-back');
      await page.waitForSelector('.su-panel:not(.su-leave) #su-key-anthropic');
      const keyLeak = await page.evaluate(() => ({
        inMarkup: document.documentElement.outerHTML.includes('sk-ant-FAKE'),
        attr: document.querySelector('#su-key-anthropic')?.getAttribute('value') ?? null,
        kept: (document.querySelector('#su-key-anthropic') as HTMLInputElement | null)?.value === 'sk-ant-FAKE-fixture-only-000000000000',
      }));
      ok(!keyLeak.inMarkup && keyLeak.attr === null && keyLeak.kept, `${tag} a typed API key is kept in the field but never written into the page markup (value attribute ${keyLeak.attr === null ? 'absent' : 'present'})`);
      await press(page, size.touch, '.su-panel:not(.su-leave) .su-foot .su-primary');
      await page.fill('#su-daily', '2');
      await shot('07-limits-error');
      await page.fill('#su-daily', '20.00');
      await press(page, size.touch, '[aria-label="More jobs at once"]');
      await shot('08-limits');
      await press(page, size.touch, '.su-panel:not(.su-leave) .su-foot .su-primary');
      await shot('09-review');
      ok(await page.locator('.su-panel:not(.su-leave) .su-foot .su-primary').isDisabled(), `${tag} create needs the cost confirmation`);
      await press(page, size.touch, 'label[for="su-accept"]');
      await press(page, size.touch, '.su-panel:not(.su-leave) .su-foot .su-primary');
      await page.waitForSelector('.su-result .su-error');
      await shot('10-create-not-ready');
      ok(writes.length === 0, `${tag} a not-ready build makes no GitHub write calls (${writes.join(', ') || 'none'})`);
      const log = await page.evaluate(() => (window as unknown as { __bridgeLog: { method: string; key?: string }[] }).__bridgeLog);
      ok(!log.some((l) => l.method === 'secure.set' && !['github.token', 'github.login', 'mode', 'state.repo', 'server.host', 'server.token', 'server.deviceId'].includes(l.key ?? '')), `${tag} only allowlisted keys stored`);
      ok(!JSON.stringify(await page.evaluate(() => (window as unknown as { __secureStore: unknown }).__secureStore)).includes('sk-ant'), `${tag} provider keys never go to secure storage`);
      // Server path: back to the mode choice
      await press(page, size.touch, 'text=Choose another way');
      await press(page, size.touch, '.su-card-server');
      await page.waitForTimeout(400);
      const textServer = await page.evaluate(SETUP_TEXT);
      {
        type T = { lede: number[]; body: number[]; adjust: string[] } | null;
        const steps = [['mode', textMode], ['github', textGitHub], ['server', textServer]] as [string, T][];
        const ledes = new Set(steps.flatMap(([, t]) => t?.lede ?? []));
        const maxBody = Math.max(...steps.flatMap(([, t]) => t?.body ?? []));
        const minBody = Math.min(...steps.flatMap(([, t]) => t?.body ?? []));
        const desc = steps.map(([n, t]) => `${n}: lede ${t?.lede.join('/')} body ${[...new Set(t?.body)].join('/')}`).join('; ');
        ok(ledes.size === 1, `${tag} setup lede text is one size on every step (${desc})`);
        ok(maxBody <= (size.touch ? 14 : 15) && minBody >= 11, `${tag} setup body text stays within the compact scale on every step (${minBody}-${maxBody}px)`);
        ok(steps.every(([, t]) => t?.adjust.every((a) => a === '100%')), `${tag} text inflation is off (text-size-adjust 100%: ${steps.map(([, t]) => t?.adjust.join(',')).join(' ')})`);
      }
      if (size.touch) await press(page, true, '#su-address');
      await page.fill('#su-address', base.replace(/\/$/, ''));
      await page.fill('#su-password', 'wrong-password');
      await press(page, size.touch, '.su-panel:not(.su-leave) .su-foot .su-primary');
      await page.waitForSelector('.su-error:not([hidden])');
      await shot('11-server-wrong-password');
      await page.fill('#su-password', 'fixture-office');
      await press(page, size.touch, '.su-panel:not(.su-leave) .su-foot .su-primary');
      await page.waitForFunction(() => ['loading', 'ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 20000 });
      ok(!(await page.evaluate(TEXT_FOCUSED)), `${tag} the hand-over to the game closes the keyboard (no field focused on the loading screen)`);
      await page.waitForFunction(() => !document.getElementById('setup'), null, { timeout: 10000 });
      const stored = await page.evaluate(() => (window as unknown as { __secureStore: Record<string, string> }).__secureStore);
      ok(stored.mode === 'server' && !!stored['server.token'] && stored['server.host'] === base.replace(/\/$/, ''), `${tag} server path stores mode, host and device token`);
      await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120000 });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: resolve(out, `${tag}-12-game.jpg`), type: 'jpeg', quality: 82 });
      // ---- First minutes in the game: founder, then the menu's windows. All dark; no keyboard opened by itself on touch.
      await page.waitForSelector('#modal-root .modal.charsel', { timeout: 20000 });
      await page.waitForTimeout(400);
      const nameFocused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Your name');
      if (size.touch) {
        ok(!(await page.evaluate(TEXT_FOCUSED)), `${tag} founder dialog does not auto-focus a text field on touch (no keyboard)`);
        ok(await page.evaluate(() => !!document.activeElement?.closest('.charsel')), `${tag} focus still starts inside the founder dialog`);
      } else ok(nameFocused, `${tag} founder dialog autofocuses the name field on desktop`);
      const lightFounder: string[] = await page.evaluate(LIGHT_DIALOGS);
      ok(lightFounder.length === 0, `${tag} founder dialog uses the dark design (${lightFounder.join(', ') || 'dark'})`);
      await page.screenshot({ path: resolve(out, `${tag}-13-founder.jpg`), type: 'jpeg', quality: 82 });
      if (size.touch) {
        await press(page, true, '.charsel input[aria-label="Your name"]');
        await page.waitForTimeout(200);
        ok(await page.evaluate(TEXT_FOCUSED), `${tag} tapping the name field focuses it (the keyboard opens on request)`);
      }
      await page.fill('.charsel input[aria-label="Your name"]', 'Ada');
      await press(page, size.touch, '.charsel button[type=submit]');
      await page.waitForTimeout(600);
      const seen: string[] = [];
      for (let i = 0; i < 4 && (await page.locator('#modal-root .modal').count()); i++) {
        const light: string[] = await page.evaluate(LIGHT_DIALOGS);
        seen.push(...light);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
      }
      const windows: [string, string][] = [['Settings', 'Settings'], ['Controls', 'Controls'], ['Management', 'Management']];
      for (const [item, name] of windows) {
        await press(page, size.touch, '#btn-menu');
        await page.waitForSelector('#modal-root .modal.game-menu');
        seen.push(...(await page.evaluate(LIGHT_DIALOGS)));
        await press(page, size.touch, `.game-menu .menu-item:has(strong:text-is("${item}"))`);
        await page.waitForTimeout(500);
        const light: string[] = await page.evaluate(LIGHT_DIALOGS);
        seen.push(...light);
        if (item === 'Settings') await page.screenshot({ path: resolve(out, `${tag}-14-settings.jpg`), type: 'jpeg', quality: 82 });
        if (item === 'Controls') await page.screenshot({ path: resolve(out, `${tag}-15-controls.jpg`), type: 'jpeg', quality: 82 });
        ok(light.length === 0, `${tag} ${name} window uses the dark design (${light.join(', ') || 'dark'})`);
        for (let i = 0; i < 3 && (await page.locator('#modal-root .modal').count()); i++) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
        }
      }
      ok(seen.length === 0, `${tag} no light-theme dialog in the first minutes (${seen.join(', ') || 'none'})`);
      ok(errors.filter((e) => !/404|Failed to load resource/.test(e)).length === 0, `${tag} app flow: no console errors (${errors.join(' | ')})`);
      await context.close();
    }
    // ---- Web (static copy, no server behind it): token fallback and web server path ----
    {
      const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/api/whoami', (r) => r.fulfill({ status: 404, body: 'static host' }));
      await page.goto(base);
      await page.waitForSelector('.su-hero-title');
      await press(page, size.touch, 'text=Set up my Empire');
      await press(page, size.touch, '.su-card-cloud');
      await page.waitForTimeout(200);
      await page.screenshot({ path: resolve(out, `${tag}-web-github-token.jpg`), type: 'jpeg', quality: 82 });
      ok(await page.locator('#su-gh-token').isVisible(), `${tag} web offers the token fallback`);
      await page.keyboard.press('Escape');
      await press(page, size.touch, '.su-card-server');
      await page.waitForTimeout(200);
      ok(!(await page.locator('#su-password').count()), `${tag} web server path asks no password on this page`);
      await page.screenshot({ path: resolve(out, `${tag}-web-server.jpg`), type: 'jpeg', quality: 82 });
      ok(errors.length === 0, `${tag} web flow: no page errors`);
      await context.close();
    }
  }
  await browser.close();
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
