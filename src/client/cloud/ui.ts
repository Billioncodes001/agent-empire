/**
 * Cloud-mode interface: the status strip, the "Cloud Empire" window (status, jobs, new job, limits, journal), the
 * paid-job confirmation, shutdown/start, and the explanatory disabled state of everything that needs a server.
 *
 * Honesty rules (docs/team/CLOUD_MODE_PLAN.md, invariants): every figure is labelled with the snapshot's age, nothing
 * reads as live, paid work needs an explicit confirmation naming the allowance, and city credits stay separate from
 * real provider money.
 */
import { SITES, type SiteId } from '../../shared/empire';
import { CANCELLABLE, cloudStatus, dollars, JOB_LABEL, JOB_TONE, jobCounts, shortAge, snapshotTime, todaySpend } from './map';
import { repoLabel } from './repo';
import type { CloudNet, NewJobRequest } from './net';
import { store } from '../state';
import { h, openModal, toast, type Modal } from '../ui/dom';
import { setMenuExtension } from '../ui/game-menu';
import type { CloudJob, CloudState } from '../../cloud/schema';

type Tab = 'status' | 'jobs' | 'new' | 'limits' | 'journal';
const TABS: [Tab, string][] = [
  ['status', 'Status'],
  ['jobs', 'Jobs'],
  ['new', 'New job'],
  ['limits', 'Limits'],
  ['journal', 'Journal'],
];

/** Things cloud mode cannot do, shown wherever the user meets one of them. */
export const CLOUD_LIMITS = [
  'Reacts in minutes, not seconds: the coordinator runs on a schedule in GitHub Actions, or when this app wakes it.',
  'No live worker terminals, desk workers, service tunnels or local CLI agents.',
  'No office chat, voice or screen sharing; issue and pull request boards are not shown.',
  'Uses your GitHub Actions minutes and your provider’s API usage.',
];

const status = (net: CloudNet) => cloudStatus({ snapshot: net.info.snapshot, source: net.info.source, checkedAt: net.info.checkedAt, error: net.info.error, now: Date.now() });

// ---- Status strip ---------------------------------------------------------------------------------------

/** Replaces the server status strip in cloud mode. Built once; later updates only touch text. */
export function mountCloudStrip(host: HTMLElement, net: CloudNet, open: (tab?: Tab) => void) {
  // The cloud mark is drawn (CSS mask), not the U+2601 text glyph: iOS sets that glyph from a symbol font at a fraction
  // of the text size, too small to read on a phone HUD.
  const labelText = document.createTextNode('');
  const label = h('span.status-value', {}, h('span.cloud-glyph', { 'aria-hidden': 'true' }), labelText);
  const main = h('button.status-row.status-chief', { type: 'button', onclick: () => open('status') }, h('span.status-dot', { 'aria-hidden': 'true' }), h('span.status-key', {}, 'Cloud mode'), label);
  const monitor = h('span.status-monitor');
  const active = h('b'), attention = h('b'), queued = h('b');
  const work = h('button.status-row.status-workforce', { type: 'button', onclick: () => open('jobs') }, h('span.status-key', {}, 'Cloud jobs'), h('span.status-counts', {}, active, ' active · ', attention, ' need you · ', queued, ' queued'));
  const announcer = h('span.visually-hidden', { 'aria-live': 'polite', 'aria-atomic': 'true' });
  host.replaceChildren(main, monitor, work, announcer);
  host.classList.add('cloud-strip');
  let announced = '';
  const render = () => {
    const view = status(net);
    const snap = net.info.snapshot;
    // Phones hide the strip's key and detail line, so the value itself says "cloud" and whether it is a saved copy.
    labelText.data = `${net.info.source === 'saved' ? 'Saved · ' : ''}${view.label}`;
    main.title = view.detail;
    main.setAttribute('aria-label', `Cloud mode: ${view.label}. ${view.detail} Open Cloud Empire.`);
    host.dataset.tone = view.tone;
    const pending = (snap?.pending.length ?? 0) || net.info.sent.length;
    monitor.textContent = snap
      ? `${repoLabel(net.session.repo)} · ${net.info.source === 'saved' ? 'saved snapshot' : `checked ${net.info.checkedAt ? shortAge(Date.now() - net.info.checkedAt) : '—'} ago`}${pending ? ` · ${pending} action${pending === 1 ? '' : 's'} waiting` : ''}${net.info.error ? ` · ${net.info.error.message}` : ''}`
      : net.info.error?.message ?? 'Reading your state repository…';
    const counts = snap ? jobCounts(snap.state) : null;
    active.textContent = counts ? String(counts.active) : '—';
    attention.textContent = counts ? String(counts.attention + counts.review) : '—';
    queued.textContent = counts ? String(counts.queued) : '—';
    work.classList.toggle('attention', !!counts && counts.attention + counts.review > 0);
    work.setAttribute('aria-label', counts ? `Cloud jobs as of the snapshot ${view.age} ago: ${counts.active} active, ${counts.attention + counts.review} need you, ${counts.queued} queued. Open jobs.` : 'Cloud jobs: not loaded yet. Open jobs.');
    if (view.label !== announced) {
      announced = view.label;
      announcer.textContent = `Cloud mode: ${view.label}`;
    }
  };
  store.on('cloud', render);
  setInterval(render, 5000); // ages keep moving without new data
  render();
  return { render };
}

