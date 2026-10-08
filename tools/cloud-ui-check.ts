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
import { FakeGitHub } from '../tests/fake-github';
import { seed, seedProvisioning, seedUnfounded, TOKEN } from './cloud-seed';

const base = process.env.FIXTURE_URL || 'http://127.0.0.1:4708/';
if (/:4610\b/.test(base)) throw new Error('never 4610');
const out = resolve(process.env.OUT || 'docs/team/reports/cloud-mode');
mkdirSync(out, { recursive: true });
const failures: string[] = [];
const ok = (cond: unknown, name: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures.push(name); };
const FULL = 'founder/agent-empire-state';

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

/** The window is inside the safe area, centred in it, and its close button (if any) is on screen, on top, and >= 44px on touch. */
async function inSafeArea(page: Page, selector: string, size: { w: number; h: number; touch: boolean; insets: { top: number; right: number; bottom: number; left: number } }) {
  await page.waitForTimeout(250); // past the window's open animation (scale .96 -> 1)
  const r = await page.evaluate((sel) => {
    const m = document.querySelector(sel)!.getBoundingClientRect();
    const c = document.querySelector(sel)!.querySelector('header .close')?.getBoundingClientRect();
    const top = c && document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
    return { x: m.left, y: m.top, w: m.width, h: m.height, close: c ? { x: c.left, y: c.top, w: c.width, h: c.height, hit: !!top?.closest('.close') } : null };
  }, selector);
  const s = { l: size.insets.left, t: size.insets.top, r: size.w - size.insets.right, b: size.h - size.insets.bottom };
  const inside = (b: { x: number; y: number; w: number; h: number }) => b.x >= s.l - 0.5 && b.y >= s.t - 0.5 && b.x + b.w <= s.r + 0.5 && b.y + b.h <= s.b + 0.5;
  const centred = Math.abs(r.x + r.w / 2 - (s.l + s.r) / 2) <= 1.5;
  const close = !r.close || (inside(r.close) && r.close.hit && (!size.touch || (r.close.w >= 43.5 && r.close.h >= 43.5)));
  if (!(inside(r) && centred && close)) console.log(`      ${selector}: ${JSON.stringify(r)} safe ${JSON.stringify(s)}`);
  return inside(r) && centred && close;
}

