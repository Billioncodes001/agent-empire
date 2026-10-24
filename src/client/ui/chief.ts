/**
 * FREE-02 client: the Settings "Chief's planning brain" section, and the plan/review blocks the inbox shows.
 * The host reports names and states only; keys never reach this page.
 */
import { apiFetch } from '../endpoint';
import { store } from '../state';
import { h, toast } from './dom';
import { PHASE_LABEL } from '../../shared/org';
import {
  MAX_CHIEF_CAP_USD, PLAN_NOTE, REVIEW_NOTE, ROLE_LABEL,
  type BrainMode, type ChiefPlan, type ChiefReview, type ChiefSettings, type ChiefState,
} from '../../shared/chief';
import type { EnginesState } from '../../shared/engines';

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json as T;
}

export const chiefApi = {
  state: () => call<ChiefState>('/api/chief'),
  settings: (s: Partial<ChiefSettings> & { premiumPrice?: [number, number] | null }) => call<ChiefState>('/api/chief/settings', s),
};

const MODE_TEXT: Record<BrainMode, { title: string; note: string }> = {
  off: { title: 'Off · rule-based', note: 'The chief stays rule-based: no model is called. Plans come from your brief as written.' },
  free: { title: 'Free · local model', note: 'A model on this computer through Ollama. US$0. Calls wait their turn at your computer’s speed.' },
  premium: { title: 'Premium · your API key', note: 'Your Anthropic or OpenAI API key, billed to you by the provider. Capped per day from the price you enter. Never city credits.' },
};

