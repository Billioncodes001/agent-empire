import type { ExecutionConfig, ExecutionMode, ExecutionSetup, ExecutionSubmit, ExecutionTask, ExecutionTaskList, ExecutionTaskStatus } from '../../shared/execution';
import { store } from '../state';
import { apiFetch } from '../endpoint';
import { h, openModal, timeAgo, toast, type Modal } from './dom';
import type { StatusView } from './status';

/** The host's stable ID, but only from a report received on the current connection. */
export const currentHostId = () =>
  store.connected && store.continuity && store.continuityReceivedAt >= store.connectedAt ? store.continuity.serverId : undefined;

/** App-owned confirmation works consistently in desktop and embedded browsers. */
function confirmAction(title: string, message: string, label: string): Promise<boolean> {
  return new Promise(resolve => {
    let approved = false;
    const dialog = openModal(h('div.modal.exec-modal', {role:'dialog','aria-label':title},
      h('header', {}, h('h2', {}, title)), h('div.body', {}, h('p', {}, message)),
      h('footer', {}, button('Cancel', () => dialog.close()), button(label, () => {approved = true; dialog.close();}, {class:'primary'}))),
      {onClose:() => resolve(approved)});
  });
}

// ---- Pure presentation and validation ---------------------------------------------------------------

export const MODE_COPY: Record<ExecutionMode, { title: string; summary: string; detail: string }> = {
  local: {
    title: 'This host',
    summary: 'Agents run on the office host this page is connected to.',
    detail: 'Work continues only while that host stays on, awake and running the office server; quitting the packaged desktop app stops its local server and workers. Saving this choice starts nothing: queued jobs, including founding manager briefs, run only when you raise the task queue’s concurrency (the desktop app starts it paused at 0).',
  },
  vps: {
    title: 'Your own VPS',
    summary: 'Use when the office host you are connected to is a server you run.',
    detail: 'Selecting this does not provision, buy or connect another machine. To use a different host, connect to it with the desktop launcher’s remote host option.',
  },
  anthropic_cloud: {
    title: 'Provider cloud',
    summary: 'Tasks run in Anthropic-managed sandboxes billed to your Anthropic account.',
    detail: 'The office host submits and tracks each task; provider sessions keep running independently of this page and the desktop app, subject to provider limits, approvals and failures. The legacy local task queue (including civic manager jobs) is held in this mode. Cloud tasks are submitted only from the Cloud tasks panel; civic reports and cloud tasks are not synchronized yet.',
  },
};

export const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic Managed Agents', available: true, note: 'Uses an agent and environment you created in the Claude Console.' },
  { id: 'openai', name: 'OpenAI Agents API', available: false, note: 'Not connected yet.' },
  { id: 'github', name: 'GitHub Copilot / agentic workflows', available: false, note: 'Not connected yet.' },
] as const;

const TASK: Record<ExecutionTaskStatus, StatusView> = {
  dispatch_uncertain: { tone: 'attention', label: 'Submission uncertain', detail: 'The provider may or may not have started a session. Refresh to reconcile before doing anything else.' },
  running: { tone: 'active', label: 'Running', detail: 'The provider reports an active session.' },
  waiting_for_approval: { tone: 'attention', label: 'Waiting for your approval', detail: 'The session is paused on a required action.' },
  budget_paused: { tone: 'attention', label: 'Paused at budget', detail: 'The task reached its budget limit.' },
  idle: { tone: 'idle', label: 'Idle · turn ended', detail: 'The session stopped taking turns. This is not verified success; review the branch before merging.' },
  unknown: { tone: 'unknown', label: 'Status unknown', detail: 'The host could not confirm the provider session state.' },
  completed: { tone: 'idle', label: 'Ended', detail: 'The provider session ended. Outputs are unverified until you review the branch or pull request.' },
  failed: { tone: 'attention', label: 'Failed', detail: 'The task did not finish.' },
  cancelled: { tone: 'idle', label: 'Stopped', detail: 'The session was terminated.' },
};
const FINAL: ExecutionTaskStatus[] = ['completed', 'failed', 'cancelled'];

export function taskView(task: ExecutionTask): StatusView {
  const base = TASK[task.status] ?? TASK.unknown;
  return task.message ? { ...base, detail: `${task.message} ${task.status === 'idle' || task.status === 'completed' ? 'Outputs unverified.' : ''}`.trim() } : base;
}

/** A stop needs a provider session; a mid-turn session may need a second stop once it is idle. */
export const canStop = (task: ExecutionTask) => !FINAL.includes(task.status) && !!task.sessionId;

