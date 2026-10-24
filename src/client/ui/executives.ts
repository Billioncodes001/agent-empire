import { EXECUTIVES, NOT_STAFFED, type Executive, type ExecutiveRole, type OrgState } from '../../shared/org';
import { store } from '../state';
import { h, openModal } from './dom';
import { morphChildren } from './reconcile';
import { openInbox } from './inbox';
import { researchPanel } from './research';

/** Where each executive's waiting items are handled: the approval inbox (ORG-03) or the task queue. */
const ATTENTION: Partial<Record<ExecutiveRole, { label: (n: number) => string; inbox?: true; queue?: true }>> = {
  chief_of_staff: { label: (n) => `${n} client plan${n === 1 ? '' : 's'} waiting for your approval`, inbox: true },
  operations: { label: (n) => `${n} task${n === 1 ? '' : 's'} held after a dependency failed — retry or remove ${n === 1 ? 'it' : 'them'}`, queue: true },
  finance: { label: (n) => `${n} budget increase${n === 1 ? '' : 's'} waiting — the job reached the approved budget and unstarted items are held`, inbox: true },
  marketing_sales: { label: (n) => `${n} campaign send${n === 1 ? '' : 's'} waiting — review the exact message and every recipient`, inbox: true },
  research: { label: (n) => `${n} tool proposal${n === 1 ? '' : 's'} waiting — approving only records your decision`, inbox: true },
};

/** ORG-04a: leads, campaigns, opt-outs, pause and cancel live on the founder desk page. */
const OUTREACH_DESK = '/consultancy.html#outreach';

export const executiveTitle = (role: ExecutiveRole) => EXECUTIVES[role].title;

/** Plain description of the executive's evidence, so nobody mistakes a rule for a model. */
const RULE_NOTE = 'Rule-based: computed from the live queue, workers, client jobs, provider usage, outreach results and worker reports. No model is called.';
const MODEL_NOTE = 'Model-backed (FREE-02): the chief’s model drafts plans, reviews finished items and suggests how to unblock stalls. Everything it writes is a proposal until you approve it; its status line is still computed from real state.';

/** FREE-02: "Model-backed · <model> · proposals only" while the chief's brain is on; otherwise the honest Rule-based tag. */
export const monitorTag = (e: Pick<Executive, 'monitor' | 'model'>) => (e.monitor === 'model_backed' && e.model ? `Model-backed · ${e.model} · proposals only` : 'Rule-based');

function tone(e: Executive) {
  if (!e.active) return 'unknown';
  return e.attention > 0 ? 'attention' : 'active';
}

/** One executive as a card: role, name, the honest Rule-based label, the summary and what waits on you. */
export function executiveCard(e: Executive, opts: { openQueue?: () => void; beforeInbox?: () => void; heading?: 'h2' | 'strong' } = {}): HTMLElement {
  const att = ATTENTION[e.role];
  const attention = !e.active
    ? h('p.exec-note', {}, 'This office is furnished but nobody works here yet. It arrives in a later phase.')
    : e.attention > 0 && att
      ? h(
          'p.exec-attention',
          {},
          h('span.exec-count', { 'aria-hidden': 'true' }, String(e.attention)),
          h('span', {}, att.label(e.attention)),
          att.inbox ? h('button.btn.exec-link', { type: 'button', 'data-key': 'inbox', 'data-open-inbox': e.role, onclick: () => { opts.beforeInbox?.(); openInbox(); } }, 'Open inbox') : null,
          att.queue && opts.openQueue ? h('button.btn.exec-link', { type: 'button', 'data-key': 'queue', onclick: opts.openQueue }, 'Open task queue') : null,
        )
      : h('p.exec-note', {}, 'Nothing waiting for you.');
  const title = opts.heading === 'h2' ? h('h2', { id: `exec-title-${e.role}` }, e.name) : h('strong', {}, e.name);
  return h(
    'article.exec-card',
    { 'data-tone': tone(e), 'data-role': e.role },
    h('div.exec-head', {}, h('span.empire-eyebrow', {}, executiveTitle(e.role)), h('span.empire-tag', { title: e.monitor === 'model_backed' ? MODEL_NOTE : RULE_NOTE, 'data-monitor': e.monitor }, monitorTag(e))),
    title,
    h('p.exec-summary', {}, h('span.status-dot', { 'aria-hidden': 'true' }), e.active ? e.summary : NOT_STAFFED),
    attention,
    e.monitor === 'model_backed' ? h('p.exec-note.exec-model-note', {}, 'Plans, reviews and unblock ideas from this chief are proposals: nothing starts, is accepted or spends without your approval.') : null,
    e.role === 'marketing_sales' && e.active
      ? h('p.exec-note', {}, 'Coordinates email outreach; workers draft, you approve every send. ', h('a.btn.exec-link', { href: OUTREACH_DESK, target: '_blank', rel: 'noopener' }, 'Leads & campaigns ↗'))
      : null,
  );
}

/** The Management panel's "Executives" section. */
export function executivesSection(org: OrgState | null, cloud: boolean, openQueue?: () => void): HTMLElement {
  const body = cloud
    ? h('p.setting-note', {}, 'Executives run on your own server. They are not available in cloud mode yet.')
    : !org
      ? h('p.setting-note', {}, 'This server has not reported its executives yet.')
      : h('div.exec-cards', {}, ...org.executives.map((e) => executiveCard(e, { openQueue })));
  return h(
    'section.empire-section',
    { 'aria-labelledby': 'empire-executives' },
    h('h3', { id: 'empire-executives' }, 'Executives ', h('span.empire-tag', {}, 'rule-based')),
    body,
    h('p.setting-note', {}, `${RULE_NOTE} Their offices are upstairs in the loft; they never take a funded workstation.`),
  );
}

/** Pressing E at an executive's desk: that executive's card, kept current while it is open. */
export function openExecutiveCard(role: ExecutiveRole, openQueue?: () => void) {
  const slot = h('div.exec-modal-body');
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close executive card' }, '✕');
  const render = () => {
    const e = store.org?.executives.find((x) => x.role === role);
    // Patched in place, so the Open inbox / Open task queue button keeps focus when the org broadcast repeats.
    morphChildren(slot, [
      e
        ? executiveCard(e, { heading: 'h2', openQueue: openQueue && (() => { modal.close(); openQueue(); }), beforeInbox: () => modal.close() })
        : h('p.setting-note', {}, store.cloud ? 'Executives are not available in cloud mode yet.' : 'This server has not reported its executives yet.'),
    ]);
  };
  // ORG-05: the research office also lists its reports and takes questions.
  const panel = role === 'research' ? researchPanel(() => modal.close()) : undefined;
  const modal = openModal(h('div.modal.exec-modal', { role: 'dialog', 'aria-labelledby': `exec-title-${role}`, 'aria-label': executiveTitle(role), 'data-role': role }, h('header', {}, h('small.empire-eyebrow', {}, 'Executive office'), close), slot, panel ? h('div.exec-body.research-body', {}, panel.el) : null), {
    onClose: () => { off(); panel?.dispose(); },
    // ORG-05 review fix 3: Esc in a report steps back to the research list first.
    onEscape: () => panel?.back() ?? false,
  });
  const off = store.on('org', render);
  close.addEventListener('click', () => modal.close());
  render();
  close.focus();
}
