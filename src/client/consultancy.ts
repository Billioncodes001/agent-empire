import type { ConsultancyJob } from '../shared/consultancy';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const labels: Record<string, string> = { awaiting_approval: 'Your approval', queued: 'Queued', running: 'In progress', needs_attention: 'Needs attention', awaiting_review: 'Ready for review', rejected: 'Declined' };
interface Snapshot { revision: number; jobs: ConsultancyJob[]; storageError?: string }
interface Status { repository: string; resources: { workstations: number; workers: number; attention: number; concurrency: number; queued: number | null; blocker?: string; mode: string }; telegram: {configured: boolean; running: boolean; error?: string; lastPollAt?: number} }
let jobs: ConsultancyJob[] = [], fresh = false, selected: string | undefined, busy = false, refreshing = false;
let lastRendered = '';
let refreshFlight: Promise<void> | undefined;
const detail = $<HTMLDialogElement>('job-detail'), intake = $<HTMLDialogElement>('intake');
const form = $<HTMLFormElement>('brief-form');
const newRequestId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
let step = 1, requestId = newRequestId();
const text = (tag: string, value: string, cls?: string) => { const n = document.createElement(tag); n.textContent = value; if (cls) n.className = cls; return n; };
function error(id: string, message = '') { const e = $(id); e.textContent = message; e.hidden = !message; }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/consultancy/${path}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000), ...(body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}) });
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
function renderDetail() {
  const focusedAction = detail.contains(document.activeElement) ? document.activeElement?.textContent : undefined;
  const job = jobs.find(j => j.id === selected); if (!job) return;
  const content = $('detail-content'); content.replaceChildren(text('h2',job.title),text('p',`${job.client} · ${labels[job.status] ?? job.status}`),text('p',job.brief));
  if (job.attention) content.append(text('p',job.attention));
  const plan = text('section','','plan'); plan.append(text('h3','Proposed work'));
  // Task prompts remain visible in full before approval, including plans created outside this form.
  for (const item of job.items) {
    plan.append(text('h3',item.title), text('small', labels[item.status] ?? item.status), text('p',item.prompt));
    if (item.attention) plan.append(text('p',item.attention));
  }
  content.append(plan, text('p','Approval submits these work items to this host’s local queue. Existing provider charges, budget, concurrency and funded desks still apply. Worker turn completion requires review before client delivery.'));
  const actions = $('detail-actions'); actions.replaceChildren();
  if (job.decision === 'pending_approval') {
    for (const [kind,label] of [['reject','Decline plan'],['approve','Approve & queue']] as const) {
      const b = text('button',label,kind === 'approve' ? 'primary' : 'quiet') as HTMLButtonElement;
      b.disabled = busy || !fresh;
      b.addEventListener('click',async () => {
        if (busy || !fresh) return;
        busy = true; error('action-error'); renderDetail();
        try { await api(`jobs/${encodeURIComponent(job.id)}/${kind}`,{}); await refresh(); }
        catch (e) { error('action-error',(e as Error).message); }
        finally { busy = false; renderDetail(); }
      });
      actions.append(b);
      if (focusedAction === label && !b.disabled) b.focus();
    }
  }
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
    $('active-count').textContent = String(jobs.filter(j => ['queued','running','needs_attention'].includes(j.status)).length);
    $('approval-count').textContent = String(jobs.filter(j => j.status === 'awaiting_approval').length);
    $('workers-count').textContent = String(status.resources.workers); $('desks-count').textContent = String(status.resources.workstations);
    $('chief-report').textContent = status.resources.blocker || `${status.resources.attention} workers need input. ${status.resources.queued} tasks waiting. Up to ${status.resources.concurrency} workers can run at once within the funded desk limit. Work is scoped to ${status.repository}.`;
    $('telegram-status').textContent = status.telegram.error || (!status.telegram.configured ? 'Not connected yet. Connect your private bot to send briefs, approve plans and receive updates.' : status.telegram.lastPollAt ? 'Connected to your configured private bot.' : 'Configured. Waiting for the first successful connection.');
    showJobs(); if (detail.open && (changed || !wasFresh)) renderDetail();
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
  if (step === 1) {
    $('brief-review').replaceChildren(text('h3',`${body.client} / ${body.title}`),text('p',body.brief),text('p','The initial plan contains one work item matching your brief. Saving does not launch a worker. Review and approve the job separately to start.'));
    setStep(2); return;
  }
  busy = true; ($('save-job') as HTMLButtonElement).disabled = true; error('form-error');
  try { const job = await api<ConsultancyJob>('jobs',body); jobs = [...jobs.filter(j => j.id !== job.id), job]; intake.close(); await refresh(); selected = job.id; error('action-error'); renderDetail(); detail.showModal(); }
  catch (e) { error('form-error',(e as Error).message); }
  finally { busy = false; ($('save-job') as HTMLButtonElement).disabled = false; if (detail.open) renderDetail(); }
});
intake.addEventListener('cancel',e => { if (busy) e.preventDefault(); });
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
