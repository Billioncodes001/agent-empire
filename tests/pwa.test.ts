import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { connectionView, continuityView, parseContinuity } from '../src/client/ui/continuity';
import { STALE_MS } from '../src/client/ui/status';
import type { ContinuityStatus } from '../src/shared/continuity';

const pub = resolve(import.meta.dirname, '../src/client/public');
const status = (over: Partial<ContinuityStatus> = {}): ContinuityStatus => ({
  schemaVersion: 1, serverId: 'srv-1234567890abcdef', serverRunId: 'run-abcdef123', revision: 42, checkpointRevision: 40, oldestRevision: 1,
  observedAt: 1, mode: 'single_owner', durability: 'ok', ...over,
});

test('continuity status parsing rejects malformed or unknown schemas', () => {
  assert.ok(parseContinuity(status()));
  for (const bad of [null, 1, {}, { ...status(), schemaVersion: 2 }, { ...status(), mode: 'multi' }, { ...status(), durability: 'maybe' }, { ...status(), revision: -1 }, { ...status(), serverId: '' }, { ...status(), error: 3 }])
    assert.equal(parseContinuity(bad), null);
});

test('host persistence separates receipt freshness from what the host reported', () => {
  assert.equal(continuityView(null, 0, true, 0).tone, 'unknown');
  assert.equal(continuityView(status(), 1000, true, 2000).label, 'Host is saving state');
  const stale = continuityView(status(), 1000, true, 1000 + STALE_MS + 1);
  assert.equal(stale.tone, 'unknown');
  assert.match(stale.detail, /may no longer be current/);
  assert.equal(continuityView(status(), 1000, false, 1100).tone, 'unknown');
  const failed = continuityView(status({ durability: 'error', error: 'disk full' }), 1000, true, 1100);
  assert.equal(failed.tone, 'attention');
  assert.equal(failed.detail, 'disk full');
  for (const v of [continuityView(status(), 1000, true, 1100), connectionView({ online: true, connected: true })])
    assert.doesNotMatch(`${v.label} ${v.detail}`, /cloud|offline mode|runs? (here|on this device)/i);
});

test('connection view distinguishes device offline from host unreachable', () => {
  assert.equal(connectionView({ online: false, connected: false }).label, 'This device is offline');
  assert.equal(connectionView({ online: true, connected: false }).tone, 'unknown');
  assert.equal(connectionView({ online: true, connected: true }).tone, 'active');
});

function loadWorker() {
  const listeners: Record<string, (e: any) => void> = {};
  const added: any[] = [], deleted: string[] = [], opened: string[] = [];
  let network: () => Promise<unknown> = async () => ({ network: true });
  let cached: unknown = { offline: true };
  class FakeRequest {
    constructor(public url: string, init: Record<string, unknown> = {}) { Object.assign(this, init); }
  }
  const stored = new Map<string, unknown>();
  const staticCache = {
    match: async (req: any) => stored.get(req.url),
    put: async (req: any, res: unknown) => void stored.set(req.url, res),
    keys: async () => [...stored.keys()].map((url) => ({ url })),
    delete: async (req: any) => stored.delete(req.url),
  };
  const caches = {
    open: async (name: string) => {
      opened.push(name);
      if (name === 'agent-empire-static-v1') return staticCache;
      return { addAll: async (reqs: any[]) => void added.push(...reqs), put: async () => assert.fail('the offline cache must never store responses') };
    },
    keys: async () => ['agent-empire-offline-v0', 'agent-empire-offline-v1', 'agent-empire-static-v1', 'agent-empire-static-v0', 'someone-else'],
    delete: async (key: string) => (deleted.push(key), true),
    match: async (url: string, opts: { cacheName?: string }) => (['/assets/pwa/offline-v1.html', '/assets/pwa/icon-192-v1.png'].includes(url) && opts.cacheName === 'agent-empire-offline-v1' ? cached : undefined),
  };
  const self = {
    addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] = fn), skipWaiting: async () => {}, clients: { claim: async () => {} },
    location: { href: 'https://office.example/', origin: 'https://office.example' },
  };
  vm.runInNewContext(readFileSync(resolve(pub, 'sw.js'), 'utf8'), { self, caches, fetch: () => network(), Request: FakeRequest, Response, URL });
  const fetchEvent = (request: Record<string, string>) => {
    let responded: Promise<unknown> | undefined;
    listeners.fetch({ request, respondWith: (p: Promise<unknown>) => (responded = p) });
    return responded;
  };
  return { listeners, added, deleted, opened, fetchEvent, stored, setNetwork: (fn: typeof network) => (network = fn), setCached: (v: unknown) => (cached = v) };
}

test('service worker precaches only the public offline page and icon', async () => {
  const sw = loadWorker();
  let wait: Promise<unknown> = Promise.resolve();
  sw.listeners.install({ waitUntil: (p: Promise<unknown>) => (wait = p) });
  await wait;
  assert.deepEqual(sw.added.map((r) => r.url), ['/assets/pwa/offline-v1.html', '/assets/pwa/icon-192-v1.png']);
  assert.ok(sw.added.every((r) => r.credentials === 'omit'));
  sw.listeners.activate({ waitUntil: (p: Promise<unknown>) => (wait = p) });
  await wait;
  assert.deepEqual(sw.deleted, ['agent-empire-offline-v0', 'agent-empire-static-v0']);
});

