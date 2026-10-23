import test from 'node:test';
import assert from 'node:assert/strict';
import { devicePlatform, lastSeen, parseDevices } from '../src/client/ui/devices';

test('device list parsing validates rows and puts this device first, then most recently seen', () => {
  const rows = parseDevices({ devices: [
    { id: 'a1', name: 'Browser', createdAt: 1, lastUsedAt: 50, current: false },
    { id: 'b2', name: 'iPhone', createdAt: 2, lastUsedAt: 10, current: true },
    { id: 'c3', name: '', createdAt: 3, lastUsedAt: 90 },
  ] });
  assert.deepEqual(rows?.map(r => r.id), ['b2', 'c3', 'a1']);
  assert.equal(rows?.[1].name, 'Device');
  assert.equal(rows?.[1].current, false);
  assert.equal(parseDevices({ devices: [{ id: '../x', name: 'Bad' }] }), null, 'ids are path-safe');
  assert.equal(parseDevices({}), null);
  assert.equal(parseDevices(null), null);
});

test('platform comes from the sign-in device name; unknown names show none', () => {
  assert.equal(devicePlatform('iPhone'), 'iOS');
  assert.equal(devicePlatform('iPad'), 'iOS');
  assert.equal(devicePlatform('Android device'), 'Android');
  assert.equal(devicePlatform('Desktop app'), 'Desktop');
  assert.equal(devicePlatform('Browser'), 'Web');
  assert.equal(devicePlatform('Kitchen tablet'), undefined);
});

test('last seen is relative and honest about never', () => {
  const now = 10 * 86_400_000;
  assert.equal(lastSeen(0, now), 'never');
  assert.equal(lastSeen(now - 30_000, now), 'just now');
  assert.equal(lastSeen(now - 15 * 60_000, now), '15 min ago');
  assert.equal(lastSeen(now - 5 * 3_600_000, now), '5 h ago');
  assert.equal(lastSeen(now - 86_400_000, now), '1 day ago');
  assert.equal(lastSeen(now - 3 * 86_400_000, now), '3 days ago');
});
