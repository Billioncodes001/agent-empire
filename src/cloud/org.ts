/**
 * FREE-07: organization features in cloud mode, kept in `state/org.json` of the state repository.
 *
 * Pure and browser-safe (the game reads the same file and computes the same views). The coordinator is the only writer:
 * clients send intents (`approval_decision`, `lesson_propose`, `lesson_retire`, `research`), and the coordinator applies
 * the shared rules — the lesson checks and proposal match guard (src/shared/lesson-rules.ts), the research report parser
 * (src/shared/research-report.ts) and the approval fingerprint (src/shared/approvals.ts) — the office server uses too.
 *
 * Only the approval kinds in CLOUD_APPROVAL_KINDS exist here (tool proposals and lessons). Neither spends money: a tool
 * decision is recorded only, and a lesson is planning context that no cloud plan uses yet. Paid research goes through
 * the ordinary `new_job` path with its confirmation and limits.
 */
import { APPROVAL_ID_RE, RAISED_BY, approvalFingerprint, type Approval, type ApprovalsState } from '../shared/approvals.js';
import { checkLesson, lessonItemMatches, sameLesson } from '../shared/lesson-rules.js';
import { SOURCE_LABEL, type Lesson, type LessonScope, type LessonSource, type MemoryState } from '../shared/memory.js';
import { EXECUTIVES, type Executive, type OrgState } from '../shared/org.js';
import { CLOUD_APPROVAL_KINDS, ORG_CAPABILITIES } from '../shared/org-capabilities.js';
import { parseArtifact, MAX_ARTIFACT_BYTES } from '../shared/artifact-parse.js';
import { parseResearchReport, researchPrompt } from '../shared/research-report.js';
import { CONFIDENCES, FEASIBILITIES, MAX_QUESTION, RESEARCH_DIR, type Confidence, type Feasibility, type ResearchReport, type ResearchReportSummary, type ResearchSections, type ResearchState, type ToolProposal } from '../shared/research.js';
import { hasHiddenChars } from '../shared/text-safety.js';
import type { CloudJob, CloudState } from './schema.js';

export const ORG_FILE = 'state/org.json';
export const ORG_LIMITS = { approvals: 400, decidedKept: 300, lessons: 500, research: 60, section: 2000, reason: 300, readAttempts: 5 } as const;
/** Review fix 3: the serialized state/org.json never exceeds this (readers accept 4 MiB per state file). */
export const ORG_MAX_BYTES = 3 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LESSON_ID = /^L[1-9]\d{0,8}$/;
const NONCE = /^[a-f0-9]{16}$/;

export interface CloudLesson extends Lesson { nonce: string }
/** `queued` until the job's turn finishes and the report is read from the task branch. */
export type CloudResearchStatus = 'queued' | 'imported' | 'needs_attention';
export interface CloudResearch {
  jobId: string;
  question: string;
  askedAt: number;
  status: CloudResearchStatus;
  reason?: string;
  feasibility?: Feasibility;
  confidence?: Confidence;
  sources?: number;
  /** Each section clipped to ORG_LIMITS.section characters to keep the state file small. */
  sections?: ResearchSections;
  importedAt?: number;
  /** Review fix 4: reads that could not reach GitHub; after ORG_LIMITS.readAttempts the report needs attention. */
  readAttempts?: number;
  tools: ToolProposal[];
}
export interface CloudOrg {
  schemaVersion: 1;
  nextApproval: number;
  nextLesson: number;
  approvals: Approval[];
  lessons: CloudLesson[];
  research: CloudResearch[];
}

export const emptyOrg = (): CloudOrg => ({ schemaVersion: 1, nextApproval: 1, nextLesson: 1, approvals: [], lessons: [], research: [] });
export const isEmptyOrg = (org: CloudOrg) => JSON.stringify(org) === JSON.stringify(emptyOrg());

/** A rule refused the change; the coordinator records it as a rejected intent with this message. */
export class OrgRuleError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'OrgRuleError'; }
}
const refuse = (code: string, message: string): never => { throw new OrgRuleError(code, message); };

// ---------------------------------------------------------------- validation

