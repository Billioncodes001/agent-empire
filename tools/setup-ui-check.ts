/**
 * Screenshots of every setup step against the isolated fixture (never 4610), with:
 *  - an in-page fake iOS bridge (window.webkit.messageHandlers.empire answering through window.__empireNative),
 *  - a fake api.github.com (Playwright route; no request leaves the machine; write calls are counted).
 * Also drives the server path end to end against the fixture's device login (FIXTURE_PASSWORD=fixture-office).
 * Usage: npm run build:client && FIXTURE_PORT=4707 FIXTURE_PASSWORD=fixture-office npx tsx tools/ui-fixture.ts
 *        FIXTURE_URL=http://127.0.0.1:4707/ npx tsx tools/setup-ui-check.ts   (writes docs/team/reports/setup/*.jpg)
 */
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import nacl from 'tweetnacl';
import { FakeGitHub } from '../tests/fake-github';

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

/** An in-memory api.github.com (tests/fake-github.ts): the real installer runs against it; nothing leaves the machine. */
function newGitHub() {
  const gh = new FakeGitHub();
  gh.login = 'octo-founder';
  gh.listed = repos;
  gh.plan = { name: 'free' };
  gh.publicKey = Buffer.from(nacl.box.keyPair().publicKey).toString('base64'); // a real X25519 key: the page seals for real
  return gh;
}
async function fakeGitHub(target: Page | BrowserContext, gh: FakeGitHub) {
  await target.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const res = await gh.handle(new URL(req.url()), { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined });
    const headers: Record<string, string> = { ...cors };
    res.headers.forEach((v, k) => (headers[k] = v));
    return route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
  });
}

/** Desktop shell with "Run on this computer": app.runLocal is cancelled once, then signs in to the fixture like the shell would. */
const FAKE_DESKTOP = (password: string) => `
  window.AGENT_EMPIRE_APP = Object.freeze({ platform: 'desktop', deviceName: 'Fixture Mac', localAvailable: true });
  window.__runLocalCalls = 0; const store = {};
  window.empireDesktop = { postMessage(m) {
    const N = () => window.__empireNative;
    setTimeout(async () => {
      switch (m.method) {
        case 'secure.get': return N().resolve(m.id, store[m.params.key] ?? null);
        case 'secure.set': store[m.params.key] = m.params.value; return N().resolve(m.id, true);
        case 'secure.delete': delete store[m.params.key]; return N().resolve(m.id, true);
        case 'app.runLocal': {
          if (window.__runLocalCalls++ === 0) return N().reject(m.id, 'cancelled: Running on this computer was cancelled. Nothing was started.');
          const res = await fetch(location.origin + '/api/device/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(password)}, deviceName: 'Fixture Mac (local)' }) });
          const body = await res.json();
          store.mode = 'local';
          return N().resolve(m.id, { mode: 'local', host: location.origin, token: body.token, deviceId: body.deviceId });
        }
        default: return N().resolve(m.id, true);
      }
    }, 20);
  } };
`;

/**
 * DEVICE-BUGS-03: every setup step at Android-like sizes and with larger text must fit the screen. On a real phone the
 * cloud "Choose your projects" panel grew to its 760px maximum (a long repository description set its min-content
 * width), so the lede, the descriptions and Next ran off the right edge. `scrollWidth` missed it (.su clips), so this
 * measures every element's visible right edge, honouring clipping ancestors inside the setup, and the primary button.
 */
const SWEEP_SIZES = [{ w: 667, h: 375 }, { w: 800, h: 360 }, { w: 915, h: 412 }, { w: 375, h: 812 }, { w: 1024, h: 768 }, { w: 740, h: 332 }]; // 740x332: a 915x412 phone with a larger Android "Display size"
/** Larger text: `zoom` scales the layout like Android "Display size"/browser zoom; `text` scales only the font sizes,
 * like Android font scale or Chrome's text scaling (WebView textZoom), which is the harsher case for fixed widths. */