// ---- The Cloud Empire window ----------------------------------------------------------------------------

let openPanel: { select(tab: Tab): void; modal: Modal } | null = null;

export function openCloudPanel(net: CloudNet, initial: Tab = 'status') {
  if (openPanel) return openPanel.select(initial);
  let tab: Tab = initial;
  let signature = '';
  const freshness = h('span.empire-freshness');
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close Cloud Empire' }, '✕');
  const tabs = TABS.map(([id, label]) => h('button.empire-tab', { type: 'button', role: 'tab', id: `cloud-tab-${id}`, 'aria-controls': 'cloud-panel', onclick: () => select(id, false) }, label));
  const tablist = h('div.empire-tabs', { role: 'tablist', 'aria-label': 'Cloud Empire sections' }, ...tabs);
  const panel = h('div.body.empire-body', { role: 'tabpanel', id: 'cloud-panel', tabindex: 0 });
  tablist.addEventListener('keydown', (e) => {
    const i = TABS.findIndex(([id]) => id === tab);
    const next = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(TABS[next][0], true);
  });
  const modal = openModal(
    h(
      'div.modal.empire-modal.cloud-modal',
      { role: 'dialog', 'aria-labelledby': 'cloud-title' },
      h('header', {}, h('div.empire-heading', {}, h('small.empire-eyebrow', {}, `Cloud mode · ${repoLabel(net.session.repo)}`), h('h2', { id: 'cloud-title' }, 'Cloud Empire')), freshness, close),
      tablist,
      panel,
    ),
    {
      onClose: () => {
        off();
        clearInterval(timer);
        openPanel = null;
      },
    },
  );
  close.onclick = () => modal.close();

  function select(id: Tab, focus: boolean) {
    tab = id;
    for (const [i, [tabId]] of TABS.entries()) {
      tabs[i].setAttribute('aria-selected', String(tabId === tab));
      tabs[i].tabIndex = tabId === tab ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', `cloud-tab-${tab}`);
    panel.scrollTop = 0;
    signature = '';
    refresh();
    if (focus) tabs[TABS.findIndex(([t]) => t === tab)].focus();
  }

  function refresh() {
    const view = status(net);
    freshness.textContent = net.info.snapshot ? `${view.label} · not live` : view.label;
    freshness.classList.toggle('stale', view.tone !== 'idle');
    // Forms keep what the user typed: they are rebuilt only when the tab changes.
    if ((tab === 'new' || tab === 'limits') && signature) return;
    const next = JSON.stringify([tab, net.info.snapshot?.sha, net.info.source, net.info.busy, net.info.sent.map((s) => s.id), net.info.snapshot?.pending, net.info.error?.code]);
    if (next === signature) return;
    signature = next;
    const scroll = panel.scrollTop;
    panel.replaceChildren(...content());
    panel.scrollTop = scroll;
  }

  function content(): HTMLElement[] {
    const snap = net.info.snapshot;
    if (!snap)
      return [h('p.setting-note', {}, net.info.error ? net.info.error.message : 'Reading your Empire from GitHub…'), h('div.sector-actions', {}, button('retry', 'Check GitHub again', () => net.reconnectNow()))];
    if (tab === 'jobs') return jobsTab(net, snap.state, () => select('new', true));
    if (tab === 'new') return newJobTab(net, snap.state);
    if (tab === 'limits') return limitsTab(net, snap.state);
    if (tab === 'journal') return journalTab(snap.state);
    return statusTab(net, snap.state);
  }

  const off = store.on('cloud', refresh);
  const timer = setInterval(refresh, 5000);
  openPanel = { select: (t) => select(t, true), modal };
  select(tab, false);
}

const button = (key: string, label: string, onclick: () => void, attrs: Record<string, unknown> = {}) => h('button.btn', { type: 'button', 'data-key': key, onclick, ...attrs }, label);
const metric = (label: string, value: string, note?: string) => h('div.empire-metric', {}, h('strong', {}, value), h('span', {}, label), note ? h('small', {}, note) : null);
const card = (title: string, tone: string, label: string, detail: string, ...controls: (HTMLElement | null)[]) =>
  h('article.status-card', { 'data-tone': tone }, h('span.empire-eyebrow', {}, title), h('strong', {}, h('span.status-dot', { 'aria-hidden': 'true' }), label), h('p', {}, detail), controls.some(Boolean) ? h('div.sector-actions', {}, ...controls) : null);

function statusTab(net: CloudNet, state: CloudState): HTMLElement[] {
  const view = status(net);
  const meta = state.meta;
  const counts = jobCounts(state);
  const spend = todaySpend(state, Date.now());
  const lifecycle = meta.lifecycle.status;
  const waiting = net.info.sent.filter((s) => s.kind === 'shutdown' || s.kind === 'start');
  const control =
    lifecycle === 'running'
      ? button('shutdown', 'Shut down Empire', () => confirmShutdown(net), { class: 'btn danger', disabled: net.info.busy || waiting.some((s) => s.kind === 'shutdown') })
      : lifecycle === 'shutdown'
        ? button('start', 'Start Empire', () => confirmStart(net), { class: 'btn primary', disabled: net.info.busy || waiting.some((s) => s.kind === 'start') })
        : null;
  const execution = meta.execution;
  return [
    h(
      'section.empire-section',
      {},
      h('h3', {}, 'Coordinator'),
      h(
        'div.status-cards',
        {},
        card('Empire', view.tone, view.label, view.detail, control),
        card(
          'Waiting actions',
          waiting.length || net.info.sent.length ? 'attention' : 'idle',
          `${state === net.info.snapshot?.state ? net.info.snapshot!.pending.length : 0} in the repository`,
          net.info.sent.length ? `Sent from this device: ${net.info.sent.map((s) => `${s.label} (${shortAge(Date.now() - s.at)} ago)`).join(', ')}. Applied on the coordinator’s next run.` : 'Nothing sent from this device is waiting.',
          button('wake', 'Check GitHub now', () => net.reconnectNow()),
        ),
        card(
          'Agent execution',
          execution ? 'idle' : 'attention',
          execution ? `${execution.repository.owner}/${execution.repository.name}` : 'Not configured',
          execution ? `Anthropic Managed Agents on ${execution.repository.baseBranch}. Work arrives as branches and pull requests.` : 'Jobs wait until execution is configured under Limits.',
        ),
      ),
      h(
        'div.empire-metrics',
        { 'aria-label': `Jobs as of the snapshot ${view.age} ago` },
        metric('Active jobs', String(counts.active), 'as of snapshot'),
        metric('Need you', String(counts.attention + counts.review), `${counts.review} ready for review`),
        metric('Queued', String(counts.queued)),
        metric('Spent today (UTC)', dollars(spend.observedCents), `${dollars(spend.reservedCents)} reserved of ${dollars(spend.dailyCents)}`),
      ),
    ),
    h(
      'section.empire-section',
      {},
      h('h3', {}, 'Schedule and costs ', h('span.empire-tag.real', {}, 'real')),
      h('p.setting-note', {}, `Runs every ${meta.schedule.intervalMinutes} minutes: about ${meta.schedule.runsPerMonth.toLocaleString()} scheduled runs and ${meta.schedule.billedMinutesPerMonth.toLocaleString()} billed GitHub Actions minutes a month (an estimate; each run bills at least one minute). Waking the coordinator from the app adds runs. Provider usage is billed by your provider. Changing the schedule means running setup again.`),
      h('p.setting-note', {}, `Limits: ${meta.limits.maxConcurrent} job${meta.limits.maxConcurrent === 1 ? '' : 's'} at once · ${dollars(meta.limits.perTaskBudgetCents)} allowance per job · ${dollars(meta.limits.dailyBudgetCents)} admitted per UTC day. The coordinator enforces them before it starts anything.`),
    ),
    h('section.empire-section', {}, h('h3', {}, 'Not available in cloud mode'), h('ul.cloud-limits', {}, ...CLOUD_LIMITS.map((t) => h('li', {}, t))), h('p.setting-note', {}, 'Connect your own server (Menu → Forget this device, then set up again) for live terminals and full capabilities.')),
  ];
}

function jobRow(net: CloudNet, job: CloudJob): HTMLElement {
  const tone = JOB_TONE[job.status];
  const busy = net.info.busy;
  const sent = net.info.sent.some((s) => s.jobId === job.id);
  const site = job.site ? SITES.find((s) => s.id === job.site)?.name : undefined;
  const actions: HTMLElement[] = [];
  if (job.status === 'awaiting_review') {
    actions.push(
      button(`accept-${job.id}`, 'Accept', () => void net.submit({ kind: 'review', jobId: job.id, decision: 'accept' }, `Accept “${job.title.slice(0, 40)}”`), { disabled: busy || sent }),
      button(`reject-${job.id}`, 'Reject', () => void net.submit({ kind: 'review', jobId: job.id, decision: 'reject' }, `Reject “${job.title.slice(0, 40)}”`), { disabled: busy || sent }),
    );
  }
  if (CANCELLABLE.includes(job.status))
    actions.push(
      button(`cancel-${job.id}`, 'Cancel', () =>
        confirm(`Cancel “${job.title}”?`, 'The coordinator stops the provider session on its next run. Work already pushed to its branch stays there. Usage so far is still billed by your provider.', 'Cancel job', () =>
          void net.submit({ kind: 'cancel', jobId: job.id }, `Cancel “${job.title.slice(0, 40)}”`),
        ), { disabled: busy || sent }),
    );
  const cost = job.cost ? `${dollars(job.cost.amountCents)} used (provider list cost)` : job.reservation ? `${dollars(job.reservation.cents)} reserved` : `up to ${dollars(job.authorizedCents)} authorized`;
  return h(
    'li.cloud-job',
    { 'data-tone': tone, 'data-job': job.id },
    h('div.cloud-job-head', {}, h('span.status-dot', { 'aria-hidden': 'true' }), h('strong', {}, job.title), h('span.cloud-pill', {}, JOB_LABEL[job.status])),
    h('p', {}, [site, job.message, cost, job.branchHead ? `branch ${job.branch} @ ${job.branchHead.sha.slice(0, 7)} (pushed; not verified)` : null, `updated ${shortAge(Date.now() - job.updatedAt)} ago`].filter(Boolean).join(' · ')),
    job.status === 'dispatch_uncertain' ? h('p.setting-note', {}, 'The start was interrupted after the paid request; check the provider Console before retrying so nothing runs twice.') : null,
    actions.length ? h('div.sector-actions', {}, ...actions) : null,
  );
}

function jobsTab(net: CloudNet, state: CloudState, openNew: () => void): HTMLElement[] {
  const jobs = [...state.jobs.jobs].sort((a, b) => b.createdAt - a.createdAt);
  const { at } = snapshotTime(state);
  return [
    h('h3', {}, 'Jobs ', h('span.empire-tag', {}, `as of ${shortAge(Date.now() - at)} ago`)),
    h('p.setting-note', {}, 'Each job is one provider session on a branch of your project. A finished turn is ready for review; accepting pays the 500 simulation-credit reward once. Neither verifies the code.'),
    jobs.length ? h('ul.cloud-jobs', {}, ...jobs.map((j) => jobRow(net, j))) : h('p.setting-note', {}, 'No jobs yet.'),
    h('div.sector-actions', {}, button('new-job', 'New job…', openNew)),
  ];
}

function field(label: string, control: HTMLElement, hint?: string) {
  return h('label.cloud-field', {}, h('span', {}, label), control, hint ? h('small', {}, hint) : null);
}

function newJobTab(net: CloudNet, state: CloudState, preset: Partial<NewJobRequest> = {}): HTMLElement[] {
  const title = h('input', { type: 'text', maxlength: 120, value: preset.title ?? '', placeholder: 'e.g. Fix the checkout total rounding', 'aria-label': 'Job title' }) as HTMLInputElement;
  const prompt = h('textarea', { rows: 6, maxlength: 20000, placeholder: 'What should the agent do? It works on a new branch and opens nothing on your default branch.', 'aria-label': 'Instructions' }) as HTMLTextAreaElement;
  prompt.value = preset.prompt ?? '';
  const site = h('select', { 'aria-label': 'Sector' }, h('option', { value: '' }, 'No sector'), ...state.empire.sectors.filter((s) => s.built).map((s) => h('option', { value: s.id }, SITES.find((x) => x.id === s.id)!.name))) as HTMLSelectElement;
  if (preset.site) site.value = preset.site;
  const next = h('button.btn.primary', { type: 'submit' }, 'Review cost…');
  const form = h(
    'form.cloud-form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        const t = title.value.trim() || prompt.value.trim().slice(0, 90);
        if (!prompt.value.trim()) return prompt.focus();
        openCloudJobDialog(net, { title: t, prompt: prompt.value.trim(), site: site.value || undefined });
      },
    },
    field('Title', title),
    field('Instructions', prompt),
    field('Sector', site, 'Optional. Links the job to a sector manager.'),
    h('div.sector-actions', {}, next),
  );
  return [h('h3', {}, 'New paid job ', h('span.empire-tag.real', {}, 'real')), form];
}

