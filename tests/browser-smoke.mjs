import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:4610/login');
  await page.locator('#password').fill('empire-local-preview');
  await page.locator('#submit').click();
  await page.waitForURL('http://127.0.0.1:4610/');
  // Isolated browser context: fixtures do not change another player's profile or key mappings.
  await page.evaluate(() =>
    localStorage.setItem(
      'agent-office.profile',
      JSON.stringify({ name: 'Founder', color: '#32685c', look: { skin: 4, hair: 0, style: 0 } }),
    ),
  );
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#scene')?.dataset.assets === 'ready');
  if (await page.getByRole('dialog', { name: 'Found your city' }).count()) throw new Error('Complete founding setup before running traversal smoke checks. This script does not appoint paid AI workers.');
  assert.equal(await page.getByRole('button', { name: 'Office ↔ City' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Go home', exact: true }).count(), 0);
  const position = () => page.locator('#scene').getAttribute('data-position');
  const beforeMap = await position();
  await page.getByRole('button', { name: 'Expand district map' }).click();
  await page.getByRole('button', { name: 'Set waypoint to Founder residence', exact: true }).click();
  assert.equal(await position(), beforeMap, 'map selection must not teleport the player');
  await page.screenshot({ path: 'artifacts/navigation-map.png' });
  await page.getByRole('button', { name: 'Close district map' }).click();
  // Set a deterministic starting point, then exercise real held input and portal triggers.
  await page.evaluate(() => {
    const p = window.__office.player;
    p.pos.set(0, 0, 10);
    p.camYaw = Math.PI;
    p.setView('third');
    p.camYaw = Math.PI;
  });
  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => document.querySelector('#scene').dataset.traversal === 'exit-office');
  await page.keyboard.up('ArrowUp');
  await page.waitForFunction(
    () =>
      document.querySelector('#scene').dataset.traversal === 'walking' &&
      Number(document.querySelector('#scene').dataset.position.split(',')[2]) > 30,
  );
  await page.screenshot({ path: 'artifacts/navigation-exit.png' });
  await page.evaluate(() => {
    const p = window.__office.player;
    p.camYaw = 0;
    p.facing = Math.PI;
  });
  await page.waitForTimeout(1600);
  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => document.querySelector('#scene').dataset.traversal === 'enter-office');
  await page.keyboard.up('ArrowUp');
  await page.waitForFunction(
    () =>
      document.querySelector('#scene').dataset.traversal === 'walking' &&
      Number(document.querySelector('#scene').dataset.position.split(',')[2]) < 30,
  );
  await page.evaluate(() => {
    const w = window.__office;
    w.city.car.position.set(5, 0, 45);
    w.city.car.rotation.y = 0;
    w.player.pos.set(3.2, 0, 45.1);
  });
  await page.keyboard.press('e');
  await page.waitForFunction(() => document.querySelector('#scene').dataset.traversal === 'enter-car');
  await page.waitForTimeout(2600);
  await page.screenshot({ path: 'artifacts/navigation-car-entry.png' });
  await page.waitForFunction(() => document.querySelector('#scene').dataset.traversal === 'driving');
  const before = await position();
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(700);
  await page.keyboard.up('ArrowUp');
  assert.notEqual(await position(), before);
  await page.waitForTimeout(2400);
  await page.keyboard.press('e');
  await page.waitForFunction(() => document.querySelector('#scene').dataset.traversal === 'exit-car');
  await page.waitForFunction(() => document.querySelector('#scene').dataset.traversal === 'walking');
  await page.keyboard.press('n');
  assert.equal(await page.locator('#scene').getAttribute('data-view'), 'first');
  await page.screenshot({ path: 'artifacts/navigation-first-person.png' });
  await page.getByRole('button', { name: 'Management', exact: true }).click();
  assert.equal(await page.getByRole('dialog', { name: 'Empire operations' }).count(), 1);
  await page.getByRole('button', { name: 'Close operations' }).click();
  await page.locator('#btn-settings').click();
  await page.getByRole('button', { name: 'Remap Expand map', exact: true }).click();
  await page.keyboard.press('q');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForFunction(() => window.__office?.store.you);
  await page.keyboard.press('q');
  assert.equal(await page.getByRole('dialog', { name: 'District map' }).count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: physical doorway traversal, car animation/driving, non-teleporting map, camera, operations and saved controls');
} finally {
  await browser.close();
}
