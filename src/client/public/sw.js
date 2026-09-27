// Agent Empire service worker. Its only job: show a public explanation when a page cannot load.
// It never stores app pages, API responses, terminal output, snapshots or credentials.
const CACHE = 'agent-empire-offline-v1';
const OFFLINE_URL = '/assets/pwa/offline-v1.html';
const PRECACHE = [OFFLINE_URL, '/assets/pwa/icon-192-v1.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload', credentials: 'omit' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('agent-empire-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Everything except a failed top-level page load goes straight to the network, untouched.
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  event.respondWith(
    fetch(request).catch(async () => (await caches.match(OFFLINE_URL, { cacheName: CACHE })) || Response.error()),
  );
});
