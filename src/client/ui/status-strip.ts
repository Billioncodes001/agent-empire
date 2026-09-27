import { store } from '../state';
import { chiefView, delegationLabel, monitorView, workforceView, type Tone } from './status';
import { h } from './dom';

/** Compact, always-visible supervision evidence. Built once; later updates only touch text. */
export function mountStatusStrip(host: HTMLElement, actions: { openManagement: () => void; openWorkers: () => void }) {
  const dot = h('span.status-dot', { 'aria-hidden': 'true' });
  const chiefLabel = h('span.status-value');
  const chief = h(
    'button.status-row.status-chief',
    { type: 'button', onclick: actions.openManagement },
    dot,
    h('span.status-key', {}, 'Chief of staff'),
    chiefLabel,
  );
  const monitor = h('span.status-monitor');
  const active = h('b'), attention = h('b'), queued = h('b');
  const workforce = h(
    'button.status-row.status-workforce',
    { type: 'button', onclick: actions.openWorkers },
    h('span.status-key', {}, 'AI workers'),
    h('span.status-counts', {}, active, ' active · ', attention, ' need input · ', queued, ' queued'),
  );
  const announcer = h('span.visually-hidden', { 'aria-live': 'polite', 'aria-atomic': 'true' });
  host.replaceChildren(chief, monitor, workforce, announcer);

  let lastAnnounced = '';
  let lastTone: Tone | '' = '';
  const render = () => {
    const ev = store.evidence();
    const sup = store.empire.supervision;
    const view = chiefView(sup, ev);
    const mon = monitorView(sup, ev);
    const counts = workforceView(sup, ev);
    chiefLabel.textContent = view.label;
    chief.title = view.detail;
    chief.setAttribute('aria-label', `Chief of staff: ${view.label}. ${view.detail} Open Management.`);
    if (view.tone !== lastTone) {
      host.dataset.tone = view.tone;
      lastTone = view.tone;
    }
    monitor.textContent = ev.fresh ? `${mon.label} · ${delegationLabel(sup?.delegationRequested ?? store.empire.delegated)}` : mon.detail;
    active.textContent = counts ? String(counts.active) : '—';
    attention.textContent = counts ? String(counts.attention) : '—';
    queued.textContent = counts ? String(counts.queued) : '—';
    workforce.classList.toggle('attention', !!counts?.attention);
    workforce.setAttribute(
      'aria-label',
      counts
        ? `AI workers: ${counts.active} active, ${counts.attention} need input, ${counts.queued} queued. Open worker list.`
        : 'AI workers: counts unavailable until the server reports fresh evidence. Open worker list.',
    );
    const announce = `Chief of staff: ${view.label}`;
    if (announce !== lastAnnounced) {
      lastAnnounced = announce;
      announcer.textContent = announce;
    }
  };
  for (const topic of ['empire', 'workers', 'queue', 'connection'] as const) store.on(topic, render);
  // Staleness has to surface even when no message arrives, including while dialogs are open.
  setInterval(render, 1000);
  render();
  return { render };
}
