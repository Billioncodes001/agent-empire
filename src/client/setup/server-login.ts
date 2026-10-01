/**
 * "Connect my own server": address → reachability probe → POST /api/device/login (APP-01) → a device session.
 * No cookies, no cache, and redirects are refused, so a password never goes to another host.
 */
import { normaliseHost } from '../endpoint';

export type LoginError =
  | 'empty_host' | 'bad_host' | 'has_path' | 'https_required' | 'empty_password'
  | 'unreachable' | 'not_empire' | 'wrong_password' | 'rate_limited' | 'too_many_devices' | 'server' | 'bad_response';

export const LOGIN_MESSAGES: Record<LoginError, string> = {
  empty_host: 'Enter your Empire server address.',
  bad_host: 'That doesn’t look like a server address.',
  has_path: 'Enter only the server address, without a path, query or password.',
  https_required: 'The server must use HTTPS. Only this device’s own address (localhost) may use http.',
  empty_password: 'Enter the office password.',
  unreachable: 'Can’t reach that server. Check the address, your connection, and that its HTTPS certificate is valid.',
  not_empire: 'That server didn’t answer like an Agent Empire server. Check the address and that it runs a current version.',
  wrong_password: 'Wrong password.',
  rate_limited: 'Too many sign-in attempts. Wait a few minutes and try again.',
  too_many_devices: 'This Empire has too many signed-in devices. Remove one in Settings on another device, then try again.',
  server: 'The server couldn’t sign you in. Try again shortly.',
  bad_response: 'The server sent an unexpected answer. Check that it runs a current Agent Empire version.',
};

export class LoginFailure extends Error {
  constructor(readonly code: LoginError, readonly status?: number) {
    super(status && code === 'server' ? `${LOGIN_MESSAGES.server} (error ${status})` : LOGIN_MESSAGES[code]);
    this.name = 'LoginFailure';
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * "city.example.com" means https. Plain http is accepted only for this device's loopback address, and in the Android
 * app also for 10.0.2.2, the emulator's alias for the host computer's loopback. The shell stays the authority: a
 * release Android build refuses cleartext and won't store that address, a debug build allows it for local testing.
 */
export function parseServerAddress(input: string, opts: { androidEmulator?: boolean } = {}): { ok: true; host: string } | { ok: false; error: LoginError } {
  let text = input.trim();
  if (!text) return { ok: false, error: 'empty_host' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'bad_host' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'bad_host' };
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return { ok: false, error: 'has_path' };
  if (!url.hostname || !/^[a-z0-9.[\]:-]+$/i.test(url.hostname)) return { ok: false, error: 'bad_host' };
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname) && !(opts.androidEmulator && url.hostname === '10.0.2.2')) return { ok: false, error: 'https_required' };
  const host = normaliseHost(url.origin);
  return host ? { ok: true, host } : { ok: false, error: 'bad_host' };
}

export interface ServerSession {
  host: string;
  token: string;
  deviceId: string;
}

const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NO_COOKIES: RequestInit = { credentials: 'omit', cache: 'no-store', redirect: 'error', mode: 'cors' };

async function send(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetchImpl(url, { ...NO_COOKIES, ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new LoginFailure('unreachable');
  }
}

/** Probes GET /api/health, then signs this device in. Throws LoginFailure with a plain message. */
export async function signInToServer(
  opts: { host: string; password: string; deviceName: string; androidEmulator?: boolean },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<ServerSession> {
  const parsed = parseServerAddress(opts.host, { androidEmulator: opts.androidEmulator });
  if (!parsed.ok) throw new LoginFailure(parsed.error);
  if (!opts.password) throw new LoginFailure('empty_password');
  const host = parsed.host;

  const health = await send(fetchImpl, `${host}/api/health`, { headers: { Accept: 'application/json' } }, timeoutMs);
  const ok = health.status === 200 && (await health.json().catch(() => null))?.ok === true;
  if (!ok) throw new LoginFailure('not_empire');

  const res = await send(
    fetchImpl,
    `${host}/api/device/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password: opts.password, deviceName: opts.deviceName.slice(0, 64) || 'Device' }),
    },
    timeoutMs,
  );
  if (res.status === 401) throw new LoginFailure('wrong_password');
  if (res.status === 429) throw new LoginFailure('rate_limited');
  if (res.status === 409) throw new LoginFailure('too_many_devices');
  if (res.status !== 200) throw new LoginFailure('server', res.status);
  const body = (await res.json().catch(() => null)) as { token?: unknown; deviceId?: unknown } | null;
  if (!body || typeof body.token !== 'string' || !TOKEN.test(body.token) || typeof body.deviceId !== 'string' || !DEVICE_ID.test(body.deviceId))
    throw new LoginFailure('bad_response');
  return { host, token: body.token, deviceId: body.deviceId };
}

/** Best effort: a token the app could not store securely is revoked so it doesn't linger as an orphan device. */
export async function revokeDevice(session: ServerSession, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${session.host}/api/devices/${encodeURIComponent(session.deviceId)}`, {
      ...NO_COOKIES,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.token}` },
      signal: AbortSignal.timeout(6000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** A readable device name for the server's device list; the shell may inject a better one. */
export function defaultDeviceName(platform: string | null, ua: string): string {
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua) || platform === 'ios') return 'iPhone';
  if (/Android/.test(ua) || platform === 'android') return 'Android device';
  if (platform === 'desktop') return 'Desktop app';
  return 'Browser';
}