/** The explicit paid-work confirmation. Nothing is sent before the user ticks it. */
export function openCloudJobDialog(net: CloudNet, request: NewJobRequest) {
  const snap = net.info.snapshot;
  if (!snap) return toast('Your Empire hasn’t loaded from GitHub yet, so a job can’t be checked against your limits.', 'warn');
  const state = snap.state;
  if (state.meta.lifecycle.status !== 'running') return toast('Your Empire is shut down. Start it from the menu before adding jobs.', 'warn');
  const spend = todaySpend(state, Date.now());
  const { at } = snapshotTime(state);
  const tick = h('input', { type: 'checkbox', id: 'cloud-confirm-paid' }) as HTMLInputElement;
  const go = h('button.btn.primary', { type: 'button', disabled: true }, 'Start paid job');
  const cancel = h('button.btn', { type: 'button' }, 'Never mind');
  tick.addEventListener('change', () => (go.disabled = !tick.checked));
  const site = request.site && SITES.some((s) => s.id === request.site) ? (request.site as SiteId) : undefined;
  const rows: [string, string][] = [
    ['Job', request.title],
    ['Allowance', `Up to ${dollars(spend.perJobCents)} is reserved for this job; the provider stops it at that budget (it can overshoot slightly between requests).`],
    ['Today (UTC)', `${dollars(spend.reservedCents)} reserved and ${dollars(spend.observedCents)} used of ${dollars(spend.dailyCents)} a day. If today is full, the job waits.`],
    ['Billing', 'Billed by Anthropic to your API account, plus GitHub Actions minutes. City credits are not involved.'],
    ['Where', state.meta.execution ? `${state.meta.execution.repository.owner}/${state.meta.execution.repository.name}, on a new branch` : 'Execution is not configured: the job will wait until it is (Limits tab).'],
    ['Checked against', `Your limits as of the snapshot ${shortAge(Date.now() - at)} ago (revision ${state.meta.configRevision}). If they changed since, the coordinator refuses the job and nothing is charged.`],
  ];
  const modal = openModal(
    h(
      'div.modal.ae-dark.cloud-confirm',
      { role: 'alertdialog', 'aria-labelledby': 'cloud-confirm-title' },
      h('header', {}, h('h2', { id: 'cloud-confirm-title' }, 'Start a paid job?')),
      h('div.body', {}, h('dl.cloud-dl', {}, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])), h('label.cloud-check', { for: 'cloud-confirm-paid' }, tick, h('span', {}, `I confirm this paid job with an allowance of ${dollars(spend.perJobCents)}.`))),
      h('footer', {}, cancel, go),
    ),
  );
  cancel.onclick = () => modal.close();
  go.onclick = () => {
    if (!tick.checked) return;
    modal.close();
    void net.submit(
      { kind: 'new_job', job: { id: net.newJobId(), title: request.title.slice(0, 120), prompt: request.prompt, ...(site ? { site } : {}), configRevision: state.meta.configRevision, confirmPaid: true } },
      `New job “${request.title.slice(0, 40)}”`,
    );
  };
  setTimeout(() => tick.focus(), 30);
}

