// FREE-11: the chief's planning brain in cloud mode. Settings, spend and requests come from the coordinator's snapshot
// (state/brain.json); every change is an intent the coordinator applies on its next run. The key is the user's own
// Actions secret: this panel only checks that the secret's NAME exists, and has no field that could take a value.
// Output is proposals only: plans, reviews and unblock ideas wait in the inbox for the CEO.

import { HOSTED_FREE, HOSTED_TERMS_CAVEAT } from '../../shared/engines';
import { MAX_BRIEF_CHARS } from '../../shared/chief';
import { cloudGapMessage } from '../../shared/org-capabilities';
import { BRAIN_PROVIDER_LABEL, FREE_BRAIN_PROVIDERS, brainSecretName, brainStatus, emptyBrain, type BrainProvider, type BrainRequest } from '../../cloud/brain';
import { activeCloudNet } from '../cloud/active';
import { store } from '../state';
import { h, openModal } from './dom';
import { morphChildren } from './reconcile';
import { openInbox } from './inbox';

const brainNow = () => store.cloud?.snapshot?.state.brain ?? emptyBrain();
const jobsNow = () => store.cloud?.snapshot?.state.jobs.jobs ?? [];
const STATUS: Record<BrainRequest['status'], string> = { queued: 'Waiting for the coordinator', charged: 'Charged; answer not recorded yet', done: 'Proposal in the inbox', needs_attention: 'Needs attention', uncertain: 'Uncertain (never called again)' };

