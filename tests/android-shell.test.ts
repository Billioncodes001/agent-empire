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
  // The manifest flag is fontWeightAdjustment (aapt2 rejects 'fontWeightAdjust' and the APK would not build).
  for (const change of ['fontScale', 'fontWeightAdjustment', 'orientation', 'screenSize', 'density']) assert.ok(configChanges.includes(change), `configChanges has ${change}`);
});

test('android shell: a display-size (density) change recreates the activity (a new WebView) instead of keeping a stale layout', () => {
  const handler = activity.match(/public void onConfigurationChanged\(Configuration[^)]*\)\s*\{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.ok(handler, 'MainActivity overrides onConfigurationChanged');
  assert.match(handler, /super\.onConfigurationChanged/);
  assert.match(handler, /densityDpi/, 'compares the density');
  // A reload alone keeps the WebView's old density metrics (checked on the emulator: 915 CSS px at DPR 3.25 after it),
  // so the activity is recreated with a new WebView; the setup restores its progress from local storage.
  assert.match(handler, /recreate\(\)/, 'recreates the activity on a density change');
});
