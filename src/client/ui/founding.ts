import { STARTER_SITES, SITES, hourlyRates, newSector, MANAGER_NAMES, type SiteId } from '../../shared/empire';
import { store } from '../state';
import type { Net } from '../net';
import { CloudNet } from '../cloud/net';
import { foundingBriefs, foundingSpend } from '../cloud/founding-plan';
import { dollars, executionStatus } from '../cloud/map';
import { h, openModal } from './dom';

/** Founding copy that differs between a server (or this computer) and cloud mode. */
export const FOUNDING_COPY = {
  server: {
    included: 'Rule-based server checks report on every sector; your chief of staff’s agent jobs and any blocked work come back to you for decisions.',
    billing: 'Starting buildings are a one-time grant. Unselected sites can be built later. City revenue, salaries and founder dividends are simulation credits; real agent work uses your configured AI account and its usage budget.',
    footer: 'Queues real AI work using your configured account.',
  },
  cloud: {
    included: (minutes: number) =>
      `Your coordinator runs in your own GitHub (GitHub Actions, about every ${minutes} minutes, or sooner when this app wakes it). On each run it records every sector and job in your state repository; what you see here is its last snapshot, never live. Your chief of staff’s jobs and any blocked work come back to you for decisions.`,
    billing: 'Starting buildings are a one-time grant. Unselected sites can be built later. City revenue, salaries and founder dividends are simulation credits. Startup jobs are real paid work: billed by Anthropic to your API account, plus GitHub Actions minutes.',
  },
} as const;

