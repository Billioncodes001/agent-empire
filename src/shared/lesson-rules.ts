// FREE-07: the lesson rules both the office server (src/server/memory.ts) and the cloud coordinator (src/cloud/org.ts)
// apply. Moved unchanged from src/server/memory.ts; pure and browser-safe, so the game can pre-check a lesson too.

import type { Approval } from './approvals.js';
import { CHIEF_ROLES } from './chief.js';
import { LESSON_LIMITS, isLessonScope, type Lesson, type LessonScope } from './memory.js';
import { hasHiddenChars, unsafeReason } from './text-safety.js';

export interface LessonDraft { text: unknown; scope: unknown; scopeValue?: unknown }

/**
 * Validates lesson text and scope. `model`: text the chief's model wrote (screened as untrusted). Answers the clean
 * fields or an error message; nothing is trimmed into shape.
 */
export function checkLesson(draft: LessonDraft, origin: 'model' | 'ceo'): { ok: { text: string; scope: LessonScope; scopeValue?: string } } | { error: string } {
  if (typeof draft.text !== 'string' || !draft.text.trim()) return { error: 'the lesson text is missing' };
  const text = draft.text.trim();
  if (text.length > LESSON_LIMITS.text) return { error: `the lesson is longer than ${LESSON_LIMITS.text} characters` };
  if (hasHiddenChars(text)) return { error: 'the lesson contains invisible or control characters' };
  if (origin === 'model') { const why = unsafeReason(text); if (why) return { error: `the lesson ${why}` }; }
  if (!isLessonScope(draft.scope)) return { error: 'scope must be company, product, role or client' };
  const scope = draft.scope;
  const raw = draft.scopeValue;
  if (scope === 'company') {
    if (raw !== undefined && raw !== null && raw !== '') return { error: 'a company-wide lesson has no scope value' };
    return { ok: { text, scope } };
  }
  if (typeof raw !== 'string' || !raw.trim()) return { error: `a ${scope} lesson needs its ${scope === 'role' ? 'role' : `${scope} name`}` };
  const value = raw.trim();
  if (scope === 'role') {
    if (!(CHIEF_ROLES as readonly string[]).includes(value)) return { error: `role must be one of ${CHIEF_ROLES.join(', ')}` };
  } else {
    if (value.length > LESSON_LIMITS.scopeValue) return { error: `the ${scope} name is longer than ${LESSON_LIMITS.scopeValue} characters` };
    if (hasHiddenChars(value)) return { error: `the ${scope} name contains invisible or control characters` };
  }
  return { ok: { text, scope, scopeValue: value } };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
/** The same lesson in other words: same scope, same text and scope value ignoring case and spacing. */
export const sameLesson = (a: Pick<Lesson, 'text' | 'scope' | 'scopeValue'>, b: Pick<Lesson, 'text' | 'scope' | 'scopeValue'>) =>
  a.scope === b.scope && norm(a.text) === norm(b.text) && norm(a.scopeValue ?? '') === norm(b.scopeValue ?? '');

/**
 * FREE-10 review fix 1: an inbox item counts only if it was raised for exactly this proposal (id, text, scope, scope
 * value and nonce, and raised after it). Lesson and approval ids repeat when a store is reset, so the nonce is the key.
 */
export function lessonItemMatches(item: Pick<Approval, 'kind' | 'lesson' | 'createdAt'>, l: Pick<Lesson, 'id' | 'text' | 'scope' | 'scopeValue' | 'proposedAt'> & { nonce?: string }): boolean {
  const a = item.lesson;
  return item.kind === 'lesson' && !!a && a.lessonId === l.id && a.text === l.text && a.scope === l.scope && (a.scopeValue ?? '') === (l.scopeValue ?? '')
    && !!l.nonce && a.nonce === l.nonce && item.createdAt >= l.proposedAt;
}
