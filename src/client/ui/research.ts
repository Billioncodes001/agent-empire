import type { ResearchReport, ResearchReportSummary } from '../../shared/research';
import { MAX_QUESTION } from '../../shared/research';
import { apiFetch } from '../endpoint';
import { STATUS_LABEL, reportBody, reportFacts } from '../research-view';
import { store } from '../state';
import { h, openModal } from './dom';
import { openInbox } from './inbox';

// ORG-05: the research card's panel in the game. It lists the real reports and tool proposals the server reports, lets
// the CEO ask a question (an internal job that still needs approval), and opens a report as readable text.

const newRequestId = () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function ask(question: string, requestId: string) {
  const res = await apiFetch('/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, requestId }) });
  const body = (await res.json().catch(() => ({}))) as { error?: string; job?: { id: string } };
  if (!res.ok) throw new Error(body.error || `The server answered ${res.status}.`);
  return body;
}

function reportRow(r: ResearchReportSummary, onOpen: () => void): HTMLElement {
  const open = r.tools.filter((t) => t.decision === 'pending').length;
  return h('li', {},
    h('button.research-row', { type: 'button', 'data-report': r.jobId, 'data-status': r.status, onclick: onOpen },
      h('strong.research-q', {}, r.question),
      reportFacts(r),
      r.status !== 'imported' ? h('span.research-row-status', {}, STATUS_LABEL[r.status]) : null,
      r.reason ? h('span.research-row-reason', {}, r.reason) : null,
      open ? h('span.research-row-tools', {}, `${open} tool proposal${open === 1 ? '' : 's'} to decide`) : r.tools.length ? h('span.research-row-tools.decided', {}, `${r.tools.length} tool proposal${r.tools.length === 1 ? '' : 's'} decided`) : null));
}

/** Opens one report as text, fetched from the server. */
export async function openResearchReport(jobId: string) {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close research report' }, '✕');
  const slot = h('div.research-report-slot', {}, h('p.setting-note', {}, 'Loading the report…'));
  const modal = openModal(h('div.modal.exec-modal.research-modal', { role: 'dialog', 'aria-labelledby': 'research-report-title' },
    h('header', {}, h('div', {}, h('small.empire-eyebrow', {}, 'Research report'), h('h2', { id: 'research-report-title' }, 'Report')), close),
    h('div.exec-body', {}, slot)));
  close.addEventListener('click', () => modal.close());
  close.focus();
  try {
    const res = await apiFetch(`/api/research/reports/${encodeURIComponent(jobId)}`);
    const report = (await res.json()) as ResearchReport & { error?: string };
    if (!res.ok) throw new Error(report.error || `The server answered ${res.status}.`);
    modal.el.querySelector('#research-report-title')!.textContent = report.question;
    const open = report.tools.some((t) => t.decision === 'pending')
      ? h('button.btn.primary', { type: 'button', onclick: () => { modal.close(); openInbox(report.tools.find((t) => t.decision === 'pending')?.approvalId); } }, 'Decide tool proposals in the inbox')
      : null;
    slot.replaceChildren(reportBody(report), ...(open ? [open] : []));
  } catch (e) {
    slot.replaceChildren(h('p.inbox-error', { role: 'alert' }, (e as Error).message));
  }
}

/** The research executive's panel: ask, reports, tool proposals. Kept current while open; the form keeps its text. */
export function researchPanel(onLeave?: () => void): { el: HTMLElement; dispose(): void } {
  let requestId = newRequestId();
  const field = h('textarea', { id: 'research-question', rows: 2, maxlength: MAX_QUESTION, placeholder: 'e.g. Can we offer appointment booking for dental practices?', 'aria-describedby': 'research-ask-note' }) as HTMLTextAreaElement;
  const status = h('p.research-status', { role: 'status', 'aria-live': 'polite' });
  const submit = h('button.btn.primary', { type: 'submit' }, 'Ask research') as HTMLButtonElement;
  const form = h('form.research-ask', {},
    h('label', { for: 'research-question' }, 'Ask a question or describe an unfamiliar job'),
    field,
    h('p.setting-note', { id: 'research-ask-note' }, 'Creates an internal job with an estimate. Nothing runs, and nothing is spent, until you approve it in the inbox. Telegram: /research <question>.'),
    h('div.research-actions', {}, submit),
    status);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = field.value.trim();
    if (!q) { status.textContent = 'Write a question first.'; field.focus(); return; }
    submit.disabled = true;
    status.textContent = 'Saving…';
    try {
      await ask(q, requestId);
      requestId = newRequestId();
      field.value = '';
      status.replaceChildren('Saved as an internal job awaiting your approval. ', h('button.btn.exec-link', { type: 'button', onclick: () => { onLeave?.(); openInbox(); } }, 'Open inbox'));
    } catch (err) {
      status.textContent = (err as Error).message;
    } finally {
      submit.disabled = false;
    }
  });
  const list = h('ul.research-list', { 'aria-label': 'Research reports' });
  const summary = h('p.research-summary');
  const render = () => {
    const state = store.research;
    if (store.cloud) { list.replaceChildren(h('li.setting-note', {}, 'Research runs on your own server; it is not available in cloud mode yet.')); summary.textContent = ''; return; }
    if (!state) { list.replaceChildren(h('li.setting-note', {}, 'This server has not reported research yet. Update the office host to use it.')); summary.textContent = ''; return; }
    if (state.storageError) { list.replaceChildren(h('li.inbox-error', { role: 'alert' }, state.storageError)); return; }
    const done = state.reports.filter((r) => r.status === 'imported').length;
    summary.textContent = `${done} report${done === 1 ? '' : 's'} · ${state.openProposals} open tool proposal${state.openProposals === 1 ? '' : 's'} · every report is the worker's work, not verified`;
    const keep = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.report : undefined;
    list.replaceChildren(...(state.reports.length ? state.reports.map((r) => reportRow(r, () => void openResearchReport(r.jobId))) : [h('li.setting-note', {}, 'No research yet. Ask the first question above.')]));
    if (keep) list.querySelector<HTMLElement>(`[data-report="${CSS.escape(keep)}"]`)?.focus();
  };
  const el = h('section.research-panel', { 'aria-labelledby': 'research-panel-title' },
    h('h3', { id: 'research-panel-title' }, 'Research'),
    form,
    h('h3', {}, 'Reports'),
    summary,
    list);
  const offs = (['research', 'cloud'] as const).map((t) => store.on(t, render));
  render();
  return { el, dispose: () => offs.forEach((off) => off()) };
}