const PLAN_ITEM_KEYS = ['title', 'prompt', 'phase', 'role', 'parallel', 'dependsOn'];
/** FREE-11/12: the fields each new cloud kind may carry, checked strictly (and only on that kind). */
function validateNewKinds(a: Rec) {
  const only = (field: string, kind: string) => { if (a[field] !== undefined && a.kind !== kind) throw new OrgSchemaError(`${field} on a ${String(a.kind).slice(0, 30)} item`); };
  only('plan', 'job_plan'); only('proposal', 'chief_proposal'); only('outreach', 'external_action');
  if (a.proposedBy !== undefined && (a.kind !== 'job_plan' || typeof a.proposedBy !== 'string' || a.proposedBy.length > 200)) throw new OrgSchemaError('invalid proposedBy');
  if (a.kind === 'job_plan') {
    const p = obj(a.plan, ['requestId', 'client', 'title', 'summary', 'items', 'lessons', 'citedLessons', 'costLabel'], 'plan');
    text(p.requestId, 80, 'plan'); text(p.title, 200, 'plan title'); text(p.costLabel, 200, 'plan cost');
    if (p.client !== undefined) text(p.client, 120, 'plan client');
    if (p.summary !== undefined) text(p.summary, 400, 'plan summary');
    if (!Array.isArray(p.items) || !p.items.length || p.items.length > 8) throw new OrgSchemaError('invalid plan items');
    for (const it of p.items) {
      const x = obj(it, PLAN_ITEM_KEYS, 'plan item');
      text(x.title, 120, 'plan item title'); text(x.prompt, 2000, 'plan item prompt'); text(x.phase, 40, 'plan item'); text(x.role, 40, 'plan item');
      if (typeof x.parallel !== 'boolean' || !Array.isArray(x.dependsOn) || x.dependsOn.some((d) => !Number.isSafeInteger(d))) throw new OrgSchemaError('invalid plan item');
      if (hasHiddenChars(String(x.title)) || hasHiddenChars(String(x.prompt))) throw new OrgSchemaError('a plan item has hidden characters');
    }
    if (p.lessons !== undefined) { if (!Array.isArray(p.lessons) || p.lessons.length > 20) throw new OrgSchemaError('invalid plan lessons'); for (const l of p.lessons) { const x = obj(l, ['id', 'text'], 'plan lesson'); text(x.id, 12, 'plan lesson'); text(x.text, 600, 'plan lesson'); } }
    if (p.citedLessons !== undefined && (!Array.isArray(p.citedLessons) || p.citedLessons.some((c) => typeof c !== 'string' || !(p.lessons as { id: string }[] | undefined)?.some((l) => l.id === c)))) throw new OrgSchemaError('a plan cites a lesson it was not given');
  }
  if (a.kind === 'chief_proposal') {
    const p = obj(a.proposal, ['situation', 'text', 'model'], 'proposal');
    text(p.situation, 300, 'proposal'); text(p.text, 1200, 'proposal'); text(p.model, 100, 'proposal');
  }
  if (a.kind === 'external_action') {
    const o = obj(a.outreach, ['campaignId', 'snapshotHash', 'channel', 'from', 'dailyCap', 'intervalSec', 'perRun', 'samples', 'recipients', 'excluded', 'draftedBy'], 'campaign send');
    text(o.campaignId, 12, 'campaign'); if (!/^[a-f0-9]{64}$/.test(String(o.snapshotHash)) || o.channel !== 'email') throw new OrgSchemaError('invalid campaign send');
    text(o.from, 254, 'campaign sender'); text(o.draftedBy, 80, 'campaign'); num(o.dailyCap, 'campaign cap'); num(o.intervalSec, 'campaign interval'); if (o.perRun !== undefined) num(o.perRun, 'campaign cap');
    if (!Array.isArray(o.recipients) || o.recipients.length > 500 || o.recipients.some((r) => typeof r !== 'string' || r.length > 254)) throw new OrgSchemaError('invalid campaign recipients');
    if (!Array.isArray(o.samples) || o.samples.length > 2) throw new OrgSchemaError('invalid campaign samples');
    for (const sm of o.samples) { const x = obj(sm, ['to', 'subject', 'text'], 'campaign sample'); text(x.to, 254, 'sample'); text(x.subject, 300, 'sample'); text(x.text, 25_000, 'sample'); }
    const e = obj(o.excluded, ['suppressed', 'invalid', 'unconfirmed'], 'excluded'); for (const k of Object.keys(e)) num(e[k], 'excluded');
  }
}

export class OrgSchemaError extends Error {
  constructor(message: string) { super(`${ORG_FILE}: ${message}`); this.name = 'OrgSchemaError'; }
}
type Rec = Record<string, unknown>;
function obj(value: unknown, keys: readonly string[], what: string): Rec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrgSchemaError(`${what} must be an object`);
  const extra = Object.keys(value).find((k) => !keys.includes(k));
  if (extra) throw new OrgSchemaError(`unexpected ${what} field ${extra.slice(0, 40)}`);
  return value as Rec;
}
const text = (v: unknown, max: number, what: string) => { if (typeof v !== 'string' || v.length > max) throw new OrgSchemaError(`invalid ${what}`); return v; };
const num = (v: unknown, what: string) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new OrgSchemaError(`invalid ${what}`); return v; };

