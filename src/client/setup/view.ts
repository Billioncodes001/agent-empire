/**
 * The first-launch setup screen. Runs before the game bundle loads (no three.js here), renders the pure state
 * machine in model.ts, and hands back either a server session (the game then starts) or a cloud Empire.
 */
import './setup.css';
import type { Native, ShellInfo } from '../native';
import { BridgeError } from '../native';
import {
  blockers, CLOUD_STEPS, DEFAULT_LIMITS, dollars, LIMIT_BOUNDS, linkedProviders, MAX_REPOS, parseCents, progress, PROVIDER_NAMES, reduce, repoKey,
  STATE_REPO_NAME, validateProviderKey, type Action, type ProviderId, type RepoRef, type SetupState, type Step,
} from './model';
import { defaultDeviceName, LoginFailure, parseServerAddress, revokeDevice, signInToServer, type ServerSession } from './server-login';
import { GitHubClient, GitHubError, type RepoListing } from './github';
import { CloudSetupError, createEmpire, CREATE_STEPS, githubCloudSetup, pendingWorkflow, readiness, sodiumSealer, type CreateStep, type StateRepo, type WorkflowSource } from './cloud-setup';
import { GITHUB_NEW_STATE_REPO_URL, GITHUB_SCOPES, GITHUB_TOKEN_URL, PROVIDER_KEY_URLS } from './config';
import { dismissKeyboard, isTouchDevice, trackKeyboard } from '../keyboard';

// ---- Tiny DOM helper --------------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v); // static, trusted markup only (icons)
    // Field values are set as the live property, never as an attribute: a typed API key must not appear in the DOM
    // markup (outerHTML, serialisers, attribute selectors).
    else if (k === 'value' && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) node.value = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v as EventListener);
    else if (k in node && typeof v !== 'string') (node as unknown as Record<string, unknown>)[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}
const icon = (svg: string, cls = 'su-ico') => el('span', { class: cls, 'aria-hidden': 'true', html: svg });

const ICONS = {
  cloud: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 36h21a9 9 0 0 0 1.6-17.86A12 12 0 0 0 13.3 21.2 7.5 7.5 0 0 0 14 36Z"/><path d="M20 28l4-4 4 4M24 24v9"/></svg>',
  server: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="9" y="8" width="30" height="12" rx="3"/><rect x="9" y="28" width="30" height="12" rx="3"/><path d="M15 14h.01M15 34h.01M21 14h11M21 34h11"/></svg>',
  github: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.24 2.75.12 3.04.74.81 1.18 1.83 1.18 3.09 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l2 2M15 8l2 2"/></svg>',
};

// ---- Background: a quiet city skyline, drawn once ------------------------------------------------------

function skyline(lite: boolean): HTMLElement {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const layer = (depth: number, base: number, count: number, maxH: number, fill: string, lit: string) => {
    const w = 1600;
    let x = 0;
    let rects = '';
    let windows = '';
    for (let i = 0; i < count && x < w; i++) {
      const bw = 34 + rnd() * 70;
      const bh = maxH * (0.35 + rnd() * 0.65);
      const y = base - bh;
      rects += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2"/>`;
      if (rnd() > 0.7) rects += `<rect x="${(x + bw / 2 - 1.5).toFixed(1)}" y="${(y - 18).toFixed(1)}" width="3" height="18"/>`;
      if (!lite && depth > 0)
        for (let wy = y + 10; wy < base - 12; wy += 16)
          for (let wx = x + 7; wx < x + bw - 10; wx += 13)
            if (rnd() > 0.83) windows += `<rect class="${rnd() > 0.8 ? 'su-tw' : ''}" style="animation-delay:${(rnd() * 6).toFixed(2)}s" x="${wx.toFixed(1)}" y="${wy.toFixed(1)}" width="5" height="7" rx="1"/>`;
      x += bw + 4 + rnd() * 18;
    }
    return `<svg class="su-layer su-layer-${depth}" viewBox="0 0 1600 400" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><g fill="${fill}">${rects}</g><g fill="${lit}">${windows}</g></svg>`;
  };
  return el('div', {
    class: 'su-bg',
    'aria-hidden': 'true',
    html:
      '<div class="su-sky"></div><div class="su-sun"></div><div class="su-grid"></div>' +
      layer(0, 400, 40, 190, '#18303a', '#9bd1ba') +
      layer(1, 400, 28, 250, '#10222a', '#f4d9a8') +
      layer(2, 400, 22, 150, '#0b171c', '#c7e8d8') +
      '<div class="su-haze"></div>',
  });
}

// ---- Public API -----------------------------------------------------------------------------------------

export interface SetupDeps {
  native: Native;
  shell: ShellInfo | null;
  clientId: string;
  fetchImpl?: typeof fetch;
  workflow?: WorkflowSource;
  /** App: a device session was signed in and stored; start the game with it. */
  onServerSession(session: ServerSession): void;
  /** Web: continue to the server's own cookie sign-in page. */
  onWebServer(host: string): void;
  /** Cloud: the Empire's state repository is ready. */
  onCloudCreated(repo: StateRepo): void;
}

const prefersReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const saveData = () => !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;

