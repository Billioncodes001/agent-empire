/**
 * CITY-10 client: Settings → "Let the city grow while you're away" (the city architect), and the change list the inbox
 * shows for a daily summary. The host does the work; this page only asks it. Keys never reach this page.
 */
import { apiFetch } from '../endpoint';
import { store } from '../state';
import { h, toast } from './dom';
import { ARCHITECT_LIMITS, ARCHITECT_TITLE, CLOUD_ARCHITECT_NOTE, ENGINE_TEXT, type ArchitectState, type RunRecord } from '../../shared/architect';
import { CATALOG, LOTS, changeLabel, type ArchitectEngine } from '../../shared/world';
import type { Approval } from '../../shared/approvals';

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json as T;
}

export const architectApi = {
  state: () => call<ArchitectState>('/api/architect'),
  settings: (s: Record<string, unknown>) => call<ArchitectState>('/api/architect/settings', s),
  run: () => call<RunRecord>('/api/architect/run', {}),
  undo: (changeId: string) => call<ArchitectState>('/api/architect/undo', { changeId }),
  revert: (runId: string) => call<{ note: string; state: ArchitectState }>('/api/architect/revert', { runId }),
  avoid: (model: string, lot?: string) => call<ArchitectState>('/api/architect/avoid', { model, ...(lot ? { lot } : {}) }),
  removeAvoid: (id: string) => call<ArchitectState>('/api/architect/avoid/remove', { id }),
};

const when = (at: number) => new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** One run: its changes with Undo, and Revert this day. */
function runBlock(run: RunRecord, onState: (s: ArchitectState) => void): HTMLElement {
  const live = !run.reverted;
  const status = run.reverted ? 'reverted' : run.status.replace('_', ' ');
  return h('article.architect-run', { 'data-status': run.reverted ? 'reverted' : run.status, 'data-run': run.id },
    h('header', {}, h('strong', {}, `${run.day} · ${run.id}`), h('span.architect-run-status', {}, status)),
    h('p.setting-note', {}, `${run.engineLabel} · ${run.costLabel}${run.note ? ` · ${run.note}` : ''}${run.reason ? ` · ${run.reason}` : ''}`),
    run.changes.length ? h('ul.architect-changes', {}, ...run.changes.map((c) => h('li', { 'data-undone': String(!!c.undone) },
      h('span', {}, h('strong', {}, changeLabel(c)), h('small', {}, c.reason)),
      c.undone || !live ? h('span.architect-undone', {}, 'undone') : h('button.btn', { type: 'button', 'aria-label': `Undo ${changeLabel(c)}`, onclick: () => architectApi.undo(c.id).then((s) => { onState(s); toast(`Undid ${c.id}`, 'info'); }, (e) => toast(e.message, 'warn')) }, 'Undo')))) : null,
    live && run.changes.some((c) => !c.undone) ? h('div.sector-actions', {}, h('button.btn.danger', { type: 'button', onclick: () => architectApi.revert(run.id).then((r) => { onState(r.state); toast(r.note, 'info'); }, (e) => toast(e.message, 'warn')) }, `Revert ${run.day}`)) : null,
  );
}

