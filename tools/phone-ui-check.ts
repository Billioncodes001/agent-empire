/**
 * FREE-05 acceptance against the isolated UI fixture only (never the protected 4610 session):
 *   npm run build:client && FIXTURE_PORT=4871 FIXTURE_WORKERS=3 FIXTURE_ENGINES=free FIXTURE_VOICE=1 npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://localhost:4871/ npx tsx tools/phone-ui-check.ts
 * Checks Settings → Voice (models with size/licence/source, confirmed download with progress and cancel), the phone
 * contacts (executives labelled rule-based, workers with real status), the chief call with subtitles, push-to-talk
 * (Chrome's fake microphone → fake STT → transcript confirmed and sent once), the text fallback creating a pending
 * plan, keyboard/Escape behaviour, and the 874x402 phone layout with reduced motion and Save-Data. No real model,
 * microphone or download is used. Screenshots go to docs/team/reports/free-05/; exits non-zero on any failed check.
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:4871/';
if (/:4610\b/.test(base)) throw new Error('Refusing the protected 4610 session; use the UI fixture.');
const out = resolve(import.meta.dirname, '../docs/team/reports/free-05');
mkdirSync(out, { recursive: true });

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const shot = (p: Page, name: string) => p.screenshot({ path: resolve(out, name), quality: 82 });

async function open(browser: Browser, o: { width: number; height: number; touch: boolean; reduced?: boolean; saveData?: boolean }) {
  const context = await browser.newContext({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: 1, isMobile: o.touch, hasTouch: o.touch, reducedMotion: o.reduced ? 'reduce' : 'no-preference', permissions: ['microphone'] });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }));
    localStorage.setItem('agent-empire.execution.offered', '1');
  });
  if (o.saveData) await context.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true } }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*(404|409)/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(base);
  await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
  await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10_000 });
  for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  return { context, page, errors };
}

async function openVoiceSettings(p: Page) {
  await p.evaluate(() => (document.getElementById('btn-settings') as HTMLButtonElement | null)?.click());
  await p.waitForSelector('.voice-settings .voice-model', { timeout: 15_000 });
  await p.evaluate(() => document.querySelector('.voice-settings')?.scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(400);
}
const openPhone = async (p: Page) => { await p.evaluate(() => (document.getElementById('btn-phone') as HTMLButtonElement | null)?.click()); await p.waitForSelector('.phone-modal .phone-contact', { timeout: 10_000 }); await p.waitForTimeout(500); };

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    // ---- Desktop 1440x900 ----
    const d = await open(browser, { width: 1440, height: 900, touch: false });
    const p = d.page;
    await p.waitForTimeout(3000);
    await openVoiceSettings(p);
    const setup = (await p.locator('.voice-settings').textContent()) ?? '';
    check('voice setup shows the sherpa-onnx runtime and that no cloud service is used', /Speech runtime · sherpa-onnx \(Apache-2\.0\)/.test(setup) && /No cloud speech service/.test(setup), '');
    check('STT choices: Moonshine Tiny/Base and Whisper Small with size and licence', /Moonshine Tiny \(English\)/.test(setup) && /Moonshine Base/.test(setup) && /Whisper Small/.test(setup) && /30 MB · MIT · sha256 verified/.test(setup) && /636 MB · MIT · size verified \(no published checksum\)/.test(setup));
    check('TTS choice: Kokoro with Apache-2.0 licence', /Kokoro \(English, int8\)/.test(setup) && /103 MB · Apache-2\.0/.test(setup));
    check('installed models are marked and selected', (await p.locator('.voice-model[data-installed=true]').count()) === 2 && (await p.locator('.voice-model button[aria-checked=true]').count()) === 2);
    check('each model links its source and licence', (await p.locator('.voice-settings .voice-note a').count()) >= 10);
    check('keep-recordings is off by default', !(await p.locator('#voice-keep').isChecked()));
    await shot(p, '01-voice-setup-1440x900.jpg');
    await p.locator('.voice-model[data-model=whisper-small-en] button').click();
    const dialog = p.locator('[role=alertdialog]');
    await dialog.waitFor({ timeout: 5000 });
    const ask = (await dialog.textContent()) ?? '';
    check('download asks first with name, size, licence and the checksum policy', /Whisper Small/.test(ask) && /636 MB/.test(ask) && /MIT/.test(ask) && /exact size is checked/.test(ask), ask.slice(0, 160));
    await shot(p, '02-voice-download-confirm-1440x900.jpg');
    await dialog.locator('button.danger').click();
    // Security review: a size-only model asks a second, explicit question.
    await p.waitForFunction(() => /No published checksum/.test(document.querySelector('[role=alertdialog]')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
    const warn = (await p.locator('[role=alertdialog]').textContent().catch(() => '')) ?? '';
    check('a size-only model needs a second confirmation that names the risk', /No published checksum — size check only/.test(warn) && /sha256 is recorded/.test(warn), warn.slice(0, 120));
    await shot(p, '02b-voice-size-only-warning-1440x900.jpg');
    await p.locator('[role=alertdialog] button.danger').click();
    await p.waitForSelector('.voice-progress progress', { timeout: 8000 });
    await p.waitForTimeout(1500);
    const prog = (await p.locator('.voice-progress').textContent()) ?? '';
    check('download progress with a cancel button', /whisper-small-en: downloading/.test(prog) && (await p.locator('.voice-progress button:has-text("Cancel download")').count()) === 1, prog);
    await p.locator('.voice-progress').scrollIntoViewIfNeeded();
    await shot(p, '03-voice-download-progress-1440x900.jpg');
    await p.locator('.voice-progress button').click();
    await p.waitForFunction(() => /cancelled/.test(document.querySelector('.voice-progress')?.textContent ?? ''), null, { timeout: 8000 }).then(() => check('download can be cancelled; nothing installed', true), () => check('download can be cancelled; nothing installed', false));
    check('whisper is still not installed', (await p.locator('.voice-model[data-model=whisper-small-en]').getAttribute('data-installed')) === 'false');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);

    // Phone contacts.
    await openPhone(p);
    const names = await p.locator('.phone-contact').evaluateAll((els) => els.map((e) => ({ kind: (e as HTMLElement).dataset.kind, text: e.textContent ?? '' })));
    check('the chief is the first contact, labelled rule-based', names[0]?.kind === 'chief' && /Chief of staff · Rule-based/.test(names[0].text), JSON.stringify(names[0]));
    check('executives listed with rule-based labels', names.filter((n) => n.kind !== 'worker').every((n) => /Rule-based/.test(n.text)) && names.filter((n) => n.kind !== 'worker').length >= 5);
    const workers = names.filter((n) => n.kind === 'worker');
    check('workers listed with their real status', workers.length >= 3 && workers.every((n) => /Worker · live status/.test(n.text) && /(Working|Idle|Needs your input|Starting|Turn ended|Stopped|Offline|Status unknown)/.test(n.text)), workers.map((w) => w.text).join(' | '));
    check('focus starts on the first contact (keyboard)', await p.evaluate(() => document.activeElement?.classList.contains('phone-contact') ?? false));
    await shot(p, '04-phone-contacts-1440x900.jpg');

    // Worker entry: status only, no speech, no push-to-talk.
    await p.locator('.phone-contact[data-kind=worker]').first().click();
    await p.waitForSelector('.phone-worker', { timeout: 5000 });
    const wtext = (await p.locator('.phone-screen').textContent()) ?? '';
    check('a worker entry shows status, activity and task, and says workers don’t take calls', /Status/.test(wtext) && /Current task/.test(wtext) && /don’t take calls/.test(wtext) && (await p.locator('.phone-screen .ptt').count()) === 0);

    // Chief call: rule-based briefing as subtitles.
    await p.locator('.phone-contact[data-kind=chief]').click();
    await p.waitForSelector('.phone-subtitles li[data-who=chief]', { timeout: 8000 });
    const sub = (await p.locator('.phone-subtitles').textContent()) ?? '';
    check('calling the chief gives the rule-based briefing as subtitles', /Rule-based report/.test(sub) && /Chief of staff:/.test(sub) && /from the office records/.test(sub), sub.slice(0, 200));
    check('spoken replies are offered because a voice is installed', !(await p.locator('#phone-speak').isDisabled()));
    await p.waitForTimeout(600);
    await shot(p, '05-chief-call-subtitles-1440x900.jpg');

    // Push-to-talk with Chrome's fake microphone.
    const ptt = p.locator('.phone-ptt .btn.ptt');
    check('push-to-talk is enabled (STT installed, microphone available)', !(await ptt.isDisabled()));
    const box = (await ptt.boundingBox())!;
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down();
    await p.waitForFunction(() => document.querySelector('.phone-modal')?.classList.contains('recording'), null, { timeout: 5000 }).catch(() => {});
    check('holding the button records (recording state shown)', await p.evaluate(() => document.querySelector('.phone-modal')?.classList.contains('recording') ?? false));
    await p.waitForTimeout(1500);
    await p.mouse.up();
    await p.waitForSelector('.phone-confirm', { timeout: 10_000 });
    const confirm = (await p.locator('.phone-confirm').textContent()) ?? '';
    check('the transcript is shown for confirmation before sending', /How much did we spend today\?/.test(confirm) && /check before sending/.test(confirm), confirm);
    await shot(p, '06-push-to-talk-confirm-1440x900.jpg');
    const before = await p.locator('.phone-subtitles li[data-who=chief]').count();
    await p.locator('.phone-confirm button:has-text("Send to chief")').click();
    await p.waitForFunction((n) => document.querySelectorAll('.phone-subtitles li[data-who=chief]').length > n, before, { timeout: 8000 });
    const last = (await p.locator('.phone-subtitles li[data-who=chief]').last().textContent()) ?? '';
    check('the confirmed question is answered from the finance report', /Finance:/.test(last) && /Rule-based report/.test(last), last.slice(0, 160));
    check('sent once: the confirmation is gone', (await p.locator('.phone-confirm').count()) === 0);
    await p.waitForTimeout(400);
    await shot(p, '07-push-to-talk-reply-1440x900.jpg');

    // Text fallback: a new job becomes a pending plan.
    await p.fill('.phone-compose input', 'new job: write the onboarding guide');
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => /Nothing starts before you approve/.test(document.querySelector('.phone-subtitles')?.textContent ?? ''), null, { timeout: 8000 }).then(() => check('text “new job: …” saves a plan that waits for approval', true), () => check('text “new job: …” saves a plan that waits for approval', false));
    const jobs = await p.evaluate(async () => (await (await fetch('/__fixture/jobs')).json()).jobs as { title: string; decision: string }[]);
    const job = jobs.find((j) => j.title === 'Write the onboarding guide');
    check('the plan is pending approval, never auto-approved', job?.decision === 'pending_approval', JSON.stringify(job));
    // Escape: first hangs up, then closes.
    await p.locator('.phone-compose input').blur();
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    check('Escape hangs up first', (await p.locator('.phone-modal').count()) === 1 && (await p.locator('.phone-idle').count()) === 1);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    check('a second Escape closes the phone', (await p.locator('.phone-modal').count()) === 0);
    check('desktop: no console errors', d.errors.length === 0, d.errors.join(' | '));
    await d.context.close();

    // ---- Phone landscape 874x402, touch, reduced motion + Save-Data ----
    const m = await open(browser, { width: 874, height: 402, touch: true, reduced: true, saveData: true });
    const q = m.page;
    await openPhone(q);
    const fit = await q.evaluate(() => { const el = document.querySelector('.phone-modal') as HTMLElement; const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, overflow: el.scrollWidth - el.clientWidth }; });
    check('phone: the phone fits the 874x402 screen without horizontal overflow', fit.w <= 874 && fit.h <= 402 && fit.overflow <= 1, JSON.stringify(fit));
    await shot(q, '08-phone-contacts-874x402.jpg');
    await q.locator('.phone-contact[data-kind=chief]').tap();
    await q.waitForSelector('.phone-subtitles li[data-who=chief]', { timeout: 8000 });
    const tap = await q.evaluate(() => Math.min(...[...document.querySelectorAll('.phone-modal button')].map((b) => b.getBoundingClientRect().height).filter((x) => x > 0)));
    check('phone: controls are at least 32 px tall', tap >= 32, `${tap}px`);
    const anim = await q.evaluate(() => getComputedStyle(document.querySelector('.phone-avatar.big') as Element, '::after').animationName);
    check('phone: reduced motion stops the ringing animation', anim === 'none', anim);
    await q.waitForTimeout(400);
    await shot(q, '09-chief-call-874x402.jpg');
    await q.keyboard.press('Escape'); await q.keyboard.press('Escape');
    await openVoiceSettings(q);
    const overflow = await q.evaluate(() => { const el = document.querySelector('.voice-settings') as HTMLElement; return el.scrollWidth - el.clientWidth; });
    check('phone: voice setup fits without horizontal overflow', overflow <= 1, `${overflow}px`);
    await shot(q, '10-voice-setup-874x402.jpg');
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