async function run() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  // Phones run with the Dynamic Island / notch emulated on the left (real env(safe-area-inset-*) through CDP).
  const sizes = [
    { tag: 'phone-landscape-874x402', w: 874, h: 402, touch: true, insets: { top: 0, right: 0, bottom: 20, left: 62 } },
    { tag: 'phone-375-landscape-812x375', w: 812, h: 375, touch: true, insets: { top: 0, right: 44, bottom: 21, left: 0 } },
    { tag: 'desktop-1440x900', w: 1440, h: 900, touch: false, insets: { top: 0, right: 0, bottom: 0, left: 0 } },
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
    await (await context.newCDPSession(page)).send('Emulation.setSafeAreaInsetsOverride' as any, { insets: size.insets });
    await page.goto(base);
    await waitGame(page);
    const glyph = await page.locator('#status-strip .status-chief .cloud-glyph').boundingBox();
    ok(!!glyph && glyph.width >= 14 && glyph.height >= 10, `${size.tag} the HUD cloud mark is drawn at a legible size (${glyph ? `${glyph.width.toFixed(0)}x${glyph.height.toFixed(0)}` : 'missing'})`);
    const strip = (await page.locator('#status-strip').innerText()).replace(/\s+/g, ' ');
    const visible = await page.locator('#status-strip .status-chief .status-value').innerText();
    ok(/^Snapshot 1[12] min ago$/.test(visible), `${size.tag} the always-visible HUD value marks cloud and gives the snapshot age (${visible})`);
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
    ok(await inSafeArea(page, '.cloud-modal', size), `${size.tag} Cloud Empire sits centred in the safe area with a reachable close button`);
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
    ok(await inSafeArea(page, '.cloud-confirm', size), `${size.tag} the job confirmation sits centred in the safe area`);
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
  // Founding in cloud mode (followups-1): GitHub-coordinator copy, the limits from the snapshot, the explicit paid
  // confirmation, and proper intents through the cloud adapter (one city action plus one paid job per manager).
  for (const size of sizes) {
    const { gh, provider, tick } = await seedUnfounded();
    const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch, deviceScaleFactor: size.touch ? 1.5 : 1 });
    await context.addInitScript({ content: 'window.__name = (f) => f;' });
    await context.addInitScript({ content: IOS_BRIDGE(TOKEN) });
    await context.addInitScript(() => localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture Founder', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } })));
    await routeGitHub(context, gh);
    const { page, errors } = await newPage(context);
    await (await context.newCDPSession(page)).send('Emulation.setSafeAreaInsetsOverride' as any, { insets: size.insets });
    await page.goto(base);
    await waitGame(page);
    await page.waitForSelector('#modal-root .founding-modal[data-mode="cloud"]', { timeout: 20_000 });
    const tag = `${size.tag} founding`;
    const text = async () => (await page.locator('.founding-modal').innerText()).replace(/\s+/g, ' ');
    let copy = await text();
    ok(/coordinator runs in your own GitHub/.test(copy) && /about every \d+ minutes/.test(copy) && /never live/.test(copy), `${tag}: explains the coordinator runs in the user's GitHub on its schedule`);
    ok(!/Rule-based server checks/.test(copy) && !/configured account/.test(copy), `${tag}: no server-mode wording`);
    ok(/1 paid cloud job/.test(copy) && /\$5\.00/.test(copy) && /\$20\.00 daily allowance/.test(copy) && /At most 3 run at once/.test(copy), `${tag}: the chief of staff's job with the per-job and daily allowance from the snapshot`);
    const submit = page.locator('.founding-modal footer .btn.primary');
    await page.locator('.founding-modal input[aria-label="Start with Harbour hospital"]').check();
    copy = await text();
    ok(/2 paid cloud jobs/.test(copy) && /up to \$10\.00/.test(copy), `${tag}: choosing a site adds its manager's paid job to the plan`);
    ok(await submit.isDisabled(), `${tag}: founding needs the explicit paid confirmation`);
    ok(await page.locator('#founding-confirm-paid').isVisible(), `${tag}: the confirmation sits beside the button`);
    await page.locator('#founding-confirm-paid').check();
    ok(await submit.isEnabled(), `${tag}: the tick enables founding`);
    await page.locator('.founding-modal input[aria-label="Start with Common Ground café"]').check();
    ok(!(await page.locator('#founding-confirm-paid').isChecked()) && (await submit.isDisabled()), `${tag}: a changed plan needs a new confirmation`);
    await page.locator('#founding-confirm-paid').check();
    copy = await text();
    ok(/I confirm 3 paid jobs with an allowance of \$5\.00 each \(up to \$15\.00\)/.test(copy), `${tag}: the confirmation names the job count, allowance and total`);
    ok(await noOverflow(page), `${tag}: no horizontal overflow`);
    ok(await inSafeArea(page, '.founding-modal', size), `${tag}: the dialog sits centred in the safe area`);
    const box = await page.locator('#founding-confirm-paid').evaluate((el) => el.closest('label')!.getBoundingClientRect().height);
    ok(!size.touch || box >= 43.5, `${tag}: the confirmation row is touch-sized (${box.toFixed(0)}px)`);
    await shot(page, `${size.tag}-09-founding-confirm`);
    const mark = gh.requests.length;
    const rev: number = await page.evaluate(() => (window as any).__office.net.info.snapshot.state.meta.configRevision);
    await submit.click();
    await page.waitForSelector('.founding-modal', { state: 'detached', timeout: 15_000 });
    const writes = gh.requests.slice(mark).filter((r) => r.method !== 'GET');
    const intentFiles = Object.entries(gh.files(FULL)).filter(([p]) => p.startsWith('intents/')).map(([, t]) => JSON.parse(t));
    const found = intentFiles.filter((i) => i.kind === 'empire_action');
    const jobs = intentFiles.filter((i) => i.kind === 'new_job');
    ok(writes.filter((r) => r.path.includes('/contents/intents/')).length === 4 && writes.filter((r) => r.path.endsWith('/dispatches')).length === 4, `${tag}: four intents and four wake-ups, nothing else (${writes.map((r) => `${r.method} ${r.path.replace(/^\/repos\/founder\/agent-empire-state/, '')}`).join(', ')})`);
    ok(found.length === 1 && found[0].action.kind === 'found' && JSON.stringify([...found[0].action.sites].sort()) === '["cafe","hospital"]', `${tag}: the founding plan is a city-action intent`);
    ok(jobs.length === 3 && jobs.every((j) => j.job.confirmPaid === true && j.job.configRevision === rev && /startup brief$/.test(j.job.title) && /^[0-9a-f]{8}-[0-9a-f]{4}-8/.test(j.job.id)) && JSON.stringify(jobs.map((j) => j.job.site).sort()) === '["cafe","hospital","hq"]',
      `${tag}: one paid new_job per manager (hq, hospital, café) with confirmPaid, configRevision and a stable id`);
    ok(provider.sessions.size === 0, `${tag}: the app starts no provider session`);
    // The real coordinator applies the plan on its next run.
    await tick(Date.now());
    await page.evaluate(() => (window as any).__office.net.pollNow());
    await page.waitForFunction(() => (window as any).__office.store.empire.setup.completed === true, null, { timeout: 10_000 });
    const managers = await page.evaluate(() => (window as any).__office.store.empire.sectors.filter((s: any) => s.manager).map((s: any) => `${s.id}:${s.manager.status}`).sort().join(','));
    ok(/cafe:(queued|working)/.test(managers) && /hospital:(queued|working)/.test(managers) && /hq:(queued|working)/.test(managers), `${tag}: the coordinator founded the city and linked each manager to its job (${managers})`);
    const unexpected = errors.filter((e) => !/Failed to fetch/i.test(e));
    ok(unexpected.length === 0, `${tag}: no console errors (${unexpected.join(' | ') || 'none'})`);
    await context.close();
  }
  // Server mode keeps its founding copy (the fixture's empire is shown unfounded through a WebSocket route).
  {
    const context = await browser.newContext({ viewport: { width: 874, height: 402 }, hasTouch: true, isMobile: true });
    await context.addInitScript({ content: 'window.__name = (f) => f;' });
    await context.addInitScript(() => localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture Founder', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } })));
    const { page } = await newPage(context);
    await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        const msg = JSON.parse(String(m));
        if (msg.t === 'empire') msg.state.setup = { completed: false, selected: [] };
        ws.send(JSON.stringify(msg));
      });
    });
    await page.goto(base);
    await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
    await page.waitForSelector('#modal-root .founding-modal', { timeout: 20_000 });
    const copy = (await page.locator('.founding-modal').innerText()).replace(/\s+/g, ' ');
    ok(/Rule-based server checks report on every sector/.test(copy) && /Queues real AI work using your configured account\./.test(copy) && /Appointing managers queues \d+ startup briefs\. They respect the existing queue’s concurrency and spending limits\./.test(copy) && /real agent work uses your configured AI account and its usage budget/.test(copy), 'server founding: copy unchanged');
    ok(!(await page.locator('#founding-confirm-paid').isVisible()) && !/GitHub/.test(copy) && (await page.locator('.founding-modal[data-mode]').count()) === 0, 'server founding: no cloud wording or paid tick');
    await shot(page, 'server-874x402-11-founding-unchanged');
    await context.close();
  }
  // Execution setup (claude/cloud-exec-setup): a fresh Empire whose coordinator has not set up the Anthropic agent and
  // environment yet. The app shows the real state, refuses to send a paid job, then accepts one once execution is ready;
  // an Empire without execution asks its coordinator from Limits.
  for (const size of [sizes[1], sizes[2]]) {
    const tag = `${size.tag} execution`;
    const { gh, provider, tick } = await seedProvisioning();
    const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch, deviceScaleFactor: size.touch ? 1.5 : 1 });
    await context.addInitScript({ content: 'window.__name = (f) => f;' });
    await context.addInitScript({ content: IOS_BRIDGE(TOKEN) });
    await context.addInitScript(() => localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture Founder', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } })));
    await routeGitHub(context, gh);
    const anthropic: string[] = [];
    const { page, errors } = await newPage(context);
    page.on('request', (r) => { if (/anthropic\.com$/.test(new URL(r.url()).hostname)) anthropic.push(r.url()); });
    await (await context.newCDPSession(page)).send('Emulation.setSafeAreaInsetsOverride' as any, { insets: size.insets });
    await page.goto(base);
    await waitGame(page);
    await page.waitForSelector('#modal-root .founding-modal[data-mode="cloud"]', { timeout: 20_000 });
    const founding = (await page.locator('.founding-modal').innerText()).replace(/\s+/g, ' ');
    ok(/still being set up by your coordinator/.test(founding) && /queues no paid jobs/.test(founding), `${tag}: founding says execution is being set up and queues no paid jobs`);
    await closeModals(page);
    await page.evaluate(() => (document.querySelector('#status-strip .status-chief') as HTMLButtonElement).click());
    await page.waitForSelector('.cloud-modal');
    const status = (await page.locator('.cloud-modal').innerText()).replace(/\s+/g, ' ');
    ok(/Being set up/.test(status) && /not a billed item and starts no session/.test(status) && /refused, not charged/.test(status) && !/will wait|Jobs wait/.test(status), `${tag}: status shows execution being set up, honestly`);
    await shot(page, `${size.tag}-12-execution-setting-up`);
    await page.locator('.cloud-modal .empire-tab', { hasText: 'New job' }).click();
    await page.fill('.cloud-modal textarea', 'Fixture only; nothing runs.');
    await page.locator('.cloud-modal button', { hasText: 'Review cost' }).click();
    await page.waitForSelector('.cloud-confirm');
    const confirm = (await page.locator('.cloud-confirm').innerText()).replace(/\s+/g, ' ');
    ok(/Can’t start yet/.test(confirm) && !/will wait/.test(confirm) && (await page.locator('#cloud-confirm-paid').isDisabled()) && (await page.locator('.cloud-confirm button', { hasText: 'Start paid job' }).isDisabled()), `${tag}: the paid-job dialog shows the real state and cannot send`);
    ok(await inSafeArea(page, '.cloud-confirm', size), `${tag}: the dialog sits in the safe area`);
    await shot(page, `${size.tag}-13-job-blocked`);
    await page.locator('.cloud-confirm button', { hasText: 'Never mind' }).click();
    ok(!gh.requests.some((r) => r.method === 'PUT' && r.path.includes('/contents/intents/')), `${tag}: nothing was sent`);
    // The coordinator's first run sets up execution (fake provider); the app reads it back.
    await tick(Date.now());
    ok(provider.calls.join() === 'provision', `${tag}: the coordinator made one setup call and no dispatch (${provider.calls.join()})`);
    await page.locator('.cloud-modal .empire-tab', { hasText: 'Status' }).click();
    await page.locator('.cloud-modal button', { hasText: 'Check GitHub now' }).click();
    await page.waitForFunction(() => /agent_fixture1|agent_provisioned1/.test(document.querySelector('.cloud-modal')?.textContent ?? ''), null, { timeout: 15_000 });
    ok(/Anthropic Managed Agents \(agent agent_provisioned1, environment env_provisioned1\)/.test(await page.locator('.cloud-modal').innerText()), `${tag}: status shows execution ready with the recorded IDs`);
    const readyText = await page.locator('.cloud-modal').innerText();
    ok(/Set up automatically: Claude Sonnet 5, unrestricted networking/.test(readyText) && /full internet access/.test(readyText) && /untrusted content/.test(readyText), `${tag}: status names the model and the sandbox's internet access`);
    await shot(page, `${size.tag}-14-execution-ready`);
    await page.locator('.cloud-modal .empire-tab', { hasText: 'New job' }).click();
    await page.fill('.cloud-modal textarea', 'Fixture only; nothing runs.');
    await page.locator('.cloud-modal button', { hasText: 'Review cost' }).click();
    await page.waitForSelector('.cloud-confirm');
    ok(/fixture\/repo, on a new branch/.test(await page.locator('.cloud-confirm').innerText()) && (await page.locator('#cloud-confirm-paid').isEnabled()), `${tag}: once ready, the dialog names the project and allows the explicit tick`);
    await page.locator('.cloud-confirm button', { hasText: 'Never mind' }).click();
    ok(anthropic.length === 0, `${tag}: the app never called Anthropic (${anthropic.length})`);
    const unexpected = errors.filter((e) => !/internetdisconnected|ERR_INTERNET_DISCONNECTED|Failed to fetch/i.test(e));
    ok(unexpected.length === 0, `${tag}: no console errors (${unexpected.join(' | ') || 'none'})`);
    await context.close();
  }
  {
    // No execution at all (e.g. set up OpenAI-only, then an Anthropic key added): Limits → Set up automatically.
    const { gh } = await seedProvisioning({ provision: false });
    const size = sizes[2];
    const context = await browser.newContext({ viewport: { width: size.w, height: size.h } });
    await context.addInitScript({ content: 'window.__name = (f) => f;' });
    await context.addInitScript({ content: IOS_BRIDGE(TOKEN) });
    await context.addInitScript(() => localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture Founder', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } })));
    await routeGitHub(context, gh);
    const { page, errors } = await newPage(context);
    await page.goto(base);
    await waitGame(page);
    await closeModals(page);
    await page.evaluate(() => (document.querySelector('#status-strip .status-chief') as HTMLButtonElement).click());
    await page.waitForSelector('.cloud-modal');
    ok(/Not set up/.test(await page.locator('.cloud-modal').innerText()) && /Anthropic, or OpenAI once it is verified/.test(await page.locator('.cloud-modal').innerText()), 'no execution: status says jobs are refused and why');
    await page.locator('.cloud-modal .empire-tab', { hasText: 'Limits' }).click();
    await page.fill('.cloud-modal input[aria-label="Project owner for automatic setup"]', 'fixture');
    await page.fill('.cloud-modal input[aria-label="Project repository for automatic setup"]', 'repo');
    ok((await page.locator('.cloud-modal select[aria-label="Worker model"]').inputValue()) === 'claude-sonnet-5' && (await page.locator('.cloud-modal select[aria-label="Worker model"] option').count()) === 3, 'no execution: the worker model defaults to Sonnet 5, with Opus and Fable selectable');
    ok(/full internet access/.test(await page.locator('.cloud-modal').innerText()), 'no execution: Limits states the sandbox has full internet access');
    // CLOUD-06: choosing OpenAI swaps in the OpenAI models (unverified until first run) and the vault/gate disclosure.
    ok((await page.locator('.cloud-modal select[aria-label="Execution provider"]').inputValue()) === 'anthropic', 'no execution: the provider defaults to Anthropic');
    await page.locator('.cloud-modal select[aria-label="Execution provider"]').selectOption('openai');
    const openaiModels = await page.locator('.cloud-modal select[aria-label="Worker model"] option').allInnerTexts();
    const openaiText = await page.locator('.cloud-modal').innerText();
    ok((await page.locator('.cloud-modal select[aria-label="Worker model"]').inputValue()) === 'gpt-6.1-sol' && openaiModels.length === 3 && openaiModels.every((t) => /unverified until first run/.test(t)), 'OpenAI: GPT-6.1 Sol by default; every OpenAI model marked unverified until first run');
    ok(/refuses OpenAI jobs until the integration's first verified real run/.test(openaiText) && /OpenAI vault/.test(openaiText) && /about \$2\.90/.test(openaiText), 'OpenAI: Limits explains the verification gate, the vault copy and the estimate example');
    mkdirSync(resolve('docs/team/reports/cloud-06'), { recursive: true });
    await page.locator('.cloud-modal').screenshot({ path: resolve('docs/team/reports/cloud-06/desktop-1440x900-limits-openai.jpg'), type: 'jpeg', quality: 82 });
    await page.locator('.cloud-modal select[aria-label="Execution provider"]').selectOption('anthropic');
    await page.locator('.cloud-modal select[aria-label="Worker model"]').selectOption('claude-opus-5-5');
    await shot(page, 'desktop-1440x900-15-limits-set-up-automatically');
    const mark = gh.requests.length;
    await page.locator('.cloud-modal button', { hasText: 'Set up automatically' }).click();
    await page.waitForFunction(() => document.querySelector('#toasts')?.textContent?.includes('Set up execution'), null, { timeout: 10_000 });
    const writes = gh.requests.slice(mark).filter((r) => r.method !== 'GET');
    const file = Object.entries(gh.files(FULL)).find(([p, t]) => p.startsWith('intents/') && t.includes('"provision"'));
    const body = file ? JSON.parse(file[1]) : null;
    ok(writes.length === 2 && !!body && body.repository.owner === 'fixture' && body.repository.name === 'repo' && body.repository.baseBranch === 'main' && body.model === 'claude-opus-5-5' && Number.isInteger(body.configRevision), `no execution: Set up automatically writes one provision intent and one wake-up (${writes.map((r) => `${r.method} ${r.path.replace(/^\/repos\/founder\/agent-empire-state/, '')}`).join(', ')})`);
    ok(errors.length === 0, `no execution: no console errors (${errors.join(' | ') || 'none'})`);
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
