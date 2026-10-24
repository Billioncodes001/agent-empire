import { apiFetch } from '../endpoint';
import { h, toast } from './dom';
import { confirmDialog } from './prompt';

/** One row of GET /api/devices (APP-01). The host stores no platform; it is read from the device name. */
export interface DeviceRow { id: string; name: string; createdAt: number; lastUsedAt: number; current: boolean }

export function parseDevices(raw: unknown): DeviceRow[] | null {
  const list = (raw as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(list)) return null;
  const rows: DeviceRow[] = [];
  for (const d of list) {
    if (!d || typeof d !== 'object') return null;
    const { id, name, createdAt, lastUsedAt, current } = d as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || typeof name !== 'string') return null;
    rows.push({
      id,
      name: name.slice(0, 64) || 'Device',
      createdAt: Number.isFinite(createdAt) ? (createdAt as number) : 0,
      lastUsedAt: Number.isFinite(lastUsedAt) ? (lastUsedAt as number) : 0,
      current: current === true,
    });
  }
  // This device first, then most recently seen.
  return rows.sort((a, b) => Number(b.current) - Number(a.current) || b.lastUsedAt - a.lastUsedAt);
}

/** Platform as named at sign-in (the setup names devices iPhone, iPad, Android device, Desktop app or Browser). */
export function devicePlatform(name: string): string | undefined {
  if (/iphone|ipad|\bios\b/i.test(name)) return 'iOS';
  if (/android/i.test(name)) return 'Android';
  if (/desktop|mac|windows|linux/i.test(name)) return 'Desktop';
  if (/browser/i.test(name)) return 'Web';
  return undefined;
}

export function lastSeen(at: number, now = Date.now()): string {
  if (!at) return 'never';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(at).toLocaleDateString();
}

/**
 * Settings card (server mode): the app devices signed in to this office, with revoke. Revoking signs
 * that device out and closes its connections on the host; this device is marked and is signed out
 * from Menu › Sign out instead. Browsers signed in with the office password use a cookie session and
 * are not listed.
 */
export function devicesSection() {
  const list = h('ul.device-list', { 'aria-label': 'Signed-in devices' });
  const status = h('p.setting-note', { role: 'status' });
  const refresh = h('button.btn', { type: 'button' }, 'Refresh');
  const el = h(
    'article.status-card.devices-card',
    { 'aria-labelledby': 'devices-title' },
    h('span.empire-eyebrow', { id: 'devices-title' }, 'Signed-in devices'),
    h('p.setting-note', {}, 'Apps signed in to this office with the office password. Revoking one signs it out at once; its saved sign-in stops working. Browsers using the office password page are not listed.'),
    list,
    status,
    h('div.sector-actions', {}, refresh),
  );
  let disposed = false;
  const load = async () => {
    status.textContent = 'Loading devices…';
    try {
      const res = await apiFetch('/api/devices', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(String(res.status));
      const rows = parseDevices(await res.json());
      if (!rows) throw new Error('bad response');
      if (disposed) return;
      paint(rows);
      status.textContent = rows.length ? '' : 'No app devices are signed in.';
    } catch {
      if (disposed) return;
      list.replaceChildren();
      status.textContent = 'Could not load signed-in devices. Check the connection to the office host and try Refresh.';
    }
  };
  const revoke = (row: DeviceRow) =>
    confirmDialog(
      `Revoke ${row.name}?`,
      `${row.name} will be signed out of this office now. Its connections close and it must sign in again with the office password. Workers keep running.`,
      'Revoke device',
      async () => {
        try {
          const res = await apiFetch(`/api/devices/${encodeURIComponent(row.id)}`, { method: 'DELETE', signal: AbortSignal.timeout(6000) });
          if (res.status === 404) toast(`${row.name} was already signed out.`, 'info');
          else if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error || `The host answered ${res.status}.`);
          } else toast(`${row.name} has been signed out.`, 'info');
        } catch (err) {
          toast(`Could not revoke ${row.name}. ${(err as Error).message || 'Check the connection and try again.'}`, 'error');
        }
        void load();
      },
    );
  const paint = (rows: DeviceRow[]) => {
    list.replaceChildren(
      ...rows.map((row) => {
        const platform = devicePlatform(row.name);
        const meta = [platform, `last seen ${lastSeen(row.lastUsedAt)}`, row.createdAt ? `added ${new Date(row.createdAt).toLocaleDateString()}` : '']
          .filter(Boolean)
          .join(' · ');
        const action = row.current
          ? h('span.device-this', {}, 'This device')
          : h('button.btn.danger', { type: 'button', 'aria-label': `Revoke ${row.name}`, onclick: () => revoke(row) }, 'Revoke');
        return h('li.device-row', { 'data-device': row.id }, h('div', {}, h('strong', {}, row.name), h('span.device-meta', {}, meta)), action);
      }),
    );
  };
  refresh.addEventListener('click', () => void load());
  void load();
  return { el, dispose: () => { disposed = true; } };
}
