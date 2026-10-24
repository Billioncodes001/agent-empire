/**
 * FREE-04 UI check: the cloud engine choice in setup (free Qwen / Claude subscription / API keys), the subscription
 * checklist with the secret-NAME check, and creation with the job workflow, against the isolated fixture (never 4610)
 * and an in-memory api.github.com (Playwright route; nothing leaves the machine; no Actions run is started).
 * Usage: npm run build:client && FIXTURE_PORT=4861 FIXTURE_PASSWORD=fixture-office npx tsx tools/ui-fixture.ts
 *        FIXTURE_URL=http://127.0.0.1:4861/ npx tsx tools/free-04-ui-check.ts   (writes docs/team/reports/free-04/*.jpg)
 */
import { chromium, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import nacl from 'tweetnacl';
import { FakeGitHub } from '../tests/fake-github';

const base = process.env.FIXTURE_URL || 'http://127.0.0.1:4861/';
if (/:4610\b/.test(base)) throw new Error('never 4610');
const out = resolve(process.env.OUT || 'docs/team/reports/free-04');
mkdirSync(out, { recursive: true });
const sizes = [{ w: 874, h: 402, touch: true }, { w: 1440, h: 900, touch: false }];
const failures: string[] = [];
const ok = (cond: unknown, name: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures.push(name); };
const PROJECT = 'octo-founder/city-planner';

const FAKE_BRIDGE = `
  window.AGENT_EMPIRE_APP = Object.freeze({ platform: 'ios', deviceName: 'Fixture iPhone' });
  const store = {};
  window.webkit = { messageHandlers: { empire: { postMessage(m) {
    const N = () => window.__empireNative;
    setTimeout(() => {
      switch (m.method) {
        case 'secure.get': return N().resolve(m.id, store[m.params.key] ?? null);
        case 'secure.set': store[m.params.key] = m.params.value; return N().resolve(m.id, true);
        case 'secure.delete': delete store[m.params.key]; return N().resolve(m.id, true);
        case 'github.deviceFlow': return setTimeout(() => N().resolve(m.id, { token: 'gho_FAKEFIXTURETOKEN000000000000000000', login: 'octo-founder' }), 300);
        default: return N().resolve(m.id, true);
      }
    }, 20);
  } } } };
`;

function newGitHub() {
  const gh = new FakeGitHub();
  gh.login = 'octo-founder';
  gh.listed = [{ name: 'city-planner', owner: { login: 'octo-founder' }, private: false, default_branch: 'main', description: 'Zoning service', pushed_at: new Date().toISOString(), permissions: { push: true, admin: true } }];
  gh.publicKey = Buffer.from(nacl.box.keyPair().publicKey).toString('base64');
  gh.create(PROJECT, false, { 'README.md': '# city planner\n' });
  return gh;
}

async function press(page: Page, touch: boolean, selector: string) {
  const target = page.locator(selector).first();
  if (!touch) return target.click();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`nothing to tap: ${selector}`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function run() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const size of sizes) {
    const tag = `${size.w}x${size.h}`;
    const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch, deviceScaleFactor: size.touch ? 1.5 : 1, reducedMotion: size.touch ? 'reduce' : 'no-preference' });
    await context.addInitScript({ content: 'window.__name = (f) => f;' });
    await context.addInitScript({ content: FAKE_BRIDGE });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Expected GitHub 404s ("file not there yet") are answered by the fake; any other failed load is an error.
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    page.on('response', (r) => { if (r.status() >= 400 && !r.url().startsWith('https://api.github.com/')) errors.push(`${r.status()} ${r.url()}`); });
    const gh = newGitHub();
    await page.route('https://api.github.com/**', async (route) => {
      const req = route.request();
      const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      const res = await gh.handle(new URL(req.url()), { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined });
      const headers: Record<string, string> = { ...cors };
      res.headers.forEach((v, k) => (headers[k] = v));
      return route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    });
    const shot = async (name: string) => {
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.querySelector('.su')!.scrollWidth > innerWidth);
      ok(!overflow, `${tag} ${name}: no horizontal overflow`);
      await page.screenshot({ path: resolve(out, `${tag}-${name}.jpg`), type: 'jpeg', quality: 82, fullPage: false });
    };
    const primary = '.su-panel:not(.su-leave) .su-foot .su-primary';
    await page.goto(base);
    await page.waitForSelector('.su-hero-title');
    await press(page, size.touch, 'text=Set up my Empire');
    await page.waitForSelector('.su-card-cloud');
    await press(page, size.touch, '.su-card-cloud');
    await press(page, size.touch, 'text=Sign in with GitHub');
    await page.waitForSelector('.su-linked');
    await press(page, size.touch, primary);
    await page.waitForSelector('.su-repo');
    await press(page, size.touch, 'label[for="su-r-octo-founder-city-planner"]');
    await press(page, size.touch, primary);
    await page.waitForSelector('.su-engines');
    await shot('01-engine-choice');
    ok(await page.locator('#su-engine-api-keys').isChecked(), `${tag} today’s API-key path stays the default`);
    ok(await page.locator('#su-key-anthropic').isVisible(), `${tag} API key fields show for the API-key engine`);

    // Keyboard: arrow keys move between engines in the radio group.
    await page.locator('#su-engine-api-keys').focus();
    await page.keyboard.press('ArrowLeft');
    ok(await page.locator('#su-engine-claude-subscription').isChecked(), `${tag} arrow keys switch the engine`);

    // Free engine.
    await press(page, size.touch, 'label[for="su-engine-qwen-free"]');
    ok(!(await page.locator('#su-key-anthropic').isVisible()), `${tag} the free engine asks for no API key`);
    ok(await page.locator(primary).isDisabled(), `${tag} free engine needs a model source and the project token`);
    const freeText = await page.locator('#su-panel-free').innerText();
    ok(/qwen2\.5-coder:1\.5b/.test(freeText) && /986 MB/.test(freeText) && /Apache-2\.0/.test(freeText) && /slow/i.test(freeText), `${tag} the CPU model shows its name, size, licence and that it is slow`);
    ok(/may log prompts and code and use them for training/.test(freeText), `${tag} the free hosted key carries a data-use warning`);
    ok(/free in public repositories/.test(await page.locator('.su-engine-actions').innerText()), `${tag} public vs private minutes are explained`);
    await press(page, size.touch, 'label[for="su-free-cpu"]');
    await page.fill('#su-project-token', 'github_pat_FAKEFIXTURE0000000000000000000000');
    await page.waitForTimeout(100);
    ok(!(await page.locator(primary).isDisabled()), `${tag} free engine with the CPU model and a project token may continue`);
    await shot('02-free-engine');

    // Claude subscription: checklist; the Empire has no token field and checks only the secret name.
    await press(page, size.touch, 'label[for="su-engine-claude-subscription"]');
    const subText = await page.locator('#su-panel-sub').innerText();
    ok(/claude setup-token/.test(subText) && new RegExp(`gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ${PROJECT}`).test(subText) && /install-github-app/.test(subText), `${tag} the checklist shows the user’s own terminal commands`);
    ok(/never asks for, sees or stores your Claude token/.test(subText), `${tag} the page says the token is never collected`);
    const tokenFields = await page.evaluate(() => [...document.querySelectorAll('input')].filter((i) => /claude|oauth/i.test(i.id + i.name + i.placeholder) && i.type !== 'radio').length);
    ok(tokenFields === 0, `${tag} there is no input for a Claude token`);
    ok(await page.locator(primary).isDisabled(), `${tag} cannot continue before the secret exists`);
    await press(page, size.touch, '.su-secret button');
    await page.waitForFunction(() => /isn’t in/.test(document.querySelector('.su-secret-status')?.textContent ?? ''));
    await shot('03-subscription-missing');
    // The user runs `gh secret set` in their own terminal (simulated directly in the fake GitHub).
    gh.repos.get(PROJECT)!.secrets.set('CLAUDE_CODE_OAUTH_TOKEN', { encrypted_value: 'sealed-by-gh-cli', key_id: 'key-1' });
    await press(page, size.touch, '.su-secret button');
    await page.waitForFunction(() => /Found CLAUDE_CODE_OAUTH_TOKEN/.test(document.querySelector('.su-secret-status')?.textContent ?? ''));
    ok(/rotate it after 11 months/.test(await page.locator('.su-secret-status').innerText()), `${tag} the rotation reminder is shown`);
    ok(!(await page.locator(primary).isDisabled()), `${tag} with the secret present, setup may continue`);
    await shot('04-subscription-present');
    const secretReads = gh.requests.filter((r) => r.path.includes('/actions/secrets') && r.path.startsWith(`/repos/${PROJECT}`));
    ok(secretReads.length >= 2 && secretReads.every((r) => r.method === 'GET'), `${tag} the project secrets were only listed, never written`);

    // Review and create.
    await press(page, size.touch, primary);
    await press(page, size.touch, primary);
    await page.waitForSelector('.su-review');
    const review = await page.locator('.su-review').innerText();
    ok(/Claude Code in your GitHub Actions/.test(review) && /never seen by the Empire/.test(review) && /agent-empire-job\.yml/.test(review), `${tag} review states the engine and the job workflow`);
    await shot('05-review');
    await press(page, size.touch, 'label[for="su-accept"]');
    await press(page, size.touch, primary);
    // Count finished progress steps as they happen: with reduced motion the setup hands over to the game at once.
    await page.evaluate(() => { (window as any).__done = new Set(); new MutationObserver(() => document.querySelectorAll('.su-prog.is-done').forEach((li) => (window as any).__done.add(li.textContent))).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true }); });
    await page.waitForFunction(() => !!document.querySelector('.su-result .su-success, .su-result .su-error') || !document.querySelector('.su-panel'), undefined, { timeout: 20000 });
    if (await page.locator('.su-result .su-error').count()) console.log('CREATE ERROR: ' + (await page.locator('.su-result').innerText()));
    if (await page.locator('.su-result .su-success').count()) await shot('06-created');
    ok(await page.evaluate(() => (window as any).__done.size) === 7, `${tag} all seven steps done, including the job workflow`);
    const files = gh.files(PROJECT);
    const wf = files['.github/workflows/agent-empire-job.yml'] ?? '';
    ok(/claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/.test(wf) && /^permissions: \{\}$/m.test(wf), `${tag} the job workflow was committed to the project`);
    const meta = JSON.parse(gh.files('octo-founder/agent-empire-state')['state/meta.json']);
    ok(meta.execution?.provider === 'github-actions' && meta.execution.actions.engine === 'claude-subscription', `${tag} the state records GitHub Actions execution`);
    const stateSecrets = [...gh.repos.get('octo-founder/agent-empire-state')!.secrets.keys()];
    ok(stateSecrets.length === 1 && stateSecrets[0] === 'PROJECT_GITHUB_TOKEN', `${tag} only the project token was sealed; no Claude token anywhere`);
    ok(!gh.requests.some((r) => /dispatches/.test(r.path)), `${tag} setup starts no run`);
    ok(errors.length === 0, `${tag} no console errors (${errors.slice(0, 2).join(' | ')})`);
    await context.close();
  }
  await browser.close();
  if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
  console.log('\nall FREE-04 setup checks passed');
}
void run();
