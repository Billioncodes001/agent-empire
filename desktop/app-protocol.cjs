/**
 * Serves the bundled game at empire-app://game/ from the app's resources (runtime/public). Pure Node, so
 * tests/desktop-bridge.test.ts exercises it without Electron.
 *
 * Only GET/HEAD for host "game"; the path is decoded once, must stay inside the root after symlinks are resolved,
 * and may not name a dotfile, a source map or a web-only page (sign-in, claim, consultancy, service worker): the
 * app signs in natively, like the iOS and Android shells (tools/sync-ios-game.sh excludes the same files).
 */
const fs = require('node:fs');
const path = require('node:path');
const { APP_HOST, APP_SCHEME } = require('./bridge-policy.cjs');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.hdr': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
});
const EXCLUDED = new Set(['sw.js', 'login.html', 'claim.html', 'consultancy.html']);
/**
 * The Android shell's HTML policy (AssetPolicy.HTML_CSP) plus scripts from the bundle only: the built client has no
 * inline script and no eval. Connections stay open because the server the player chooses is only known at runtime.
 */
const HTML_CSP = "script-src 'self'; worker-src 'self' blob:; frame-src 'self'; child-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'";

const mimeFor = (file) => MIME[path.extname(file).toLowerCase()];

/**
 * Maps a request URL to a file under root, or returns {status} for a refusal. Never throws.
 */
function resolveAsset(root, requestUrl) {
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return { status: 400 };
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST || url.username || url.password) return { status: 403 };
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return { status: 400 };
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  // Decoded once: a remaining "%", a backslash, NUL or a ".." segment is never a legitimate bundle path.
  if (/[\\\0%]/.test(rel) || rel.split('/').some((seg) => seg === '..' || seg === '.')) return { status: 403 };
  const segments = rel.split('/').filter(Boolean);
  if (!segments.length || segments.some((seg) => seg.startsWith('.'))) return { status: 404 };
  const name = segments[segments.length - 1];
  if (segments.length === 1 && EXCLUDED.has(name)) return { status: 404 };
  if (name.endsWith('.map')) return { status: 404 };
  const type = mimeFor(name);
  if (!type) return { status: 404 };
  const base = path.resolve(root);
  const file = path.resolve(base, ...segments);
  if (file !== base && !file.startsWith(base + path.sep)) return { status: 403 };
  let real, realBase;
  try {
    realBase = fs.realpathSync(base);
    real = fs.realpathSync(file);
  } catch {
    return { status: 404 };
  }
  if (!real.startsWith(realBase + path.sep)) return { status: 403 };
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return { status: 404 };
  }
  if (!stat.isFile()) return { status: 404 };
  return { status: 200, file: real, type, size: stat.size };
}

/** Headers for a served file. */
function headersFor(type) {
  const headers = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };
  if (type.startsWith('text/html')) Object.assign(headers, { 'Cache-Control': 'no-cache', 'Content-Security-Policy': HTML_CSP, 'Referrer-Policy': 'no-referrer' });
  return headers;
}

/**
 * The protocol.handle callback: (Request) => Response. `root` is a folder, or a function returning the folder to serve
 * now (in-app updates: the active installed bundle, else the built-in one; update-store.cjs). Each request resolves
 * against one root with the same traversal, dotfile and MIME rules.
 */
function createHandler(root) {
  const rootNow = typeof root === 'function' ? root : () => root;
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const found = resolveAsset(rootNow(), request.url);
    if (found.status !== 200) return new Response(null, { status: found.status, headers: { 'X-Content-Type-Options': 'nosniff' } });
    const body = request.method === 'HEAD' ? null : await fs.promises.readFile(found.file);
    return new Response(body, { status: 200, headers: { ...headersFor(found.type), 'Content-Length': String(found.size) } });
  };
}

module.exports = { MIME, EXCLUDED, HTML_CSP, mimeFor, resolveAsset, headersFor, createHandler };
