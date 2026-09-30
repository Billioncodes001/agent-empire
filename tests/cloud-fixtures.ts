/** Shared no-network fixtures for the cloud coordinator tests. */
import { DispatchFailure, type DispatchRequest, type ProviderAdapter, type ProviderObservation } from '../src/cloud/provider';
import { initialCloudState, serializeState, type CloudExecution, type CloudLimits, type CloudState, type EventCursorState } from '../src/cloud/schema';
import { MemoryStateStore } from '../src/cloud/store';
import { intentPath, type CloudIntent } from '../src/cloud/intents';
import { runCoordinatorTick, type TickReport } from '../src/cloud/tick';
import { readCloudView } from '../src/cloud/client';

export const T0 = Date.parse('2026-09-30T12:00:00Z');
export const SHA = 'a'.repeat(40);
export const EXECUTION: CloudExecution = { provider: 'anthropic', repository: { owner: 'fixture', name: 'repo', baseBranch: 'main' }, anthropic: { agentId: 'agent_fixture1', environmentId: 'env_fixture1' } };
export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

type Session = { status: 'running' | 'idle' | 'terminated'; archived: boolean; cost: number; budget: number; stopReason?: 'end_turn' | 'requires_action' | 'budget_reached' | 'error'; jobId: string };
/** In-memory provider with the Anthropic adapter's status mapping. */
export class FakeProvider implements ProviderAdapter {
  readonly provider = 'anthropic' as const;
  canDispatch = true;
  sessions = new Map<string, Session>();
  calls: string[] = [];
  /** Next dispatch outcome override: 'not_sent' | 'sent' (uncertain) | 'throw' (unexpected error). */
  failNext: ('not_sent' | 'sent' | 'throw')[] = [];
  failObserve = new Set<string>();
  /** Report a different budget than requested for these job ids. */
  wrongBudget = new Set<string>();
  private counter = 0;

  sessionFor(jobId: string) { return [...this.sessions.entries()].find(([, s]) => s.jobId === jobId)?.[0]; }
  finish(jobId: string, stopReason: Session['stopReason'] = 'end_turn', cost = 40) {
    const s = this.sessions.get(this.sessionFor(jobId)!)!; s.status = 'idle'; s.stopReason = stopReason; s.cost = cost;
  }
  terminate(jobId: string) { this.sessions.get(this.sessionFor(jobId)!)!.status = 'terminated'; }
  obs(id: string): ProviderObservation {
    const s = this.sessions.get(id)!;
    const providerStatus = s.archived ? 'archived' : s.status;
    const status = providerStatus === 'archived' ? 'cancelled' : providerStatus === 'terminated' ? 'failed' : providerStatus === 'running' ? 'running' : 'idle';
    return { sessionId: id, status, providerStatus, costCents: s.cost, budgetCents: s.budget, message: `fake ${providerStatus}` };
  }
  async dispatch(request: DispatchRequest) {
    this.calls.push(`dispatch:${request.jobId}`);
    const fail = this.failNext.shift();
    if (fail === 'not_sent') throw new DispatchFailure(false, 'Repository check failed.');
    if (fail === 'sent') throw new DispatchFailure(true, 'Creation response lost.');
    if (fail === 'throw') throw new Error('socket hang up');
    const id = `sesn_fake${(++this.counter).toString().padStart(4, '0')}`;
    this.sessions.set(id, { status: 'running', archived: false, cost: 0, budget: this.wrongBudget.has(request.jobId) ? request.budgetCents + 1 : request.budgetCents, jobId: request.jobId });
    return { sourceCommit: SHA, observation: this.obs(id) };
  }
  async observe(sessionId: string, cursor: EventCursorState) {
    this.calls.push(`observe:${sessionId}`);
    if (this.failObserve.has(sessionId)) throw new Error('network down');
    const s = this.sessions.get(sessionId)!;
    return { observation: this.obs(sessionId), cursor: { ...cursor, stopReason: s.status === 'idle' ? s.stopReason : undefined } };
  }
  async interrupt(sessionId: string) { this.calls.push(`interrupt:${sessionId}`); const s = this.sessions.get(sessionId)!; s.status = 'idle'; s.stopReason = 'end_turn'; }
  async archive(sessionId: string) { this.calls.push(`archive:${sessionId}`); const s = this.sessions.get(sessionId)!; if (s.status === 'idle') { s.archived = true; s.status = 'terminated'; } }
}

export function makeStore(options: { limits?: CloudLimits; execution?: CloudExecution | null; mutate?: (state: CloudState) => void } = {}) {
  const state = initialCloudState(T0, { limits: options.limits ?? { maxConcurrent: 2, perTaskBudgetCents: 100, dailyBudgetCents: 1000 }, ...(options.execution === null ? {} : { execution: options.execution ?? EXECUTION }) });
  options.mutate?.(state);
  return new MemoryStateStore(serializeState(state));
}

type IntentBody = CloudIntent extends infer I ? I extends { kind: string } ? Omit<I, 'schemaVersion' | 'id' | 'createdAt'> : never : never;
export function intent(n: number, body: IntentBody, createdAt = T0 + n): CloudIntent {
  return { schemaVersion: 1, id: uuid(100_000 + n), createdAt, ...body } as CloudIntent;
}
export function push(store: MemoryStateStore, ...intents: CloudIntent[]) {
  store.push(intents.map(item => ({ path: intentPath(item.id), content: JSON.stringify(item) })), 'client intents');
}
export const newJob = (n: number, jobN: number, extra: Partial<{ site: any; configRevision: number; prompt: string; title: string }> = {}) =>
  intent(n, { kind: 'new_job', job: { id: uuid(jobN), title: extra.title ?? `Job ${jobN}`, prompt: extra.prompt ?? `Do task ${jobN}`, configRevision: extra.configRevision ?? 0, confirmPaid: true, ...(extra.site ? { site: extra.site } : {}) } } as IntentBody);

/** Runs ticks with a controllable clock. */
export function harness(store: MemoryStateStore, provider = new FakeProvider(), start = T0) {
  let now = start; let run = 0;
  return {
    store, provider,
    get now() { return now; },
    advance(ms: number) { now += ms; },
    async tick(options: { allowSelfDisable?: boolean } = {}): Promise<TickReport> {
      return runCoordinatorTick({ store, provider, now: () => now, runId: `run-${++run}`, allowSelfDisable: options.allowSelfDisable ?? true });
    },
    async view() { return readCloudView(store, now); },
    async state() { return (await readCloudView(store, now)).state; },
  };
}
export const job = (state: CloudState, n: number) => state.jobs.jobs.find(item => item.id === uuid(n))!;
