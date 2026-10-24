import type { ConsultancyJob } from '../shared/consultancy.js';
import type { SupervisionState } from '../shared/empire.js';
import { EXECUTIVE_ROLES, EXECUTIVES, NOT_STAFFED, type Executive, type ExecutiveRole, type OrgState } from '../shared/org.js';
import { heldDependencyId } from '../shared/dependencies.js';
import type { QueueState, UsageState, WorkerInfo } from '../shared/protocol.js';
import type { Approval } from '../shared/approvals.js';
import type { OutreachSummary } from '../shared/outreach.js';
import type { ResearchState } from '../shared/research.js';

/** Everything the executives read. All of it is existing runtime state; nothing is fetched or asked of a model. */
export interface OrgInput {
  now: number;
  supervision?: SupervisionState;
  workers: WorkerInfo[];
  queue: QueueState;
  jobs: ConsultancyJob[];
  usage: UsageState;
  /** ORG-03: the approval inbox. When present, chief and finance attention count the pending items each raised. */
  approvals?: Approval[];
  /** ORG-04a: email outreach (campaigns, leads, suppression). Absent on hosts without it. */
  outreach?: OutreachSummary;
  /** ORG-05: the research index (reports and tool proposals). */
  research?: ResearchState;
  /** FREE-02: the chief's planning brain when it can propose right now. Absent: the chief stays rule-based. */
  chiefBrain?: { model: string };
}





const raised = (input: OrgInput, role: Approval['raisedBy']) => input.approvals?.filter((a) => a.raisedBy === role && a.status === 'pending').length;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const usd = (n: number) => `$${n.toFixed(2)}`;


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
  return { summary: parts.join(' · '), attention: raised(input, 'chief_of_staff') ?? plans };
}

function operations(input: OrgInput): Pick<Executive, 'summary' | 'attention'> {
  const tasks = input.queue.tasks;
  const running = tasks.filter((t) => t.status === 'running').length;
  const queued = tasks.filter((t) => t.status === 'queued').length;
  // LIFE-04: a task whose dependency did not finish is held (done/failed) until the CEO retries or removes it.
  const failures = tasks.filter((t) => heldDependencyId(t) !== undefined).length;
  const blocked = tasks.filter((t) => t.status === 'queued' && Array.isArray(t.blockedBy) && t.blockedBy.length > 0).length;
  const waiting = input.workers.filter((w) => w.waitingOn && (w.status === 'idle' || w.status === 'done')).length;
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
  // Each hold is a budget_increase this executive raises in the inbox; without inbox data, the holds themselves.
  const holds = raised(input, 'finance') ?? input.jobs.filter((j) => j.budgetHold).length;
  if (holds) parts.push(`${plural(holds, 'budget increase')} needed`);
  return { summary: parts.join(' · '), attention: holds };
}

/** ORG-04a: coordinates outreach, never writes it. Attention is the campaign sends waiting for the CEO's approval. */
function marketingSales(input: OrgInput): Pick<Executive, 'summary' | 'attention'> {
  const o = input.outreach;
  const waiting = raised(input, 'marketing_sales') ?? 0;
  if (!o) return { summary: 'Email outreach is not available on this host', attention: waiting };
  const parts = [o.campaigns ? plural(o.campaigns, 'campaign') : 'No campaigns yet'];
  if (o.sending) parts.push(`${o.sending} sending`);
  if (o.drafting) parts.push(`${o.drafting} drafting`);
  parts.push(plural(o.confirmedLeads, 'lead'));
  if (o.proposedLeads) parts.push(`${o.proposedLeads} proposed to accept`);
  if (waiting) parts.push(`${plural(waiting, 'send')} waiting for approval`);
  if (!o.sendingEnabled) parts.push('sending not configured');
  return { summary: parts.join(' · '), attention: waiting };
}

/** ORG-05: reports by state, and the tool proposals it raised that still wait on the CEO. */
function research(input: OrgInput): Pick<Executive, 'summary' | 'attention'> {
  const reports = input.research?.reports ?? [];
  const done = reports.filter((r) => r.status === 'imported').length;
  const working = reports.filter((r) => r.status === 'queued' || r.status === 'running').length;
  const asked = reports.filter((r) => r.status === 'awaiting_approval').length;
  const attention = reports.filter((r) => r.status === 'needs_attention').length;
  const proposals = raised(input, 'research') ?? input.research?.openProposals ?? 0;
  if (!reports.length) return { summary: 'No research yet · ask a question from the founder desk, this card or /research', attention: proposals };
  const parts = [plural(done, 'report')];
  if (working) parts.push(`${working} in progress`);
  if (asked) parts.push(`${plural(asked, 'question')} awaiting approval`);
  if (attention) parts.push(`${attention} need${attention === 1 ? 's' : ''} attention`);
  if (proposals) parts.push(`${plural(proposals, 'tool proposal')} to decide`);
  return { summary: parts.join(' · '), attention: proposals };
}

const COMPUTE: Partial<Record<ExecutiveRole, (input: OrgInput) => Pick<Executive, 'summary' | 'attention'>>> = {
  chief_of_staff: chiefOfStaff,
  operations,
  finance,
  marketing_sales: marketingSales,
  research,
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
      const brain = role === 'chief_of_staff' && compute ? input.chiefBrain : undefined;
      return brain
        ? { role, name: def.name, monitor: 'model_backed' as const, model: brain.model, active: true, summary, attention }
        : { role, name: def.name, monitor: 'rule_based' as const, active: !!compute, summary, attention };
    }),
  };
}

/** For change detection: the roster without its timestamp. */
export const orgSignature = (org: OrgState) => JSON.stringify(org.executives);