export const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Parses a dollar amount typed by the user into whole cents; null when it is not a plain non-negative number. */
export function parseCents(text: string): number | null {
  const t = text.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

export const LIMITS = { maxConcurrent: 10, perTaskCents: 100_000, dailyCents: 10_000_000 };
const ID = { agentId: /^agent_[A-Za-z0-9]{8,100}$/, environmentId: /^env_[A-Za-z0-9]{8,100}$/, vaultId: /^vlt_[A-Za-z0-9]{8,100}$/ };
const REF = /^[A-Za-z0-9._\-/]{1,200}$/;
const GH = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/** Mirrors the host's validation so mistakes show before saving; the host remains the authority. */
export function validateConfig(c: ExecutionConfig): string[] {
  const errors: string[] = [];
  const l = c.limits;
  if (!Number.isSafeInteger(l.maxConcurrent) || l.maxConcurrent < 1 || l.maxConcurrent > LIMITS.maxConcurrent)
    errors.push(`Maximum concurrent tasks must be a whole number from 1 to ${LIMITS.maxConcurrent}.`);
  if (!Number.isSafeInteger(l.perTaskBudgetCents) || l.perTaskBudgetCents < 1 || l.perTaskBudgetCents > LIMITS.perTaskCents)
    errors.push(`Per-task budget must be from $0.01 to ${dollars(LIMITS.perTaskCents)}.`);
  if (!Number.isSafeInteger(l.dailyBudgetCents) || l.dailyBudgetCents > LIMITS.dailyCents) errors.push(`Daily budget must be at most ${dollars(LIMITS.dailyCents)}.`);
  else if (l.dailyBudgetCents < l.perTaskBudgetCents) errors.push('Daily budget must be at least the per-task budget.');
  if (c.mode !== 'anthropic_cloud') return errors;
  if (!GH.test(c.repository.owner)) errors.push('Enter the GitHub repository owner.');
  if (!GH.test(c.repository.name)) errors.push('Enter the GitHub repository name.');
  if (!REF.test(c.repository.baseBranch)) errors.push('Enter the base branch.');
  if (!ID.agentId.test(c.anthropic.agentId)) errors.push('Enter the managed agent ID from the Claude Console (starts with agent_).');
  if (!ID.environmentId.test(c.anthropic.environmentId)) errors.push('Enter the environment ID from the Claude Console (starts with env_).');
  if (c.anthropic.vaultId && !ID.vaultId.test(c.anthropic.vaultId)) errors.push('A vault ID starts with vlt_ followed by letters and numbers.');
  return errors;
}

export function setupView(s: ExecutionSetup): StatusView {
  if (s.storageError) return { tone: 'attention', label: 'Setup could not be saved', detail: s.storageError };
  if (!s.config.completed) return { tone: 'unknown', label: 'Not set up', detail: 'No execution choice has been saved yet. Cloud tasks require setup and explicit submission.' };
  const mode = MODE_COPY[s.config.mode].title;
  if (s.config.mode !== 'anthropic_cloud') return { tone: 'idle', label: mode, detail: MODE_COPY[s.config.mode].summary };
  if (s.check.status === 'blocked') return { tone: 'attention', label: `${mode} · check failed`, detail: s.check.message ?? 'The read-only check found a problem.' };
  if (s.check.status === 'unchecked') return { tone: 'unknown', label: `${mode} · not checked`, detail: 'Run the read-only check before submitting paid tasks.' };
  if (s.check.status === 'ready' && !s.ready)
    return { tone: 'unknown', label: `${mode} · check expired`, detail: 'A passed check is valid for 5 minutes. Run the read-only check again before submitting.' };
  return s.ready
    ? { tone: 'idle', label: `${mode} · ready`, detail: 'Read-only check passed (valid for 5 minutes). Tasks still need explicit paid confirmation.' }
    : { tone: 'attention', label: `${mode} · not ready`, detail: s.check.message ?? 'The host reports the setup is not ready.' };
}

/** The offer appears once per browser, and only while no execution choice has been saved. */
export const shouldOffer = (setup: ExecutionSetup | null, seen: boolean) => !!setup && !setup.config.completed && !seen;

/** Form and saved configs compare equal when they describe the same choice. */
export const comparable = (c: ExecutionConfig) =>
  JSON.stringify([c.mode, c.repository.owner, c.repository.name, c.repository.baseBranch, c.anthropic.agentId, c.anthropic.environmentId, c.anthropic.vaultId || '', c.limits.maxConcurrent, c.limits.perTaskBudgetCents, c.limits.dailyBudgetCents]);

// ---- HTTP -------------------------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** Codes the host raises before it records or dispatches a submission (see the host's admission checks). */
export const PRE_DISPATCH_CODES = new Set([
  'invalid_input', 'paid_confirmation_required', 'setup_changed', 'cloud_not_ready', 'ledger_capacity',
  'concurrency_limit', 'daily_allowance', 'credentials_missing', 'credentials_changed',
]);

/** Only a proven pre-dispatch rejection may release a submission ID; everything else stays unresolved. */
export function provenPreDispatch(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 && !!err.code && PRE_DISPATCH_CODES.has(err.code);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: init.body ? { 'content-type': 'application/json' } : undefined,
    });
  } catch {
    throw new ApiError('Could not reach the office host.', 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status, body?.code);
  return body as T;
}

