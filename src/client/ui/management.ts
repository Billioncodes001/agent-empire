import { SITES, hourlyRates, upgradeCost, type EmpireAction, type SiteId } from '../../shared/empire';
import { store } from '../state';
import type { Net } from '../net';
import { h, openModal } from './dom';
import { fmtCost } from './usage';
import { cloudManagerView, cloudStatus, jobCounts } from '../cloud/map';
import { ageLabel, chiefView, delegationLabel, managerView, monitorView, unknownView, workforceView, type StatusView } from './status';

type Tab = 'overview' | 'sectors' | 'accounts' | 'reports';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['sectors', 'Sectors'],
  ['accounts', 'Accounts'],
  ['reports', 'Reports'],
];

export interface ManagementActions {
  openQueue(): void;
  openTerminal(workerId: string): void;
  assignTask(site: SiteId): void;
}

type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;
/** Buttons carry a stable key so a data refresh can hand focus back to the same control. */
const button = (key: string, label: string, onclick: () => void, attrs: Attrs = {}) =>
  h('button.btn', { type: 'button', 'data-key': key, onclick, ...attrs }, label);

const metric = (label: string, value: string, note?: string) =>
  h('div.empire-metric', {}, h('strong', {}, value), h('span', {}, label), note ? h('small', {}, note) : null);

const statusCard = (title: string, view: StatusView, ...controls: (HTMLElement | null)[]) =>
  h(
    'article.status-card',
    { 'data-tone': view.tone },
    h('span.empire-eyebrow', {}, title),
    h('strong', {}, h('span.status-dot', { 'aria-hidden': 'true' }), view.label),
    h('p', {}, view.detail),
    controls.some(Boolean) ? h('div.sector-actions', {}, ...controls) : null,
  );

