import type { ExecutionConfig, ExecutionSubmit } from '../shared/execution.js';
import { ExecutionError } from './execution-errors.js';

export const TASK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const PROVIDER_ID = { agent: /^agent_[A-Za-z0-9]{8,100}$/, environment: /^env_[A-Za-z0-9]{8,100}$/, vault: /^vlt_[A-Za-z0-9]{8,100}$/, session: /^sesn_[A-Za-z0-9]{8,100}$/, event: /^sevt_[A-Za-z0-9]{8,100}$/ };
export const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const invalid = () => new ExecutionError(400, 'invalid_input', 'Execution settings or task fields are invalid. Credentials belong in protected host storage, never in this request.');
export function object(value: unknown, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (keys && Object.keys(record).some(key => !keys.includes(key))) throw invalid();
  return record;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  return value.trim();
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid();
  return value as number;
}
export function validateConfig(value: unknown): ExecutionConfig {
  const c = object(value, ['schemaVersion', 'completed', 'mode', 'repository', 'anthropic', 'githubAuth', 'limits']);
  if (c.schemaVersion !== 1 || typeof c.completed !== 'boolean' || !['local', 'vps', 'anthropic_cloud'].includes(String(c.mode)) || c.githubAuth !== 'host_token') throw invalid();
  const repository = object(c.repository, ['owner', 'name', 'baseBranch']);
  const owner = text(repository.owner, 39); const name = text(repository.name, 100); const baseBranch = text(repository.baseBranch, 200);
  if ((owner && !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) || (name && (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..'))
    || (baseBranch && (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(baseBranch) || baseBranch.includes('..') || baseBranch.includes('//') || baseBranch.endsWith('/') || baseBranch.endsWith('.lock')))) throw invalid();
  const a = object(c.anthropic, ['agentId', 'environmentId', 'vaultId']);
  const agentId = text(a.agentId, 128); const environmentId = text(a.environmentId, 128); const vaultId = a.vaultId === undefined ? undefined : text(a.vaultId, 128) || undefined;
  if ((agentId && !PROVIDER_ID.agent.test(agentId)) || (environmentId && !PROVIDER_ID.environment.test(environmentId)) || (vaultId && !PROVIDER_ID.vault.test(vaultId))) throw invalid();
  if (c.mode === 'anthropic_cloud' && c.completed && (!owner || !name || !baseBranch || !agentId || !environmentId)) throw invalid();
  const limits = object(c.limits, ['maxConcurrent', 'perTaskBudgetCents', 'dailyBudgetCents']);
  const maxConcurrent = integer(limits.maxConcurrent, 1, 10);
  const perTaskBudgetCents = integer(limits.perTaskBudgetCents, 1, 100_000);
  const dailyBudgetCents = integer(limits.dailyBudgetCents, perTaskBudgetCents, 10_000_000);
  return { schemaVersion: 1, completed: c.completed, mode: c.mode as ExecutionConfig['mode'], repository: { owner, name, baseBranch }, anthropic: { agentId, environmentId, ...(vaultId ? { vaultId } : {}) }, githubAuth: 'host_token', limits: { maxConcurrent, perTaskBudgetCents, dailyBudgetCents } };
}
export function validateSubmit(value: unknown): ExecutionSubmit {
  const input = object(value, ['id', 'prompt', 'configRevision', 'confirmPaid']);
  if (typeof input.id !== 'string' || !TASK_ID.test(input.id) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20_000 || input.prompt.includes('\0')) throw invalid();
  if (input.confirmPaid !== true) throw new ExecutionError(400, 'paid_confirmation_required', 'Confirm the repository, provider and real-money budget before submitting this task.');
  return { id: input.id.toLowerCase(), prompt: input.prompt.trim(), configRevision: integer(input.configRevision, 0, Number.MAX_SAFE_INTEGER), confirmPaid: true };
}