function validateTool(v: unknown, what: string): ToolProposal {
  const t = obj(v, ['name', 'url', 'licence', 'enables', 'risk', 'approvalId', 'decision', 'decidedAt', 'decidedBy'], what);
  text(t.name, 120, what); text(t.licence, 120, what); text(t.enables, 300, what); text(t.risk, 300, what);
  if (typeof t.url !== 'string' || !/^https:\/\//.test(t.url) || t.url.length > 2048) throw new OrgSchemaError(`invalid ${what} url`);
  if (t.approvalId !== undefined && !APPROVAL_ID_RE.test(String(t.approvalId))) throw new OrgSchemaError(`invalid ${what} approval`);
  if (t.decision !== undefined && !['pending', 'approved', 'rejected'].includes(String(t.decision))) throw new OrgSchemaError(`invalid ${what} decision`);
  if (t.decidedAt !== undefined) num(t.decidedAt, what);
  if (t.decidedBy !== undefined) text(t.decidedBy, 80, what);
  return t as unknown as ToolProposal;
}

function validateSource(v: unknown): LessonSource {
  const s = obj(v, ['kind', 'ref', 'jobId', 'label'], 'lesson source');
  if (!['ceo_note', 'job', 'research'].includes(String(s.kind))) throw new OrgSchemaError('invalid lesson source');
  text(s.ref, 200, 'lesson source'); text(s.label, 200, 'lesson source');
  if (s.jobId !== undefined && !UUID.test(String(s.jobId))) throw new OrgSchemaError('invalid lesson source job');
  return s as unknown as LessonSource;
}

/** Strict reading of state/org.json. Unknown approval kinds are refused: cloud raises only CLOUD_APPROVAL_KINDS. */
export function validateOrg(value: unknown): CloudOrg {
  const o = obj(value, ['schemaVersion', 'nextApproval', 'nextLesson', 'approvals', 'lessons', 'research'], 'org');
  if (o.schemaVersion !== 1) throw new OrgSchemaError('unsupported schemaVersion');
  for (const k of ['nextApproval', 'nextLesson']) if (!Number.isSafeInteger(o[k]) || (o[k] as number) < 1) throw new OrgSchemaError(`invalid ${k}`);
  if (!Array.isArray(o.approvals) || o.approvals.length > ORG_LIMITS.approvals) throw new OrgSchemaError('invalid approvals');
  if (!Array.isArray(o.lessons) || o.lessons.length > ORG_LIMITS.lessons) throw new OrgSchemaError('invalid lessons');
  if (!Array.isArray(o.research) || o.research.length > ORG_LIMITS.research) throw new OrgSchemaError('invalid research');
  const ids = new Set<string>();
  for (const item of o.approvals) {
    const a = obj(item, ['id', 'kind', 'raisedBy', 'title', 'detail', 'jobId', 'createdAt', 'status', 'decidedAt', 'decidedBy', 'note', 'tool', 'lesson', 'proposedBy', 'plan', 'proposal', 'outreach'], 'approval');
    validateNewKinds(a);
    if (!APPROVAL_ID_RE.test(String(a.id)) || ids.has(String(a.id)) || Number(String(a.id).slice(1)) >= (o.nextApproval as number)) throw new OrgSchemaError('invalid approval id');
    ids.add(String(a.id));
    if (!CLOUD_APPROVAL_KINDS.includes(a.kind as never)) throw new OrgSchemaError(`approval kind ${String(a.kind).slice(0, 40)} is not raised in cloud mode`);
    if (a.raisedBy !== RAISED_BY[a.kind as Approval['kind']]) throw new OrgSchemaError('invalid approval executive');
    text(a.title, 200, 'approval title'); text(a.detail, 600, 'approval detail'); text(a.jobId, 80, 'approval job'); num(a.createdAt, 'approval time');
    if (!['pending', 'approved', 'rejected', 'resolved'].includes(String(a.status))) throw new OrgSchemaError('invalid approval status');
    if (a.decidedAt !== undefined) num(a.decidedAt, 'approval decision time');
    if (a.decidedBy !== undefined) text(a.decidedBy, 80, 'approval decider');
    if (a.note !== undefined) text(a.note, 300, 'approval note');
    // Review fix 3: a tool proposal's details are stored once, in its report (the game hydrates the item from it).
    if (a.kind === 'tool_proposal' && (a.lesson !== undefined || a.tool !== undefined)) throw new OrgSchemaError('a cloud tool proposal stores its tool in its report');
    if (a.kind === 'lesson') {
      if (a.tool !== undefined) throw new OrgSchemaError('lesson with a tool');
      const l = obj(a.lesson, ['lessonId', 'text', 'scope', 'scopeValue', 'source', 'proposedBy', 'supersedes', 'supersedesText', 'nonce'], 'approval lesson');
      if (!LESSON_ID.test(String(l.lessonId)) || !NONCE.test(String(l.nonce))) throw new OrgSchemaError('invalid approval lesson');
      if ('error' in checkLesson({ text: l.text, scope: l.scope, scopeValue: l.scopeValue }, 'ceo')) throw new OrgSchemaError('invalid approval lesson text');
      validateSource(l.source); text(l.proposedBy, 80, 'approval lesson');
      if (l.supersedes !== undefined && !LESSON_ID.test(String(l.supersedes))) throw new OrgSchemaError('invalid approval lesson');
      if (l.supersedesText !== undefined) text(l.supersedesText, 500, 'approval lesson');
    }
  }
  const lessonIds = new Set<string>();
  for (const item of o.lessons) {
    const l = obj(item, ['id', 'text', 'scope', 'scopeValue', 'source', 'status', 'proposedBy', 'proposedAt', 'decidedAt', 'decidedBy', 'retiredReason', 'supersedes', 'approvalId', 'uses', 'lastUsedAt', 'nonce'], 'lesson');
    if (!LESSON_ID.test(String(l.id)) || lessonIds.has(String(l.id)) || Number(String(l.id).slice(1)) >= (o.nextLesson as number)) throw new OrgSchemaError('invalid lesson id');
    lessonIds.add(String(l.id));
    if ('error' in checkLesson({ text: l.text, scope: l.scope, scopeValue: l.scopeValue }, 'ceo')) throw new OrgSchemaError('invalid lesson text');
    if (!['proposed', 'approved', 'retired'].includes(String(l.status)) || !NONCE.test(String(l.nonce))) throw new OrgSchemaError('invalid lesson');
    validateSource(l.source); text(l.proposedBy, 80, 'lesson'); num(l.proposedAt, 'lesson time');
    if (!Number.isSafeInteger(l.uses) || (l.uses as number) < 0) throw new OrgSchemaError('invalid lesson uses');
    if (l.approvalId !== undefined && !APPROVAL_ID_RE.test(String(l.approvalId))) throw new OrgSchemaError('invalid lesson approval');
    if (l.supersedes !== undefined && !LESSON_ID.test(String(l.supersedes))) throw new OrgSchemaError('invalid lesson supersedes');
    if (l.retiredReason !== undefined) text(l.retiredReason, 300, 'lesson');
    if (l.decidedAt !== undefined) num(l.decidedAt, 'lesson'); if (l.decidedBy !== undefined) text(l.decidedBy, 80, 'lesson');
    if (l.lastUsedAt !== undefined) num(l.lastUsedAt, 'lesson');
  }
  const jobs = new Set<string>();
  for (const item of o.research) {
    const r = obj(item, ['jobId', 'question', 'askedAt', 'status', 'reason', 'feasibility', 'confidence', 'sources', 'sections', 'importedAt', 'readAttempts', 'tools'], 'research');
    if (r.readAttempts !== undefined && (!Number.isSafeInteger(r.readAttempts) || (r.readAttempts as number) < 0 || (r.readAttempts as number) > ORG_LIMITS.readAttempts)) throw new OrgSchemaError('invalid research read attempts');
    if (!UUID.test(String(r.jobId)) || jobs.has(String(r.jobId))) throw new OrgSchemaError('invalid research job');
    jobs.add(String(r.jobId));
    text(r.question, MAX_QUESTION, 'research question'); num(r.askedAt, 'research time');
    if (!['queued', 'imported', 'needs_attention'].includes(String(r.status))) throw new OrgSchemaError('invalid research status');
    if (r.reason !== undefined) text(r.reason, ORG_LIMITS.reason, 'research reason');
    if (r.feasibility !== undefined && !FEASIBILITIES.includes(r.feasibility as Feasibility)) throw new OrgSchemaError('invalid feasibility');
    if (r.confidence !== undefined && !CONFIDENCES.includes(r.confidence as Confidence)) throw new OrgSchemaError('invalid confidence');
    if (r.sources !== undefined && !Number.isSafeInteger(r.sources)) throw new OrgSchemaError('invalid sources');
    if (r.importedAt !== undefined) num(r.importedAt, 'research import time');
    if (r.sections !== undefined) { const s = obj(r.sections, ['findings', 'canDoNow', 'cannotYet', 'proposedTools'], 'research sections'); for (const k of Object.keys(s)) text(s[k], ORG_LIMITS.section, 'research section'); }
    if (!Array.isArray(r.tools) || r.tools.length > 10) throw new OrgSchemaError('invalid research tools');
    r.tools.forEach((t) => validateTool(t, 'research tool'));
  }
  return JSON.parse(JSON.stringify(o)) as CloudOrg;
}

// ---------------------------------------------------------------- rules (coordinator)

export interface OrgCtx { now: number; intentId: string }

/** Raises one inbox item (dropping the oldest decided items when full; pending items are never dropped). */
export function raiseApproval(org: CloudOrg, fields: Omit<Approval, 'id' | 'raisedBy' | 'status'>): Approval {
  if (org.approvals.length >= ORG_LIMITS.approvals) {
    // Drop the oldest decided items first; pending items are never dropped.
    const decided = org.approvals.filter((a) => a.status !== 'pending').sort((a, b) => (a.decidedAt ?? a.createdAt) - (b.decidedAt ?? b.createdAt));
    const drop = new Set(decided.slice(0, org.approvals.length - ORG_LIMITS.decidedKept).map((a) => a.id));
    org.approvals = org.approvals.filter((a) => !drop.has(a.id));
    if (org.approvals.length >= ORG_LIMITS.approvals) refuse('inbox_full', `${ORG_LIMITS.approvals} items are waiting in the inbox. Decide some first.`);
  }
  const item: Approval = { id: `A${org.nextApproval++}`, raisedBy: RAISED_BY[fields.kind], status: 'pending', ...fields };
  org.approvals.push(item);
  return item;
}

const nonceFor = (intentId: string) => intentId.replace(/-/g, '').toLowerCase().slice(-16);
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface LessonInput { text: unknown; scope: unknown; scopeValue?: unknown; supersedes?: string; source?: { kind: 'job' | 'research'; ref: string } }

/** A CEO lesson (or an edit of an approved one) becomes a proposed lesson and one `lesson` inbox item. */
export function proposeLesson(org: CloudOrg, input: LessonInput, ctx: OrgCtx, jobs: readonly Pick<CloudJob, 'id' | 'title'>[]): CloudLesson {
  const checked = checkLesson(input, 'ceo');
  if ('error' in checked) return refuse('invalid_lesson', `Lesson refused: ${checked.error}.`);
  const fields = checked.ok;
  const old = input.supersedes ? org.lessons.find((l) => l.id === input.supersedes) : undefined;
  if (input.supersedes && old?.status !== 'approved') refuse('not_editable', `Only a lesson in use can be edited; ${input.supersedes} is not.`);
  if (org.lessons.some((l) => l.status !== 'retired' && l.id !== old?.id && sameLesson(l, fields)) || (old && sameLesson(old, fields))) refuse('duplicate_lesson', 'That lesson is already proposed or in use.');
  if (org.lessons.length >= ORG_LIMITS.lessons) refuse('memory_full', `Memory holds at most ${ORG_LIMITS.lessons} lessons.`);
  let source: LessonSource = { kind: 'ceo_note', ref: '', label: 'Written in the game' };
  if (input.source) {
    const { kind, ref } = input.source;
    const research = kind === 'research' ? org.research.find((r) => r.jobId === ref) : undefined;
    const job = jobs.find((j) => j.id === ref);
    if (kind === 'research' && !research) refuse('unknown_source', 'That research report is not in this Empire.');
    if (kind === 'job' && !job) refuse('unknown_source', 'That cloud job is not in the current job list.');
    source = kind === 'research'
      ? { kind, ref, label: `${SOURCE_LABEL.research} · “${short(research!.question, 80)}” · cited by the CEO` }
      : { kind, ref, jobId: ref, label: `${SOURCE_LABEL.job} · “${short(job!.title, 80)}” · cited by the CEO` };
  }
  const lesson: CloudLesson = {
    id: `L${org.nextLesson++}`, text: fields.text, scope: fields.scope, ...(fields.scopeValue ? { scopeValue: fields.scopeValue } : {}),
    source, status: 'proposed', proposedBy: 'CEO', proposedAt: ctx.now, uses: 0, nonce: nonceFor(ctx.intentId), ...(old ? { supersedes: old.id } : {}),
  };
  const item = raiseApproval(org, {
    kind: 'lesson', jobId: source.jobId ?? '', createdAt: ctx.now,
    title: old ? `Edit of lesson ${old.id}` : `Lesson ${lesson.id}: ${short(lesson.text, 70)}`,
    detail: `CEO proposes a ${lesson.scope === 'company' ? 'company-wide' : lesson.scope} lesson from ${SOURCE_LABEL[source.kind].toLowerCase()}. Approving makes it planning context; nothing else happens.`,
    lesson: { lessonId: lesson.id, text: lesson.text, scope: lesson.scope, ...(lesson.scopeValue ? { scopeValue: lesson.scopeValue } : {}), source: { ...source }, proposedBy: 'CEO',
      ...(old ? { supersedes: old.id, supersedesText: old.text } : {}), nonce: lesson.nonce },
  });
  lesson.approvalId = item.id;
  org.lessons.push(lesson);
  return lesson;
}

function resolveItem(org: CloudOrg, id: string | undefined, note: string, now: number) {
  const item = id ? org.approvals.find((a) => a.id === id) : undefined;
  if (item?.status === 'pending') Object.assign(item, { status: 'resolved', decidedAt: now, note });
}

function retire(org: CloudOrg, l: CloudLesson, reason: string, now: number) {
  const pending = l.status === 'proposed';
  Object.assign(l, { status: 'retired', retiredReason: reason, decidedAt: now, decidedBy: 'CEO' });
  if (pending) resolveItem(org, l.approvalId, reason, now);
}

/** Retiring takes effect at once; a waiting lesson's inbox item is resolved. Retiring a retired lesson is a duplicate. */
export function retireLesson(org: CloudOrg, lessonId: string, ctx: OrgCtx): 'applied' | 'duplicate' {
  const l = org.lessons.find((x) => x.id === lessonId) ?? refuse('lesson_not_found', `There is no lesson ${lessonId}.`);
  if (l.status === 'retired') return 'duplicate';
  retire(org, l, 'Retired by the CEO', ctx.now);
  return 'applied';
}

export interface DecisionInput { approvalId: string; decision: 'approve' | 'reject'; seen: string }

/**
 * Decides one cloud inbox item. Idempotent: repeating a decision already recorded is a duplicate and changes nothing.
 * The decision applies only if `seen` (the fingerprint of the item as the CEO was shown it) matches the item now.
 */
export function decideApproval(org: CloudOrg, input: DecisionInput, ctx: OrgCtx): 'applied' | 'duplicate' {
  const item = org.approvals.find((a) => a.id === input.approvalId) ?? refuse('approval_not_found', `There is no inbox item ${input.approvalId} in this Empire.`);
  const wanted = input.decision === 'approve' ? 'approved' : 'rejected';
  if (item.status !== 'pending') {
    if (item.status === wanted) return 'duplicate';
    return refuse('already_decided', `${item.id} was already ${item.status === 'resolved' ? 'resolved' : item.status === 'approved' ? 'approved' : 'declined'}; nothing changed.`);
  }
  if (approvalFingerprint(hydrate(org, item)) !== input.seen) refuse('stale_view', `${item.id} changed after you opened it, so nothing was decided. Open it again and review what it says now.`);
  if (item.kind === 'lesson') {
    const l = org.lessons.find((x) => x.id === item.lesson?.lessonId);
    // FREE-10 guard: the item must have been raised for exactly this proposal (id, text, scope and nonce).
    if (!l || l.status !== 'proposed' || l.approvalId !== item.id || !lessonItemMatches(item, l)) refuse('lesson_mismatch', `${item.id} no longer matches its lesson, so nothing was decided.`);
    if (wanted === 'approved') {
      Object.assign(l!, { status: 'approved', decidedAt: ctx.now, decidedBy: 'CEO' });
      const old = l!.supersedes ? org.lessons.find((x) => x.id === l!.supersedes) : undefined;
      if (old && old.status !== 'retired') retire(org, old, `Replaced by ${l!.id}`, ctx.now);
    } else Object.assign(l!, { status: 'retired', retiredReason: 'Declined by CEO', decidedAt: ctx.now, decidedBy: 'CEO' });
  } else if (item.kind === 'tool_proposal') {
    const tool = org.research.find((r) => r.jobId === item.jobId)?.tools.find((t) => t.approvalId === item.id);
    if (!tool) refuse('tool_mismatch', `${item.id} no longer matches a research report, so nothing was decided.`);
    Object.assign(tool!, { decision: wanted, decidedAt: ctx.now, decidedBy: 'CEO' });
  } else if (item.kind !== 'job_plan' && item.kind !== 'chief_proposal' && item.kind !== 'external_action') refuse('not_in_cloud', 'That kind of item is not decided in cloud mode.');
  // FREE-11: a plan or chief proposal records the decision only. FREE-12: a campaign send is checked against its
  // snapshot by the coordinator before this, and starts sending after it (src/cloud/outreach.ts).
  Object.assign(item, { status: wanted, decidedAt: ctx.now, decidedBy: 'CEO' });
  return 'applied';
}

// ---------------------------------------------------------------- research

export const researchPath = (jobId: string) => `${RESEARCH_DIR}/${jobId}.md`;
/** The worker's prompt for a cloud research job: the shared ORG-05 prompt, naming this job's report file. */
export const cloudResearchPrompt = (question: string, jobId: string) => researchPrompt(question).replaceAll('{{jobId}}', jobId);
export const researchTitle = (question: string) => short(`Research: ${question.replace(/\s+/g, ' ')}`, 120);

/** Validates a research question like the server does: 1–500 printable characters. */
export function checkQuestion(question: unknown): string {
  if (typeof question !== 'string' || !question.trim()) return refuse('invalid_question', 'Write a research question first.');
  const q = question.trim();
  if (q.length > MAX_QUESTION) refuse('invalid_question', `A research question is at most ${MAX_QUESTION} characters.`);
  if (hasHiddenChars(q.replace(/\n/g, ' '))) refuse('invalid_question', 'The question contains invisible or control characters.');
  return q;
}

export function addResearch(org: CloudOrg, jobId: string, question: string, now: number) {
  if (org.research.some((r) => r.jobId === jobId)) return;
  if (org.research.length >= ORG_LIMITS.research) {
    // Drop the oldest finished report whose tools are all decided.
    const old = org.research.filter((r) => r.status !== 'queued' && r.tools.every((t) => t.decision !== 'pending')).sort((a, b) => a.askedAt - b.askedAt)[0];
    if (!old) refuse('research_full', `${ORG_LIMITS.research} research reports are open. Decide their tool proposals first.`);
    org.research = org.research.filter((r) => r !== old);
  }
  org.research.push({ jobId, question, askedAt: now, status: 'queued', tools: [] });
}

/** Reports to read from their task branch this run: queued, and the job's turn has finished (awaiting or past review). */
export function researchDue(org: CloudOrg, jobs: readonly CloudJob[]): { jobId: string; branch: string }[] {
  // Review fix 4: reports with fewer failed reads go first, so a few stuck reports can't starve the rest.
  return org.research.filter((r) => r.status === 'queued').sort((a, b) => (a.readAttempts ?? 0) - (b.readAttempts ?? 0) || a.askedAt - b.askedAt).flatMap((r) => {
    const job = jobs.find((j) => j.id === r.jobId);
    return job && ['awaiting_review', 'accepted', 'rejected'].includes(job.status) ? [{ jobId: r.jobId, branch: job.branch }] : [];
  });
}

export type BranchFile = { state: 'found'; text: string; bytes: number } | { state: 'missing' } | { state: 'refused'; reason: string } | { state: 'unknown'; reason: string } | { state: 'unsupported' };

// ---------------------------------------------------------------- review fixes 1 and 3: always readable, always bounded

export const orgBytes = (org: CloudOrg) => new TextEncoder().encode(JSON.stringify(org, null, 2) + '\n').length;

/**
 * Keeps state/org.json under ORG_MAX_BYTES: drops the oldest finished reports whose tools are all decided, then the
 * oldest decided inbox items. Pending items, waiting lessons and queued reports are never dropped; if they alone are too
 * big the change is refused (OrgRuleError), so the caller keeps the previous state.
 */
export function fitOrg(org: CloudOrg): void {
  while (orgBytes(org) > ORG_MAX_BYTES) {
    const report = org.research.filter((r) => r.status !== 'queued' && r.tools.every((t) => t.decision !== 'pending')).sort((a, b) => a.askedAt - b.askedAt)[0];
    if (report) { org.research = org.research.filter((r) => r !== report); continue; }
    const decided = org.approvals.filter((a) => a.status !== 'pending').sort((a, b) => (a.decidedAt ?? a.createdAt) - (b.decidedAt ?? b.createdAt)).slice(0, 10);
    if (decided.length) { const drop = new Set(decided); org.approvals = org.approvals.filter((a) => !drop.has(a)); continue; }
    refuse('org_full', 'The organization file is full of waiting items. Decide some inbox items first.');
  }
}

/** The coordinator writes only what it can read back: the size budget, then the same validation readers apply. */
export function checkOrg(org: CloudOrg): void {
  fitOrg(org);
  try { validateOrg(JSON.parse(JSON.stringify(org))); }
  catch (error) { refuse('org_invalid', `The change would leave the organization unreadable (${error instanceof Error ? short(error.message, 120) : 'invalid'}), so it was not made.`); }
}

/** The inbox item as shown: a tool proposal gets its tool from its report (stored once). */
export function hydrate(org: CloudOrg, item: Approval): Approval {
  if (item.kind !== 'tool_proposal') return item;
  const tool = org.research.find((r) => r.jobId === item.jobId)?.tools.find((t) => t.approvalId === item.id);
  return tool ? { ...item, tool: { name: tool.name, url: tool.url, licence: tool.licence, enables: tool.enables, risk: tool.risk } } : item;
}

const clipSections = (s: ResearchSections): ResearchSections =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.length > ORG_LIMITS.section ? `${v.slice(0, ORG_LIMITS.section - 40)}\n… (shortened; full report on the task branch)` : v])) as unknown as ResearchSections;

