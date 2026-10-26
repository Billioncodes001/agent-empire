// FREE-07: organizational memory in cloud mode. Lessons come from the coordinator's snapshot (state/org.json); adding,
// editing and retiring are intents the coordinator applies on its next run. Every new lesson or edit still waits in the
// inbox for the CEO's decision, exactly as on a server (FREE-10). Nothing here is live.

import { CHIEF_ROLES, ROLE_LABEL } from '../../shared/chief';
import { checkLesson } from '../../shared/lesson-rules';
import { LESSON_LIMITS, LESSON_SCOPES, LESSON_STATUS_LABEL, MEMORY_NOTE, SCOPE_LABEL, SOURCE_LABEL, lessonsMarkdown, scopeText, type Lesson, type LessonScope } from '../../shared/memory';
import { cloudGapMessage } from '../../shared/org-capabilities';
import { cloudMemory } from '../../cloud/org';
import { activeCloudNet } from '../cloud/active';
import { store } from '../state';
import { h, openModal } from './dom';
import { morphChildren } from './reconcile';
import { openInbox } from './inbox';

const lessonsNow = (): Lesson[] => (store.cloud?.snapshot ? cloudMemory(store.cloud.snapshot.state.org).lessons : []);
const sentFor = (id: string) => store.cloud?.sent?.find((s) => s.ref === id && (s.kind === 'lesson_retire'));

