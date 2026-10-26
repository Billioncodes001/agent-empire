/**
 * Client intents. A client never writes `state/`; it adds exactly one file `intents/<id>.json` per
 * intent. The coordinator validates, applies or rejects each intent once and deletes the file in the
 * same commit that records the outcome.
 */
import { SITES, type EmpireAction, type SiteId } from '../shared/empire.js';
import { ExecutionError } from '../server/execution-errors.js';
import { TASK_ID, validateSubmit } from '../server/execution-validation.js';
import { INTENT_PATH, validateExecution, validateLimits, validateProvisionRepository, type CloudExecution, type CloudLimits } from './schema.js';
import type { ExecutionConfig } from '../shared/execution.js';
import { isWorkerModel, type WorkerModel } from './worker-spec.js';
import { APPROVAL_ID_RE, FINGERPRINT_RE } from '../shared/approvals.js';
import { checkLesson } from '../shared/lesson-rules.js';
import type { LessonScope } from '../shared/memory.js';
import { checkQuestion } from './org.js';
import { BrainRuleError, checkBrainRequest, checkBrainSettings, type BrainRequest } from './brain.js';
import { OutreachRuleError, SUPPRESSION_REASONS, checkCampaign, checkLeads, checkOutreachSettings, type CloudCampaign, type CloudLead, type OutreachSettings, type SuppressionReason } from './outreach.js';

export const MAX_INTENT_BYTES = 64 * 1024;

interface IntentBase { schemaVersion: 1; id: string; createdAt: number }
export type CloudIntent = IntentBase & (
  /** Paid work. `confirmPaid` and the current `configRevision` prove the user saw the current limits. */
  | { kind: 'new_job'; job: { id: string; title: string; prompt: string; site?: SiteId; configRevision: number; confirmPaid: true } }
  /** Review of a finished turn: accept (credits the city once) or reject. Neither verifies code. */
  | { kind: 'review'; jobId: string; decision: 'accept' | 'reject'; note?: string }
  | { kind: 'cancel'; jobId: string }
  /** The user's decision about an uncertain dispatch after inspecting the provider Console. */
  | { kind: 'resolve_uncertain'; jobId: string; resolution: 'not_dispatched' | 'attach_session'; sessionId?: string }
  | { kind: 'shutdown' }
  | { kind: 'start' }
  | { kind: 'limits'; limits: CloudLimits; configRevision: number }
  | { kind: 'configure'; execution: CloudExecution; configRevision: number }
  /** Ask the coordinator to find or create the Anthropic agent and environment for this project (free; no session). */
  | { kind: 'provision'; repository: ExecutionConfig['repository']; model?: WorkerModel; configRevision: number }
  | { kind: 'empire_action'; action: EmpireAction }
  /**
   * FREE-07: decide a cloud inbox item (tool proposal or lesson). `seen` is the approvalFingerprint of the item as the
   * CEO was shown it; the coordinator refuses the decision if the item changed. Neither kind moves money.
   */
  | { kind: 'approval_decision'; approvalId: string; decision: 'approve' | 'reject'; seen: string }
  /** FREE-07: a CEO lesson (or an edit of an approved one, `supersedes`), proposed into the inbox. */
  | { kind: 'lesson_propose'; lesson: { text: string; scope: LessonScope; scopeValue?: string; supersedes?: string; source?: { kind: 'job' | 'research'; ref: string } } }
  | { kind: 'lesson_retire'; lessonId: string }
  /** FREE-07: a research question as paid cloud work; `job` carries the same paid confirmation as `new_job`. */
  | { kind: 'research'; question: string; job: { id: string; configRevision: number; confirmPaid: true } }
  /** FREE-11: the chief's brain settings. Premium carries the paid confirmation; a free tier names the terms accepted. */
  | { kind: 'brain_settings'; settings: ReturnType<typeof checkBrainSettings>; confirmPaid?: true }
  /** FREE-11: ask the chief's model for a plan, a review of a finished job, or an unblock idea. Always a proposal. */
  | { kind: 'brain_request'; request: Pick<BrainRequest, 'kind' | 'title' | 'client' | 'brief' | 'jobId'> }
  /** FREE-12: sender identity and caps; acknowledgePrivacy confirms the CEO read the personal-data warning. */
  | { kind: 'outreach_settings'; settings: Omit<OutreachSettings, 'acknowledgedAt'>; acknowledgePrivacy: true }
  | { kind: 'outreach_leads'; leads: Omit<CloudLead, 'id' | 'addedAt'>[] }
  /** FREE-12: an opt-out as its salted hash only (the game hashes the address), so the address never enters the repository. */
  | { kind: 'outreach_suppress'; hash: string; reason: SuppressionReason }
  | { kind: 'outreach_campaign'; campaign: Pick<CloudCampaign, 'title' | 'subject' | 'body' | 'audience'> }
  | { kind: 'outreach_cancel'; campaignId: string }
  | { kind: 'outreach_delete_leads'; confirm: true }
);
export type IntentKind = CloudIntent['kind'];
export const INTENT_KINDS: readonly IntentKind[] = ['new_job', 'review', 'cancel', 'resolve_uncertain', 'shutdown', 'start', 'limits', 'configure', 'provision', 'empire_action', 'approval_decision', 'lesson_propose', 'lesson_retire', 'research', 'brain_settings', 'brain_request', 'outreach_settings', 'outreach_leads', 'outreach_suppress', 'outreach_campaign', 'outreach_cancel', 'outreach_delete_leads'];