/**
 * Records what reading the reports gave, and settles reports whose job ended without a finished turn. A report is
 * imported once; a refused report needs attention with the reason (ask again to retry). An unknown read is retried.
 */
export function recordResearch(org: CloudOrg, jobs: readonly CloudJob[], reads: Record<string, BranchFile>, now: number): void {
  const attention = (r: CloudResearch, reason: string) => { Object.assign(r, { status: 'needs_attention', reason: short(reason, ORG_LIMITS.reason) }); delete r.readAttempts; };
  for (const jobId of org.research.filter((x) => x.status === 'queued').map((x) => x.jobId)) {
    const r = org.research.find((x) => x.jobId === jobId);
    if (!r) continue; // dropped by the size budget while importing an earlier report
    const job = jobs.find((j) => j.id === r.jobId);
    if (!job) { attention(r, 'The research job is no longer in the job list, so its report was not read.'); continue; }
    if (['failed', 'cancelled'].includes(job.status)) { attention(r, `The research job ${job.status === 'failed' ? 'failed' : 'was cancelled'} before a finished turn, so there is no report. Ask again to retry.`); continue; }
    const read = reads[r.jobId];
    if (!read) continue;
    if (read.state === 'unknown') {
      // Review fix 4: network trouble is retried, but only a few times.
      r.readAttempts = (r.readAttempts ?? 0) + 1;
      if (r.readAttempts >= ORG_LIMITS.readAttempts) attention(r, `The coordinator tried ${r.readAttempts} times and could not read the report (${short(read.reason, 120)}). Ask again to retry.`);
      else r.reason = `The report could not be read yet (${short(read.reason, 160)}); the coordinator tries again next run.`;
      continue;
    }
    if (read.state === 'unsupported') { attention(r, 'This execution cannot read files from the task branch, so the report was not imported.'); continue; }
    if (read.state === 'refused') { attention(r, `Report not accepted: ${read.reason}`); continue; }
    if (read.state === 'missing') { attention(r, `The worker did not commit ${researchPath(r.jobId)} to its branch. Ask again to retry.`); continue; }
    if (read.bytes > MAX_ARTIFACT_BYTES) { attention(r, `The report is larger than ${MAX_ARTIFACT_BYTES / 1024} KB.`); continue; }
    const parsed = parseResearchReport(parseArtifact(read.text));
    if (!parsed.ok) { attention(r, `Report not accepted: ${parsed.reason}`); continue; }
    // Review fixes 1–3: import on a copy; keep it only if the result fits the budget and reads back. Otherwise the
    // report needs attention with the reason and the previous organization stays as it was.
    const before = JSON.stringify(org);
    try {
      delete r.reason; delete r.readAttempts;
      Object.assign(r, { status: 'imported', feasibility: parsed.feasibility, confidence: parsed.confidence, sources: parsed.sources, sections: clipSections(parsed.sections), importedAt: now });
      r.tools = parsed.tools.map((t) => ({ ...t, decision: 'pending' as const }));
      for (const tool of r.tools) {
        const item = raiseApproval(org, {
          kind: 'tool_proposal', jobId: r.jobId, createdAt: now,
          title: `Tool proposal: ${short(tool.name, 80)}`,
          detail: short(`Sam · Research proposes it in the report on “${r.question}”. Approving records your decision only.`, 600),
        });
        tool.approvalId = item.id;
      }
      checkOrg(org);
    } catch (error) {
      Object.assign(org, JSON.parse(before));
      const back = org.research.find((x) => x.jobId === jobId);
      const why = error instanceof OrgRuleError && error.code === 'inbox_full'
        ? `The inbox already has ${ORG_LIMITS.approvals} items, so this report's tool proposals could not be raised. Decide some inbox items, then ask again.`
        : error instanceof OrgRuleError ? error.message : 'The report could not be recorded.';
      if (back) attention(back, why);
    }
  }
}

