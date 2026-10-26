/**
 * FREE-11/12 UI check: the chief's planning brain and email outreach in cloud mode, against the isolated UI fixture
 * (never 4610) and an in-memory api.github.com seeded by the real installer and real coordinator ticks with a fake
 * provider, a fake model caller and an injected GitHub clock (no network, no model call, no dispatch, no email).
 *
 *   npm run build:client && FIXTURE_PORT=5201 npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://127.0.0.1:5201/ npx tsx tools/cloud-brain-outreach-ui-check.ts   (writes docs/team/reports/free-11-12/*.jpg)
 */
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { GitHubClient, GitHubStateStore } from '../src/cloud/store';
import { runCoordinatorTick, type BrainCaller } from '../src/cloud/tick';
import { CloudRepo } from '../src/client/cloud/repo';
import { approvalFingerprint } from '../src/shared/approvals';
import { seed, FULL, TOKEN } from './cloud-seed';

const base = process.env.FIXTURE_URL || 'http://127.0.0.1:5201/';
if (/:4610\b/.test(base)) throw new Error('never 4610');
const port = Number(new URL(base).port);
if (!(port >= 5200 && port <= 5220)) throw new Error('FREE-11/12 checks use their own ports 5200–5220');
const out = resolve(process.env.OUT || 'docs/team/reports/free-11-12');
mkdirSync(out, { recursive: true });
const failures: string[] = [];
const ok = (cond: unknown, name: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures.push(name); };

const plan = (title: string) => JSON.stringify({ summary: `A small, testable ${title.toLowerCase()}.`, items: [
  { title: 'Build the request form', prompt: 'Build an accessible appointment request form that emails the practice. Label every field.', phase: 'build', role: 'frontend_engineer', parallel: false, dependsOn: [] },
  { title: 'Test the form', prompt: 'Write tests for the form: required fields, the email sent, and keyboard use.', phase: 'testing', role: 'qa_tester', parallel: false, dependsOn: [1] },
], lessons: ['L1'] });

