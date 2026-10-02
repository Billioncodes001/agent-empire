/**
 * Pure rules for the desktop native bridge (docs/team/CLOUD_MODE_PLAN.md, "Native bridge contract").
 * No Electron types, so tests/desktop-bridge.test.ts covers every rule. main.cjs enforces these on every call.
 * Same rules as Android BridgePolicy.java and iOS BridgeProtocol.swift.
 */
const APP_SCHEME = 'empire-app';
const APP_HOST = 'game';
/** The bundled game's origin. The server already allows it (src/server/server.ts APP_ORIGINS, shared with iOS). */
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const METHODS = Object.freeze(['secure.get', 'secure.set', 'secure.delete', 'github.deviceFlow', 'app.signedOut', 'app.openExternal', 'app.runLocal',
  // In-app updates (docs/team/RELEASE_PLAN.md, REL-04): see update-store.cjs.
  'update.fetch', 'update.installGame', 'update.activate', 'update.bootOk', 'update.nativeInfo', 'update.openNative']);
/** Releases come only from this repository (src/client/update/channel.ts RELEASE_REPO; Android and iOS pin the same). */
const RELEASE_REPO = 'Billioncodes001/agent-empire';
const RELEASES_API = `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=20`;
/** Hosts GitHub redirects a release download to. Nothing else is followed. */
const ASSET_REDIRECT_HOSTS = Object.freeze(['objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
/** Stored modes. 'local' is desktop-only: the bundled server on this computer ("Run on this computer"). */
const MODES = Object.freeze(['cloud', 'server', 'local']);
/**
 * Modes the page may store. 'local' is written only by the main process after the player confirms the native
 * "Run on this computer" dialog (app.runLocal or the menu); a page script must never be able to select it.
 */
const PAGE_MODES = Object.freeze(['cloud', 'server']);
/** Fixed key allowlist for secure.get/set/delete. Provider API keys are never among them. */
const KEYS = Object.freeze(['mode', 'server.host', 'server.token', 'server.deviceId', 'github.token', 'github.login', 'state.repo']);
/** Cleared by app.signedOut: every credential and the identity bound to it. Preferences (mode, host, repo) stay. */
const SESSION_KEYS = Object.freeze(['server.token', 'server.deviceId', 'github.token', 'github.login']);
const GITHUB_SCOPES = Object.freeze(['repo', 'workflow', 'read:user']);
const SIGN_OUT_REASONS = Object.freeze(['user', 'revoked', 'unauthorized']);
const MAX_VALUE_LENGTH = 8192;
/** How long after a real click or key press app.openExternal is still accepted without asking. */
const GESTURE_WINDOW_MS = 5000;

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,100}$/;
const DEVICE_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const STATE_REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-((?:0|[1-9]\d{0,8}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d{0,8}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEGMENT = /^[A-Za-z0-9._+-]{1,128}$/;

const isKey = (key) => typeof key === 'string' && KEYS.includes(key);
const isSemver = (v) => typeof v === 'string' && v.length <= 64 && SEMVER.test(v);
const isSha256 = (v) => typeof v === 'string' && SHA256.test(v);

/** SemVer 2.0 precedence (same as src/client/update/semver.ts). Both must be valid. */
function compareSemver(a, b) {
  const parse = (v) => {
    const m = SEMVER.exec(v);
    if (!m) throw new Error(`Not a version: ${v}`);
    return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [] };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i];
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * A release asset of RELEASE_REPO: https://github.com/<repo>/releases/download/<tag>/<file> or
 * .../releases/latest/download/<file>. Returns {tag, file} (tag null for latest) or null. No query, port or userinfo.
 */
function releaseAsset(input) {
  if (typeof input !== 'string' || input.length > 512) return null;
  let u;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password || u.search || u.hash) return null;
  const parts = u.pathname.split('/');
  const [owner, repo] = RELEASE_REPO.toLowerCase().split('/');
  if (parts[1]?.toLowerCase() !== owner || parts[2]?.toLowerCase() !== repo || parts[3] !== 'releases') return null;
  const ok = (seg) => !!seg && SEGMENT.test(seg) && seg !== '.' && seg !== '..';
  if (parts.length === 7 && parts[4] === 'download' && ok(parts[5]) && ok(parts[6])) return { tag: parts[5], file: parts[6] };
  if (parts.length === 7 && parts[4] === 'latest' && parts[5] === 'download' && ok(parts[6])) return { tag: null, file: parts[6] };
  return null;
}

/** The release page https://github.com/<repo>/releases/tag/<tag> (where desktop players download the app). */
function releasePage(input) {
  if (typeof input !== 'string' || input.length > 512) return false;
  let u;
  try {
    u = new URL(input);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password || u.search || u.hash) return false;
  const parts = u.pathname.split('/');
  const [owner, repo] = RELEASE_REPO.toLowerCase().split('/');
  return parts.length === 6 && parts[1]?.toLowerCase() === owner && parts[2]?.toLowerCase() === repo && parts[3] === 'releases' && parts[4] === 'tag' && !!parts[5] && SEGMENT.test(parts[5]) && parts[5] !== '..';
}

/** A release's download folder: .../releases/download/<tag> or .../releases/latest/download (a Squirrel.Windows feed). */
function releaseFolder(input) {
  if (typeof input !== 'string' || input.length > 512) return false;
  let u;
  try {
    u = new URL(input);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password || u.search || u.hash) return false;
  const parts = u.pathname.split('/');
  const [owner, repo] = RELEASE_REPO.toLowerCase().split('/');
  if (parts.length !== 6 || parts[1]?.toLowerCase() !== owner || parts[2]?.toLowerCase() !== repo || parts[3] !== 'releases') return false;
  if (parts[4] === 'latest') return parts[5] === 'download';
  return parts[4] === 'download' && !!parts[5] && SEGMENT.test(parts[5]) && parts[5] !== '..';
}

/** The stable macOS feed: .../releases/latest/download/RELEASES-darwin-<arm64|x64>.json, nothing else under latest. */
function isMacLatestFeed(input) {
  const a = releaseAsset(input);
  return !!a && a.tag === null && /^RELEASES-darwin-(arm64|x64)\.json$/.test(a.file);
}

/** update.fetch: a release asset, or the releases listing used to find the newest pre-release. */
const isUpdateFetchUrl = (url) => url === RELEASES_API || releaseAsset(url) !== null;

/** A redirect GitHub may send a release download to (https, its asset hosts only). */
function isAssetRedirect(input) {
  try {
    const u = new URL(input);
    return u.protocol === 'https:' && ASSET_REDIRECT_HOSTS.includes(u.hostname) && !u.port && !u.username && !u.password;
  } catch {
    return false;
  }
}
const isMethod = (method) => typeof method === 'string' && METHODS.includes(method);
const isDeviceToken = (token) => typeof token === 'string' && DEVICE_TOKEN.test(token);

/**
 * An Empire server origin: https, or http only on this computer's loopback (a server the user runs here, or the
 * bundled "This computer" host). No path, query, fragment, credentials or bad port. Returns the origin or null.
 */
function serverOrigin(input) {
  if (typeof input !== 'string' || input.length > 300 || input.includes('\\')) return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  if (!url.hostname || /[^a-z0-9.[\]:-]/i.test(url.hostname)) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url.origin;
  return null;
}

/**
 * What may be stored under each key. Returns null when acceptable, else the message for the page.
 * `trusted` is set only by the main process itself (never for a page request): it alone may store mode=local.
 */
function invalidValue(key, value, { trusted = false } = {}) {
  if (!isKey(key)) return 'Key not allowed.';
  if (typeof value !== 'string' || !value || value.length > MAX_VALUE_LENGTH) return 'That value can’t be stored.';
  switch (key) {
    case 'mode':
      if (value === 'local' && !trusted) return 'Running on this computer starts only from the app’s own confirmation.';
      return MODES.includes(value) ? null : 'Unknown mode.';
    case 'server.host':
      return serverOrigin(value) === value ? null : 'That server address isn’t allowed in this app.';
    case 'server.token':
      return isDeviceToken(value) ? null : 'Malformed device token.';
    case 'server.deviceId':
      return DEVICE_ID.test(value) ? null : 'Malformed device id.';
    case 'github.token':
      return value.length <= 512 && !/\s/.test(value) ? null : 'Malformed GitHub token.';
    case 'github.login':
      return GITHUB_LOGIN.test(value) ? null : 'Malformed GitHub login.';
    case 'state.repo':
      return STATE_REPO.test(value) ? null : 'Malformed repository name.';
    default:
      return 'Key not allowed.';
  }
}

/** GitHub scopes joined for the device-code request, de-duplicated in order; null unless all are allowed. */
function scopes(list) {
  if (!Array.isArray(list) || !list.length || list.length > 10) return null;
  const seen = [];
  for (const scope of list) {
    if (typeof scope !== 'string' || !GITHUB_SCOPES.includes(scope)) return null;
    if (!seen.includes(scope)) seen.push(scope);
  }
  return seen.join(' ');
}

const isClientId = (id) => typeof id === 'string' && CLIENT_ID.test(id);

/** app.openExternal: a plain https URL with a host and no credentials, not the app's own origin; else null. */
function externalUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  return url.href;
}

/** The verification page GitHub returned must be on GitHub's web origin. */
function isVerificationUrl(input, githubOrigin = 'https://github.com') {
  try {
    const url = new URL(input);
    return url.origin === githubOrigin && !url.username && !url.password;
  } catch {
    return false;
  }
}

const gestureAllows = (lastGestureAt, now) => lastGestureAt > 0 && now >= lastGestureAt && now - lastGestureAt <= GESTURE_WINDOW_MS;

/** True only for the bundled game's main document. */
function isAppUrl(url) {
  try {
    // Node gives custom schemes an opaque origin ("null"), so compare scheme and host instead.
    const u = new URL(url);
    return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
}

/**
 * Whether the app resumes "This computer" at launch or reload. Decided only from connection.json (main-process
 * settings the page can't write), never from the page-writable secure store, so a page can't start the local
 * server without the confirmation.
 */
const shouldResumeLocal = (connection) =>
  !!connection && connection.runMode === 'local' && typeof connection.localProject === 'string' && connection.localProject.length > 0;

/**
 * Validates a page request {id, method, params}. Returns {id, method, params} with checked params, or throws an
 * Error whose message goes back to the page. A request without a usable id can't be answered and is dropped (null).
 */
function parseRequest(raw) {
  if (!raw || typeof raw !== 'object' || !ID.test(String(raw.id ?? ''))) return null;
  const id = String(raw.id);
  const fail = (message) => ({ id, error: message });
  if (!isMethod(raw.method)) return fail('Unknown method.');
  const p = raw.params && typeof raw.params === 'object' ? raw.params : {};
  switch (raw.method) {
    case 'secure.get':
    case 'secure.delete':
      return isKey(p.key) ? { id, method: raw.method, params: { key: p.key } } : fail('Key not allowed.');
    case 'secure.set': {
      const problem = invalidValue(p.key, p.value);
      return problem ? fail(problem) : { id, method: raw.method, params: { key: p.key, value: p.value } };
    }
    case 'github.deviceFlow': {
      const scope = scopes(p.scopes);
      if (!isClientId(p.clientId)) return fail('invalid_request: GitHub sign-in is not configured in this build.');
      if (!scope) return fail('invalid_request: Unsupported GitHub permissions requested.');
      return { id, method: raw.method, params: { clientId: p.clientId, scope } };
    }
    case 'app.signedOut':
      return { id, method: raw.method, params: { reason: SIGN_OUT_REASONS.includes(p.reason) ? p.reason : 'unauthorized' } };
    case 'app.runLocal':
      return { id, method: raw.method, params: {} };
    case 'app.openExternal': {
      const url = externalUrl(p.url);
      return url ? { id, method: raw.method, params: { url } } : fail('Only https links can be opened.');
    }
    case 'update.fetch': {
      if (typeof p.url !== 'string' || !isUpdateFetchUrl(p.url)) return fail('That address is not an Agent Empire release.');
      const etag = typeof p.etag === 'string' && p.etag.length <= 200 && /^[\x21-\x7e]+$/.test(p.etag) ? p.etag : undefined;
      return { id, method: raw.method, params: etag ? { url: p.url, etag } : { url: p.url } };
    }
    case 'update.installGame': {
      const a = releaseAsset(p.url);
      if (!a || a.tag === null) return fail('That update is not an Agent Empire release.');
      if (!isSha256(p.sha256)) return fail('Malformed sha256.');
      if (!isSemver(p.version)) return fail('Malformed version.');
      return { id, method: raw.method, params: { url: p.url, sha256: p.sha256, version: p.version } };
    }
    case 'update.activate':
    case 'update.bootOk':
    case 'update.nativeInfo':
      return { id, method: raw.method, params: {} };
    case 'update.openNative': {
      if (!isSemver(p.version)) return fail('Malformed version.');
      const out = { version: p.version };
      if (p.url !== undefined) {
        const a = releaseAsset(p.url);
        if (!releasePage(p.url) && (!a || a.tag === null)) return fail('That download is not an Agent Empire release.');
        out.url = p.url;
      }
      if (p.feed !== undefined) {
        const a = releaseAsset(p.feed);
        if (!releaseFolder(p.feed) && !isMacLatestFeed(p.feed) && (!a || a.tag === null)) return fail('That update feed is not an Agent Empire release.');
        out.feed = p.feed;
      }
      if (!out.url && !out.feed) return fail('Nothing to open.');
      return { id, method: raw.method, params: out };
    }
  }
  return fail('Unknown method.');
}

/**
 * window.AGENT_EMPIRE_APP for the page: platform, device name, the stored mode, a server session only in server
 * mode when host and token are valid, and a one-shot sign-out reason. Same rules as Android configFields.
 */
function configFor({ deviceName, mode, host, token, deviceId, signedOut, local, localAvailable }) {
  const out = { platform: 'desktop' };
  const name = typeof deviceName === 'string' ? deviceName.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim() : '';
  out.deviceName = name ? name.slice(0, 64) : 'Desktop app';
  if (MODES.includes(mode)) out.mode = mode;
  const origin = serverOrigin(host);
  // A session only for a server: a remote one (server), or the bundled one on loopback http (local).
  if ((mode === 'server' || (mode === 'local' && origin && origin.startsWith('http://'))) && origin && origin === host && isDeviceToken(token)) {
    out.host = origin;
    out.token = token;
    if (typeof deviceId === 'string' && DEVICE_ID.test(deviceId)) out.deviceId = deviceId;
  }
  if (SIGN_OUT_REASONS.includes(signedOut)) out.signedOut = signedOut;
  if (local === true && out.host) out.local = true;
  if (localAvailable === true) out.localAvailable = true;
  return out;
}

module.exports = {
  APP_SCHEME, APP_HOST, APP_ORIGIN, METHODS, MODES, PAGE_MODES, KEYS, SESSION_KEYS, GITHUB_SCOPES, SIGN_OUT_REASONS, MAX_VALUE_LENGTH, GESTURE_WINDOW_MS,
  isKey, isMethod, isDeviceToken, isClientId, serverOrigin, invalidValue, scopes, externalUrl, isVerificationUrl, gestureAllows, isAppUrl,
  parseRequest, configFor, shouldResumeLocal,
  RELEASE_REPO, RELEASES_API, ASSET_REDIRECT_HOSTS, isSemver, isSha256, compareSemver, releaseAsset, releasePage, releaseFolder, isMacLatestFeed, isUpdateFetchUrl, isAssetRedirect,
};
