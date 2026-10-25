/**
 * FREE-07 UI check: organization features in cloud mode, against the isolated UI fixture (never 4610) and an in-memory
 * api.github.com seeded by the real installer and real coordinator ticks with a fake provider (no network, no paid call,
 * no dispatch from the page). Covers the cloud inbox (tool proposal, lesson, the kinds not raised with their reasons),
 * a decision sent as an intent that names the item as seen, executives with their gap notes, memory, and research with
 * the paid confirmation that sends nothing until confirmed.
 *
 *   npm run build:client && FIXTURE_PORT=5007 npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://127.0.0.1:5007/ npx tsx tools/cloud-org-ui-check.ts     (writes docs/team/reports/free-07/*.jpg)
 */
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { GitHubClient, GitHubStateStore } from '../src/cloud/store';
import { runCoordinatorTick } from '../src/cloud/tick';
import { CloudRepo } from '../src/client/cloud/repo';
import { uuidv7 } from '../src/client/cloud/uuid';
import { approvalFingerprint } from '../src/shared/approvals';
import { researchPath } from '../src/cloud/org';
import { seed, FULL, TOKEN } from './cloud-seed';

const base = process.env.FIXTURE_URL || 'http://127.0.0.1:5007/';
if (/:4610\b/.test(base)) throw new Error('never 4610');
const port = Number(new URL(base).port);
if (!(port >= 5000 && port <= 5015)) throw new Error('FREE-07 checks use their own ports 5000–5015');
const out = resolve(process.env.OUT || 'docs/team/reports/free-07');
mkdirSync(out, { recursive: true });
const failures: string[] = [];
const ok = (cond: unknown, name: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures.push(name); };

const REPORT = `---
question: Can we offer appointment booking for dental practices?
feasibility: partial
confidence: medium
---
## Findings
- Self-hosted booking widgets exist for small clinics (https://example.org/booking).
## What we can do now
A simple request form that emails the practice.
## What we can't do yet and why
Two-way calendar sync needs each practice's own system.
## Proposed tools
| Name | URL | Licence | Enables | Risk |
|---|---|---|---|---|
| Cal.com | https://cal.com | AGPL-3.0 | Self-hosted booking | AGPL obligations if modified |
`;