const headers = (h: Record<string, string> = {}) => ({ has: (k: string) => k.toLowerCase() in h, get: (k: string) => h[k.toLowerCase()] ?? null });

test('service worker caches only fingerprinted static build files, never API, models or authorised requests (FREE-03)', async () => {
  const sw = loadWorker();
  let calls = 0;
  sw.setNetwork(async () => (calls++, { status: 200, type: 'basic', headers: headers({ 'cache-control': 'public, max-age=31536000, immutable' }), clone() { return { cloned: this }; } }));
  const asset = { mode: 'no-cors', method: 'GET', url: 'https://office.example/assets/main-B_pX_qdZ.js', headers: headers() };
  await sw.fetchEvent(asset);
  assert.equal(calls, 1);
  assert.ok(sw.stored.has(asset.url), 'a hashed build file is stored');
  await sw.fetchEvent(asset);
  assert.equal(calls, 1, 'the second load comes from the cache');
  for (const request of [
    { mode: 'cors', method: 'GET', url: 'https://office.example/api/continuity/status' },
    { mode: 'cors', method: 'GET', url: 'https://office.example/api/assets/main-B_pX_qdZ.js' },
    { mode: 'no-cors', method: 'GET', url: 'https://office.example/models/executive-sedan.glb' },
    { mode: 'no-cors', method: 'GET', url: 'https://office.example/textures/oak-color.jpg' },
    { mode: 'no-cors', method: 'GET', url: 'https://office.example/assets/pwa/icon-512-v1.png' },
    { mode: 'no-cors', method: 'GET', url: 'https://office.example/assets/main-B_pX_qdZ.js?token=x' },
    { mode: 'no-cors', method: 'GET', url: 'https://cdn.example/assets/main-B_pX_qdZ.js' },
    { mode: 'cors', method: 'GET', url: 'https://office.example/assets/view-CXTJV7fE.css', headers: headers({ authorization: 'Bearer x' }) },
    { mode: 'cors', method: 'POST', url: 'https://office.example/assets/main-B_pX_qdZ.js' },
  ])
    assert.equal(sw.fetchEvent(request), undefined, request.url);
});

test('the offline page icon falls back to its precached copy when the network fails', async () => {
  const sw = loadWorker();
  sw.setNetwork(async () => { throw new TypeError('offline'); });
  sw.setCached({ icon: true });
  const icon = sw.fetchEvent({ mode: 'no-cors', method: 'GET', url: 'https://office.example/assets/pwa/icon-192-v1.png' });
  assert.ok(icon, 'the worker answers the precached icon');
  assert.deepEqual(await icon, { icon: true });
});

test('service worker does not store error, opaque or no-store responses', async () => {
  for (const res of [
    { status: 404, type: 'basic', headers: headers() },
    { status: 200, type: 'opaque', headers: headers() },
    { status: 200, type: 'basic', headers: headers({ 'cache-control': 'no-store' }) },
    { status: 200, type: 'basic', headers: headers({ 'cache-control': 'private, max-age=60' }) },
  ]) {
    const sw = loadWorker();
    sw.setNetwork(async () => ({ ...res, clone: () => res }));
    const answered = await sw.fetchEvent({ mode: 'no-cors', method: 'GET', url: 'https://office.example/assets/main-B_pX_qdZ.js', headers: headers() } as any);
    assert.equal((answered as { status: number }).status, res.status, 'the network response is passed through');
    assert.equal(sw.stored.size, 0, JSON.stringify(res));
  }
});

test('service worker leaves API, assets, sockets and non-GET requests to the network', () => {
  const sw = loadWorker();
  for (const request of [
    { mode: 'cors', method: 'GET', url: '/api/continuity/status' },
    { mode: 'no-cors', method: 'GET', url: '/assets/index.js' },
    { mode: 'same-origin', method: 'GET', url: '/api/whoami' },
    { mode: 'navigate', method: 'POST', url: '/api/login' },
  ])
    assert.equal(sw.fetchEvent(request), undefined, request.url);
});

test('page loads use the network and fall back to the offline page only on failure', async () => {
  const sw = loadWorker();
  assert.deepEqual(await sw.fetchEvent({ mode: 'navigate', method: 'GET', url: '/' }), { network: true });
  assert.deepEqual(sw.opened, [], 'a successful page load must not touch the cache');
  sw.setNetwork(async () => { throw new TypeError('offline'); });
  assert.deepEqual(await sw.fetchEvent({ mode: 'navigate', method: 'GET', url: '/' }), { offline: true });
  sw.setCached(undefined);
  assert.equal(((await sw.fetchEvent({ mode: 'navigate', method: 'GET', url: '/' })) as Response).type, 'error');
});

test('manifest, icons and offline page are public, local and consistent', () => {
  const manifest = JSON.parse(readFileSync(resolve(pub, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\/assets\/pwa\//);
    assert.ok(existsSync(resolve(pub, icon.src.slice(1))), icon.src);
  }
  const offline = readFileSync(resolve(pub, 'assets/pwa/offline-v1.html'), 'utf8');
  assert.doesNotMatch(offline, /<script|https?:\/\//i);
  assert.match(offline, /only while that host stays on/);
  for (const page of ['index.html', 'login.html'])
    assert.match(readFileSync(resolve(pub, '..', page), 'utf8'), /<link rel="manifest" href="\/manifest\.webmanifest"/);
});
