/**
 * Page side of the native bridge contract (docs/team/CLOUD_MODE_PLAN.md, "Native bridge contract").
 *
 * A shell announces itself with `window.AGENT_EMPIRE_APP.platform` before any page script runs. Calls are
 * asynchronous request/response messages `{id, method, params}`; the shell answers with
 * `window.__empireNative.resolve(id, result)` or `window.__empireNative.reject(id, message)`.
 *
 * Transports (exactly one per shell; nothing else is used):
 *   iOS      window.webkit.messageHandlers.empire.postMessage(request)       (structured object)
 *   Android  window.empireAndroid.postMessage(JSON.stringify(request))        (one @JavascriptInterface, bundled origin only)
 *   desktop  window.empireDesktop.postMessage(request)                        (Electron contextBridge)
 *
 * In a plain browser there is no shell: `webNative` keeps the non-secret keys in localStorage, refuses to store
 * secrets, and cannot run the GitHub device flow (GitHub's token endpoints send no CORS headers).
 */

export type AppPlatform = 'ios' | 'android' | 'desktop';
export const PLATFORMS: readonly AppPlatform[] = ['ios', 'android', 'desktop'];

/** The only keys a shell stores. Provider API keys are never among them. */
export const SECURE_KEYS = ['mode', 'server.host', 'server.token', 'server.deviceId', 'github.token', 'github.login', 'state.repo'] as const;
export type SecureKey = (typeof SECURE_KEYS)[number];
/** Keys that hold credentials: a browser without a shell never persists these. */
export const SECRET_KEYS: ReadonlySet<SecureKey> = new Set(['server.token', 'github.token']);

export type BridgeMethod =
  | 'secure.get' | 'secure.set' | 'secure.delete' | 'github.deviceFlow' | 'app.signedOut' | 'app.openExternal' | 'app.runLocal'
  // In-app updates (docs/team/RELEASE_PLAN.md, REL-04); typed wrappers in src/client/update/bridge.ts.
  | 'update.fetch' | 'update.installGame' | 'update.activate' | 'update.bootOk' | 'update.nativeInfo' | 'update.openNative';
export interface BridgeRequest {
  id: string;
  method: BridgeMethod;
  params: Record<string, unknown>;
}

export type BridgeErrorCode = 'unavailable' | 'timeout' | 'rejected' | 'invalid';
export class BridgeError extends Error {
  constructor(message: string, readonly code: BridgeErrorCode) {
    super(message);
    this.name = 'BridgeError';
  }
}

export type SignedOutReason = 'user' | 'revoked' | 'unauthorized';
export interface DeviceFlowResult {
  token: string;
  /** Informational: a shell may answer null when GitHub's /user call failed; the page reads the login itself. */
  login: string | null;
}

/** Desktop only: the Empire running on this computer, signed in to its bundled loopback server. */
export interface LocalSession {
  mode: 'local';
  host: string;
  token: string;
  deviceId: string;
}

/** The typed API the setup flow and the game use. */
export interface Native {
  /** The shell's platform, or null in a plain browser. */
  readonly platform: AppPlatform | null;
  /** True when a shell transport exists (secure storage and the device flow are real). */
  readonly available: boolean;
  secureGet(key: SecureKey): Promise<string | null>;
  secureSet(key: SecureKey, value: string): Promise<void>;
  secureDelete(key: SecureKey): Promise<void>;
  githubDeviceFlow(opts: { clientId: string; scopes: string[] }): Promise<DeviceFlowResult>;
  signedOut(reason: SignedOutReason): Promise<void>;
  openExternal(url: string): Promise<void>;
  /**
   * Desktop only: the shell confirms with a native dialog, starts its bundled server on loopback, signs in and stores
   * mode=local. Takes no parameters from the page. Rejects with a message starting `cancelled:` when the player says no.
   */
  runLocal(): Promise<LocalSession>;
}

type Win = Record<string, unknown>;
interface Transport {
  post(request: BridgeRequest): void;
}

/** Default timeouts. The device flow waits for the player on GitHub, whose device codes last 15 minutes. */
export const TIMEOUTS = { default: 15_000, deviceFlow: 16 * 60_000, runLocal: 10 * 60_000, update: 10 * 60_000 } as const;
const MAX_VALUE = 8192;
const GITHUB_SCOPES = new Set(['repo', 'workflow', 'read:user']);
const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

const isKey = (k: unknown): k is SecureKey => SECURE_KEYS.includes(k as SecureKey);

/** Injected shell info, read without requiring a signed-in session. */
export interface ShellInfo {
  platform: AppPlatform;
  /** `local` (the Empire runs on this computer) exists on desktop only. */
  mode?: 'cloud' | 'server' | 'local';
  /** Desktop only: this computer can run the Empire itself (app.runLocal). */
  localAvailable?: boolean;
  deviceName?: string;
  signedOut?: SignedOutReason;
}

