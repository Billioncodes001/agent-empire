// ORG-04a: the founder desk's email outreach section — campaigns with real per-recipient counts, leads (CSV import,
// proposed leads to accept), the suppression list, pause and cancel. Every number comes from the host's outreach.json.
import { apiFetch } from './endpoint';
import { LAWFUL_BASIS_NOTE, NO_IMAP_NOTE, NO_SCRAPING_NOTE, unverifiedLabel, type CampaignView, type OutreachState } from '../shared/outreach';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, text = '', cls?: string) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
const newRequestId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

const STATE_LABEL: Record<CampaignView['state'], string> = {
  drafting: 'Drafting', needs_attention: 'Needs attention', ready: 'Draft ready', awaiting_approval: 'Your approval',
  sending: 'Sending', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled', rejected: 'Declined',
};

let state: OutreachState | undefined;
let busy = false;
let lastRendered = '';
let campaignRequest = newRequestId();

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(`/api/outreach${path}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 401 ? 'Your session ended. Open the city and sign in again.' : (data as { error?: string }).error || 'The host could not complete the request.');
  return data as T;
}

function report(id: string, text: string, tone: 'ok' | 'error' = 'ok') {
  const p = $(id);
  p.textContent = text;
  p.dataset.tone = tone;
  p.hidden = !text;
}

function tally(c: CampaignView): HTMLElement {
  const box = el('dl', '', 'tally');
  const n = c.counts;
  if (!n) { box.append(el('div', 'No send approved yet — no email has left for this campaign.', 'tally-none')); return box; }
  for (const [label, value, tone] of [['Recipients', n.recipients, ''], ['Sent', n.sent, 'good'], ['Pending', n.pending + n.inFlight, ''], ['Refused', n.refused, n.refused ? 'warn' : ''], ['Failed', n.failed, n.failed ? 'warn' : ''], ['Suppressed', n.suppressed, ''], ['Unknown', n.unknown, n.unknown ? 'warn' : '']] as const) {
    const d = el('div');
    if (tone) d.dataset.tone = tone;
    d.append(el('dt', label), el('dd', String(value)));
    box.append(d);
  }
  return box;
}

function campaignCard(c: CampaignView): HTMLElement {
  const card = el('article', '', 'campaign');
  card.dataset.state = c.state;
  card.dataset.campaign = c.id;
  const head = el('header');
  const title = el('div');
  title.append(el('small', `${c.id} · created ${new Date(c.createdAt).toLocaleDateString()}`), el('strong', c.title));
  head.append(title, el('span', STATE_LABEL[c.state], 'campaign-state'));
  card.append(head);
  if (c.draft) {
    card.append(el('p', unverifiedLabel(c.draft.draftedBy), 'unverified'));
    const preview = el('details', '', 'campaign-draft');
    preview.append(el('summary', `Subject: ${c.draft.subject}`));
    const body = el('pre', c.draft.body);
    body.tabIndex = 0;
    preview.append(body, el('p', `Audience: ${c.draft.audience.join(', ')}${c.draft.proposedLeads ? ` · ${c.draft.proposedLeads} lead${c.draft.proposedLeads === 1 ? '' : 's'} proposed (unconfirmed)` : ''}`, 'campaign-meta'));
    if (c.snapshot) preview.append(el('pre', c.snapshot.footer, 'campaign-footer'), el('p', 'The footer above is added by the server to every email; the draft cannot change it.', 'campaign-meta'));
    card.append(preview);
  } else if (c.state === 'drafting') {
    card.append(el('p', 'Waiting for the drafting job: approve it under Client engagements (client “Internal”), then a worker writes the draft.', 'campaign-meta'));
  }
  if (c.issue) card.append(el('p', `Needs attention: ${c.issue}`, 'campaign-issue'));
  if (c.note) card.append(el('p', c.note, 'campaign-note'));
  if (c.snapshot) {
    const ex = c.snapshot.excluded;
    card.append(el('p', `From ${c.snapshot.from} · at most ${c.snapshot.dailyCap} a day · excluded ${ex.suppressed} suppressed, ${ex.invalid} invalid, ${ex.unconfirmed} unconfirmed`, 'campaign-meta'));
  }
  card.append(tally(c));
  if (c.state === 'awaiting_approval' && c.approvalId)
    card.append(el('p', `Waiting for you: ${c.approvalId}. Review the exact message and every recipient in the game inbox (CEO desk), or send /approve ${c.approvalId} in Telegram.`, 'campaign-approval'));
  const actions = el('div', '', 'campaign-actions');
  const button = (label: string, action: 'pause' | 'resume' | 'cancel', confirmText?: string) => {
    const b = el('button', label, action === 'cancel' ? 'quiet danger' : 'quiet') as HTMLButtonElement;
    b.type = 'button';
    b.disabled = busy;
    b.addEventListener('click', async () => {
      if (confirmText && !window.confirm(confirmText)) return;
      busy = true; render(true);
      try { await api(`/campaigns/${encodeURIComponent(c.id)}/${action}`, {}); await refresh(); }
      catch (e) { report('outreach-status', (e as Error).message, 'error'); }
      finally { busy = false; render(true); }
    });
    return b;
  };
  if (c.state === 'sending') actions.append(button('Pause sending', 'pause'));
  if (c.state === 'paused') actions.append(button('Resume sending', 'resume'));
  if (['drafting', 'needs_attention', 'ready', 'awaiting_approval', 'sending', 'paused'].includes(c.state))
    actions.append(button('Cancel campaign', 'cancel', `Cancel “${c.title}”? Nobody not yet emailed will be emailed. This cannot be undone.`));
  if (actions.childNodes.length) card.append(actions);
  if (c.results?.length) {
    const log = el('details', '', 'campaign-log');
    log.append(el('summary', `Per-recipient results (${c.results.length} most recent)`));
    const list = el('ul', '', 'ledger-list');
    for (const r of c.results) {
      const li = el('li');
      li.dataset.status = r.status;
      li.append(el('span', r.email), el('span', r.status.replace('_', ' '), 'chip'));
      if (r.detail) li.title = r.detail;
      list.append(li);
    }
    log.append(list);
    card.append(log);
  }
  return card;
}

function render(force = false) {
  if (!state) return;
  const fingerprint = JSON.stringify([state, busy]);
  if (!force && fingerprint === lastRendered) return;
  lastRendered = fingerprint;
  const s = state.status;
  const sent = `${s.sentToday} of ${s.dailyCap} sent today (UTC) · one message every ${s.intervalSec} s`;
  report('outreach-status', state.storageError ? state.storageError : s.sendingEnabled ? `${s.label} · from ${s.from} · ${sent}` : `${s.label}. ${s.problems.slice(1).join(' ')} Drafts and leads still work; nothing can be sent until this is set on the host.`, state.storageError || !s.sendingEnabled ? 'error' : 'ok');
  $('outreach-status').dataset.enabled = String(s.sendingEnabled);
  const campaigns = $('campaigns');
  const focused = campaigns.contains(document.activeElement) ? (document.activeElement as HTMLElement).textContent : undefined;
  campaigns.replaceChildren(...(state.campaigns.length ? state.campaigns.map(campaignCard) : [el('p', 'No campaigns yet. Import your leads, then brief a campaign; a worker drafts it after you approve the drafting job.', 'empty')]));
  if (focused) [...campaigns.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === focused)?.focus();
  const confirmed = state.leads.filter((l) => l.status === 'confirmed');
  const proposed = state.leads.filter((l) => l.status === 'proposed');
  $('lead-count').textContent = `${confirmed.length}`;
  $('suppression-count').textContent = `${state.suppression.length}`;
  const prop = $('proposed');
  prop.replaceChildren();
  if (proposed.length) {
    prop.append(el('p', `${proposed.length} lead${proposed.length === 1 ? '' : 's'} proposed by a worker — unconfirmed and never emailed until you accept, with your own lawful basis.`, 'ledger-report'));
    const list = el('ul', '', 'ledger-list proposed');
    for (const l of proposed) {
      const li = el('li');
      li.append(el('span', `${l.name || l.email} · ${l.email}${l.company ? ` · ${l.company}` : ''} — source “${l.source}”, basis “${l.basis}” (${l.proposedBy ?? 'worker'})`));
      for (const [label, action] of [['Accept', 'accept'], ['Decline', 'decline']] as const) {
        const b = el('button', label, 'quiet small') as HTMLButtonElement;
        b.type = 'button';
        b.disabled = busy;
        b.setAttribute('aria-label', `${label} ${l.email}`);
        b.addEventListener('click', async () => {
          busy = true; render(true);
          try { await api(`/leads/${l.id}/${action}`, {}); await refresh(); } catch (e) { report('import-report', (e as Error).message, 'error'); }
          finally { busy = false; render(true); }
        });
        li.append(b);
      }
      list.append(li);
    }
    prop.append(list);
  }
  $('lead-details').querySelector('summary')!.textContent = `All leads (${state.leads.length})`;
  $('lead-list').replaceChildren(...state.leads.slice(0, 300).map((l) => {
    const li = el('li');
    li.dataset.status = l.status;
    li.append(el('span', `${l.id} · ${l.name || '—'} · ${l.email}${l.company ? ` · ${l.company}` : ''}${l.tags.length ? ` · #${l.tags.join(' #')}` : ''}`), el('span', l.status === 'proposed' ? 'proposed' : `basis: ${l.basis}`, 'chip'));
    li.title = `Source: ${l.source} · Basis: ${l.basis}`;
    return li;
  }));
  $('suppression-list').replaceChildren(...[...state.suppression].reverse().slice(0, 200).map((x) => {
    const li = el('li');
    li.append(el('span', x.email), el('span', x.reason.replace('_', '-'), 'chip'));
    li.title = `${x.by}${x.note ? ` · ${x.note}` : ''}`;
    return li;
  }));
}

let flight: Promise<void> | undefined;
async function refresh() {
  if (flight) await flight;
  flight = (async () => {
    try { state = await api<OutreachState>(''); render(); }
    catch (e) { report('outreach-status', (e as Error).message, 'error'); }
  })();
  try { await flight; } finally { flight = undefined; }
}

$('lawful-note').textContent = LAWFUL_BASIS_NOTE;
$('scraping-note').textContent = NO_SCRAPING_NOTE;
$('imap-note').textContent = NO_IMAP_NOTE;

$('lead-file').addEventListener('change', async () => {
  const file = ($('lead-file') as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 1024 * 1024) { report('import-report', 'The CSV is larger than 1 MB.', 'error'); return; }
  ($('lead-csv') as HTMLTextAreaElement).value = await file.text();
});

$('lead-import').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const csv = ($('lead-csv') as HTMLTextAreaElement).value;
  if (!csv.trim()) { report('import-report', 'Paste CSV rows or choose a file first.', 'error'); return; }
  busy = true; render(true);
  try {
    const r = await api<{ added: number; confirmed: number; duplicates: number; errors: { line: number; reason: string }[] }>('/leads/import', { csv });
    const errors = r.errors.slice(0, 6).map((x) => `line ${x.line}: ${x.reason}`).join('; ');
    report('import-report', `Imported ${r.added} new lead${r.added === 1 ? '' : 's'}${r.confirmed ? `, confirmed ${r.confirmed} proposed` : ''}, skipped ${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'}.${r.errors.length ? ` ${r.errors.length} row${r.errors.length === 1 ? '' : 's'} refused — ${errors}${r.errors.length > 6 ? '; …' : ''}` : ''}`, r.errors.length ? 'error' : 'ok');
    if (!r.errors.length) ($('lead-csv') as HTMLTextAreaElement).value = '';
    await refresh();
  } catch (err) { report('import-report', (err as Error).message, 'error'); }
  finally { busy = false; render(true); }
});