/** Settings section. */
export function architectSection() {
  const status = h('p.setting-note.architect-status', { 'aria-live': 'polite' }, 'Checking the city architect…');
  const body = h('div.architect-body');
  let disposed = false;

  const paint = (s: ArchitectState) => {
    if (disposed) return;
    if (!s.available) { status.textContent = s.unavailableReason ?? CLOUD_ARCHITECT_NOTE; body.replaceChildren(); return; }
    const set = s.settings;
    const st = s.engine;
    status.dataset.ready = String(st.ready);
    status.textContent = s.storageError ? s.storageError
      : !set.enabled ? 'Off. When on, this server adds a few small, reversible things to the city each day: trees, lamps, café parasols, signs and small buildings. Data only; nothing runs as code.'
        : set.paused ? 'Paused. Nothing is built until you resume.'
          : `${st.label}.${st.reason ? ` ${st.reason}` : ''}${s.nextRunAt ? ` Next run ${when(s.nextRunAt)}.` : ''}${s.running ? ' Running now…' : ''}`;
    const form = h('form.architect-form') as HTMLFormElement;
    const engines = (['rules', 'free', 'premium'] as ArchitectEngine[]).map((e) => h('label.chief-mode', { 'data-mode': e },
      h('input', { type: 'radio', name: 'architect-engine', value: e, checked: set.engine === e }),
      h('span', {}, h('strong', {}, ENGINE_TEXT[e].title), h('small', {}, ENGINE_TEXT[e].note))));
    const hour = h('select', { name: 'runHour', 'aria-label': 'Daily run hour' }, ...Array.from({ length: 24 }, (_, i) => h('option', { value: String(i), selected: i === set.runHour }, `${String(i).padStart(2, '0')}:00`)));
    const changes = h('select', { name: 'maxChangesPerRun', 'aria-label': 'Changes per run' }, ...Array.from({ length: ARCHITECT_LIMITS.maxChangesPerRun }, (_, i) => h('option', { value: String(i + 1), selected: i + 1 === set.maxChangesPerRun }, String(i + 1))));
    const num = (name: string, value: number, label: string, max: number) => h('label.chief-num', {}, label, h('input', { name, type: 'number', inputmode: 'decimal', min: String(ARCHITECT_LIMITS.minCapUsd), max: String(max), step: '0.01', value: String(value) }));
    form.append(
      h('label.architect-toggle', {}, h('input', { type: 'checkbox', name: 'enabled', checked: set.enabled }), h('span', {}, ARCHITECT_TITLE)),
      h('fieldset.chief-modes', {}, h('legend', {}, 'Engine'), ...engines),
      h('div.chief-row', {}, h('label', {}, 'Daily run at (this server’s time)', hour), h('label', {}, 'Changes per run', changes)),
      h('div.chief-row', {}, num('dailyCapUsd', set.dailyCapUsd, `Premium daily cap (US$, at most ${ARCHITECT_LIMITS.maxDailyCapUsd})`, ARCHITECT_LIMITS.maxDailyCapUsd), num('monthlyCapUsd', set.monthlyCapUsd, `Premium monthly cap (US$, at most ${ARCHITECT_LIMITS.maxMonthlyCapUsd})`, ARCHITECT_LIMITS.maxMonthlyCapUsd)),
      h('p.setting-note.architect-budget', {}, s.budget.note),
      h('div.sector-actions', {},
        h('button.btn.primary', { type: 'submit' }, 'Save'),
        set.enabled ? h('button.btn', { type: 'button', 'data-action': 'pause', onclick: () => architectApi.settings({ paused: !set.paused }).then(apply, (e) => toast(e.message, 'warn')) }, set.paused ? 'Resume' : 'Pause') : null,
        set.enabled && !set.paused ? h('button.btn', { type: 'button', 'data-action': 'run', disabled: s.running, onclick: () => architectApi.run().then((r) => { toast(r.status === 'applied' ? `City architect: ${r.changes.length} change${r.changes.length === 1 ? '' : 's'} built` : `City architect: ${r.reason ?? r.status.replace('_', ' ')}`, r.status === 'rejected' ? 'warn' : 'info'); return architectApi.state(); }).then(apply, (e) => toast(e.message, 'warn')) }, 'Run now') : null),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(form);
      architectApi.settings({ enabled: f.get('enabled') === 'on', engine: f.get('architect-engine') ?? set.engine, runHour: Number(f.get('runHour')), maxChangesPerRun: Number(f.get('maxChangesPerRun')), dailyCapUsd: Number(f.get('dailyCapUsd')), monthlyCapUsd: Number(f.get('monthlyCapUsd')) })
        .then((n) => { apply(n); toast(n.settings.enabled ? 'The city will grow while you’re away' : 'City architect off', 'info'); }, (err) => toast(err.message, 'warn'));
    });
    const model = h('select', { 'aria-label': 'What not to build' }, ...CATALOG.map((c) => h('option', { value: c.id }, c.label))) as HTMLSelectElement;
    const lot = h('select', { 'aria-label': 'Where' }, h('option', { value: '' }, 'anywhere'), ...LOTS.map((l) => h('option', { value: l.id }, l.name))) as HTMLSelectElement;
    body.replaceChildren(
      form,
      h('h4.architect-sub', {}, 'Recent runs (undo for 30 days)'),
      ...(s.runs.length ? s.runs.slice(0, 7).map((r) => runBlock(r, apply)) : [h('p.setting-note', {}, 'No runs yet.')]),
      h('h4.architect-sub', {}, 'Don’t build'),
      h('div.chief-row', {}, model, lot, h('button.btn', { type: 'button', onclick: () => architectApi.avoid(model.value, lot.value || undefined).then(apply, (e) => toast(e.message, 'warn')) }, 'Add rule')),
      s.journal.avoid.length ? h('ul.architect-avoid', {}, ...s.journal.avoid.map((r) => h('li', {}, h('span', {}, `${r.text}${r.source === 'undo' ? ' (from an undo)' : ''}`), h('button.btn', { type: 'button', 'aria-label': `Remove rule ${r.text}`, onclick: () => architectApi.removeAvoid(r.id).then(apply, (e) => toast(e.message, 'warn')) }, 'Remove')))) : h('p.setting-note', {}, 'No rules. Undoing something the architect built adds one automatically.'),
      h('p.setting-note', {}, `The world holds ${s.world.additions.length} of at most 48 additions. In the city they say “Built by the city architect”; they are never agent work. `, h('a', { href: '/api/architect/journal.md', download: 'city-architect-journal.md' }, 'Download the journal')),
    );
  };
  const apply = (s: ArchitectState) => { store.architect = s; store.emit('architect'); };
  const load = () => {
    if (store.cloud) { status.textContent = CLOUD_ARCHITECT_NOTE; return; }
    architectApi.state().then(paint, (e) => { if (!disposed) status.textContent = `The city architect is not available on this host: ${e.message}`; });
  };
  const off = store.on('architect', () => { if (store.architect) paint(store.architect); });
  load();
  const el = h('section.architect-section', { 'aria-labelledby': 'architect-title' },
    h('label', { id: 'architect-title', style: 'margin-top:18px' }, `City architect · ${ARCHITECT_TITLE}`), status, body);
  return { el, dispose() { disposed = true; if (typeof off === 'function') off(); } };
}

