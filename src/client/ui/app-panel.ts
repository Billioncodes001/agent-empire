import { store } from '../state';
import type { Net } from '../net';
import { h, toast } from './dom';
import { connectionView, continuityView } from './continuity';
import { installState, onInstallChange, promptInstall } from './pwa';
import type { StatusView } from './status';

const INSTALL_TEXT = {
  installed: 'Installed. Agent Empire opens in its own window from your home screen, dock or app list.',
  available: 'Install Agent Empire as an app on this device. It still connects to your office host; nothing runs on this device.',
  ios: 'On iPhone or iPad: tap Share, then “Add to Home Screen”.',
  insecure: 'Installing needs HTTPS or localhost. Open the office over a secure address to install it.',
  'browser-menu': 'Use your browser’s menu to install this site (for example “Install app” or “Add to Home Screen”), where supported.',
} as const;

/** Settings section: connection, host persistence and installation. Built once; updates only change text. */
export function appPanel(net: Net) {
  const card = (title: string) => {
    const label = h('strong');
    const detail = h('p');
    const el = h('article.status-card', {}, h('span.empire-eyebrow', {}, title), h('strong', {}, h('span.status-dot', { 'aria-hidden': 'true' }), label), detail);
    const set = (v: StatusView) => {
      el.dataset.tone = v.tone;
      label.textContent = v.label;
      detail.textContent = v.detail;
    };
    return { el, set };
  };
  const connection = card('Connection');
  const host = card('Host persistence');
  const hostMeta = h('p.setting-note');
  const reconnect = h('button.btn', { type: 'button' }, 'Reconnect now');
  reconnect.addEventListener('click', () => net.reconnectNow());
  connection.el.append(h('div.sector-actions', {}, reconnect));
  host.el.append(hostMeta);

  const installNote = h('p.setting-note');
  const install = h('button.btn', { type: 'button' }, 'Install app');
  install.addEventListener('click', async () => {
    if (await promptInstall()) toast('Agent Empire installed on this device.', 'info');
  });

  const el = h(
    'section.app-panel',
    { 'aria-labelledby': 'app-panel-title' },
    h('label', { id: 'app-panel-title', style: 'margin-top:18px' }, 'App & connection'),
    h('div.status-cards', {}, connection.el, host.el),
    h(
      'p.setting-note',
      {},
      'Agents run on the office host that serves this page. They keep working after you close this browser or app only while that host stays on, awake and running the office server. Nothing runs offline on this device, and a connected page does not mean the host is a cloud server.',
    ),
    h('div.app-install', {}, installNote, install),
  );

  const paint = () => {
    const now = performance.now();
    connection.set(connectionView({ online: store.online, connected: store.connected }));
    reconnect.hidden = store.connected || !store.online;
    const current = store.connected && store.continuityReceivedAt >= store.connectedAt;
    host.set(continuityView(store.continuity, store.continuityReceivedAt, current, now));
    const s = store.continuity;
    hostMeta.textContent = s ? `Host ${s.serverId.slice(0, 12)} · run ${s.serverRunId.slice(0, 8)} · one host owns execution` : '';
    hostMeta.hidden = !s;
    const state = installState();
    installNote.textContent = INSTALL_TEXT[state.kind];
    install.hidden = state.kind !== 'available';
  };
  const offs = [store.on('connection', paint), store.on('continuity', paint), onInstallChange(paint)];
  // Report ages go stale without new messages.
  const timer = setInterval(paint, 1000);
  paint();
  return {
    el,
    dispose() {
      offs.forEach((off) => off());
      clearInterval(timer);
    },
  };
}
