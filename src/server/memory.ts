/**
 * FREE-10 / CONSULT-05: reviewed organizational memory (lessons.json).
 *
 * - A lesson is proposed by the chief's model (from a review or a repeated failure) or written by the CEO. Either way it
 *   starts `proposed` and goes to the approval inbox as a `lesson` item (decision only). Nothing is active until the CEO
 *   approves it there; the inbox saves the decision first and only then tells memory (`apply`), and `reconcile` finishes
 *   a decision a restart cut off.
 * - Approved lessons relevant to a brief (shared/memory.ts `relevantLessons`) are given to the chief's planner as
 *   delimited, cited context. They never reach worker prompts automatically.
 * - Editing makes a new proposal that replaces the old lesson only once approved. Retiring is immediate.
 *
 * Model-written lesson text is untrusted: bounded, refused when it holds invisible/control characters, and screened by
 * the same heuristic as the chief's prompts. CEO notes are bounded and refused on invisible characters too.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Approval } from '../shared/approvals.js';
import { CHIEF_ROLES } from '../shared/chief.js';
import {
  LESSON_LIMITS, SOURCE_KINDS, SOURCE_LABEL, isLessonScope, lessonsMarkdown, relevantLessons,
  type Lesson, type LessonScope, type LessonSource, type MemoryState,
} from '../shared/memory.js';
import { hasHiddenChars, unsafeReason } from './chief.js';
import { writeJsonAtomic } from './persistence.js';

const FILE = 'lessons.json';
const MAX_LESSONS = 500;

export class MemoryError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'MemoryError'; }
}

interface Stored extends Lesson {
  /** Idempotency for chief proposals (e.g. `review:<review key>`). Server only. */
  key?: string;
  /** Idempotency for CEO notes and edits. Server only. */
  requestId?: string;
  /** Review fix 1: a random nonce per proposal, carried by its inbox item. Server only. */
  nonce?: string;
}

interface StoredFile { version: 1; nextId: number; lessons: Stored[] }

/** What the approval inbox offers memory: raise a `lesson` item, resolve one, and read a decision back. */
export interface MemoryInboxPort {
  raise(fields: { source: string; jobId: string; title: string; detail: string; lesson: NonNullable<Approval['lesson']> }): string | undefined;
  resolve(approvalId: string, note: string): void;
  get(approvalId: string): Approval | undefined;
}

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
const sameLesson = (a: Pick<Lesson, 'text' | 'scope' | 'scopeValue'>, b: Pick<Lesson, 'text' | 'scope' | 'scopeValue'>) =>
  a.scope === b.scope && norm(a.text) === norm(b.text) && norm(a.scopeValue ?? '') === norm(b.scopeValue ?? '');
