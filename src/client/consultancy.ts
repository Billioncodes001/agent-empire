import type { ConsultancyJob } from '../shared/consultancy';
import { apiFetch } from './endpoint';
import type { ResearchReport, ResearchState } from '../shared/research';
import { STATUS_LABEL, reportBody, reportFacts } from './research-view';
import { ACTUAL_SPEND_LABEL, PHASE_LABEL, basisLabel, defaultApprovedBudget, fmtDurationRange, fmtUsdRange } from '../shared/org';
import { PLAN_NOTE, REVIEW_NOTE, ROLE_LABEL, chiefTag, lessonsLine, type ChiefPlan, type ChiefState } from '../shared/chief';
import { mountMemory, refreshMemory } from './memory-desk';

/** The CEO's edited budget per pending job, kept across the 5-second refreshes while they type. */
const budgetDraft = new Map<string, string>();
const usd = (n: number) => `$${n.toFixed(2)}`;

/** ORG-02: the estimate before approval, labelled with its basis; afterwards, approved budget against actual spend. */
function estimateSection(job: ConsultancyJob): HTMLElement | null {
  const e = job.estimate;
  if (!e && job.approvedBudgetUsd === undefined && job.actualSpendUsd === undefined) return null;
  const box = text('section', '', 'estimate');
  box.setAttribute('aria-labelledby', 'estimate-title');
  const head = text('h3', job.decision === 'pending_approval' ? 'Estimate before approval' : 'Estimate and actual spend');
  head.id = 'estimate-title';
  box.append(head);
  if (e) {
    const figures = text('dl', '', 'estimate-figures');
    const pair = (k: string, v: string) => { const d = text('div', ''); d.append(text('dt', k), text('dd', v)); figures.append(d); };
    pair('Provider cost', fmtUsdRange(e.costUsd));
    pair('Calendar time', fmtDurationRange(e.calendarMs));
    pair('Workers at once', String(Math.max(1, e.maxWorkers)));
    box.append(figures, text('p', basisLabel(e.basis), e.basis.source === 'default' ? 'estimate-basis rough' : 'estimate-basis'));
    const list = text('ol', '', 'estimate-items');
    job.items.forEach((item, i) => {
      const ie = e.items[i]; if (!ie) return;
      const li = text('li', '');
      li.append(text('span', PHASE_LABEL[ie.phase], 'phase'), text('span', item.title), text('span', fmtUsdRange(ie.costUsd), 'amount'));
      if (item.actualSpendUsd !== undefined) li.append(text('span', `actual ${usd(item.actualSpendUsd)}`, 'amount actual'));
      list.append(li);
    });
    box.append(list);
    box.append(text('p', 'An estimate, not a quote: the p25–p75 range of comparable finished tasks. Items run in order unless the plan marks them parallel.', 'estimate-note'));
  }
  if (job.decision === 'pending_approval' && e) {
    const label = text('label', 'Approved budget (USD)', 'budget');
    const input = document.createElement('input');
    input.type = 'number'; input.min = '1'; input.step = '1'; input.inputMode = 'decimal'; input.id = 'budget-input';
    input.value = budgetDraft.get(job.id) ?? String(defaultApprovedBudget(e));
    input.addEventListener('input', () => budgetDraft.set(job.id, input.value));
    label.append(input);
    box.append(label, text('p', 'Defaults to the top of the range, rounded up. If provider spend reaches it, unstarted items wait for your approval; running work is not stopped.', 'estimate-note'));
  }
  if (job.approvedBudgetUsd !== undefined) {
    const spent = job.actualSpendUsd ?? 0;
    const meter = text('div', '', 'budget-meter');
    meter.setAttribute('role', 'img');
    meter.setAttribute('aria-label', `${usd(spent)} of ${usd(job.approvedBudgetUsd)} approved budget spent`);
    const fill = text('span', '');
    fill.style.width = `${Math.min(100, (spent / job.approvedBudgetUsd) * 100).toFixed(1)}%`;
    meter.append(fill);
    box.append(text('p', `Approved budget ${usd(job.approvedBudgetUsd)} · actual ${usd(spent)} (${ACTUAL_SPEND_LABEL})`, 'estimate-actual'), meter);
  }
  if (job.budgetHold) box.append(text('p', `Budget reached at ${usd(job.budgetHold.spentUsd)}. Unstarted items are held until the budget is raised (coming with the approval inbox).`, 'estimate-hold'));
  return box;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const labels: Record<string, string> = { awaiting_approval: 'Your approval', queued: 'Queued', running: 'In progress', needs_attention: 'Needs attention', awaiting_review: 'Ready for review', rejected: 'Declined' };
interface Snapshot { revision: number; jobs: ConsultancyJob[]; storageError?: string }
interface Status { repository: string; resources: { workstations: number; workers: number; attention: number; concurrency: number; queued: number | null; blocker?: string; mode: string }; telegram: {configured: boolean; running: boolean; error?: string; lastPollAt?: number}; email?: { label: string; error?: string } }
let jobs: ConsultancyJob[] = [], fresh = false, selected: string | undefined, busy = false, refreshing = false;
/** FREE-02: the chief's planning brain, its plan requests and reviews (null on hosts without it). */
let chief: ChiefState | null = null;
let lastRendered = '';
let refreshFlight: Promise<void> | undefined;
const detail = $<HTMLDialogElement>('job-detail'), intake = $<HTMLDialogElement>('intake');
const form = $<HTMLFormElement>('brief-form');
const newRequestId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
let step = 1, requestId = newRequestId();
const text = (tag: string, value: string, cls?: string) => { const n = document.createElement(tag); n.textContent = value; if (cls) n.className = cls; return n; };
function error(id: string, message = '') { const e = $(id); e.textContent = message; e.hidden = !message; }
// Metrics only ever show host-reported values; a changed value gets a brief visual tick, never a count-up through invented numbers.
function metric(id: string, value: string) {
  const el = $(id); if (el.textContent === value) return;
  el.textContent = value; el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick');
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`/api/consultancy/${path}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000), ...(body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}) });
  const data = await response.json();
  if (!response.ok) throw new Error(response.status === 401 ? 'Your session ended. Open the city and sign in again.' : data.error || 'The host could not complete the request.');
  return data;
}
function showJobs() {
  const fingerprint = JSON.stringify(jobs);
  if (fingerprint === lastRendered) return;
  lastRendered = fingerprint;
  const el = $('jobs'); el.replaceChildren();
  if (!jobs.length) { el.append(text('p', 'Your next client starts here. Add a brief, review it, then approve work when you’re ready.', 'empty')); return; }
  for (const job of [...jobs].reverse()) {
    const row = text('button', '', 'job') as HTMLButtonElement;
    row.type = 'button'; row.dataset.status = job.status;
    const title = text('div',''); title.append(text('small', job.client), text('strong', job.title));
    row.append(title, text('span', labels[job.status] ?? job.status));
    row.addEventListener('click', () => { selected = job.id; error('action-error'); renderDetail(); detail.showModal(); });
    el.append(row);
  }
}
async function refreshChief() {
  try {
    const r = await apiFetch('/api/chief', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000) });
    chief = r.ok ? await r.json() as ChiefState : null;
  } catch { chief = null; }
  const ready = !!chief?.brain.ready;
  $('chief-tag').textContent = chief && ready ? chiefTag(chief.brain) : 'Rule-based coordination';
  $('chief-tag').dataset.monitor = ready ? 'model_backed' : 'rule_based';
  $('chief-brain').textContent = chief ? `Planning brain: ${chief.brain.label}.${chief.brain.reason ? ` ${chief.brain.reason}` : ''}${chief.pendingCalls ? ` ${chief.pendingCalls} waiting.` : ''}` : '';
  $('chief-option').hidden = !ready;
  $('chief-option-note').textContent = ready ? `${chiefTag(chief!.brain)} · it drafts items with roles and order; you review every prompt and approve with an estimate.` : '';
  const list = $('chief-plans'); list.replaceChildren();
  for (const p of (chief?.plans ?? []).slice(-5).reverse()) {
    const row = text('div', '', 'chief-plan-row'); row.dataset.status = p.status;
    const label = { queued: 'Waiting for the model', planning: 'Drafting…', proposed: 'Proposed · your approval', needs_attention: 'Needs attention' }[p.status];
    row.append(text('small', `${p.id} · ${label}`), text('strong', `${p.client} · ${p.title}`));
    if (p.reason) row.append(text('p', p.reason, 'chief-reason'));
    if (p.status === 'proposed' && p.jobId) {
      const open = text('button', 'Review the proposed plan →', 'quiet') as HTMLButtonElement; open.type = 'button';
      open.addEventListener('click', () => { selected = p.jobId; error('action-error'); renderDetail(); detail.showModal(); });
      row.append(open);
    }
    list.append(row);
  }
}
const planFor = (jobId: string): ChiefPlan | undefined => chief?.plans.find((p) => p.jobId === jobId && p.status === 'proposed');
function chiefSection(job: ConsultancyJob): HTMLElement | null {
  const plan = planFor(job.id);
  const reviews = chief?.reviews.filter((r) => r.jobId === job.id) ?? [];
  if (!plan && !reviews.length) return null;
  const box = text('section', '', 'chief-proposed');
  box.setAttribute('aria-label', 'From the chief');
  if (plan) {
    box.append(text('span', `Proposed by the chief · Model-backed · ${plan.model ?? 'model'} · proposals only`, 'tag chief-model-tag'));
    if (plan.summary) box.append(text('p', plan.summary));
    // FREE-10: the approved lessons the chief was given, and which the plan cites.
    const line = lessonsLine(plan);
    if (line && plan.lessons) {
      const d = document.createElement('details'); d.className = 'chief-lessons';
      const ul = document.createElement('ul');
      for (const l of plan.lessons) { const li = text('li', ` ${l.text}`); li.prepend(text('strong', l.id)); li.dataset.cited = String(!!plan.citedLessons?.includes(l.id)); ul.append(li); }
      d.append(text('summary', line), ul, text('p', 'Approved lessons from organizational memory, given to the chief as context. They are not added to the prompts below; only what the plan wrote is.', 'estimate-note'));
      box.append(d);
    }
    box.append(text('p', `${PLAN_NOTE}${plan.costLabel ? ` Planning cost: ${plan.costLabel}.` : ''}`, 'estimate-note'));
  }
  if (reviews.length) {
    box.append(text('h3', 'Chief reviews'));
    for (const r of reviews) {
      const art = text('article', '', 'chief-review'); art.dataset.recommendation = r.recommendation ?? r.status;
      art.append(text('strong', `${r.itemTitle} · ${r.status === 'reviewed' ? (r.recommendation === 'accept' ? 'Recommends accept' : 'Recommends changes') : r.status === 'needs_attention' ? 'Needs attention' : 'Reviewing…'}`));
      if (r.summary) art.append(text('p', r.summary));
      for (const c of r.concerns ?? []) art.append(text('p', `· ${c}`, 'chief-concern'));
      if (r.reason) art.append(text('p', r.reason, 'chief-reason'));
      if (r.lessonNote) art.append(text('p', r.lessonNote, 'chief-concern'));
      if (r.evidence) art.append(text('small', `Based on: ${r.evidence}`));
      box.append(art);
    }
    box.append(text('p', REVIEW_NOTE, 'estimate-note'));
  }
  return box;
}
function renderDetail() {
  const focusedAction = detail.contains(document.activeElement) ? document.activeElement?.textContent : undefined;
  const budgetFocused = document.activeElement?.id === 'budget-input';
  const job = jobs.find(j => j.id === selected); if (!job) return;
  const title = text('h2', job.title); title.id = 'detail-title';
  const content = $('detail-content'); content.replaceChildren(title,text('p',`${job.client} · ${labels[job.status] ?? job.status}`),text('p',job.brief));
  if (job.attention) content.append(text('p',job.attention));
  const plan = text('section','','plan'); plan.append(text('h3','Proposed work'));
  // Task prompts remain visible in full before approval, including plans created outside this form.
  const proposed = planFor(job.id);
  job.items.forEach((item, i) => {
    const meta = proposed?.items?.[i];
    plan.append(text('h3',item.title), text('small', `${labels[item.status] ?? item.status}${meta ? ` · ${ROLE_LABEL[meta.role]} · ${meta.dependsOn.length ? `after item ${meta.dependsOn.join(' & ')}` : 'starts first'}${meta.parallel ? ' · parallel' : ''}` : ''}`), text('p',item.prompt));
    if (item.attention) plan.append(text('p',item.attention));
  });
  const fromChief = chiefSection(job);
  if (fromChief) content.append(fromChief);
  const estimate = estimateSection(job);
  if (estimate) content.append(estimate);
  content.append(plan, text('p','Approval submits these work items to this host’s local queue. Existing provider charges, budget, concurrency and funded desks still apply. Worker turn completion requires review before client delivery.'));
  const actions = $('detail-actions'); actions.replaceChildren();
  if (job.decision === 'pending_approval') {
    for (const [kind,label] of [['reject','Decline plan'],['approve','Approve & queue']] as const) {
      const b = text('button',label,kind === 'approve' ? 'primary' : 'quiet') as HTMLButtonElement;
      b.disabled = busy || !fresh;
      b.addEventListener('click',async () => {
        if (busy || !fresh) return;
        busy = true; error('action-error'); renderDetail();
        let body: { budgetUsd?: number } = {};
        if (kind === 'approve') {
          const raw = ($('budget-input') as HTMLInputElement | null)?.value.trim();
          if (raw) {
            const n = Number(raw);
            if (!Number.isFinite(n) || n <= 0) { busy = false; error('action-error', 'Enter a budget above $0, or clear it to use the estimate.'); renderDetail(); return; }
            body = { budgetUsd: n };
          }
        }
        try { await api(`jobs/${encodeURIComponent(job.id)}/${kind}`, body); budgetDraft.delete(job.id); await refresh(); }
        catch (e) { error('action-error',(e as Error).message); }
        finally { busy = false; renderDetail(); }
      });
      actions.append(b);
      if (focusedAction === label && !b.disabled) b.focus();
    }
  }
  if (budgetFocused) ($('budget-input') as HTMLInputElement | null)?.focus();
  if (detail.open && !detail.contains(document.activeElement)) $('close-detail').focus();
}
async function refresh() {
  // A mutation must fetch a new snapshot after an older poll finishes.
  if (refreshFlight) await refreshFlight;
  const flight = refreshNow();
  refreshFlight = flight;
  try { await flight; } finally { if (refreshFlight === flight) refreshFlight = undefined; }
}
async function refreshNow() {
  refreshing = true;
  try {
    const [snapshot,status] = await Promise.all([api<Snapshot>('jobs'),api<Status>('status')]);
    if (snapshot.storageError) throw new Error(snapshot.storageError);
    const changed = JSON.stringify(snapshot.jobs) !== JSON.stringify(jobs);
    const wasFresh = fresh; jobs = snapshot.jobs; fresh = true; error('error');
    $('connection').textContent = `Host connected · ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
    metric('active-count', String(jobs.filter(j => ['queued','running','needs_attention'].includes(j.status)).length));
    metric('approval-count', String(jobs.filter(j => j.status === 'awaiting_approval').length));
    metric('workers-count', String(status.resources.workers)); metric('desks-count', String(status.resources.workstations));
    $('chief-report').textContent = status.resources.blocker || `${status.resources.attention} workers need input. ${status.resources.queued} tasks waiting. Up to ${status.resources.concurrency} workers can run at once within the funded desk limit. Work is scoped to ${status.repository}.`;
    $('telegram-status').textContent = status.telegram.error || (!status.telegram.configured ? 'Not connected yet. Connect your private bot to send briefs, approve plans and receive updates.' : status.telegram.lastPollAt ? 'Connected to your configured private bot.' : 'Configured. Waiting for the first successful connection.');
    $('email-status').textContent = status.email ? `${status.email.label}${status.email.error ? ` — ${status.email.error}` : ''}` : 'Email: not configured';
    const chiefBefore = JSON.stringify(chief);
    await refreshChief();
    showJobs(); if (detail.open && (changed || !wasFresh || JSON.stringify(chief) !== chiefBefore)) renderDetail();
    void refreshResearch();
    void refreshMemory();
    deepLink();
  } catch (e) {
    fresh = false; $('connection').textContent = 'Host unavailable · last view retained'; error('error',(e as Error).message);
    if (detail.open) renderDetail();
  } finally { refreshing = false; }
}
function setStep(n: number) {
  step = n; $('brief-fields').hidden = n !== 1; $('brief-review').hidden = n !== 2; $('back').hidden = n !== 2;
  $('step-label').textContent = n === 1 ? '01 / THE BRIEF' : '02 / REVIEW';
  $('form-title').textContent = n === 1 ? 'Bring a new opportunity.' : 'Ready for the chief’s desk.';
  $('save-job').textContent = n === 1 ? 'Review brief →' : 'Save for approval';
}
$('new-job').addEventListener('click', () => { form.reset(); requestId = newRequestId(); setStep(1); error('form-error'); intake.showModal(); });
$('close-intake').addEventListener('click', () => { if (!busy) intake.close(); });
$('close-detail').addEventListener('click', () => detail.close());
$('back').addEventListener('click', () => setStep(1));
$('refresh').addEventListener('click', () => void refresh());
form.addEventListener('submit', async e => {
  e.preventDefault(); if (busy) return;
  const values = new FormData(form); const body = {requestId,client:String(values.get('client') ?? '').trim(),title:String(values.get('title') ?? '').trim(),brief:String(values.get('brief') ?? '').trim()};
  if (!body.client || !body.title || !body.brief) { setStep(1); error('form-error','Please fill in the client, title and brief.'); return; }
  const useChief = !!chief?.brain.ready && ($('use-chief') as HTMLInputElement).checked;
  if (step === 1) {
    $('brief-review').replaceChildren(text('h3',`${body.client} / ${body.title}`),text('p',body.brief),text('p', useChief
      ? `The chief (${chiefTag(chief!.brain)}) drafts the work items from this brief. Your brief is sent to the model as data. Nothing launches: the proposed plan waits for your approval with an estimate, and a malformed answer is shown as needing attention, never guessed.`
      : 'The initial plan contains one work item matching your brief. Saving does not launch a worker. The next step shows a cost and time estimate with its basis; approve the job separately to start.'));
    setStep(2); return;
  }
  busy = true; ($('save-job') as HTMLButtonElement).disabled = true; error('form-error');
  if (useChief) {
    try {
      const r = await apiFetch('/api/chief/plans', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'The chief could not take this brief.');
      intake.close(); await refresh();
    } catch (e) { error('form-error', (e as Error).message); }
    finally { busy = false; ($('save-job') as HTMLButtonElement).disabled = false; }
    return;
  }
  try { const job = await api<ConsultancyJob>('jobs',body); jobs = [...jobs.filter(j => j.id !== job.id), job]; intake.close(); await refresh(); selected = job.id; error('action-error'); renderDetail(); detail.showModal(); }
  catch (e) { error('form-error',(e as Error).message); }
  finally { busy = false; ($('save-job') as HTMLButtonElement).disabled = false; if (detail.open) renderDetail(); }
});
intake.addEventListener('cancel',e => { if (busy) e.preventDefault(); });
// ORG-05: the research executive on the founder desk. Report text is rendered as text; links are https anchors only.
let researchSeen = '';
let researchRequest = newRequestId();
async function researchApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`/api/research${path}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000), ...(body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The host could not complete the request.');
  return data;
}
async function refreshResearch() {
  let state: ResearchState;
  try { state = await researchApi<ResearchState>(''); } catch { return; }
  const fp = JSON.stringify(state); if (fp === researchSeen) return; researchSeen = fp;
  const done = state.reports.filter(r => r.status === 'imported').length;
  $('research-summary').textContent = state.storageError ?? `${done} report${done === 1 ? '' : 's'} · ${state.openProposals} open tool proposal${state.openProposals === 1 ? '' : 's'} · reports are the worker's work, not verified`;
  const list = $('research-list'); list.replaceChildren();
  if (!state.reports.length) { list.append(text('li', 'No research yet. Ask the first question.', 'empty')); return; }
  for (const r of state.reports) {
    const li = document.createElement('li');
    const row = text('button', '', 'job research-row') as HTMLButtonElement; row.type = 'button'; row.dataset.status = r.status; row.dataset.report = r.jobId;
    const title = text('div', ''); title.append(text('small', r.worker ? `Researched by ${r.worker} — not verified` : 'Internal research'), text('strong', r.question), reportFacts(r));
    const open = r.tools.filter(t => t.decision === 'pending').length;
    if (r.reason) title.append(text('p', r.reason, 'research-reason'));
    row.append(title, text('span', open ? `${open} tool${open === 1 ? '' : 's'} to decide` : STATUS_LABEL[r.status]));
    row.addEventListener('click', () => void openResearch(r.jobId));
    li.append(row); list.append(li);
  }
}
// FREE-10: provenance links (consultancy.html?job=… or ?research=…) open the cited job or report once, after the first load.
let linked = false;
function deepLink() {
  if (linked) return;
  linked = true;
  const q = new URLSearchParams(location.search);
  const job = q.get('job'), report = q.get('research');
  if (job && jobs.some((j) => j.id === job)) { selected = job; renderDetail(); detail.showModal(); }
  else if (report) void openResearch(report);
}
mountMemory({ openJob: (id) => { if (!jobs.some((j) => j.id === id)) return false; selected = id; error('action-error'); renderDetail(); detail.showModal(); return true; } });
const researchDialog = $<HTMLDialogElement>('research-detail');
async function openResearch(jobId: string) {
  $('research-detail-title').textContent = 'Loading…'; $('research-detail-content').replaceChildren(); researchDialog.showModal();
  try {
    const report = await researchApi<ResearchReport>(`/reports/${encodeURIComponent(jobId)}`);
    $('research-detail-title').textContent = report.question;
    const body = reportBody(report);
    if (report.tools.some(t => t.decision === 'pending')) body.append(text('p', 'Decide tool proposals in the game inbox (CEO desk) or with /approve ID in Telegram. Approving only records your decision.', 'research-note'));
    $('research-detail-content').replaceChildren(body);
  } catch (e) { $('research-detail-content').replaceChildren(text('p', (e as Error).message, 'research-reason')); }
  $('close-research').focus();
}
$('close-research').addEventListener('click', () => researchDialog.close());
$<HTMLFormElement>('research-form').addEventListener('submit', async e => {
  e.preventDefault();
  const field = $<HTMLTextAreaElement>('research-question'); const button = $<HTMLButtonElement>('research-ask');
  const question = field.value.trim(); if (!question) { $('research-status').textContent = 'Write a question first.'; return; }
  button.disabled = true; $('research-status').textContent = 'Saving…';
  try {
    await researchApi('', { question, requestId: researchRequest });
    researchRequest = newRequestId(); field.value = '';
    $('research-status').textContent = 'Saved as an internal job. Approve it under Client engagements (client “Internal”), in the game inbox or in Telegram before any work starts.';
    await refresh();
  } catch (err) { $('research-status').textContent = (err as Error).message; }
  finally { button.disabled = false; }
});
void refresh();
const saveData = (navigator as Navigator & {connection?: {saveData?: boolean}}).connection?.saveData;
let timer: ReturnType<typeof setInterval> | undefined;
function startPolling() {
  if (timer !== undefined) return;
  timer = setInterval(() => { if (!document.hidden && !busy && !refreshing) void refresh(); }, saveData ? 30000 : 5000);
}
startPolling();
window.addEventListener('pagehide', () => {
  clearInterval(timer); timer = undefined; fresh = false;
  $('connection').textContent = 'Reconnecting to host…';
  if (detail.open) renderDetail();
});
window.addEventListener('pageshow', event => {
  startPolling();
  if (event.persisted) void refresh();
});

// Presentation effects; consultancy-scene-entry.ts exclusively owns the 3D controls.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
document.documentElement.dataset.saveData = String(Boolean(saveData));
// Pointer spotlight on metric cells (fine pointers only; purely cosmetic).
document.addEventListener('pointermove', e => {
  if (!finePointer.matches || reducedMotion.matches || saveData) return;
  const cell = (e.target instanceof Element ? e.target.closest<HTMLElement>('[data-spotlight]') : null); if (!cell) return;
  const r = cell.getBoundingClientRect();
  cell.style.setProperty('--mx', `${e.clientX - r.left}px`); cell.style.setProperty('--my', `${e.clientY - r.top}px`);
}, { passive: true });
// Scroll reveal for lower panels, only when motion is allowed; content is visible without it.
if (!reducedMotion.matches && !saveData && 'IntersectionObserver' in window) {
  const revealer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('is-in'); revealer.unobserve(entry.target); }
  }, { rootMargin: '0px 0px -6% 0px' });
  document.documentElement.classList.add('reveal-ready');
  for (const target of document.querySelectorAll<HTMLElement>('.workspace > *, .site-footer')) { target.classList.add('reveal'); revealer.observe(target); }
}