const TEXT_CASES = [{ name: '100%', zoom: 1, text: 1 }, { name: 'zoom 130%', zoom: 1.3, text: 1 }, { name: 'text 130%', zoom: 1, text: 1.3 }];
const FITS = `(() => {
  const W = innerWidth, H = innerHeight, root = document.querySelector('.su'); const bad = [];
  for (const e of root.querySelectorAll('*')) {
    if (e.closest('.su-bg, .su-sr, .su-leave') || !e.getClientRects().length) continue;
    const r = e.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
    let left = r.left, right = r.right;
    for (let a = e.parentElement; a && a !== root; a = a.parentElement) {
      if (getComputedStyle(a).overflowX === 'visible') continue;
      const ar = a.getBoundingClientRect(); right = Math.min(right, ar.right); left = Math.max(left, ar.left);
    }
    if (right > W + 1 || (left < -1 && right > 0)) bad.push((typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : e.tagName.toLowerCase()) + '@' + Math.round(left) + '..' + Math.round(right));
  }
  const p = [...document.querySelectorAll('.su-panel:not(.su-leave) .su-foot .su-primary, .su-hero .su-primary')].find((b) => b.getClientRects().length);
  const pr = p && p.getBoundingClientRect();
  const primary = !p || (pr.left >= -1 && pr.right <= W + 1 && pr.top >= -1 && pr.bottom <= H + 1);
  return { bad: [...new Set(bad)].slice(0, 6), primary, page: document.documentElement.scrollWidth <= W };
})()`;
const SCALE_TEXT = (k: number) => `(() => { for (const e of document.querySelectorAll('.su *')) { e.style.removeProperty('font-size'); }
  if (${k} === 1) return; const sizes = [...document.querySelectorAll('.su *')].map((e) => [e, parseFloat(getComputedStyle(e).fontSize)]);
  for (const [e, px] of sizes) e.style.fontSize = (px * ${k}) + 'px'; })()`;
const LONG_DESC = 'Customer-facing storefront, checkout and inventory sync for the whole catalogue, with the nightly price import and the admin tools';
const longRepos = [
  ...repos.slice(0, 3),
  { ...repos[3], name: 'a-very-long-repository-name-that-has-no-spaces-anywhere-in-it', description: LONG_DESC },
  { ...repos[4], description: `${LONG_DESC} ${LONG_DESC}` },
  repos[8],
];