export class IntentError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'IntentError'; }
}
const bad = (message: string, code = 'invalid_intent') => new IntentError(code, message);
/** FREE-11/12: a rule refusal becomes an intent refusal with the same user-safe message. */
const rule = <T>(run: () => T): T => { try { return run(); } catch (error) { if (error instanceof BrainRuleError || error instanceof OutreachRuleError) throw bad(error.message, error.code); throw error; } };

function rec(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('Intent fields must be objects.');
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) throw bad(`Unexpected intent field "${extra[0].slice(0, 40)}".`);
  return value as Record<string, unknown>;
}
const configRevision = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw bad('configRevision must be a non-negative integer.');
  return value as number;
};
const jobId = (value: unknown) => {
  if (typeof value !== 'string' || !TASK_ID.test(value)) throw bad('jobId must be a UUID.');
  return value.toLowerCase();
};
const EMPIRE_ACTION_KINDS = ['delegate', 'found', 'build', 'hire', 'buy-land', 'upgrade', 'reinvest', 'office-floor', 'office-workstation', 'buy-plot', 'buy-vehicle', 'vehicle-spawn', 'vehicle-store', 'buy-helicopter'];

/** Intent id from a path, used to record a rejection even when the body is unreadable. */
export function intentIdFromPath(path: string): string | undefined {
  return INTENT_PATH.exec(path)?.[1];
}

