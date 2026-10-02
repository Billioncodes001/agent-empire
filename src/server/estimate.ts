import type { ItemEstimate, ItemPhase, JobEstimate, Range } from '../shared/org.js';

/** One finished task: what the provider reported it cost and how long its worker took. */
export interface CostSample {
  costUsd: number;
  durationMs: number;
  phase?: ItemPhase;
}

/** What estimateJob needs to know about each planned item. */
export interface PlannedItem {
  phase?: ItemPhase;
  /** The plan opted this item out of waiting for the one before it. */
  parallel?: boolean;
}

/** A per-task spend record (see Ledger.taskCosts in usage.ts). */
export interface TaskCostRecord {
  taskId: string;
  costUsd: number;
  startedAt?: number;
  finishedAt?: number;
  outcome?: string;
  jobKey?: string;
}

/** Below this many comparable samples, the estimate is the stated default, and the UI says so. */
export const MIN_SAMPLES = 3;

/**
 * The stated default for one item with no history: a deliberately wide, conservative range for a
 * single agent turn on a scoped coding task. It is a planning number, not a measurement.
 */
export const DEFAULT_ITEM_ESTIMATE: { costUsd: Range; durationMs: Range } = {
  costUsd: { low: 0.5, high: 3 },
  durationMs: { low: 10 * 60_000, high: 45 * 60_000 },
};

/** Linear interpolation between closest ranks (the common "type 7" definition). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const range = (values: number[], places: number): Range => ({ low: round(percentile(values, 0.25), places), high: round(percentile(values, 0.75), places) });

/** Successful finished tasks with recorded spend and a measurable duration become samples. */
export function historyFromTaskCosts(records: TaskCostRecord[], phaseOf: (jobKey?: string) => ItemPhase | undefined): CostSample[] {
  const out: CostSample[] = [];
  for (const r of records) {
    if (r.outcome !== 'done' || !(r.costUsd > 0) || r.startedAt === undefined || r.finishedAt === undefined) continue;
    const durationMs = r.finishedAt - r.startedAt;
    if (!(durationMs > 0)) continue;
    const phase = phaseOf(r.jobKey);
    out.push(phase ? { costUsd: r.costUsd, durationMs, phase } : { costUsd: r.costUsd, durationMs });
  }
  return out;
}

function estimateItem(item: PlannedItem, history: CostSample[]): ItemEstimate {
  const phase = item.phase ?? 'build';
  const own = history.filter((s) => (s.phase ?? 'build') === phase);
  const pool = own.length >= MIN_SAMPLES ? own : history;
  if (pool.length < MIN_SAMPLES) {
    return { phase, costUsd: { ...DEFAULT_ITEM_ESTIMATE.costUsd }, durationMs: { ...DEFAULT_ITEM_ESTIMATE.durationMs }, basis: { samples: pool.length, source: 'default' } };
  }
  return {
    phase,
    costUsd: range(pool.map((s) => s.costUsd), 2),
    durationMs: range(pool.map((s) => s.durationMs), 0),
    basis: { samples: pool.length, source: 'history' },
  };
}

/**
 * Calendar time for the plan: item N starts after item N−1 finishes unless it is parallel, and at
 * most `workers` items run at once (list scheduling in plan order, like the queue seats them).
 */
function calendar(items: PlannedItem[], durations: number[], workers: number): number {
  const free = Array.from({ length: Math.max(1, workers) }, () => 0);
  const finish: number[] = [];
  items.forEach((item, i) => {
    const ready = i > 0 && !item.parallel ? finish[i - 1] : 0;
    let slot = 0;
    for (let w = 1; w < free.length; w++) if (free[w] < free[slot]) slot = w;
    const start = Math.max(ready, free[slot]);
    finish[i] = start + durations[i];
    free[slot] = finish[i];
  });
  return finish.length ? Math.max(...finish) : 0;
}

/** Pure: estimates a consultancy plan from past spend. No provider is called. */
export function estimateJob(items: PlannedItem[], history: CostSample[], opts: { maxWorkers: number; now?: number }): JobEstimate {
  const valid = history.filter((s) => Number.isFinite(s.costUsd) && s.costUsd >= 0 && Number.isFinite(s.durationMs) && s.durationMs > 0);
  const estimates = items.map((item) => estimateItem(item, valid));
  const sum = (pick: (e: ItemEstimate) => number) => estimates.reduce((total, e) => total + pick(e), 0);
  const workers = Math.max(1, Math.floor(opts.maxWorkers) || 0);
  const fromHistory = estimates.length > 0 && estimates.every((e) => e.basis.source === 'history');
  return {
    costUsd: { low: round(sum((e) => e.costUsd.low), 2), high: round(sum((e) => e.costUsd.high), 2) },
    calendarMs: {
      low: calendar(items, estimates.map((e) => e.durationMs.low), workers),
      high: calendar(items, estimates.map((e) => e.durationMs.high), workers),
    },
    items: estimates,
    basis: { samples: valid.length, source: fromHistory ? 'history' : 'default' },
    maxWorkers: Math.max(0, Math.floor(opts.maxWorkers) || 0),
    estimatedAt: opts.now ?? Date.now(),
  };
}