function limitsTab(net: CloudNet, state: CloudState): HTMLElement[] {
  const l = state.meta.limits;
  const conc = h('input', { type: 'number', min: 1, max: 10, step: 1, value: String(l.maxConcurrent), 'aria-label': 'Jobs at once' }) as HTMLInputElement;
  const per = h('input', { type: 'text', inputmode: 'decimal', value: (l.perTaskBudgetCents / 100).toFixed(2), 'aria-label': 'Allowance per job in dollars' }) as HTMLInputElement;
  const day = h('input', { type: 'text', inputmode: 'decimal', value: (l.dailyBudgetCents / 100).toFixed(2), 'aria-label': 'Daily allowance in dollars' }) as HTMLInputElement;
  const errors = h('p.setting-note.cloud-error', { role: 'alert' });
  const cents = (v: string) => (/^\$?\d{1,9}(\.\d{1,2})?$/.test(v.trim()) ? Math.round(Number(v.trim().replace('$', '')) * 100) : NaN);
  const limitsForm = h(
    'form.cloud-form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        const limits = { maxConcurrent: Number(conc.value), perTaskBudgetCents: cents(per.value), dailyBudgetCents: cents(day.value) };
        if (!Number.isInteger(limits.maxConcurrent) || limits.maxConcurrent < 1 || limits.maxConcurrent > 10 || !(limits.perTaskBudgetCents >= 1 && limits.perTaskBudgetCents <= 100_000) || !(limits.dailyBudgetCents >= limits.perTaskBudgetCents && limits.dailyBudgetCents <= 10_000_000)) {
          errors.textContent = 'Use 1–10 jobs at once, $0.01–$1,000.00 per job, and a daily allowance of at least the per-job allowance.';
          return;
        }
        errors.textContent = '';
        void net.submit({ kind: 'limits', limits, configRevision: state.meta.configRevision }, 'New spending limits');
      },
    },
    h('div.cloud-row', {}, field('Jobs at once', conc), field('Per job ($)', per), field('Per UTC day ($)', day)),
    errors,
    h('div.sector-actions', {}, h('button.btn.primary', { type: 'submit', disabled: net.info.busy }, 'Save limits')),
  );
  const ex = state.meta.execution;
  const owner = h('input', { type: 'text', value: ex?.repository.owner ?? '', placeholder: 'owner', 'aria-label': 'Project owner' }) as HTMLInputElement;
  const name = h('input', { type: 'text', value: ex?.repository.name ?? '', placeholder: 'repository', 'aria-label': 'Project repository' }) as HTMLInputElement;
  const base = h('input', { type: 'text', value: ex?.repository.baseBranch ?? 'main', 'aria-label': 'Base branch' }) as HTMLInputElement;
  const agent = h('input', { type: 'text', value: ex?.anthropic.agentId ?? '', placeholder: 'agent_…', 'aria-label': 'Anthropic agent ID' }) as HTMLInputElement;
  const env = h('input', { type: 'text', value: ex?.anthropic.environmentId ?? '', placeholder: 'env_…', 'aria-label': 'Anthropic environment ID' }) as HTMLInputElement;
  const exErr = h('p.setting-note.cloud-error', { role: 'alert' });
  const execForm = h(
    'form.cloud-form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        const execution = { provider: 'anthropic' as const, repository: { owner: owner.value.trim(), name: name.value.trim(), baseBranch: base.value.trim() }, anthropic: { agentId: agent.value.trim(), environmentId: env.value.trim() } };
        exErr.textContent = '';
        void net.submit({ kind: 'configure', execution, configRevision: state.meta.configRevision }, 'Execution settings').then((id) => {
          if (!id) exErr.textContent = 'Not sent. Check the repository and the Anthropic IDs (agent_…, env_…).';
        });
      },
    },
    h('div.cloud-row', {}, field('Owner', owner), field('Repository', name), field('Base branch', base)),
    h('div.cloud-row', {}, field('Agent ID', agent), field('Environment ID', env)),
    exErr,
    h('div.sector-actions', {}, h('button.btn', { type: 'submit', disabled: net.info.busy }, 'Save execution settings')),
  );
  return [
    h('section.empire-section', {}, h('h3', {}, 'Spending limits ', h('span.empire-tag.real', {}, 'real')), h('p.setting-note', {}, `Revision ${state.meta.configRevision}. Changing limits makes jobs confirmed under older limits wait for a new confirmation.`), limitsForm),
    h('section.empire-section', {}, h('h3', {}, 'Agent execution'), h('p.setting-note', {}, 'References only: the Anthropic agent and environment, and the project repository jobs run on. Keys stay in your GitHub Actions secrets.'), execForm),
  ];
}

