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
      // keyboard: Tab reaches the first card with a visible focus ring
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement?.className ?? '');
      ok(/su-btn|su-card/.test(focused), `${tag} keyboard focus moves into the choices (${focused})`);
      await press(page, size.touch, '.su-card-cloud');
      await shot('03-github-device');
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
      if (size.touch) await press(page, true, '#su-address');
      await page.fill('#su-address', base.replace(/\/$/, ''));
      await page.fill('#su-password', 'wrong-password');
      await press(page, size.touch, '.su-panel:not(.su-leave) .su-foot .su-primary');
      await page.waitForSelector('.su-error:not([hidden])');
      await shot('11-server-wrong-password');
      await page.fill('#su-password', 'fixture-office');
      await press(page, size.touch, '.su-panel:not(.su-leave) .su-foot .su-primary');
      await page.waitForFunction(() => ['loading', 'ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 20000 });
      await page.waitForFunction(() => !document.getElementById('setup'), null, { timeout: 10000 });
      const stored = await page.evaluate(() => (window as unknown as { __secureStore: Record<string, string> }).__secureStore);
      ok(stored.mode === 'server' && !!stored['server.token'] && stored['server.host'] === base.replace(/\/$/, ''), `${tag} server path stores mode, host and device token`);
      await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120000 });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: resolve(out, `${tag}-12-game.jpg`), type: 'jpeg', quality: 82 });
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
