/**
 * Device testing (v1.0.0-beta.1, Android emulator): a long press on a dialog button ("Don't show again", "Skip this
 * step") selected its label and opened Android's Copy / Share / Select all bar over the game. Buttons in the game and
 * in the first-launch setup must not be text-selectable or show the touch callout. Renders the real stylesheets in
 * headless Chrome; skipped when Chrome is not installed. Form fields stay selectable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const sheet = (p: string) => readFileSync(resolve(import.meta.dirname, '../src/client', p), 'utf8');

for (const [name, css, markup] of [
  ['game', sheet('style.css'), '<div class="modal"><button class="btn" id="b">Skip this step</button><button class="linkish" id="l">Don’t show again</button><div role="button" id="r">Close</div><input id="i" value="Northwind"></div>'],
  ['setup', sheet('setup/setup.css'), '<div class="su"><button class="su-btn" id="b">Sign in</button><button id="l">Back</button><div role="button" id="r">Card</div><input id="i" value="city.example.com"></div>'],
] as const) {
  test(`${name} buttons are not text-selectable on touch`, async (t) => {
    let browser;
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true });
    } catch {
      t.skip('Chrome is not installed');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${markup}</body></html>`);
      const styles = await page.evaluate(`(() => Object.fromEntries(['b','l','r','i'].map((id) => {
        const s = getComputedStyle(document.getElementById(id));
        return [id, { select: s.userSelect || s.webkitUserSelect, callout: s.webkitTouchCallout }];
      })))()`) as Record<string, { select: string; callout?: string }>;
      for (const id of ['b', 'l', 'r']) assert.equal(styles[id].select, 'none', `${name} #${id} label is selectable`);
      assert.notEqual(styles.i.select, 'none', 'text fields stay selectable');
    } finally {
      await browser.close();
    }
  });
}
