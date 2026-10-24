/**
 * FREE-01 client: the Settings "Linked accounts" panel and the hire dialog's engine choice.
 * The office host reports names and states only; no key, token or credential ever reaches this page.
 */
import { apiFetch } from '../endpoint';
import { h, toast } from './dom';
import { confirmDialog } from './prompt';
import {
  HOSTED_TERMS_CAVEAT, MODEL_CATALOGUE, MODEL_TAG_CAVEAT, engineKey, engineLabel,
  type CliAccount, type EngineOption, type EnginesState, type WorkerEngine,
} from '../../shared/engines';

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json as T;
}

export const enginesApi = {
  state: (refresh = false) => call<EnginesState>(`/api/engines${refresh ? '?refresh=1' : ''}`),
  setDefault: (engine: 'auto' | WorkerEngine) => call<EnginesState>('/api/engines/default', { engine }),
  pull: (model: string) => call<unknown>('/api/engines/ollama/pull', { model, confirm: true }),
  cancel: () => call<unknown>('/api/engines/ollama/cancel', {}),
};

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

function card(title: string, tone: 'ok' | 'warn' | 'unknown' | 'off', label: string, detail: string, ...extra: (Node | null)[]) {
  const el = h('article.status-card.engine-card', { 'data-tone': tone === 'ok' ? 'good' : tone === 'warn' ? 'warn' : tone === 'off' ? 'bad' : 'unknown' },
    h('span.empire-eyebrow', {}, title), h('strong', {}, h('span.status-dot', { 'aria-hidden': 'true' }), label), h('p', {}, detail), ...extra);
  return el;
}

function cliTone(a: CliAccount): 'ok' | 'warn' | 'unknown' | 'off' {
  if (!a.installed) return 'off';
  if (a.expired || a.loggedIn === false) return 'warn';
  if (a.loggedIn === null) return 'unknown';
  return a.expiringSoon ? 'warn' : 'ok';
}

