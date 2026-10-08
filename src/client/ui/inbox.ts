import { APPROVAL_KIND_LABEL, CLOUD_INBOX_NOTE, MAX_APPROVAL_BUDGET_USD, approveHint, type Approval } from '../../shared/approvals';
import { ACTUAL_SPEND_LABEL, EXECUTIVES, basisLabel, defaultApprovedBudget, fmtDurationRange, fmtUsdRange } from '../../shared/org';
import { apiFetch } from '../endpoint';
import { TOOL_DECISION_NOTE } from '../../shared/research';
import { safeLink } from '../research-view';
import { store } from '../state';
import { h, openModal } from './dom';
import { morphChildren } from './reconcile';

// ORG-03: the CEO approval inbox. Every item comes from the server's inbox, which is reconciled from consultancy state;
// a decision here is the same decision as on the founder desk or in Telegram.

const usd = (n: number) => `$${n.toFixed(2)}`;
const KIND_ICON: Record<Approval['kind'], string> = { job_plan: '📄', budget_increase: '💵', tool_proposal: '🧰' };

export const pendingApprovals = () => (store.cloud ? 0 : store.approvals?.pending ?? 0);

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

function itemRow(item: Approval, selected: boolean, onSelect: () => void): HTMLElement {
  const money = item.kind === 'budget_increase' && item.spentUsd !== undefined && item.approvedBudgetUsd !== undefined
    ? `${usd(item.spentUsd)} of ${usd(item.approvedBudgetUsd)} spent`
    : item.tool ? item.tool.licence : item.estimate ? `Estimate ${fmtUsdRange(item.estimate.costUsd)}` : '';
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
      detail.replaceChildren(h('p.inbox-empty', {}, store.approvals?.pending ? 'Choose an item to review it.' : 'Nothing is waiting for you. New plans and budget increases appear here, on the founder desk and in Telegram.'));
      return;
    }
    const back = h('button.btn.inbox-back', { type: 'button', onclick: () => { body.dataset.view = 'list'; render(); list.querySelector<HTMLElement>(`[data-approval="${CSS.escape(item.id)}"]`)?.focus(); } }, '← All items');
    const head = [
      back,
      h('span.inbox-kind', { 'data-kind': item.kind }, h('span', { 'aria-hidden': 'true' }, KIND_ICON[item.kind]), ` ${APPROVAL_KIND_LABEL[item.kind]} · ${item.id}`),
      h('h3', { tabindex: -1, id: 'inbox-detail-title' }, item.title),
      h('p.inbox-raised', {}, `Raised by ${EXECUTIVES[item.raisedBy].name} `, h('span.empire-tag', { title: 'Computed from real state. No model is called.' }, 'Rule-based')),
      h('p.inbox-detail-text', {}, item.detail),
      moneyFacts(item),
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
    const tool = item.kind === 'tool_proposal';
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
    const spendSentence = tool
      ? `Record that you approve ${item.tool?.name ?? 'this tool'}? Nothing is installed or adopted; adopting it is later reviewed work.`
      : item.kind === 'budget_increase'
      ? `Raise the budget for “${item.title.replace(/ reached its budget$/, '')}” from ${usd(item.approvedBudgetUsd ?? 0)} to ${b !== undefined && Number.isFinite(b) ? usd(b) : '—'}? Held items will start.`
      : `Approve this plan${b !== undefined && Number.isFinite(b) ? ` with a ${usd(b)} budget` : ''}? Its items go to the task queue and real provider spend starts.`;
    const confirm = confirming && h(
      'div.inbox-confirm',
      { role: 'group', 'aria-label': 'Confirm decision' },
      h('p', {}, confirming === 'approve' ? spendSentence : tool ? 'Record that you decline this tool proposal?' : item.kind === 'budget_increase' ? 'Decline the increase? The job stays held; its unstarted items will not start.' : 'Decline this plan? Nothing from it will start.'),
      h('div.inbox-actions', {},
        h(`button.btn.${confirming === 'approve' ? 'primary' : 'danger'}`, { type: 'button', disabled: busy, onclick: () => void run(confirming!) }, busy ? 'Saving…' : confirming === 'approve' ? 'Confirm approval' : 'Confirm decline'),
        h('button.btn', { type: 'button', disabled: busy, onclick: () => { confirming = null; render(); } }, 'Cancel')),
    );
    detail.replaceChildren(
      ...head,
      ...(tool ? [h('p.setting-note', {}, TOOL_DECISION_NOTE)] : [
        h('label.inbox-budget', { for: 'inbox-budget' }, item.kind === 'budget_increase' ? 'New budget (USD)' : 'Approved budget (USD)', h('span.inbox-dollar', {}, '$', input)),
        h('p.setting-note', { id: 'inbox-budget-note' }, note)]),
      ...(error ? [h('p.inbox-error', { role: 'alert' }, error)] : []),
      confirm || h('div.inbox-actions', {},
        h('button.btn.primary', { type: 'button', disabled: busy, onclick: () => ask('approve') }, tool ? 'Approve proposal…' : item.kind === 'budget_increase' ? 'Approve increase…' : 'Approve plan…'),
        reopen ? null : h('button.btn', { type: 'button', disabled: busy, onclick: () => ask('reject') }, 'Decline…')),
      h('p.setting-note', {}, approveHint(item.id)),
    );
  };

  const render = () => {
    if (store.cloud) {
      body.replaceChildren(h('p.inbox-empty.inbox-cloud', {}, CLOUD_INBOX_NOTE));
      count.textContent = '';
      return;
    }
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
    const key = JSON.stringify([current, confirming, busy, error]);
    if (key !== detailKey || !detail.firstChild) { detailKey = key; renderDetail(current); }
  };

  const modal = openModal(
    h('div.modal.inbox-modal', { role: 'dialog', 'aria-labelledby': 'inbox-title' },
      h('header', {}, h('div.inbox-heading', {}, h('small.empire-eyebrow', {}, 'CEO desk · Approval inbox'), h('h2', { id: 'inbox-title' }, 'Waiting for you ', count)), close),
      body,
      h('footer', {}, h('p.setting-note', {}, 'Plans come from Alex, budget increases from Priya, tool proposals from Sam. All are rule-based monitors of real jobs, provider spend and worker reports. Telegram: /approvals.'))),
    { onClose: () => offs.forEach((off) => off()) },
  );
  const offs = (['approvals', 'cloud'] as const).map((topic) => store.on(topic, render));
  close.addEventListener('click', () => modal.close());
  render();
  if (focusId && store.approvals?.items.some((i) => i.id === focusId)) select(focusId);
  else close.focus();
}

/** The HUD badge: shown only while something waits, with the count in text (not colour alone). */
export function mountInboxButton(btn: HTMLElement) {
  btn.setAttribute('title', 'Approval inbox: plans and budget increases waiting for you');
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