export function openManagement(net: Net, actions: ManagementActions, selected?: SiteId) {
  let tab: Tab = selected ? 'sectors' : 'overview';
  let payrollOpen = false;
  let signature = '';
  const send = (action: EmpireAction) => net.send({ t: 'empire.action', action });

  const freshness = h('span.empire-freshness');
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close operations' }, '✕');
  const tabs = TABS.map(([id, label]) =>
    h('button.empire-tab', { type: 'button', role: 'tab', id: `empire-tab-${id}`, 'aria-controls': 'empire-panel', onclick: () => select(id, false) }, label),
  );
  const tablist = h('div.empire-tabs', { role: 'tablist', 'aria-label': 'Management sections' }, ...tabs);
  const panel = h('div.body.empire-body', { role: 'tabpanel', id: 'empire-panel', tabindex: 0 });
  tablist.addEventListener('keydown', (e) => {
    const i = TABS.findIndex(([id]) => id === tab);
    const next = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(TABS[next][0], true);
  });

  const modal = openModal(
    h(
      'div.modal.empire-modal',
      { role: 'dialog', 'aria-labelledby': 'empire-title' },
      h(
        'header',
        {},
        h('div.empire-heading', {}, h('small.empire-eyebrow', {}, 'District operations'), h('h2', { id: 'empire-title' }, 'Empire operations')),
        freshness,
        close,
      ),
      tablist,
      panel,
    ),
    { onClose: () => { offs.forEach((off) => off()); clearInterval(timer); } },
  );
  close.onclick = () => modal.close();

  function select(id: Tab, focus: boolean) {
    tab = id;
    for (const [i, [tabId]] of TABS.entries()) {
      const on = tabId === tab;
      tabs[i].setAttribute('aria-selected', String(on));
      tabs[i].tabIndex = on ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', `empire-tab-${tab}`);
    panel.scrollTop = 0;
    signature = '';
    refresh();
    if (focus) tabs[TABS.findIndex(([t]) => t === tab)].focus();
  }

  function refresh() {
    const ev = store.evidence();
    freshness.textContent = ev.fresh ? `Updated ${ageLabel(ev.age)}` : unknownView(ev).detail;
    freshness.classList.toggle('stale', !ev.fresh);
    const { updatedAt: _u, minutes: _m, supervision, ...rest } = store.empire;
    const sup = supervision && { ...supervision, observedAt: 0, monitor: { ...supervision.monitor, lastCheckAt: 0 } };
    const managers = SITES.map((site) => {
      const sector = store.empire.sectors.find((s) => s.id === site.id);
      return sector ? managerView(sector, store.queue.tasks, store.workers, ev) : null;
    });
    const next = JSON.stringify([tab, selected, rest, sup, ev.fresh, ev.reason, managers, store.usage, [...store.workers.keys()], store.cloud && [store.cloud.snapshot?.sha, store.cloud.source, store.cloud.error?.code, cloudAge()]]);
    // Freshness ticks only touch the header text; the panel is rebuilt when what it shows changes.
    if (next === signature) return;
    signature = next;
    const active = document.activeElement as HTMLElement | null;
    const key = active && panel.contains(active) ? active.closest('[data-key]')?.getAttribute('data-key') : null;
    const hadFocus = !!active && panel.contains(active);
    const scroll = panel.scrollTop;
    panel.replaceChildren(...content());
    panel.scrollTop = scroll;
    if (hadFocus) {
      const target = key ? panel.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null;
      (target && !target.hasAttribute('disabled') ? target : panel).focus({ preventScroll: true });
    }
  }

  function content(): HTMLElement[] {
    if (tab === 'sectors') return sectors();
    if (tab === 'accounts') return accounts();
    if (tab === 'reports') return reports();
    return overview();
  }

  function overview(): HTMLElement[] {
    const state = store.empire;
    const ev = store.evidence();
    const sup = state.supervision;
    const chief = chiefView(sup, ev);
    const counts = workforceView(sup, ev);
    const hq = state.sectors.find((s) => s.id === 'hq')?.manager;
    const chiefWorker = ev.fresh && sup?.chief.phase === 'needs_input' && sup.chief.workerId && store.workers.has(sup.chief.workerId) ? sup.chief.workerId : null;
    const requested = sup?.delegationRequested ?? state.delegated;
    const economy = state.economy;
    const rate = state.sectors.reduce((sum, sector) => {
      const r = hourlyRates(sector);
      return sum + r.revenue - r.wages - r.upkeep;
    }, 0);
    const usage = store.usage;
    return [
      store.cloud ? cloudSupervision() : h(
        'section.empire-section',
        { 'aria-labelledby': 'empire-supervision' },
        h('h3', { id: 'empire-supervision' }, 'Supervision'),
        h(
          'div.status-cards',
          {},
          statusCard(
            'Chief of staff · job phase',
            chief,
            chiefWorker ? button('chief-terminal', 'Open terminal', () => actions.openTerminal(chiefWorker)) : null,
            hq && ['offline', 'pending'].includes(hq.status) ? button('chief-retry', 'Retry chief startup', () => send({ kind: 'retry-manager', site: 'hq' })) : null,
          ),
          statusCard('Monitoring', monitorView(sup, ev)),
          statusCard(
            'Oversight preference',
            { tone: 'idle', label: delegationLabel(requested), detail: 'A preference only. Permission prompts and approvals always stay with you.' },
            button('delegate', requested ? 'Resume CEO oversight' : 'Request delegation', () => send({ kind: 'delegate', enabled: !requested })),
          ),
        ),
        h(
          'div.empire-metrics',
          { 'aria-label': 'AI workforce' },
          metric('AI agents active', counts ? String(counts.active) : '—'),
          metric('Need your input', counts ? String(counts.attention) : '—'),
          metric('Queued tasks', counts ? String(counts.queued) : '—'),
        ),
        h('div.sector-actions', {}, button('queue', 'Open task queue', actions.openQueue)),
      ),
      h(
        'section.empire-section',
        { 'aria-labelledby': 'empire-credits' },
        h('h3', { id: 'empire-credits' }, 'Simulation credits ', h('span.empire-tag', {}, 'fictional')),
        h(
          'div.empire-metrics',
          {},
          metric('City treasury', `${state.funds.toLocaleString()} cr`),
          metric('Founder wallet', `${economy.ownerBalance.toLocaleString()} cr`),
          metric('Net / city hour', `${rate >= 0 ? '+' : ''}${rate.toLocaleString()} cr`),
          metric('Employee earnings', `${economy.wages.toLocaleString()} cr`),
        ),
        h(
          'div.sector-actions',
          {},
          button('reinvest', 'Reinvest founder earnings', () => send({ kind: 'reinvest' }), { disabled: economy.ownerBalance <= 0 }),
        ),
        h(
          'p.setting-note',
          {},
          'You receive 20% of positive operating profit. A queued task earns 500 simulation credits once when an agent turn ends: 50 worker pay, 90 founder dividend and 360 retained by the city. The turn ending is recorded; its output is not verified. City operations settle every city hour (one minute while the server runs).',
        ),
      ),
      h(
        'section.empire-section',
        { 'aria-labelledby': 'empire-spend' },
        h('h3', { id: 'empire-spend' }, 'Provider spend ', h('span.empire-tag.real', {}, 'real')),
        h(
          'div.empire-metrics',
          {},
          metric('Today', fmtCost(usage.today.cost), usage.budget !== undefined ? `of ${fmtCost(usage.budget)} budget` : undefined),
          metric('All time', fmtCost(usage.total.cost)),
        ),
        h('p.setting-note', {}, store.cloud ? 'Provider-reported list cost recorded by your cloud coordinator; “All time” covers its 90-day ledger. Billed by your provider. Separate from simulation credits.' : 'Estimated from worker sessions and billed by your provider. Separate from simulation credits.'),
      ),
    ];
  }

  /** Cloud mode: the age of the snapshot everything here comes from. */
  function cloudAge() {
    const c = store.cloud;
    return c ? cloudStatus({ snapshot: c.snapshot, source: c.source, checkedAt: c.checkedAt, error: c.error, now: Date.now() }).age || 'unknown' : '';
  }

  /** Cloud mode replaces live supervision with what the coordinator last recorded, and says how old it is. */
  function cloudSupervision(): HTMLElement {
    const c = store.cloud!;
    const view = cloudStatus({ snapshot: c.snapshot, source: c.source, checkedAt: c.checkedAt, error: c.error, now: Date.now() });
    const state = store.empire;
    const hq = state.sectors.find((s) => s.id === 'hq');
    const counts = c.snapshot ? jobCounts(c.snapshot.state) : null;
    const requested = state.delegated;
    return h(
      'section.empire-section',
      { 'aria-labelledby': 'empire-supervision' },
      h('h3', { id: 'empire-supervision' }, 'Supervision ', h('span.empire-tag', {}, 'cloud snapshot')),
      h(
        'div.status-cards',
        {},
        statusCard('Cloud coordinator', view, button('cloud-open', 'Open Cloud Empire', actions.openQueue)),
        statusCard('Chief of staff · HQ manager', hq ? cloudManagerView(hq, view.age || 'unknown') : { tone: 'unknown', label: 'Status unknown', detail: 'Not recorded.' }),
        statusCard(
          'Oversight preference',
          { tone: 'idle', label: delegationLabel(requested), detail: 'A preference only. Paid jobs and reviews always need your confirmation.' },
          button('delegate', requested ? 'Resume CEO oversight' : 'Request delegation', () => send({ kind: 'delegate', enabled: !requested })),
        ),
      ),
      h(
        'div.empire-metrics',
        { 'aria-label': 'Cloud jobs as of the snapshot' },
        metric('Cloud jobs active', counts ? String(counts.active) : '—', view.age ? `as of ${view.age} ago` : undefined),
        metric('Need you', counts ? String(counts.attention + counts.review) : '—'),
        metric('Queued jobs', counts ? String(counts.queued) : '—'),
      ),
    );
  }

  function sectors(): HTMLElement[] {
    const state = store.empire;
    const ev = store.evidence();
    const cards = SITES.filter((site) => !selected || site.id === selected).map((site) => {
      const sector = state.sectors.find((s) => s.id === site.id)!;
      const r = hourlyRates(sector),
        m = sector.manager;
      const act = (kind: 'build' | 'hire' | 'buy-land' | 'upgrade' | 'retry-manager') => send({ kind, site: site.id });
      const view = store.cloud ? cloudManagerView(sector, cloudAge()) : site.id === 'hq' ? chiefView(state.supervision, ev) : managerView(sector, store.queue.tasks, store.workers, ev);
      const blockedWorker = ev.fresh && m?.status === 'needs_input' && m.workerId && store.workers.has(m.workerId) ? m.workerId : null;
      const titleId = `empire-site-${site.id}`;
      return h(
        'article.empire-site',
        { 'aria-labelledby': titleId },
        h('span.empire-eyebrow', {}, site.sector),
        h('h4', { id: titleId }, site.name),
        h(
          'p',
          {},
          sector.built
            ? site.id === 'hq'
              ? `${state.office.floors} operational floors · ${state.office.workstations} furnished workstations. Use HQ to expand; employ AI workers at their desks.`
              : `Level ${sector.level} · ${sector.staff}/${site.capacity} service employees · ${sector.service}% coverage`
            : sector.owned
              ? `Owned parcel · construction ${site.cost.toLocaleString()} cr`
              : `Expansion land · ${site.landCost.toLocaleString()} cr`,
        ),
        sector.built ? h('progress', { max: 100, value: sector.service, 'aria-label': `${site.name} service coverage` }) : null,
        m
          ? h(
              'div.manager-status',
              { 'data-tone': view.tone },
              h('strong', {}, m.name),
              h('div', {}, h('span.status-dot', { 'aria-hidden': 'true' }), view.label),
              h('small', {}, view.detail),
              h(
                'div.sector-actions',
                {},
                blockedWorker ? button(`terminal-${site.id}`, 'Open terminal', () => actions.openTerminal(blockedWorker)) : null,
                button(`queue-${site.id}`, 'View agent queue', actions.openQueue),
              ),
            )
          : null,
        sector.built && site.id !== 'home'
          ? h('p.setting-note', {}, `${r.revenue} revenue − ${r.wages} wages − ${r.upkeep} upkeep / city hour (simulation credits). Lifetime revenue ${sector.revenue.toLocaleString()} cr.`)
          : null,
        h(
          'div.sector-actions',
          {},
          !sector.owned
            ? button(`land-${site.id}`, `Buy land · ${site.landCost.toLocaleString()} cr`, () => act('buy-land'), { disabled: state.funds < site.landCost })
            : !sector.built
              ? button(`build-${site.id}`, `Build · ${site.cost.toLocaleString()} cr`, () => act('build'), { disabled: state.funds < site.cost })
              : null,
          sector.built && site.id !== 'home' && site.id !== 'hq'
            ? button(`hire-${site.id}`, 'Hire employee · 1,200 cr', () => act('hire'), { disabled: sector.staff >= site.capacity || state.funds < 1200 })
            : null,
          sector.built && site.id !== 'home' && site.id !== 'hq' && sector.level < 3
            ? button(`upgrade-${site.id}`, `Upgrade · ${upgradeCost(sector).toLocaleString()} cr`, () => act('upgrade'), { disabled: state.funds < upgradeCost(sector) })
            : null,
          m && ['offline', 'pending'].includes(m.status) ? button(`retry-${site.id}`, 'Retry manager startup', () => act('retry-manager')) : null,
          sector.built ? button(`assign-${site.id}`, 'Assign real AI task', () => actions.assignTask(site.id)) : null,
        ),
      );
    });
    return [
      h('h3.visually-hidden', {}, 'Sectors'),
      h('div.empire-sites', {}, ...cards),
      selected
        ? button('all-sectors', 'Show all sectors', () => {
            selected = undefined;
            signature = '';
            refresh();
          })
        : h('span'),
    ];
  }

  function accounts(): HTMLElement[] {
    const economy = store.empire.economy;
    const payroll = h(
      'details',
      { open: payrollOpen },
      h('summary', { 'data-key': 'payroll' }, `Employee accounts · ${Object.keys(economy.employees).length}`),
      h(
        'div.payroll-grid',
        {},
        ...Object.values(economy.employees).map((employee) =>
          h(
            'article',
            {},
            h('span', {}, employee.name),
            h('small', {}, `${SITES.find((s) => s.id === employee.site)!.name} · ${employee.role}`),
            h('strong', {}, `${employee.earned.toLocaleString()} cr earned`),
          ),
        ),
      ),
    );
    payroll.addEventListener('toggle', () => (payrollOpen = payroll.open));
    return [
      h('h3', {}, 'City accounts ', h('span.empire-tag', {}, 'fictional')),
      h('p.setting-note', {}, 'Gross revenue, wages, upkeep and dividends reconcile to the treasury. Salaries and founder earnings remain simulation credits.'),
      h(
        'div.economy-ledger',
        { tabindex: 0, role: 'region', 'aria-label': 'Recent ledger entries' },
        h(
          'table',
          {},
          h('caption.visually-hidden', {}, 'Latest ten ledger entries, in simulation credits'),
          h('thead', {}, h('tr', {}, ...['Transaction', 'Revenue', 'Wages', 'Upkeep', 'Founder', 'Investment', 'Treasury'].map((label) => h('th', { scope: 'col' }, label)))),
          h(
            'tbody',
            {},
            ...economy.ledger
              .slice(0, 10)
              .map((row) =>
                h(
                  'tr',
                  {},
                  h('th', { scope: 'row' }, row.label),
                  ...[row.revenue, row.wages, row.upkeep, row.dividend, row.capital, row.balance].map((value) => h('td', {}, value.toLocaleString())),
                ),
              ),
          ),
        ),
      ),
      economy.ledger.length ? h('span') : h('p.setting-note', {}, 'Your first completed task or hourly operating close will appear here.'),
      payroll,
    ];
  }

  function reports(): HTMLElement[] {
    const list = store.empire.reports;
    return [
      h('h3', {}, 'Sector reports'),
      h('p.setting-note', {}, 'Written by deterministic server checks and recorded worker outcomes. A report is not proof that an artifact exists or was accepted.'),
      list.length
        ? h(
            'ol.empire-reports',
            {},
            ...list.map((r) =>
              h(
                'li',
                {},
                h('small', {}, h('time', { datetime: new Date(r.at).toISOString() }, new Date(r.at).toLocaleString()), ` · ${r.sector}`),
                h('p', {}, r.text),
              ),
            ),
          )
        : h('p.setting-note', {}, 'No reports yet.'),
    ];
  }

  const offs = (['empire', 'workers', 'queue', 'usage', 'connection'] as const).map((topic) => store.on(topic, refresh));
  // Keeps the freshness label honest while no messages arrive.
  const timer = setInterval(refresh, 1000);
  select(tab, false);
  return modal;
}
