/**
 * FREE-06 client: the Settings "Products" panel (one repository per product) and the product chooser used by the hire
 * dialog. Linking and creating are explicit actions; creating a GitHub repository asks for the typed name first.
 */
import { apiFetch } from '../endpoint';
import { h, openModal, toast } from './dom';
import { confirmDialog } from './prompt';
import { OFFICE_PRODUCT_ID, validRepoName, type ProductInfo, type ProductsState } from '../../shared/products';

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await apiFetch(path, { method, cache: 'no-store', credentials: 'same-origin', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json as T;
}

export const productsApi = {
  state: () => call<ProductsState>('/api/products'),
  link: (body: { name: string; client?: string; path: string }) => call<{ product: ProductInfo; state: ProductsState }>('/api/products/link', 'POST', body),
  create: (body: { name: string; client?: string; repo: string; confirm: string; public?: boolean }) => call<{ product: ProductInfo; state: ProductsState }>('/api/products/create', 'POST', body),
  update: (id: string, body: { maxWorkers?: number | null }) => call<{ state: ProductsState }>(`/api/products/${encodeURIComponent(id)}`, 'PUT', body),
  unlink: (id: string) => call<{ state: ProductsState }>(`/api/products/${encodeURIComponent(id)}`, 'DELETE'),
};

const when = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function productCard(p: ProductInfo, onChange: (s: ProductsState) => void): HTMLElement {
  const tone = p.present ? 'good' : 'bad';
  const where = p.origin === 'office' ? 'Default · this office’s repository' : p.origin === 'created' ? `Created on GitHub${p.private === false ? ' · public' : ' · private'}` : 'Linked local repository';
  const facts = [p.github ? `GitHub ${p.github}` : 'No GitHub remote', p.defaultBranch ? `🌿 ${p.defaultBranch}` : null, `${p.workers} worker${p.workers === 1 ? '' : 's'}`, `${p.openTasks} unfinished task${p.openTasks === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  const actions: HTMLElement[] = [];
  if (p.origin !== 'office') {
    const cap = h('input', { type: 'number', min: 0, max: 64, value: p.maxWorkers ?? 0, 'aria-label': `Worker cap for ${p.name} (0 = none)`, style: 'width:4.5em' }) as HTMLInputElement;
    cap.addEventListener('change', () => {
      const n = Math.max(0, Math.min(64, Math.floor(Number(cap.value) || 0)));
      productsApi.update(p.id, { maxWorkers: n || null }).then((r) => { onChange(r.state); toast(n ? `${p.name}: at most ${n} queue worker${n === 1 ? '' : 's'} at once` : `${p.name}: no product cap (queue limit applies)`, 'info'); }, (e) => toast(e.message, 'warn'));
    });
    actions.push(h('label.product-cap', {}, 'Worker cap ', cap));
    actions.push(h('button.btn', {
      type: 'button', 'data-key': 'unlink',
      onclick: () => confirmDialog(`Unlink ${p.name}?`, `The office forgets this product. Its folder (${p.dir})${p.github ? ` and the GitHub repository ${p.github}` : ''} are not deleted.`, 'Unlink', () => {
        productsApi.unlink(p.id).then((r) => { onChange(r.state); toast(`Unlinked ${p.name}`, 'info'); }, (e) => toast(e.message, 'warn'));
      }),
    }, 'Unlink'));
  }
  return h('article.status-card.product-card', { 'data-tone': tone, 'data-product': p.id },
    h('span.empire-eyebrow', {}, where),
    h('strong', {}, h('span.status-dot', { 'aria-hidden': 'true' }), p.name, p.client ? h('small', {}, ` · ${p.client}`) : null),
    h('p', {}, facts),
    h('p.setting-note.product-dir', { title: p.dir }, p.present ? `📁 ${p.dir}` : `Folder missing or not a git repository: ${p.dir}`),
    actions.length ? h('div.sector-actions', {}, ...actions) : null);
}

function linkForm(onDone: (s: ProductsState) => void): HTMLElement {
  const name = h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'e.g. Northstar booking app', 'aria-label': 'Product name' }) as HTMLInputElement;
  const client = h('input', { name: 'client', maxlength: 160, placeholder: 'Client (optional)', 'aria-label': 'Client' }) as HTMLInputElement;
  const dir = h('input', { name: 'path', required: true, placeholder: '/absolute/path/to/repo on the office host', 'aria-label': 'Repository folder on the office host' }) as HTMLInputElement;
  const submit = h('button.btn', { type: 'submit' }, '🔗 Link repository');
  const form = h('form.product-form', { 'aria-label': 'Link a local repository' }, h('h4', {}, 'Link an existing local repository or clone'), name, client, dir,
    h('p.setting-note', {}, 'Nothing outside this office host changes. Workers for this product get their own worktrees inside it.'), submit) as HTMLFormElement;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    productsApi.link({ name: name.value.trim(), path: dir.value.trim(), ...(client.value.trim() ? { client: client.value.trim() } : {}) })
      .then((r) => { form.reset(); onDone(r.state); }, (err) => toast(err.message, 'warn'));
  });
  return form;
}

function createForm(state: ProductsState, onDone: (s: ProductsState) => void): HTMLElement {
  const name = h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'e.g. Harbour Dental site', 'aria-label': 'New product name' }) as HTMLInputElement;
  const client = h('input', { name: 'client', maxlength: 160, placeholder: 'Client (optional)', 'aria-label': 'Client for the new product' }) as HTMLInputElement;
  const repo = h('input', { name: 'repo', required: true, maxlength: 201, placeholder: 'repo-name or org/repo-name', 'aria-label': 'GitHub repository name' }) as HTMLInputElement;
  const pub = h('input', { type: 'checkbox', name: 'public', id: 'product-public' }) as HTMLInputElement;
  const c = state.creation;
  const throttle = c.nextAllowedAt ? `Next creation allowed at ${when(c.nextAllowedAt)}.` : 'A creation is allowed now.';
  const submit = h('button.btn.primary', { type: 'submit', disabled: c.inFlight }, '＋ Create on GitHub…');
  const form = h('form.product-form', { 'aria-label': 'Create a GitHub repository' }, h('h4', {}, 'Create a new GitHub repository'), name, client, repo,
    h('label.product-public', { for: 'product-public' }, pub, ' Public (default: private)'),
    h('p.setting-note.product-throttle', {}, `Uses the GitHub CLI already signed in on the office host; no new credentials are asked for or stored. Throttled for GitHub’s limits: ${c.usedThisHour}/${c.perHour} this hour, at least a minute apart. ${throttle} Cloned into ${state.productsDir}.`),
    submit) as HTMLFormElement;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const r = repo.value.trim();
    if (!validRepoName(r)) { toast('Use letters, digits, dot, dash or underscore (optionally org/name).', 'warn'); repo.focus(); return; }
    confirmCreate(r, pub.checked, () => {
      submit.setAttribute('disabled', '');
      productsApi.create({ name: name.value.trim(), repo: r, confirm: r, public: pub.checked, ...(client.value.trim() ? { client: client.value.trim() } : {}) })
        .then((res) => { form.reset(); onDone(res.state); }, (err) => { submit.removeAttribute('disabled'); toast(err.message, 'warn'); });
    });
  });
  return form;
}

/** Outward-facing: the CEO types the repository name to confirm before anything is created on GitHub. */
function confirmCreate(repo: string, isPublic: boolean, onConfirm: () => void) {
  const typed = h('input', { 'aria-label': 'Type the repository name to confirm', placeholder: repo, autocomplete: 'off' }) as HTMLInputElement;
  const yes = h('button.btn.danger', { type: 'button', disabled: true }, 'Create repository');
  const no = h('button.btn', { type: 'button' }, 'Never mind');
  const el = h('div.modal.ae-dark.product-confirm', { role: 'alertdialog', 'aria-label': 'Create a GitHub repository' },
    h('header', {}, h('h2', {}, 'Create a repository on GitHub?')),
    h('div.body', {},
      h('p', { style: 'margin:0 0 10px;font-weight:700' }, `This creates ${isPublic ? 'a PUBLIC' : 'a private'} repository “${repo}” in your GitHub account with the office’s gh sign-in, and clones it on the office host. It counts toward the hourly creation limit.`),
      h('label', {}, `Type ${repo} to confirm`, typed)),
    h('footer', {}, no, yes));
  const modal = openModal(el);
  typed.addEventListener('input', () => { (yes as HTMLButtonElement).disabled = typed.value.trim() !== repo; });
  no.addEventListener('click', () => modal.close());
  yes.addEventListener('click', () => { if (typed.value.trim() !== repo) return; modal.close(); onConfirm(); });
  setTimeout(() => typed.focus(), 30);
}

export function productsSection() {
  const status = h('p.setting-note', {}, 'Loading products…');
  const list = h('div.status-grid.products-list');
  const forms = h('div.product-forms');
  let disposed = false;
  const paint = (s: ProductsState) => {
    if (disposed) return;
    status.textContent = s.storageError ?? `${s.products.length} product${s.products.length === 1 ? '' : 's'}. Each runs in its own repository; workers for one product never get another’s folder (separate working directories on this host, not a sandbox).`;
    list.replaceChildren(...s.products.map((p) => productCard(p, paint)));
    forms.replaceChildren(linkForm(paint), createForm(s, paint));
  };
  const load = () => productsApi.state().then(paint, (e) => { status.textContent = `Products unavailable: ${e.message}`; });
  void load();
  const el = h('section.products-section', { 'aria-labelledby': 'products-title' }, h('label', { id: 'products-title', style: 'margin-top:18px' }, '📦 Products'), status, list, forms);
  return { el, dispose() { disposed = true; } };
}

/** The hire dialog's product chooser; hidden while the office has only its default product. */
export function productChoice() {
  const select = h('select', { id: 'product-choice', 'aria-label': 'Product' }) as HTMLSelectElement;
  const el = h('div.product-choice', { hidden: true }, h('label', { for: 'product-choice' }, '📦 Product'), select);
  productsApi.state().then((s) => {
    if (s.products.length < 2) return;
    select.replaceChildren(...s.products.map((p) => h('option', { value: p.id, disabled: !p.present }, `${p.name}${p.origin === 'office' ? ' (this office)' : ''}${p.present ? '' : ' — folder missing'}`)));
    select.value = OFFICE_PRODUCT_ID;
    el.hidden = false;
  }, () => undefined);
  return { element: el, value: (): string | undefined => (el.hidden || select.value === OFFICE_PRODUCT_ID ? undefined : select.value) };
}