/** Settings section: off / free local / premium, the daily cap, and what the brain is doing now. */
export function chiefBrainSection() {
  const status = h('p.setting-note.chief-status', { 'aria-live': 'polite' }, 'Checking the chief’s planning brain…');
  const form = h('form.chief-brain', { 'aria-labelledby': 'chief-brain-title' }) as HTMLFormElement;
  let disposed = false;
  let models: string[] = [];

  const paint = (s: ChiefState) => {
    const set = s.settings;
    const radios = (['off', 'free', 'premium'] as BrainMode[]).map((mode) => h('label.chief-mode', { 'data-mode': mode },
      h('input', { type: 'radio', name: 'chief-mode', value: mode, checked: set.mode === mode }),
      h('span', {}, h('strong', {}, MODE_TEXT[mode].title), h('small', {}, MODE_TEXT[mode].note))));
    const freeModel = models.length
      ? h('select', { name: 'freeModel', 'aria-label': 'Local model for the chief' }, ...[...new Set([set.freeModel, ...models])].map((m) => h('option', { value: m, selected: m === set.freeModel }, `${m}${models.includes(m) ? '' : ' (not downloaded)'}`)))
      : h('input', { name: 'freeModel', value: set.freeModel, 'aria-label': 'Local model tag for the chief', autocomplete: 'off' });
    const provider = h('select', { name: 'premiumProvider', 'aria-label': 'Premium provider' },
      h('option', { value: 'anthropic', selected: set.premiumProvider === 'anthropic' }, 'Anthropic API (ANTHROPIC_API_KEY)'),
      h('option', { value: 'openai', selected: set.premiumProvider === 'openai' }, 'OpenAI API (OPENAI_API_KEY)'));
    const num = (name: string, value: number | undefined, label: string, step = '0.01') => h('label.chief-num', {}, label, h('input', { name, type: 'number', inputmode: 'decimal', min: '0', step, value: value === undefined ? '' : String(value) }));
    const brain = s.brain;
    status.textContent = `${brain.label}.${brain.reason ? ` ${brain.reason}` : ''} ${s.budget.note}${s.pendingCalls ? ` · ${s.pendingCalls} model call${s.pendingCalls === 1 ? '' : 's'} waiting.` : ''}`;
    status.dataset.ready = String(brain.ready);
    form.replaceChildren(
      h('fieldset.chief-modes', {}, h('legend', {}, 'Brain'), ...radios),
      h('div.chief-fields', { 'data-for': 'free' }, h('label', {}, 'Local model', freeModel),
        h('p.setting-note', {}, models.length ? 'Models downloaded in Ollama on this computer.' : 'Download a model under Linked accounts first; nothing downloads from here.')),
      h('div.chief-fields', { 'data-for': 'premium' },
        h('label', {}, 'Provider', provider),
        h('label', {}, 'Model id', h('input', { name: 'premiumModel', value: set.premiumModel, placeholder: 'the model id from your provider', autocomplete: 'off' })),
        h('div.chief-row', {}, num('priceIn', set.premiumPrice?.[0], 'Input US$ per 1M tokens'), num('priceOut', set.premiumPrice?.[1], 'Output US$ per 1M tokens')),
        num('dailyCapUsd', set.dailyCapUsd, `Daily cap (US$, at most ${MAX_CHIEF_CAP_USD})`),
        h('p.setting-note', {}, `Today: ${s.budget.kind === 'premium' ? `estimated $${s.budget.spentUsd.toFixed(2)} of $${s.budget.capUsd.toFixed(2)}` : 'no premium spend'}. Enter your provider’s current price so the cap can be enforced before each call; the Empire ships no price list. Your Claude subscription is not used for the chief in this version.`)),
      h('p.setting-note', {}, 'Whatever the brain writes is a proposal: plans wait for your approval with an estimate, reviews never accept work, and unblock ideas arrive in your inbox.'),
      h('div.sector-actions', {}, h('button.btn.primary', { type: 'submit' }, 'Save brain settings')),
    );
    form.dataset.mode = set.mode;
  };
  form.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.name === 'chief-mode') form.dataset.mode = t.value;
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const mode = String(f.get('chief-mode') ?? 'off') as BrainMode;
    const body: Record<string, unknown> = { mode, freeModel: String(f.get('freeModel') ?? '').trim() || undefined };
    if (mode === 'premium' || f.get('premiumModel')) {
      body.premiumProvider = f.get('premiumProvider');
      body.premiumModel = String(f.get('premiumModel') ?? '');
      const pin = String(f.get('priceIn') ?? ''), pout = String(f.get('priceOut') ?? '');
      if (pin && pout) body.premiumPrice = [Number(pin), Number(pout)];
      const cap = String(f.get('dailyCapUsd') ?? '');
      if (cap) body.dailyCapUsd = Number(cap);
    }
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    chiefApi.settings(body).then((s) => { paint(s); toast(`Chief’s brain: ${s.brain.label}`, 'info'); }, (err) => toast(err.message, 'warn'));
  });
  const load = () => chiefApi.state().then((s) => { if (!disposed) paint(s); }, (e) => { status.textContent = `The chief’s brain is not available on this host: ${e.message}`; });
  // Installed local models, when the host reports them (names only).
  apiFetch('/api/engines', { cache: 'no-store', credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((e: EnginesState | null) => { models = e?.ollama.models.map((m) => m.name) ?? []; }).catch(() => {}).finally(() => void load());
  const el = h('section.chief-brain-section', { 'aria-labelledby': 'chief-brain-title' },
    h('label', { id: 'chief-brain-title', style: 'margin-top:18px' }, 'Chief of staff · planning brain'), status, form);
  return { el, dispose() { disposed = true; } };
}

/** The chief's proposed plan: roles, order, parallel, and every item's full prompt as text (review fix 2). */
export function chiefPlanBlock(plan: ChiefPlan): HTMLElement {
  return h('section.chief-plan', { 'aria-label': 'Proposed by the chief' },
    h('p.chief-plan-head', {}, h('span.empire-tag', {}, `Model-backed · ${plan.model ?? 'model'} · proposals only`), plan.costLabel ? h('small', {}, ` ${plan.costLabel}`) : null),
    plan.summary ? h('p.chief-summary', {}, plan.summary) : null,
    h('ol.chief-items', {}, ...(plan.items ?? []).map((it) => h('li', {},
      h('strong', {}, it.title),
      h('span.chief-meta', {}, `${ROLE_LABEL[it.role]} · ${PHASE_LABEL[it.phase]}${it.parallel ? ' · parallel with the item before' : ''}${it.dependsOn.length ? ` · after item ${it.dependsOn.join(' & ')}` : ' · starts first'}`),
      it.prompt ? h('pre.chief-prompt', { tabindex: 0, 'aria-label': `Full prompt for ${it.title}` }, it.prompt) : null))),
    h('p.setting-note', {}, PLAN_NOTE));
}

/** The chief's reviews of a job's finished items: recommendation, summary, concerns, evidence. Never an acceptance. */
export function chiefReviewsBlock(reviews: ChiefReview[]): HTMLElement | null {
  if (!reviews.length) return null;
  return h('section.chief-reviews', { 'aria-label': 'Chief reviews' },
    h('h4', {}, 'Chief reviews'),
    ...reviews.map((r) => h('article.chief-review', { 'data-status': r.status, 'data-recommendation': r.recommendation ?? '' },
      h('p', {}, h('strong', {}, r.itemTitle), ' · ',
        r.status === 'reviewed' ? h('span.chief-verdict', {}, r.recommendation === 'accept' ? 'Recommends accept' : 'Recommends changes')
          : h('span.chief-verdict', {}, r.status === 'needs_attention' ? 'Needs attention' : 'Reviewing…')),
      r.summary ? h('p', {}, r.summary) : null,
      r.concerns?.length ? h('ul', {}, ...r.concerns.map((c) => h('li', {}, c))) : null,
      r.reason ? h('p.inbox-error', {}, r.reason) : null,
      r.evidence ? h('small', {}, `Based on: ${r.evidence}`) : null)),
    h('p.setting-note', {}, REVIEW_NOTE));
}

/** Review fix 2: a model-proposed plan may be approved here only when every item's full prompt is on screen. */
export const promptsShown = (plan: ChiefPlan | undefined) => !!plan?.items?.length && plan.items.every((i) => typeof i.prompt === 'string' && i.prompt.length > 0);

export const chiefPlanFor = (jobId: string) => store.chief?.plans.find((p) => p.jobId === jobId && p.status === 'proposed');
export const chiefReviewsFor = (jobId: string) => store.chief?.reviews.filter((r) => r.jobId === jobId) ?? [];
