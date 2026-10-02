import type { ConsultancyJob } from '../shared/consultancy.js';
import type { SupervisionState } from '../shared/empire.js';
import { EXECUTIVE_ROLES, EXECUTIVES, NOT_STAFFED, type Executive, type ExecutiveRole, type OrgState } from '../shared/org.js';
import type { QueueState, QueueTask, UsageState, WorkerInfo } from '../shared/protocol.js';

/** Everything the executives read. All of it is existing runtime state; nothing is fetched or asked of a model. */
export interface OrgInput {
  now: number;
  supervision?: SupervisionState;
  workers: WorkerInfo[];
  queue: QueueState;
  jobs: ConsultancyJob[];
  usage: UsageState;
}

/** LIFE-04 adds these; read them defensively so either branch can merge first. */
type MaybeBlocked = QueueTask & { blockedBy?: string[] };
type MaybeWaiting = WorkerInfo & { waitingOn?: { id: string; name: string; taskId: string } };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const DEPENDENCY_FAILURE = /^dependency \S+ did not finish/;

const PHASE: Record<SupervisionState['chief']['phase'], string> = {
  unassigned: 'No chief appointed',
  pending: 'Startup pending',
  queued: 'Startup queued',
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  needs_input: 'Needs your input',
  turn_ended: 'Turn ended, not verified',
  interrupted: 'Interrupted',
  failed: 'Startup failed',
  unknown: 'Status unknown',
};

function chiefOfStaff(input: OrgInput): Pick<Executive, 'summary' | 'attention'> {
  const plans = input.jobs.filter((j) => j.decision === 'pending_approval').length;
  const sup = input.supervision;
  const parts = sup
    ? [PHASE[sup.chief.phase], `${sup.workforce.active} active`, `${sup.workforce.attention} need${sup.workforce.attention === 1 ? 's' : ''} input`]
    : ['No supervision evidence yet'];
  if (plans) parts.push(`${plural(plans, 'plan')} awaiting approval`);
  return { summary: parts.join(' · '), attention: plans };
}

function operations(input: OrgInput): Pick<Executive, 'summary' | 'attention'> {
  const tasks = input.queue.tasks as MaybeBlocked[];
  const running = tasks.filter((t) => t.status === 'running').length;
  const queued = tasks.filter((t) => t.status === 'queued').length;
  const failures = tasks.filter((t) => t.status !== 'running' && typeof t.error === 'string' && DEPENDENCY_FAILURE.test(t.error)).length;
  const blocked = tasks.filter((t) => t.status === 'queued' && Array.isArray(t.blockedBy) && t.blockedBy.length > 0).length;
  const waiting = (input.workers as MaybeWaiting[]).filter((w) => w.waitingOn && (w.status === 'idle' || w.status === 'done')).length;
  const held = input.jobs.reduce((n, j) => n + j.items.filter((i) => i.held).length, 0);
  if (!running && !queued && !failures && !held) return { summary: 'Queue idle · nothing queued', attention: 0 };
  const parts = [`${running} running`, `${queued} queued`];
  if (blocked) parts.push(`${blocked} blocked`);
  if (waiting) parts.push(plural(waiting, 'waiting worker'));
  if (failures) parts.push(`${plural(failures, 'dependency failure')} held`);
  if (held) parts.push(`${held} held for budget`);
  return { summary: parts.join(' · '), attention: failures };
}

function finance(input: OrgInput): Pick<Executive, 'summary' | 'attention'> {
  const today = input.usage.today.cost;
  const parts = [input.usage.budget !== undefined ? `Today ${usd(today)} of ${usd(input.usage.budget)} daily budget` : `Today ${usd(today)} · no daily budget set`];
  const budgeted = input.jobs.filter((j) => j.decision === 'approved' && j.approvedBudgetUsd !== undefined);
  if (budgeted.length) {
    const approved = budgeted.reduce((n, j) => n + (j.approvedBudgetUsd ?? 0), 0);
    const spent = budgeted.reduce((n, j) => n + (j.actualSpendUsd ?? 0), 0);
    parts.push(`${plural(budgeted.length, 'job')}: ${usd(spent)} spent of ${usd(approved)} approved`);
  } else parts.push('no approved job budgets');
  // Each hold is a budget_increase this executive raises; ORG-03 turns it into an inbox item.
  const holds = input.jobs.filter((j) => j.budgetHold).length;
  if (holds) parts.push(`${plural(holds, 'budget increase')} needed`);
  return { summary: parts.join(' · '), attention: holds };
}

const COMPUTE: Partial<Record<ExecutiveRole, (input: OrgInput) => Pick<Executive, 'summary' | 'attention'>>> = {
  chief_of_staff: chiefOfStaff,
  operations,
  finance,
};

/** Pure: the executive roster as the real state shows it right now. */
export function projectOrg(input: OrgInput): OrgState {
  return {
    schemaVersion: 1,
    observedAt: input.now,
    executives: EXECUTIVE_ROLES.map((role) => {
      const def = EXECUTIVES[role];
      const compute = def.active ? COMPUTE[role] : undefined;
      const { summary, attention } = compute ? compute(input) : { summary: NOT_STAFFED, attention: 0 };
      return { role, name: def.name, monitor: 'rule_based', active: !!compute, summary, attention };
    }),
  };
}

/** For change detection: the roster without its timestamp. */
export const orgSignature = (org: OrgState) => JSON.stringify(org.executives);
