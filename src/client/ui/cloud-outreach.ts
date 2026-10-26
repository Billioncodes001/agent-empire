// FREE-12: email outreach in cloud mode. Everything comes from the coordinator's snapshot (state/outreach.json); every
// change is an intent. The SMTP URL is the user's own Actions secret (AGENT_EMPIRE_SMTP_URL): only its NAME is checked.
// Opt-outs are hashed here with the Empire's salt, so the plain address never enters the repository through them.
// Every send still waits in the inbox for the CEO's approval of the exact message and recipients.

import { cloudGapMessage } from '../../shared/org-capabilities';
import { normalizeEmail } from '../../shared/email-address';
import { checkCampaignText } from '../../shared/outreach-render';
import { PRIVACY_WARNING, deliveryEstimate, emptyOutreach, suppressionHash, type CloudCampaign } from '../../cloud/outreach';
import { activeCloudNet } from '../cloud/active';
import { store } from '../state';
import { h, openModal } from './dom';
import { morphChildren } from './reconcile';
import { openInbox } from './inbox';

const SMTP_SECRET = 'AGENT_EMPIRE_SMTP_URL';
const outreachNow = () => store.cloud?.snapshot?.state.outreach ?? emptyOutreach();
const intervalNow = () => store.cloud?.snapshot?.state.meta.schedule.intervalMinutes ?? 30;
const STATE_LABEL: Record<CloudCampaign['state'], string> = { draft: 'Draft', awaiting_approval: 'Waiting for your approval', sending: 'Sending', done: 'Finished', cancelled: 'Cancelled', rejected: 'Declined' };

