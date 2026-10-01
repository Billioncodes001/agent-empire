import { apiFetch, appConfig, beginUserSignOut, hostUrl, notifySignedOut } from '../endpoint';
import type { PlayerController } from '../player';
import { h, modalOpen, openModal, toast, type Modal } from './dom';
import { openHelp } from './hud';
import { confirmDialog } from './prompt';

/** Not remappable (controls.validKey rejects it) and not used by Esc, chat or terminals. */
export const MENU_KEY = 'Backquote';

function isTextEntry(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable || !!el.closest('.xterm');
}

const touchMode = () => document.documentElement.classList.contains('ae-touch');

/** Top-bar tools the current layout hides (phones); the menu lists them so nothing becomes unreachable. */
function hiddenTools(): HTMLButtonElement[] {
  const skip = new Set(['btn-menu', 'btn-settings', 'btn-help', 'btn-camera']);
  return [...document.querySelectorAll<HTMLButtonElement>('.topbar .controls > button')].filter(
    (b) => !skip.has(b.id) && !b.classList.contains('hidden') && b.getClientRects().length === 0,
  );
}

function toolLabel(b: HTMLButtonElement): string {
  return (b.getAttribute('aria-label') || b.textContent || b.title || 'Tool').trim();
}

export function openTouchHelp(onKeyboard: () => void) {
  const rows: [string, string][] = [
    ['Left thumb', 'Touch anywhere on the left half and drag to walk. Push to the edge of the ring to run.'],
    ['Right side drag', 'Orbit the camera (third person) or look around (first person).'],
    ['Tap the scene', 'Use what you tap: a desk, a board, the TV.'],
    ['Jump', 'Jump. Hold to keep jumping when you land.'],
    ['Use (E)', 'Interact with what is in front of you: desks, doors, your car.'],
    ['View', 'Switch between first and third person.'],
    ['Minimap', 'Open the district map and set a waypoint.'],
    ['Menu', 'Settings, map, management, chat, office tools and sign out.'],
  ];
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close' }, '✕');
  const keyboard = h('button.btn', { type: 'button' }, 'Keyboard controls');
  const modal = openModal(
    h(
      'div.modal.game-help.ae-dark',
      { role: 'dialog', 'aria-label': 'Touch controls' },
      h('header', {}, h('h2', {}, 'Touch controls'), close),
      h('div.body', {}, h('div.help-grid', {}, ...rows.flatMap(([k, v]) => [h('span.key', {}, k), h('span', {}, v)]))),
      h('footer', {}, keyboard),
    ),
  );
  close.addEventListener('click', () => modal.close());
  keyboard.addEventListener('click', () => {
    modal.close();
    onKeyboard();
  });
}

/** App sign-out: revoke this device's token on the host when reachable, then hand back to the native sign-in. */
async function appSignOut() {
  const app = appConfig()!;
  beginUserSignOut();
  try {
    let id = app.deviceId;
    if (!id) {
      const who = await apiFetch('/api/whoami', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      id = who.ok ? ((await who.json()) as { deviceId?: string }).deviceId : undefined;
    }
    if (id) await apiFetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(6000) });
  } catch {
    // Offline: the token is still forgotten on this device; it can be revoked later from Settings on another one.
  }
  notifySignedOut('user');
}

export function signOut() {
  if (appConfig()) {
    confirmDialog('Sign out?', 'This signs this device out of the office and forgets its sign-in. Workers and cloud jobs keep running on the host.', 'Sign out', () => void appSignOut());
    return;
  }
  confirmDialog('Sign out?', 'This signs this browser out of the office. Workers and cloud jobs keep running on the host.', 'Sign out', () => {
    fetch(hostUrl('/api/logout'), { method: 'POST', credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        location.href = hostUrl('/login');
      })
      .catch(() => toast('Could not sign out. Check the connection to the office host and try again.', 'error'));
  });
}

