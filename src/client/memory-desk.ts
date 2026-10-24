/**
 * FREE-10: the Memory panel on the founder desk. Lists reviewed lessons with their provenance, filters them, adds a CEO
 * note, edits (a new proposal that needs approval) and retires. Approving happens only in the inbox (game or Telegram),
 * so nothing written here is used until it is approved. All text is rendered as text.
 */
import { apiFetch } from './endpoint';
import { CHIEF_ROLES, ROLE_LABEL } from '../shared/chief';
import {
  LESSON_LIMITS, LESSON_SCOPES, LESSON_STATUS_LABEL, MEMORY_NOTE, SCOPE_LABEL, SOURCE_LABEL, scopeText, sourceLink,
  type Lesson, type LessonScope, type LessonStatus, type MemoryState,
} from '../shared/memory';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, value = '', cls?: string) => { const n = document.createElement(tag); n.textContent = value; if (cls) n.className = cls; return n; };
const newId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

async function memoryApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(`/api/memory${path}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000), ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 401 ? 'Your session ended. Open the city and sign in again.' : data.error || 'Memory could not complete the request.');
  return data as T;
}

let state: MemoryState | null = null;
let seen = '';
let editing: string | undefined;
let noteRequest = newId();
let openJob: (jobId: string) => boolean = () => false;

const scopeValueField = (scope: LessonScope, value = '', name = 'scopeValue'): HTMLElement | null => {
  if (scope === 'company') return null;
  if (scope === 'role') {
    const select = el('select'); select.name = name; select.setAttribute('aria-label', 'Role');
    for (const r of CHIEF_ROLES) { const o = el('option', ROLE_LABEL[r]); o.value = r; o.selected = r === value; select.append(o); }
    return select;
  }
  const input = el('input'); input.name = name; input.maxLength = LESSON_LIMITS.scopeValue; input.value = value; input.required = true;
  input.placeholder = scope === 'client' ? 'Client name, exactly as on its jobs' : 'Product name as it appears in briefs';
  input.setAttribute('aria-label', scope === 'client' ? 'Client name' : 'Product name');
  return input;
};

function sourceLine(l: Lesson): HTMLElement {
  const p = el('p', `${SOURCE_LABEL[l.source.kind]} · ${l.source.label}`, 'lesson-source');
  const link = sourceLink(l.source);
  if (link && l.source.jobId) {
    const a = el('a', 'Open job ↗'); a.href = link;
    a.addEventListener('click', (e) => { if (openJob(l.source.jobId!)) e.preventDefault(); });
    p.append(' ', a);
  } else if (link) { const a = el('a', 'Open report ↗'); a.href = link; p.append(' ', a); }
  return p;
}

function lessonRow(l: Lesson): HTMLElement {
  const art = el('article', '', 'lesson'); art.dataset.status = l.status; art.dataset.lesson = l.id;
  const head = el('header');
  head.append(el('strong', l.id, 'lesson-id'), el('span', LESSON_STATUS_LABEL[l.status], 'lesson-status'), el('span', scopeText(l), 'lesson-scope'));
  art.append(head);
  if (editing === l.id) { art.append(editForm(l)); return art; }
  art.append(el('p', l.text, 'lesson-text'), sourceLine(l));
  const meta = [`Proposed by ${l.proposedBy}`, l.decidedBy ? `${l.status === 'approved' ? 'approved' : 'decided'} by ${l.decidedBy}` : '', l.supersedes ? `edit of ${l.supersedes}` : '', `used in ${l.uses} plan${l.uses === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  art.append(el('p', meta, 'lesson-meta'));
  if (l.retiredReason) art.append(el('p', `Retired: ${l.retiredReason}`, 'lesson-meta'));
  if (l.status === 'proposed') art.append(el('p', `Not used until you approve it${l.approvalId ? `: decide ${l.approvalId} in the game inbox, or /approve ${l.approvalId} in Telegram` : ''}.`, 'lesson-pending'));
  if (l.status !== 'retired') {
    const actions = el('div', '', 'lesson-actions');
    const edit = el('button', 'Edit…', 'quiet') as HTMLButtonElement; edit.type = 'button';
    edit.setAttribute('aria-label', `Edit ${l.id}`);
    edit.addEventListener('click', () => { editing = l.id; render(true); art.ownerDocument.querySelector<HTMLTextAreaElement>(`[data-lesson="${l.id}"] textarea`)?.focus(); });
    const retire = el('button', 'Retire…', 'quiet') as HTMLButtonElement; retire.type = 'button';
    retire.setAttribute('aria-label', `Retire ${l.id}`);
    retire.addEventListener('click', async () => {
      if (!confirm(`Retire ${l.id}? The chief stops using it straight away.${l.status === 'proposed' ? ' Its inbox item is resolved.' : ''}`)) return;
      try { await memoryApi(`/lessons/${l.id}/retire`, {}); status(`${l.id} retired.`); await refreshMemory(true); } catch (e) { status((e as Error).message, true); }
    });
    actions.append(edit, retire);
    art.append(actions);
  }
  return art;
}

function editForm(l: Lesson): HTMLElement {
  const form = el('form', '', 'lesson-edit');
  const area = el('textarea'); area.name = 'text'; area.maxLength = LESSON_LIMITS.text; area.rows = 3; area.value = l.text; area.required = true;
  area.setAttribute('aria-label', `New text for ${l.id}`);
  const note = el('p', l.status === 'approved' ? `Saving sends the edit to your inbox. ${l.id} stays in use until you approve it, then it is replaced.` : 'Saving replaces this proposal with the edit, which goes to your inbox.', 'small');
  const save = el('button', 'Send edit for approval', 'primary') as HTMLButtonElement; save.type = 'submit';
  const cancel = el('button', 'Cancel', 'quiet') as HTMLButtonElement; cancel.type = 'button';
  cancel.addEventListener('click', () => { editing = undefined; render(true); });
  const requestId = newId();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      const next = await memoryApi<Lesson>(`/lessons/${l.id}/edit`, { text: area.value, requestId });
      editing = undefined; status(`Edit ${next.id} waits for your approval${next.approvalId ? ` (${next.approvalId})` : ''}.`);
      await refreshMemory(true);
    } catch (err) { status((err as Error).message, true); save.disabled = false; }
  });
  const row = el('div', '', 'lesson-actions'); row.append(save, cancel);
  form.append(area, note, row);
  return form;
}