function journalTab(state: CloudState): HTMLElement[] {
  const entries = [...state.journal.entries].reverse().slice(0, 80);
  return [
    h('h3', {}, 'Coordinator journal'),
    h('p.setting-note', {}, 'Recorded by the coordinator in your state repository. A record is not proof that an artifact exists or works.'),
    entries.length
      ? h('ol.empire-reports', {}, ...entries.map((e) => h('li', {}, h('small', {}, h('time', { datetime: new Date(e.at).toISOString() }, new Date(e.at).toLocaleString()), ` · ${e.kind.replace(/_/g, ' ')}`), h('p', {}, e.message))))
      : h('p.setting-note', {}, 'Nothing recorded yet. The first entries appear after the coordinator’s first run.'),
  ];
}

function confirm(title: string, body: string, label: string, run: () => void, danger = true) {
  const yes = h(danger ? 'button.btn.danger' : 'button.btn.primary', { type: 'button' }, label);
  const no = h('button.btn', { type: 'button' }, 'Never mind');
  const modal = openModal(h('div.modal.ae-dark.cloud-confirm', { role: 'alertdialog', 'aria-label': title }, h('header', {}, h('h2', {}, title)), h('div.body', {}, ...body.split('\n').map((p) => h('p', {}, p))), h('footer', {}, no, yes)));
  no.onclick = () => modal.close();
  yes.onclick = () => {
    modal.close();
    run();
  };
  setTimeout(() => no.focus(), 30);
}

