import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { apiFetch, isAppMode, notifySignedOut, wsProtocols, wsUrl, WS_REVOKED } from './endpoint';
import type { Profile } from './state';

type Handler = (msg: ServerMsg) => void;

export class Net {
  private ws: WebSocket | null = null;
  private handlers: Handler[] = [];
  private statusHandlers: ((up: boolean) => void)[] = [];
  private retry = 0;
  private closedByUs = false;
  /** The server is restarting on purpose: retry every second instead of backing off. */
  private restartExpected = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  up = false;

  constructor(private profile: () => Profile) {}

  onMessage(h: Handler) {
    this.handlers.push(h);
    return () => { this.handlers = this.handlers.filter(fn => fn !== h); };
  }

  onStatus(h: (up: boolean) => void) {
    this.statusHandlers.push(h);
    return () => { this.statusHandlers = this.statusHandlers.filter(fn => fn !== h); };
  }

  connect() {
    const { name, color, look } = this.profile();
    const q = new URLSearchParams({ name, color, skin: String(look.skin), hair: String(look.hair), style: String(look.style) });
    // Web: same host, cookie auth, no subprotocol. App: the office host, token in the subprotocol (never the URL).
    const protocols = wsProtocols();
    const ws = protocols ? new WebSocket(wsUrl(q.toString()), protocols) : new WebSocket(wsUrl(q.toString()));
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.up = true;
      this.statusHandlers.forEach((h) => h(true));
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      for (const h of this.handlers) h(msg);
    };
    ws.onclose = async (ev) => {
      if (this.ws !== ws) return;
      this.up = false;
      this.statusHandlers.forEach((h) => h(false));
      if (this.closedByUs) return;
      // This device was revoked: the app shell returns to its sign-in screen. There is nothing to retry.
      if (ev.code === WS_REVOKED && isAppMode()) return this.signedOut('revoked');
      // Session expired? Go back to the door (the web sign-in page, or the app's native sign-in).
      try {
        const res = await apiFetch('/api/whoami', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
        if (res.status === 401) {
          if (isAppMode()) return this.signedOut('unauthorized');
          location.href = '/login';
          return;
        }
      } catch {
        // offline or timed out; keep retrying
      }
      const delay = this.restartExpected ? 1000 : Math.min(8000, 500 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect();
      }, delay);
    };
  }

  private signedOut(reason: 'revoked' | 'unauthorized') {
    this.closedByUs = true;
    notifySignedOut(reason);
  }

  /** Skips the backoff wait. Does nothing while connected or while a socket is already opening. */
  reconnectNow() {
    if (this.up || this.closedByUs || this.ws?.readyState === WebSocket.CONNECTING) return;
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retry = 0;
    this.connect();
  }

  expectRestart() {
    this.restartExpected = true;
  }

  send(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