/** The seeded cloud Empire plus FREE-07 state: two lessons (one approved), one imported research report with a tool. */
async function seedOrg() {
  const s = await seed();
  const now = Date.now();
  const store = new GitHubStateStore(new GitHubClient('ghs_actions', { fetch: s.gh.fetch }), { owner: 'founder', repo: 'agent-empire-state', branch: 'main', workflowFile: 'agent-empire.yml' });
  let run = 0;
  const tick = (at: number) => runCoordinatorTick({ store, provider: s.provider, now: () => at, runId: `org-${++run}`, allowSelfDisable: true, retry: { sleep: async () => {} } });
  const client = new CloudRepo({ owner: 'founder', name: 'agent-empire-state' }, TOKEN, s.gh.fetch);
  const snap = async () => { await client.poll(); return client.snapshot!.state; };
  // The seeded jobs filled today's allowance; raise it (as the CEO would under Limits) so research can be dispatched.
  await client.submit({ kind: 'limits', limits: { maxConcurrent: 3, perTaskBudgetCents: 500, dailyBudgetCents: 10_000 }, configRevision: (await snap()).meta.configRevision }, 'agent-empire-intent', now - 11.5 * 60_000);
  await tick(now - 11.2 * 60_000);
  const rev = (await snap()).meta.configRevision;
  const researchId = uuidv7(now - 11 * 60_000);
  await client.submit({ kind: 'lesson_propose', lesson: { text: 'Every deploy plan names its rollback step.', scope: 'company' } }, 'agent-empire-intent', now - 11 * 60_000);
  await client.submit({ kind: 'lesson_propose', lesson: { text: 'Harbour Dental wants plain-language patient emails.', scope: 'client', scopeValue: 'Harbour Dental' } }, 'agent-empire-intent', now - 11 * 60_000 + 1);
  await client.submit({ kind: 'research', question: 'Can we offer appointment booking for dental practices?', job: { id: researchId, configRevision: rev, confirmPaid: true } }, 'agent-empire-intent', now - 11 * 60_000 + 2);
  // Free the concurrency slots (the seeded jobs finish their turns), so the research job is dispatched to the fake.
  for (const sess of s.provider.sessions.values()) if (sess.status === 'running') s.provider.finish(sess.jobId, 'end_turn', 50);
  await tick(now - 10 * 60_000);
  const first = (await snap()).org.approvals.find((a) => a.lesson?.lessonId === 'L1')!;
  await client.submit({ kind: 'approval_decision', approvalId: first.id, decision: 'approve', seen: approvalFingerprint(first) }, 'agent-empire-intent', now - 9 * 60_000);
  await tick(now - 8.5 * 60_000);
  s.provider.files.set(`${researchId}:${researchPath(researchId)}`, REPORT);
  if (s.provider.sessionFor(researchId)) s.provider.finish(researchId, 'end_turn', 60);
  await tick(now - 8 * 60_000);
  await tick(now - 7 * 60_000);
  const final = await snap();
  const rj = final.jobs.jobs.find((j) => j.id === researchId);
  console.log(`      seed: research job ${rj?.status ?? 'absent'}; report ${final.org.research[0]?.status ?? 'absent'} ${final.org.research[0]?.reason ?? ''}; inbox ${final.org.approvals.map((a) => `${a.id}:${a.kind}:${a.status}`).join(' ')}; rejected ${final.journal.entries.filter((e) => e.kind === 'intent_rejected').map((e) => e.message).join(' | ')}`);
  return { ...s, researchId };
}

async function routeGitHub(context: BrowserContext, gh: Awaited<ReturnType<typeof seed>>['gh']) {
  await context.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag, Link, X-RateLimit-Remaining' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': 'Authorization, Content-Type, If-None-Match, X-GitHub-Api-Version, Accept', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE' } });
    const res = await gh.handle(new URL(req.url()), { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined });
    const headers: Record<string, string> = { ...cors };
    res.headers.forEach((v, k) => (headers[k] = v));
    return route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
  });
}

const IOS_BRIDGE = (token: string) => `
  window.AGENT_EMPIRE_APP = Object.freeze({ platform: 'ios', deviceName: 'Fixture iPhone' });
  const store = { mode: 'cloud', 'state.repo': '${FULL}', 'github.token': '${token}', 'github.login': 'founder' };
  window.webkit = { messageHandlers: { empire: { postMessage(m) {
    const N = () => window.__empireNative;
    setTimeout(() => {
      switch (m.method) {
        case 'secure.get': return N().resolve(m.id, store[m.params.key] ?? null);
        case 'secure.set': store[m.params.key] = m.params.value; return N().resolve(m.id, true);
        case 'secure.delete': delete store[m.params.key]; return N().resolve(m.id, true);
        default: return N().resolve(m.id, true);
      }
    }, 10);
  } } } };
`;

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
async function closeModals(page: Page) {
  for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
}

