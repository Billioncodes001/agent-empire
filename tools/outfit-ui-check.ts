/**
 * Corporate attire acceptance against the isolated UI fixture only (never the protected 4610 session).
 *   npm run build:client && FIXTURE_PORT=4719 FIXTURE_WORKERS=5 npx tsx tools/ui-fixture.ts
 *   FIXTURE_URL=http://localhost:4719/ npx tsx tools/outfit-ui-check.ts
 * Screenshots go to docs/team/reports/corporate-outfits/; exits non-zero on any failed check.
 * OUTFIT_UI_ONLY=perf only measures load size and frame time (PERF_LABEL names the run, e.g. before/after), which
 * also works against an older build's fixture with no FIXTURE_WORKERS support.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.FIXTURE_URL || 'http://localhost:4719/';
if (/:4610\b/.test(base)) throw new Error('Refusing the protected 4610 session; use the UI fixture.');
const out = resolve(import.meta.dirname, '../docs/team/reports/corporate-outfits');
mkdirSync(out, { recursive: true });
const only = process.env.OUTFIT_UI_ONLY;

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

interface Opened { context: BrowserContext; page: Page; errors: string[]; bytes: Map<string, number> }
async function open(browser: Browser, opts: { width: number; height: number; touch: boolean; style?: number | null; saveData?: boolean }): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1, isMobile: opts.touch, hasTouch: opts.touch });
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  if (opts.style !== null)
    await context.addInitScript((style: number) => {
      localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Fixture CEO', color: '#32685c', look: { skin: 4, hair: 0, style } }));
      localStorage.setItem('agent-empire.execution.offered', '1');
    }, opts.style ?? 0);
  else await context.addInitScript(() => localStorage.setItem('agent-empire.execution.offered', '1'));
  if (opts.saveData) await context.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true } }));
  const page = await context.newPage();
  const errors: string[] = [];
  const bytes = new Map<string, number>();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*404/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', async (r) => {
    const path = new URL(r.url()).pathname;
    if (r.status() === 404 && !path.startsWith('/api/')) errors.push(`404 ${path}`);
    // Transfer size from Content-Length (bodies of image and range fetches are not always retrievable).
    if (path.startsWith('/models/')) bytes.set(path, Number(await r.headerValue('content-length').catch(() => null)) || (await r.body().catch(() => Buffer.alloc(0))).length);
  });
  await page.goto(base);
  return { context, page, errors, bytes };
}

async function enterGame(page: Page) {
  await page.waitForFunction(() => ['ready', 'forced'].includes(document.documentElement.dataset.boot ?? ''), null, { timeout: 120_000 });
  await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10_000 });
  for (let i = 0; i < 4 && (await page.locator('#modal-root .backdrop').count()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
}

/** Puts the first-person camera `distance` m from a world point along its facing turned by `turn` rad, looking back at it. */
async function look(page: Page, at: { x: number; y: number; z: number; fx: number; fz: number }, distance: number, pitch = -0.12, turn = 0) {
  const c = Math.cos(turn), sn = Math.sin(turn);
  at = { ...at, fx: at.fx * c + at.fz * sn, fz: -at.fx * sn + at.fz * c };
  await page.evaluate(([p, d, lp]) => {
    const o = (window as unknown as { __office: { player: { pos: { set(x: number, y: number, z: number): void }; view: string; camYaw: number; lookPitch: number; facing: number } } }).__office;
    o.player.view = 'first';
    o.player.pos.set(p.x + p.fx * d, p.y, p.z + p.fz * d);
    // You look along (-sin yaw, -cos yaw): back toward the point.
    o.player.camYaw = Math.atan2(p.fx, p.fz);
    o.player.facing = o.player.camYaw;
    o.player.lookPitch = lp;
  }, [at, distance, pitch] as const);
  await page.waitForTimeout(2500);
}

/** A worker's world position and the direction its body faces, by id. */
async function workerAt(page: Page, id: string) {
  return page.evaluate((wid) => {
    const o = (window as unknown as { __office: { workerViews: Map<string, { model: { root: { getWorldPosition(v: unknown): { x: number; y: number; z: number }; getWorldDirection(v: unknown): { x: number; z: number } } } }> } }).__office;
    const v = o.workerViews.get(wid);
    if (!v) return null;
    // Vector3 scratch objects come from the root's own position (no THREE import in the page).
    const root = v.model.root as unknown as { getWorldPosition(v: object): { x: number; y: number; z: number }; getWorldDirection(v: object): { x: number; z: number }; position: { clone(): { set(x: number, y: number, z: number): object } } };
    const p = root.getWorldPosition(root.position.clone());
    const f = root.getWorldDirection(root.position.clone());
    // The seated body faces its desk, opposite the root's +Z.
    return { x: p.x, y: p.y, z: p.z, fx: -f.x, fz: -f.z };
  }, id);
}