async function overflowSweep(browser: import('playwright-core').Browser) {
  const sweepOut = process.env.SWEEP_OUT ? resolve(process.env.SWEEP_OUT) : null;
  if (sweepOut) mkdirSync(sweepOut, { recursive: true });
  const sweep = async (page: Page, step: string, restore: { w: number; h: number }) => {
    for (const size of SWEEP_SIZES) for (const tc of TEXT_CASES) {
      await page.setViewportSize({ width: size.w, height: size.h });
      await page.evaluate(({ z }) => { document.documentElement.style.zoom = z === 1 ? '' : String(z); }, { z: tc.zoom });
      await page.evaluate(SCALE_TEXT(tc.text));
      await page.waitForTimeout(120);
      const r: { bad: string[]; primary: boolean; page: boolean } = await page.evaluate(FITS);
      ok(!r.bad.length && r.page && r.primary, `sweep ${step} ${size.w}x${size.h} ${tc.name}: nothing overflows horizontally and the primary action is on screen${r.bad.length ? ` (${r.bad.join(' ')})` : ''}${r.primary ? '' : ' (primary off screen)'}`);
      // SWEEP_OUT=<dir> saves every case (docs/team/reports/device-bugs-03 keeps a selection); routine runs save none.
      if (sweepOut) await page.screenshot({ path: resolve(sweepOut, `${step}-${size.w}x${size.h}${tc.name === '100%' ? '' : '-' + tc.name.replace(/\W+/g, '')}.jpg`), type: 'jpeg', quality: 78 });
    }
    await page.evaluate(SCALE_TEXT(1));
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    await page.setViewportSize({ width: restore.w, height: restore.h });
    await page.waitForTimeout(150);
  };
  const home = { w: 915, h: 412 };
  const newPage = async (init: string, touch: boolean) => {
    const context = await browser.newContext({ viewport: { width: home.w, height: home.h }, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1 });
    await context.addInitScript({ content: 'window.__name = (f) => f;' });
    if (init) await context.addInitScript({ content: init });
    return { context, page: await context.newPage() };
  };
  const primaryBtn = '.su-panel:not(.su-leave) .su-foot .su-primary';
  // App shell (Android-like bridge semantics are identical through the shared native layer): the whole cloud path.
  {
    const { context, page } = await newPage(FAKE_BRIDGE.replace("platform: 'ios'", "platform: 'android'").replace('window.webkit = {', 'window.empireAndroid = { postMessage(j) { window.webkit.messageHandlers.empire.postMessage(JSON.parse(j)); } }; window.webkit = {'), true);
    const gh = newGitHub();
    gh.listed = longRepos;
    await fakeGitHub(page, gh);
    await page.goto(base);
    await page.waitForSelector('.su-hero-title');
    await page.waitForTimeout(1400);
    await sweep(page, 'welcome', home);
    await page.locator('text=Set up my Empire').click();
    await page.waitForSelector('.su-card-cloud');
    await page.waitForTimeout(450);
    await sweep(page, 'mode', home);
    await page.locator('.su-card-cloud').click();
    await page.waitForSelector('text=Sign in with GitHub');
    await page.waitForTimeout(450);
    await sweep(page, 'github-device', home);
    await page.locator('text=Sign in with GitHub').click();
    await page.waitForSelector('.su-linked');
    await sweep(page, 'github-linked', home);
    await page.locator(primaryBtn).click();
    await page.waitForSelector('.su-repo');
    await page.locator('label[for="su-r-octo-founder-city-planner"]').click();
    await page.waitForTimeout(300);
    await sweep(page, 'repos', home);
    await page.locator(primaryBtn).click();
    await page.waitForSelector('#su-key-anthropic');
    await page.fill('#su-key-anthropic', 'sk-ant-FAKE-fixture-only-000000000000');
    await page.waitForTimeout(450);
    await sweep(page, 'engine', home);
    await page.locator(primaryBtn).click();
    await page.waitForSelector('#su-daily');
    await page.waitForTimeout(450);
    await sweep(page, 'limits', home);
    await page.locator(primaryBtn).click();
    await page.waitForSelector('.su-panel:not(.su-leave) .su-review');
    await page.waitForTimeout(450);
    await sweep(page, 'review', home);
    await page.locator('label[for="su-accept"]').click();
    gh.failures.push({ method: 'PUT', path: /\/actions\/secrets\/ANTHROPIC_API_KEY$/, status: 502, times: 1 });
    await page.locator(primaryBtn).click();
    await page.waitForSelector('.su-result .su-error');
    await sweep(page, 'create-failed', home);
    await context.close();
  }
  // App shell: own server.
  {
    const { context, page } = await newPage(FAKE_BRIDGE, true);
    await page.goto(base);
    await page.waitForSelector('.su-hero-title');
    await page.locator('text=Set up my Empire').click();
    await page.locator('.su-card-server').click();
    await page.waitForSelector('#su-address');
    await page.fill('#su-address', base.replace(/\/$/, ''));
    await page.fill('#su-password', 'wrong-password');
    await page.locator(primaryBtn).click();
    await page.waitForSelector('.su-error:not([hidden])');
    await sweep(page, 'server', home);
    await context.close();
  }
  // Desktop shell: three ways to run.
  {
    const { context, page } = await newPage(FAKE_DESKTOP(process.env.FIXTURE_PASSWORD || 'fixture-office'), false);
    await page.goto(base);
    await page.waitForSelector('.su-hero-title');
    await page.locator('text=Set up my Empire').click();
    await page.waitForSelector('.su-card-local');
    await page.waitForTimeout(450);
    await sweep(page, 'desktop-mode', home);
    await context.close();
  }
  // Web / PWA (no native bridge): the token fallback and the web server step.
  {
    const { context, page } = await newPage('', true);
    await page.route('**/api/whoami', (r) => r.fulfill({ status: 404, body: 'static host' }));
    await page.goto(base);
    await page.waitForSelector('.su-hero-title');
    await page.locator('text=Set up my Empire').click();
    await page.locator('.su-card-cloud').click();
    await page.waitForSelector('#su-gh-token');
    await page.waitForTimeout(450);
    await sweep(page, 'web-github-token', home);
    await page.keyboard.press('Escape');
    await page.locator('.su-card-server').click();
    await page.waitForTimeout(450);
    await sweep(page, 'web-server', home);
    await context.close();
  }
}