async function run() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const sizes = [
    { tag: 'desktop-1440x900', w: 1440, h: 900, touch: false },
    { tag: 'phone-landscape-874x402', w: 874, h: 402, touch: true },
  ];
  for (const size of sizes) {
    const { gh, provider, researchId } = await seedOrg();
    const sessions = provider.sessions.size;
    const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch, deviceScaleFactor: size.touch ? 1.5 : 1, reducedMotion: size.touch ? 'reduce' : 'no-preference' });
    await context.addInitScript({ content: 'window.__name = (f) => f;' });
    await context.addInitScript({ content: IOS_BRIDGE(TOKEN) });
    await context.addInitScript(() => localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture Founder', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } })));
    await routeGitHub(context, gh);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
    const shot = (name: string) => page.screenshot({ path: resolve(out, `${size.tag}-${name}.jpg`), type: 'jpeg', quality: 80, animations: 'disabled' });
    await page.goto(base);
    await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
    await page.waitForFunction(() => ((window as any).__office?.store?.approvals?.pending ?? 0) > 0, null, { timeout: 30_000 });
    await page.waitForTimeout(600);
    const T = `${size.tag}`;

    // HUD inbox badge counts the coordinator's pending items.
    const badge = await page.locator('#btn-inbox').innerText();
    ok(!(await page.locator('#btn-inbox').evaluate((b) => b.classList.contains('hidden'))) && /2/.test(badge), `${T} the HUD inbox badge shows the cloud inbox count (${badge.replace(/\s+/g, ' ')})`);

    // Inbox: the cloud items and the kinds not raised, each with its reason.
    await page.evaluate(() => (window as any).__office.orgUI.openInbox());
    await page.waitForSelector('.inbox-modal');
    const inboxText = (await page.locator('.inbox-modal').innerText()).replace(/\s+/g, ' ');
    ok(/Tool proposal/.test(inboxText) && /Lesson/.test(inboxText), `${T} inbox lists the tool proposal and the waiting lesson`);
    ok(!/isn.t available in cloud mode yet/.test(inboxText), `${T} the old blanket "not available" note is gone`);
    await page.locator('.inbox-cloud-gaps summary').click();
    const gaps = await page.locator('.inbox-cloud-gaps li').allInnerTexts();
    ok(gaps.length === 4, `${T} four inbox kinds are listed as not raised in cloud mode (${gaps.length})`);
    ok(gaps.some((g) => /per-job allowance/.test(g)) && gaps.some((g) => /SMTP/.test(g)) && gaps.some((g) => /paid confirmation/.test(g)) && gaps.some((g) => /model/.test(g)), `${T} each missing kind names its specific reason`);
    ok(await noOverflow(page), `${T} no horizontal overflow (inbox)`);
    await shot('01-cloud-inbox');

    // Decide the tool proposal: confirm first, then one intent naming the item as seen; nothing paid.
    await page.locator('.inbox-row', { hasText: 'Cal.com' }).first().click();
    const writes = gh.writes.length;
    await page.locator('.inbox-detail .btn.primary', { hasText: 'Approve proposal' }).click();
    ok(gh.writes.length === writes, `${T} nothing is written before the confirmation`);
    await page.locator('.inbox-confirm .btn.primary').click();
    await page.waitForSelector('.inbox-sent', { timeout: 10_000 });
    const files = gh.files(FULL);
    const intents = Object.entries(files).filter(([p]) => p.startsWith('intents/')).map(([, c]) => JSON.parse(c));
    const decision = intents.find((i) => i.kind === 'approval_decision');
    ok(!!decision && decision.decision === 'approve' && /^[a-f0-9]{16}$/.test(decision.seen) && Object.keys(decision).sort().join() === 'approvalId,createdAt,decision,id,kind,schemaVersion,seen', `${T} the decision is one approval_decision intent with the seen fingerprint and nothing else`);
    ok(/sent to your coordinator/.test(await page.locator('.inbox-detail').innerText()), `${T} the item says the decision is waiting for the coordinator`);
    ok(await page.locator('.inbox-detail .inbox-actions .btn.primary').count() === 0, `${T} no second decision while one is in flight`);
    await shot('02-decision-sent');
    await closeModals(page);

    // Executives: rule-based cards from the snapshot with their specific cloud gaps.
    await page.evaluate(() => (window as any).__office.orgUI.openExecutiveCard('chief_of_staff'));
    await page.waitForSelector('.exec-modal .exec-card');
    const chief = (await page.locator('.exec-modal').innerText()).replace(/\s+/g, ' ');
    ok(/Rule-based/.test(chief) && /queued/.test(chief) && /awaiting your review/.test(chief), `${T} chief card: rule-based, summarised from cloud jobs`);
    ok(/Ollama/.test(chief) && /Actions secret/.test(chief), `${T} chief card names why there is no planning brain in cloud mode`);
    ok(!/not available in cloud mode yet/.test(chief), `${T} no blanket "not available" executive note`);
    ok(await noOverflow(page), `${T} no horizontal overflow (chief card)`);
    await shot('03-chief-card');
    await page.locator('.exec-modal button[data-key="memory"]').click();
    await page.waitForSelector('.cloud-memory');
    const mem = (await page.locator('.cloud-memory').innerText()).replace(/\s+/g, ' ');
    ok(/L1/.test(mem) && /Approved · in use/.test(mem) && /L2/.test(mem) && /Waiting for your approval/.test(mem), `${T} memory lists the approved and the waiting lesson`);
    ok(/No plan cites a lesson in cloud mode/.test(mem), `${T} memory says why lessons are not used for planning in cloud mode`);
    const w2 = gh.writes.length;
    await page.locator('#cloud-lesson-text').fill('Hidden​instruction');
    await page.locator('.cloud-memory button[type="submit"]').click();
    ok(/invisible or control characters/.test(await page.locator('.memory-status').innerText()) && gh.writes.length === w2, `${T} an invalid lesson is refused in the game with the shared rule; nothing is written`);
    await shot('04-memory');
    await closeModals(page);

    await page.evaluate(() => (window as any).__office.orgUI.openExecutiveCard('marketing_sales'));
    await page.waitForSelector('.exec-modal .exec-card');
    const mkt = (await page.locator('.exec-modal').innerText()).replace(/\s+/g, ' ');
    ok(/SMTP/.test(mkt) && /personal data/.test(mkt) && !(await page.locator('.exec-modal a[href*="consultancy.html"]').count()), `${T} marketing card explains why outreach can't run in cloud mode and links nowhere broken`);
    await shot('05-marketing-card');
    await closeModals(page);

    // Research: the imported report, and a new question needs the paid confirmation before anything is sent.
    await page.evaluate(() => (window as any).__office.orgUI.openExecutiveCard('research'));
    await page.waitForSelector('.research-panel');
    await page.waitForTimeout(300);
    const res = (await page.locator('.research-panel').innerText()).replace(/\s+/g, ' ');
    ok(/appointment booking/.test(res) && /Report in|Partly feasible/.test(res), `${T} research lists the report the coordinator imported`);
    await page.locator(`.research-row[data-report="${researchId}"]`).click();
    await page.waitForSelector('.research-report-title');
    await page.waitForTimeout(300);
    ok(/Booking widgets|booking widgets/i.test(await page.locator('.research-report-view').innerText()), `${T} the report opens from the snapshot`);
    await shot('06-research-report');
    await page.locator('.research-back').click();
    const w3 = gh.writes.length;
    await page.locator('#research-question').fill('Which open-source tools handle patient reminders?');
    await page.locator('.research-ask button[type="submit"]').click();
    await page.waitForSelector('.cloud-confirm');
    const confirm = (await page.locator('.cloud-confirm').innerText()).replace(/\s+/g, ' ');
    ok(/Allowance/.test(confirm) && /I confirm this paid job/.test(confirm), `${T} a cloud research question opens the paid confirmation`);
    ok(gh.writes.length === w3, `${T} nothing is sent before the paid confirmation`);
    await shot('07-research-confirm');
    await page.locator('.cloud-confirm .btn', { hasText: 'Never mind' }).click();
    ok(gh.writes.length === w3, `${T} declining the confirmation sends nothing`);
    await closeModals(page);

    ok(provider.sessions.size === sessions, `${T} the page started no provider session`);
    ok(errors.length === 0, `${T} no console errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
    await context.close();
  }
  await browser.close();
  console.log(`\n${failures.length ? `${failures.length} FAILED` : 'ALL PASS'}`);
  process.exit(failures.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