export function openCloudBrain() {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close the chief’s brain' }, '✕');
  const statusBox = h('div.brain-status', { role: 'status', 'aria-live': 'polite' });
  const requests = h('ul.memory-list.brain-requests', { 'aria-label': 'Requests to the chief' });
  const formStatus = h('p.memory-status', { role: 'status', 'aria-live': 'polite' });
  const s0 = brainNow().settings;

  // ---- settings
  const mode = h('select', { id: 'brain-mode' }, h('option', { value: 'off' }, 'Off · rule-based'), h('option', { value: 'free' }, 'Free tier · your own key'), h('option', { value: 'premium' }, 'Premium · your API key')) as HTMLSelectElement;
  mode.value = s0.mode;
  const provider = h('select', { id: 'brain-provider' }) as HTMLSelectElement;
  const model = h('input', { id: 'brain-model', type: 'text', maxlength: 100, value: s0.model, placeholder: 'Model id, e.g. a free model on OpenRouter', autocomplete: 'off' }) as HTMLInputElement;
  const priceIn = h('input', { id: 'brain-price-in', type: 'number', inputmode: 'decimal', min: '0.01', step: '0.01', value: s0.price ? String(s0.price[0]) : '' }) as HTMLInputElement;
  const priceOut = h('input', { id: 'brain-price-out', type: 'number', inputmode: 'decimal', min: '0.01', step: '0.01', value: s0.price ? String(s0.price[1]) : '' }) as HTMLInputElement;
  const daily = h('input', { id: 'brain-daily', type: 'number', inputmode: 'decimal', min: '0.01', max: '100', step: '0.01', value: (s0.dailyCapCents / 100).toFixed(2) }) as HTMLInputElement;
  const monthly = h('input', { id: 'brain-monthly', type: 'number', inputmode: 'decimal', min: '0.01', max: '1000', step: '0.01', value: (s0.monthlyCapCents / 100).toFixed(2) }) as HTMLInputElement;
  const freeCalls = h('input', { id: 'brain-free-calls', type: 'number', inputmode: 'numeric', min: '1', max: '500', step: '1', value: String(s0.freeCallsPerDay) }) as HTMLInputElement;
  const terms = h('div.brain-terms');
  const accept = h('input', { id: 'brain-accept', type: 'checkbox' }) as HTMLInputElement;
  const confirmPaid = h('input', { id: 'brain-confirm-paid', type: 'checkbox' }) as HTMLInputElement;
  const secretLine = h('p.setting-note.brain-secret', { role: 'status' });
  const premiumRows = h('div.brain-premium');
  const freeRows = h('div.brain-free');
  const shared = h('div.brain-shared');
  const syncMode = () => {
    const m = mode.value;
    const options: BrainProvider[] = m === 'premium' ? ['anthropic', 'openai'] : [...FREE_BRAIN_PROVIDERS];
    const keep = options.includes(provider.value as BrainProvider) ? provider.value : options.includes(s0.provider) ? s0.provider : options[0];
    provider.replaceChildren(...options.map((p) => h('option', { value: p }, BRAIN_PROVIDER_LABEL[p])));
    provider.value = keep;
    premiumRows.hidden = m !== 'premium'; freeRows.hidden = m !== 'free'; shared.hidden = m === 'off';
    const hosted = HOSTED_FREE.find((x) => x.id === provider.value);
    terms.replaceChildren(...(hosted ? [h('p', {}, h('strong', {}, `${hosted.name}: `), hosted.terms, ' ', h('a', { href: hosted.termsUrl, target: '_blank', rel: 'noopener' }, 'Read the terms ↗')), h('p.setting-note', {}, HOSTED_TERMS_CAVEAT)] : []));
    secretLine.textContent = m === 'off' ? '' : `Your key goes in the Actions secret ${brainSecretName(provider.value as BrainProvider)} of your state repository. Set it yourself (GitHub → Settings → Secrets and variables → Actions, or gh secret set); this app never asks for it. A Claude subscription is never used for the brain.`;
  };
  mode.addEventListener('change', syncMode);
  provider.addEventListener('change', syncMode);
  const checkSecret = h('button.btn', { type: 'button', onclick: async () => {
    const net = activeCloudNet();
    if (!net) { secretLine.textContent = 'Cloud mode is not connected on this device yet.'; return; }
    const name = brainSecretName(provider.value as BrainProvider);
    const r = await net.repo.secretNames([name]);
    secretLine.textContent = r.error ?? (r.present[name] ? `✓ The secret ${name} exists. (Only its name was checked.)` : `✕ No secret named ${name} yet. Add it in your state repository’s Actions secrets.`);
  } }, 'Check secret name');
  freeRows.append(
    h('label', { for: 'brain-free-calls' }, 'Free-tier calls a day'), freeCalls, terms,
    h('label.check', { for: 'brain-accept' }, accept, ' I read this provider’s data-use terms. My briefs and job summaries are sent to it.'));
  premiumRows.append(
    h('div.brain-price', {}, h('label', { for: 'brain-price-in' }, 'Input US$ / million tokens'), priceIn, h('label', { for: 'brain-price-out' }, 'Output US$ / million tokens'), priceOut),
    h('p.setting-note', {}, 'Your provider’s current price, so the caps can be enforced. It cannot be zero. Each call’s worst case is charged before it is made.'),
    h('label.check', { for: 'brain-confirm-paid' }, confirmPaid, ' I understand each call spends money on my key, up to these caps.'));
  shared.append(
    h('label', { for: 'brain-provider' }, 'Provider'), provider, h('label', { for: 'brain-model' }, 'Model'), model,
    h('div.brain-caps', {}, h('label', { for: 'brain-daily' }, 'Daily cap (US$, UTC day)'), daily, h('label', { for: 'brain-monthly' }, 'Cap for the last 30 days (US$)'), monthly),
    secretLine, checkSecret);
  const saveBtn = h('button.btn.primary', { type: 'submit' }, 'Save brain settings') as HTMLButtonElement;
  const settingsForm = h('form.brain-settings', {}, h('label', { for: 'brain-mode' }, 'Brain'), mode, freeRows, premiumRows, shared, h('div.research-actions', {}, saveBtn), formStatus);
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const m = mode.value;
    const cents = (v: string) => Math.round(Number(v) * 100);
    let settings: Record<string, unknown>;
    if (m === 'off') settings = { mode: 'off' };
    else {
      settings = { mode: m, provider: provider.value, model: model.value.trim(), dailyCapCents: cents(daily.value), monthlyCapCents: cents(monthly.value) };
      if (m === 'free') { if (!accept.checked) { formStatus.textContent = 'Not sent: accept the provider’s data-use terms first.'; accept.focus(); return; } Object.assign(settings, { freeCallsPerDay: Number(freeCalls.value), acceptTerms: provider.value }); }
      else {
        const p = [Number(priceIn.value), Number(priceOut.value)];
        if (!(p[0] > 0 && p[1] > 0)) { formStatus.textContent = 'Not sent: set both prices; a paid API price cannot be zero.'; priceIn.focus(); return; }
        if (!confirmPaid.checked) { formStatus.textContent = 'Not sent: confirm that calls spend money on your key.'; confirmPaid.focus(); return; }
        settings.price = p;
      }
      if (!model.value.trim()) { formStatus.textContent = 'Not sent: enter the model id.'; model.focus(); return; }
    }
    const net = activeCloudNet();
    if (!net) { formStatus.textContent = 'Cloud mode is not connected on this device yet.'; return; }
    saveBtn.disabled = true;
    const id = await net.submit({ kind: 'brain_settings', settings: settings as never, ...(m === 'premium' ? { confirmPaid: true as const } : {}) }, m === 'off' ? 'Turn the chief’s brain off' : 'Chief’s brain settings');
    saveBtn.disabled = false;
    formStatus.textContent = id ? 'Sent to your coordinator. It applies the settings on its next run.' : 'Not sent; nothing changed.';
  });

  // ---- plan request
  const client = h('input', { id: 'brain-client', type: 'text', maxlength: 120, placeholder: 'Client (optional)' }) as HTMLInputElement;
  const title = h('input', { id: 'brain-title', type: 'text', maxlength: 120, placeholder: 'e.g. Booking request form' }) as HTMLInputElement;
  const brief = h('textarea', { id: 'brain-brief', rows: 4, maxlength: MAX_BRIEF_CHARS, placeholder: 'What should be built, for whom, and what “done” means.' }) as HTMLTextAreaElement;
  const askStatus = h('p.memory-status', { role: 'status', 'aria-live': 'polite' });
  const askBtn = h('button.btn.primary', { type: 'submit' }, 'Ask the chief for a plan') as HTMLButtonElement;
  const planForm = h('form.memory-add.brain-plan', {},
    h('label', { for: 'brain-title' }, 'Plan title'), title, h('label', { for: 'brain-client' }, 'Client'), client, h('label', { for: 'brain-brief' }, 'Brief'), brief,
    h('p.setting-note', {}, 'Your coordinator charges the call’s worst case first, then asks the model. The plan comes back as a proposal in the inbox with every prompt; approving it spends nothing, and each item is submitted as a paid job only when you confirm it.'),
    h('div.research-actions', {}, askBtn), askStatus);
  planForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!title.value.trim() || !brief.value.trim()) { askStatus.textContent = 'Not sent: write a title and a brief.'; (title.value.trim() ? brief : title).focus(); return; }
    if (brainNow().settings.mode === 'off') { askStatus.textContent = 'Not sent: the brain is off. Turn it on above first.'; return; }
    const net = activeCloudNet();
    if (!net) { askStatus.textContent = 'Cloud mode is not connected on this device yet.'; return; }
    askBtn.disabled = true;
    const id = await net.submit({ kind: 'brain_request', request: { kind: 'plan', title: title.value.trim(), ...(client.value.trim() ? { client: client.value.trim() } : {}), brief: brief.value.trim() } }, `Plan “${title.value.trim().slice(0, 40)}”`);
    askBtn.disabled = false;
    if (id) { askStatus.textContent = 'Sent. The proposal appears in the inbox after your coordinator’s next run.'; brief.value = ''; }
  });

  // ---- review / unblock a job
  const jobSelect = h('select', { id: 'brain-job' }) as HTMLSelectElement;
  const jobStatus = h('p.memory-status', { role: 'status', 'aria-live': 'polite' });
  const ask = async (kind: 'review' | 'unblock') => {
    const net = activeCloudNet();
    const job = jobsNow().find((j) => j.id === jobSelect.value);
    if (!net || !job) { jobStatus.textContent = 'Choose a job first.'; return; }
    const id = await net.submit({ kind: 'brain_request', request: { kind, jobId: job.id } }, `${kind === 'review' ? 'Review' : 'Unblock'} “${job.title.slice(0, 40)}”`);
    jobStatus.textContent = id ? 'Sent. The chief’s proposal appears in the inbox after the next run; it never decides the job.' : 'Not sent.';
  };
  const jobBox = h('div.brain-jobs', {}, h('label', { for: 'brain-job' }, 'Ask about a cloud job'), jobSelect,
    h('div.research-actions', {}, h('button.btn', { type: 'button', onclick: () => void ask('review') }, 'Ask for a review'), h('button.btn', { type: 'button', onclick: () => void ask('unblock') }, 'Ask how to unblock')), jobStatus);

  const render = () => {
    const brain = brainNow();
    const st = brainStatus(brain, Date.now());
    morphChildren(statusBox, [h('p', { 'data-key': 'label' }, h('strong', {}, st.label)), h('p.setting-note', { 'data-key': 'note' }, st.note), ...(store.cloud?.snapshot?.state.brainError ? [h('p.inbox-error', { 'data-key': 'err', role: 'alert' }, `The brain file could not be read: ${store.cloud.snapshot.state.brainError}`)] : [])]);
    const list = [...brain.requests].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
    morphChildren(requests, list.length ? list.map((r) => h('li', { 'data-key': r.id, 'data-status': r.status },
      h('strong', {}, r.kind === 'plan' ? `Plan: ${r.title}` : `${r.kind === 'review' ? 'Review' : 'Unblock'}: ${jobsNow().find((j) => j.id === r.jobId)?.title ?? 'a cloud job'}`),
      h('span.memory-meta', {}, ` · ${STATUS[r.status]}${r.model ? ` · ${r.model}` : ''}`),
      r.reason ? h('p.setting-note', {}, r.reason) : null,
      r.approvalId ? h('button.btn.exec-link', { type: 'button', onclick: () => { modal.close(); openInbox(r.approvalId); } }, `Open ${r.approvalId} in the inbox`) : null)) : [h('li.memory-empty', { 'data-key': 'none' }, 'No requests yet.')]);
    const eligible = jobsNow().filter((j) => ['awaiting_review', 'accepted', 'rejected', 'failed', 'dispatch_uncertain', 'unknown', 'cancelled', 'budget_paused'].includes(j.status)).slice(0, 50);
    const keep = jobSelect.value;
    jobSelect.replaceChildren(...(eligible.length ? eligible.map((j) => h('option', { value: j.id }, `${j.title} · ${j.status.replace(/_/g, ' ')}`)) : [h('option', { value: '' }, 'No finished or stalled jobs')]));
    if (eligible.some((j) => j.id === keep)) jobSelect.value = keep;
  };
  syncMode();
  const modal = openModal(h('div.modal.exec-modal.cloud-brain', { role: 'dialog', 'aria-labelledby': 'cloud-brain-title' },
    h('header', {}, h('small.empire-eyebrow', {}, 'Chief of staff · cloud mode'), close),
    h('div.exec-body', {},
      h('h2', { id: 'cloud-brain-title' }, 'Chief’s planning brain'),
      h('p.exec-note.exec-cloud-gap', { 'data-gap': 'chief_brain' }, cloudGapMessage('chief_brain')),
      statusBox, settingsForm, h('h3', {}, 'Ask for a plan'), planForm, jobBox, h('h3', {}, 'Recent requests'), requests)), { onClose: () => off() });
  const off = store.on('cloud', render);
  close.addEventListener('click', () => modal.close());
  render();
  close.focus();
}
