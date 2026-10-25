import { APPROVAL_KIND_LABEL, MAX_APPROVAL_BUDGET_USD, approvalFingerprint, approveHint, type Approval } from '../../shared/approvals';
import { ORG_CAPABILITIES, cloudMissingKinds } from '../../shared/org-capabilities';
import { activeCloudNet } from '../cloud/active';
import { ACTUAL_SPEND_LABEL, EXECUTIVES, basisLabel, defaultApprovedBudget, fmtDurationRange, fmtUsdRange } from '../../shared/org';
import { apiFetch } from '../endpoint';
import { TOOL_DECISION_NOTE } from '../../shared/research';
import { safeLink } from '../research-view';
import { store } from '../state';
import { h, openModal } from './dom';
import { morphChildren } from './reconcile';
import { chiefPlanBlock, chiefPlanFor, chiefReviewsBlock, chiefReviewsFor, promptsShown } from './chief';
import { LESSON_DECISION_NOTE, SOURCE_LABEL, scopeText } from '../../shared/memory';

// ORG-03: the CEO approval inbox. Every item comes from the server's inbox, which is reconciled from consultancy state;
// a decision here is the same decision as on the founder desk or in Telegram.

const usd = (n: number) => `$${n.toFixed(2)}`;
const KIND_ICON: Record<Approval['kind'], string> = { job_plan: '📄', budget_increase: '💵', external_action: '✉️', tool_proposal: '🧰', chief_proposal: '🧭', lesson: '📘' };

/** FREE-02: who wrote it, honestly. Model-backed items are proposals; everything else is computed from real state. */
function raisedTag(item: Approval): HTMLElement {
  // FREE-10: a lesson the CEO wrote is neither a model proposal nor computed state.
  if (item.kind === 'lesson' && !item.lesson?.proposedBy.startsWith('Model-backed')) return h('span.empire-tag', { title: 'Written by a person in the Empire, not by a model.' }, `Written by ${item.lesson?.proposedBy ?? 'the CEO'}`);
  const model = item.kind === 'lesson' ? item.lesson!.proposedBy.replace(/^Model-backed · /, '').replace(/ · proposals only$/, '')
    : item.kind === 'chief_proposal' ? item.proposal?.model : item.proposedBy ? item.proposedBy.replace(/^Model-backed · /, '').replace(/ · proposals only$/, '') : undefined;
  return model
    ? h('span.empire-tag', { 'data-monitor': 'model_backed', title: 'Written by the chief’s model. A proposal until you decide.' }, `Model-backed · ${model} · proposals only`)
    : h('span.empire-tag', { title: 'Computed from real state. No model is called.' }, 'Rule-based');
}

/** FREE-02: the chief's suggestion and the one action approving runs (if any). */
function proposalFacts(item: Approval): HTMLElement {
  const p = item.proposal;
  if (!p) return h('p.setting-note', {}, 'This proposal has nothing to show.');
  return h('dl.inbox-facts.chief-proposal', {},
    h('div', {}, h('dt', {}, 'Situation'), h('dd', {}, p.situation)),
    h('div', {}, h('dt', {}, 'Chief proposes'), h('dd', {}, p.text)),
    h('div', {}, h('dt', {}, 'Approving'), h('dd', {}, p.action ? `records your decision, then ${p.action.label.replace(/^Retry/, 'retries')} through the queue` : 'records your decision only')));
}

/** FREE-10: the proposed lesson, its scope and provenance, and what approving does. */
function lessonFacts(item: Approval): HTMLElement {
  const l = item.lesson;
  if (!l) return h('p.setting-note', {}, 'This lesson has nothing to show.');
  const link = l.source.kind === 'research' ? `consultancy.html?research=${encodeURIComponent(l.source.ref)}` : l.source.jobId ? `consultancy.html?job=${encodeURIComponent(l.source.jobId)}` : undefined;
  return h('dl.inbox-facts.lesson-facts', {},
    h('div', {}, h('dt', {}, 'Lesson'), h('dd', {}, h('blockquote.lesson-text', {}, l.text))),
    l.supersedes ? h('div', {}, h('dt', {}, `Replaces ${l.supersedes}`), h('dd', {}, l.supersedesText ?? '')) : null,
    h('div', {}, h('dt', {}, 'Scope'), h('dd', {}, scopeText(l))),
    h('div', {}, h('dt', {}, 'Source'), h('dd', {}, `${SOURCE_LABEL[l.source.kind]} · ${l.source.label} `, link ? h('a', { href: link, target: '_blank', rel: 'noopener' }, 'Open on the founder desk ↗') : null)),
    h('div', {}, h('dt', {}, 'Approving'), h('dd', {}, 'makes it planning context for the chief; nothing else happens')));
}