/** Parses and validates one intent file. Throws IntentError with a user-safe reason. */
export function parseIntent(path: string, text: string): CloudIntent {
  const fileId = intentIdFromPath(path);
  if (!fileId) throw bad('Intent files must be named intents/<uuid>.json.');
  if (text.length > MAX_INTENT_BYTES) throw bad('Intent file is larger than 64 KiB.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw bad('Intent file is not valid JSON.'); }
  const base = rec(value, ['schemaVersion', 'id', 'createdAt', 'kind', 'job', 'jobId', 'decision', 'note', 'resolution', 'sessionId', 'limits', 'configRevision', 'execution', 'repository', 'model', 'action', 'approvalId', 'seen', 'lesson', 'lessonId', 'question', 'settings', 'confirmPaid', 'request', 'acknowledgePrivacy', 'leads', 'hash', 'reason', 'campaign', 'campaignId', 'confirm']);
  if (base.schemaVersion !== 1) throw bad('Unsupported intent schemaVersion.');
  if (typeof base.id !== 'string' || !TASK_ID.test(base.id)) throw bad('Intent id must be a UUID.');
  if (base.id.toLowerCase() !== fileId.toLowerCase()) throw bad('Intent id does not match its file name.');
  if (typeof base.createdAt !== 'number' || !Number.isFinite(base.createdAt) || base.createdAt < 0) throw bad('Intent createdAt must be a timestamp.');
  const common = { schemaVersion: 1 as const, id: base.id.toLowerCase(), createdAt: base.createdAt };
  const allow = (keys: string[]) => rec(value, ['schemaVersion', 'id', 'createdAt', 'kind', ...keys]);
  switch (base.kind) {
    case 'new_job': {
      allow(['job']);
      const job = rec(base.job, ['id', 'title', 'prompt', 'site', 'configRevision', 'confirmPaid']);
      let submit;
      // Reuse the host submission rules: UUID id, 1–20,000 char prompt, explicit paid confirmation.
      try { submit = validateSubmit({ id: job.id, prompt: job.prompt, configRevision: job.configRevision, confirmPaid: job.confirmPaid }); }
      catch (error) { throw bad(error instanceof ExecutionError ? error.message : 'Invalid job.', error instanceof ExecutionError ? error.code : 'invalid_intent'); }
      if (typeof job.title !== 'string' || !job.title.trim() || job.title.length > 120 || /[\x00-\x1f\x7f]/.test(job.title)) throw bad('Job title must be 1–120 printable characters.');
      if (job.site !== undefined && !SITES.some(s => s.id === job.site)) throw bad('Unknown sector site.');
      return { ...common, kind: 'new_job', job: { id: submit.id, title: job.title.trim(), prompt: submit.prompt, ...(job.site ? { site: job.site as SiteId } : {}), configRevision: submit.configRevision, confirmPaid: true } };
    }
    case 'review': {
      allow(['jobId', 'decision', 'note']);
      if (base.decision !== 'accept' && base.decision !== 'reject') throw bad('Review decision must be accept or reject.');
      if (base.note !== undefined && (typeof base.note !== 'string' || base.note.length > 500)) throw bad('Review note must be at most 500 characters.');
      return { ...common, kind: 'review', jobId: jobId(base.jobId), decision: base.decision, ...(base.note ? { note: base.note as string } : {}) };
    }
    case 'cancel':
      allow(['jobId']);
      return { ...common, kind: 'cancel', jobId: jobId(base.jobId) };
    case 'resolve_uncertain': {
      allow(['jobId', 'resolution', 'sessionId']);
      if (base.resolution === 'not_dispatched') { if (base.sessionId !== undefined) throw bad('not_dispatched takes no sessionId.'); return { ...common, kind: 'resolve_uncertain', jobId: jobId(base.jobId), resolution: 'not_dispatched' }; }
      if (base.resolution === 'attach_session') {
        // Anthropic session (sesn_…) or GitHub Actions run (ghrun_<run id>); the coordinator checks it matches the job's provider.
        if (typeof base.sessionId !== 'string' || !/^(sesn_[A-Za-z0-9]{8,100}|ghrun_[1-9][0-9]{0,19})$/.test(base.sessionId)) throw bad('attach_session needs a provider session ID or a GitHub Actions run ID (ghrun_<id>).');
        return { ...common, kind: 'resolve_uncertain', jobId: jobId(base.jobId), resolution: 'attach_session', sessionId: base.sessionId };
      }
      throw bad('resolution must be not_dispatched or attach_session.');
    }
    case 'shutdown': allow([]); return { ...common, kind: 'shutdown' };
    case 'start': allow([]); return { ...common, kind: 'start' };
    case 'limits': {
      allow(['limits', 'configRevision']);
      let limits: CloudLimits;
      try { limits = validateLimits(base.limits); } catch { throw bad('Limits must be 1–10 concurrent jobs, a per-job allowance of 1–100,000 cents and a daily allowance between the per-job allowance and 10,000,000 cents.'); }
      return { ...common, kind: 'limits', limits, configRevision: configRevision(base.configRevision) };
    }
    case 'configure': {
      allow(['execution', 'configRevision']);
      let execution: CloudExecution;
      try { execution = validateExecution(base.execution); } catch { throw bad('Execution references are invalid. Only repository and provider references belong here, never credentials.'); }
      return { ...common, kind: 'configure', execution, configRevision: configRevision(base.configRevision) };
    }
    case 'provision': {
      allow(['repository', 'model', 'configRevision']);
      if (base.model !== undefined && !isWorkerModel(base.model)) throw bad('Unsupported worker model.');
      let repository: ExecutionConfig['repository'];
      try { repository = validateProvisionRepository(base.repository); } catch { throw bad('The project repository must be an owner, a name and a base branch.'); }
      return { ...common, kind: 'provision', repository, ...(base.model ? { model: base.model as WorkerModel } : {}), configRevision: configRevision(base.configRevision) };
    }
    case 'empire_action': {
      allow(['action']);
      const action = base.action as Record<string, unknown> | undefined;
      if (!action || typeof action !== 'object' || !EMPIRE_ACTION_KINDS.includes(String(action.kind))) throw bad('Unsupported city action. Manager retries are submitted as new jobs in cloud mode.');
      if (action.kind === 'found') rec(action, ['kind', 'sites']);
      else if (action.kind === 'delegate') rec(action, ['kind', 'enabled']);
      else if (['build', 'hire', 'buy-land', 'upgrade'].includes(String(action.kind))) rec(action, ['kind', 'site']);
      else if (action.kind === 'buy-plot') rec(action, ['kind', 'plot', 'nonce']);
      else if (action.kind === 'buy-vehicle') rec(action, ['kind', 'model', 'nonce']);
      else if (action.kind === 'vehicle-spawn') rec(action, ['kind', 'vehicle', 'blocked']);
      else if (action.kind === 'vehicle-store') rec(action, ['kind', 'vehicle']);
      else if (action.kind === 'buy-helicopter') rec(action, ['kind', 'nonce']);
      else rec(action, ['kind']);
      return { ...common, kind: 'empire_action', action: JSON.parse(JSON.stringify(action)) as EmpireAction };
    }
    case 'approval_decision': {
      allow(['approvalId', 'decision', 'seen']);
      if (typeof base.approvalId !== 'string' || !APPROVAL_ID_RE.test(base.approvalId)) throw bad('approvalId must look like A3.');
      if (base.decision !== 'approve' && base.decision !== 'reject') throw bad('An inbox decision must be approve or reject.');
      if (typeof base.seen !== 'string' || !FINGERPRINT_RE.test(base.seen)) throw bad('An inbox decision must name the item as you saw it (seen).');
      return { ...common, kind: 'approval_decision', approvalId: base.approvalId, decision: base.decision, seen: base.seen };
    }
    case 'lesson_propose': {
      allow(['lesson']);
      const l = rec(base.lesson, ['text', 'scope', 'scopeValue', 'supersedes', 'source']);
      const checked = checkLesson({ text: l.text, scope: l.scope, scopeValue: l.scopeValue }, 'ceo');
      if ('error' in checked) throw bad(`Lesson refused: ${checked.error}.`);
      if (l.supersedes !== undefined && (typeof l.supersedes !== 'string' || !/^L[1-9]\d{0,8}$/.test(l.supersedes))) throw bad('supersedes must name a lesson like L3.');
      let source: { kind: 'job' | 'research'; ref: string } | undefined;
      if (l.source !== undefined) {
        const s = rec(l.source, ['kind', 'ref']);
        if ((s.kind !== 'job' && s.kind !== 'research') || typeof s.ref !== 'string' || !TASK_ID.test(s.ref)) throw bad('A lesson source is a cloud job or research report id.');
        source = { kind: s.kind, ref: s.ref.toLowerCase() };
      }
      return { ...common, kind: 'lesson_propose', lesson: { text: checked.ok.text, scope: checked.ok.scope, ...(checked.ok.scopeValue ? { scopeValue: checked.ok.scopeValue } : {}), ...(l.supersedes ? { supersedes: l.supersedes as string } : {}), ...(source ? { source } : {}) } };
    }
    case 'lesson_retire':
      allow(['lessonId']);
      if (typeof base.lessonId !== 'string' || !/^L[1-9]\d{0,8}$/.test(base.lessonId)) throw bad('lessonId must look like L3.');
      return { ...common, kind: 'lesson_retire', lessonId: base.lessonId };
    case 'research': {
      allow(['question', 'job']);
      let question: string;
      try { question = checkQuestion(base.question); } catch (error) { throw bad(error instanceof Error ? error.message : 'Invalid question.'); }
      const job = rec(base.job, ['id', 'configRevision', 'confirmPaid']);
      let submit;
      // The same paid confirmation as new_job: UUID id, current configRevision, confirmPaid: true.
      try { submit = validateSubmit({ id: job.id, prompt: question, configRevision: job.configRevision, confirmPaid: job.confirmPaid }); }
      catch (error) { throw bad(error instanceof ExecutionError ? error.message : 'Invalid research job.', error instanceof ExecutionError ? error.code : 'invalid_intent'); }
      return { ...common, kind: 'research', question, job: { id: submit.id, configRevision: submit.configRevision, confirmPaid: true } };
    }
    case 'brain_settings': {
      allow(['settings', 'confirmPaid']);
      if (base.confirmPaid !== undefined && base.confirmPaid !== true) throw bad('confirmPaid must be true when present.');
      if (!base.settings || typeof base.settings !== 'object' || Array.isArray(base.settings)) throw bad('Brain settings must be an object.');
      const settings = rule(() => checkBrainSettings(base.settings as Record<string, unknown>, { confirmPaid: base.confirmPaid }));
      return { ...common, kind: 'brain_settings', settings, ...(base.confirmPaid === true ? { confirmPaid: true as const } : {}) };
    }
    case 'brain_request': {
      allow(['request']);
      if (!base.request || typeof base.request !== 'object' || Array.isArray(base.request)) throw bad('A brain request must be an object.');
      return { ...common, kind: 'brain_request', request: rule(() => checkBrainRequest(base.request as Record<string, unknown>, (v) => typeof v === 'string' && TASK_ID.test(v))) };
    }
    case 'outreach_settings': {
      allow(['settings', 'acknowledgePrivacy']);
      if (base.acknowledgePrivacy !== true) throw bad('Acknowledge the privacy warning first (acknowledgePrivacy): leads and opt-outs are personal data kept in your state repository and its git history.');
      if (!base.settings || typeof base.settings !== 'object' || Array.isArray(base.settings)) throw bad('Outreach settings must be an object.');
      return { ...common, kind: 'outreach_settings', settings: rule(() => checkOutreachSettings(base.settings as Record<string, unknown>)), acknowledgePrivacy: true };
    }
    case 'outreach_leads':
      allow(['leads']);
      return { ...common, kind: 'outreach_leads', leads: rule(() => checkLeads(base.leads)) };
    case 'outreach_suppress':
      allow(['hash', 'reason']);
      if (typeof base.hash !== 'string' || !/^[a-f0-9]{64}$/.test(base.hash)) throw bad('An opt-out is sent as its salted hash (64 hex characters), never as an address.');
      if (!SUPPRESSION_REASONS.includes(base.reason as SuppressionReason)) throw bad(`The reason must be one of ${SUPPRESSION_REASONS.join(', ')}.`);
      return { ...common, kind: 'outreach_suppress', hash: base.hash, reason: base.reason as SuppressionReason };
    case 'outreach_campaign':
      allow(['campaign']);
      return { ...common, kind: 'outreach_campaign', campaign: rule(() => checkCampaign(base.campaign)) };
    case 'outreach_cancel':
      allow(['campaignId']);
      if (typeof base.campaignId !== 'string' || !/^C[1-9]\d{0,8}$/.test(base.campaignId)) throw bad('campaignId must look like C3.');
      return { ...common, kind: 'outreach_cancel', campaignId: base.campaignId };
    case 'outreach_delete_leads':
      allow(['confirm']);
      if (base.confirm !== true) throw bad('Deleting lead data needs confirm: true.');
      return { ...common, kind: 'outreach_delete_leads', confirm: true };
    default: throw bad('Unknown intent kind.');
  }
}

/**
 * Deterministic processing order: client timestamp, then intent id (never the file path).
 * Unreadable files sort first by their file id; they are only rejected, so order does not matter.
 */
export function sortIntents<T extends { intent?: CloudIntent; path: string }>(items: T[]): T[] {
  const id = (item: T) => (item.intent?.id ?? intentIdFromPath(item.path) ?? item.path).toLowerCase();
  return [...items].sort((a, b) => (a.intent?.createdAt ?? 0) - (b.intent?.createdAt ?? 0) || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0));
}

export const intentPath = (id: string) => `intents/${id.toLowerCase()}.json`;

/**
 * Extra intent blobs fetched beyond the batch size. The Git tree listing carries no timestamps, so
 * the fetch window is chosen by path (UUIDv7 ids make that time-ordered) and processing within it is
 * oldest-first by createdAt. Keeps per-run API calls near the batch size, well inside rate limits.
 */
export const INTENT_FETCH_MARGIN = 20;

/**
 * Chooses which readable intent files a run processes: the oldest `max` by (createdAt, id), not by
 * path, so a later cancel can never be applied before an earlier job submission across batches.
 */
export function selectIntentBatch(files: Record<string, string>, max: number): { selected: string[]; truncated: boolean } {
  const keyed = Object.entries(files).map(([path, text]) => {
    let createdAt = Number.MAX_SAFE_INTEGER;
    try { const value = JSON.parse(text); if (typeof value?.createdAt === 'number' && Number.isFinite(value.createdAt)) createdAt = value.createdAt; } catch { createdAt = -1; /* rejected first */ }
    return { path, createdAt, id: (intentIdFromPath(path) ?? path).toLowerCase() };
  }).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { selected: keyed.slice(0, max).map(item => item.path), truncated: keyed.length > max };
}