export function openCloudOutreach() {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close outreach' }, '✕');
  const net = () => activeCloudNet();
  const say = (el: HTMLElement, text: string) => { el.textContent = text; };
  const s0 = outreachNow().settings;

  // ---- setup
  const from = h('input', { id: 'out-from', type: 'email', maxlength: 254, value: s0?.from ?? '', autocomplete: 'off' }) as HTMLInputElement;
  const fromName = h('input', { id: 'out-name', type: 'text', maxlength: 80, value: s0?.fromName ?? '' }) as HTMLInputElement;
  const address = h('input', { id: 'out-address', type: 'text', maxlength: 300, value: s0?.address ?? '', placeholder: 'Company name, street, city (printed in every email)' }) as HTMLInputElement;
  const daily = h('input', { id: 'out-daily', type: 'number', min: '1', max: '2000', step: '1', value: String(s0?.dailyCap ?? 50) }) as HTMLInputElement;
  const perRun = h('input', { id: 'out-run', type: 'number', min: '1', max: '100', step: '1', value: String(s0?.perRunCap ?? 20) }) as HTMLInputElement;
  const ack = h('input', { id: 'out-ack', type: 'checkbox' }) as HTMLInputElement;
  const setupStatus = h('p.memory-status', { role: 'status', 'aria-live': 'polite' });
  const secretLine = h('p.setting-note', { role: 'status' }, `Your SMTP URL (smtp:// or smtps://user:password@host:port) goes in the Actions secret ${SMTP_SECRET} of your state repository. Set it yourself; this app never asks for it. Only a separate send job, which runs no model, can read it.`);
  const setup = h('form.memory-add.out-setup', {},
    h('p.inbox-error.out-privacy', { role: 'note' }, PRIVACY_WARNING),
    h('label.check', { for: 'out-ack' }, ack, ' I understand where lead data is kept and that git history keeps old versions.'),
    h('label', { for: 'out-from' }, 'Sender address'), from, h('label', { for: 'out-name' }, 'Sender name (optional)'), fromName,
    h('label', { for: 'out-address' }, 'Sender identity and postal address'), address,
    h('div.brain-caps', {}, h('label', { for: 'out-run' }, 'At most per coordinator run'), perRun, h('label', { for: 'out-daily' }, 'At most per day (UTC)'), daily),
    secretLine,
    h('div.research-actions', {}, h('button.btn.primary', { type: 'submit' }, 'Save sender settings'), h('button.btn', { type: 'button', onclick: async () => {
      const n = net(); if (!n) return say(secretLine, 'Cloud mode is not connected on this device yet.');
      const r = await n.repo.secretNames([SMTP_SECRET]);
      say(secretLine, r.error ?? (r.present[SMTP_SECRET] ? `✓ The secret ${SMTP_SECRET} exists. (Only its name was checked.)` : `✕ No secret named ${SMTP_SECRET} yet: nothing can be sent until you add it.`));
    } }, 'Check secret name')), setupStatus);
  setup.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!ack.checked) { say(setupStatus, 'Not sent: acknowledge the privacy warning first.'); ack.focus(); return; }
    const n = net(); if (!n) return say(setupStatus, 'Cloud mode is not connected on this device yet.');
    const id = await n.submit({ kind: 'outreach_settings', settings: { from: from.value.trim(), ...(fromName.value.trim() ? { fromName: fromName.value.trim() } : {}), address: address.value.trim(), dailyCap: Number(daily.value), perRunCap: Number(perRun.value) }, acknowledgePrivacy: true }, 'Outreach sender settings');
    say(setupStatus, id ? 'Sent to your coordinator.' : 'Not sent; nothing changed.');
  });

  // ---- leads and opt-outs
  const leadsText = h('textarea', { id: 'out-leads', rows: 3, placeholder: 'One per line: email, name, company, tags (space-separated)' }) as HTMLTextAreaElement;
  const leadsStatus = h('p.memory-status', { role: 'status', 'aria-live': 'polite' });
  const leadsForm = h('form.memory-add', {}, h('label', { for: 'out-leads' }, 'Add leads (people who agreed to hear from you)'), leadsText, h('div.research-actions', {}, h('button.btn', { type: 'submit' }, 'Add leads')), leadsStatus);
  leadsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rows = leadsText.value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!rows.length || rows.length > 200) return say(leadsStatus, 'Not sent: add 1–200 leads at a time.');
    const leads = [];
    for (const [i, row] of rows.entries()) {
      const [email, name = '', company = '', tags = ''] = row.split(',').map((x) => x.trim());
      if (!normalizeEmail(email)) return say(leadsStatus, `Not sent: line ${i + 1} has no plain email address.`);
      leads.push({ email, ...(name ? { name } : {}), ...(company ? { company } : {}), ...(tags ? { tags: tags.split(/\s+/).filter(Boolean) } : {}) });
    }
    const n = net(); if (!n) return say(leadsStatus, 'Cloud mode is not connected on this device yet.');
    const id = await n.submit({ kind: 'outreach_leads', leads: leads as never }, `Add ${leads.length} lead${leads.length === 1 ? '' : 's'}`);
    if (id) { leadsText.value = ''; say(leadsStatus, 'Sent. Leads appear after your coordinator’s next run.'); }
  });
  const optEmail = h('input', { id: 'out-optout', type: 'email', maxlength: 254, autocomplete: 'off' }) as HTMLInputElement;
  const optStatus = h('p.memory-status', { role: 'status', 'aria-live': 'polite' });
  const optForm = h('form.memory-add', {}, h('label', { for: 'out-optout' }, 'Record an opt-out (someone replied STOP)'), optEmail,
    h('p.setting-note', {}, 'Hashed on this device with your Empire’s salt; only the hash is sent, and the lead is removed.'),
    h('div.research-actions', {}, h('button.btn', { type: 'submit' }, 'Suppress address')), optStatus);
  optForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const o = outreachNow();
    const email = normalizeEmail(optEmail.value);
    if (!email) return say(optStatus, 'Not sent: enter one plain email address.');
    if (!o.salt) return say(optStatus, 'Not sent: save the sender settings first.');
    const n = net(); if (!n) return say(optStatus, 'Cloud mode is not connected on this device yet.');
    const id = await n.submit({ kind: 'outreach_suppress', hash: suppressionHash(o.salt, email), reason: 'unsubscribed' }, 'Record an opt-out');
    if (id) { optEmail.value = ''; say(optStatus, 'Sent. Only the hash reaches your repository.'); }
  });

  // ---- campaigns
  const cTitle = h('input', { id: 'out-c-title', type: 'text', maxlength: 120 }) as HTMLInputElement;
  const cSubject = h('input', { id: 'out-c-subject', type: 'text', maxlength: 150, placeholder: 'Hello {{name}}' }) as HTMLInputElement;
  const cBody = h('textarea', { id: 'out-c-body', rows: 5, maxlength: 20000, placeholder: 'Plain text. Merge fields: {{name}} and {{company}}. Your footer with the postal address and STOP line is added to every email.' }) as HTMLTextAreaElement;
  const cAudience = h('input', { id: 'out-c-audience', type: 'text', placeholder: 'Lead tags, space-separated, or all' }) as HTMLInputElement;
  const cStatus = h('p.memory-status', { role: 'status', 'aria-live': 'polite' });
  const cForm = h('form.memory-add', {}, h('label', { for: 'out-c-title' }, 'Campaign title'), cTitle, h('label', { for: 'out-c-subject' }, 'Subject'), cSubject, h('label', { for: 'out-c-body' }, 'Message'), cBody, h('label', { for: 'out-c-audience' }, 'Audience'), cAudience,
    h('p.setting-note', {}, 'Your coordinator freezes the exact message and every recipient into one inbox item. Nothing is sent until you approve it there.'),
    h('div.research-actions', {}, h('button.btn.primary', { type: 'submit' }, 'Write campaign')), cStatus);
  cForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = checkCampaignText(cSubject.value, cBody.value);
    if ('error' in text) return say(cStatus, `Not sent: ${text.error}.`);
    const audience = cAudience.value.trim().split(/\s+/).filter(Boolean);
    if (!cTitle.value.trim() || !audience.length) return say(cStatus, 'Not sent: add a title and an audience.');
    const n = net(); if (!n) return say(cStatus, 'Cloud mode is not connected on this device yet.');
    const id = await n.submit({ kind: 'outreach_campaign', campaign: { title: cTitle.value.trim(), subject: text.ok.subject, body: text.ok.body, audience } }, `Campaign “${cTitle.value.trim().slice(0, 40)}”`);
    if (id) say(cStatus, 'Sent. It appears in the inbox for your approval after your coordinator’s next run.');
  });

  const summary = h('div.out-summary', { role: 'status', 'aria-live': 'polite' });
  const campaigns = h('ul.memory-list.out-campaigns', { 'aria-label': 'Campaigns' });
  const delStatus = h('p.memory-status', { role: 'status', 'aria-live': 'polite' });
  let confirmDelete = false;
  const delBox = h('div.out-delete');
  const renderDelete = () => delBox.replaceChildren(
    h('h3', {}, 'Delete lead data'),
    h('p.setting-note', {}, 'Removes every lead and every stored recipient address from the current files in one commit, and cancels unsent messages. Opt-out hashes stay so those people stay suppressed. Git history still contains old versions: only rewriting the repository’s history (for example with git filter-repo, then a force-push you do yourself) removes them.'),
    confirmDelete
      ? h('div.inbox-confirm', { role: 'group', 'aria-label': 'Confirm deletion' }, h('p', {}, 'Delete all lead data now?'), h('div.inbox-actions', {},
          h('button.btn.danger', { type: 'button', onclick: async () => { const n = net(); if (!n) return; const id = await n.submit({ kind: 'outreach_delete_leads', confirm: true }, 'Delete lead data'); confirmDelete = false; renderDelete(); say(delStatus, id ? 'Sent. Your coordinator deletes the lead data on its next run. Git history keeps old versions.' : 'Not sent.'); } }, 'Confirm delete'),
          h('button.btn', { type: 'button', onclick: () => { confirmDelete = false; renderDelete(); } }, 'Cancel')))
      : h('button.btn.danger', { type: 'button', onclick: () => { confirmDelete = true; renderDelete(); delBox.querySelector<HTMLElement>('.btn.danger')?.focus(); } }, 'Delete lead data…'),
    delStatus);
  renderDelete();

  const render = () => {
    const o = outreachNow();
    const err = store.cloud?.snapshot?.state.outreachError;
    morphChildren(summary, [
      h('p', { 'data-key': 's' }, o.settings ? `Sender ${o.settings.fromName ? `${o.settings.fromName} <${o.settings.from}>` : o.settings.from} · at most ${o.settings.perRunCap} per run and ${o.settings.dailyCap} a day · coordinator every ${intervalNow()} minutes` : 'Not set up yet.'),
      h('p.setting-note', { 'data-key': 'n' }, `${o.leads.length} lead${o.leads.length === 1 ? '' : 's'} · ${o.suppression.length} opt-out${o.suppression.length === 1 ? '' : 's'} (hashed)`),
      ...(err ? [h('p.inbox-error', { 'data-key': 'e', role: 'alert' }, `The outreach file could not be read: ${err}`)] : []),
    ]);
    const list = [...o.campaigns].sort((a, b) => b.createdAt - a.createdAt);
    morphChildren(campaigns, list.length ? list.map((c) => {
      const left = c.sends?.filter((s) => s.status === 'pending' || s.status === 'claimed').length ?? 0;
      const sent = c.sends?.filter((s) => s.status === 'sent').length ?? 0;
      const eta = c.state === 'sending' && left && o.settings ? deliveryEstimate(left, o.settings, intervalNow()).text : c.state === 'awaiting_approval' && c.snapshot ? deliveryEstimate(c.snapshot.recipients.length, c.snapshot, intervalNow()).text : '';
      return h('li', { 'data-key': c.id, 'data-state': c.state },
        h('strong', {}, `${c.id} · ${c.title}`), h('span.memory-meta', {}, ` · ${STATE_LABEL[c.state]}${c.sends ? ` · ${sent} sent of ${c.sends.length}` : ''}`),
        c.note ? h('p.setting-note', {}, c.note) : null, eta ? h('p.setting-note.out-eta', {}, `Expected delivery: ${eta}`) : null,
        h('div.research-actions', {},
          c.approvalId && c.state === 'awaiting_approval' ? h('button.btn.exec-link', { type: 'button', onclick: () => { modal.close(); openInbox(c.approvalId); } }, `Review ${c.approvalId} in the inbox`) : null,
          ['draft', 'awaiting_approval', 'sending'].includes(c.state) ? h('button.btn', { type: 'button', onclick: async () => { const n = net(); if (n) await n.submit({ kind: 'outreach_cancel', campaignId: c.id }, `Cancel ${c.id}`); } }, 'Cancel campaign') : null));
    }) : [h('li.memory-empty', { 'data-key': 'none' }, 'No campaigns yet.')]);
  };
  const modal = openModal(h('div.modal.exec-modal.cloud-outreach', { role: 'dialog', 'aria-labelledby': 'cloud-outreach-title' },
    h('header', {}, h('small.empire-eyebrow', {}, 'Marketing & sales · cloud mode'), close),
    h('div.exec-body', {},
      h('h2', { id: 'cloud-outreach-title' }, 'Email outreach'),
      h('p.exec-note.exec-cloud-gap', { 'data-gap': 'outreach' }, cloudGapMessage('outreach')),
      summary, h('h3', {}, 'Campaigns'), campaigns, cForm, h('h3', {}, 'Leads'), leadsForm, optForm, h('h3', {}, 'Sender and privacy'), setup, delBox)), { onClose: () => off() });
  const off = store.on('cloud', render);
  close.addEventListener('click', () => modal.close());
  render();
  close.focus();
}
