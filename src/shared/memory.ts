// FREE-10 / CONSULT-05: reviewed organizational memory, shared by server and client.
// A lesson is a short, reviewed note with provenance. Only APPROVED lessons are ever used, and only as clearly delimited,
// cited context in the chief's planning prompt. Nothing becomes active without the CEO's approval in the inbox, and
// lessons are never added to worker prompts automatically: a lesson reaches a worker only through a plan the CEO approves.

import { CHIEF_ROLES, ROLE_LABEL, type ChiefRole } from './chief.js';

export type LessonScope = 'company' | 'product' | 'role' | 'client';
export const LESSON_SCOPES: readonly LessonScope[] = ['company', 'product', 'role', 'client'];
export const SCOPE_LABEL: Record<LessonScope, string> = { company: 'Company-wide', product: 'Product', role: 'Role', client: 'Client' };
export const isLessonScope = (x: unknown): x is LessonScope => typeof x === 'string' && (LESSON_SCOPES as readonly string[]).includes(x);

export type LessonStatus = 'proposed' | 'approved' | 'retired';
export const LESSON_STATUS_LABEL: Record<LessonStatus, string> = { proposed: 'Waiting for your approval', approved: 'Approved · in use', retired: 'Retired' };

/** Where a lesson came from. `ref` is the id of the thing it cites; `jobId` (when known) links to the job on the founder desk. */
export type LessonSourceKind = 'review' | 'failure' | 'job' | 'item' | 'research' | 'ceo_note';
export const SOURCE_KINDS: readonly LessonSourceKind[] = ['review', 'failure', 'job', 'item', 'research', 'ceo_note'];
export const SOURCE_LABEL: Record<LessonSourceKind, string> = { review: 'Chief review', failure: 'Repeated failure', job: 'Job', item: 'Work item', research: 'Research report', ceo_note: 'CEO note' };

export interface LessonSource {
  kind: LessonSourceKind;
  /** The cited id: a review key, a queue task id, a job id, a research report id, or empty for a plain CEO note. */
  ref: string;
  jobId?: string;
  /** One plain line naming the source, e.g. "Review of “Build the API” · Harbour Dental · Online booking". */
  label: string;
}

export interface Lesson {
  /** "L1", "L2", … — short, typable, cited in plans. */
  id: string;
  text: string;
  scope: LessonScope;
  /** client: the client name; role: a chief role id; product: a product name. Absent for company. */
  scopeValue?: string;
  source: LessonSource;
  status: LessonStatus;
  /** "CEO", or "Model-backed · <model> · proposals only" when the chief's model proposed it. */
  proposedBy: string;
  proposedAt: number;
  decidedAt?: number;
  decidedBy?: string;
  /** retired: why (declined, retired by the CEO, replaced by an approved edit). */
  retiredReason?: string;
  /** An edit: the lesson this one replaces once approved. The old lesson stays in use until then. */
  supersedes?: string;
  /** The inbox item that decides this lesson. */
  approvalId?: string;
  /** How many planning prompts this lesson was given to the chief in. */
  uses: number;
  lastUsedAt?: number;
}

export interface MemoryState {
  schemaVersion: 1;
  lessons: Lesson[];
  storageError?: string;
}

export const LESSON_LIMITS = { text: 500, scopeValue: 80, ref: 200, label: 200 } as const;
/** At most this many lessons (and characters) go into one planning prompt. */
export const PLAN_LESSONS = { max: 5, chars: 2500 } as const;

export const MEMORY_NOTE = 'Reviewed lessons with provenance. Only approved lessons are given to the chief, as cited context when it plans; they are never added to worker prompts automatically. Nothing here trains a model or changes the Empire by itself.';
export const LESSON_DECISION_NOTE = 'Approving makes this lesson available to the chief as cited planning context. It never goes into a worker prompt by itself: only a plan you approve can carry it, and you read every prompt first.';

/** A scope in words, e.g. "Client · Harbour Dental" or "Role · QA tester". */
export function scopeText(l: Pick<Lesson, 'scope' | 'scopeValue'>): string {
  if (l.scope === 'company') return SCOPE_LABEL.company;
  const v = l.scope === 'role' && l.scopeValue && (CHIEF_ROLES as readonly string[]).includes(l.scopeValue) ? ROLE_LABEL[l.scopeValue as ChiefRole] : l.scopeValue;
  return `${SCOPE_LABEL[l.scope]} · ${v ?? '—'}`;
}

/** The founder-desk link for a source (relative; the desk opens the job). Plain notes have none. */
export function sourceLink(s: LessonSource): string | undefined {
  if (s.kind === 'research') return `consultancy.html?research=${encodeURIComponent(s.ref)}`;
  return s.jobId ? `consultancy.html?job=${encodeURIComponent(s.jobId)}` : undefined;
}

