/**
 * The one place that knows where the office host is and how to authenticate to it.
 *
 * Web (no app config): everything is same-origin and cookie-authenticated, exactly as before. API paths stay
 * relative, the WebSocket goes to this page's host, and no credentials are added.
 *
 * Bundled app: the native shell injects `window.AGENT_EMPIRE_APP = {host, token, platform, deviceId?}` before any
 * page script runs (never via the query string). The game itself is served from the app bundle; only API and
 * WebSocket traffic goes to `host`, with `Authorization: Bearer <token>` on HTTP and the subprotocols
 * `["empire.v1", "bearer.<token>"]` on the socket. Native calls (sign-out, secure storage) go through the one bridge in
 * native.ts. The first-launch setup (setup/) can adopt a session it just signed in with via `setSessionConfig`.
 */
import { native, PLATFORMS, resetNativeForTests, type AppPlatform, type SignedOutReason } from './native';

export type { AppPlatform, SignedOutReason };

export interface AppConfig {
  /** Office origin, e.g. https://city.example.com (no path, no credentials). */
  host: string;
  /** Device token from POST /api/device/login. */
  token: string;
  platform: AppPlatform;
  /** This device's id from POST /api/device/login, used to revoke itself on sign-out. */
  deviceId?: string;
}

/** The WebSocket subprotocol the server speaks (see WS_PROTOCOL in src/server/server.ts). */
export const WS_PROTOCOL = 'empire.v1';
/** Close code the server uses when a device token is revoked. */
export const WS_REVOKED = 4401;

const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Normalises an http(s) origin, or returns undefined for anything with a path, query, credentials or another scheme. */
export function normaliseHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return undefined;
  return url.origin;
}

/** Validates an injected app config. Anything malformed means "not an app", so the web behaviour is kept. */
export function parseAppConfig(raw: unknown): AppConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const host = normaliseHost(r.host);
  if (!host || typeof r.token !== 'string' || !TOKEN.test(r.token)) return null;
  if (!PLATFORMS.includes(r.platform as AppPlatform)) return null;
  const cfg: AppConfig = { host, token: r.token, platform: r.platform as AppPlatform };
  if (typeof r.deviceId === 'string' && DEVICE_ID.test(r.deviceId)) cfg.deviceId = r.deviceId;
  return cfg;
}

const hasWindow = () => typeof window !== 'undefined';

let cached: AppConfig | null | undefined;

/** The injected app config, read once. Null in a normal browser. */
export function appConfig(): AppConfig | null {
  if (cached === undefined) cached = hasWindow() ? parseAppConfig((window as { AGENT_EMPIRE_APP?: unknown }).AGENT_EMPIRE_APP) : null;
  return cached;
}

/** Tests only: forget the cached config (and the sign-out latch) so another one can be read. */
export function resetEndpointForTests(config?: AppConfig | null) {
  cached = config;
  signedOutSent = false;
  userSigningOut = false;
  resetNativeForTests();
}

/** The setup flow signed in and stored a device session: use it from now on, without reloading the page. */
export function setSessionConfig(config: AppConfig) {
  const parsed = parseAppConfig(config);
  if (!parsed) throw new Error('Invalid session');
  cached = parsed;
  signedOutSent = false;
  userSigningOut = false;
}

export const isAppMode = () => appConfig() !== null;

/**
 * Where the office host lives. In a browser this is the page's own origin. The bundled app uses its injected host;
 * a page can also be pointed elsewhere with <meta name="agent-empire-host"> or window.AGENT_EMPIRE_HOST.
 */
export function hostBase(): string {
  const app = appConfig();
  if (app) return app.host;
  const configured =
    (window as unknown as { AGENT_EMPIRE_HOST?: string }).AGENT_EMPIRE_HOST ??
    document.querySelector<HTMLMetaElement>('meta[name="agent-empire-host"]')?.content;
  return configured?.trim() || location.origin;
}

/** An absolute URL on the office host for an API path or page such as '/api/logout' or '/login'. */
export function hostUrl(path: string): string {
  return new URL(path, hostBase()).href;
}

/** URL for an API path. Relative (unchanged) on the web; absolute on the office host in the app. */
export function apiUrl(path: string): string {
  const app = appConfig();
  return app ? new URL(path, app.host).href : path;
}

/**
 * The request init for an API call. On the web it is returned untouched. In the app it drops cookies (the server
 * never allows credentialed CORS) and adds the bearer token, keeping any other headers the caller set.
 */
export function apiInit(init: RequestInit = {}): RequestInit {
  const app = appConfig();
  if (!app) return init;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${app.token}`);
  return { ...init, headers, credentials: 'omit', mode: 'cors' };
}

/**
 * fetch() for office API paths. In the app, a 401 means the device token is no longer valid: the native shell is
 * told once so it can clear its stored token and return to its sign-in screen. The response is still returned.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!isAppMode()) return fetch(path, init);
  const res = await fetch(apiUrl(path), apiInit(init));
  if (res.status === 401) notifySignedOut('unauthorized');
  return res;
}

/** The office WebSocket URL for the given query (player profile only, never credentials). */
export function wsUrl(query: string): string {
  const app = appConfig();
  const base = app ? new URL(app.host) : new URL(location.href);
  const proto = base.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${base.host}/ws${query ? `?${query}` : ''}`;
}

/** Subprotocols to offer: none on the web (cookie auth), the protocol plus the bearer entry in the app. */
export function wsProtocols(): string[] | undefined {
  const app = appConfig();
  return app ? [WS_PROTOCOL, `bearer.${app.token}`] : undefined;
}

let signedOutSent = false;
/** Set when the player chose Sign out: revoking the device closes our own socket (4401), which is not a surprise. */
let userSigningOut = false;

/**
 * Tells the native shell this device is signed out (user choice, token revoked, or rejected). Sent at most once per
 * page. Returns false outside the app, where callers keep the web behaviour (the /login page).
 */
export function notifySignedOut(reason: SignedOutReason): boolean {
  if (!isAppMode()) return false;
  if (signedOutSent) return true;
  signedOutSent = true;
  // The shell clears its session keys and returns to the setup's sign-in step; nothing more to do if it can't answer.
  native().signedOut(userSigningOut ? 'user' : reason).catch(() => {});
  return true;
}

/** The player chose Sign out: whatever ends the session next (the revoke's own 4401 or 401) is reported as 'user'. */
export function beginUserSignOut() {
  userSigningOut = true;
}

/** Tests only. */
export const signedOutNotified = () => signedOutSent;