export const executionApi = {
  setup: () => api<ExecutionSetup>('/api/execution/setup'),
  save: (config: ExecutionConfig) => api<ExecutionSetup>('/api/execution/setup', { method: 'PUT', body: JSON.stringify(config) }),
  check: () => api<ExecutionSetup>('/api/execution/check', { method: 'POST' }),
  tasks: () => api<ExecutionTaskList>('/api/execution/tasks'),
  submit: (body: ExecutionSubmit) => api<ExecutionTask>('/api/execution/tasks', { method: 'POST', body: JSON.stringify(body) }),
  refresh: (id: string) => api<ExecutionTask>(`/api/execution/tasks/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
  stop: (id: string) => api<ExecutionTask>(`/api/execution/tasks/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
};

// ---- Pending paid submission (survives reloads so a retry reuses its ID) ---------------------------------

const PENDING_PREFIX = 'agent-empire.execution.pending:';
const OFFER_KEY = 'agent-empire.execution.offered';
export interface Pending extends Pick<ExecutionSubmit, 'id' | 'prompt' | 'configRevision'> {
  scope: string;
}

/** A retry must reach the same host and the same repository/agent setup; null when the host identity is unknown. */
export function pendingScope(hostId: string | undefined, c: ExecutionConfig): string | null {
  if (!hostId) return null;
  const r = c.repository, a = c.anthropic;
  return JSON.stringify([hostId, r.owner.toLowerCase(), r.name.toLowerCase(), r.baseBranch, a.agentId, a.environmentId, a.vaultId || '']);
}

export function loadPending(scope: string, storage: Pick<Storage, 'getItem'> = localStorage): Pending | null {
  try {
    const p = JSON.parse(storage.getItem(PENDING_PREFIX + scope) ?? 'null');
    return p && p.scope === scope && typeof p.id === 'string' && typeof p.prompt === 'string' && Number.isSafeInteger(p.configRevision) ? p : null;
  } catch {
    return null;
  }
}

/** Writes and reads back the record; false means a retry could not be guaranteed, so nothing may be sent. */
export function persistPending(p: Pending, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): boolean {
  try {
    const value = JSON.stringify(p);
    storage.setItem(PENDING_PREFIX + p.scope, value);
    return storage.getItem(PENDING_PREFIX + p.scope) === value;
  } catch {
    return false;
  }
}

export function clearPending(scope: string, storage: Pick<Storage, 'removeItem'> = localStorage) {
  try {
    storage.removeItem(PENDING_PREFIX + scope);
  } catch {}
}

/** The exact request for a stored submission; a retry never mints a new ID or takes a newer prompt/revision. */
export const submissionOf = (p: Pending): ExecutionSubmit => ({ id: p.id, prompt: p.prompt, configRevision: p.configRevision, confirmPaid: true });

/** What the paid confirmation shows and submits, copied when it opens so later polls cannot change it. */
export function confirmationSnapshot(setup: ExecutionSetup, prompt: string, scope: string) {
  return Object.freeze({ scope, prompt, configRevision: setup.configRevision, config: structuredClone(setup.config) });
}

// ---- Shared DOM pieces ------------------------------------------------------------------------------

type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;
const button = (label: string, onclick: () => void, attrs: Attrs = {}) => h('button.btn', { type: 'button', onclick, ...attrs }, label);

function statusCard(title: string) {
  const label = h('span');
  const detail = h('p');
  const el = h('article.status-card', {}, h('span.empire-eyebrow', {}, title), h('strong', {}, h('span.status-dot', { 'aria-hidden': 'true' }), label), detail);
  return {
    el,
    set(v: StatusView) {
      el.dataset.tone = v.tone;
      label.textContent = v.label;
      detail.textContent = v.detail;
    },
  };
}

function field(label: string, input: HTMLInputElement | HTMLTextAreaElement, hint?: string) {
  const id = `exec-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  const hintEl = hint ? h('small', { id: `${id}-hint` }, hint) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  return h('div.exec-field', {}, h('label', { for: id }, label), input, hintEl);
}

const text = (value: string, attrs: Attrs = {}) => h('input', { type: 'text', value, autocomplete: 'off', spellcheck: 'false', ...attrs });

// ---- Execution setup --------------------------------------------------------------------------------

export function openExecutionSetup(opts: { onChanged?: (s: ExecutionSetup) => void; openTasks?: () => void } = {}) {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close execution setup' }, '✕');
  const body = h('div.body.exec-body', {}, h('p.setting-note', {}, 'Loading execution setup…'));
  const footerNote = h('span.exec-footer-note', {}, 'Saving and checking never start a task.');
  const saveBtn = button('Save configuration', () => void save(), { class: 'primary' });
  const checkBtn = button('Run read-only check', () => void check());
  const tasksBtn = button('Open cloud tasks', () => opts.openTasks?.());
  const status = h('p.exec-status', { role: 'status', 'aria-live': 'polite' });
  const modal = openModal(
    h(
      'div.modal.exec-modal',
      { role: 'dialog', 'aria-labelledby': 'exec-title' },
      h('header', {}, h('div.empire-heading', {}, h('small.empire-eyebrow', {}, 'Where agents run'), h('h2', { id: 'exec-title' }, 'Execution setup')), close),
      body,
      h('footer', {}, footerNote, status, checkBtn, tasksBtn, saveBtn),
    ),
  );
  close.onclick = () => modal.close();
  let setup: ExecutionSetup | null = null;
  let busy = false;

  // Form controls, built once so typing is never interrupted by a status refresh.
  const modeInputs = new Map<ExecutionMode, HTMLInputElement>();
  const owner = text('', { 'aria-required': 'true' }), name = text(''), branch = text('main');
  const agentId = text(''), environmentId = text(''), vaultId = text('');
  const concurrent = h('input', { type: 'number', min: 1, max: LIMITS.maxConcurrent, step: 1, inputmode: 'numeric' });
  const perTask = text('', { inputmode: 'decimal' }), daily = text('', { inputmode: 'decimal' });
  const errors = h('ul.exec-errors', { role: 'alert' });
  const summary = statusCard('Current setup');
  const creds = h('ul.exec-creds');
  const notices = h('ul.exec-notices');
  const cloudOnly = h('div.exec-cloud');
  const limitsOnly = h('div.exec-cloud');

  const readForm = (): ExecutionConfig | null => {
    if (!setup) return null;
    const mode = [...modeInputs].find(([, input]) => input.checked)?.[0] ?? setup.config.mode;
    const p = parseCents(perTask.value), d = parseCents(daily.value);
    const vault = vaultId.value.trim();
    return {
      schemaVersion: 1,
      completed: true,
      mode,
      repository: { owner: owner.value.trim(), name: name.value.trim(), baseBranch: branch.value.trim() },
      anthropic: { agentId: agentId.value.trim(), environmentId: environmentId.value.trim(), ...(vault ? { vaultId: vault } : {}) },
      githubAuth: 'host_token',
      limits: { maxConcurrent: Number(concurrent.value), perTaskBudgetCents: p ?? NaN, dailyBudgetCents: d ?? NaN },
    };
  };
  const dirty = () => {
    const f = readForm();
    return !!f && !!setup && (!setup.config.completed || comparable(f) !== comparable(setup.config));
  };
  const paintButtons = () => {
    const isDirty = dirty();
    const cloud = modeInputs.get('anthropic_cloud')?.checked ?? false;
    saveBtn.disabled = busy || !setup;
    checkBtn.disabled = busy || !setup || isDirty || setup.config.mode !== 'anthropic_cloud';
    checkBtn.title = isDirty ? 'Save your changes before checking.' : setup?.config.mode !== 'anthropic_cloud' ? 'The read-only check applies to provider cloud setup.' : '';
    tasksBtn.hidden = !opts.openTasks || !cloud || isDirty || setup?.config.mode !== 'anthropic_cloud';
    cloudOnly.hidden = !cloud;
    limitsOnly.hidden = !cloud;
    footerNote.textContent = isDirty ? 'Unsaved changes. Saving and checking never start a task.' : 'Saving and checking never start a task.';
  };
  const paintSetup = () => {
    if (!setup) return;
    summary.set(setupView(setup));
    creds.replaceChildren(
      h('li', { 'data-ok': String(setup.credentials.anthropic) }, setup.credentials.anthropic ? 'Anthropic credential available to the host' : 'No Anthropic credential on the host'),
      h('li', { 'data-ok': String(setup.credentials.github) }, setup.credentials.github ? 'GitHub token available to the host' : 'No GitHub token on the host'),
    );
    const items = [...setup.notices, ...(setup.check.message && setup.check.status !== 'ready' ? [setup.check.message] : [])];
    notices.replaceChildren(...items.map((n) => h('li', {}, n)));
    notices.hidden = !items.length;
    if (setup.check.checkedAt) summary.el.querySelector('p')!.append(` Checked ${timeAgo(setup.check.checkedAt)}.`);
    opts.onChanged?.(setup);
  };
  const fill = (c: ExecutionConfig) => {
    modeInputs.get(c.mode)!.checked = true;
    owner.value = c.repository.owner;
    name.value = c.repository.name;
    branch.value = c.repository.baseBranch || 'main';
    agentId.value = c.anthropic.agentId;
    environmentId.value = c.anthropic.environmentId;
    vaultId.value = c.anthropic.vaultId ?? '';
    concurrent.value = String(c.limits.maxConcurrent);
    perTask.value = (c.limits.perTaskBudgetCents / 100).toFixed(2);
    daily.value = (c.limits.dailyBudgetCents / 100).toFixed(2);
  };

  const modeCards = h(
    'div.exec-choices',
    { role: 'radiogroup', 'aria-labelledby': 'exec-mode-title' },
    ...(Object.keys(MODE_COPY) as ExecutionMode[]).map((mode) => {
      const input = h('input', { type: 'radio', name: 'exec-mode', value: mode });
      input.onchange = paintButtons;
      modeInputs.set(mode, input);
      const copy = MODE_COPY[mode];
      return h('label.exec-choice', {}, input, h('span', {}, h('strong', {}, copy.title), h('span', {}, copy.summary), h('small', {}, copy.detail)));
    }),
  );
  const providers = h(
    'div.exec-choices',
    { role: 'radiogroup', 'aria-label': 'Cloud provider' },
    ...PROVIDERS.map((p) =>
      h(
        'label.exec-choice',
        { 'aria-disabled': String(!p.available) },
        h('input', { type: 'radio', name: 'exec-provider', checked: p.available, disabled: !p.available }),
        h('span', {}, h('strong', {}, p.name), h('small', {}, p.note)),
      ),
    ),
  );
  cloudOnly.append(
    h('h3', {}, 'Provider'),
    providers,
    h('h3', {}, 'Repository'),
    h('div.exec-grid', {}, field('Owner', owner), field('Repository', name), field('Base branch', branch, 'Tasks work on their own branch cut from this one.')),
    h('p.setting-note', {}, 'Changes go to a separate branch or pull request for your review; the base branch is not changed directly.'),
    h('h3', {}, 'Managed agent'),
    h(
      'div.exec-grid',
      {},
      field('Agent ID', agentId, 'Created beforehand in the Claude Console; starts with agent_.'),
      field('Environment ID', environmentId, 'The sandbox environment the agent runs in; starts with env_.'),
      field('Vault ID (optional)', vaultId, 'Starts with vlt_.'),
    ),
    h('h3', {}, 'Credentials'),
    creds,
    h(
      'p.setting-note',
      {},
      'Keys never go through this page. In the desktop app use File › Provider credentials (stored encrypted by your operating system). On a server host, set ANTHROPIC_API_KEY and AGENT_EMPIRE_GITHUB_TOKEN in its environment.',
    ),
  );
  [owner, name, branch, agentId, environmentId, vaultId, concurrent, perTask, daily].forEach((el) => el.addEventListener('input', paintButtons));

  limitsOnly.append(
      h('h3', {}, 'Cloud task spending limits'),
      h(
        'div.exec-grid',
        {},
        field('Maximum concurrent tasks', concurrent, `1 to ${LIMITS.maxConcurrent}.`),
        field('Per-task budget (USD)', perTask, `Reserved from the daily budget when a task is submitted. Up to ${dollars(LIMITS.perTaskCents)}.`),
        field('Daily budget (USD)', daily, `At least the per-task budget, up to ${dollars(LIMITS.dailyCents)}.`),
      ),
      h(
        'p.setting-note',
        {},
        'The host enforces these limits before submitting work. Provider billing is separate: a final model call can overrun a cap, so your bill is not guaranteed to match these numbers exactly. Simulation credits never pay for real usage.',
      ),
  );

  const render = () => {
    body.replaceChildren(
      summary.el,
      h('details.exec-notice-details', {}, h('summary', {}, 'Cloud billing, access and recovery details'), notices),
      h('h3', { id: 'exec-mode-title' }, 'Where agents run'),
      modeCards,
      cloudOnly,
      limitsOnly,
      errors,
    );
  };

  const show = (next: ExecutionSetup, message = '') => {
    setup = next;
    paintSetup();
    status.textContent = message;
    paintButtons();
  };
  async function save() {
    const config = readForm();
    if (!config || busy) return;
    const problems = validateConfig(config);
    errors.replaceChildren(...problems.map((p) => h('li', {}, p)));
    if (problems.length) return;
    busy = true;
    paintButtons();
    status.textContent = 'Saving…';
    try {
      const next = await executionApi.save(config);
      fill(next.config);
      show(next, 'Configuration saved. No task was started.');
    } catch (err) {
      status.textContent = (err as Error).message;
    } finally {
      busy = false;
      paintButtons();
    }
  }
  async function check() {
    if (busy) return;
    busy = true;
    paintButtons();
    status.textContent = 'Running read-only check…';
    try {
      show(await executionApi.check(), 'Check finished. No task was started.');
    } catch (err) {
      status.textContent = (err as Error).message;
    } finally {
      busy = false;
      paintButtons();
    }
  }

  executionApi
    .setup()
    .then((s) => {
      render();
      fill(s.config);
      show(s);
      if (!s.config.completed) status.textContent = 'Defaults shown. Nothing is saved until you choose Save configuration.';
      modal.el.querySelector<HTMLInputElement>('input[name=exec-mode]:checked')?.focus();
    })
    .catch((err) => {
      body.replaceChildren(h('p.exec-error', { role: 'alert' }, `Execution setup is unavailable: ${(err as Error).message}`));
      paintButtons();
    });
  paintButtons();
  return modal;
}

// ---- Cloud tasks ------------------------------------------------------------------------------------

export function openCloudTasks(opts: { openSetup?: () => void; hostId?: () => string | undefined } = {}) {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close cloud tasks' }, '✕');
  const summary = statusCard('Provider cloud');
  const freshness = h('span.empire-freshness');
  const list = h('ol.exec-tasks', { 'aria-label': 'Cloud tasks' });
  const prompt = h('textarea', { rows: 4, placeholder: 'Describe the coding task for the managed agent…', maxlength: 20000 });
  const review = button('Review paid task…', () => confirmSubmit(), { class: 'primary' });
  const pendingBox = h('div.exec-pending', { role: 'status' });
  const setupBtn = button('Execution setup…', () => opts.openSetup?.());
  const composer = h(
    'section.exec-compose',
    { 'aria-labelledby': 'exec-new-title' },
    h('h3', { id: 'exec-new-title' }, 'New cloud task'),
    field('Task', prompt),
    h('div.sector-actions', {}, review),
    pendingBox,
  );
  const modal = openModal(
    h(
      'div.modal.exec-modal',
      { role: 'dialog', 'aria-labelledby': 'exec-tasks-title' },
      h('header', {}, h('div.empire-heading', {}, h('small.empire-eyebrow', {}, 'Provider cloud'), h('h2', { id: 'exec-tasks-title' }, 'Cloud tasks')), freshness, close),
      h(
        'div.body.exec-body',
        {},
        summary.el,
        h('p.setting-note', {}, 'This panel is separate from the office task queue. Cloud tasks run in your provider account; their results are unverified until you review the branch or pull request.'),
        h('div.sector-actions', {}, setupBtn),
        composer,
        h('h3', {}, 'Tasks'),
        list,
      ),
    ),
    { onClose: () => clearInterval(timer) },
  );
  close.onclick = () => modal.close();
  let setup: ExecutionSetup | null = null;
  let tasks: ExecutionTask[] = [];
  let loadedAt = 0;
  let listError = '';
  let scope: string | null = null;
  let pending: Pending | null = null;
  let submitting = false;
  const acting = new Set<string>();
  const resolve = (p: Pending | null) => {
    if (!p) return;
    clearPending(p.scope);
    if (pending?.id === p.id) pending = null;
  };

  const paintSummary = () => {
    summary.set(setup ? setupView(setup) : { tone: 'unknown', label: 'Setup unknown', detail: 'Could not load execution setup from the host.' });
    const ready = !!setup && setup.config.mode === 'anthropic_cloud' && setup.ready;
    review.disabled = !ready || !scope || submitting || !!pending;
    prompt.disabled = !ready || !scope;
    review.title = !ready
      ? 'Save a provider cloud setup and pass the read-only check first.'
      : !scope
        ? 'This host has not reported a stable identity, so a lost response could not be retried safely.'
        : pending
          ? 'Resolve the unconfirmed submission first.'
          : '';
  };
  const paintPending = () => {
    pendingBox.hidden = !pending;
    if (!pending) return pendingBox.replaceChildren();
    const p = pending;
    pendingBox.replaceChildren(
      h('strong', {}, 'Submission not confirmed'),
      h('p', {}, `The host did not confirm “${p.prompt.slice(0, 80)}${p.prompt.length > 80 ? '…' : ''}”. It may already be running. Retrying resends this request with the same task ID so the host can reconcile it against its saved ledger.`),
      h(
        'div.sector-actions',
        {},
        button(submitting ? 'Retrying…' : 'Retry same submission', () => void send(p), { disabled: submitting }),
        button('Forget this submission', async () => {
          if (!await confirmAction('Forget this submission?', 'If the host accepted it, it stays in the task list and may still be billed.', 'Forget submission')) return;
          resolve(p);
          paintPending();
          paintSummary();
        }),
      ),
    );
  };
  const paintList = () => {
    const age = loadedAt ? ` · updated ${timeAgo(loadedAt)}` : '';
    freshness.textContent = listError ? `Last known${age} · ${listError}` : loadedAt ? `Updated ${timeAgo(loadedAt)}` : 'Loading…';
    freshness.classList.toggle('stale', !!listError);
    const active = document.activeElement as HTMLElement | null;
    const key = active && list.contains(active) ? active.dataset.key : undefined;
    list.replaceChildren(
      ...(tasks.length
        ? [...tasks]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((t) => {
              const v = listError ? { tone: 'unknown' as const, label: `Last known: ${taskView(t).label}`, detail: 'The host could not be reached for an update.' } : taskView(t);
              const cost = t.cost ? `${dollars(t.cost.amountCents)} observed` : 'no cost observed yet';
              return h(
                'li.exec-task',
                { 'data-tone': v.tone },
                h('div.exec-task-head', {}, h('span.status-dot', { 'aria-hidden': 'true' }), h('strong', {}, v.label), h('small', {}, `Submitted ${timeAgo(t.createdAt)} · status checked ${timeAgo(t.updatedAt)}`)),
                h('p.exec-task-prompt', {}, t.prompt),
                h('p', {}, v.detail),
                h('small', {}, [`${t.repository.owner}/${t.repository.name}`, t.branch && `branch ${t.branch}`, `reserved ${dollars(t.reservedCents)} (${t.budgetDay})`, cost, t.sessionId && `session ${t.sessionId.slice(0, 12)}`].filter(Boolean).join(' · ')),
                h(
                  'div.sector-actions',
                  {},
                  button(acting.has(t.id) ? 'Refreshing…' : 'Refresh status', () => void act(t.id, 'refresh'), { 'data-key': `refresh-${t.id}`, disabled: acting.has(t.id) }),
                  canStop(t) ? button('Stop session', () => void act(t.id, 'stop'), { 'data-key': `stop-${t.id}`, disabled: acting.has(t.id) }) : null,
                ),
                !canStop(t) && !FINAL.includes(t.status) ? h('small', {}, 'No provider session is known yet, so it cannot be stopped from here. Refresh to reconcile.') : null,
              );
            })
        : [h('li.exec-empty', {}, loadedAt ? 'No cloud tasks yet.' : 'Loading tasks…')]),
    );
    if (key) list.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  };
  const upsert = (task: ExecutionTask) => {
    tasks = [task, ...tasks.filter((t) => t.id !== task.id)];
    if (pending?.id === task.id) resolve(pending);
  };
  async function load() {
    try {
      const [s, t] = await Promise.all([executionApi.setup(), executionApi.tasks()]);
      setup = s;
      tasks = t.tasks;
      loadedAt = Date.now();
      listError = '';
      scope = pendingScope((opts.hostId ?? currentHostId)(), s.config);
      // Pending records from another host or setup stay stored but are never offered here.
      if (!submitting) pending = scope ? loadPending(scope) : null;
      if (pending && tasks.some((x) => x.id === pending!.id)) resolve(pending);
    } catch (err) {
      listError = (err as Error).message;
    }
    paintSummary();
    paintPending();
    paintList();
  }
  async function act(id: string, kind: 'refresh' | 'stop') {
    if (acting.has(id)) return;
    if (kind === 'stop' && !await confirmAction('Stop this provider session?', 'A session mid-turn is interrupted first; if archival is not confirmed, refresh and Stop again once idle. Usage so far is still billed.', 'Confirm stop')) return;
    acting.add(id);
    paintList();
    try {
      const next = await executionApi[kind](id);
      upsert(next);
      if (kind === 'stop' && canStop(next)) toast('Session interrupted. Refresh, then Stop again once it is idle to archive it.', 'info');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      acting.delete(id);
      paintList();
    }
  }
  async function send(p: Pending) {
    if (submitting) return;
    if (!setup || pendingScope((opts.hostId ?? currentHostId)(), setup.config) !== p.scope) {
      toast('The connected host or repository changed. Return to the original host to reconcile this submission.', 'error');
      return;
    }
    submitting = true;
    paintSummary();
    paintPending();
    try {
      upsert(await executionApi.submit(submissionOf(p)));
      resolve(p);
      if (prompt.value.trim() === p.prompt) prompt.value = '';
      toast('Cloud task accepted by the host.', 'info');
    } catch (err) {
      if (provenPreDispatch(err)) resolve(p);
      toast(`${(err as Error).message}${provenPreDispatch(err) ? '' : ' The submission stays unresolved; retry reuses the same task ID.'}`, 'error');
    } finally {
      submitting = false;
      paintSummary();
      paintPending();
      paintList();
    }
  }
  /** Starts a new paid submission from the snapshot the user confirmed; refuses if it cannot be recorded first. */
  function submitNew(snapshot: { scope: string; prompt: string; configRevision: number }) {
    if (submitting || pending) return;
    const p: Pending = { ...snapshot, id: crypto.randomUUID() };
    if (!persistPending(p)) {
      toast('This browser could not save a record of the submission, so it was not sent. Allow site storage and try again.', 'error');
      return;
    }
    pending = p;
    void send(p);
  }
  function confirmSubmit() {
    const task = prompt.value.trim();
    if (!task || !setup || !scope || pending) {
      prompt.focus();
      return;
    }
    const snapshot = confirmationSnapshot(setup, task, scope);
    const c = snapshot.config;
    const repo = `${c.repository.owner}/${c.repository.name}`;
    const ack = h('input', { type: 'checkbox', id: 'exec-paid-ack' });
    const go = button('Submit paid task', () => {
      dialog.close();
      submitNew({ scope: snapshot.scope, prompt: snapshot.prompt, configRevision: snapshot.configRevision });
    }, { class: 'primary', disabled: true });
    ack.onchange = () => (go.disabled = !ack.checked);
    const cancel = button('Cancel', () => dialog.close());
    const dialog: Modal = openModal(
      h(
        'div.modal.exec-modal.exec-confirm',
        { role: 'dialog', 'aria-labelledby': 'exec-confirm-title', 'aria-describedby': 'exec-confirm-body' },
        h('header', {}, h('h2', { id: 'exec-confirm-title' }, 'Start a paid cloud task?')),
        h(
          'div.body.exec-body',
          { id: 'exec-confirm-body' },
          h(
            'dl.exec-review',
            {},
            ...[
              ['Provider', 'Anthropic Managed Agents (your account)'],
              ['Repository', `${repo} from ${c.repository.baseBranch}`],
              ['GitHub access', `The host’s GitHub token is sent to Anthropic for this session so the agent can clone and push to ${repo}.`],
              ['Agent / environment', `${c.anthropic.agentId} / ${c.anthropic.environmentId}${c.anthropic.vaultId ? ` / ${c.anthropic.vaultId}` : ''}`],
              ['Reserved per task', `${dollars(c.limits.perTaskBudgetCents)} of ${dollars(c.limits.dailyBudgetCents)} daily`],
              ['Setup revision', String(snapshot.configRevision)],
              ['Task', task.length > 240 ? `${task.slice(0, 240)}…` : task],
            ].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
          ),
          h('p.setting-note', {}, 'This starts a billed provider session that keeps running after you close this page. The host enforces your limits, but a final model call can overrun a cap, so the bill is not guaranteed to match exactly. Results are unverified until you review them. If the setup changes before the host admits the task, it is rejected and nothing starts.'),
          h('label.exec-ack', { for: 'exec-paid-ack' }, ack, ' I understand this starts a paid task on my provider account and shares the host’s GitHub token with Anthropic for this session.'),
        ),
        h('footer', {}, cancel, go),
      ),
    );
  }

  const timer = setInterval(() => void load(), 5000);
  paintSummary();
  paintPending();
  paintList();
  void load();
  return modal;
}

// ---- First-use offer --------------------------------------------------------------------------------

/** FREE-08: onboarding includes "Where agents run", so showing it counts as the offer. */
export function markOfferSeen() {
  try {
    localStorage.setItem(OFFER_KEY, '1');
  } catch {}
}

export function offerSeen(): boolean {
  try {
    return localStorage.getItem(OFFER_KEY) === '1';
  } catch {
    return true;
  }
}

/** Offered once after character and founding; choosing Later saves nothing on the host and starts nothing. */
export async function maybeOfferExecutionSetup(openSetup: () => void) {
  if (offerSeen()) return;
  let setup: ExecutionSetup | null = null;
  try {
    setup = await executionApi.setup();
  } catch {
    return;
  }
  if (!shouldOffer(setup, offerSeen())) return;
  const markSeen = () => {
    try {
      localStorage.setItem(OFFER_KEY, '1');
    } catch {}
  };
  const later = button('Later', () => modal.close());
  const now = button('Choose where agents run', () => {
    modal.close();
    openSetup();
  }, { class: 'primary' });
  const modal = openModal(
    h(
      'div.modal.exec-modal.exec-offer',
      { role: 'dialog', 'aria-labelledby': 'exec-offer-title' },
      h('header', {}, h('div.empire-heading', {}, h('small.empire-eyebrow', {}, 'Optional'), h('h2', { id: 'exec-offer-title' }, 'Where should agents run?'))),
      h(
        'div.body.exec-body',
        {},
        h('p', {}, 'You can keep exploring and decide later. A new desktop city keeps local work paused until setup is complete and you enable the queue. Existing hosts retain their local worker controls.'),
        h('ul.exec-offer-list', {}, ...(Object.keys(MODE_COPY) as ExecutionMode[]).map((m) => h('li', {}, h('strong', {}, MODE_COPY[m].title), ` — ${MODE_COPY[m].summary}`))),
        h('p.setting-note', {}, 'Nothing is saved, connected or started from this prompt. You can open execution setup any time from Settings › App & connection.'),
      ),
      h('footer', {}, later, now),
    ),
    { onClose: markSeen },
  );
}