/** FREE-02: a job's model-proposed plan structure and the chief's reviews of its finished items. */
function chiefBlocks(item: Approval): HTMLElement[] {
  if (item.kind !== 'job_plan') return [];
  const plan = chiefPlanFor(item.jobId);
  const reviews = chiefReviewsBlock(chiefReviewsFor(item.jobId));
  return [plan ? chiefPlanBlock(plan) : null, reviews].filter((x): x is HTMLElement => !!x);
}

export const pendingApprovals = () => store.approvals?.pending ?? 0;

/** FREE-07: a cloud decision this device sent that the coordinator has not applied yet. */
const sentDecision = (item: Approval) => store.cloud?.sent.find((s) => s.kind === 'approval_decision' && s.ref === item.id);
/** FREE-07: the inbox kinds cloud mode never raises, each with its specific reason (from the capability matrix). */
function cloudGaps(): HTMLElement {
  return h('details.inbox-cloud-gaps', {},
    h('summary', {}, 'Not raised in cloud mode'),
    h('ul', {}, ...cloudMissingKinds().map((m) => h('li', { 'data-gap': m.kind }, m.message))));
}

function ago(at: number): string {
  const min = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** The budget the input starts with: the suggestion for an increase, the estimate's top for a plan. */
function defaultBudget(item: Approval): number | undefined {
  if (item.kind === 'budget_increase') return item.suggestedBudgetUsd;
  return item.estimate ? defaultApprovedBudget(item.estimate) : undefined;
}

function moneyFacts(item: Approval): HTMLElement {
  const rows: HTMLElement[] = [];
  if (item.estimate) {
    rows.push(h('div', {}, h('dt', {}, 'Estimate (not a quote)'), h('dd', {}, fmtUsdRange(item.estimate.costUsd), item.estimate.calendarMs ? ` · ${fmtDurationRange(item.estimate.calendarMs)} calendar time` : '')));
    if (item.estimate.basis) rows.push(h('div', {}, h('dt', {}, 'Basis'), h('dd', {}, basisLabel(item.estimate.basis))));
  }
  if (item.kind === 'budget_increase' && item.spentUsd !== undefined && item.approvedBudgetUsd !== undefined) {
    const pct = Math.min(100, Math.round((item.spentUsd / item.approvedBudgetUsd) * 100));
    rows.push(h('div', {}, h('dt', {}, 'Spent so far'), h('dd', {}, `${usd(item.spentUsd)} of the approved ${usd(item.approvedBudgetUsd)} `, h('small', {}, `(${ACTUAL_SPEND_LABEL})`))));
    rows.push(h('div.inbox-meter', { role: 'img', 'aria-label': `${pct}% of the approved budget spent` }, h('span', { style: `width:${pct}%` })));
  }
  if (item.tool) {
    rows.push(h('div', {}, h('dt', {}, 'Tool'), h('dd', {}, item.tool.name)));
    rows.push(h('div', {}, h('dt', {}, 'Link'), h('dd', {}, safeLink(item.tool.url))));
    rows.push(h('div', {}, h('dt', {}, 'Licence'), h('dd', {}, item.tool.licence)));
    rows.push(h('div', {}, h('dt', {}, 'Enables'), h('dd', {}, item.tool.enables)));
    rows.push(h('div', {}, h('dt', {}, 'Risk'), h('dd', {}, item.tool.risk)));
  }
  if (item.status !== 'pending' && item.budgetUsd !== undefined) rows.push(h('div', {}, h('dt', {}, 'Budget recorded'), h('dd', {}, usd(item.budgetUsd))));
  return h('dl.inbox-facts', {}, ...rows);
}

/** ORG-04a: the exact campaign send being approved — rendered samples, every recipient, what was excluded, sender and cap. */
function outreachFacts(item: Approval): HTMLElement {
  const o = item.outreach;
  if (!o) return h('p.setting-note', {}, 'This send has no snapshot to show.');
  const ex = o.excluded;
  return h('div.inbox-outreach', {},
    h('dl.inbox-facts', {},
      h('div', {}, h('dt', {}, 'Recipients'), h('dd', {}, `${o.recipients.length} · one message each, never CC or BCC`)),
      h('div', {}, h('dt', {}, 'Excluded'), h('dd', {}, `${ex.suppressed} suppressed · ${ex.invalid} invalid · ${ex.unconfirmed} unconfirmed (proposed, not accepted)`)),
      h('div', {}, h('dt', {}, 'Sender'), h('dd', {}, o.from)),
      h('div', {}, h('dt', {}, 'Pace'), h('dd', {}, `one every ${o.intervalSec} s · at most ${o.dailyCap} a day`)),
      h('div', {}, h('dt', {}, 'Draft'), h('dd', {}, `Drafted by ${o.draftedBy} — not verified`))),
    ...o.samples.map((s, i) => {
      // The server footer (postal address, STOP line) is pinned below the scrolling body, so it is always in view.
      const cut = s.text.lastIndexOf('\n\n--\n');
      const body = cut >= 0 ? s.text.slice(0, cut) : s.text;
      const footer = cut >= 0 ? s.text.slice(cut + 2).trimEnd() : '';
      return h('figure.inbox-sample', {},
        h('figcaption', {}, `Exact message ${i + 1} of ${o.recipients.length} · to ${s.to}`),
        h('p.inbox-sample-subject', {}, h('span', {}, 'Subject: '), s.subject),
        h('pre.inbox-sample-body', { tabindex: 0, 'aria-label': `Message body for ${s.to}` }, body),
        footer ? h('pre.inbox-sample-footer', { 'aria-label': 'Footer added by the server to every email' }, footer) : null);
    }),
    h('details.inbox-recipients', {}, h('summary', {}, `All ${o.recipients.length} recipient${o.recipients.length === 1 ? '' : 's'}`),
      h('ol', {}, ...o.recipients.map((r) => h('li', {}, r)))),
  );
}

function itemRow(item: Approval, selected: boolean, onSelect: () => void): HTMLElement {
  const money = item.kind === 'budget_increase' && item.spentUsd !== undefined && item.approvedBudgetUsd !== undefined
    ? `${usd(item.spentUsd)} of ${usd(item.approvedBudgetUsd)} spent`
    : item.outreach ? `${item.outreach.recipients.length} recipient${item.outreach.recipients.length === 1 ? '' : 's'}`
    : item.tool ? item.tool.licence : item.proposal ? (item.proposal.action ? 'One-click retry' : 'Decision only') : item.estimate ? `Estimate ${fmtUsdRange(item.estimate.costUsd)}` : '';
  return h(
    'li',
    { 'data-key': item.id },
    h(
      'button.inbox-row',
      { type: 'button', 'aria-current': selected ? 'true' : undefined, 'data-approval': item.id, 'data-status': item.status, onclick: onSelect },
      h('span.inbox-kind', { 'data-kind': item.kind }, h('span', { 'aria-hidden': 'true' }, KIND_ICON[item.kind]), ` ${APPROVAL_KIND_LABEL[item.kind]}`),
      h('strong.inbox-row-title', {}, item.title),
      h('span.inbox-row-meta', {}, `${item.id} · ${EXECUTIVES[item.raisedBy].name} · ${item.status === 'pending' ? ago(item.createdAt) : `${item.status} ${ago(item.decidedAt ?? item.createdAt)}`}`),
      money ? h('span.inbox-row-money', {}, money) : null,
      item.reopenable ? h('span.inbox-row-reopen', {}, 'Still held · Approve increase…') : null,
    ),
  );
}

async function decide(item: Approval, action: 'approve' | 'reject', budgetUsd?: number): Promise<Approval> {
  if (store.cloud) {
    // FREE-07: an intent naming the item exactly as shown; the coordinator refuses it if the item changed meanwhile.
    const net = activeCloudNet();
    if (!net) throw new Error('Cloud mode is not connected on this device yet.');
    const id = await net.submit({ kind: 'approval_decision', approvalId: item.id, decision: action, seen: approvalFingerprint(item) }, `${action === 'approve' ? 'Approve' : 'Decline'} ${item.id}`);
    if (!id) throw new Error('The decision was not sent; nothing changed. Try again.');
    return item;
  }
  const res = await apiFetch(`/api/approvals/${encodeURIComponent(item.id)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: `game-${item.id}-${action}-${Date.now()}`, ...(budgetUsd !== undefined ? { budgetUsd } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as Approval & { error?: string };
  if (!res.ok) throw new Error(body.error || `The server answered ${res.status}.`);
  return body;
}

/** Pressing E at the inbox tray (or the HUD badge, or an executive card): the inbox, kept current while open. */
export function openInbox(focusId?: string) {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close the approval inbox' }, '✕');
  const count = h('span.inbox-count', { 'aria-live': 'polite' });
  const list = h('ul.inbox-list', { 'aria-label': 'Waiting for your approval' });
  const history = h('ul.inbox-list.inbox-history', { 'aria-label': 'Recent decisions' });
  const historyBox = h('details.inbox-history-box', {}, h('summary', {}, 'Recent decisions'), history);
  const detail = h('section.inbox-detail', { 'aria-live': 'polite', 'aria-label': 'Approval detail' });
  const storageNote = h('p.inbox-error', { role: 'alert', hidden: true });
  const side = h('div.inbox-side', {}, list, historyBox, storageNote);
  const body = h('div.inbox-body', { 'data-view': 'list' });
  let selected = focusId;
  let confirming: 'approve' | 'reject' | null = null;
  let busy = false;
  let error = '';
  let budgetDraft: string | undefined;
  let detailKey = '';

  const select = (id: string) => {
    if (selected !== id) { confirming = null; error = ''; budgetDraft = undefined; }
    selected = id;
    body.dataset.view = 'detail';
    render();
    detail.querySelector<HTMLElement>('h3')?.focus();
  };

  const renderDetail = (item: Approval | undefined) => {
    if (!item) {
      detail.replaceChildren(h('p.inbox-empty', {}, store.approvals?.pending ? 'Choose an item to review it.' : (store.cloud ? 'Nothing is waiting for you. Tool proposals from cloud research and lessons you write appear here.' : 'Nothing is waiting for you. New plans and budget increases appear here, on the founder desk and in Telegram.')));
      return;
    }
    const back = h('button.btn.inbox-back', { type: 'button', onclick: () => { body.dataset.view = 'list'; render(); list.querySelector<HTMLElement>(`[data-approval="${CSS.escape(item.id)}"]`)?.focus(); } }, '← All items');
    const head = [
      back,
      h('span.inbox-kind', { 'data-kind': item.kind }, h('span', { 'aria-hidden': 'true' }, KIND_ICON[item.kind]), ` ${APPROVAL_KIND_LABEL[item.kind]} · ${item.id}`),
      h('h3', { tabindex: -1, id: 'inbox-detail-title' }, item.title),
      h('p.inbox-raised', {}, `Raised by ${EXECUTIVES[item.raisedBy].name} `, raisedTag(item)),
      h('p.inbox-detail-text', {}, item.detail),
      item.kind === 'external_action' ? outreachFacts(item) : item.kind === 'chief_proposal' ? proposalFacts(item) : item.kind === 'lesson' ? lessonFacts(item) : moneyFacts(item),
      ...chiefBlocks(item),
    ];
    const verdict = { approved: '✓ Approved', rejected: '✕ Declined', resolved: '○ Resolved', pending: '' }[item.status];
    const decidedLine = item.status !== 'pending'
      ? h('p.inbox-decided', { 'data-status': item.status }, `${verdict} by ${item.decidedBy ?? 'CEO'} · ${ago(item.decidedAt ?? item.createdAt)}${item.note ? ` · ${item.note}` : ''}`)
      : null;
    // A declined budget increase stays approvable while its hold stands (review fix 1); everything else decided is final.
    const reopen = item.status === 'rejected' && item.reopenable === true;
    if (item.status !== 'pending' && !reopen) {
      detail.replaceChildren(...head, decidedLine!);
      return;
    }
    if (reopen) head.push(decidedLine!, h('p.setting-note', {}, 'The job is still held. You can still approve the increase.'));
    const sent = sentDecision(item);
    if (sent) {
      // FREE-07: decided on this device; the coordinator applies it on its next run. No second decision meanwhile.
      detail.replaceChildren(...head, h('p.inbox-decided.inbox-sent', { 'data-status': 'sent', role: 'status' }, `${sent.label}: sent to your coordinator. It applies the decision on its next run, usually within a few minutes, and refuses it if this item changed.`));
      return;
    }
    if (item.kind === 'external_action') {
      const n = item.outreach?.recipients.length ?? 0;
      const runSend = async (action: 'approve' | 'reject') => {
        busy = true; error = ''; render();
        try { await decide(item, action); confirming = null; } catch (e) { error = (e as Error).message; }
        finally { busy = false; render(); detail.querySelector<HTMLElement>('h3')?.focus(); }
      };
      const askSend = (action: 'approve' | 'reject') => { confirming = action; error = ''; render(); detail.querySelector<HTMLElement>('.inbox-confirm .btn.primary, .inbox-confirm .btn.danger')?.focus(); };
      const confirmSend = confirming && h('div.inbox-confirm', { role: 'group', 'aria-label': 'Confirm decision' },
        h('p', {}, confirming === 'approve' ? `Send exactly this message to ${n} recipient${n === 1 ? '' : 's'}, one at a time from ${item.outreach?.from}? Real email leaves the Empire.` : 'Decline this send? Nothing is emailed.'),
        h('div.inbox-actions', {},
          h(`button.btn.${confirming === 'approve' ? 'primary' : 'danger'}`, { type: 'button', disabled: busy, onclick: () => void runSend(confirming!) }, busy ? 'Saving…' : confirming === 'approve' ? 'Confirm send' : 'Confirm decline'),
          h('button.btn', { type: 'button', disabled: busy, onclick: () => { confirming = null; render(); } }, 'Cancel')));
      detail.replaceChildren(...head,
        ...(error ? [h('p.inbox-error', { role: 'alert' }, error)] : []),
        confirmSend || h('div.inbox-actions', {},
          h('button.btn.primary', { type: 'button', disabled: busy, onclick: () => askSend('approve') }, 'Approve send…'),
          h('button.btn', { type: 'button', disabled: busy, onclick: () => askSend('reject') }, 'Decline…')),
        h('p.setting-note', {}, `Any change to the recipients or sender makes a new item. Pause or cancel a send on the founder desk. ${approveHint(item.id)}`));
      return;
    }
    // Review fix 2: a model-proposed plan is approvable only from a view that shows every prompt.
    if (item.kind === 'job_plan' && item.proposedBy && !promptsShown(chiefPlanFor(item.jobId))) {
      detail.replaceChildren(...head, h('p.inbox-error', { role: 'note' }, 'The chief’s model proposed this plan, but its prompts are not loaded here. Review and approve it on the founder desk, where every prompt is shown.'));
      return;
    }
    const chiefItem = item.kind === 'chief_proposal';
    const lessonItem = item.kind === 'lesson';
    const tool = item.kind === 'tool_proposal' || chiefItem || lessonItem;
    const fallback = defaultBudget(item);
    const input = h('input', { id: 'inbox-budget', type: 'number', inputmode: 'decimal', min: '1', max: String(MAX_APPROVAL_BUDGET_USD), step: '0.01', value: budgetDraft ?? (fallback !== undefined ? String(fallback) : ''), 'aria-describedby': 'inbox-budget-note' }) as HTMLInputElement;
    input.addEventListener('input', () => { budgetDraft = input.value; if (confirming) { confirming = null; render(); input.focus(); } });
    const note = item.kind === 'budget_increase'
      ? 'The new total budget for this job. Held items start once it is raised; running work was never stopped.'
      : 'Approval records this budget. Unstarted items are held if provider spend reaches it.';
    const budget = (): number | undefined => {
      const raw = input.value.trim();
      if (tool) return undefined;
      if (!raw) return item.kind === 'budget_increase' ? NaN : undefined;
      return Number(raw);
    };
    const validate = (b: number | undefined): string => {
      if (b === undefined) return '';
      if (!Number.isFinite(b) || b <= 0 || b > MAX_APPROVAL_BUDGET_USD) return `Enter a budget above $0 and at most $${MAX_APPROVAL_BUDGET_USD.toLocaleString()}.`;
      if (item.kind === 'budget_increase' && item.spentUsd !== undefined && b <= item.spentUsd) return `The new budget must exceed the ${usd(item.spentUsd)} already spent.`;
      return '';
    };
    const ask = (action: 'approve' | 'reject') => {
      const problem = action === 'approve' ? validate(budget()) : '';
      error = problem;
      confirming = problem ? null : action;
      render();
      detail.querySelector<HTMLElement>(problem ? '#inbox-budget' : '.inbox-confirm .btn.primary, .inbox-confirm .btn.danger')?.focus();
    };
    const run = async (action: 'approve' | 'reject') => {
      busy = true;
      error = '';
      render();
      try {
        await decide(item, action, action === 'approve' ? budget() : undefined);
        confirming = null;
        budgetDraft = undefined;
      } catch (e) {
        error = (e as Error).message;
      } finally {
        busy = false;
        render();
        detail.querySelector<HTMLElement>('h3')?.focus();
      }
    };
    const b = budget();
    const spendSentence = lessonItem
      ? `Approve ${item.lesson?.lessonId ?? 'this lesson'}${item.lesson?.supersedes ? ` (it replaces ${item.lesson.supersedes})` : ''}? The chief may cite it as planning context. It never goes into a worker prompt by itself.`
      : chiefItem
      ? (item.proposal?.action ? `Approve and ${item.proposal.action.label.replace(/^Retry/, 'retry')}? The queue’s normal limits still apply.` : 'Record that you approve this proposal? Nothing else happens.')
      : tool
      ? `Record that you approve ${item.tool?.name ?? 'this tool'}? Nothing is installed or adopted; adopting it is later reviewed work.`
      : item.kind === 'budget_increase'
      ? `Raise the budget for “${item.title.replace(/ reached its budget$/, '')}” from ${usd(item.approvedBudgetUsd ?? 0)} to ${b !== undefined && Number.isFinite(b) ? usd(b) : '—'}? Held items will start.`
      : `Approve this plan${b !== undefined && Number.isFinite(b) ? ` with a ${usd(b)} budget` : ''}? Its items go to the task queue and real provider spend starts.`;
    const confirm = confirming && h(
      'div.inbox-confirm',
      { role: 'group', 'aria-label': 'Confirm decision' },
      h('p', {}, confirming === 'approve' ? spendSentence : lessonItem ? 'Decline this lesson? It is retired and never used.' : chiefItem ? 'Dismiss this proposal? Nothing changes.' : tool ? 'Record that you decline this tool proposal?' : item.kind === 'budget_increase' ? 'Decline the increase? The job stays held; its unstarted items will not start.' : 'Decline this plan? Nothing from it will start.'),
      h('div.inbox-actions', {},
        h(`button.btn.${confirming === 'approve' ? 'primary' : 'danger'}`, { type: 'button', disabled: busy, onclick: () => void run(confirming!) }, busy ? 'Saving…' : confirming === 'approve' ? 'Confirm approval' : 'Confirm decline'),
        h('button.btn', { type: 'button', disabled: busy, onclick: () => { confirming = null; render(); } }, 'Cancel')),
    );
    detail.replaceChildren(
      ...head,
      ...(chiefItem ? [] : lessonItem ? [h('p.setting-note', {}, LESSON_DECISION_NOTE)] : tool ? [h('p.setting-note', {}, TOOL_DECISION_NOTE)] : [
        h('label.inbox-budget', { for: 'inbox-budget' }, item.kind === 'budget_increase' ? 'New budget (USD)' : 'Approved budget (USD)', h('span.inbox-dollar', {}, '$', input)),
        h('p.setting-note', { id: 'inbox-budget-note' }, note)]),
      ...(error ? [h('p.inbox-error', { role: 'alert' }, error)] : []),
      confirm || h('div.inbox-actions', {},
        h('button.btn.primary', { type: 'button', disabled: busy, onclick: () => ask('approve') }, lessonItem ? 'Approve lesson…' : chiefItem ? (item.proposal?.action ? 'Approve & retry…' : 'Approve proposal…') : tool ? 'Approve proposal…' : item.kind === 'budget_increase' ? 'Approve increase…' : 'Approve plan…'),
        reopen ? null : h('button.btn', { type: 'button', disabled: busy, onclick: () => ask('reject') }, chiefItem ? 'Dismiss…' : 'Decline…')),
      h('p.setting-note', {}, store.cloud ? 'Your coordinator applies this on its next run, usually within a few minutes. Telegram and the founder desk are not available in cloud mode.' : approveHint(item.id)),
    );
  };

  const render = () => {
    // FREE-07: in cloud mode the inbox is the coordinator's (tool proposals and lessons); the other kinds say why not.
    if (store.cloud && !side.querySelector('.inbox-cloud-gaps')) side.append(h('p.setting-note.inbox-cloud-note', {}, ORG_CAPABILITIES.inbox.cloudSummary), cloudGaps());
    const state = store.approvals;
    if (!state) {
      body.replaceChildren(h('p.inbox-empty', {}, 'This server has not reported an approval inbox yet. Update the office host to use it.'));
      return;
    }
    const pending = state.items.filter((i) => i.status === 'pending');
    const decided = state.items.filter((i) => i.status !== 'pending').slice(0, 12);
    count.textContent = pending.length ? `${pending.length} waiting` : 'All clear';
    if (selected && !state.items.some((i) => i.id === selected)) selected = undefined;
    if (!selected && pending[0]) selected = pending[0].id;
    if (body.firstChild !== side) body.replaceChildren(side, detail);
    const keep = side.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.approval : undefined;
    // Patched in place by item id, so a focused row keeps focus and the lists keep their scroll across broadcasts.
    morphChildren(list, pending.length ? pending.map((i) => itemRow(i, i.id === selected, () => select(i.id))) : [h('li.inbox-empty', {}, 'Nothing is waiting for you.')]);
    morphChildren(history, decided.map((i) => itemRow(i, i.id === selected, () => select(i.id))));
    // An item that moved from the waiting list to the history is a new row there; follow it.
    if (keep && !side.contains(document.activeElement)) side.querySelector<HTMLElement>(`[data-approval="${CSS.escape(keep)}"]`)?.focus({ preventScroll: true });
    historyBox.hidden = !decided.length;
    if (decided.some((i) => i.reopenable)) historyBox.open = true;
    storageNote.textContent = state.storageError ?? '';
    storageNote.hidden = !state.storageError;
    // Re-draw the detail only when what it shows changed, so a broadcast never steals focus from the budget input.
    const current = state.items.find((i) => i.id === selected);
    const key = JSON.stringify([current, confirming, busy, error, !!(current && sentDecision(current)), current?.kind === 'job_plan' ? [chiefPlanFor(current.jobId), chiefReviewsFor(current.jobId)] : null]);
    if (key !== detailKey || !detail.firstChild) { detailKey = key; renderDetail(current); }
  };

  const modal = openModal(
    h('div.modal.inbox-modal', { role: 'dialog', 'aria-labelledby': 'inbox-title' },
      h('header', {}, h('div.inbox-heading', {}, h('small.empire-eyebrow', {}, 'CEO desk · Approval inbox'), h('h2', { id: 'inbox-title' }, 'Waiting for you ', count)), close),
      body,
      h('footer', {}, h('p.setting-note', {}, store.cloud ? 'Cloud mode: tool proposals come from Sam’s research reports and lessons from you. Everything here was recorded by your coordinator in your state repository; nothing is live.' : 'Plans come from Alex, budget increases from Priya, campaign sends from Jordan, tool proposals from Sam. Items tagged Model-backed were written by the chief’s model and are proposals; the rest are rule-based monitors of real jobs, spend, outreach and worker reports. Telegram: /approvals.'))),
    { onClose: () => offs.forEach((off) => off()) },
  );
  const offs = (['approvals', 'cloud', 'chief'] as const).map((topic) => store.on(topic, render));
  close.addEventListener('click', () => modal.close());
  render();
  if (focusId && store.approvals?.items.some((i) => i.id === focusId)) select(focusId);
  else close.focus();
}

/** The HUD badge: shown only while something waits, with the count in text (not colour alone). */
export function mountInboxButton(btn: HTMLElement) {
  btn.setAttribute('title', 'Approval inbox: plans, budget increases and campaign sends waiting for you');
  const label = h('span', {}, 'Inbox');
  const badge = h('span.svc-count.inbox-badge');
  btn.replaceChildren(h('span.inbox-glyph', { 'aria-hidden': 'true' }, '📥'), label, badge);
  const render = () => {
    const n = pendingApprovals();
    badge.textContent = String(n);
    btn.setAttribute('aria-label', `Approval inbox, ${n} waiting`);
    btn.classList.toggle('hidden', n === 0);
  };
  store.on('approvals', render);
  store.on('cloud', render);
  render();
  btn.addEventListener('click', () => openInbox());
}
