/**
 * DEVICE-BUGS-03 review 4-5: the Android shell keeps the setup through system setting changes.
 * On the released beta.2 APK, changing the font scale recreated the activity and the setup started again at the welcome
 * screen; changing the display size left the WebView laid out for the old density (everything scaled off screen).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = readFileSync(path.join(root, 'mobile/android/app/src/main/AndroidManifest.xml'), 'utf8');
const activity = readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/agentempire/mobile/MainActivity.java'), 'utf8');
const configChanges = (manifest.match(/android:configChanges="([^"]+)"/)?.[1] ?? '').split('|');

test('android shell: font scale and font weight changes do not recreate the activity (the setup is kept)', () => {
  for (const change of ['fontScale', 'fontWeightAdjust', 'orientation', 'screenSize', 'density']) assert.ok(configChanges.includes(change), `configChanges has ${change}`);
});

test('android shell: a display-size (density) change reloads the page safely instead of keeping a stale layout', () => {
  const handler = activity.match(/public void onConfigurationChanged\(Configuration[^)]*\)\s*\{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.ok(handler, 'MainActivity overrides onConfigurationChanged');
  assert.match(handler, /super\.onConfigurationChanged/);
  assert.match(handler, /densityDpi/, 'compares the density');
  assert.match(handler, /reload\(\)/, 'reloads the WebView on a density change (setup progress is restored from local storage)');
});
