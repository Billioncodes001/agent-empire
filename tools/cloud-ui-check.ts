/**
 * Cloud mode (CLOUD-04/05) acceptance against the isolated UI fixture and an in-memory api.github.com (never the
 * protected 4610 session, never real GitHub, no paid calls). The state repository is seeded by the real installer and
 * real coordinator ticks with a fake provider, so the app reads exactly what a coordinator writes.
 *
 *   npm run build:client && FIXTURE_PORT=4708 npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://127.0.0.1:4708/ npx tsx tools/cloud-ui-check.ts      (writes docs/team/reports/cloud-mode/*.jpg)
 */
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { GitHubClient, GitHubStateStore } from '../src/cloud/store';
import { installStateRepository } from '../src/cloud/installer';
import { runCoordinatorTick } from '../src/cloud/tick';
import { CloudRepo } from '../src/client/cloud/repo';
import { uuidv7 } from '../src/client/cloud/uuid';
import { FakeGitHub } from '../tests/fake-github';
import { EXECUTION, FakeProvider } from '../tests/cloud-fixtures';

const base = process.env.FIXTURE_URL || 'http://127.0.0.1:4708/';
if (/:4610\b/.test(base)) throw new Error('never 4610');
const out = resolve(process.env.OUT || 'docs/team/reports/cloud-mode');
mkdirSync(out, { recursive: true });
const failures: string[] = [];
const ok = (cond: unknown, name: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures.push(name); };
const FULL = 'founder/agent-empire-state';
const TOKEN = 'gho_FAKEFIXTURETOKEN000000000000000000';

/** A state repository as a coordinator leaves it: founded city, jobs in several states, spend, journal. */
async function seed() {
  const gh = new FakeGitHub();
  const now = Date.now();
  const t0 = now - 3 * 3600_000;
  await installStateRepository(new GitHubClient(TOKEN, { fetch: gh.fetch }), {
    secrets: { ANTHROPIC_API_KEY: 'sk-ant-fixture' }, limits: { maxConcurrent: 3, perTaskBudgetCents: 500, dailyBudgetCents: 2000 },
    execution: EXECUTION, coordinatorBundle: '// bundle\n', now: t0, sleep: async () => {},
  }, async (k, v) => `sealed(${k}):${Buffer.from(v).toString('base64').split('').reverse().join('')}`);
  const store = new GitHubStateStore(new GitHubClient('ghs_actions', { fetch: gh.fetch }), { owner: 'founder', repo: 'agent-empire-state', branch: 'main', workflowFile: 'agent-empire.yml' });
  const provider = new FakeProvider();
  let run = 0;
  const tick = (at: number) => runCoordinatorTick({ store, provider, now: () => at, runId: `seed-${++run}`, allowSelfDisable: true, retry: { sleep: async () => {} } });
  const client = new CloudRepo({ owner: 'founder', name: 'agent-empire-state' }, TOKEN, gh.fetch);
  await client.submit({ kind: 'empire_action', action: { kind: 'found', sites: ['hospital', 'cafe'] } }, 'agent-empire-intent', t0 + 1000);
  await tick(t0 + 60_000);
  const snap = await client.poll();
  const rev = snap.changed ? snap.snapshot.state.meta.configRevision : 0;
  const titles = ['Fix the checkout total rounding', 'Write the clinic intake form', 'Draft the café menu page', 'Add a status badge to the README', 'Translate the onboarding emails'];
  const ids = titles.map((_, i) => uuidv7(t0 + 120_000 + i));
  for (const [i, title] of titles.entries())
    await client.submit({ kind: 'new_job', job: { id: ids[i], title, prompt: `${title}. Work on a branch and open a pull request.`, ...(i === 1 ? { site: 'hospital' as const } : i === 2 ? { site: 'cafe' as const } : {}), configRevision: rev, confirmPaid: true } }, 'agent-empire-intent', t0 + 120_000 + i);
  await tick(t0 + 180_000); // dispatches 3 (maxConcurrent)
  provider.finish(ids[0], 'end_turn', 180);
  provider.finish(ids[1], 'end_turn', 95);
  await tick(t0 + 40 * 60_000);
  await client.submit({ kind: 'review', jobId: ids[1], decision: 'accept' }, 'agent-empire-intent', t0 + 41 * 60_000);
  await tick(t0 + 50 * 60_000);
  await tick(now - 12 * 60_000); // the last committed snapshot: 12 minutes old
  return { gh, provider, ids, titles };
}