$('optout-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const email = ($('optout-email') as HTMLInputElement).value.trim();
  if (!email) { report('optout-report', 'Enter the address to suppress.', 'error'); return; }
  busy = true; render(true);
  try {
    const s = await api<{ email: string; reason: string }>('/suppression', { email, reason: ($('optout-reason') as HTMLSelectElement).value });
    report('optout-report', `${s.email} will never be emailed again (${s.reason.replace('_', '-')}).`);
    ($('optout-email') as HTMLInputElement).value = '';
    await refresh();
  } catch (err) { report('optout-report', (err as Error).message, 'error'); }
  finally { busy = false; render(true); }
});

const intake = $<HTMLDialogElement>('campaign-intake');
$('new-campaign').addEventListener('click', () => { ($('campaign-form') as HTMLFormElement).reset(); campaignRequest = newRequestId(); report('campaign-error', ''); intake.showModal(); });
$('close-campaign').addEventListener('click', () => intake.close());
$('campaign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const title = ($('campaign-title') as HTMLInputElement).value.trim();
  const brief = ($('campaign-brief') as HTMLTextAreaElement).value.trim();
  if (!title || !brief) { report('campaign-error', 'Give the campaign a title and a brief.', 'error'); return; }
  busy = true;
  ($('save-campaign') as HTMLButtonElement).disabled = true;
  try {
    await api('/campaigns', { requestId: campaignRequest, title, brief });
    intake.close();
    await refresh();
    report('outreach-status', `Saved “${title}”. Its drafting job waits for your approval under Client engagements (client “Internal”).`);
  } catch (err) { report('campaign-error', (err as Error).message, 'error'); }
  finally { busy = false; ($('save-campaign') as HTMLButtonElement).disabled = false; }
});

void refresh();
const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
setInterval(() => { if (!document.hidden && !busy) void refresh(); }, saveData ? 30000 : 5000);
if (location.hash === '#outreach') requestAnimationFrame(() => $('outreach-title').focus({ preventScroll: false }));