export function confirmShutdown(net: CloudNet) {
  const live = net.info.snapshot ? jobCounts(net.info.snapshot.state).active : 0;
  confirm(
    'Shut down your Empire?',
    [
      `Active cloud sessions are interrupted and archived${live ? ` (${live} recorded as active)` : ''}. Work already pushed to branches stays; jobs ready for review stay reviewable.`,
      'Then the coordinator workflow is disabled: no scheduled runs, no Actions minutes, no new provider spending.',
      'City time stops. There is no catch-up revenue for the time it is shut down.',
      'It takes effect on the coordinator’s next run (usually within minutes). Start it again from the menu at any time.',
    ].join('\n'),
    'Shut down Empire',
    () => void net.shutdown(),
  );
}

export function confirmStart(net: CloudNet) {
  confirm(
    'Start your Empire?',
    ['This re-enables the coordinator workflow in your GitHub and records a start. Scheduled runs and Actions minutes resume; queued jobs may start within your limits.', 'City time restarts from now, with no catch-up for the time it was shut down.'].join('\n'),
    'Start Empire',
    () => void net.start(),
    false,
  );
}

// ---- Server-only features --------------------------------------------------------------------------------

const SERVER_ONLY_BUTTONS: [string, string][] = [
  ['btn-voice', 'Voice chat'],
  ['btn-share', 'Screen sharing'],
  ['btn-issues', 'The issues board'],
  ['btn-pulls', 'The pull requests board'],
  ['btn-services', 'Worker services and tunnels'],
  ['btn-team', 'Inviting teammates'],
  ['btn-upgrade', 'Upgrading the office server'],
  ['btn-decor', 'Pictures on the office walls'],
];