// ---------------------------------------------------------------- views (the game)

/** The inbox as the game reads it in cloud mode: pending first, then the 30 most recent decisions. */
export function cloudApprovals(org: CloudOrg, revision: number, storageError?: string): ApprovalsState {
  const pending = org.approvals.filter((a) => a.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  const decided = org.approvals.filter((a) => a.status !== 'pending').sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0)).slice(0, 30);
  return { schemaVersion: 1, revision, items: [...pending, ...decided].map((a) => hydrate(org, a)), pending: pending.length, ...(storageError ? { storageError } : {}) };
}

const reportStatus = (r: CloudResearch, job: CloudJob | undefined): ResearchReportSummary['status'] =>
  r.status !== 'queued' ? r.status : job && ['dispatching', 'dispatch_uncertain', 'running', 'waiting_for_approval', 'budget_paused', 'idle', 'unknown', 'awaiting_review', 'accepted', 'rejected'].includes(job.status) ? 'running' : 'queued';

export function cloudResearchReport(org: CloudOrg, jobs: readonly CloudJob[], jobId: string): ResearchReport | undefined {
  const r = org.research.find((x) => x.jobId === jobId);
  if (!r) return undefined;
  const job = jobs.find((j) => j.id === r.jobId);
  return {
    jobId: r.jobId, question: r.question, askedAt: r.askedAt, askedBy: 'CEO', status: reportStatus(r, job),
    ...(r.reason ? { reason: r.reason } : {}), ...(r.feasibility ? { feasibility: r.feasibility } : {}), ...(r.confidence ? { confidence: r.confidence } : {}),
    worker: job?.provider === 'github-actions' ? 'your GitHub Actions worker' : 'your cloud worker',
    ...(r.importedAt ? { importedAt: r.importedAt } : {}), ...(job?.cost && job.cost.basis === 'provider_reported_list_cost' ? { costUsd: job.cost.amountCents / 100 } : {}),
    ...(r.sources !== undefined ? { sources: r.sources } : {}), tools: r.tools.map((t) => ({ ...t })), ...(r.sections ? { sections: { ...r.sections } } : {}),
  };
}