async function routeGitHub(context: BrowserContext, gh: FakeGitHub, opts: { offline?: () => boolean } = {}) {
  await context.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag, Link, X-RateLimit-Remaining' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': 'Authorization, Content-Type, If-None-Match, X-GitHub-Api-Version, Accept', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE' } });
    if (opts.offline?.()) return route.abort('internetdisconnected');
    const res = await gh.handle(new URL(req.url()), { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined });
    const headers: Record<string, string> = { ...cors };
    res.headers.forEach((v, k) => (headers[k] = v));
    return route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
  });
}

const IOS_BRIDGE = (token: string) => `
  window.AGENT_EMPIRE_APP = Object.freeze({ platform: 'ios', deviceName: 'Fixture iPhone' });
  const store = JSON.parse(sessionStorage.getItem('fixture-secure') || 'null') || { mode: 'cloud', 'state.repo': '${FULL}', 'github.token': '${token}', 'github.login': 'founder' };
  const save = () => sessionStorage.setItem('fixture-secure', JSON.stringify(store));
  window.webkit = { messageHandlers: { empire: { postMessage(m) {
    const N = () => window.__empireNative;
    setTimeout(() => {
      switch (m.method) {
        case 'secure.get': return N().resolve(m.id, store[m.params.key] ?? null);
        case 'secure.set': store[m.params.key] = m.params.value; save(); return N().resolve(m.id, true);
        case 'secure.delete': delete store[m.params.key]; save(); return N().resolve(m.id, true);
        default: return N().resolve(m.id, true);
      }
    }, 10);
  } } } };
  window.__secure = store;
`;

async function newPage(context: BrowserContext) {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  return { page, errors };
}
async function waitGame(page: Page) {
  await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
  await page.waitForFunction(() => !!document.querySelector('#status-strip.cloud-strip') && /Snapshot|Waiting|shut|overdue/i.test(document.querySelector('#status-strip')?.textContent ?? ''), null, { timeout: 20_000 });
  await page.waitForTimeout(800);
}
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(out, `${name}.jpg`), type: 'jpeg', quality: 78, animations: 'disabled' });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
async function closeModals(page: Page) {
  for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
}

