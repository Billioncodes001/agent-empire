/**
 * The status lines (error / up to date / busy) in the dark Updates dialog must be readable. In `.modal.ae-dark` the
 * text colour (--ink) is light, so the light-paper status backgrounds made "The release's signature does not match…"
 * nearly invisible (found on the packaged macOS app, docs/team/reports/update-device-rerun.md).
 * Renders src/client/style.css in headless Chrome and checks WCAG contrast; skipped when Chrome is not installed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const css = readFileSync(resolve(import.meta.dirname, '../src/client/style.css'), 'utf8');

test('update status lines in the dark Updates dialog have at least 4.5:1 contrast', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    t.skip('Chrome is not installed');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
      <div class="modal ae-dark update-modal"><div class="body update-body">
        <p class="upgrade-status error" id="error">The release’s signature does not match this app’s release key.</p>
        <p class="upgrade-status ok" id="ok">You’re up to date.</p>
        <p class="upgrade-status busy" id="busy">Checking for updates…</p>
      </div></div></body></html>`);
    await page.evaluate('window.__name = (f) => f'); // tsx wraps named functions in __name()
    const ratios = await page.evaluate(() => {
      const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const c = [r, g, b].map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      // The effective background: the first ancestor with an opaque-enough background colour.
      const bg = (el: Element | null): number[] => {
        for (let e = el; e; e = e.parentElement) {
          const v = rgb(getComputedStyle(e).backgroundColor);
          if (v.length === 3 || (v[3] ?? 1) > 0.5) return v.slice(0, 3);
        }
        return [255, 255, 255];
      };
      return Object.fromEntries(['error', 'ok', 'busy'].map((id) => {
        const el = document.getElementById(id)!;
        const a = lum(rgb(getComputedStyle(el).color).slice(0, 3)), b = lum(bg(el));
        return [id, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)];
      }));
    });
    for (const [id, ratio] of Object.entries(ratios)) assert.ok(ratio >= 4.5, `${id} status contrast ${ratio.toFixed(2)}:1 is below 4.5:1`);
  } finally {
    await browser.close();
  }
});
