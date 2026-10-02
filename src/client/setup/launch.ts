/**
 * What the page does at launch: go straight into the Empire, or run the first-launch setup.
 *
 * App shells (iOS, Android, desktop) remember the chosen mode in secure storage. A plain browser page that an
 * Agent Empire server served (cookie session) is already "my own server"; a static copy of the game with no
 * server behind it runs the setup like an app, remembering only non-secret choices in localStorage.
 */
import { normaliseHost } from '../endpoint';
import type { ShellInfo, SignedOutReason } from '../native';
import type { Mode } from './model';

export type LaunchDecision =
  | { kind: 'game' }
  | { kind: 'setup'; step: 'welcome' | 'server'; mode?: Mode; notice?: string; address?: string }
  | { kind: 'cloud'; repo?: string }
  | { kind: 'redirect'; url: string };

export type ServerProbe = 'signed-in' | 'signed-out' | 'none';

export interface LaunchEnv {
  shell: ShellInfo | null;
  /** An injected, valid device session (endpoint.appConfig()). */
  hasSession: boolean;
  get(key: 'mode' | 'server.host' | 'state.repo'): Promise<string | null>;
  /** Web only: does the page's own origin run an Agent Empire server, and is this browser signed in to it? */
  probe(): Promise<ServerProbe>;
  origin: string;
}

export const SIGNED_OUT_NOTICE: Record<SignedOutReason, string> = {
  user: 'Signed out. This device’s sign-in was removed.',
  revoked: 'This device was signed out from the Empire. Sign in again to continue.',
  unauthorized: 'Your sign-in is no longer valid. Sign in again to continue.',
};

const asMode = (v: string | null | undefined): Mode | undefined => (v === 'cloud' || v === 'server' ? v : undefined);
const asAppMode = (v: string | null | undefined, desktop: boolean): Mode | 'local' | undefined => (v === 'local' && desktop ? 'local' : asMode(v));
const safe = async (p: Promise<string | null>) => {
  try {
    return await p;
  } catch {
    return null;
  }
};

export async function decideLaunch(env: LaunchEnv): Promise<LaunchDecision> {
  if (env.shell) {
    const desktop = env.shell.platform === 'desktop';
    const mode = env.shell.mode ?? asAppMode(await safe(env.get('mode')), desktop);
    // Desktop "Run on this computer": the shell signs in to its own loopback server, so it is server mode with a session.
    if ((mode === 'server' || mode === 'local') && env.hasSession) return { kind: 'game' };
    if (mode === 'local') return { kind: 'setup', step: 'welcome' }; // the local server did not start: choose again
    if (mode === 'server') {
      const address = normaliseHost(await safe(env.get('server.host')));
      const notice = env.shell.signedOut ? SIGNED_OUT_NOTICE[env.shell.signedOut] : undefined;
      return { kind: 'setup', step: 'server', mode, notice, address };
    }
    if (mode === 'cloud') return { kind: 'cloud', repo: (await safe(env.get('state.repo'))) ?? undefined };
    return { kind: 'setup', step: 'welcome' };
  }

  const probe = await env.probe().catch((): ServerProbe => 'none');
  if (probe === 'signed-in') return { kind: 'game' };
  if (probe === 'signed-out') return { kind: 'redirect', url: '/login' };
  const mode = asMode(await safe(env.get('mode')));
  if (mode === 'cloud') return { kind: 'cloud', repo: (await safe(env.get('state.repo'))) ?? undefined };
  // Stored by this page, but localStorage is writable by anything on the origin: only a bare http(s) origin
  // (no path, credentials or javascript: URL) is ever navigated to.
  const host = normaliseHost(await safe(env.get('server.host')));
  if (mode === 'server' && host && host !== env.origin) return { kind: 'redirect', url: `${host}/` };
  return { kind: 'setup', step: 'welcome' };
}

/** Same-origin probe used by the web build. */
export async function probeOwnOrigin(fetchImpl: typeof fetch = fetch): Promise<ServerProbe> {
  try {
    const res = await fetchImpl('/api/whoami', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
    if (res.status === 401) return 'signed-out';
    if (!res.ok) return 'none';
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true ? 'signed-in' : 'none';
  } catch {
    return 'none';
  }
}
