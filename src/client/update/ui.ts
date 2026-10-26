/**
 * REL-03 interface: the HUD toast, the menu entry "Check for updates", the updates dialog with release notes, the
 * Settings section (channel and installed versions) and the REL-05 coordinator / server notices.
 *
 * The toast appears only when promptGate allows (no modal, no typing, not mid-jump, the splash done); otherwise it
 * waits. "Later" hides it for this version until the next launch; the menu entry stays.
 */
import { h, modalOpen, onModalChange, openModal, timeAgo, toast, type Modal } from '../ui/dom';
import { setMenuUpdateEntry } from '../ui/game-menu';
import { renderNotes } from './notes';
import { noticeGate, promptGate, isTextEntry } from './gate';
import type { UpdateService, UpdateState } from './service';
import type { Channel } from './channel';
import { versionLine } from './version-line';

const DISMISSED_KEY = 'agent-empire.update.dismissed';
/** One-off update notices stay up longer than an ordinary toast. */
const NOTICE_MS = 12_000;
const PLATFORM_LABEL: Record<string, string> = { ios: 'iPhone and iPad app', android: 'Android app', desktop: 'desktop app' };

function sessionGet(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function sessionSet(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {}
}

export { versionLine } from './version-line'; // DEVICE-BUGS-03: names the game build too

/** The one-line summary for the toast and the menu entry; null when there is nothing new. */
export function offerSummary(s: UpdateState): string | null {
  if (s.installed) return `Update ${s.installed} is ready: restart to use it`;
  const o = s.offer;
  const coordinator = s.coordinator?.kind === 'available' ? s.coordinator : null;
  if (o?.game.kind === 'install') return `Update available: Agent Empire ${o.game.version}`;
  if (o?.game.kind === 'needs-shell') return `Agent Empire ${o.game.version} needs a newer app`;
  if (o?.native) return `App update available: ${o.native.version}`;
  if (coordinator) return `Coordinator update available: ${coordinator.version}`;
  if (o?.server) return `Your server runs ${o.server.running}; ${o.server.available} is available`;
  return null;
}

const offerKey = (s: UpdateState) => offerSummary(s) ?? '';

export interface UpdateUiOptions {
  /** True while the player is in the air (no prompt mid-jump). */
  airborne?: () => boolean;
}

let dialog: { modal: Modal; render(): void } | null = null;

export function mountUpdateUi(service: UpdateService, opts: UpdateUiOptions = {}) {
  let toastEl: HTMLElement | null = null;
  let waiting: ReturnType<typeof setInterval> | null = null;
  let rolledBackShown = false;
  let installPendingShown = false;

  const gate = () =>
    promptGate({
      boot: document.documentElement.dataset.boot,
      modalOpen: modalOpen(),
      typing: isTextEntry(document.activeElement),
      airborne: !!opts.airborne?.(),
      hidden: document.visibilityState === 'hidden',
    });

  const hideToast = () => {
    toastEl?.remove();
    toastEl = null;
  };

  const showToast = (s: UpdateState) => {
    const text = offerSummary(s);
    if (!text) return hideToast();
    if (toastEl?.dataset.key === text) return;
    hideToast();
    const view = h('button.btn.primary', { type: 'button' }, s.installed ? 'Restart' : 'View');
    const later = h('button.btn', { type: 'button' }, 'Later');
    toastEl = h('div.toast.update-toast', { role: 'status', 'aria-live': 'polite', 'data-key': text }, h('span', {}, text), h('span.update-toast-actions', {}, view, later));
    view.addEventListener('click', () => {
      hideToast();
      openUpdateDialog(service);
    });
    later.addEventListener('click', () => {
      sessionSet(DISMISSED_KEY, text);
      hideToast();
    });
    document.getElementById('toasts')?.append(toastEl);
  };

  let noticeWait: ReturnType<typeof setInterval> | null = null;
  // One-off notices wait until the splash is gone, then stay up long enough to read.
  const showNotices = () => {
    if (noticeGate({ boot: document.documentElement.dataset.boot, hidden: document.visibilityState === 'hidden' }) !== 'show') return false;
    const s = service.state;
    if (s.info?.installPending && !installPendingShown) {
      installPendingShown = true;
      toast(`The app update to ${s.info.installPending} didn’t finish installing. Tap Update again to finish installing.`, 'warn', NOTICE_MS);
    }
    if (s.info?.rolledBack && !rolledBackShown) {
      rolledBackShown = true;
      toast(`The update to ${s.info.rolledBack} didn’t start, so the app went back to ${s.info.installedGame ?? s.info.builtinGame ?? 'the previous version'}.`, 'warn', NOTICE_MS);
    }
    return true;
  };

  const consider = () => {
    const s = service.state;
    const notices = (s.info?.installPending && !installPendingShown) || (s.info?.rolledBack && !rolledBackShown);
    if (notices && !noticeWait && !showNotices()) {
      noticeWait = setInterval(() => {
        if (!showNotices()) return;
        clearInterval(noticeWait!);
        noticeWait = null;
      }, 500);
    }
    const key = offerKey(s);
    if (!key || sessionGet(DISMISSED_KEY) === key || dialog) {
      if (!key) hideToast();
      return;
    }
    if (toastEl?.dataset.key === key) return;
    // Wait for a calm moment: no modal, no typing, not mid-jump, the city loaded.
    if (waiting) return;
    const attempt = () => {
      if (gate() !== 'show') return false;
      if (waiting) clearInterval(waiting);
      waiting = null;
      if (offerKey(service.state) && sessionGet(DISMISSED_KEY) !== offerKey(service.state)) showToast(service.state);
      return true;
    };
    if (!attempt()) waiting = setInterval(attempt, 1500);
  };

  service.on(() => {
    consider();
    dialog?.render();
  });
  // A dialog opening over the prompt hides it (not dismissed); it comes back at the next calm moment.
  onModalChange((open) => {
    if (open && toastEl && !dialog) hideToast();
    else if (!open) consider();
  });
  setMenuUpdateEntry(() => {
    const summary = offerSummary(service.state);
    return {
      label: summary ? 'Update available' : 'Check for updates',
      detail: summary ?? versionLine(service.state), // DEVICE-BUGS-03: the game build is always one tap away
      run: () => openUpdateDialog(service, { check: !summary }),
      cls: summary ? '.update' : '',
    };
  });
  consider();
}

function card(title: string, tone: string, label: string, detail: string | HTMLElement, ...controls: (HTMLElement | null)[]) {
  return h(
    'article.status-card.update-card',
    { 'data-tone': tone },
    h('span.empire-eyebrow', {}, title),
    h('strong', {}, h('span.status-dot', { 'aria-hidden': 'true' }), label),
    typeof detail === 'string' ? h('p', {}, detail) : detail,
    controls.some(Boolean) ? h('div.sector-actions', {}, ...controls) : null,
  );
}

function confirmDialog(title: string, paragraphs: string[], yesLabel: string, run: () => void) {
  const yes = h('button.btn.primary', { type: 'button' }, yesLabel);
  const no = h('button.btn', { type: 'button' }, 'Not now');
  const m = openModal(h('div.modal.ae-dark.cloud-confirm', { role: 'alertdialog', 'aria-label': title }, h('header', {}, h('h2', {}, title)), h('div.body', {}, ...paragraphs.map((p) => h('p', {}, p))), h('footer', {}, no, yes)));
  no.onclick = () => m.close();
  yes.onclick = () => {
    m.close();
    run();
  };
  setTimeout(() => no.focus(), 30);
}

/** The updates dialog: versions, what's new, and the actions the player can take. */
export function openUpdateDialog(service: UpdateService, opts: { check?: boolean } = {}) {
  if (dialog) return dialog.render();
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close' }, '✕');
  const body = h('div.body.update-body', { 'aria-live': 'polite' });
  const recheck = h('button.btn', { type: 'button' }, 'Check again');
  const foot = h('span.grow');
  const el = h('div.modal.ae-dark.update-modal', { role: 'dialog', 'aria-labelledby': 'update-title' }, h('header', {}, h('h2', { id: 'update-title' }, 'Updates'), close), body, h('footer', {}, foot, recheck));
  recheck.addEventListener('click', () => void service.check());

  const render = () => {
    const s = service.state;
    const o = s.offer;
    recheck.disabled = s.phase === 'checking' || s.phase === 'installing';
    recheck.hidden = !service.canCheck;
    foot.textContent = s.checkedAt ? `Checked ${timeAgo(s.checkedAt)}` : '';
    const nodes: (HTMLElement | null)[] = [h('p.setting-note.update-versions', {}, versionLine(s))];
    if (!service.canCheck) nodes.push(h('p.setting-note', {}, 'In a browser the game comes from your Empire’s server, so it updates with the server. The Agent Empire apps check GitHub releases for updates.'));
    if (s.phase === 'checking') nodes.push(h('p.upgrade-status.busy', {}, h('span.spinner'), 'Checking for updates…'));
    if (s.error && s.phase !== 'checking') nodes.push(h('p.upgrade-status.error', { role: 'alert' }, s.error));
    const notes = o?.notes ? h('div.update-notes', {}, h('strong', {}, `What’s new in ${o.version}`), ...renderNotes(o.notes)) : null;

    if (s.installed) {
      const restart = h('button.btn.primary', { type: 'button', onclick: () => void service.restart().catch((e) => toast(e instanceof Error ? e.message : 'Restart failed', 'error')) }, 'Restart now');
      nodes.push(card('Game', 'ready', `Agent Empire ${s.installed} is installed`, 'It starts the next time the app opens, or restart now. Your saves and settings are not changed. If it doesn’t start, the app goes back to the current version by itself.', restart));
    } else if (o?.game.kind === 'install') {
      const busy = s.phase === 'installing';
      const go = h('button.btn.primary', { type: 'button', disabled: busy, onclick: () => void service.installGame().catch(() => {}) }, busy ? 'Downloading…' : 'Update game');
      nodes.push(card('Game', 'attention', `Agent Empire ${o.game.version} is available`, busy ? h('p.upgrade-status.busy', {}, h('span.spinner'), 'Downloading and checking the signed update. You can keep playing.') : 'Downloads the signed game files, checks them, and switches on the next start. Saves and settings are not changed.', go));
    } else if (o?.game.kind === 'needs-shell') {
      nodes.push(card('Game', 'attention', `Agent Empire ${o.game.version} needs a newer app`, `This update needs version ${o.game.minShell} of the ${PLATFORM_LABEL[s.info?.platform ?? ''] ?? 'app'} or newer. Update the app first.`));
    }
    if (o?.native) {
      const how = o.native.how;
      const ready = s.nativeUpdate === 'ready', working = s.nativeUpdate === 'working';
      const label = ready ? 'Restart to update' : working ? 'Downloading…' : how === 'auto' ? 'Update the app' : how === 'installer' ? 'Download and install' : how === 'store' ? (s.info?.platform === 'ios' ? 'Open TestFlight / App Store' : 'Open Google Play') : 'Open download page';
      const after = (r: { action: string }) => {
        if (r.action === 'permission') toast('Allow Agent Empire to install apps, then choose the update again.', 'info');
        if (r.action === 'auto-update') toast(`App version ${o.native!.version} is ready. Restart to update.`, 'info');
      };
      const btn = h(ready ? 'button.btn.primary' : 'button.btn', { type: 'button', disabled: working, onclick: () => void service.openNative().then(after, (e) => toast(e instanceof Error ? e.message : 'The app update could not start.', 'error')) }, label);
      const detail = ready
        ? 'The update is downloaded and checked. Restarting takes a moment; your Empire is not changed.'
        : how === 'auto'
          ? 'The app downloads the signed update in the background, then asks you to restart.'
          : how === 'installer'
            ? 'Downloads the app, checks it against the signed release, and opens Android’s installer.'
            : how === 'store'
              ? 'Opens the store page for the app update.'
              : 'Opens the release page in your browser. Install it over this app; your Empire is not changed.';
      nodes.push(card('App', ready ? 'ready' : 'attention', ready ? `App version ${o.native.version} is ready` : `App version ${o.native.version} is available`, detail, btn));
    }
    if (o?.server) nodes.push(card('Server', 'attention', `Your server runs ${o.server.running}; ${o.server.available} is available`, 'The app does not change your server. Update it from the office’s Upgrade button (servers deployed from git) or redeploy it.'));
    const c = s.coordinator;
    if (c?.kind === 'available') {
      const btn = h(
        'button.btn',
        {
          type: 'button',
          disabled: s.coordinatorBusy,
          onclick: () =>
            confirmDialog(
              `Update your coordinator to ${c.version}?`,
              [
                `This commits the new coordinator (checked against the signed release) to your state repository, replacing ${c.installed.version ? `version ${c.installed.version}` : 'the current one'}. Its next run uses it.`,
                'Your Empire’s state, jobs and secrets are not changed, and no paid work starts. You can see the commit in your repository’s history.',
              ],
              'Update coordinator',
              () =>
                void service.updateCoordinator().then(
                  () => toast(`Coordinator updated to ${c.version}. It runs on the next schedule.`, 'info'),
                  (e) => toast(e instanceof Error ? e.message : 'The coordinator was not updated.', 'error'),
                ),
            ),
        },
        s.coordinatorBusy ? 'Updating…' : 'Update coordinator…',
      );
      nodes.push(card('Cloud coordinator', 'attention', `Coordinator update available: ${c.version}`, `Your state repository runs ${c.installed.version ?? 'an older coordinator'}. Updating it is your choice; it never happens automatically.`, btn));
    } else if (c?.kind === 'needs-game') {
      nodes.push(card('Cloud coordinator', 'attention', `Coordinator ${c.version} needs a newer game`, 'Update the game first: the new coordinator saves your Empire in a format this version can’t read.'));
    } else if (c?.kind === 'current') {
      nodes.push(card('Cloud coordinator', 'idle', `Coordinator ${c.installed.version ?? 'current'}`, 'Your state repository runs the coordinator from the newest release.'));
    }
    const offered = s.installed || (o && o.any) || c?.kind === 'available';
    if (!offered && s.phase !== 'checking' && s.checkedAt && !s.error) nodes.push(h('p.upgrade-status.ok', {}, 'You’re up to date.'));
    if (notes && (s.installed || o?.any)) nodes.push(notes);
    body.replaceChildren(...nodes.filter((n): n is HTMLElement => !!n));
  };

  const modal = openModal(el, { onClose: () => (dialog = null) });
  dialog = { modal, render };
  close.addEventListener('click', () => modal.close());
  render();
  if (opts.check) void service.check();
}

/** Settings → "Updates": channel, installed versions and a check button. */
export function updateSettingsSection(service: UpdateService) {
  const seg = h('div.seg', { role: 'radiogroup', 'aria-label': 'Update channel' });
  const line = h('p.setting-note.update-versions');
  const status = h('p.setting-note');
  const check = h('button.btn', { type: 'button', onclick: () => openUpdateDialog(service, { check: true }) }, 'Check for updates');
  const choices: [Channel, string][] = [
    ['stable', 'Stable'],
    ['beta', 'Beta'],
  ];
  const paint = () => {
    const s = service.state;
    seg.replaceChildren(
      ...choices.map(([value, label]) =>
        h('button.btn', { type: 'button', role: 'radio', 'aria-checked': String(s.channel === value), class: s.channel === value ? 'on' : '', onclick: () => service.setChannel(value) }, label),
      ),
    );
    line.textContent = versionLine(s);
    status.textContent = !service.canCheck
      ? 'In a browser the game updates with your Empire’s server.'
      : s.phase === 'checking'
        ? 'Checking for updates…'
        : offerSummary(s) ?? (s.error ? `Last check failed: ${s.error}` : s.checkedAt ? `Up to date (checked ${timeAgo(s.checkedAt)}).` : 'Not checked yet.');
  };
  const off = service.on(paint);
  paint();
  const el = h(
    'section.update-settings',
    { 'aria-labelledby': 'update-settings-title' },
    h('label', { id: 'update-settings-title', style: 'margin-top:18px' }, 'Updates'),
    line,
    seg,
    h('p.setting-note', {}, 'Beta gets pre-releases first, and stable releases when they are newer. Updates never change your saves or settings.'),
    status,
    h('div.sector-actions', {}, check),
  );
  return { el, dispose: () => off() };
}