/** Inbox: the day's changes, each with Undo. */
export function architectFacts(item: Approval): HTMLElement {
  const a = item.architect;
  if (!a) return h('p.setting-note', {}, 'This summary has nothing to show.');
  const run = store.architect?.runs.find((r) => r.id === a.runId);
  const changes = run?.changes ?? [];
  return h('dl.inbox-facts.architect-facts', {},
    h('div', {}, h('dt', {}, 'Engine'), h('dd', {}, a.engineLabel)),
    h('div', {}, h('dt', {}, 'Cost'), h('dd', {}, a.costLabel)),
    a.note ? h('div', {}, h('dt', {}, 'Note'), h('dd', {}, a.note)) : null,
    a.reason ? h('div', {}, h('dt', {}, 'Why nothing changed'), h('dd', {}, a.reason)) : null,
    h('div', {}, h('dt', {}, 'Changes'), h('dd', {}, a.changes.length ? h('ul.architect-changes', {}, ...a.changes.map((c) => {
      const live = changes.find((x) => x.id === c.id);
      const undone = !!live?.undone || !!run?.reverted;
      return h('li', { 'data-undone': String(undone) }, h('span', {}, h('strong', {}, c.label), h('small', {}, c.reason)),
        undone ? h('span.architect-undone', {}, 'undone') : live ? h('button.btn', { type: 'button', 'aria-label': `Undo ${c.label}`, onclick: () => architectApi.undo(c.id).then((s) => { store.architect = s; store.emit('architect'); toast(`Undid ${c.id}`, 'info'); }, (e) => toast(e.message, 'warn')) }, 'Undo') : h('span.architect-undone', {}, 'past the 30-day undo window'));
    })) : 'None')),
    h('div', {}, h('dt', {}, 'Keep changes'), h('dd', {}, 'records that you saw them; they are already in the city')),
    h('div', {}, h('dt', {}, 'Revert this day'), h('dd', {}, 'undoes every change above that is not undone yet')));
}