function status(message: string, isError = false) { const s = $('memory-status'); s.textContent = message; s.dataset.error = String(isError); }

function render(force = false) {
  if (!state) return;
  const fs = ($('memory-filter-status') as HTMLSelectElement).value as LessonStatus | 'all';
  const sc = ($('memory-filter-scope') as HTMLSelectElement).value as LessonScope | 'all';
  const fp = JSON.stringify([state, fs, sc, editing]);
  if (!force && fp === seen) return;
  seen = fp;
  const counts = { approved: 0, proposed: 0, retired: 0 };
  for (const l of state.lessons) counts[l.status]++;
  $('memory-summary').textContent = state.storageError ?? `${counts.approved} in use · ${counts.proposed} waiting for approval · ${counts.retired} retired`;
  const list = $('memory-list'); list.replaceChildren();
  const shown = state.lessons.filter((l) => (fs === 'all' || l.status === fs) && (sc === 'all' || l.scope === sc)).reverse();
  if (!shown.length) { list.append(el('p', state.lessons.length ? 'No lessons match these filters.' : 'No lessons yet. Approved lessons from reviews, failures and your notes appear here.', 'empty')); return; }
  for (const l of shown) list.append(lessonRow(l));
}

export async function refreshMemory(force = false) {
  try { state = await memoryApi<MemoryState>(''); } catch { if (!state) $('memory-summary').textContent = 'Memory is not available on this host.'; return; }
  render(force);
}

export function mountMemory(options: { openJob: (jobId: string) => boolean }) {
  openJob = options.openJob;
  $('memory-note').textContent = MEMORY_NOTE;
  const scope = $('memory-scope') as HTMLSelectElement;
  for (const s of LESSON_SCOPES) { const o = el('option', SCOPE_LABEL[s]); o.value = s; scope.append(o); }
  const fscope = $('memory-filter-scope') as HTMLSelectElement;
  for (const s of LESSON_SCOPES) { const o = el('option', SCOPE_LABEL[s]); o.value = s; fscope.append(o); }
  const slot = $('memory-scope-value');
  const paintScope = () => { slot.replaceChildren(); const f = scopeValueField(scope.value as LessonScope); if (f) slot.append(f); };
  scope.addEventListener('change', paintScope);
  paintScope();
  for (const id of ['memory-filter-status', 'memory-filter-scope']) $(id).addEventListener('change', () => render());
  const form = $('memory-form') as HTMLFormElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const body: Record<string, unknown> = { text: String(f.get('text') ?? ''), scope: scope.value, requestId: noteRequest };
    const v = f.get('scopeValue'); if (v !== null && scope.value !== 'company') body.scopeValue = String(v);
    const ref = String(f.get('sourceRef') ?? '').trim();
    if (ref) body.source = { kind: String(f.get('sourceKind') ?? 'job'), ref };
    const btn = $('memory-add') as HTMLButtonElement; btn.disabled = true;
    try {
      const l = await memoryApi<Lesson>('/lessons', body);
      noteRequest = newId(); form.reset(); paintScope();
      status(`${l.id} waits for your approval${l.approvalId ? ` (${l.approvalId} in the game inbox or Telegram)` : ''}. It is not used until then.`);
      await refreshMemory(true);
    } catch (err) { status((err as Error).message, true); } finally { btn.disabled = false; }
  });
  $('memory-export').addEventListener('click', async () => {
    try {
      const res = await apiFetch('/api/memory/export.md', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error('Export failed.');
      const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/markdown' }));
      const a = el('a'); a.href = url; a.download = 'agent-empire-memory.md'; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status('Exported as Markdown.');
    } catch (e) { status((e as Error).message, true); }
  });
  void refreshMemory(true);
}