export function cloudResearch(org: CloudOrg, jobs: readonly CloudJob[]): ResearchState {
  const reports = [...org.research].sort((a, b) => b.askedAt - a.askedAt).map((r) => { const { sections: _s, ...summary } = cloudResearchReport(org, jobs, r.jobId)!; return summary; });
  return { schemaVersion: 1, reports, openProposals: org.research.reduce((n, r) => n + r.tools.filter((t) => t.decision === 'pending').length, 0) };
}

export function cloudMemory(org: CloudOrg): MemoryState {
  return { schemaVersion: 1, lessons: org.lessons.map(({ nonce: _n, ...l }) => l) };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The executives in cloud mode: rule-based, computed only from the snapshot (jobs, spend ledger, research, inbox).
 * Nothing here calls a model, and the game shows the snapshot's age next to it.
 */
export function cloudExecutives(state: Pick<CloudState, 'jobs' | 'ledger' | 'meta'>, org: CloudOrg, now: number): OrgState {
  const jobs = state.jobs.jobs;
  const count = (...s: CloudJob['status'][]) => jobs.filter((j) => s.includes(j.status)).length;
  const pending = (kind: Approval['kind']) => org.approvals.filter((a) => a.kind === kind && a.status === 'pending').length;
  const active = count('dispatching', 'running', 'waiting_for_approval', 'budget_paused', 'idle', 'unknown');
  const day = state.ledger.days[new Date(now).toISOString().slice(0, 10)] ?? { reservedCents: 0, observedCostCents: 0 };
  const imported = org.research.filter((r) => r.status === 'imported').length;
  const researching = org.research.filter((r) => r.status === 'queued').length;
  const attention = org.research.filter((r) => r.status === 'needs_attention').length;
  const e = (role: Executive['role'], summary: string, att = 0): Executive => ({ role, name: EXECUTIVES[role].name, monitor: 'rule_based', active: true, summary, attention: att });
  return {
    schemaVersion: 1, observedAt: now,
    executives: [
      e('chief_of_staff', [`${count('queued')} queued`, `${active} active`, `${count('awaiting_review')} awaiting your review`, ...(pending('lesson') ? [plural(pending('lesson'), 'lesson') + ' to decide'] : [])].join(' · '), pending('lesson')),
      e('operations', [`Up to ${state.meta.limits.maxConcurrent} at once`, ...(count('dispatch_uncertain') ? [`${plural(count('dispatch_uncertain'), 'uncertain dispatch', 'uncertain dispatches')} to resolve in Cloud Empire → Jobs`] : []), `${count('failed')} failed`].join(' · ')),
      e('finance', `Today ${usd(day.reservedCents)} reserved · ${usd(day.observedCostCents)} provider-reported of ${usd(state.meta.limits.dailyBudgetCents)} a day · ${usd(state.meta.limits.perTaskBudgetCents)} per job`),
      e('marketing_sales', ORG_CAPABILITIES.outreach.cloudSummary),
      e('research', [plural(imported, 'report'), `${researching} in progress`, ...(attention ? [`${attention} need${attention === 1 ? 's' : ''} attention`] : [])].join(' · '), pending('tool_proposal')),
    ],
  };
}

export type { LessonScope };