async function run() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  await overflowSweep(browser);
  if (process.env.SWEEP_ONLY) {
    await browser.close();
    console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
    process.exit(failures.length ? 1 : 0);
  }
  for (const size of sizes) {
    const tag = `${size.w}x${size.h}`;
    let textMode: unknown = null;
    let textGitHub: unknown = null;
    // ---- App (fake iOS bridge): the full cloud path, with the real installer against a fake GitHub ----
    {
      const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch, deviceScaleFactor: size.touch ? 1.5 : 1 });
      await context.addInitScript({ content: 'window.__name = (f) => f;' });
      await context.addInitScript({ content: FAKE_BRIDGE });
      await context.addInitScript({ content: "window.__touches=0;addEventListener('touchstart',()=>window.__touches++,{capture:true,passive:true});" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      const anthropicCalls: string[] = [];
      page.on('request', (r) => { if (/anthropic\.com/.test(new URL(r.url()).hostname)) anthropicCalls.push(r.url()); });
      const gh = newGitHub();
      await fakeGitHub(page, gh);
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
      // DEVTEST-02: since FREE-04 the cloud can run free (Qwen Code on GitHub Actions), on a Claude plan or with API keys.
      const cloudCard = (await page.locator('.su-card-cloud .su-card-points').textContent()) ?? '';
      ok(/free/i.test(cloudCard) && /Claude (plan|subscription)/.test(cloudCard) && /API keys/.test(cloudCard) && !/Uses your Claude and\/or OpenAI API keys/.test(cloudCard), `${tag} the cloud card names the free engine, a Claude plan and API keys (${cloudCard.replace(/\s+/g, ' ').trim()})`);
      textMode = await page.evaluate(SETUP_TEXT);
      // keyboard: Tab reaches the first card with a visible focus ring
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement?.className ?? '');
      ok(/su-btn|su-card/.test(focused), `${tag} keyboard focus moves into the choices (${focused})`);
      await press(page, size.touch, '.su-card-cloud');
      await shot('03-github-device');
      textGitHub = await page.evaluate(SETUP_TEXT);
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
      await page.fill('#su-project-token', 'ghp_classic000000000000000000000000000000');
      ok(await page.locator('.su-panel:not(.su-leave) .su-foot .su-primary').isDisabled(), `${tag} a classic project token blocks advancing`);
      await page.fill('#su-project-token', '');
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
      const est30 = await page.locator('.su-estimate').innerText();
      ok(/About 1,440 GitHub Actions minutes/.test(est30) && /72% of the 2,000 included on GitHub Free/.test(est30), `${tag} the default 30-minute schedule shows its minutes against the plan (${est30.slice(0, 90)})`);
      await press(page, size.touch, 'label[for="su-interval-15"]');
      await shot('08-limits');
      await press(page, size.touch, '.su-panel:not(.su-leave) .su-foot .su-primary');
      await shot('09-review');
      ok(await page.locator('.su-panel:not(.su-leave) .su-foot .su-primary').isDisabled(), `${tag} create needs the cost confirmation`);
      const estimate = await page.locator('.su-panel:not(.su-leave) .su-review').innerText();
      ok(/every 15 minutes/.test(estimate) && /2,880 Actions minutes a month/.test(estimate), `${tag} review shows the chosen schedule and its Actions minutes`);
      ok(/Jobs run[\s\S]*first run creates \(or reuses\) an Anthropic agent[\s\S]*not a billed item and starts no session/.test(estimate), `${tag} review says where jobs run and that execution setup is free and starts nothing`);
      ok(/with Claude Sonnet 5/.test(estimate) && /full internet access/.test(estimate) && /untrusted content/.test(estimate), `${tag} review states the owner defaults: Sonnet 5 and full internet access in the sandbox`);
      await press(page, size.touch, 'label[for="su-accept"]');
      // The first attempt fails at the secrets step (a GitHub 502); "Try again" must resume, not start over.
      gh.failures.push({ method: 'PUT', path: /\/actions\/secrets\/ANTHROPIC_API_KEY$/, status: 502, times: 1 });
      await press(page, size.touch, '.su-panel:not(.su-leave) .su-foot .su-primary');
      await page.waitForSelector('.su-result .su-error');
      await shot('10-create-failed-resumable');
      const failedText = await page.locator('.su-panel:not(.su-leave)').innerText();
      ok(/GitHub is having trouble/.test(failedText) && /continues where it stopped/.test(failedText), `${tag} a failed step says why and that retrying resumes`);
      ok(await page.locator('.su-prog.is-done').count() === 1 && await page.locator('.su-prog.is-failed').count() === 1, `${tag} progress shows the repository done and the secrets step failed`);
      await press(page, size.touch, '.su-panel:not(.su-leave) .su-foot .su-primary');
      await page.waitForSelector('.su-result .su-success', { timeout: 20000 });
      await shot('10b-create-done');
      ok(await page.locator('.su-prog.is-done').count() === 6, `${tag} all six steps done after resuming`);
      const execStep = await page.locator('.su-prog').nth(3).innerText();
      ok(/Request your Anthropic agent and environment/.test(execStep) && /requested/.test(execStep), `${tag} the execution step reports the request (${execStep.replace(/\s+/g, ' ').slice(0, 120)})`);
      ok(/sets up your Anthropic agent and environment on its first run/.test(await page.locator('.su-result').innerText()), `${tag} the result explains when execution becomes ready`);
      const writes = gh.writes;
      ok(writes.filter((w) => w === 'POST /user/repos').length === 1, `${tag} the repository is created once across both attempts`);
      ok(gh.repos.get('octo-founder/agent-empire-state')?.private === true, `${tag} the state repository is private`);
      const files = gh.files('octo-founder/agent-empire-state');
      ok(!!files['state/meta.json'] && !!files['.github/workflows/agent-empire.yml'] && (files['coordinator/agent-empire-coordinator.mjs'] ?? '').includes('runCoordinatorTick'), `${tag} state, workflow and the shipped coordinator bundle are committed`);
      ok(/cron: '\*\/15 \* \* \* \*'/.test(files['.github/workflows/agent-empire.yml'] ?? ''), `${tag} the workflow uses the chosen 15-minute schedule`);
      ok(!writes.some((w) => /dispatches|actions\/workflows/.test(w)) && !Object.keys(files).some((f) => f.startsWith('intents/')) && JSON.parse(files['state/jobs.json']).jobs.length === 0, `${tag} setup starts nothing: no run, no intent, no job`);
      ok(JSON.parse(files['state/meta.json']).provisioning?.status === 'pending' && JSON.parse(files['state/meta.json']).provisioning?.model === 'claude-sonnet-5' && anthropicCalls.length === 0, `${tag} execution setup is requested in the starting state; the device never calls Anthropic`);
      const secrets = [...gh.repos.get('octo-founder/agent-empire-state')!.secrets.values()];
      ok(secrets.length === 1 && !JSON.stringify(gh.requests.map((r) => r.body ?? null)).includes('sk-ant-FAKE'), `${tag} the key went only as a sealed box`);
      const log = await page.evaluate(() => (window as unknown as { __bridgeLog: { method: string; key?: string }[] }).__bridgeLog);
      ok(!log.some((l) => l.method === 'secure.set' && !['github.token', 'github.login', 'mode', 'state.repo', 'server.host', 'server.token', 'server.deviceId'].includes(l.key ?? '')), `${tag} only allowlisted keys stored`);
      const stored0 = await page.evaluate(() => (window as unknown as { __secureStore: Record<string, string> }).__secureStore);
      ok(!JSON.stringify(stored0).includes('sk-ant'), `${tag} provider keys never go to secure storage`);
      ok(stored0.mode === 'cloud' && stored0['state.repo'] === 'octo-founder/agent-empire-state', `${tag} cloud mode and the state repository are remembered`);
      // The game opens in cloud mode, fed from the new state repository.
      await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120000 });
      await page.waitForSelector('#modal-root .modal.charsel', { timeout: 20000 });
      await page.fill('.charsel input[aria-label="Your name"]', 'Ada');
      await press(page, size.touch, '.charsel button[type=submit]');
      await page.waitForFunction(() => /Waiting for first run/.test(document.querySelector('#status-strip')?.textContent ?? ''), null, { timeout: 20000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: resolve(out, `${tag}-10c-cloud-game-first-run.jpg`), type: 'jpeg', quality: 82 });
      ok(true, `${tag} the new Empire opens in cloud mode: "Waiting for first run"`);
      // Founding in a new cloud Empire (no execution settings yet): GitHub-coordinator wording, the plan only, no paid jobs.
      const founding = (await page.locator('#modal-root .founding-modal').innerText().catch(() => '')).replace(/\s+/g, ' ');
      ok(/coordinator runs in your own GitHub/.test(founding) && /records your plan only/.test(founding) && !/Rule-based server checks|configured account/.test(founding),
        `${tag} cloud founding explains the GitHub coordinator and, without execution settings, queues no paid jobs`);
      ok(!(await page.locator('#founding-confirm-paid').isVisible()) && /^Found my city$/.test((await page.locator('.founding-modal footer .btn.primary').innerText()).trim()), `${tag} cloud founding without paid jobs asks for no paid confirmation`);
      ok(errors.filter((e) => !/404|Failed to load resource/.test(e)).length === 0, `${tag} cloud create: no console errors (${errors.join(' | ')})`);
      await context.close();
    }
    // ---- App (fake iOS bridge): the server path ----
    {
      const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch, deviceScaleFactor: size.touch ? 1.5 : 1 });
      await context.addInitScript({ content: 'window.__name = (f) => f;' });
      await context.addInitScript({ content: FAKE_BRIDGE });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      const shot = async (name: string) => {
        await page.waitForTimeout(450);
        await page.screenshot({ path: resolve(out, `${tag}-${name}.jpg`), type: 'jpeg', quality: 82 });
      };
      await page.goto(base);
      await page.waitForSelector('.su-hero-title');
      await press(page, size.touch, 'text=Set up my Empire');
      await page.waitForSelector('.su-card-server');
      ok(!(await page.locator('.su-card-local').count()), `${tag} phones never offer "Run on this computer"`);
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
        if (item === 'Settings') {
          // DEVICE-BUGS-03: Settings names the game build, so a release and a newer build of the same version differ.
          const versions = (await page.locator('.update-versions').first().innerText().catch(() => '')).trim();
          ok(/^Game \d+\.\d+\.\d+\S* \(build [0-9a-f]{7}\+?(, \d{1,2} \w{3} \d{4})?\)/.test(versions), `${tag} Settings shows the game version with its build (${versions})`);
        }
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
    // ---- Desktop shell: "Run on this computer" (app.runLocal) ----
    {
      const context = await browser.newContext({ viewport: { width: size.w, height: size.h } });
      await context.addInitScript({ content: 'window.__name = (f) => f;' });
      await context.addInitScript({ content: FAKE_DESKTOP(process.env.FIXTURE_PASSWORD || 'fixture-office') });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base);
      await page.waitForSelector('.su-hero-title');
      await page.locator('text=Set up my Empire').click();
      await page.waitForSelector('.su-card-local');
      await page.waitForTimeout(450);
      ok(await page.locator('.su-cards-3 .su-card').count() === 3, `${tag} desktop with localAvailable offers three ways to run`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      ok(!overflow, `${tag} desktop mode choice: no horizontal overflow`);
      await page.screenshot({ path: resolve(out, `${tag}-desktop-01-three-cards.jpg`), type: 'jpeg', quality: 82 });
      await page.locator('.su-card-local').click();
      await page.waitForFunction(() => (window as unknown as { __runLocalCalls: number }).__runLocalCalls === 1);
      await page.waitForTimeout(300);
      ok(await page.locator('.su-card-local').isVisible() && (await page.locator('.su-panel:not(.su-leave) .su-error:not([hidden])').count()) === 0, `${tag} a cancelled native dialog leaves the choice on screen with no error`);
      await page.locator('.su-card-local').click();
      await page.waitForFunction(() => ['loading', 'ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 20000 });
      await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120000 });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: resolve(out, `${tag}-desktop-02-local-game.jpg`), type: 'jpeg', quality: 82 });
      ok(await page.evaluate(() => !document.getElementById('setup')), `${tag} after app.runLocal the game opens without a reload`);
      ok(errors.length === 0, `${tag} desktop local: no page errors (${errors.join(' | ')})`);
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
