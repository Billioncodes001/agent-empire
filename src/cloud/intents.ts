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
);
export type IntentKind = CloudIntent['kind'];
export const INTENT_KINDS: readonly IntentKind[] = ['new_job', 'review', 'cancel', 'resolve_uncertain', 'shutdown', 'start', 'limits', 'configure', 'provision', 'empire_action'];

export class IntentError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'IntentError'; }
}
const bad = (message: string, code = 'invalid_intent') => new IntentError(code, message);

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
const EMPIRE_ACTION_KINDS = ['delegate', 'found', 'build', 'hire', 'buy-land', 'upgrade', 'reinvest', 'office-floor', 'office-workstation'];

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
  const base = rec(value, ['schemaVersion', 'id', 'createdAt', 'kind', 'job', 'jobId', 'decision', 'note', 'resolution', 'sessionId', 'limits', 'configRevision', 'execution', 'repository', 'model', 'action']);
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
      else rec(action, ['kind']);
      return { ...common, kind: 'empire_action', action: JSON.parse(JSON.stringify(action)) as EmpireAction };
    }
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
