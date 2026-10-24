// Agent Empire service worker (FREE-03). Two jobs, nothing else:
// 1. Show a public explanation page when a page cannot load.
// 2. Keep the game's fingerprinted static build files (/assets/<name>-<hash>.<ext>) so repeat visits load fast.
//    The office server serves /assets/ to everyone before sign-in, and a hashed file never changes.
// It never stores app pages, /api responses, terminal output, snapshots, credentials, models or textures (those are
// served only after sign-in), never touches WebSockets (they do not pass through a service worker), and never stores
// a request that carries an Authorization header.
const CACHE = 'agent-empire-offline-v1';
const STATIC_CACHE = 'agent-empire-static-v1';
const KEEP = [CACHE, STATIC_CACHE];
const OFFLINE_URL = '/assets/pwa/offline-v1.html';
const PRECACHE = [OFFLINE_URL, '/assets/pwa/icon-192-v1.png'];
const STATIC_LIMIT = 120;
// Vite output: /assets/<name>-<8-char hash>.<ext>. No sub-folders (so /assets/pwa/* is excluded).
const HASHED_ASSET = /^\/assets\/[\w.-]+-[\w-]{8}\.(?:js|css|woff2?|png|jpe?g|webp|avif|svg|glb|gltf|bin|hdr|ktx2|wasm|wav|mp3|ogg)$/;

/** Whether a request may be answered from, and stored in, the static cache. */
function isStaticAsset(request) {
  if (request.method !== 'GET') return false;
  if (request.headers && typeof request.headers.has === 'function' && request.headers.has('authorization')) return false;
  let url;
  try {
    url = new URL(request.url, self.location && self.location.href);
  } catch {
    return false;
  }
  if (self.location && url.origin !== self.location.origin) return false;
  if (url.search) return false;
  return HASHED_ASSET.test(url.pathname);
}

/** Only a plain, complete, same-origin 200 that the server lets clients store. */
function storable(response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false;
  const cc = (response.headers && response.headers.get && response.headers.get('cache-control')) || '';
  return !/no-store|private/i.test(cc);
}

async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - STATIC_LIMIT))) await cache.delete(key);
}

async function fromStaticCache(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (storable(response)) {
    await cache.put(request, response.clone());
    await trim(cache);
  }
  return response;
}

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
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('agent-empire-') && !KEEP.includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    // Pages always come from the network; the cache is only a fallback explanation when that fails.
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(OFFLINE_URL, { cacheName: CACHE })) || Response.error()),
    );
    return;
  }
  const pathname = new URL(request.url, self.location && self.location.href).pathname;
  if (PRECACHE.includes(pathname) && pathname !== OFFLINE_URL) {
    // The offline page's own image: network first, its precached copy when the network fails.
    event.respondWith(fetch(request).catch(async () => (await caches.match(pathname, { cacheName: CACHE })) || Response.error()));
    return;
  }
  if (isStaticAsset(request)) event.respondWith(fromStaticCache(request));
  // Everything else (API, models, textures, audio, other origins) goes straight to the network, untouched.
});