export interface MenuEntry { label: string; detail: string; run: () => void; cls?: string }
/** Extra entries for a mode (cloud mode adds Cloud Empire and Shut down / Start) and its own sign-out. */
export interface MenuExtension { items(): MenuEntry[]; signOut?: MenuEntry }
let extension: MenuExtension | null = null;
export function setMenuExtension(ext: MenuExtension | null) {
  extension = ext;
}

export function mountGameMenu(opts: { player: PlayerController; openMap: () => void; openOperations: () => void }) {
  let menu: Modal | null = null;
  const trigger = h(
    'button.btn',
    { id: 'btn-menu', type: 'button', title: 'Menu (`)', 'aria-label': 'Game menu', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    h('span.menu-glyph', { 'aria-hidden': 'true' }),
    h('span', {}, 'Menu'),
  );
  document.querySelector('.topbar .controls')?.append(trigger);

  const help = () => (touchMode() ? openTouchHelp(() => openHelp(opts.player.bindings)) : openHelp(opts.player.bindings));

  function open() {
    if (menu || modalOpen()) return;
    const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close menu' }, '✕');
    // Each entry closes the menu first, so the next window opens on the game, not on top of the menu.
    const item = (label: string, detail: string, run: () => void, cls = '') =>
      h(
        `button.menu-item${cls}` as 'button.x',
        {
          type: 'button',
          onclick: () => {
            menu?.close();
            run();
          },
        },
        h('strong', {}, label),
        h('small', {}, detail),
      );
    const tools = hiddenTools();
    const chat = document.getElementById('chat-input') as HTMLInputElement | null;
    const body = h(
      'div.body.menu-body',
      {},
      h(
        'div.menu-grid',
        {},
        item('Resume', 'Back to the city', () => {}, '.primary'),
        item('Map', 'District map and waypoints', opts.openMap),
        item('Management', 'Sectors, workers and reports', opts.openOperations),
        item('Settings', 'Camera, graphics, sound, keys', () => document.getElementById('btn-settings')?.click()),
        item('Controls', touchMode() ? 'Touch and keyboard help' : 'Keyboard and mouse help', help),
        ...(extension?.items() ?? []).map((e) => item(e.label, e.detail, e.run, e.cls ?? '')),
        touchMode() && chat
          ? item('Chat', 'Message people in the office', () => {
              document.documentElement.classList.add('ae-chat-open');
              chat.focus();
            })
          : null,
      ),
      tools.length
        ? h(
            'section.menu-tools',
            { 'aria-label': 'Office tools' },
            h('h3', {}, 'Office tools'),
            h('div.menu-tool-row', {}, ...tools.map((b) => item(toolLabel(b), b.title && b.title !== toolLabel(b) ? b.title : '', () => b.click(), '.tool'))),
          )
        : null,
      h('div.menu-foot', {}, extension?.signOut ? item(extension.signOut.label, extension.signOut.detail, extension.signOut.run, '.danger') : item('Sign out', 'Workers keep running on the host', signOut, '.danger')),
    );
    menu = openModal(
      h(
        'div.modal.game-menu.ae-dark',
        { role: 'dialog', 'aria-label': 'Game menu' },
        h('header', {}, h('div.menu-title', {}, h('small', {}, 'AGENT EMPIRE'), h('h2', {}, 'Menu')), close),
        body,
      ),
      { onClose: () => { menu = null; trigger.setAttribute('aria-expanded', 'false'); } },
    );
    trigger.setAttribute('aria-expanded', 'true');
    close.addEventListener('click', () => menu?.close());
    requestAnimationFrame(() => body.querySelector<HTMLElement>('.menu-item')?.focus({ preventScroll: true }));
  }

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    open();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code !== MENU_KEY || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTextEntry(e.target)) return;
    e.preventDefault();
    if (menu) menu.close();
    else open();
  });

  // The chat panel on phones is shown only while it is being used.
  const chat = document.getElementById('chat-input');
  chat?.addEventListener('blur', () => setTimeout(() => document.documentElement.classList.remove('ae-chat-open'), 0));
  return { open };
}