async function run() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const sizes = [
    { tag: 'phone-landscape-874x402', w: 874, h: 402, touch: true },
    { tag: 'phone-375-landscape-812x375', w: 812, h: 375, touch: true },
    { tag: 'desktop-1440x900', w: 1440, h: 900, touch: false },
  ];
  for (const size of sizes) {
    const { gh, provider, ids } = await seed();
    const sessionsAtStart = provider.sessions.size;
    const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch, deviceScaleFactor: size.touch ? 1.5 : 1 });
    await context.addInitScript({ content: 'window.__name = (f) => f;' });
    await context.addInitScript({ content: IOS_BRIDGE(TOKEN) });
    await context.addInitScript(() => localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture Founder', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } })));
    let offline = false;
    await routeGitHub(context, gh, { offline: () => offline });
    const { page, errors } = await newPage(context);
    await page.goto(base);
    await waitGame(page);
    const strip = (await page.locator('#status-strip').innerText()).replace(/\s+/g, ' ');
    const visible = await page.locator('#status-strip .status-chief .status-value').innerText();
    ok(/^\u2601\uFE0E? Snapshot 1[12] min ago$/.test(visible), `${size.tag} the always-visible HUD value marks cloud and gives the snapshot age (${visible})`);
    ok(!/\blive\b/i.test(strip.replace(/not live/gi, '')), `${size.tag} the HUD never calls the data live`);
    ok(await page.evaluate(() => (window as any).__office.store.evidence().fresh === false), `${size.tag} store evidence is never fresh in cloud mode`);
    ok(await noOverflow(page), `${size.tag} no horizontal overflow (game)`);
    await shot(page, `${size.tag}-01-cloud-hud`);
    // Server-only features are visibly unavailable and explain themselves; nothing is written.
    const writesBefore = gh.writes.length;
    const disabled = await page.evaluate(() => ['btn-voice', 'btn-share', 'btn-services', 'btn-decor'].map((id) => document.getElementById(id)?.getAttribute('aria-disabled')));
    ok(disabled.every((v) => v === 'true'), `${size.tag} voice, share, services and pictures are marked unavailable (${disabled.join(',')})`);
    await page.evaluate(() => (document.getElementById('btn-services') as HTMLButtonElement).click());
    await page.waitForSelector('#modal-root .modal[aria-labelledby="cloud-only-title"]');
    ok(/needs a connected Agent Empire server/.test(await page.locator('#modal-root .modal').innerText()), `${size.tag} a server-only feature explains why it is disabled`);
    await shot(page, `${size.tag}-02-server-only`);
    await closeModals(page);
    ok(gh.writes.length === writesBefore, `${size.tag} nothing is written for a server-only feature`);
    // Cloud Empire window: status, jobs, journal; all from the snapshot.
    await page.evaluate(() => (document.querySelector('#status-strip .status-chief') as HTMLButtonElement).click());
    await page.waitForSelector('.cloud-modal');
    const statusText = await page.locator('.cloud-modal').innerText();
    ok(/Shut down Empire/.test(statusText) && /billed GitHub Actions minutes/.test(statusText) && /not live/.test(statusText), `${size.tag} status tab: shutdown control, Actions estimate, not-live label`);
    ok(await noOverflow(page), `${size.tag} no horizontal overflow (Cloud Empire)`);
    await shot(page, `${size.tag}-03-cloud-status`);
    await page.locator('.cloud-modal .empire-tab', { hasText: 'Jobs' }).click();
    await page.waitForSelector('.cloud-job');
    const pills = await page.locator('.cloud-job .cloud-pill').allInnerTexts();
    ok(pills.includes('Ready for review') && pills.includes('Accepted') && pills.includes('Running') && pills.includes('Queued'), `${size.tag} jobs show recorded statuses (${pills.join(', ')})`);
    await shot(page, `${size.tag}-04-cloud-jobs`);
    // Accept the job that is ready for review: one intent + one wake-up.
    const mark = gh.requests.length;
    await page.locator(`.cloud-job[data-job="${ids[0]}"] button`, { hasText: 'Accept' }).click();
    await page.waitForFunction(() => document.querySelector('#toasts')?.textContent?.includes('sent'), null, { timeout: 10_000 });
    const writes = gh.requests.slice(mark).filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
    ok(writes.length === 2 && /^PUT \/repos\/founder\/agent-empire-state\/contents\/intents\/[0-9a-f-]{36}\.json$/.test(writes[0]) && writes[1].endsWith('/dispatches'), `${size.tag} accept writes one UUIDv7 intent and one dispatch (${writes.join(', ')})`);
    const intent = JSON.parse(Object.entries(gh.files(FULL)).find(([p, t]) => p.startsWith('intents/') && t.includes('"review"'))![1]);
    ok(intent.kind === 'review' && intent.decision === 'accept' && intent.jobId === ids[0] && /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(intent.id), `${size.tag} the intent is schema-valid UUIDv7 review/accept`);
    // New paid job: the confirmation is explicit and names the allowance.
    await page.locator('.cloud-modal .empire-tab', { hasText: 'New job' }).click();
    await page.fill('.cloud-modal input[aria-label="Job title"]', 'Fixture: tidy the README');
    await page.fill('.cloud-modal textarea', 'Tidy the README headings. Fixture only; nothing runs.');
    await page.locator('.cloud-modal button', { hasText: 'Review cost' }).click();
    await page.waitForSelector('.cloud-confirm');
    const confirmText = await page.locator('.cloud-confirm').innerText();
    ok(/\$5\.00/.test(confirmText) && /Billed by Anthropic/.test(confirmText) && /revision \d+/.test(confirmText), `${size.tag} the job confirmation names the allowance, billing and config revision`);
    ok(await page.locator('.cloud-confirm button', { hasText: 'Start paid job' }).isDisabled(), `${size.tag} the paid job needs the explicit tick`);
    ok(await noOverflow(page), `${size.tag} no horizontal overflow (job confirmation)`);
    await shot(page, `${size.tag}-05-job-confirm`);
    await page.locator('#cloud-confirm-paid').check();
    const before = gh.requests.length;
    await page.locator('.cloud-confirm button', { hasText: 'Start paid job' }).click();
    await page.waitForFunction((n) => (window as any).__office.store.cloud?.busy === false, null);
    await page.waitForTimeout(600);
    const jobIntentPath = gh.requests.slice(before).find((r) => r.method === 'PUT' && r.path.includes('/contents/intents/'))?.path;
    const jobIntent = jobIntentPath ? JSON.parse(gh.files(FULL)[jobIntentPath.split('/contents/')[1]]) : null;
    ok(jobIntent?.kind === 'new_job' && jobIntent.job.confirmPaid === true && Number.isInteger(jobIntent.job.configRevision), `${size.tag} new_job intent carries confirmPaid and configRevision`);
    ok(provider.sessions.size === sessionsAtStart, `${size.tag} the app makes no provider call; sessions are only started by the coordinator (${provider.sessions.size} = ${sessionsAtStart} seeded)`);
    await closeModals(page);
    // Shut down: confirmation explains the effects; intent + shutdown wake-up.
    await page.evaluate(() => (document.getElementById('btn-menu') as HTMLButtonElement).click());
    await page.waitForSelector('.game-menu');
    ok(await page.locator('.game-menu .menu-item', { hasText: 'Shut down Empire' }).count() === 1 && await page.locator('.game-menu .menu-item', { hasText: 'Forget this device' }).count() === 1, `${size.tag} menu has Shut down Empire and Forget this device`);
    await shot(page, `${size.tag}-06-menu`);
    await page.locator('.game-menu .menu-item', { hasText: 'Shut down Empire' }).click();
    await page.waitForSelector('.cloud-confirm');
    const shutText = await page.locator('.cloud-confirm').innerText();
    ok(/interrupted and archived/.test(shutText) && /workflow is disabled/.test(shutText) && /no catch-up revenue/.test(shutText), `${size.tag} shutdown confirmation explains sessions, workflow and no catch-up`);
    await shot(page, `${size.tag}-07-shutdown-confirm`);
    await page.locator('.cloud-confirm button', { hasText: 'Shut down Empire' }).click();
    await page.waitForFunction(() => document.querySelector('#toasts')?.textContent?.includes('Shut down Empire: sent'), null, { timeout: 10_000 });
    ok(gh.repos.get(FULL)!.dispatches.includes('agent-empire-shutdown'), `${size.tag} shutdown wakes the coordinator with agent-empire-shutdown`);
    // Keyboard: Escape closes, focus returns to the game.
    await page.evaluate(() => (document.querySelector('#status-strip .status-workforce') as HTMLButtonElement).focus());
    await page.keyboard.press('Enter');
    await page.waitForSelector('.cloud-modal');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    ok(!(await page.locator('.cloud-modal').count()), `${size.tag} Escape closes the Cloud Empire window`);
    // Relaunch offline: the saved snapshot shows immediately, labelled saved.
    offline = true;
    await page.reload();
    await waitGame(page);
    const saved = await page.locator('#status-strip .status-chief .status-value').innerText();
    ok(/Saved · Snapshot/.test(saved), `${size.tag} relaunch offline shows the saved snapshot, labelled (${saved})`);
    ok(await page.locator('#conn').isVisible() && /Can’t reach GitHub|offline/.test(await page.locator('#conn').innerText()), `${size.tag} the connection banner says GitHub can’t be reached`);
    ok(await page.evaluate(() => (window as any).__office.store.cloud?.source === 'saved' && (window as any).__office.store.cloud?.error?.code === 'offline'), `${size.tag} the store knows it is a saved snapshot and GitHub is unreachable`);
    await shot(page, `${size.tag}-08-relaunch-offline-saved`);
    offline = false;
    const unexpected = errors.filter((e) => !/internetdisconnected|ERR_INTERNET_DISCONNECTED|Failed to fetch/i.test(e));
    ok(unexpected.length === 0, `${size.tag} no console errors (${unexpected.join(' | ') || 'none'})`);
    await context.close();
  }
  // Reduced motion + Save-Data, web build (no shell): unlock screen, then the game.
  {
    const { gh } = await seed();
    const context = await browser.newContext({ viewport: { width: 874, height: 402 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce', extraHTTPHeaders: { 'Save-Data': 'on' } });
    await context.addInitScript({ content: 'window.__name = (f) => f;' });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true });
      localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Web Founder', color: '#32685c', look: { skin: 2, hair: 1, style: 0 } }));
      localStorage.setItem('agent-empire.setup.mode', 'cloud');
      localStorage.setItem('agent-empire.setup.state.repo', 'founder/agent-empire-state');
    });
    await context.route('**/api/whoami', (r) => r.fulfill({ status: 404, body: 'static host' }));
    await routeGitHub(context, gh);
    const { page, errors } = await newPage(context);
    await page.goto(base);
    await page.waitForSelector('#su-unlock-token');
    ok(await page.evaluate(() => document.querySelector('.su')?.classList.contains('su-reduced') && document.querySelector('.su')?.classList.contains('su-lite')), 'web unlock honours reduced motion and Save-Data');
    await shot(page, 'web-874x402-09-unlock');
    await page.fill('#su-unlock-token', TOKEN);
    await page.locator('.su-foot .su-primary').click();
    await waitGame(page);
    ok(/Cloud mode/.test(await page.locator('#status-strip').innerText()), 'web: the cloud game opens after signing in again');
    ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(TOKEN), 'web: the GitHub token is never written to localStorage');
    await shot(page, 'web-874x402-10-cloud-hud-reduced-motion');
    ok(errors.length === 0, `web: no console errors (${errors.join(' | ') || 'none'})`);
    await context.close();
  }
  await browser.close();
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