/** Shared city setup runs once on the server (or the cloud coordinator), immediately after the founder's character step. */
export function openFounding(net: Net) {
  const cloud = net instanceof CloudNet ? net : null;
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
  const included = h('p', {}, FOUNDING_COPY.server.included);
  const billing = h('p.setting-note', {}, FOUNDING_COPY.server.billing);
  const footerNote = h('span', {}, FOUNDING_COPY.server.footer);
  // Cloud mode: the same explicit paid-work confirmation as any other cloud job (cloud/ui.ts).
  const paidTick = h('input', { type: 'checkbox', id: 'founding-confirm-paid' }) as HTMLInputElement;
  const paidText = h('span');
  const paid = h('label.cloud-check.founding-paid', { for: 'founding-confirm-paid' }, paidTick, paidText);
  paid.hidden = true;
  paidTick.onchange = () => refresh();
  let pending = false,
    closed = false,
    confirmedTerms = '';

  /** What cloud founding would send now, from the latest snapshot; null outside cloud mode. */
  const cloudPlan = () => {
    if (!cloud) return null;
    const state = cloud.info.snapshot?.state;
    if (!state) return { state: null, briefs: [], spend: null, blocked: 'Waiting for your Empire to load from GitHub…' } as const;
    // Without execution settings the coordinator refuses new jobs: founding then records the plan only.
    const briefs = executionStatus(state).canSubmit ? foundingBriefs(state.empire, selected) : [];
    const blocked = state.meta.lifecycle.status !== 'running' ? 'Your Empire is shut down. Start it from the menu before founding your city.' : '';
    return { state, briefs, spend: foundingSpend(state, briefs.length, Date.now()), blocked } as const;
  };

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
    estimate.textContent = `Projected operating result: ${netRate >= 0 ? '+' : ''}${netRate} cr / city hour, after managers start. Queued tasks earn additional simulation credits once when an agent turn ends; their output is not verified.`;
    const plan = cloudPlan();
    if (!plan) {
      usage.textContent = `Appointing managers queues ${1 + selected.size} startup briefs. They respect the existing queue’s concurrency and spending limits. Buildings open when their assigned manager starts; paused or disconnected agents remain clearly marked.`;
      submit.disabled = pending || !net.up;
      submit.textContent = pending ? 'Saving your founding plan…' : 'Found my city & appoint managers';
      return;
    }
    const { state, briefs, spend, blocked } = plan;
    if (state) included.textContent = FOUNDING_COPY.cloud.included(state.meta.schedule.intervalMinutes);
    billing.textContent = FOUNDING_COPY.cloud.billing;
    const jobs = briefs.length;
    paid.hidden = !jobs;
    footerNote.hidden = !!jobs; // the confirmation takes the footer note's place, next to the button it unlocks
    if (!state || !spend) {
      usage.textContent = blocked;
      footerNote.textContent = 'Nothing is sent until your Empire has loaded.';
    } else if (!state.meta.execution || !executionStatus(state).canSubmit) {
      const exec = executionStatus(state);
      usage.textContent = `${exec.kind === 'setting_up' ? 'Cloud execution is still being set up by your coordinator' : exec.kind === 'failed' ? 'Cloud execution setup needs you (Cloud Empire → Limits)' : 'Cloud execution is not set up yet (Cloud Empire → Limits)'}, so founding queues no paid jobs: it records your plan only. Assign each manager’s startup brief later from Management → Sectors; every job is confirmed and paid separately.`;
      footerNote.textContent = 'Records your founding plan. No paid jobs.';
    } else {
      const repo = `${state.meta.execution.repository.owner}/${state.meta.execution.repository.name}`;
      usage.textContent =
        `Appointing managers queues ${jobs} paid cloud job${jobs === 1 ? '' : 's'} (one startup brief each) on new branches of ${repo}. ` +
        `Each job has an allowance of up to ${dollars(spend.perJobCents)}, so up to ${dollars(spend.totalCents)} in all. ` +
        `Today (UTC) ${dollars(spend.reservedCents)} is reserved and ${dollars(spend.observedCents)} used of your ${dollars(spend.dailyCents)} daily allowance` +
        `${spend.fitsToday ? '' : `; jobs that don’t fit the ${dollars(spend.leftTodayCents)} left today wait for the next UTC day`}. ` +
        `At most ${spend.maxConcurrent} run at once. Your coordinator enforces these limits (revision ${state.meta.configRevision}) before it starts anything.`;
      // A confirmation covers the terms it named; new limits, a new revision or another job count need a new tick.
      const terms = `${jobs}:${spend.perJobCents}:${state.meta.configRevision}`;
      if (terms !== confirmedTerms) paidTick.checked = false;
      confirmedTerms = terms;
      paidText.textContent = `I confirm ${jobs} paid job${jobs === 1 ? '' : 's'} with an allowance of ${dollars(spend.perJobCents)} each (up to ${dollars(spend.totalCents)}).`;
      footerNote.textContent = `Queues ${jobs} paid cloud job${jobs === 1 ? '' : 's'} through your GitHub coordinator.`;
    }
    if (!pending) error.textContent = blocked && state ? blocked : '';
    submit.disabled = pending || !state || !!blocked || cloud!.info.busy || (jobs > 0 && !paidTick.checked);
    submit.textContent = pending ? 'Sending your founding plan…' : jobs ? `Found my city & queue ${jobs} paid job${jobs === 1 ? '' : 's'}` : 'Found my city';
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
      { role: 'dialog', 'aria-label': 'Found your city', ...(cloud ? { 'data-mode': 'cloud' } : {}) },
      h('header', {}, h('div', {}, h('small', {}, 'FOUNDER SETUP / YOUR STARTING DISTRICT'), h('h2', {}, 'Your work. Your city.'))),
      h(
        'div.body',
        {},
        h(
          'p.founding-intro',
          {},
          'Choose the places that will be ready on day one. Their AI managers prepare a brief for your project, then take on the real work you assign.',
        ),
        h('div.founding-included', {}, h('strong', {}, 'Always included'), h('span', {}, 'Headquarters · Private residence · Chief of staff'), included),
        cards,
        summary,
        estimate,
        billing,
        usage,
        error,
      ),
      h('footer', {}, footerNote, paid, submit),
    ),
    {
      escCloses: false,
      backdropCloses: false,
      onClose: () => {
        closed = true;
        off();
        offNet();
        offStatus();
        offCloud();
      },
    },
  );
  const off = store.on('empire', () => {
    if (store.empire.setup.completed) modal.close();
    else refresh();
  });
  const offCloud = cloud ? store.on('cloud', () => !closed && refresh()) : () => {};
  const offNet = net.onMessage((msg) => {
    if (!closed && pending && msg.t === 'toast' && msg.level === 'error') {
      pending = false;
      error.textContent = msg.text;
      refresh();
    }
  });
  const offStatus = net.onStatus((up) => {
    if (cloud) return refresh(); // cloud mode has its own connection banner; founding needs a loaded snapshot instead
    if (!up) {
      pending = false;
      error.textContent = 'Reconnecting to your city…';
    } else error.textContent = '';
    refresh();
  });
  submit.onclick = () => {
    if (cloud) return void foundInCloud(cloud);
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
  /** Writes the plan as intents through the cloud adapter; never the server's empire.action path. */
  const foundInCloud = async (cloud: CloudNet) => {
    const plan = cloudPlan();
    if (pending || !plan?.state || plan.blocked || (plan.briefs.length && !paidTick.checked)) return;
    pending = true;
    error.textContent = '';
    refresh();
    const result = await cloud.found([...selected], plan.briefs, plan.state.meta.configRevision);
    pending = false;
    if (closed) return;
    if (!result.founded) {
      error.textContent = 'Your founding plan was not sent. Check your connection to GitHub and try again.';
      return refresh();
    }
    // The coordinator applies the plan on its next run; the city updates from that snapshot.
    modal.close();
  };
  refresh();
}