const STOP = new Set(['with', 'that', 'this', 'from', 'have', 'they', 'will', 'into', 'your', 'their', 'them', 'when', 'what', 'which', 'should', 'would', 'could', 'about', 'after', 'before', 'each', 'only', 'also', 'than', 'then', 'there', 'these', 'those', 'very', 'more', 'most', 'some', 'such', 'other', 'work', 'items', 'item', 'make', 'sure', 'always', 'never', 'must', 'need', 'needs', 'every', 'client', 'clients', 'brief', 'synthetic', 'fixture']);

/** Significant words: lower-case letters/digits, at least 4 characters, minus common words. Deterministic. */
export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u)) if (w.length >= 4 && !STOP.has(w)) out.add(w);
  return out;
}

const norm = (s: string) => s.trim().toLowerCase().normalize('NFKC').replace(/\s+/g, ' ');

/**
 * Approved lessons relevant to a brief, best first, simple and deterministic (no embeddings):
 * - client lessons only for that exact client (cross-client memory stays scoped);
 * - product lessons when the product name appears in the brief;
 * - role and company lessons when they share a significant word with the brief (role: or name the role).
 * Ties keep the older lesson first. At most PLAN_LESSONS.max lessons and PLAN_LESSONS.chars characters.
 */
export function relevantLessons(lessons: readonly Lesson[], brief: { client: string; title: string; brief: string }): Lesson[] {
  const text = `${brief.title}\n${brief.brief}`;
  const words = keywords(text);
  const lower = norm(text);
  const scored: { l: Lesson; score: number; n: number }[] = [];
  for (const l of lessons) {
    if (l.status !== 'approved') continue;
    const overlap = [...keywords(l.text)].filter((w) => words.has(w)).length;
    let score = -1;
    if (l.scope === 'client') score = l.scopeValue && norm(l.scopeValue) === norm(brief.client) ? 100 + overlap : -1;
    else if (l.scope === 'product') score = l.scopeValue && lower.includes(norm(l.scopeValue)) ? 50 + overlap : -1;
    else if (l.scope === 'role') {
      const roleWords = l.scopeValue && (CHIEF_ROLES as readonly string[]).includes(l.scopeValue) ? keywords(ROLE_LABEL[l.scopeValue as ChiefRole]) : new Set<string>();
      const named = [...roleWords].some((w) => words.has(w));
      score = named || overlap > 0 ? 20 + overlap + (named ? 1 : 0) : -1;
    } else score = overlap > 0 ? overlap : -1;
    if (score >= 0) scored.push({ l, score, n: Number(l.id.slice(1)) || 0 });
  }
  scored.sort((a, b) => b.score - a.score || a.n - b.n);
  const out: Lesson[] = [];
  let chars = 0;
  for (const { l } of scored) {
    if (out.length >= PLAN_LESSONS.max || chars + l.text.length > PLAN_LESSONS.chars) break;
    out.push(l);
    chars += l.text.length;
  }
  return out;
}

/** The whole memory as Markdown (export). Every lesson keeps its status, scope and provenance. */
export function lessonsMarkdown(lessons: readonly Lesson[], at = Date.now()): string {
  const day = (t?: number) => (t ? new Date(t).toISOString().slice(0, 10) : '—');
  const lines = ['# Agent Empire · organizational memory', '', `Exported ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC. ${MEMORY_NOTE}`, ''];
  for (const status of ['approved', 'proposed', 'retired'] as LessonStatus[]) {
    const group = lessons.filter((l) => l.status === status);
    if (!group.length) continue;
    lines.push(`## ${LESSON_STATUS_LABEL[status]}`, '');
    for (const l of group) {
      lines.push(`### ${l.id} · ${scopeText(l)}`, '', l.text.replace(/\n+/g, ' '), '',
        `- Source: ${SOURCE_LABEL[l.source.kind]}${l.source.ref ? ` \`${l.source.ref}\`` : ''} · ${l.source.label}`,
        `- Proposed by ${l.proposedBy} on ${day(l.proposedAt)}${l.decidedBy ? ` · decided by ${l.decidedBy} on ${day(l.decidedAt)}` : ''}`,
        ...(l.supersedes ? [`- Edit of ${l.supersedes}`] : []),
        ...(l.retiredReason ? [`- Retired: ${l.retiredReason}`] : []),
        `- Used in ${l.uses} planning prompt${l.uses === 1 ? '' : 's'}`, '');
    }
  }
  if (!lessons.length) lines.push('No lessons yet.', '');
  return lines.join('\n');
}
