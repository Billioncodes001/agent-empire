// The executive organization (ORG-01) and job estimates (ORG-02), shared by server and client.
// Every executive this round is rule-based: a pure projection of real queue, worker, consultancy and
// usage state. Nothing here calls a model, and nothing here is city credits.

export type ExecutiveRole = 'chief_of_staff' | 'operations' | 'finance' | 'marketing_sales' | 'research';

export interface Executive {
  role: ExecutiveRole;
  /** Stable, e.g. "Morgan · Operations". */
  name: string;
  /** Honest label; no model behind it this round. */
  monitor: 'rule_based';
  /** marketing_sales is inactive until ORG-04 ("Not staffed yet"); research is active since ORG-05. */
  active: boolean;
  /** One line computed from real state, e.g. "2 tasks blocked · 1 waiting worker". */
  summary: string;
  /** Items this executive is waiting on the CEO for (approvals it raised). */
  attention: number;
}

export interface OrgState {
  schemaVersion: 1;
  observedAt: number;
  executives: Executive[];
}

export const EXECUTIVE_ROLES: readonly ExecutiveRole[] = ['chief_of_staff', 'operations', 'finance', 'marketing_sales', 'research'];

/** Stable names and plain titles; the chief keeps the name the HQ manager has always had. */
export const EXECUTIVES: Record<ExecutiveRole, { name: string; title: string; active: boolean }> = {
  chief_of_staff: { name: 'Alex · Chief of staff', title: 'Chief of staff', active: true },
  operations: { name: 'Morgan · Operations', title: 'Operations', active: true },
  finance: { name: 'Priya · Finance', title: 'Finance', active: true },
  marketing_sales: { name: 'Jordan · Marketing & sales', title: 'Marketing & sales', active: false },
  research: { name: 'Sam · Research', title: 'Research', active: true },
};

export const NOT_STAFFED = 'Not staffed yet';

// ---- Estimates (ORG-02) ---------------------------------------------------------------------------

export type ItemPhase = 'build' | 'iteration' | 'testing' | 'field_testing';
export const ITEM_PHASES: readonly ItemPhase[] = ['build', 'iteration', 'testing', 'field_testing'];
export const PHASE_LABEL: Record<ItemPhase, string> = { build: 'Build', iteration: 'Iteration', testing: 'Testing', field_testing: 'Field testing' };
export const isItemPhase = (x: unknown): x is ItemPhase => typeof x === 'string' && (ITEM_PHASES as readonly string[]).includes(x);

export interface Range {
  low: number;
  high: number;
}

/** How an estimate was made: past finished tasks with recorded provider usage, or a stated default. */
export interface EstimateBasis {
  samples: number;
  source: 'history' | 'default';
}

export interface ItemEstimate {
  phase: ItemPhase;
  /** USD, p25 to p75 of comparable past tasks. */
  costUsd: Range;
  /** Wall-clock time one worker needs, p25 to p75. */
  durationMs: Range;
  basis: EstimateBasis;
}

export interface JobEstimate {
  /** Sum of the items' ranges. */
  costUsd: Range;
  /** Calendar time, honouring item order (item N waits for N−1 unless parallel) and maxWorkers. */
  calendarMs: Range;
  items: ItemEstimate[];
  /** `default` when any item fell back to the stated default. */
  basis: EstimateBasis;
  maxWorkers: number;
  estimatedAt: number;
}

/** Recorded when a job's actual spend reaches its approved budget; unstarted items wait, running work continues. */
export interface BudgetHold {
  reachedAt: number;
  spentUsd: number;
  approvedBudgetUsd: number;
}

export const ROUGH_DEFAULT_LABEL = 'Rough default — no history yet';
export const ACTUAL_SPEND_LABEL = 'provider-reported list cost';

/** The budget recorded at approval unless the CEO edits it: the top of the cost range, rounded up to whole dollars. */
export function defaultApprovedBudget(estimate: Pick<JobEstimate, 'costUsd'>): number {
  return Math.max(1, Math.ceil(estimate.costUsd.high - 1e-9));
}

export const fmtUsdRange = (r: Range) => `$${r.low.toFixed(2)}–$${r.high.toFixed(2)}`;

export function fmtDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 90) return `${min} min`;
  const h = min / 60;
  return h < 36 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${(h / 24).toFixed(1)} days`;
}

export const fmtDurationRange = (r: Range) => (fmtDuration(r.low) === fmtDuration(r.high) ? fmtDuration(r.low) : `${fmtDuration(r.low)}–${fmtDuration(r.high)}`);

export function basisLabel(basis: EstimateBasis): string {
  return basis.source === 'default' ? ROUGH_DEFAULT_LABEL : `Based on ${basis.samples} finished task${basis.samples === 1 ? '' : 's'} with recorded usage`;
}
