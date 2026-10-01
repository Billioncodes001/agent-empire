/**
 * Pure rules for the desktop native bridge (docs/team/CLOUD_MODE_PLAN.md, "Native bridge contract").
 * No Electron types, so tests/desktop-bridge.test.ts covers every rule. main.cjs enforces these on every call.
 * Same rules as Android BridgePolicy.java and iOS BridgeProtocol.swift.
 */
const APP_SCHEME = 'empire-app';
const APP_HOST = 'game';
/** The bundled game's origin. The server already allows it (src/server/server.ts APP_ORIGINS, shared with iOS). */
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const METHODS = Object.freeze(['secure.get', 'secure.set', 'secure.delete', 'github.deviceFlow', 'app.signedOut', 'app.openExternal', 'app.runLocal']);
/** Stored modes. 'local' is desktop-only: the bundled server on this computer ("Run on this computer"). */
const MODES = Object.freeze(['cloud', 'server', 'local']);
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

const isKey = (key) => typeof key === 'string' && KEYS.includes(key);
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

/** What may be stored under each key. Returns null when acceptable, else the message for the page. */
function invalidValue(key, value) {
  if (!isKey(key)) return 'Key not allowed.';
  if (typeof value !== 'string' || !value || value.length > MAX_VALUE_LENGTH) return 'That value can’t be stored.';
  switch (key) {
    case 'mode':
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
  APP_SCHEME, APP_HOST, APP_ORIGIN, METHODS, MODES, KEYS, SESSION_KEYS, GITHUB_SCOPES, SIGN_OUT_REASONS, MAX_VALUE_LENGTH, GESTURE_WINDOW_MS,
  isKey, isMethod, isDeviceToken, isClientId, serverOrigin, invalidValue, scopes, externalUrl, isVerificationUrl, gestureAllows, isAppUrl,
  parseRequest, configFor,
};