/** Settings section: linked accounts, local models, keys (names only) and the default engine. */
export function linkedAccountsSection(opts: { onSignIn: () => void }) {
  const body = h('div.engine-grid', { 'aria-live': 'polite' });
  const status = h('p.setting-note', {}, 'Checking what is installed and signed in on the office host…');
  const refresh = h('button.btn', { type: 'button' }, 'Check again');
  let timer: number | undefined;
  let disposed = false;

  const paint = (s: EnginesState) => {
    status.textContent = `Checked ${new Date(s.checkedAt).toLocaleTimeString()} on the office host. Sign-in state comes only from each CLI's own status command.`;
    const signIn = h('button.btn.primary', { type: 'button', onclick: opts.onSignIn, disabled: !s.claude.installed }, 'Sign in to Claude…');
    const claude = card('Claude Code · premium', cliTone(s.claude), !s.claude.installed ? 'Not installed' : s.claude.loggedIn ? `Signed in${s.claude.plan ? ` · ${s.claude.plan}` : ''}` : s.claude.expired ? 'Sign-in expired' : s.claude.loggedIn === false ? 'Not signed in' : 'Unknown', s.claude.detail,
      h('p.setting-note', {}, 'The Empire never signs you in or sees your Claude credentials. “Sign in to Claude” opens a worker terminal with /login typed; you press Enter and finish inside Claude Code.'),
      h('p.setting-note', {}, 'Checked in this office’s repository: an API key or apiKeyHelper in its Claude settings means workers would bill the API, so “your Claude account” is not offered. Settings on other branches or in a worktree’s local file are not checked.'),
      h('div.sector-actions', {}, signIn));
    const codex = card('Codex CLI · optional', cliTone(s.codex), !s.codex.installed ? 'Not installed' : s.codex.loggedIn ? 'Signed in' : s.codex.loggedIn === false ? 'Not signed in' : 'Unknown', s.codex.detail);
    const qwen = card('Qwen Code · free', s.qwen.installed ? 'ok' : 'off', s.qwen.installed ? 'Installed' : 'Not installed', s.qwen.detail);

    const local = new Set(s.ollama.models.map((m) => m.name));
    const pull = s.ollama.pull;
    const pulling = pull && !pull.done;
    const progress = pull ? h('div.pull-progress', {},
      h('progress', { max: Math.max(pull.total, 1), value: pull.completed, 'aria-label': `Downloading ${pull.model}` }),
      h('span', {}, pull.done ? (pull.error ? `${pull.model}: ${pull.error}` : pull.cancelled ? `${pull.model}: cancelled` : `${pull.model}: downloaded`) : `${pull.model}: ${pull.status}${pull.total ? ` · ${gb(pull.completed)} of ${gb(pull.total)}` : ''}`),
      pulling ? h('button.btn', { type: 'button', onclick: () => enginesApi.cancel().then(() => load(), (e) => toast(e.message, 'warn')) }, 'Cancel download') : null) : null;
    const recs = h('ul.model-recs', {}, ...s.ram.models.map((m) => h('li', {},
      h('strong', {}, `${m.label} `, h('code', {}, m.tag)), h('span.role', {}, m.role),
      h('small', {}, `${m.sizeGb} GB download · ${m.licence} · ${m.note}`),
      local.has(m.tag) ? h('span.have', {}, 'Downloaded') : h('button.btn', {
        type: 'button', disabled: !s.ollama.running || !!pulling,
        onclick: () => confirmDialog(`Download ${m.tag}?`, `${m.label} · ${m.sizeGb} GB · licence ${m.licence}. Ollama downloads it to this computer now. ${MODEL_TAG_CAVEAT}`, `Download ${m.sizeGb} GB`,
          () => enginesApi.pull(m.tag).then(() => load(), (e) => toast(e.message, 'warn'))),
      }, `Download (${m.sizeGb} GB)…`))));
    const ollama = card('Ollama · local models', s.ollama.running ? 'ok' : 'off', s.ollama.running ? `Running${s.ollama.version ? ` · v${s.ollama.version}` : ''}` : 'Not running', s.ollama.detail,
      s.ollama.running ? null : h('p', {}, h('a', { href: s.ollama.installUrl, target: '_blank', rel: 'noopener' }, 'Install Ollama (ollama.com/download)'), ' — not bundled with the Empire.'),
      s.ollama.models.length ? h('p.setting-note', {}, `Downloaded: ${s.ollama.models.map((m) => m.name).join(', ')}`) : null,
      h('p.setting-note', {}, `This computer: ${s.ram.totalGb} GB memory. ${s.ram.note} Nothing downloads without your click. ${MODEL_TAG_CAVEAT}`),
      recs, progress);

    const keys = card('API keys · names only', s.keys.some((k) => k.present) ? 'ok' : 'unknown', `${s.keys.filter((k) => k.present).length} of ${s.keys.length} present`, 'Keys stay on the office host. The desktop app seals them in this computer’s credential store (menu → Provider keys…); a server reads them from its environment.',
      h('ul.key-names', {}, ...s.keys.map((k) => h('li', { 'data-present': String(k.present) }, h('code', {}, k.name), k.present ? ' · present' : ' · not set'))));

    const hosted = h('details.hosted-free', {},
      h('summary', {}, h('strong', {}, 'Free hosted models (opt-in)'), ' — your own key; read the data-use terms first'),
      h('p.setting-note', {}, HOSTED_TERMS_CAVEAT),
      ...s.hosted.map((p) => h('div.hosted-terms', {},
        h('strong', {}, p.name), h('p', {}, p.terms), h('p.setting-note', {}, 'Terms: ', h('a', { href: p.termsUrl, target: '_blank', rel: 'noopener' }, p.termsUrl), ` · saved as `, h('code', {}, p.key), ` · ${s.keys.find((k) => k.name === p.key)?.present ? 'present' : 'not set'}`))),
      h('p.setting-note', {}, 'To save one after reading its terms: in the desktop app use the menu → Provider keys… (it asks you to confirm the terms again); on a server set the variable named above. Hosted calls are labelled “free tier (rate-limited)” and cost US$0.'));

    const select = h('select', { 'aria-label': 'Default engine for new hires' }) as HTMLSelectElement;
    select.append(h('option', { value: 'auto' }, 'Automatic: premium when healthy, otherwise free'));
    for (const o of s.options) select.append(h('option', { value: engineKey(o.engine), disabled: !o.usable }, `${o.label}${o.usable ? '' : ' — not ready'}`));
    select.value = s.defaultEngine === 'auto' ? 'auto' : engineKey(s.defaultEngine);
    select.addEventListener('change', () => {
      const chosen = select.value === 'auto' ? 'auto' : s.options.find((o) => engineKey(o.engine) === select.value)?.engine;
      if (chosen) enginesApi.setDefault(chosen).then(paint, (e) => toast(e.message, 'warn'));
    });
    const def = h('div.engine-default', {}, h('label', {}, 'Default engine for new hires'), select,
      h('p.setting-note', {}, s.recommended ? `New hires get: ${engineLabel(s.recommended)}. You can change it in each hire.` : s.help.join(' ')));

    body.replaceChildren(def, claude, qwen, ollama, codex, keys, hosted);
    clearTimeout(timer);
    if (pulling && !disposed) timer = window.setTimeout(() => load(), 1000);
  };
  const load = (force = false) => enginesApi.state(force).then((s) => { if (!disposed) paint(s); }, (e) => { status.textContent = `Linked accounts unavailable: ${e.message}`; });
  refresh.addEventListener('click', () => void load(true));
  void load();
  const el = h('section.linked-accounts', { 'aria-labelledby': 'linked-accounts-title' },
    h('label', { id: 'linked-accounts-title', style: 'margin-top:18px' }, 'Linked accounts & worker engines'), status, body, h('div.sector-actions', {}, refresh));
  return { el, dispose() { disposed = true; clearTimeout(timer); } };
}

/** The hire dialog's engine choice: premium preferred when healthy; free offered with its label; help when none. */
export function engineChoice() {
  let options: EngineOption[] = [];
  let chosen: WorkerEngine | null = null;
  const select = h('select', { id: 'engine-choice', 'aria-label': 'Worker engine' }) as HTMLSelectElement;
  const note = h('p.setting-note.engine-note', {}, 'Checking which engines are ready…');
  const el = h('div.engine-choice', {}, h('label', { for: 'engine-choice' }, '🧠 Engine'), select, note);
  select.disabled = true;
  const describe = () => {
    const o = options.find((x) => engineKey(x.engine) === select.value);
    chosen = o?.usable ? o.engine : null;
    note.textContent = o ? `${o.premium ? 'Premium' : 'Free'} · ${o.reason}` : '';
  };
  enginesApi.state().then((s) => {
    options = s.options;
    select.replaceChildren(...options.map((o) => h('option', { value: engineKey(o.engine), disabled: !o.usable }, `${o.label}${o.premium ? '' : ' · free'}${o.usable ? '' : ' — not ready'}`)));
    select.disabled = false;
    if (s.recommended) { select.value = engineKey(s.recommended); describe(); }
    else { chosen = null; note.textContent = s.help.join(' '); }
  }, () => {
    // An older host without engines: the hire uses the host's default (Claude Code), as before.
    el.hidden = true;
  });
  select.addEventListener('change', describe);
  return {
    element: el,
    /** undefined = let the host decide (older host); null = nothing usable was chosen. */
    value: (): WorkerEngine | null | undefined => (el.hidden ? undefined : chosen),
  };
}