const REF_RE = /^[\w:.#@-]{1,200}$/;
const JOB_RE = /^[\w-]{1,80}$/;

export class LessonMemory {
  private readonly file: string;
  private data: StoredFile = { version: 1, nextId: 1, lessons: [] };
  private storageError?: string;
  private inbox?: MemoryInboxPort;
  private readonly now: () => number;

  constructor(dataDir: string, private readonly ports: { now?: () => number; onChange?: () => void; jobExists?: (jobId: string) => boolean } = {}) {
    this.file = path.join(dataDir, FILE);
    this.now = ports.now ?? Date.now;
    this.restore();
  }

  setInbox(port: MemoryInboxPort) { this.inbox = port; }

  state(): MemoryState {
    return { schemaVersion: 1, lessons: this.data.lessons.map(publicLesson), ...(this.storageError ? { storageError: this.storageError } : {}) };
  }

  get(id: string): Lesson | undefined { const l = this.find(id); return l && publicLesson(l); }

  markdown(): string { return lessonsMarkdown(this.data.lessons.map(publicLesson), this.now()); }

  /** Approved lessons relevant to a brief, for the chief's planning prompt. */
  relevant(brief: { client: string; title: string; brief: string }): Lesson[] {
    if (this.storageError) return [];
    return relevantLessons(this.data.lessons, brief).map(publicLesson);
  }

  /** Counts that these lessons were given to the chief in a planning prompt. */
  markUsed(ids: string[]) {
    if (this.storageError || !ids.length) return;
    const at = this.now();
    for (const id of ids) { const l = this.find(id); if (l && l.status === 'approved') { l.uses += 1; l.lastUsedAt = at; } }
    this.save();
  }

  /**
   * The chief's model proposes a lesson. `key` makes it idempotent (one proposal per review or failure); an identical
   * lesson already proposed or approved is answered instead of a duplicate. Answers the lesson, or an error to record.
   */
  proposeFromChief(input: { key: string; draft: LessonDraft; source: LessonSource; model: string }): { ok: Lesson } | { error: string } {
    if (this.storageError) return { error: 'organizational memory is unavailable' };
    const known = this.data.lessons.find((l) => l.key === input.key);
    if (known) return { ok: publicLesson(known) };
    const checked = checkLesson(input.draft, 'model');
    if ('error' in checked) return checked;
    const dup = this.data.lessons.find((l) => l.status !== 'retired' && sameLesson(l, checked.ok));
    if (dup) return { ok: publicLesson(dup) };
    const lesson = this.add({ ...checked.ok, source: input.source, proposedBy: `Model-backed · ${input.model} · proposals only`, key: input.key });
    return { ok: publicLesson(lesson) };
  }

  /** The CEO writes a lesson. It is still a proposal: it becomes active only when approved in the inbox. */
  addNote(input: unknown, actor: string): Lesson {
    this.assertMutable();
    const raw = this.object(input, ['text', 'scope', 'scopeValue', 'source', 'requestId']);
    const requestId = this.requestId(raw.requestId);
    if (requestId) { const known = this.data.lessons.find((l) => l.requestId === requestId); if (known) return publicLesson(known); }
    const checked = checkLesson({ text: raw.text, scope: raw.scope, scopeValue: raw.scopeValue }, 'ceo');
    if ('error' in checked) throw new MemoryError(400, `${checked.error[0].toUpperCase()}${checked.error.slice(1)}.`);
    const source = this.ceoSource(raw.source);
    return publicLesson(this.add({ ...checked.ok, source, proposedBy: actor, ...(requestId ? { requestId } : {}) }));
  }

  /**
   * An edit is a new proposal with the same provenance. The lesson it replaces stays as it is (in use, if approved)
   * until the edit is approved; then it is retired. Editing a proposal replaces that proposal straight away.
   */
  edit(id: string, input: unknown, actor: string): Lesson {
    this.assertMutable();
    const old = this.find(id);
    if (!old) throw new MemoryError(404, `Unknown lesson: ${id}`);
    if (old.status === 'retired') throw new MemoryError(409, `${id} is retired. Add a new lesson instead.`);
    const raw = this.object(input, ['text', 'scope', 'scopeValue', 'requestId']);
    const requestId = this.requestId(raw.requestId);
    if (requestId) { const known = this.data.lessons.find((l) => l.requestId === requestId); if (known) return publicLesson(known); }
    if (this.data.lessons.some((l) => l.status === 'proposed' && l.supersedes === id)) throw new MemoryError(409, `An edit of ${id} already waits for your approval. Decide it first.`);
    const checked = checkLesson({ text: raw.text, scope: raw.scope ?? old.scope, scopeValue: raw.scope === undefined && raw.scopeValue === undefined ? old.scopeValue : raw.scopeValue }, 'ceo');
    if ('error' in checked) throw new MemoryError(400, `${checked.error[0].toUpperCase()}${checked.error.slice(1)}.`);
    if (sameLesson(old, checked.ok)) throw new MemoryError(400, 'Nothing changed.');
    const next = this.add({ ...checked.ok, source: structuredClone(old.source), proposedBy: `${actor} (edit of ${id})`, supersedes: old.status === 'approved' ? id : old.supersedes, ...(requestId ? { requestId } : {}) }, false);
    if (old.status === 'proposed') this.retireLesson(old, `Replaced by the edit ${next.id}`, actor);
    this.save();
    this.raiseFor(next);
    return publicLesson(next);
  }

  /** Retiring is immediate: the chief stops seeing the lesson. A pending inbox item for it is resolved. */
  retire(id: string, actor: string, reason?: unknown): Lesson {
    this.assertMutable();
    const l = this.find(id);
    if (!l) throw new MemoryError(404, `Unknown lesson: ${id}`);
    if (l.status === 'retired') return publicLesson(l);
    const why = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : `Retired by ${actor}`;
    if (hasHiddenChars(why)) throw new MemoryError(400, 'The reason contains invisible or control characters.');
    this.retireLesson(l, why, actor);
    this.save();
    return publicLesson(l);
  }

  /** The inbox's port: `check` refuses a stale approval (409); `apply` runs after the decision is saved. */
  actions() {
    return {
      check: (item: Approval): string | undefined => {
        const l = item.lesson && this.find(item.lesson.lessonId);
        if (!l || !this.matches(item, l)) return 'This item is for a lesson that no longer exists, so it no longer applies.';
        if (l.status !== 'proposed') return `${l.id} is already ${l.status}, so this item no longer applies.`;
        return undefined;
      },
      apply: (item: Approval, decision: 'approved' | 'rejected', actor: string): string => {
        const l = item.lesson && this.find(item.lesson.lessonId);
        return l && this.matches(item, l) ? this.decide(l.id, decision, actor) : '';
      },
    };
  }

  /**
   * Raises inbox items for proposals that have none (e.g. the inbox was briefly unavailable) and finishes decisions the
   * inbox saved before a restart cut off `apply`. Never throws.
   */
  reconcile(): void {
    if (this.storageError || !this.inbox) return;
    try {
      for (const l of this.data.lessons) {
        if (l.status !== 'proposed') continue;
        const item = l.approvalId ? this.inbox.get(l.approvalId) : undefined;
        // Review fix 1: an item counts only if it was raised for exactly this proposal (a reset inbox reuses ids).
        if (!item || !this.matches(item, l)) {
          // A pending lesson item for the same id that does not match is retired from the inbox, never applied.
          if (item && item.kind === 'lesson' && item.status === 'pending' && item.lesson?.lessonId === l.id) this.inbox.resolve(item.id, 'Replaced by a fresh item for this proposal.');
          this.raiseFor(l, true);
          continue;
        }
        if (item.status === 'approved' || item.status === 'rejected') this.decide(l.id, item.status, item.decidedBy ?? 'CEO');
      }
    } catch { /* retried on the next tick */ }
  }

  // ---- internals ----

  /** Review fix 1: the inbox item was raised for exactly this proposal. */
  private matches(item: Approval, l: Stored): boolean {
    const a = item.lesson;
    return item.kind === 'lesson' && !!a && a.lessonId === l.id && a.text === l.text && a.scope === l.scope && (a.scopeValue ?? '') === (l.scopeValue ?? '')
      && !!l.nonce && a.nonce === l.nonce && item.createdAt >= l.proposedAt;
  }

  private decide(id: string, decision: 'approved' | 'rejected', actor: string): string {
    const l = this.find(id);
    if (!l || l.status !== 'proposed') return '';
    const at = this.now();
    if (decision === 'approved') {
      Object.assign(l, { status: 'approved', decidedAt: at, decidedBy: actor });
      const old = l.supersedes ? this.find(l.supersedes) : undefined;
      if (old && old.status !== 'retired') this.retireLesson(old, `Replaced by ${l.id}`, actor);
      this.save();
      return old ? `${l.id} is in use and replaces ${old.id}.` : `${l.id} is in use.`;
    }
    this.retireLesson(l, `Declined by ${actor}`, actor);
    this.save();
    return `${l.id} was declined and is not used.`;
  }

  private retireLesson(l: Stored, reason: string, actor: string) {
    const pending = l.status === 'proposed' && l.approvalId;
    Object.assign(l, { status: 'retired', retiredReason: reason, decidedAt: this.now(), decidedBy: actor });
    if (pending) { try { this.inbox?.resolve(l.approvalId!, reason); } catch { /* the inbox reports its own storage problem */ } }
  }

  private add(fields: Pick<Stored, 'text' | 'scope' | 'scopeValue' | 'source' | 'proposedBy' | 'supersedes' | 'key' | 'requestId'>, raise = true): Stored {
    const lesson: Stored = { id: `L${this.data.nextId++}`, status: 'proposed', proposedAt: this.now(), uses: 0, nonce: randomBytes(8).toString('hex'), ...stripUndefined(fields) };
    this.data.lessons.push(lesson);
    this.trim();
    this.save();
    if (raise) this.raiseFor(lesson);
    return lesson;
  }

  private raiseFor(l: Stored, replace = false) {
    if (!this.inbox || l.status !== 'proposed' || this.storageError) return;
    // A missing or mismatched item gets a fresh proposal nonce, so the new item can never collide with an old one.
    if (!l.nonce || replace) { l.nonce = randomBytes(8).toString('hex'); delete l.approvalId; this.save(); }
    const old = l.supersedes ? this.find(l.supersedes) : undefined;
    const id = this.inbox.raise({
      source: `lesson:${l.id}:${l.nonce}`, jobId: l.source.jobId ?? '',
      title: old ? `Edit of lesson ${old.id}` : `Lesson ${l.id}: ${l.text.length > 70 ? `${l.text.slice(0, 67)}…` : l.text}`,
      detail: `${l.proposedBy.startsWith('Model-backed') ? 'The chief proposes' : `${l.proposedBy} proposes`} a ${l.scope === 'company' ? 'company-wide' : l.scope} lesson from ${SOURCE_LABEL[l.source.kind].toLowerCase()}. Approving makes it planning context for the chief; nothing else happens.`,
      lesson: { lessonId: l.id, text: l.text, scope: l.scope, ...(l.scopeValue ? { scopeValue: l.scopeValue } : {}), source: structuredClone(l.source), proposedBy: l.proposedBy,
        ...(old ? { supersedes: old.id, supersedesText: old.text } : {}), nonce: l.nonce },
    });
    if (id && l.approvalId !== id) { l.approvalId = id; this.save(); }
  }

  private ceoSource(raw: unknown): LessonSource {
    if (raw === undefined || raw === null) return { kind: 'ceo_note', ref: '', label: 'CEO note' };
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new MemoryError(400, 'source must be {kind, ref}.');
    const s = raw as Record<string, unknown>;
    for (const k of Object.keys(s)) if (!['kind', 'ref', 'jobId'].includes(k)) throw new MemoryError(400, `Unknown source field: ${k}`);
    if (!(SOURCE_KINDS as readonly string[]).includes(s.kind as string)) throw new MemoryError(400, `source.kind must be one of ${SOURCE_KINDS.join(', ')}`);
    const kind = s.kind as LessonSource['kind'];
    const ref = typeof s.ref === 'string' ? s.ref.trim() : '';
    if (kind === 'ceo_note' && !ref) return { kind, ref: '', label: 'CEO note' };
    if (!REF_RE.test(ref)) throw new MemoryError(400, 'source.ref must be the id of a job, item, review, task or research report.');
    let jobId = kind === 'job' ? ref : typeof s.jobId === 'string' && s.jobId.trim() ? s.jobId.trim() : undefined;
    if (jobId !== undefined && !JOB_RE.test(jobId)) throw new MemoryError(400, 'source.jobId is invalid.');
    if (jobId && this.ports.jobExists && !this.ports.jobExists(jobId)) throw new MemoryError(400, `Unknown job: ${jobId}`);
    if (kind === 'research') jobId = undefined;
    return { kind, ref, ...(jobId ? { jobId } : {}), label: `${SOURCE_LABEL[kind]} ${ref} · cited by the CEO` };
  }

  private object(input: unknown, allowed: string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MemoryError(400, 'Expected a lesson.');
    const raw = input as Record<string, unknown>;
    for (const k of Object.keys(raw)) if (!allowed.includes(k)) throw new MemoryError(400, `Unknown field: ${k}`);
    return raw;
  }

  private requestId(v: unknown): string | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || !v.trim() || v.length > 120) throw new MemoryError(400, 'requestId must be a short string.');
    return v.trim();
  }

  private find(id: string): Stored | undefined { return this.data.lessons.find((l) => l.id === id); }

  /** Old retired lessons drop off first; proposed and approved lessons are never dropped. */
  private trim() {
    const over = this.data.lessons.length - MAX_LESSONS;
    if (over <= 0) return;
    let dropped = 0;
    this.data.lessons = this.data.lessons.filter((l) => (dropped < over && l.status === 'retired' ? (dropped++, false) : true));
  }

  private assertMutable() { if (this.storageError) throw new MemoryError(503, this.storageError); }

  private save() {
    if (this.storageError) return;
    try { writeJsonAtomic(this.file, this.data); } catch (error) {
      this.storageError = `Organizational memory could not be saved; preserve lessons.json, repair storage and restart. ${(error as Error).message}`;
    }
    try { this.ports.onChange?.(); } catch { /* observers cannot undo a save */ }
  }

  private restore() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as StoredFile;
      if (raw?.version !== 1 || !Number.isSafeInteger(raw.nextId) || raw.nextId < 1 || !Array.isArray(raw.lessons)) throw new Error('unsupported lessons.json');
      const ids = new Set<string>();
      for (const [i, l] of raw.lessons.entries()) {
        const bad = (why: string) => new Error(`lesson #${i + 1} ${why}`);
        if (!l || typeof l !== 'object' || typeof l.id !== 'string' || !/^L[1-9]\d{0,8}$/.test(l.id) || Number(l.id.slice(1)) >= raw.nextId || ids.has(l.id)) throw bad('has an invalid id');
        ids.add(l.id);
        if (!['proposed', 'approved', 'retired'].includes(l.status)) throw bad('has an invalid status');
        const checked = checkLesson(l, 'ceo');
        if ('error' in checked) throw bad(`is invalid: ${checked.error}`);
        if (!l.source || !(SOURCE_KINDS as readonly string[]).includes(l.source.kind) || typeof l.source.ref !== 'string' || typeof l.source.label !== 'string') throw bad('has invalid provenance');
        if (typeof l.proposedBy !== 'string' || !Number.isSafeInteger(l.proposedAt) || !Number.isSafeInteger(l.uses) || l.uses < 0) throw bad('is incomplete');
        if (l.status !== 'proposed' && (typeof l.decidedBy !== 'string' || !Number.isSafeInteger(l.decidedAt))) throw bad('has no decision evidence');
      }
      this.data = { version: 1, nextId: raw.nextId, lessons: raw.lessons };
    } catch (error) {
      this.storageError = `Cannot restore lessons.json; preserve the file and recover a valid backup. ${(error as Error).message}`;
    }
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function publicLesson({ key: _k, requestId: _r, nonce: _n, ...l }: Stored): Lesson {
  return structuredClone(l);
}