export function openCloudMemory() {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close memory' }, '✕');
  const list = h('ul.memory-list', { 'aria-label': 'Lessons' });
  const status = h('p.memory-status', { role: 'status', 'aria-live': 'polite' });
  const text = h('textarea', { id: 'cloud-lesson-text', rows: 3, maxlength: LESSON_LIMITS.text, placeholder: 'e.g. Always add a rollback note to deploy plans.' }) as HTMLTextAreaElement;
  const scope = h('select', { id: 'cloud-lesson-scope' }, ...LESSON_SCOPES.map((s) => h('option', { value: s }, SCOPE_LABEL[s]))) as HTMLSelectElement;
  const value = h('input', { id: 'cloud-lesson-value', type: 'text', maxlength: LESSON_LIMITS.scopeValue, placeholder: 'Name', hidden: true }) as HTMLInputElement;
  const role = h('select', { id: 'cloud-lesson-role', hidden: true }, ...CHIEF_ROLES.map((r) => h('option', { value: r }, ROLE_LABEL[r]))) as HTMLSelectElement;
  let editing: Lesson | undefined;
  const editNote = h('p.setting-note', { hidden: true });
  const submit = h('button.btn.primary', { type: 'submit' }, 'Propose lesson') as HTMLButtonElement;
  const cancelEdit = h('button.btn', { type: 'button', hidden: true, onclick: () => setEditing(undefined) }, 'Cancel edit');
  const syncScope = () => { value.hidden = !['client', 'product'].includes(scope.value); role.hidden = scope.value !== 'role'; };
  scope.addEventListener('change', syncScope);
  const setEditing = (l: Lesson | undefined) => {
    editing = l;
    editNote.hidden = !l; cancelEdit.hidden = !l;
    editNote.textContent = l ? `Editing ${l.id}. It stays in use until you approve the edit in the inbox.` : '';
    submit.textContent = l ? 'Propose edit' : 'Propose lesson';
    if (l) { text.value = l.text; scope.value = l.scope; if (l.scope === 'role') role.value = l.scopeValue ?? ''; else value.value = l.scopeValue ?? ''; syncScope(); text.focus(); }
  };
  const form = h('form.memory-add', {},
    h('label', { for: 'cloud-lesson-text' }, 'Add a lesson'), text,
    h('div.memory-scope', {}, h('label', { for: 'cloud-lesson-scope' }, 'Scope'), scope, role, value),
    editNote,
    h('p.setting-note', {}, 'Your coordinator files it on its next run; it then waits in the inbox for your approval. Only approved lessons are in use.'),
    h('div.research-actions', {}, submit, cancelEdit), status);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const sv = scope.value === 'role' ? role.value : scope.value === 'company' ? undefined : value.value;
    const checked = checkLesson({ text: text.value, scope: scope.value, scopeValue: sv }, 'ceo');
    if ('error' in checked) { status.textContent = `Not sent: ${checked.error}.`; text.focus(); return; }
    const net = activeCloudNet();
    if (!net) { status.textContent = 'Cloud mode is not connected on this device yet.'; return; }
    submit.disabled = true;
    const id = await net.submit({ kind: 'lesson_propose', lesson: { text: checked.ok.text, scope: checked.ok.scope as LessonScope, ...(checked.ok.scopeValue ? { scopeValue: checked.ok.scopeValue } : {}), ...(editing ? { supersedes: editing.id } : {}) } }, editing ? `Edit of ${editing.id}` : 'New lesson');
    submit.disabled = false;
    if (id) { status.textContent = 'Sent to your coordinator. It appears below and in the inbox after its next run.'; text.value = ''; setEditing(undefined); }
  });
  const render = () => {
    const lessons = lessonsNow();
    morphChildren(list, lessons.length ? lessons.slice().reverse().map((l) => {
      const retiring = sentFor(l.id);
      return h('li', { 'data-key': `${l.id}|${l.status}|${!!retiring}` },
        h('article.memory-lesson', { 'data-status': l.status },
          h('p.memory-head', {}, h('strong', {}, l.id), ` · ${scopeText(l)} · `, h('span.empire-tag', {}, LESSON_STATUS_LABEL[l.status])),
          h('blockquote.lesson-text', {}, l.text),
          h('p.setting-note', {}, `${SOURCE_LABEL[l.source.kind]} · ${l.source.label}${l.retiredReason ? ` · ${l.retiredReason}` : ''}`),
          l.status === 'retired' ? null : h('div.research-actions', {},
            retiring ? h('span.setting-note', { role: 'status' }, 'Retirement sent; applied on the next coordinator run.') : null,
            l.status === 'approved' && !retiring ? h('button.btn', { type: 'button', onclick: () => setEditing(l) }, 'Edit…') : null,
            l.status === 'proposed' && l.approvalId ? h('button.btn', { type: 'button', onclick: () => { modal.close(); openInbox(l.approvalId); } }, 'Decide in the inbox') : null,
            retiring ? null : h('button.btn.danger', { type: 'button', onclick: () => {
              if (!confirm(`Retire ${l.id}? It stops being used at once${l.status === 'proposed' ? ' and its inbox item is resolved' : ''}.`)) return;
              void activeCloudNet()?.submit({ kind: 'lesson_retire', lessonId: l.id }, `Retire ${l.id}`);
            } }, 'Retire…'))));
    }) : [h('li.setting-note', {}, 'No lessons yet. Add the first one above.')]);
  };
  const exportBtn = h('button.btn', { type: 'button', onclick: () => {
    const blob = new Blob([lessonsMarkdown(lessonsNow())], { type: 'text/markdown' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'agent-empire-lessons.md' });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } }, 'Export as Markdown');
  const modal = openModal(h('div.modal.exec-modal.cloud-memory', { role: 'dialog', 'aria-labelledby': 'cloud-memory-title' },
    h('header', {}, h('div', {}, h('small.empire-eyebrow', {}, 'Chief of staff · cloud mode'), h('h2', { id: 'cloud-memory-title' }, 'Organizational memory')), close),
    h('div.exec-body', {},
      h('p.setting-note', {}, MEMORY_NOTE),
      h('p.exec-note.exec-cloud-gap', { 'data-gap': 'memory' }, cloudGapMessage('memory')),
      form, h('h3', {}, 'Lessons'), list, h('div.research-actions', {}, exportBtn))),
  { onClose: () => off() });
  const off = store.on('cloud', render);
  close.addEventListener('click', () => modal.close());
  syncScope();
  render();
  text.focus();
}