function relTime(iso?: string | null): string {
  if (!iso) return '';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return '';
  if (days < 1) return 'updated today';
  if (days < 31) return `updated ${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `updated ${months} month${months === 1 ? '' : 's'} ago` : `updated ${Math.floor(months / 12)} y ago`;
}

const STEP_TITLES: Record<Step, string> = {
  welcome: 'Welcome',
  mode: 'How should your Empire run?',
  server: 'Connect your server',
  github: 'Link your GitHub',
  repos: 'Choose your projects',
  providers: 'Add your AI keys',
  limits: 'Set spending limits',
  review: 'Review your Empire',
  create: 'Creating your Empire',
};

/** Mounts the setup into a fresh overlay. Returns a handle that removes it. */
export function mountSetup(initial: SetupState, deps: SetupDeps): { root: HTMLElement; leave(): Promise<void>; state(): SetupState } {
  const reduced = prefersReduced();
  const lite = saveData();
  const root = el('div', { id: 'setup', class: `su${reduced ? ' su-reduced' : ''}${lite ? ' su-lite' : ''}` });
  const live = el('p', { class: 'su-sr', 'aria-live': 'polite' });
  const rail = el('nav', { class: 'su-rail', 'aria-label': 'Setup progress' });
  const stage = el('main', { class: 'su-stage' });
  root.append(skyline(lite), el('div', { class: 'su-shell' }, rail, stage), live);
  document.body.append(root);
  trackKeyboard();
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const workflow = deps.workflow ?? pendingWorkflow;

  let state = initial;
  let busy = false;
  let shownStep: Step | null = null;
  let refresh: () => void = () => {};
  const repoCache: { login?: string; repos: RepoListing[]; page: number; more: boolean; error?: string } = { repos: [], page: 0, more: true };

  const dispatch = (a: Action) => {
    const next = reduce(state, a);
    if (next === state) return;
    state = next;
    if (state.step !== shownStep) render();
    else refresh();
  };

  // Pointer parallax on the skyline (desktop only, and not with reduced motion).
  if (!reduced && !lite && matchMedia('(pointer: fine)').matches) {
    let raf = 0;
    root.addEventListener('pointermove', (e) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        root.style.setProperty('--px', ((e.clientX / innerWidth - 0.5) * 2).toFixed(3));
        root.style.setProperty('--py', ((e.clientY / innerHeight - 0.5) * 2).toFixed(3));
      });
    });
  }
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || busy || state.step === 'welcome') return;
    if ((e.target as HTMLElement).closest('details[open]')) return;
    e.preventDefault();
    dispatch({ type: 'back' });
  });

  function renderRail() {
    rail.replaceChildren();
    rail.hidden = state.step === 'welcome';
    const brand = el('div', { class: 'su-brand' }, el('span', { class: 'su-mark', 'aria-hidden': 'true', html: TOWER }), el('span', { class: 'su-word', text: 'AGENT EMPIRE' }));
    const items = progress(state);
    const list = el('ol', { class: 'su-steps' });
    items.forEach((p, i) =>
      list.append(
        el('li', { class: `su-step is-${p.state}`, 'aria-current': p.state === 'current' ? 'step' : false },
          el('span', { class: 'su-dot', 'aria-hidden': 'true' }, p.state === 'done' ? icon(ICONS.check, 'su-dot-ico') : String(i + 1)),
          el('span', { class: 'su-step-label' }, p.label, el('span', { class: 'su-sr', text: p.state === 'done' ? ' (done)' : p.state === 'current' ? ' (current step)' : '' })),
        ),
      ),
    );
    const note =
      state.mode === 'cloud'
        ? el('p', { class: 'su-rail-note' }, icon(ICONS.lock, 'su-inline-ico'), 'Keys are encrypted on this device before they reach GitHub.')
        : state.mode === 'server'
          ? el('p', { class: 'su-rail-note' }, icon(ICONS.lock, 'su-inline-ico'), 'Your password goes only to your server.')
          : null;
    rail.append(brand, list);
    if (note) rail.append(note);
  }

  function frame(opts: { eyebrow?: string; title: string; lede?: Child; body: Node[]; primary?: HTMLButtonElement | null; secondary?: Node | null; back?: boolean; wide?: boolean; backInHead?: boolean }) {
    const heading = el('h1', { class: 'su-title', tabindex: '-1', text: opts.title });
    const backBtn = () => el('button', { type: 'button', class: 'su-btn su-ghost su-back', onclick: () => !busy && dispatch({ type: 'back' }) }, icon(ICONS.back, 'su-btn-ico'), 'Back');
    // A step whose only footer action would be Back keeps it in the header, so the content gets the height.
    const footer = opts.backInHead ? null : el('footer', { class: 'su-foot' });
    if (footer) {
      if (opts.back !== false) footer.append(backBtn());
      footer.append(el('span', { class: 'su-foot-gap' }));
      if (opts.secondary) footer.append(opts.secondary);
      if (opts.primary) footer.append(opts.primary);
    }
    const head = el('header', { class: `su-head${opts.backInHead ? ' su-head-row' : ''}` },
      el('div', { class: 'su-head-text' }, opts.eyebrow ? el('p', { class: 'su-eyebrow', text: opts.eyebrow }) : null, heading, opts.lede ? el('p', { class: 'su-lede' }, opts.lede) : null),
      opts.backInHead ? backBtn() : null);
    const panel = el('section', { class: `su-panel${opts.wide ? ' su-wide' : ''}`, 'aria-labelledby': 'su-title' }, head, el('div', { class: 'su-body' }, ...opts.body), footer);
    heading.id = 'su-title';
    return { panel, heading };
  }

  const primary = (label: string, onclick: () => void, extra: Record<string, unknown> = {}) =>
    el('button', { type: 'button', class: 'su-btn su-primary', onclick, ...extra }, el('span', { class: 'su-btn-label', text: label }), icon(ICONS.arrow, 'su-btn-ico'));
  const setBusy = (btn: HTMLButtonElement, on: boolean, label?: string) => {
    busy = on;
    btn.disabled = on;
    btn.classList.toggle('is-busy', on);
    btn.setAttribute('aria-busy', String(on));
    if (label) btn.querySelector('.su-btn-label')!.textContent = label;
  };
  const errorBox = () => el('p', { class: 'su-error', role: 'alert', hidden: true });
  const showError = (box: HTMLElement, message: string | null) => {
    box.hidden = !message;
    box.replaceChildren(...(message ? [icon(ICONS.warn, 'su-inline-ico'), message] : []));
    if (!message) return;
    requestAnimationFrame(() => box.scrollIntoView({ block: 'nearest' }));
    // On touch the on-screen keyboard is closing and WebKit restores the old scroll afterwards: show the error again.
    if (matchMedia('(pointer: coarse)').matches) setTimeout(() => box.scrollIntoView({ block: 'nearest' }), 450);
  };
  /** Keyboard users go straight back to the field; on touch the on-screen keyboard is dismissed so the error shows. */
  const focusField = (input: HTMLInputElement) => {
    if (isTouchDevice()) dismissKeyboard();
    else input.focus();
  };
  const external = (label: string, url: string) =>
    el('a', {
      class: 'su-link',
      href: url,
      target: '_blank',
      rel: 'noopener noreferrer',
      onclick: (e: Event) => {
        if (!deps.native.available) return; // a browser follows the link itself
        e.preventDefault();
        deps.native.openExternal(url).catch(() => {});
      },
    }, label, el('span', { class: 'su-sr', text: ' (opens in your browser)' }));

  function render() {
    const from = shownStep;
    shownStep = state.step;
    refresh = () => {};
    renderRail();
    const view = STEP_VIEWS[state.step]();
    const forward = from === null || order(state.step) >= order(from);
    view.panel.classList.add('su-enter', forward ? 'from-right' : 'from-left');
    // Every panel still shown leaves, not just the first child: two quick steps (Back, then a card within the
    // 260 ms transition) would otherwise leave the middle panel on screen over the new one.
    for (const old of [...stage.children] as HTMLElement[]) {
      if (old.classList.contains('su-leave')) continue;
      if (reduced) {
        old.remove();
        continue;
      }
      old.classList.add('su-leave', forward ? 'to-left' : 'to-right');
      old.setAttribute('aria-hidden', 'true');
      old.inert = true;
      setTimeout(() => old.remove(), 260);
    }
    stage.append(view.panel);
    requestAnimationFrame(() => view.panel.classList.remove('su-enter'));
    const path = progress(state);
    const at = path.findIndex((p) => p.step === state.step);
    live.textContent = at >= 0 ? `Step ${at + 1} of ${path.length}: ${STEP_TITLES[state.step]}` : STEP_TITLES[state.step];
    if (from !== null) view.heading.focus({ preventScroll: true });
    else (view.panel.querySelector<HTMLElement>('.su-primary') ?? view.heading).focus({ preventScroll: true });
  }
  const order = (s: Step) => (s === 'welcome' ? 0 : s === 'mode' ? 1 : s === 'server' ? 2 : 2 + CLOUD_STEPS.indexOf(s));

  // ---- Steps ------------------------------------------------------------------------------------------

  const STEP_VIEWS: Record<Step, () => { panel: HTMLElement; heading: HTMLElement }> = {
    welcome() {
      const letters = 'AGENT EMPIRE'.split('').map((ch, i) => el('span', { class: 'su-letter', style: `--i:${i}`, 'aria-hidden': 'true', text: ch === ' ' ? ' ' : ch }));
      const heading = el('h1', { class: 'su-hero-title', tabindex: '-1', 'aria-label': 'Agent Empire' }, ...letters);
      const start = primary('Set up my Empire', () => dispatch({ type: 'begin' }));
      const panel = el('section', { class: 'su-hero', 'aria-label': 'Welcome' },
        el('span', { class: 'su-hero-mark', 'aria-hidden': 'true', html: TOWER }),
        heading,
        el('p', { class: 'su-hero-tag', text: 'Found a company of AI agents that keeps working while you’re away.' }),
        el('div', { class: 'su-hero-actions' }, start),
        el('p', { class: 'su-hero-note', text: 'About three minutes. Nothing is charged or started during setup.' }),
      );
      return { panel, heading };
    },

    mode() {
      const card = (mode: 'cloud' | 'server', opts: { ico: string; badge: string; title: string; points: string[]; limits: Child; cta: string }) => {
        const btn = el('button', { type: 'button', class: `su-card su-card-${mode}`, 'aria-describedby': `su-card-${mode}-d`, onclick: () => dispatch({ type: 'chooseMode', mode }) },
          el('span', { class: 'su-card-top' }, icon(opts.ico, 'su-card-ico'), el('span', { class: 'su-badge', text: opts.badge })),
          el('span', { class: 'su-card-title', text: opts.title }),
          el('span', { class: 'su-card-points', id: `su-card-${mode}-d` }, ...opts.points.map((p) => el('span', { class: 'su-point' }, icon(ICONS.check, 'su-point-ico'), p)), el('span', { class: 'su-card-limits' }, opts.limits)),
          el('span', { class: 'su-card-cta' }, opts.cta, icon(ICONS.arrow, 'su-btn-ico')),
        );
        btn.addEventListener('pointermove', (e) => {
          const r = btn.getBoundingClientRect();
          btn.style.setProperty('--mx', `${e.clientX - r.left}px`);
          btn.style.setProperty('--my', `${e.clientY - r.top}px`);
        });
        return btn;
      };
      const cloud = card('cloud', {
        ico: ICONS.cloud,
        badge: 'No server needed',
        title: 'Run in the cloud with my accounts',
        points: ['Lives in a private repository in your GitHub', 'Keeps working when the app is closed', 'Uses your Claude and/or OpenAI API keys'],
        limits: [el('strong', { text: 'Limits: ' }), 'reacts in minutes, not seconds. No live terminals, tunnels or local agents; voice and screen share are limited.'].reduce((f, n) => (f.append(n), f), document.createDocumentFragment()),
        cta: 'Link my accounts',
      });
      const server = card('server', {
        ico: ICONS.server,
        badge: 'Full capabilities',
        title: 'Connect my own server',
        points: ['Live terminals, service tunnels and local agents', 'Keeps working while your server runs', 'Sign in with your office password'],
        limits: [el('strong', { text: 'Needs: ' }), 'a server you run with Agent Empire installed.'].reduce((f, n) => (f.append(n), f), document.createDocumentFragment()),
        cta: 'Connect a server',
      });
      const { panel, heading } = frame({
        eyebrow: 'Choose one · you can change it later',
        title: STEP_TITLES.mode,
        lede: 'Either way your Empire keeps working when you close the app, and reopening shows where it is now. Only “Shut down Empire” in the game stops it.',
        body: [el('div', { class: 'su-cards' }, cloud, server)],
        wide: true,
        backInHead: true,
      });
      return { panel, heading };
    },

    server() {
      const app = deps.native.available;
      const errors = errorBox();
      const address = el('input', {
        id: 'su-address', class: 'su-input', type: 'url', inputmode: 'url', autocomplete: 'url', autocapitalize: 'off', spellcheck: false,
        placeholder: 'https://city.example.com', value: state.server.address, required: true,
        oninput: () => dispatch({ type: 'setAddress', address: address.value }),
      });
      const password = el('input', { id: 'su-password', class: 'su-input', type: 'password', autocomplete: 'current-password', required: true });
      const action = primary(app ? 'Sign in' : 'Continue to sign-in', () => void submit());
      const form = el('form', { class: 'su-form', novalidate: true, onsubmit: (e: Event) => (e.preventDefault(), void submit()) },
        field('Server address', address, 'The HTTPS address of your Agent Empire server.'),
        app ? field('Office password', password, `Signs in this ${deps.shell?.platform === 'desktop' ? 'computer' : 'device'} only. The password isn’t stored; the app keeps a device sign-in in secure storage.`) : null,
        el('button', { type: 'submit', hidden: true, tabindex: '-1', 'aria-hidden': 'true' }),
      );
      if (!app) form.append(el('p', { class: 'su-note', text: 'Your server’s own sign-in page opens next. This browser page doesn’t see your password.' }));
      async function submit() {
        if (busy) return;
        const androidEmulator = deps.shell?.platform === 'android';
        const parsed = parseServerAddress(address.value, { androidEmulator });
        if (!parsed.ok) {
          showError(errors, new LoginFailure(parsed.error).message);
          focusField(address);
          return;
        }
        showError(errors, null);
        if (!app) {
          try {
            await deps.native.secureSet('server.host', parsed.host);
            await deps.native.secureSet('mode', 'server');
          } catch {}
          deps.onWebServer(parsed.host);
          return;
        }
        if (!password.value) {
          showError(errors, new LoginFailure('empty_password').message);
          focusField(password);
          return;
        }
        setBusy(action, true, 'Checking the server…');
        let session: ServerSession;
        try {
          session = await signInToServer({ host: parsed.host, password: password.value, deviceName: deps.shell?.deviceName ?? defaultDeviceName(deps.shell?.platform ?? null, navigator.userAgent), androidEmulator }, fetchImpl);
        } catch (err) {
          setBusy(action, false, 'Sign in');
          showError(errors, err instanceof LoginFailure ? err.message : 'Couldn’t sign in. Try again.');
          const wrong = err instanceof LoginFailure && err.code === 'wrong_password';
          if (wrong) password.value = '';
          focusField(wrong ? password : address);
          return;
        }
        password.value = '';
        setBusy(action, true, 'Saving sign-in…');
        try {
          await deps.native.secureSet('server.host', session.host);
          await deps.native.secureSet('server.token', session.token);
          await deps.native.secureSet('server.deviceId', session.deviceId);
          await deps.native.secureSet('mode', 'server');
        } catch {
          await Promise.allSettled([deps.native.secureDelete('server.token'), deps.native.secureDelete('server.deviceId'), revokeDevice(session, fetchImpl)]);
          setBusy(action, false, 'Sign in');
          showError(errors, 'Signed in, but this device couldn’t store the sign-in securely, so it was removed again. Nothing was saved insecurely.');
          return;
        }
        // The game takes over: close the on-screen keyboard so it doesn't stay up over the loading screen.
        dismissKeyboard();
        action.querySelector('.su-btn-label')!.textContent = 'Connected';
        action.classList.add('is-done');
        live.textContent = `Connected to ${session.host}. Opening your Empire.`;
        deps.onServerSession(session);
      }
      const needs = el('details', { class: 'su-details' },
        el('summary', { text: 'What you need' }),
        el('ol', { class: 'su-howto' },
          el('li', { text: 'A Linux server with Docker, Git and an HTTPS domain. 4 vCPUs and 8 GiB RAM is a good start.' }),
          el('li', { text: 'From the Agent Empire source, run the recipe in deploy/cloud: docker compose build, then up -d, with a strong office password.' }),
          el('li', { text: 'Put it behind HTTPS (deploy/cloud/Caddyfile.example). Never expose the plain HTTP port.' }),
          el('li', { text: 'Enter its address and office password here.' }),
        ),
      );
      const { panel, heading } = frame({
        eyebrow: 'Connect my own server',
        title: STEP_TITLES.server,
        lede: state.notice ? el('span', { class: 'su-notice', role: 'status' }, state.notice) : 'Full capabilities: live terminals, service tunnels and local agents, running on hardware you control.',
        body: [errors, form, needs],
        primary: action,
      });
      return { panel, heading };
    },

    github() {
      const errors = errorBox();
      const deviceFlowReady = deps.native.available && !!deps.clientId;
      const body: Node[] = [];
      let primaryBtn: HTMLButtonElement | null = null;

      if (state.github.login) {
        body.push(
          el('div', { class: 'su-linked', role: 'status' },
            el('span', { class: 'su-avatar', 'aria-hidden': 'true', text: state.github.login.slice(0, 1).toUpperCase() }),
            el('span', { class: 'su-linked-text' }, el('strong', { text: `@${state.github.login}` }), el('span', { text: state.github.via === 'device' ? 'Linked with GitHub sign-in' : 'Linked with a token' })),
            el('button', { type: 'button', class: 'su-btn su-ghost su-small', onclick: () => void unlink() }, 'Use another account'),
          ),
          el('p', { class: 'su-note', text: `Your Empire’s home will be the private repository ${state.github.login}/${STATE_REPO_NAME}.` }),
        );
        primaryBtn = primary('Choose projects', () => dispatch({ type: 'next' }));
      } else if (deviceFlowReady) {
        const signIn = el('button', { type: 'button', class: 'su-btn su-primary su-gh', onclick: () => void deviceFlow(signIn) }, icon(ICONS.github, 'su-btn-ico'), el('span', { class: 'su-btn-label', text: 'Sign in with GitHub' }));
        body.push(
          el('div', { class: 'su-gh-block' }, signIn,
            el('p', { class: 'su-note', text: 'The app shows a short code. Enter it on GitHub in your browser, approve Agent Empire, then come back here.' })),
          permissionsNote(),
          tokenFallback(errors, true),
        );
      } else {
        body.push(
          el('div', { class: 'su-callout' }, icon(ICONS.warn, 'su-inline-ico'),
            el('span', {}, deps.native.available ? el('strong', { text: 'GitHub sign-in isn’t configured in this build yet. ' }) : el('strong', { text: 'In a browser, link GitHub with a token. ' }),
              deps.native.available ? 'You can link GitHub with a personal access token instead.' : 'GitHub’s sign-in service can’t be used from a web page; the Agent Empire app offers one-tap sign-in.')),
          tokenFallback(errors, false),
        );
      }
      body.unshift(errors); // first, so it's visible without scrolling on a landscape phone

      async function unlink() {
        await Promise.allSettled([deps.native.secureDelete('github.token'), deps.native.secureDelete('github.login')]);
        dispatch({ type: 'githubUnlinked' });
        render();
      }
      async function linked(token: string, via: 'device' | 'token') {
        const user = await new GitHubClient(token, fetchImpl).user();
        let stored = true;
        try {
          await deps.native.secureSet('github.token', token);
          await deps.native.secureSet('github.login', user.login);
        } catch {
          stored = false;
        }
        dispatch({ type: 'githubLinked', login: user.login, token, via });
        if (!stored) live.textContent = 'Linked. This browser keeps the GitHub token only until the page closes.';
        render();
      }
      async function deviceFlow(btn: HTMLButtonElement) {
        if (busy) return;
        showError(errors, null);
        setBusy(btn, true, 'Waiting for GitHub…');
        try {
          const r = await deps.native.githubDeviceFlow({ clientId: deps.clientId, scopes: GITHUB_SCOPES });
          await linked(r.token, 'device');
          busy = false;
        } catch (err) {
          setBusy(btn, false, 'Sign in with GitHub');
          const msg = err instanceof GitHubError || err instanceof BridgeError ? err.message : 'GitHub sign-in didn’t finish.';
          showError(errors, /cancel/i.test(msg) ? 'GitHub sign-in was cancelled.' : msg);
        }
      }
      function tokenFallback(box: HTMLElement, collapsed: boolean): Node {
        const input = el('input', { id: 'su-gh-token', class: 'su-input su-mono', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, placeholder: 'github_pat_…' });
        const check = el('button', { type: 'submit', class: `su-btn ${collapsed ? 'su-ghost' : 'su-primary'}` }, el('span', { class: 'su-btn-label', text: 'Check token' }));
        if (!collapsed) primaryBtn = null;
        const form = el('form', {
          class: 'su-form',
          novalidate: true,
          onsubmit: async (e: Event) => {
            e.preventDefault();
            if (busy) return;
            const token = input.value.trim();
            if (!token) return showError(box, 'Paste a GitHub token first.'), focusField(input);
            showError(box, null);
            setBusy(check, true, 'Checking…');
            try {
              await linked(token, 'token');
              busy = false;
            } catch (err) {
              setBusy(check, false, 'Check token');
              showError(box, err instanceof GitHubError ? err.message : 'That token didn’t work.');
            }
          },
        },
          el('ol', { class: 'su-howto' },
            el('li', {}, external('Create a private repository named agent-empire-state', GITHUB_NEW_STATE_REPO_URL), ' in your account (your Empire’s home). Creating it yourself means the token needs no Administration permission.'),
            el('li', {}, external('Create a fine-grained token', GITHUB_TOKEN_URL), '. Expiration: 30 days or less (link again when it expires). Repository access: Only select repositories, that is agent-empire-state and the projects you want to use.'),
            el('li', { text: 'Repository permissions, Read and write: Contents, Secrets, Workflows, Actions and Pull requests. Metadata: Read. Nothing else.' }),
            el('li', { text: 'Paste it here.' }),
          ),
          el('div', { class: 'su-row' }, field('GitHub token', input), check),
          el('p', { class: 'su-note', text: deps.native.available ? 'The token is kept in this device’s secure storage.' : 'This browser keeps the token in memory only, until the page closes.' }),
        );
        return collapsed ? el('details', { class: 'su-details' }, el('summary', { text: 'Use a token instead' }), form) : form;
      }
      const { panel, heading } = frame({
        eyebrow: 'Cloud · step 1',
        title: STEP_TITLES.github,
        lede: 'Your Empire lives in a private repository in your GitHub account and runs there on a schedule. Agent Empire runs no servers and never sees your keys.',
        body,
        primary: primaryBtn,
      });
      return { panel, heading };
    },

    repos() {
      const list = el('ul', { class: 'su-repos', 'aria-label': 'Your repositories' });
      const status = el('p', { class: 'su-note', role: 'status' });
      const errors = errorBox();
      const search = el('input', { class: 'su-input', type: 'search', placeholder: 'Filter repositories', 'aria-label': 'Filter repositories', autocomplete: 'off', oninput: () => draw() });
      const more = el('button', { type: 'button', class: 'su-btn su-ghost su-small', hidden: true, onclick: () => void load() }, 'Load more');
      const count = el('span', { class: 'su-chip', 'aria-live': 'polite' });
      const next = primary('Add AI keys', () => dispatch({ type: 'next' }));
      if (repoCache.login !== state.github.login) Object.assign(repoCache, { login: state.github.login, repos: [], page: 0, more: true, error: undefined });

      function draw() {
        const q = search.value.trim().toLowerCase();
        const chosen = new Set(state.repos.map(repoKey));
        const shown = repoCache.repos.filter((r) => r.name.toLowerCase() !== STATE_REPO_NAME && (!q || `${r.owner}/${r.name}`.toLowerCase().includes(q)));
        list.replaceChildren(
          ...shown.map((r) => {
            const id = `su-r-${repoKey(r).replace(/[^a-z0-9]/g, '-')}`;
            const box = el('input', {
              type: 'checkbox', id, class: 'su-check', checked: chosen.has(repoKey(r)), disabled: !r.canPush || (!chosen.has(repoKey(r)) && chosen.size >= MAX_REPOS),
              onchange: () => dispatch({ type: 'toggleRepo', repo: { owner: r.owner, name: r.name, private: r.private, defaultBranch: r.defaultBranch } }),
            });
            return el('li', { class: `su-repo${chosen.has(repoKey(r)) ? ' is-on' : ''}${r.canPush ? '' : ' is-off'}` },
              box,
              el('label', { for: id },
                el('span', { class: 'su-repo-name' }, el('span', { class: 'su-repo-owner', text: `${r.owner}/` }), r.name, r.private ? icon(ICONS.lock, 'su-inline-ico su-lock') : null, el('span', { class: 'su-sr', text: r.private ? ' (private)' : ' (public)' })),
                el('span', { class: 'su-repo-meta', text: [r.canPush ? '' : 'read-only: agents can’t open pull requests here', r.description ?? '', relTime(r.pushedAt)].filter(Boolean).join(' · ') }),
              ),
            );
          }),
        );
        if (!shown.length && repoCache.repos.length) list.append(el('li', { class: 'su-empty', text: 'No repository matches that filter.' }));
        count.textContent = `${state.repos.length} selected`;
        more.hidden = !repoCache.more || busy;
        next.disabled = blockers(state).length > 0;
      }
      refresh = draw;
      async function load() {
        if (busy || !state.github.token) return;
        busy = true;
        showError(errors, null);
        status.textContent = repoCache.repos.length ? 'Loading more…' : 'Loading your repositories…';
        more.hidden = true;
        try {
          const page = await new GitHubClient(state.github.token, fetchImpl).listRepos(repoCache.page + 1);
          const seen = new Set(repoCache.repos.map(repoKey));
          repoCache.repos.push(...page.repos.filter((r) => !seen.has(repoKey(r))));
          repoCache.page += 1;
          repoCache.more = page.more;
          status.textContent = repoCache.repos.length ? `${repoCache.repos.length} repositories. Agents work on branches and open pull requests; nothing goes straight to your default branch.` : 'This account has no repositories yet. Create one on GitHub, then come back.';
        } catch (err) {
          status.textContent = '';
          showError(errors, err instanceof GitHubError ? err.message : 'Couldn’t load your repositories.');
          more.hidden = false;
          more.textContent = 'Try again';
        } finally {
          busy = false;
          draw();
        }
      }
      const { panel, heading } = frame({
        eyebrow: 'Cloud · step 2',
        title: STEP_TITLES.repos,
        lede: 'Pick the repositories your agents may work on. Only these are used, and only through branches and pull requests.',
        body: [el('div', { class: 'su-row su-repo-tools' }, search, count), list, status, more, errors],
        primary: next,
      });
      draw();
      if (!repoCache.repos.length) void load();
      return { panel, heading };
    },

    providers() {
      const next = primary('Set limits', () => dispatch({ type: 'next' }));
      const errs: Partial<Record<ProviderId, HTMLElement>> = {};
      const rows = (Object.keys(PROVIDER_NAMES) as ProviderId[]).map((id) => {
        const input = el('input', {
          id: `su-key-${id}`, class: 'su-input su-mono', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
          placeholder: id === 'anthropic' ? 'sk-ant-…' : 'sk-…', value: state.providers[id],
          oninput: () => dispatch({ type: 'setProvider', id, value: input.value }),
        });
        const reveal = el('button', {
          type: 'button', class: 'su-btn su-ghost su-small', 'aria-pressed': 'false', 'aria-controls': input.id,
          onclick: () => {
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            reveal.setAttribute('aria-pressed', String(show));
            reveal.textContent = show ? 'Hide' : 'Show';
          },
        }, 'Show');
        errs[id] = el('p', { class: 'su-field-error', id: `su-key-${id}-e`, 'aria-live': 'polite' });
        input.setAttribute('aria-describedby', errs[id]!.id);
        return el('div', { class: 'su-provider' },
          el('div', { class: 'su-provider-head' }, icon(ICONS.key, 'su-inline-ico'), el('label', { for: input.id, text: PROVIDER_NAMES[id] }), external('Get a key', PROVIDER_KEY_URLS[id])),
          el('div', { class: 'su-row' }, input, reveal),
          errs[id]!,
        );
      });
      refresh = () => {
        for (const id of Object.keys(errs) as ProviderId[]) errs[id]!.textContent = validateProviderKey(id, state.providers[id]) ?? '';
        next.disabled = blockers(state).length > 0;
      };
      const { panel, heading } = frame({
        eyebrow: 'Cloud · step 3',
        title: STEP_TITLES.providers,
        lede: 'Add at least one. Agents run in the provider’s cloud and bill your provider account.',
        body: [
          ...rows,
          el('div', { class: 'su-callout su-callout-info' }, icon(ICONS.spark, 'su-inline-ico'),
            el('span', {}, el('strong', { text: 'API keys aren’t your Claude or ChatGPT subscription. ' }), 'Subscriptions can’t be linked to other apps; there is no sign-in for that. API usage is billed separately by Anthropic or OpenAI.')),
          el('p', { class: 'su-note' }, icon(ICONS.lock, 'su-inline-ico'), 'Each key is encrypted on this device to your state repository’s public key and stored as a GitHub Actions secret. The app doesn’t keep it and it never passes through Agent Empire.'),
        ],
        primary: next,
      });
      refresh();
      return { panel, heading };
    },

    limits() {
      const next = primary('Review', () => dispatch({ type: 'next' }));
      const errors = el('ul', { class: 'su-error-list', 'aria-live': 'polite' });
      const n = el('output', { class: 'su-stepper-value', 'aria-live': 'polite', text: String(state.limits.maxConcurrent) });
      const step = (d: number) => dispatch({ type: 'setLimits', patch: { maxConcurrent: state.limits.maxConcurrent + d } });
      const stepper = el('div', { class: 'su-stepper', role: 'group', 'aria-labelledby': 'su-conc-l' },
        el('button', { type: 'button', class: 'su-btn su-ghost su-round', 'aria-label': 'Fewer jobs at once', onclick: () => step(-1) }, '−'), n,
        el('button', { type: 'button', class: 'su-btn su-ghost su-round', 'aria-label': 'More jobs at once', onclick: () => step(1) }, '+'));
      const money = (key: 'perJob' | 'daily', label: string, hint: string) => {
        const input = el('input', { id: `su-${key}`, class: 'su-input su-money', inputmode: 'decimal', autocomplete: 'off', value: state.limits[key], oninput: () => dispatch({ type: 'setLimits', patch: { [key]: input.value } }) });
        return field(label, el('span', { class: 'su-money-wrap' }, el('span', { class: 'su-money-sign', 'aria-hidden': 'true', text: '$' }), input), hint);
      };
      const approve = el('input', { type: 'checkbox', id: 'su-approve', class: 'su-switch', role: 'switch', checked: state.limits.approveEachJob, onchange: () => dispatch({ type: 'setLimits', patch: { approveEachJob: approve.checked } }) });
      refresh = () => {
        n.textContent = String(state.limits.maxConcurrent);
        const list = blockers(state);
        errors.replaceChildren(...list.map((t) => el('li', { text: t })));
        next.disabled = list.length > 0;
      };
      const { panel, heading } = frame({
        eyebrow: 'Cloud · step 4',
        title: STEP_TITLES.limits,
        lede: 'Your coordinator checks these before it starts any job. Setup itself starts nothing.',
        body: [
          el('div', { class: 'su-limits' },
            el('div', { class: 'su-field' }, el('span', { class: 'su-label', id: 'su-conc-l', text: 'Jobs at once' }), stepper, el('span', { class: 'su-hint', text: `1 to ${LIMIT_BOUNDS.maxConcurrent}` })),
            money('perJob', 'Allowance per job', `Default ${'$' + DEFAULT_LIMITS.perJob}`),
            money('daily', 'Daily allowance', 'Across all jobs, per UTC day'),
          ),
          el('label', { class: 'su-toggle', for: 'su-approve' }, approve, el('span', { class: 'su-toggle-text' }, el('strong', { text: 'Ask me before each job starts' }), el('span', { text: 'Recommended. Changes always arrive as pull requests for you to review.' }))),
          errors,
          el('p', { class: 'su-note', text: 'Provider usage is measured between requests, so a job can overshoot its allowance slightly. Also set a monthly limit in your provider’s console.' }),
        ],
        primary: next,
      });
      refresh();
      return { panel, heading };
    },

    review() {
      const s = state;
      const create = primary('Create my Empire', () => dispatch({ type: 'next' }));
      const accept = el('input', { type: 'checkbox', id: 'su-accept', class: 'su-check', checked: s.acceptedCosts, onchange: () => dispatch({ type: 'acceptCosts', value: accept.checked }) });
      refresh = () => (create.disabled = blockers(state).length > 0);
      const per = parseCents(s.limits.perJob);
      const day = parseCents(s.limits.daily);
      const row = (label: string, ...value: Child[]) => el('div', { class: 'su-review-row' }, el('dt', { text: label }), el('dd', {}, ...value));
      const { panel, heading } = frame({
        eyebrow: 'Cloud · step 5',
        title: STEP_TITLES.review,
        lede: 'Nothing has been created yet. Check everything, then create your Empire.',
        body: [
          el('dl', { class: 'su-review' },
            row('Home', el('span', { class: 'su-mono', text: `${s.github.login}/${STATE_REPO_NAME}` }), el('span', { class: 'su-chip', text: 'private' })),
            row('Projects', s.repos.map((r) => `${r.owner}/${r.name}`).join(', ')),
            row('AI providers', linkedProviders(s.providers).map((id) => PROVIDER_NAMES[id]).join(' and ') + ' · key encrypted, never shown again'),
            row('Limits', `${s.limits.maxConcurrent} job${s.limits.maxConcurrent === 1 ? '' : 's'} at once · ${per === null ? '?' : dollars(per)} per job · ${day === null ? '?' : dollars(day)} per day${s.limits.approveEachJob ? ' · you approve each job' : ''}`),
            row('App closed', 'Your Empire keeps working. It checks for work every 5–15 minutes in GitHub Actions. Only “Shut down Empire” in the game stops it.'),
            row('Costs', 'GitHub Actions minutes are billed to your GitHub account; API usage to your AI provider. Agent Empire charges nothing.'),
          ),
          el('label', { class: 'su-accept', for: 'su-accept' }, accept, el('span', { text: 'I understand these costs are billed to my own GitHub and AI provider accounts.' })),
        ],
        primary: create,
      });
      refresh();
      return { panel, heading };
    },

    create() {
      const items = new Map<CreateStep, HTMLElement>();
      const list = el('ol', { class: 'su-progress' }, ...CREATE_STEPS.map((c) => {
        const li = el('li', { class: 'su-prog is-waiting' }, el('span', { class: 'su-prog-dot', 'aria-hidden': 'true' }), el('span', { text: c.label }), el('span', { class: 'su-sr su-prog-state', text: ' — waiting' }));
        items.set(c.step, li);
        return li;
      }));
      const result = el('div', { class: 'su-result', role: 'status' });
      const retry = primary('Try again', () => void run());
      retry.hidden = true;
      const other = el('button', { type: 'button', class: 'su-btn su-ghost', hidden: true, onclick: () => !busy && dispatch({ type: 'changeMode' }) }, 'Choose another way');
      const mark = (step: CreateStep, s: 'running' | 'done' | 'failed') => {
        const li = items.get(step)!;
        li.className = `su-prog is-${s}`;
        li.querySelector('.su-prog-state')!.textContent = ` — ${s === 'running' ? 'in progress' : s}`;
      };
      async function run() {
        if (busy || !state.github.token || !state.github.login) return;
        busy = true;
        retry.hidden = true;
        other.hidden = true;
        result.replaceChildren();
        const gh = new GitHubClient(state.github.token, fetchImpl);
        try {
          const repo = await createEmpire(
            { login: state.github.login, projects: state.repos, providers: state.providers, limits: state.limits, platform: deps.shell?.platform ?? 'web' },
            githubCloudSetup(gh, sodiumSealer, workflow),
            readiness(sodiumSealer, workflow),
            (step, s) => mark(step, s),
          );
          dispatch({ type: 'forgetSecrets' });
          await Promise.allSettled([deps.native.secureSet('state.repo', `${repo.owner}/${repo.name}`), deps.native.secureSet('mode', 'cloud')]);
          result.replaceChildren(el('p', { class: 'su-success' }, icon(ICONS.check, 'su-inline-ico'), `Your Empire has a home: ${repo.owner}/${repo.name}.`));
          busy = false;
          setTimeout(() => deps.onCloudCreated(repo), reduced ? 0 : 900);
        } catch (err) {
          busy = false;
          const e = err instanceof CloudSetupError ? err : new CloudSetupError('Something went wrong.', 'github');
          if (e.step) mark(e.step, 'failed');
          result.replaceChildren(el('p', { class: 'su-error', role: 'alert' }, icon(ICONS.warn, 'su-inline-ico'), e.message));
          if (e.reasons.length) result.append(el('ul', { class: 'su-error-list' }, ...e.reasons.map((r) => el('li', { text: r }))));
          if (e.code === 'not_ready') result.append(el('p', { class: 'su-note', text: 'Your answers are kept on this screen. Your API keys stay in memory only and are forgotten when you leave setup.' }));
          retry.hidden = e.code === 'not_ready';
          other.hidden = false;
        }
      }
      const { panel, heading } = frame({
        eyebrow: 'Cloud · step 6',
        title: STEP_TITLES.create,
        lede: `Setting up ${state.github.login}/${STATE_REPO_NAME} in your GitHub.`,
        body: [list, result],
        primary: retry,
        secondary: other,
      });
      queueMicrotask(() => void run());
      return { panel, heading };
    },
  };

  function field(label: string, control: HTMLElement, hint?: string) {
    const input = control.matches('input') ? control : control.querySelector('input');
    const hintEl = hint ? el('span', { class: 'su-hint', id: `${input?.id || 'x'}-h`, text: hint }) : null;
    if (input && hintEl) input.setAttribute('aria-describedby', hintEl.id);
    return el('div', { class: 'su-field' }, el('label', { class: 'su-label', for: input?.id, text: label }), control, hintEl);
  }

  function permissionsNote() {
    return el('p', { class: 'su-note' }, icon(ICONS.lock, 'su-inline-ico'), 'Agent Empire asks for repository and workflow access so it can create your private state repository, store encrypted secrets and install its coordinator. Changes to your projects arrive as pull requests.');
  }

  render();
  return {
    root,
    state: () => state,
    leave: () =>
      new Promise<void>((resolve) => {
        root.classList.add('su-out');
        setTimeout(() => {
          root.remove();
          resolve();
        }, reduced ? 0 : 450);
      }),
  };
}

/** Cloud mode is set up, but the cloud view (CLOUD-04) is not built yet: say so plainly. */
export function mountCloudPending(opts: { repo?: string; native: Native; onChangeSetup(): void }): HTMLElement {
  const reduced = prefersReduced();
  const root = el('div', { id: 'setup', class: `su${reduced ? ' su-reduced' : ''}${saveData() ? ' su-lite' : ''}` });
  const repoUrl = opts.repo && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(opts.repo) ? `https://github.com/${opts.repo}` : null;
  const change = el('button', {
    type: 'button', class: 'su-btn su-ghost',
    onclick: () => {
      if (!confirm('Change setup? This forgets the cloud setup on this device. Your state repository on GitHub is not changed or deleted.')) return;
      opts.onChangeSetup();
    },
  }, 'Change setup');
  const heading = el('h1', { class: 'su-title', tabindex: '-1', text: 'Your Empire is being set up' });
  root.append(
    skyline(saveData()),
    el('div', { class: 'su-shell su-shell-center' },
      el('section', { class: 'su-panel su-pending', 'aria-labelledby': 'su-title' },
        el('header', { class: 'su-head' }, el('p', { class: 'su-eyebrow', text: 'Cloud mode' }), heading),
        el('div', { class: 'su-body' },
          el('p', { class: 'su-lede', text: 'Cloud view coming in the next update. Your Empire’s home is in your GitHub; this app can’t show the city from it yet, so it shows nothing rather than pretend.' }),
          opts.repo ? el('p', { class: 'su-note' }, 'State repository: ', el('span', { class: 'su-mono', text: opts.repo })) : null,
        ),
        el('footer', { class: 'su-foot' }, change, el('span', { class: 'su-foot-gap' }),
          repoUrl
            ? el('button', { type: 'button', class: 'su-btn su-primary', onclick: () => (opts.native.available ? void opts.native.openExternal(repoUrl).catch(() => {}) : void window.open(repoUrl, '_blank', 'noopener,noreferrer')) }, 'Open on GitHub')
            : null),
      ),
    ),
  );
  heading.id = 'su-title';
  document.body.append(root);
  heading.focus({ preventScroll: true });
  return root;
}

