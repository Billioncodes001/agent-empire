/**
 * FREE-08 (ORG-06) client: the first-run onboarding dialog and its Settings entry.
 *
 * Offered once per page load after founding (and before the execution offer it includes), resumable at the step it
 * stopped on, every step skippable, re-openable from Settings. The host never sends a secret back: secret fields only
 * say "saved". There is no Claude sign-in or token field: the workers step links to the existing Linked accounts flow,
 * where "Sign in to Claude" opens the user's own `claude` with /login typed. Model downloads stay in that panel, behind
 * its name/size/licence confirmation.
 */
import { apiFetch } from '../endpoint';
import { h, openModal, toast, type Modal } from './dom';
import { enginesApi } from './engines';
import { chiefApi } from './chief';
import {
  APPROVAL_RULES, CHANNEL_ENV, BUDGET_ENV, CLOUD_APPLIES, DEFAULT_NTFY_SERVER, ONBOARDING_STEPS, PROFILE_MAX, STEP_LABEL,
  executionOfferAnswered, randomTopic, validateApprovals, validateNotifications, validateProfile,
  type ChannelId, type ChannelView, type OnboardingStep, type OnboardingView, type SecretName,
} from '../../shared/onboarding';
import { engineKey, engineLabel } from '../../shared/engines';

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await apiFetch(path, { method, cache: 'no-store', credentials: 'same-origin', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json as T;
}

export const onboardingApi = {
  view: () => call<OnboardingView & { storageError?: string }>('/api/onboarding'),
  progress: (body: { action: 'step' | 'goto' | 'dismiss' | 'reopen'; step?: OnboardingStep; result?: 'done' | 'skipped' }) => call<OnboardingView>('/api/onboarding/progress', 'POST', body),
  save: (body: unknown) => call<OnboardingView>('/api/settings', 'PUT', body),
  test: (channel: ChannelId) => call<{ ok: true; message: string }>(`/api/settings/test/${channel}`, 'POST', {}),
};

const STEP_TITLE: Record<OnboardingStep, string> = {
  profile: 'Your company',
  engines: 'Who does the work',
  notifications: 'How the office reaches you',
  approvals: 'What needs your approval',
};

const SOURCE_NOTE = (c: ChannelId, v: ChannelView) => v.source === 'env'
  ? `Set on the office host by ${CHANNEL_ENV[c].join(' / ')}. Those environment variables win: what you save here is kept but not used while they are set.`
  : v.source === 'runtime' ? 'Set by the host’s test configuration.' : '';

function field(label: string, input: HTMLElement, hint?: string) {
  const id = `ob-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h('div.ob-field', {}, h('label', { for: id }, label), input, hint ? h('p.setting-note', {}, hint) : null);
}
const textInput = (value: string, attrs: Record<string, string | number> = {}) => h('input', { type: 'text', value, autocomplete: 'off', spellcheck: 'false', ...attrs }) as HTMLInputElement;

/** A secret field: never shows a saved value; typing replaces it; "Remove" deletes it on the host. */
function secretInput(name: SecretName, present: boolean, label: string, hint: string) {
  const input = h('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false', placeholder: present ? 'Saved · type to replace' : 'Not saved' }) as HTMLInputElement;
  let remove = false;
  const badge = h('span.ob-secret-state', { 'data-present': String(present) }, present ? '● Saved on the host' : '○ Not saved');
  const removeBtn = h('button.btn', { type: 'button', hidden: !present }, 'Remove') as HTMLButtonElement;
  removeBtn.addEventListener('click', () => { remove = !remove; removeBtn.textContent = remove ? 'Keep it' : 'Remove'; badge.textContent = remove ? '○ Will be removed when you save' : '● Saved on the host'; input.disabled = remove; });
  const wrap = field(label, input, hint);
  wrap.append(h('div.ob-secret-row', {}, badge, removeBtn));
  return { el: wrap, value: (): string | null | undefined => (remove ? null : input.value.trim() ? input.value.trim() : undefined), input, name };
}

const cost = (free: boolean, text: string) => h('p.ob-cost', { 'data-free': String(free) }, h('strong', {}, free ? 'Free' : 'Costs money'), ` · ${text}`);

/** Cloud mode: which steps apply. FREE-04/07 will extend this; nothing here depends on them. */
function cloudPanel(): Modal {
  const close = h('button.btn.primary', { type: 'button' }, 'Close');
  const m = openModal(h('div.modal.exec-modal.onboarding-modal', { role: 'dialog', 'aria-labelledby': 'ob-cloud-title' },
    h('header', {}, h('div.empire-heading', {}, h('small.empire-eyebrow', {}, 'Company setup · cloud mode'), h('h2', { id: 'ob-cloud-title' }, 'What applies in cloud mode'))),
    h('div.body.exec-body', {},
      h('p', {}, 'Onboarding configures an office host. In cloud mode your Empire runs in your own GitHub, so some steps do not apply yet.'),
      h('ul.ob-cloud', {}, ...ONBOARDING_STEPS.map((s) => h('li', { 'data-applies': CLOUD_APPLIES[s].applies },
        h('strong', {}, `${STEP_LABEL[s]} · ${CLOUD_APPLIES[s].applies === 'yes' ? 'applies' : CLOUD_APPLIES[s].applies === 'partly' ? 'partly applies' : 'does not apply'}`), h('p', {}, CLOUD_APPLIES[s].text)))),
    ),
    h('footer', {}, close)));
  close.addEventListener('click', () => m.close());
  return m;
}

export interface OnboardingHooks {
  /** Opens Settings at Linked accounts (on top of this dialog). */
  openLinkedAccounts: () => void;
  /** The existing "Sign in to Claude": a worker terminal with /login typed. Closes dialogs. */
  signInToClaude: () => void;
  /** The existing execution setup ("Where agents run"). */
  openExecution: () => void;
  /** The Workers step was answered or execution setup was opened from it: the separate execution offer is redundant. */
  markExecutionOfferSeen?: () => void;
  cloud?: boolean;
}

export function openOnboarding(hooks: OnboardingHooks, initial?: OnboardingView): Modal {
  if (hooks.cloud) return cloudPanel();
  let view = initial;
  let busy = false;
  let doneScreen = false;
  const rail = h('ol.ob-rail', { 'aria-label': 'Setup steps' });
  const eyebrow = h('small.empire-eyebrow');
  const title = h('h2', { id: 'ob-title' }, 'Set up your company');
  const body = h('div.body.exec-body.ob-body', { 'aria-live': 'off' });
  const status = h('p.ob-status', { role: 'status', 'aria-live': 'polite' });
  const skip = h('button.btn', { type: 'button' }, 'Skip this step') as HTMLButtonElement;
  const later = h('button.btn.ob-later', { type: 'button' }, 'Finish later') as HTMLButtonElement;
  const next = h('button.btn.primary', { type: 'button' }, 'Save and continue') as HTMLButtonElement;
  const dismissBtn = h('button.btn.ob-link', { type: 'button' }, 'Don’t show again') as HTMLButtonElement;
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close setup' }, '✕');
  const el = h('div.modal.exec-modal.onboarding-modal', { role: 'dialog', 'aria-labelledby': 'ob-title' },
    h('header', {}, h('div.empire-heading', {}, eyebrow, title), close),
    rail, body,
    h('footer', {}, dismissBtn, h('span.grow'), status, skip, later, next));
  let collect: () => Promise<void> = async () => {};
  let dirty = false;
  el.addEventListener('input', () => { dirty = true; });
  const modal = openModal(el, { dirty: () => dirty });
  close.addEventListener('click', () => modal.close());
  later.addEventListener('click', () => modal.close());

  const say = (text: string, tone: 'info' | 'error' = 'info') => { status.textContent = text; status.dataset.tone = tone; };

  const paintRail = () => {
    if (!view) return;
    const p = view.progress;
    rail.replaceChildren(...ONBOARDING_STEPS.map((s, i) => {
      const state = p.steps[s];
      const b = h('button.ob-step', { type: 'button', 'data-state': state, ...(s === p.current && !doneScreen ? { 'aria-current': 'step' } : {}) },
        h('span.ob-step-n', { 'aria-hidden': 'true' }, state === 'done' ? '✓' : state === 'skipped' ? '–' : String(i + 1)),
        h('span', {}, STEP_LABEL[s]), h('span.sr-only', {}, state === 'done' ? ' (done)' : state === 'skipped' ? ' (skipped)' : ''));
      b.addEventListener('click', () => void go(s));
      return h('li', {}, b);
    }));
  };

  const go = async (s: OnboardingStep) => {
    if (busy || !view) return;
    try { view = await onboardingApi.progress({ action: 'goto', step: s }); doneScreen = false; render(); } catch (e) { say((e as Error).message, 'error'); }
  };

  const finish = async (result: 'done' | 'skipped') => {
    if (busy || !view) return;
    busy = true; next.disabled = skip.disabled = true;
    try {
      if (result === 'done') await collect();
      const step = view.progress.current;
      view = await onboardingApi.progress({ action: 'step', step, result });
      if (executionOfferAnswered(view.progress)) hooks.markExecutionOfferSeen?.();
      dirty = false;
      if (view.progress.status === 'done') doneScreen = true;
      render();
    } catch (e) { say((e as Error).message, 'error'); }
    finally { busy = false; next.disabled = skip.disabled = false; }
  };
  next.addEventListener('click', () => void (doneScreen ? modal.close() : finish('done')));
  skip.addEventListener('click', () => void finish('skipped'));
  dismissBtn.addEventListener('click', async () => {
    try { await onboardingApi.progress({ action: 'dismiss' }); toast('Setup hidden. Open it any time from Settings › Company setup.'); modal.close(); }
    catch (e) { say((e as Error).message, 'error'); }
  });

  const heading = (text: string, lead: string) => {
    const hd = h('h3.ob-heading', { tabindex: '-1' }, text);
    return [hd, h('p.ob-lead', {}, lead)] as const;
  };

  const render = () => {
    if (!view) return;
    const p = view.progress;
    paintRail();
    say(view.storageError ?? '', view.storageError ? 'error' : 'info');
    const s = view.settings;
    const i = ONBOARDING_STEPS.indexOf(p.current);
    skip.hidden = doneScreen;
    later.hidden = doneScreen;
    dismissBtn.hidden = doneScreen || p.status === 'done';
    if (doneScreen) {
      eyebrow.textContent = 'Company setup · finished';
      title.textContent = 'Your office is set up';
      next.textContent = 'Close';
      const [hd, lead] = heading('Summary', 'Everything here can be changed later in Settings › Company setup.');
      body.replaceChildren(hd, lead, h('ul.ob-summary', {}, ...ONBOARDING_STEPS.map((st) => h('li', { 'data-state': p.steps[st] }, h('strong', {}, STEP_LABEL[st]), ` · ${p.steps[st] === 'done' ? 'done' : p.steps[st] === 'skipped' ? 'skipped' : 'not answered'}`))),
        h('p.setting-note', {}, ...(['telegram', 'ntfy', 'email'] as ChannelId[]).map((c) => `${s.channels[c].label}. `)));
      collect = async () => {};
      requestAnimationFrame(() => hd.focus({ preventScroll: true }));
      return;
    }
    eyebrow.textContent = `Company setup · step ${i + 1} of ${ONBOARDING_STEPS.length}`;
    title.textContent = STEP_TITLE[p.current];
    next.textContent = i === ONBOARDING_STEPS.length - 1 ? 'Save and finish' : 'Save and continue';
    const step = { profile: profileStep, engines: enginesStep, notifications: notificationsStep, approvals: approvalsStep }[p.current]();
    body.replaceChildren(...step.nodes.filter((x): x is Node => !!x));
    collect = step.collect;
    body.scrollTop = 0;
    requestAnimationFrame(() => (body.querySelector('.ob-heading') as HTMLElement | null)?.focus({ preventScroll: true }));
  };

  // ---- Steps -------------------------------------------------------------------------------------------------

  function profileStep() {
    const s = view!.settings.profile;
    const name = textInput(s.name, { maxlength: PROFILE_MAX.name, placeholder: 'e.g. Northwind Studio' });
    const industry = textInput(s.industry, { maxlength: PROFILE_MAX.industry, placeholder: 'e.g. Booking software for clinics' });
    const website = textInput(s.website, { maxlength: PROFILE_MAX.website, placeholder: 'https://', inputmode: 'url' });
    const mission = h('textarea', { rows: 3, maxlength: PROFILE_MAX.mission, placeholder: 'One or two sentences: what you make and for whom.' }, s.mission) as HTMLTextAreaElement;
    const [hd, lead] = heading('Company profile', 'Your company name signs notifications and names jobs you start by phone. It stays on your office host.');
    return {
      nodes: [hd, lead, cost(true, 'nothing here costs money.'), h('div.ob-grid', {}, field('Company name', name), field('What you do', industry)), field('Website (optional)', website), field('Mission (optional)', mission)],
      collect: async () => {
        const profile = { name: name.value.trim(), industry: industry.value.trim(), website: website.value.trim(), mission: mission.value.trim() };
        const errors = validateProfile(profile);
        if (errors.length) throw new Error(errors.join(' '));
        view = await onboardingApi.save({ profile });
      },
    };
  }

  function enginesStep() {
    const [hd, lead] = heading('Worker engines and models', 'Workers run a coding agent on your office host. The free path needs no account; premium uses your own subscription or key.');
    const summary = h('div.ob-engines', { 'aria-live': 'polite' }, h('p.setting-note', {}, 'Checking what is installed on the office host…'));
    const linked = h('button.btn', { type: 'button', onclick: hooks.openLinkedAccounts }, 'Open Linked accounts…');
    const signIn = h('button.btn', { type: 'button', onclick: hooks.signInToClaude }, 'Sign in to Claude…');
    const exec = h('button.btn', { type: 'button', onclick: () => { hooks.markExecutionOfferSeen?.(); hooks.openExecution(); } }, 'Where agents run…');
    enginesApi.state().then((st) => {
      const select = h('select', { 'aria-label': 'Default engine for new hires' }) as HTMLSelectElement;
      select.append(h('option', { value: 'auto' }, 'Automatic: premium when healthy, otherwise free'));
      for (const o of st.options) select.append(h('option', { value: engineKey(o.engine), disabled: !o.usable }, `${o.label}${o.usable ? '' : ' — not ready'}`));
      select.value = st.defaultEngine === 'auto' ? 'auto' : engineKey(st.defaultEngine);
      select.addEventListener('change', () => {
        const chosen = select.value === 'auto' ? 'auto' : st.options.find((o) => engineKey(o.engine) === select.value)?.engine;
        if (chosen) enginesApi.setDefault(chosen).then(() => say('Default engine saved.'), (e) => say(e.message, 'error'));
      });
      const row = (label: string, state: string, ok: boolean) => h('li', { 'data-ok': String(ok) }, h('strong', {}, label), h('span', {}, state));
      summary.replaceChildren(
        h('ul.ob-engine-list', {},
          row('Recommended now', st.recommended ? engineLabel(st.recommended) : 'Nothing is ready yet', !!st.recommended),
          row('Qwen Code · free', st.qwen.installed ? 'Installed' : 'Not installed', st.qwen.installed),
          row('Ollama · local models', st.ollama.running ? `Running · ${st.ollama.models.length} model${st.ollama.models.length === 1 ? '' : 's'}` : 'Not running', st.ollama.running),
          row('Claude Code · premium', !st.claude.installed ? 'Not installed' : st.claude.loggedIn ? 'Signed in' : 'Not signed in', !!st.claude.loggedIn),
        ),
        field('Default engine for new hires', select),
      );
    }, () => summary.replaceChildren(h('p.setting-note', {}, 'The office host did not report its engines. You can still continue and check Linked accounts later.')));
    return {
      nodes: [hd, lead,
        cost(true, 'Qwen Code with a local model through Ollama: US$0, runs on this computer (16 GB memory or more).'),
        cost(false, 'Claude Code uses your own Claude subscription or an Anthropic API key; Codex your ChatGPT account. Your provider bills you, never the Empire.'),
        summary,
        h('p.setting-note', {}, 'The Empire never asks for your Claude password or token. “Sign in to Claude” opens a worker terminal with /login typed; you finish inside Claude Code. Models download only from Linked accounts, after you confirm the name, size and licence.'),
        h('div.sector-actions', {}, linked, signIn, exec)],
      collect: async () => {},
    };
  }

  function notificationsStep() {
    const s = view!.settings;
    const n = s.notifications;
    const ch = s.channels;
    const nodes: Node[] = [];
    const [hd, lead] = heading('Notification channels', 'The host tells you when an approval is waiting. Pick any, all, or none. Nothing is sent until you press a test button or an approval arrives.');
    nodes.push(hd, lead);

    const channelBox = (id: ChannelId, name: string, children: Node[], costNode: Node) => {
      const v = ch[id];
      const state = h('span.ob-channel-state', { 'data-ok': String(v.configured && !v.error) }, v.error ? `Needs attention: ${v.error}` : v.label);
      const testBtn = h('button.btn', { type: 'button' }, 'Save and send test') as HTMLButtonElement;
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true;
        try { await save(); const r = await onboardingApi.test(id); say(r.message); toast(r.message); }
        catch (e) { say((e as Error).message, 'error'); }
        finally { testBtn.disabled = false; }
      });
      const note = SOURCE_NOTE(id, v);
      return h('fieldset.ob-channel', { 'data-source': v.source }, h('legend', {}, name), state, costNode, note ? h('p.ob-env', {}, note) : null, ...children, h('div.sector-actions', {}, testBtn));
    };

    const owner = textInput(n.telegram.ownerId, { inputmode: 'numeric', maxlength: 16, placeholder: 'e.g. 123456789' });
    const tgToken = secretInput('telegramToken', s.secrets.telegramToken, 'Bot token', 'From @BotFather (/newbot). Then send your bot any message so it may write to you.');
    nodes.push(channelBox('telegram', 'Telegram', [tgToken.el, field('Your Telegram user ID', owner, 'A number; @userinfobot tells you yours. Only this account can command the office.')], cost(true, 'Telegram bots are free.')));

    const server = textInput(n.ntfy.server || DEFAULT_NTFY_SERVER, { inputmode: 'url' });
    const topic = textInput(n.ntfy.topic, { maxlength: 64, placeholder: 'empire-…' });
    const gen = h('button.btn', { type: 'button' }, 'Use a random topic');
    gen.addEventListener('click', () => { topic.value = randomTopic(); dirty = true; });
    const ntToken = secretInput('ntfyToken', s.secrets.ntfyToken, 'Access token (optional)', 'Only for a protected topic or your own server (tk_…).');
    nodes.push(channelBox('ntfy', 'ntfy push', [field('Server', server, 'https://ntfy.sh, or your own ntfy server. Plain http only for a server on this computer.'), field('Topic', topic, 'On the public server anyone who knows the topic can read it: keep it long and random.'), h('div.sector-actions', {}, gen), ntToken.el],
      cost(true, 'ntfy.sh is free without an account (paid plans exist); self-hosting is free.')));

    const host = textInput(n.email.host, { placeholder: 'smtp.example.com' });
    const port = textInput(n.email.port ? String(n.email.port) : '', { inputmode: 'numeric', maxlength: 5, placeholder: n.email.security === 'tls' ? '465' : '587' });
    const security = h('select', {}, h('option', { value: 'starttls' }, 'STARTTLS (usually port 587)'), h('option', { value: 'tls' }, 'TLS (usually port 465)')) as HTMLSelectElement;
    security.value = n.email.security;
    const user = textInput(n.email.user, { placeholder: 'you@example.com', autocomplete: 'username' });
    const pass = secretInput('smtpPassword', s.secrets.smtpPassword, 'SMTP password', 'For Gmail, an app password (needs 2-Step Verification).');
    const to = textInput(n.email.to, { inputmode: 'email', placeholder: 'where approvals go' });
    const from = textInput(n.email.from, { inputmode: 'email', placeholder: 'optional; defaults to the user name' });
    nodes.push(channelBox('email', 'Email', [h('div.ob-grid', {}, field('SMTP server', host), field('Port', port)), field('Security', security), h('div.ob-grid', {}, field('User name', user), pass.el), h('div.ob-grid', {}, field('Send to', to), field('From (optional)', from))],
      cost(true, 'with your own mail account (Gmail allows about 500 a day). Some providers charge for SMTP.')));

    const save = async () => {
      const notifications = {
        telegram: { ownerId: owner.value.trim() },
        ntfy: { server: server.value.trim(), topic: topic.value.trim() },
        email: { host: host.value.trim(), port: port.value.trim() ? Number(port.value.trim()) : null, security: security.value as 'tls' | 'starttls', user: user.value.trim(), to: to.value.trim(), from: from.value.trim() },
      };
      const errors = validateNotifications(notifications);
      if (errors.length) throw new Error(errors.join(' '));
      const secrets: Partial<Record<SecretName, string | null>> = {};
      for (const sec of [tgToken, ntToken, pass]) { const v = sec.value(); if (v !== undefined) secrets[sec.name] = v; }
      view = await onboardingApi.save({ notifications, ...(Object.keys(secrets).length ? { secrets } : {}) });
      dirty = false;
      // Repaint so channel states and "saved" badges come from the host; secret fields come back empty.
      const top = body.scrollTop;
      render();
      body.scrollTop = top;
    };
    return { nodes, collect: save };
  }

  function approvalsStep() {
    const s = view!.settings;
    const [hd, lead] = heading('Approval rules and budgets', 'You approve all real work. These limits catch runaway spending.');
    const budget = textInput(s.approvals.dailyBudgetUsd === null ? '' : String(s.approvals.dailyBudgetUsd), { inputmode: 'decimal', placeholder: 'No daily budget' });
    const pause = h('input', { type: 'checkbox' }) as HTMLInputElement;
    pause.checked = s.approvals.pauseHiring;
    const pauseLabel = h('label.cloud-check', {}, pause, ' Stop new hires for the rest of the day once it is spent');
    const hostNote = s.budget.source === 'cli' || s.budget.source === 'env'
      ? h('p.ob-env', {}, `The office host sets a daily budget of $${s.budget.usd} with --budget or ${BUDGET_ENV.join(' / ')}. That wins: what you save here is kept for when it is removed.`) : null;
    const cap = textInput('', { inputmode: 'decimal', placeholder: '2.00' });
    let capLoaded = false;
    chiefApi.state().then((c) => { cap.value = String(c.settings.dailyCapUsd); capLoaded = true; }, () => { cap.disabled = true; cap.placeholder = 'Unavailable on this host'; });
    return {
      nodes: [hd, lead,
        h('table.ob-rules', {}, h('caption.sr-only', {}, 'Who approves what'), h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'What'), h('th', { scope: 'col' }, 'Who approves'))),
          h('tbody', {}, ...APPROVAL_RULES.map((r) => h('tr', {}, h('td', {}, r.what), h('td', {}, r.who))))),
        h('p.setting-note', {}, 'These are fixed on purpose: nothing that spends money or acts outside the office starts without you.'),
        field('Daily budget for all workers (US$)', budget, 'Local models cost US$0. This counts provider spend that the workers report, which is an estimate while a session runs.'),
        pauseLabel, hostNote,
        field('Chief’s daily premium cap (US$)', cap, 'Only used when the chief of staff thinks with a premium API key. The free (local) brain costs US$0. The chief pauses itself at the cap.')],
      collect: async () => {
        const raw = budget.value.trim().replace(/^\$/, '');
        const approvals = { dailyBudgetUsd: raw ? Number(raw) : null, pauseHiring: pause.checked };
        const errors = validateApprovals(approvals);
        if (errors.length) throw new Error(errors.join(' '));
        view = await onboardingApi.save({ approvals });
        const c = Number(cap.value.trim().replace(/^\$/, ''));
        if (capLoaded && cap.value.trim()) {
          if (!(c > 0)) throw new Error('The chief’s cap must be above $0.');
          await chiefApi.settings({ dailyCapUsd: c });
        }
      },
    };
  }

  const load = async () => {
    try { view = view ?? (await onboardingApi.view()); if (view.progress.status === 'not_started') view = await onboardingApi.progress({ action: 'goto', step: view.progress.current }); render(); }
    catch (e) { body.replaceChildren(h('p.setting-note', {}, `Setup is not available: ${(e as Error).message}`)); }
  };
  void load();
  return modal;
}

/** Settings entry: progress and a button that re-opens onboarding (or the cloud summary). */
export function onboardingSection(hooks: OnboardingHooks) {
  const note = h('p.setting-note', {}, hooks.cloud ? 'Cloud mode: see which setup steps apply.' : 'Checking setup…');
  const open = h('button.btn', { type: 'button' }, 'Company setup…');
  open.addEventListener('click', async () => {
    if (hooks.cloud) { cloudPanel(); return; }
    try { const v = await onboardingApi.progress({ action: 'reopen' }); openOnboarding(hooks, v); }
    catch (e) { toast((e as Error).message, 'warn'); }
  });
  if (!hooks.cloud) onboardingApi.view().then((v) => {
    const answered = ONBOARDING_STEPS.filter((s) => v.progress.steps[s] !== 'pending').length;
    note.textContent = `${answered} of ${ONBOARDING_STEPS.length} steps answered. Company profile, worker engines, notifications (Telegram, ntfy, email) and approval budgets.`;
  }, () => { note.textContent = 'This office host does not offer company setup.'; open.disabled = true; });
  const el = h('section.onboarding-section', { 'aria-labelledby': 'ob-section-title' }, h('label', { id: 'ob-section-title', style: 'margin-top:18px' }, 'Company setup'), note, open);
  return { el, dispose: () => {} };
}

/** First run: offered once per page load after founding, when the host says so (never for legacy installs). */
export async function maybeOfferOnboarding(hooks: OnboardingHooks): Promise<boolean> {
  try {
    const v = await onboardingApi.view();
    if (!v.offer) return false;
    openOnboarding(hooks, v);
    return true;
  } catch { return false; }
}