export function explainServerOnly(feature: string) {
  const ok = h('button.btn.primary', { type: 'button' }, 'OK');
  const modal = openModal(
    h(
      'div.modal.ae-dark.cloud-confirm',
      { role: 'dialog', 'aria-labelledby': 'cloud-only-title' },
      h('header', {}, h('h2', { id: 'cloud-only-title' }, 'Needs your own server')),
      h('div.body', {}, h('p', {}, `${feature} needs a connected Agent Empire server. In cloud mode your agents run in the provider’s cloud from your GitHub, so there is no live office here.`), h('p.setting-note', {}, 'Give your Empire work from Management → Sectors → “Assign real AI task”, or from Cloud Empire → New job.')),
      h('footer', {}, ok),
    ),
  );
  ok.onclick = () => modal.close();
  setTimeout(() => ok.focus(), 30);
}

/**
 * Turns the HUD into its cloud form: server-only buttons are marked unavailable and explain themselves, the queue
 * opens cloud jobs, and the game menu gains Cloud Empire, Shut down / Start, and "Forget this device".
 */
export function installCloudChrome(net: CloudNet, opts: { forgetDevice(): void }) {
  document.documentElement.classList.add('ae-cloud');
  net.hooks.newJob = (req) => openCloudJobDialog(net, req);
  net.hooks.serverOnly = explainServerOnly;
  for (const [id, feature] of SERVER_ONLY_BUTTONS) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.setAttribute('aria-disabled', 'true');
    b.classList.add('cloud-unavailable');
    b.title = `${feature}: needs your own server (not available in cloud mode)`;
    // Capture phase, before the button's own handler: nothing reaches the (absent) server.
    b.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        explainServerOnly(feature);
      },
      true,
    );
  }
  setMenuExtension({
    items: () => {
      const life = net.info.snapshot?.state.meta.lifecycle.status;
      return [
        { label: 'Cloud Empire', detail: 'Jobs, limits, journal and snapshot age', run: () => openCloudPanel(net) },
        life === 'shutdown'
          ? { label: 'Start Empire', detail: 'Re-enable the coordinator in your GitHub', run: () => confirmStart(net), cls: '.primary' }
          : { label: 'Shut down Empire', detail: life === 'shutting_down' ? 'Shutdown in progress' : 'Stop sessions and the coordinator', run: () => confirmShutdown(net), cls: '.danger' },
      ];
    },
    signOut: {
      label: 'Forget this device',
      detail: 'Your Empire keeps running in your GitHub',
      run: () =>
        confirm(
          'Forget this device?',
          'This removes the GitHub sign-in and the saved snapshot from this device. Your Empire keeps running in your GitHub; to stop it, use “Shut down Empire” first.',
          'Forget this device',
          opts.forgetDevice,
        ),
    },
  });
}
