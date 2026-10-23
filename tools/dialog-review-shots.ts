/**
 * Screenshots of the game's dialogs from the dev-only review page (src/client/dialog-review.html), at desktop
 * 1440×900 and phone landscape 874×402, plus a contrast and focus-ring audit of each dialog.
 *   npx vite --port 4811 --strictPort &   npx tsx tools/dialog-review-shots.ts <before|after>
 * Writes docs/team/reports/consistency/<stage>-<dialog>-<width>.png. No server, workers or providers are involved.
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const stage = process.argv[2] ?? 'after';
const base = process.env.REVIEW_URL ?? 'http://localhost:4811';
const out = resolve(import.meta.dirname, '../docs/team/reports/consistency');
mkdirSync(out, { recursive: true });
const names = ['issues', 'pull', 'merge', 'issue', 'ask', 'hang', 'picture', 'workers', 'tower', 'viewer'];
const sizes = [{ width: 1440, height: 900 }, { width: 874, height: 402 }];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let failures = 0;
for (const size of sizes) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  await page.addInitScript('globalThis.__name = (f) => f'); // tsx keeps function names with a helper the page lacks
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const name of names) {
    await page.goto(`${base}/dialog-review.html?d=${name}`);
    await page.waitForTimeout(name === 'merge' || name === 'pull' ? 1400 : 700);
    await page.screenshot({ path: resolve(out, `${stage}-${name}-${size.width}.png`) });
    // Contrast: every visible text node in the top dialog against its nearest opaque background.
    const audit = await page.evaluate(() => {
      const modals = document.querySelectorAll('#modal-root .modal');
      const modal = modals[modals.length - 1] as HTMLElement | undefined;
      if (!modal) return { dark: false, worst: 0, worstText: 'no dialog', overflow: false };
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bgOf = (el: Element | null): number[] => {
        for (let e = el; e; e = e.parentElement) {
          const s = getComputedStyle(e);
          const c = rgb(s.backgroundColor);
          if (c.length >= 3 && (c[3] ?? 1) > 0.85) return c;
          if (s.backgroundImage.includes('gradient')) { const m = /rgba?\([^)]*\)/.exec(s.backgroundImage); if (m) return rgb(m[0]).slice(0, 3); }
        }
        return [21, 34, 40];
      };
      let worst = 21, worstText = '';
      const walker = document.createTreeWalker(modal, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement!;
        if (!n.textContent!.trim() || !el.checkVisibility?.() || el.closest('.label, .pd, [aria-hidden=true]')) continue;
        const s = getComputedStyle(el);
        const fg = rgb(s.color); const bg = bgOf(el);
        const a = fg[3] ?? 1; const mixed = fg.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a));
        const [l1, l2] = [lum(mixed), lum(bg)].sort((x, y) => y - x);
        const ratio = (l1 + 0.05) / (l2 + 0.05);
        if (ratio < worst) { worst = ratio; worstText = `${n.textContent!.trim().slice(0, 40)} (${s.color} on rgb(${bg.slice(0, 3).join(',')}))`; }
      }
      return { dark: modal.classList.contains('ae-dark'), worst: Math.round(worst * 100) / 100, worstText, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    // Focus ring on the first focusable control.
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300); // focus rings animate in
    const ring = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; if (!a || a === document.body) return 'none'; const s = getComputedStyle(a); return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || s.boxShadow.includes('0px 0px 0px') ? 'ok' : `${s.outlineStyle} ${s.outlineWidth} on ${a.tagName.toLowerCase()}.${a.className}`; });
    const ok = stage === 'before' || (audit.dark && audit.worst >= 4.5 && ring === 'ok' && !audit.overflow);
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} @${size.width}: dark=${audit.dark} worst contrast ${audit.worst} ${audit.worst < 4.5 ? '← ' + audit.worstText : ''} focus=${ring} overflow=${audit.overflow}`);
  }
  if (errors.length) { failures++; console.log(`FAIL page errors @${size.width}: ${errors.join(' | ')}`); }
  await page.close();
}
await browser.close();
console.log(failures ? `${failures} failing` : 'all dialog checks pass');
process.exit(stage === 'before' ? 0 : failures ? 1 : 0);