export function parseShellInfo(raw: unknown): ShellInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!PLATFORMS.includes(r.platform as AppPlatform)) return null;
  const info: ShellInfo = { platform: r.platform as AppPlatform };
  if (r.mode === 'cloud' || r.mode === 'server' || (r.mode === 'local' && info.platform === 'desktop')) info.mode = r.mode;
  if (r.localAvailable === true && info.platform === 'desktop') info.localAvailable = true;
  if (typeof r.deviceName === 'string' && r.deviceName.trim()) info.deviceName = r.deviceName.trim().slice(0, 64);
  if (r.signedOut === 'user' || r.signedOut === 'revoked' || r.signedOut === 'unauthorized') info.signedOut = r.signedOut;
  return info;
}

function findTransport(w: Win, platform: AppPlatform | null): Transport | undefined {
  if (!platform) return undefined;
  if (platform === 'ios') {
    const handler = (w.webkit as { messageHandlers?: { empire?: { postMessage(m: unknown): void } } } | undefined)?.messageHandlers?.empire;
    return handler ? { post: (r) => handler.postMessage(r) } : undefined;
  }
  if (platform === 'android') {
    const android = w.empireAndroid as { postMessage?(json: string): void } | undefined;
    return typeof android?.postMessage === 'function' ? { post: (r) => android.postMessage!(JSON.stringify(r)) } : undefined;
  }
  const desktop = w.empireDesktop as { postMessage?(m: unknown): void } | undefined;
  return typeof desktop?.postMessage === 'function' ? { post: (r) => desktop.postMessage!(r) } : undefined;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Request/response over one shell transport, with ids, timeouts and a single receiver on window. */
export class NativeBridge implements Native {
  readonly platform: AppPlatform | null;
  readonly available: boolean;
  private readonly transport?: Transport;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(private readonly win: Win) {
    this.platform = parseShellInfo(win.AGENT_EMPIRE_APP)?.platform ?? null;
    this.transport = findTransport(win, this.platform);
    this.available = !!this.transport;
    if (this.transport) this.installReceiver();
  }

  private installReceiver() {
    const receiver = {
      resolve: (id: unknown, result: unknown) => this.settle(id, (p) => p.resolve(result)),
      reject: (id: unknown, message: unknown) =>
        this.settle(id, (p) => p.reject(new BridgeError(typeof message === 'string' && message ? message.slice(0, 500) : 'The app refused the request.', 'rejected'))),
    };
    try {
      Object.defineProperty(this.win, '__empireNative', { value: Object.freeze(receiver), configurable: true, enumerable: false, writable: false });
    } catch {
      this.win.__empireNative = receiver;
    }
  }

  private settle(id: unknown, fn: (p: Pending) => void) {
    if (typeof id !== 'string') return;
    const p = this.pending.get(id);
    if (!p) return; // unknown or already timed out
    this.pending.delete(id);
    clearTimeout(p.timer);
    fn(p);
  }

  /** Sends one request and waits for its answer. Rejects with BridgeError('unavailable' | 'timeout' | 'rejected'). */
  call<T = unknown>(method: BridgeMethod, params: Record<string, unknown> = {}, timeoutMs: number = TIMEOUTS.default): Promise<T> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new BridgeError('This feature needs the Agent Empire app.', 'unavailable'));
    const id = `${Date.now().toString(36)}-${++this.seq}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new BridgeError('The app did not answer in time.', 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        transport.post({ id, method, params });
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new BridgeError('The app could not be reached.', 'unavailable'));
      }
    });
  }

  /** Requests still waiting for an answer (tests). */
  get inFlight() {
    return this.pending.size;
  }

  async secureGet(key: SecureKey) {
    assertKey(key);
    const v = await this.call('secure.get', { key });
    return typeof v === 'string' ? v : null;
  }
  async secureSet(key: SecureKey, value: string) {
    assertKey(key);
    assertValue(value);
    await this.call('secure.set', { key, value });
  }
  async secureDelete(key: SecureKey) {
    assertKey(key);
    await this.call('secure.delete', { key });
  }
  async githubDeviceFlow(opts: { clientId: string; scopes: string[] }) {
    const { clientId, scopes } = checkDeviceFlow(opts);
    const r = await this.call<{ token?: unknown; login?: unknown }>('github.deviceFlow', { clientId, scopes }, TIMEOUTS.deviceFlow);
    if (!r || typeof r.token !== 'string' || !r.token || (r.login != null && typeof r.login !== 'string'))
      throw new BridgeError('GitHub sign-in returned an unexpected answer.', 'invalid');
    return { token: r.token, login: typeof r.login === 'string' && r.login ? r.login : null };
  }
  async signedOut(reason: SignedOutReason) {
    await this.call('app.signedOut', { reason });
  }
  async openExternal(url: string) {
    await this.call('app.openExternal', { url: checkExternal(url) });
  }
  async runLocal(): Promise<LocalSession> {
    if (this.platform !== 'desktop') throw new BridgeError('Running on this computer needs the desktop app.', 'unavailable');
    // The player reads a native dialog (and may pick a folder) before this answers, so the timeout is long.
    const r = await this.call<Record<string, unknown> | null>('app.runLocal', {}, TIMEOUTS.runLocal);
    if (!r || r.mode !== 'local' || typeof r.host !== 'string' || typeof r.token !== 'string' || typeof r.deviceId !== 'string' || !r.token || !r.deviceId)
      throw new BridgeError('The desktop app returned an unexpected answer.', 'invalid');
    let loopback = false;
    try {
      const u = new URL(r.host);
      loopback = (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password && (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash;
    } catch {}
    if (!loopback) throw new BridgeError('The desktop app returned a server that is not on this computer.', 'invalid');
    return { mode: 'local', host: r.host, token: r.token, deviceId: r.deviceId };
  }
}

function assertKey(key: unknown): asserts key is SecureKey {
  if (!isKey(key)) throw new BridgeError(`"${String(key)}" is not a storable key.`, 'invalid');
}
function assertValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > MAX_VALUE) throw new BridgeError('That value cannot be stored.', 'invalid');
}
function checkDeviceFlow(opts: { clientId: string; scopes: string[] }) {
  if (!CLIENT_ID.test(opts.clientId ?? '')) throw new BridgeError('GitHub sign-in is not configured in this build.', 'invalid');
  const scopes = [...new Set(opts.scopes)];
  if (!scopes.length || scopes.some((s) => !GITHUB_SCOPES.has(s))) throw new BridgeError('Unsupported GitHub permissions requested.', 'invalid');
  return { clientId: opts.clientId, scopes };
}
function checkExternal(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BridgeError('Only https links can be opened.', 'invalid');
  }
  if (u.protocol !== 'https:' || u.username || u.password) throw new BridgeError('Only https links can be opened.', 'invalid');
  return u.href;
}

const WEB_PREFIX = 'agent-empire.setup.';

/** Plain browser: non-secret keys in localStorage, secrets refused, no device flow. */
export function webNative(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null, open?: (url: string) => void): Native {
  const store = (fn: () => void) => {
    try {
      fn();
    } catch {
      throw new BridgeError('This browser blocked local storage.', 'unavailable');
    }
  };
  return {
    platform: null,
    available: false,
    async secureGet(key) {
      assertKey(key);
      if (SECRET_KEYS.has(key)) return null;
      try {
        return storage?.getItem(WEB_PREFIX + key) ?? null;
      } catch {
        return null;
      }
    },
    async secureSet(key, value) {
      assertKey(key);
      assertValue(value);
      if (SECRET_KEYS.has(key)) throw new BridgeError('A browser has no secure storage, so this is kept only until the page closes.', 'unavailable');
      store(() => storage?.setItem(WEB_PREFIX + key, value));
    },
    async secureDelete(key) {
      assertKey(key);
      if (!SECRET_KEYS.has(key)) store(() => storage?.removeItem(WEB_PREFIX + key));
    },
    async githubDeviceFlow(opts) {
      checkDeviceFlow(opts);
      throw new BridgeError('GitHub sign-in needs the Agent Empire app. In a browser, paste a token instead.', 'unavailable');
    },
    async signedOut() {},
    async runLocal() {
      throw new BridgeError('Running on this computer needs the desktop app.', 'unavailable');
    },
    async openExternal(url) {
      const href = checkExternal(url);
      (open ?? ((u: string) => void window.open(u, '_blank', 'noopener,noreferrer')))(href);
    },
  };
}

let shared: Native | undefined;

/** The page's one bridge: the shell's if there is one, otherwise the browser fallback. */
export function native(): Native {
  if (shared) return shared;
  if (typeof window === 'undefined') return (shared = webNative(null));
  const bridge = new NativeBridge(window as unknown as Win);
  if (bridge.available) return (shared = bridge);
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {}
  return (shared = webNative(storage));
}

/** Injected shell info (platform, stored mode, a sign-out notice), or null in a plain browser. */
export function shellInfo(): ShellInfo | null {
  return typeof window === 'undefined' ? null : parseShellInfo((window as unknown as Win).AGENT_EMPIRE_APP);
}

/** Tests only. */
export function resetNativeForTests(value?: Native) {
  shared = value;
}
