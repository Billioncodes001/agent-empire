import { STARTER_SITES, SITES, hourlyRates, newSector, MANAGER_NAMES, type SiteId } from '../../shared/empire';
import { store } from '../state';
import type { Net } from '../net';
import { h, openModal } from './dom';

/** Shared city setup runs once on the server, immediately after the founder's character step. */
export function openFounding(net: Net) {
  const existing = new Set(store.empire.sectors.filter((s) => s.built).map((s) => s.id));
  const selected = new Set<SiteId>(STARTER_SITES.filter((s) => existing.has(s.id)).map((s) => s.id));
  const count = h('strong'),
    managers = h('strong'),
    treasury = h('strong', {}, `${store.empire.funds.toLocaleString()} cr`);
  const summary = h(
    'div.founding-summary',
    {},
    h('div', {}, count, h('span', {}, 'starting buildings')),
    h('div', {}, managers, h('span', {}, 'appointed AI managers')),
    h('div', {}, treasury, h('span', {}, 'city treasury')),
  );
  const estimate = h('p.founding-estimate');
  const error = h('p.founding-error', { role: 'status' });
  const submit = h('button.btn.primary', { type: 'button' }, 'Found my city & appoint managers');
  const cards = h('div.founding-grid');
  const usage = h('p.setting-note');
  let pending = false,
    closed = false;
  const refresh = () => {
    count.textContent = String(2 + selected.size);
    managers.textContent = String(1 + selected.size);
    let netRate = -70;
    for (const id of selected) {
      const s = newSector(id);
      s.built = true;
      s.staff = 1;
      s.manager = { id: '', name: '', status: 'ready', attempt: 1, jobKey: '' };
      const rate = hourlyRates(s);
      netRate += rate.revenue - rate.wages - rate.upkeep;
    }
    estimate.textContent = `Projected operating result: ${netRate >= 0 ? '+' : ''}${netRate} cr / city hour, after managers start. Completed AI tasks earn additional credits.`;
    usage.textContent = `Appointing managers queues ${1 + selected.size} startup briefs. They respect the existing queue’s concurrency and spending limits. Buildings open when their assigned manager starts; paused or disconnected agents remain clearly marked.`;
    submit.disabled = pending || !net.up;
    submit.textContent = pending ? 'Saving your founding plan…' : 'Found my city & appoint managers';
  };
  for (const site of STARTER_SITES) {
    const input = h('input', {
      type: 'checkbox',
      checked: selected.has(site.id),
      disabled: existing.has(site.id),
      'aria-label': `Start with ${site.name}`,
    });
    const card = h(
      'label.founding-card',
      {},
      input,
      h(
        'span.founding-icon',
        {},
        (
          {
            hospital: '+',
            school: 'S',
            cafe: 'C',
            utilities: 'E',
            recreation: 'R',
          } as Record<string, string>
        )[site.id],
      ),
      h(
        'span',
        {},
        h('strong', {}, site.name),
        h('small', {}, site.sector),
        h('p', {}, `${MANAGER_NAMES[site.id]} + one service employee`),
        h('em', {}, existing.has(site.id) ? 'Already in your district' : 'Included in founding grant'),
      ),
    );
    input.onchange = () => {
      input.checked ? selected.add(site.id) : selected.delete(site.id);
      refresh();
    };
    cards.append(card);
  }
  const modal = openModal(
    h(
      'section.modal.founding-modal',
      { role: 'dialog', 'aria-label': 'Found your city' },
      h('header', {}, h('div', {}, h('small', {}, 'FOUNDER SETUP / YOUR STARTING DISTRICT'), h('h2', {}, 'Your work. Your city.'))),
      h(
        'div.body',
        {},
        h(
          'p.founding-intro',
          {},
          'Choose the places that will be ready on day one. Their AI managers prepare a brief for your project, then take on the real work you assign.',
        ),
        h(
          'div.founding-included',
          {},
          h('strong', {}, 'Always included'),
          h('span', {}, 'Headquarters · Private residence · Chief of staff'),
          h('p', {}, 'Your chief of staff monitors every sector, reports progress and brings decisions back to you.'),
        ),
        cards,
        summary,
        estimate,
        h(
          'p.setting-note',
          {},
          'Starting buildings are a one-time grant. Unselected sites can be built later. City revenue, salaries and founder dividends are simulation credits; real agent work uses your configured AI account and its usage budget.',
        ),
        usage,
        error,
      ),
      h('footer', {}, h('span', {}, 'Queues real AI work using your configured account.'), submit),
    ),
    {
      escCloses: false,
      backdropCloses: false,
      onClose: () => {
        closed = true;
        off();
        offNet();
        offStatus();
      },
    },
  );
  const off = store.on('empire', () => {
    if (store.empire.setup.completed) modal.close();
    else refresh();
  });
  const offNet = net.onMessage((msg) => {
    if (!closed && pending && msg.t === 'toast' && msg.level === 'error') {
      pending = false;
      error.textContent = msg.text;
      refresh();
    }
  });
  const offStatus = net.onStatus((up) => {
    if (!up) {
      pending = false;
      error.textContent = 'Reconnecting to your city…';
    } else error.textContent = '';
    refresh();
  });
  submit.onclick = () => {
    if (pending || !net.up) return;
    pending = true;
    submit.textContent = 'Saving your founding plan…';
    error.textContent = '';
    refresh();
    net.send({
      t: 'empire.action',
      action: { kind: 'found', sites: [...selected] },
    });
  };
  refresh();
}