async function wearing(page: Page) {
  return page.evaluate(() => {
    const o = (window as unknown as { __office: { me: { wearing: { avatar: string }; materialsReady: boolean }; city: { chief: { traverse(f: (o: { name: string; userData: Record<string, unknown> }) => void): void } }; workerViews: Map<string, { model: { wearing: Record<string, string> } }> } }).__office;
    let chief = '';
    o.city.chief.traverse((x) => { if (x.name === 'Realistic human') chief = String(x.userData.avatar); });
    return { me: o.me.wearing.avatar, ready: o.me.materialsReady, chief, workers: Object.fromEntries([...o.workerViews].map(([id, v]) => [id, v.model.wearing])) };
  });
}

/** Mean and 95th-percentile frame interval over `ms`, from requestAnimationFrame in the page. */
async function frameTimes(page: Page, ms = 4000) {
  return page.evaluate((duration) => new Promise<{ mean: number; p95: number; frames: number }>((done) => {
    const t: number[] = [];
    const start = performance.now();
    const tick = (now: number) => {
      t.push(now);
      if (now - start < duration) requestAnimationFrame(tick);
      else {
        const d = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
        done({ mean: d.reduce((a, b) => a + b, 0) / d.length, p95: d[Math.floor(d.length * 0.95)], frames: d.length });
      }
    };
    requestAnimationFrame(tick);
  }), ms);
}