/** The seeded cloud Empire plus FREE-11/12 state: a premium brain, two plans (one approved), outreach with a campaign. */
async function seedBrainOutreach() {
  const s = await seed();
  const now = Date.now();
  const store = new GitHubStateStore(new GitHubClient('ghs_actions', { fetch: s.gh.fetch }), { owner: 'founder', repo: 'agent-empire-state', branch: 'main', workflowFile: 'agent-empire.yml' });
  const answers = [{ text: plan('Reminder emails'), usage: { input: 850, output: 380 } }, { text: plan('Booking form'), usage: { input: 900, output: 400 } }];
  const brain: BrainCaller = async (call) => ({ ...answers.shift()!, model: call.model });
  let run = 0;
  const tick = (at: number) => runCoordinatorTick({ store, provider: s.provider, now: () => at, runId: `ui-${++run}`, allowSelfDisable: true, retry: { sleep: async () => {} }, brain, githubTime: async () => at });
  const client = new CloudRepo({ owner: 'founder', name: 'agent-empire-state' }, TOKEN, s.gh.fetch);
  const snap = async () => { await client.poll(); return client.snapshot!.state; };
  // The secrets the user set themselves (names only matter here): the brain's key and the SMTP URL.
  const repo = s.gh.repos.get(FULL)!;
  repo.secrets.set('AGENT_EMPIRE_SMTP_URL', { key_id: 'key-1', encrypted_value: 'sealed' });
  // Re-review note: the seed's clock keeps these ticks inside the seed's UTC day.
  const at = s.clock.after;
  await client.submit({ kind: 'lesson_propose', lesson: { text: 'Every form labels each field for screen readers.', scope: 'company' } }, 'agent-empire-intent', at(0));
  await tick(at(10_000));
  const lesson = (await snap()).org.approvals.find((a) => a.kind === 'lesson')!;
  await client.submit({ kind: 'approval_decision', approvalId: lesson.id, decision: 'approve', seen: approvalFingerprint(lesson) }, 'agent-empire-intent', at(20_000));
  await client.submit({ kind: 'brain_settings', settings: { mode: 'premium', provider: 'anthropic', model: 'claude-fixture', price: [3, 15], dailyCapCents: 200, monthlyCapCents: 2000 }, confirmPaid: true } as never, 'agent-empire-intent', at(21_000));
  await client.submit({ kind: 'brain_request', request: { kind: 'plan', title: 'Reminder emails', client: 'Harbour Dental', brief: 'Patients forget appointments. Send a reminder email the day before, form a booking request form.' } } as never, 'agent-empire-intent', at(22_000));
  await client.submit({ kind: 'brain_request', request: { kind: 'plan', title: 'Booking form', client: 'Harbour Dental', brief: 'An accessible form for patients to request an appointment; the practice gets an email.' } } as never, 'agent-empire-intent', at(23_000));
  await client.submit({ kind: 'outreach_settings', settings: { from: 'hello@harbour.example', fromName: 'Harbour Studio', address: 'Harbour Studio Ltd, 1 Quay Street, Bristol BS1 4XX, UK', dailyCap: 50, perRunCap: 20 }, acknowledgePrivacy: true } as never, 'agent-empire-intent', at(24_000));
  await client.submit({ kind: 'outreach_leads', leads: [
    { email: 'ann@clinic-a.example', name: 'Ann Patel', company: 'Clinic A', tags: ['dentists'] },
    { email: 'bob@clinic-b.example', name: 'Bob Ng', company: 'Clinic B', tags: ['dentists'] },
    { email: 'cat@clinic-c.example', name: 'Cat Ruiz', company: 'Clinic C', tags: ['dentists'] },
  ] } as never, 'agent-empire-intent', at(25_000));
  await client.submit({ kind: 'outreach_campaign', campaign: { title: 'Spring check-up reminders', subject: 'Fewer missed appointments at {{company}}', body: 'Hi {{name}},\n\nWe build appointment reminders for dental practices like {{company}}. Would a 15-minute call next week help?\n\nThanks,\nJo', audience: ['dentists'] } } as never, 'agent-empire-intent', at(26_000));
  await tick(at(60_000));
  await tick(at(120_000));
  let state = await snap();
  const approve = state.org.approvals.find((a) => a.kind === 'job_plan' && a.plan?.title === 'Reminder emails');
  if (approve) await client.submit({ kind: 'approval_decision', approvalId: approve.id, decision: 'approve', seen: approvalFingerprint(approve) }, 'agent-empire-intent', at(180_000));
  await tick(at(200_000));
  state = await snap();
  console.log(`      seed: inbox ${state.org.approvals.map((a) => `${a.id}:${a.kind}:${a.status}`).join(' ')}; brain ${state.brain.requests.map((r) => `${r.kind}:${r.status}${r.reason ? `(${r.reason})` : ''}`).join(' ')}; campaigns ${state.outreach.campaigns.map((c) => `${c.id}:${c.state}`).join(' ')}; rejected ${state.journal.entries.filter((e) => e.kind === 'intent_rejected').map((e) => e.message).join(' | ')}`);
  return s;
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
const newIntents = (gh: Awaited<ReturnType<typeof seed>>['gh'], before: Set<string>) =>
  Object.entries(gh.files(FULL)).filter(([p]) => p.startsWith('intents/') && !before.has(p)).map(([, c]) => JSON.parse(c));
const intentPaths = (gh: Awaited<ReturnType<typeof seed>>['gh']) => new Set(Object.keys(gh.files(FULL)).filter((p) => p.startsWith('intents/')));

async function run() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const sizes = [
    { tag: 'desktop-1440x900', w: 1440, h: 900, touch: false },
    { tag: 'phone-landscape-874x402', w: 874, h: 402, touch: true },
  ];
  for (const size of sizes) {
    const { gh, provider } = await seedBrainOutreach();
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
    const T = size.tag;

    // ---- Inbox: a model-backed plan with every prompt, and a campaign send with the exact recipients.
    await page.evaluate(() => (window as any).__office.orgUI.openInbox());
    await page.waitForSelector('.inbox-modal');
    const inboxText = (await page.locator('.inbox-modal').innerText()).replace(/\s+/g, ' ');
    ok(/Plan: Booking form/.test(inboxText) && /Send “Spring check-up reminders” to 3 recipients/.test(inboxText), `${T} the inbox lists the chief's plan and the campaign send`);
    await page.locator('.inbox-cloud-gaps summary').click();
    const gaps = await page.locator('.inbox-cloud-gaps li').allInnerTexts();
    ok(gaps.length === 2 && gaps.some((g) => /per-job allowance/.test(g)) && gaps.some((g) => /architect/.test(g)), `${T} only budget increases and architect summaries are listed as not raised (${gaps.length})`);
    await page.locator('.inbox-row', { hasText: 'Plan: Booking form' }).first().click();
    await page.waitForSelector('.cloud-plan');
    const planText = (await page.locator('.inbox-detail').innerText()).replace(/\s+/g, ' ');
    ok(/Model-backed · claude-fixture · proposals only/.test(planText), `${T} the plan is tagged Model-backed with its model`);
    ok(/Label every field/.test(planText) && /keyboard use/.test(planText), `${T} every prompt of the plan is shown`);
    ok(/Relies on lessons: L1/.test(planText), `${T} the plan cites the approved lesson it relies on`);
    ok(/Nothing is queued or spent/.test(planText) && !(await page.locator('#inbox-budget').count()), `${T} approving a cloud plan records the decision only (no budget input)`);
    ok(await noOverflow(page), `${T} no horizontal overflow (plan)`);
    await shot('01-inbox-plan');
    let before = intentPaths(gh);
    await page.locator('.inbox-detail .btn.primary', { hasText: 'Approve plan' }).click();
    ok(/Nothing is queued or spent/.test(await page.locator('.inbox-confirm').innerText()) && newIntents(gh, before).length === 0, `${T} the confirmation says nothing is spent; nothing written before it`);
    await page.locator('.inbox-confirm .btn.primary').click();
    await page.waitForSelector('.inbox-sent', { timeout: 10_000 });
    const decision = newIntents(gh, before).find((i) => i.kind === 'approval_decision');
    ok(!!decision && /^[a-f0-9]{16}$/.test(decision.seen), `${T} the decision is one approval_decision intent naming the plan as seen`);

    // ---- An approved plan: each item is submitted only through the paid confirmation.
    if (await page.locator('.inbox-back').isVisible()) await page.locator('.inbox-back').click();
    await page.locator('.inbox-history-box summary').click();
    await page.locator('.inbox-history .inbox-row', { hasText: 'Plan: Reminder emails' }).first().click();
    await page.waitForSelector('.cloud-plan button');
    ok(await page.locator('.cloud-plan button', { hasText: 'Submit item 1 as a cloud job' }).count() === 1, `${T} an approved plan offers to submit each item`);
    await shot('02-approved-plan');
    before = intentPaths(gh);
    await page.locator('.cloud-plan button', { hasText: 'Submit item 1 as a cloud job' }).click();
    await page.waitForSelector('.cloud-confirm');
    const confirm = (await page.locator('.cloud-confirm').innerText()).replace(/\s+/g, ' ');
    ok(/Allowance/.test(confirm) && /I confirm this paid job/.test(confirm) && newIntents(gh, before).length === 0, `${T} submitting an item opens the paid confirmation; nothing is sent before it`);
    await page.locator('.cloud-confirm .btn', { hasText: 'Never mind' }).click();
    await closeModals(page);

    // ---- The campaign send: exact message, every recipient, the cloud pace.
    await page.evaluate(() => (window as any).__office.orgUI.openInbox());
    await page.waitForSelector('.inbox-modal');
    await page.locator('.inbox-row', { hasText: 'Spring check-up reminders' }).first().click();
    await page.waitForSelector('.inbox-outreach');
    const send = (await page.locator('.inbox-detail').innerText()).replace(/\s+/g, ' ');
    ok(/Hi Ann Patel/.test(send) && /Harbour Studio Ltd, 1 Quay Street/.test(send) && /Reply STOP/.test(send), `${T} the exact message with the postal address and STOP line`);
    ok(/at most 20 per coordinator run/.test(send) && /send job that runs no model/.test(send), `${T} the pace is per coordinator run, from the send job`);
    await page.locator('.inbox-recipients summary').click();
    ok((await page.locator('.inbox-recipients li').count()) === 3, `${T} every recipient is listed`);
    await shot('03-campaign-send');
    await closeModals(page);

    // ---- The chief's card and brain panel.
    await page.evaluate(() => (window as any).__office.orgUI.openExecutiveCard('chief_of_staff'));
    await page.waitForSelector('.exec-modal .exec-card');
    const chief = (await page.locator('.exec-modal').innerText()).replace(/\s+/g, ' ');
    ok(/worst case/.test(chief) && /proposals only/.test(chief), `${T} the chief card says how the cloud brain spends and that it proposes only`);
    await page.locator('.exec-modal button[data-key="brain"]').click();
    await page.waitForSelector('.cloud-brain');
    await page.waitForTimeout(300);
    const brainText = (await page.locator('.cloud-brain').innerText()).replace(/\s+/g, ' ');
    ok(/Premium · claude-fixture/.test(brainText) && /\$2\.00\/day/.test(brainText) && /\$20\.00\/30 days/.test(brainText), `${T} the brain panel shows the premium model and both caps`);
    ok(/Charged \$0\.0\d+ today/.test(brainText), `${T} the spend so far is shown against the caps`);
    ok(/Ollama/.test(brainText) && /Claude subscription is never used/.test(brainText), `${T} the panel says there is no Ollama brain and never a Claude subscription`);
    ok(!(await page.locator('.cloud-brain input[type="password"]').count()) && !/paste your key/i.test(brainText), `${T} there is no field for a key`);
    await page.locator('.cloud-brain button', { hasText: 'Check secret name' }).click();
    await page.waitForFunction(() => /secret ANTHROPIC_API_KEY exists/.test(document.querySelector('.brain-secret')?.textContent ?? ''), null, { timeout: 10_000 });
    ok(true, `${T} the secret-name check finds ANTHROPIC_API_KEY by name only`);
    ok(await noOverflow(page), `${T} no horizontal overflow (brain)`);
    await shot('04-brain-panel');
    // A free tier needs the terms; nothing is sent without them.
    before = intentPaths(gh);
    await page.locator('#brain-mode').selectOption('free');
    await page.locator('#brain-model').fill('free-fixture');
    ok(/may use your prompts|log prompts/.test(await page.locator('.brain-terms').innerText()), `${T} a free tier shows its data-use terms`);
    await page.locator('.brain-settings button[type="submit"]').click();
    ok(/accept the provider’s data-use terms/.test(await page.locator('.brain-settings .memory-status').innerText()) && newIntents(gh, before).length === 0, `${T} a free tier is not turned on without accepting the terms`);
    await shot('05-brain-free-terms');
    // A plan request: one intent with exactly the brief.
    await page.locator('#brain-mode').selectOption('premium');
    await page.locator('#brain-title').fill('Waiting-room display');
    await page.locator('#brain-brief').fill('A screen in the waiting room that shows the next appointment number.');
    await page.locator('.brain-plan button[type="submit"]').click();
    await page.waitForFunction(() => /Sent/.test(document.querySelector('.brain-plan .memory-status')?.textContent ?? ''), null, { timeout: 10_000 });
    const req = newIntents(gh, before).find((i) => i.kind === 'brain_request');
    ok(!!req && req.request.kind === 'plan' && Object.keys(req.request).sort().join() === 'brief,kind,title', `${T} a plan request is one brain_request intent with the brief only`);
    await closeModals(page);

    // ---- Marketing card and outreach panel.
    await page.evaluate(() => (window as any).__office.orgUI.openExecutiveCard('marketing_sales'));
    await page.waitForSelector('.exec-modal .exec-card');
    await page.locator('.exec-modal button[data-key="outreach"]').click();
    await page.waitForSelector('.cloud-outreach');
    await page.waitForTimeout(300);
    const o = (await page.locator('.cloud-outreach').innerText()).replace(/\s+/g, ' ');
    ok(/git history keeps every version/.test(o) && /salted hashes/.test(o), `${T} the privacy warning names git history and hashed opt-outs`);
    ok(/Expected delivery: 3 messages go out on the next coordinator run/.test(o), `${T} the campaign shows an honest delivery estimate`);
    ok(/3 leads/.test(o) && /hello@harbour\.example/.test(o), `${T} sender and lead counts come from the snapshot`);
    ok(await noOverflow(page), `${T} no horizontal overflow (outreach)`);
    await shot('06-outreach-panel');
    before = intentPaths(gh);
    await page.locator('#out-optout').fill('bob@clinic-b.example');
    await page.locator('#out-optout').locator('xpath=ancestor::form').locator('button[type="submit"]').click();
    await page.waitForFunction(() => /hash/.test(document.getElementById('out-optout')?.closest('form')?.querySelector('.memory-status')?.textContent ?? ''), null, { timeout: 10_000 });
    const opt = newIntents(gh, before).find((i) => i.kind === 'outreach_suppress');
    ok(!!opt && /^[a-f0-9]{64}$/.test(opt.hash) && !JSON.stringify(opt).includes('@'), `${T} an opt-out is sent as its salted hash; the address never leaves the device`);
    before = intentPaths(gh);
    await page.locator('#out-c-title').fill('Bad');
    await page.locator('#out-c-subject').fill('=?utf-8?B?SGVsbG8=?= hello');
    await page.locator('#out-c-body').fill('Hello');
    await page.locator('#out-c-audience').fill('dentists');
    await page.locator('#out-c-title').locator('xpath=ancestor::form').locator('button[type="submit"]').click();
    ok(/encoded word/.test(await page.locator('#out-c-title').locator('xpath=ancestor::form').innerText()) && newIntents(gh, before).length === 0, `${T} an unsafe subject (an encoded word) is refused in the game with the shared rule; nothing is written (a one-line field cannot carry CR or LF)`);
    await page.locator('.out-delete .btn.danger').click();
    const del = (await page.locator('.out-delete').innerText()).replace(/\s+/g, ' ');
    ok(/Git history still contains old versions/.test(del) && /Delete all lead data now\?/.test(del), `${T} deleting lead data asks first and says git history keeps old versions`);
    await page.locator('.out-delete .inbox-confirm').scrollIntoViewIfNeeded();
    await shot('07-delete-lead-data');
    await page.locator('.out-delete .btn.danger', { hasText: 'Confirm delete' }).click();
    await page.waitForFunction(() => /Sent/.test(document.querySelector('.out-delete .memory-status')?.textContent ?? ''), null, { timeout: 10_000 });
    ok(newIntents(gh, before).some((i) => i.kind === 'outreach_delete_leads' && i.confirm === true), `${T} the delete is one outreach_delete_leads intent`);
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