const TOWER =
  '<svg viewBox="120 70 272 300"><rect x="250" y="78" width="12" height="40" rx="3" fill="#c7d6db"/><rect x="140" y="226" width="62" height="142" rx="5" fill="#7f999e"/><rect x="310" y="258" width="62" height="110" rx="5" fill="#7f999e"/><rect x="194" y="112" width="124" height="256" rx="7" fill="#c7d6db"/><g fill="#15232a"><rect x="212" y="136" width="24" height="16" rx="2"/><rect x="244" y="136" width="24" height="16" rx="2"/><rect x="276" y="136" width="24" height="16" rx="2"/><rect x="212" y="168" width="24" height="16" rx="2"/><rect x="276" y="168" width="24" height="16" rx="2"/><rect x="212" y="200" width="24" height="16" rx="2"/><rect x="244" y="200" width="24" height="16" rx="2"/><rect x="244" y="232" width="24" height="16" rx="2"/><rect x="276" y="232" width="24" height="16" rx="2"/><rect x="212" y="264" width="24" height="16" rx="2"/><rect x="276" y="264" width="24" height="16" rx="2"/><rect x="238" y="316" width="36" height="52" rx="3"/></g><g fill="#9bd1ba"><rect class="su-lit" x="244" y="168" width="24" height="16" rx="2"/><rect class="su-lit" x="276" y="200" width="24" height="16" rx="2"/><rect class="su-lit" x="212" y="232" width="24" height="16" rx="2"/><rect class="su-lit" x="244" y="264" width="24" height="16" rx="2"/></g></svg>';