async function perf(browser: Browser, label: string) {
  const report: Record<string, unknown> = { label, base };
  for (const [name, size] of [['desktop-1440x900', { width: 1440, height: 900, touch: false }], ['phone-812x375', { width: 812, height: 375, touch: true }]] as const) {
    const s = await open(browser, { ...size, style: 0 });
    try {
      await enterGame(s.page);
      // Let every lazily loaded body arrive (chief, residents, desk staff).
      await s.page.waitForTimeout(6000);
      await s.page.evaluate(() => { const o = (window as unknown as { __office: { player: { view: string } } }).__office; o.player.view = 'third'; });
      await s.page.waitForTimeout(1000);
      const frames = await frameTimes(s.page);
      const models = [...s.bytes].reduce((a, [, b]) => a + b, 0);
      const info = await s.page.evaluate(() => { const r = (window as unknown as { __office: { renderer: { info: { memory: { geometries: number; textures: number }; render: { triangles: number; calls: number } } } } }).__office.renderer.info; return { geometries: r.memory.geometries, textures: r.memory.textures, triangles: r.render.triangles, calls: r.render.calls }; });
      report[name] = { modelBytes: models, modelFiles: Object.fromEntries([...s.bytes].sort()), frames, renderer: info };
      console.log(`perf ${label} ${name}: models ${(models / 1024 / 1024).toFixed(2)} MiB in ${s.bytes.size} files · frame mean ${frames.mean.toFixed(1)} ms, p95 ${frames.p95.toFixed(1)} ms · ${JSON.stringify(info)}`);
    } finally {
      await s.context.close();
    }
  }
  writeFileSync(resolve(out, `perf-${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
}

// Perf runs lift the 60 Hz frame cap so frame times show the actual cost.
const unthrottled = only === 'perf' ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal', ...unthrottled] });
try {
  if (only === 'perf') await perf(browser, process.env.PERF_LABEL || 'after');
  else {
    // 1. Character select: the CEO suit catalog (first visit, no saved profile).
    {
      const s = await open(browser, { width: 1440, height: 900, touch: false, style: null });
      await s.page.waitForSelector('#modal-root .charsel', { timeout: 120_000 });
      const group = s.page.locator('.charsel [role=radiogroup][aria-label="Character model"]');
      const options = await group.locator('[role=radio]').allTextContents();
      check('character select lists the six CEO suits', options.length === 6, options.join(' | '));
      check('character select keeps Random profile', (await s.page.locator('.charsel button:has-text("Random profile")').count()) === 1);
      await s.page.waitForTimeout(5000);
      await s.page.screenshot({ path: resolve(out, '01-character-select-1440x900.jpg'), quality: 82 });
      await group.locator('[role=radio]:has-text("Black trouser suit")').click();
      await s.page.waitForTimeout(4000);
      check('choosing a suit marks it checked', (await group.locator('[role=radio][aria-checked=true]').textContent())?.includes('Black trouser suit') ?? false);
      await s.page.screenshot({ path: resolve(out, '01b-character-select-female-ceo-1440x900.jpg'), quality: 82 });
      await s.page.fill('.charsel input[aria-label="Your name"]', 'Ada');
      await s.page.locator('.charsel button[type=submit]').click();
      await enterGame(s.page);
      await s.page.waitForTimeout(4000);
      const w = await wearing(s.page);
      check('the CEO wears the chosen suit', w.me === 'business-f01', w.me);
      check('a female CEO’s chief of staff wears the navy suit', w.chief === 'business-m02', w.chief);
      check('no console errors or missing assets (character select → game)', !s.errors.length, s.errors.slice(0, 5).join(' · '));
      await s.context.close();
    }
    // 2. In game on desktop with a male CEO: the CEO, the chief of staff and a desk of workers in default attire,
    //    then a hire with a customised outfit.
    {
      const s = await open(browser, { width: 1440, height: 900, touch: false, style: 0 });
      await enterGame(s.page);
      await s.page.waitForTimeout(6000);
      let w = await wearing(s.page);
      check('style 0 CEO wears the black suit with the red tie', w.me === 'business-m01' && w.ready, `${w.me} ready=${w.ready}`);
      check('a male CEO’s chief of staff wears the taupe skirt suit', w.chief === 'business-f03', w.chief);
      await s.page.evaluate(() => { const o = (window as unknown as { __office: { player: { view: string; camYaw: number; camDist: number } } }).__office; o.player.view = 'third'; o.player.camYaw = Math.PI * 0.85; o.player.camDist = 3.2; });
      await s.page.waitForTimeout(1500);
      await s.page.screenshot({ path: resolve(out, '02-ceo-in-game-1440x900.jpg'), quality: 82 });
      const chief = await s.page.evaluate(() => {
        const o = (window as unknown as { __office: { city: { chief: { getWorldPosition(v: object): { x: number; y: number; z: number }; position: { clone(): object } } } } }).__office;
        const p = o.city.chief.getWorldPosition(o.city.chief.position.clone());
        return { x: p.x, y: p.y, z: p.z };
      });
      await look(s.page, { ...chief, fx: 0.35, fz: 0.94 }, 2.4, -0.1);
      await s.page.screenshot({ path: resolve(out, '03-chief-of-staff-1440x900.jpg'), quality: 82 });
      const staff = Object.keys(w.workers).filter((id) => id.startsWith('fixture-staff-'));
      check('fixture desk staff are seated (FIXTURE_WORKERS)', staff.length >= 3, `${staff.length} staff`);
      const { WORKER_AVATARS, workerAvatar } = await import('../src/shared/outfit.ts');
      check('desk staff wear the stable default attire', staff.every((id) => w.workers[id].avatar === workerAvatar(id) && WORKER_AVATARS.includes(w.workers[id].avatar as never)), staff.map((id) => `${id}:${w.workers[id].avatar}`).join(' '));
      const first = await workerAt(s.page, staff[1] ?? staff[0]);
      if (first) {
        await look(s.page, first, 2.6, -0.26, 2.0);
        await s.page.screenshot({ path: resolve(out, '04-desk-workers-default-attire-1440x900.jpg'), quality: 82 });
      }
      // Hire at an empty desk through the task dialog, with a customised outfit. Staff walk about on breaks, so try
      // free desks until the hint (the nearest thing in reach) offers a hire.
      const candidates = await s.page.evaluate(() => {
        const o = (window as unknown as { __office: { office: { interactables: { kind: string; deskId?: string; x: number; z: number }[] }; store: { workerAtDesk(id: string): unknown } } }).__office;
        const desks = o.office.interactables.filter((it) => it.kind === 'desk' && it.deskId);
        return desks.filter((it) => !desks.some((n) => Math.hypot(n.x - it.x, n.z - it.z) < 3 && o.store.workerAtDesk(n.deskId!))).map((d) => ({ id: d.deskId!, x: d.x, z: d.z }));
      });
      let desk: { id: string; x: number; z: number } | null = null;
      for (const d of candidates) {
        await s.page.evaluate((p) => { const o = (window as unknown as { __office: { player: { pos: { set(x: number, y: number, z: number): void }; view: string } } }).__office; o.player.view = 'first'; o.player.pos.set(p.x, 0, p.z); }, d);
        const ok = await s.page.waitForFunction(() => /Desk \d+ · empty/.test(document.getElementById('hint')?.textContent ?? ''), null, { timeout: 5_000 }).then(() => true, () => false);
        if (ok) { desk = d; break; }
      }
      check('an empty desk is available to hire at', !!desk, JSON.stringify(desk));
      if (desk) {
        await s.page.keyboard.press('KeyP');
        await s.page.waitForSelector('#modal-root .outfit-pick', { timeout: 10_000 });
        await s.page.locator('.outfit-pick summary').click();
        await s.page.locator('.outfit-avatars [role=radio]:has-text("Charcoal suit, teal tie")').click();
        await s.page.locator('[role=radiogroup][aria-label="Suit colour"] [aria-label="Suit colour: Burgundy"]').click();
        await s.page.locator('[role=radiogroup][aria-label="Shirt colour"] [aria-label="Shirt colour: Sky blue"]').click();
        await s.page.locator('[role=radiogroup][aria-label="Tie colour"] [aria-label="Tie colour: Gold"]').click();
        await s.page.waitForTimeout(3500);
        const summary = await s.page.locator('.outfit-sum').textContent();
        check('outfit summary reflects the choice', /Charcoal suit, teal tie · custom colours/.test(summary ?? ''), summary ?? '');
        await s.page.screenshot({ path: resolve(out, '05a-hire-dialog-outfit-1440x900.jpg'), quality: 82 });
        const tie = await s.page.locator('[role=radiogroup][aria-label="Tie colour"]').count();
        await s.page.locator('.outfit-avatars [role=radio]:has-text("Black trouser suit")').click();
        check('tie colours are offered only where a tie is worn', tie === 1 && (await s.page.locator('[role=radiogroup][aria-label="Tie colour"]').count()) === 0);
        await s.page.locator('.outfit-avatars [role=radio]:has-text("Charcoal suit, teal tie")').click();
        await s.page.locator('[role=radiogroup][aria-label="Tie colour"] [aria-label="Tie colour: Gold"]').click();
        await s.page.fill('#modal-root textarea', 'Fixture hire: display-only worker');
        await s.page.locator('#modal-root button[type=submit]').click();
        await s.page.waitForTimeout(5000);
        w = await wearing(s.page);
        const hired = Object.entries(w.workers).find(([id]) => !staff.includes(id) && id !== 'fixture-chief');
        check('the hired worker wears the chosen outfit', !!hired && hired[1].avatar === 'business-m03' && hired[1].suit === '#5e1f2a' && hired[1].shirt === '#bcd3ea' && hired[1].tie === '#c19a35', JSON.stringify(hired?.[1]));
        // A new hire walks in to the desk first (worker-life.ts); photograph once seated.
        if (hired) await s.page.waitForFunction((id) => {
          const v = (window as unknown as { __office: { workerViews: Map<string, { model: { root: { traverse(f: (o: { isSkinnedMesh?: boolean }) => void): void }; motion: { seated: boolean; transition: string | null } } }> } }).__office.workerViews.get(id);
          let body = false;
          v?.model.root.traverse((o) => { if (o.isSkinnedMesh) body = true; });
          return !!v && body && v.model.motion.seated && !v.model.motion.transition;
        }, hired[0], { timeout: 90_000 }).catch(() => console.log('      (hired worker not seated in time)'));
        await s.page.waitForTimeout(2000);
        const at = hired ? await workerAt(s.page, hired[0]) : null;
        if (at) {
          await look(s.page, at, 2.0, -0.3, 2.0);
          await s.page.screenshot({ path: resolve(out, '05b-customised-worker-1440x900.jpg'), quality: 82 });
        }
      }
      check('no console errors or missing assets (desktop game)', !s.errors.length, s.errors.slice(0, 5).join(' · '));
      await s.context.close();
    }
    // 3. Phone landscape (812×375, touch): 512² textures, the CEO in game.
    {
      const s = await open(browser, { width: 812, height: 375, touch: true, style: 3 });
      await enterGame(s.page);
      await s.page.waitForTimeout(6000);
      const w = await wearing(s.page);
      check('phone: CEO style 3 wears the pinstripe suit, textured', w.me === 'business-f04' && w.ready, `${w.me} ready=${w.ready}`);
      const textures = [...s.bytes.keys()].filter((p) => p.endsWith('.webp') && !p.includes('/mask-'));
      check('phone loads only the 512² texture set', textures.length > 0 && textures.every((p) => p.endsWith('-512.webp')), textures.slice(0, 3).join(' '));
      await s.page.evaluate(() => { const o = (window as unknown as { __office: { player: { view: string; camYaw: number; camDist: number } } }).__office; o.player.view = 'third'; o.player.camYaw = Math.PI * 0.85; o.player.camDist = 3.2; });
      await s.page.waitForTimeout(1500);
      await s.page.screenshot({ path: resolve(out, '06-phone-landscape-812x375.jpg'), quality: 82 });
      check('no console errors or missing assets (phone)', !s.errors.length, s.errors.slice(0, 5).join(' · '));
      await s.context.close();
    }
    // 4. Save-Data on desktop also gets the small texture set.
    {
      const s = await open(browser, { width: 1280, height: 800, touch: false, style: 0, saveData: true });
      await enterGame(s.page);
      await s.page.waitForTimeout(3000);
      const textures = [...s.bytes.keys()].filter((p) => p.endsWith('.webp') && !p.includes('/mask-'));
      check('Save-Data loads only the 512² texture set', textures.length > 0 && textures.every((p) => p.endsWith('-512.webp')), `${textures.length} textures`);
      await s.context.close();
    }
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
