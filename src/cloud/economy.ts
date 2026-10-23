/**
 * City economy for cloud mode. The rules themselves (costs, rewards, validation, hourly settlement)
 * live once in src/shared/economy-rules.ts and are shared with the host's Empire class
 * (src/server/empire.ts). This module adds only the clock-injected, queue-free cloud parts: the
 * settle cap, the cloud job → manager mapping and the cloud report wording. All amounts are
 * simulation credits, never provider spending.
 */
import { SITES, type EmpireAction, type EmpireState } from '../shared/empire.js';
import { applyCityAction, creditTaskReward, serviceCoverage, settleOperatingHour, TASK_REWARD, type CityActionText } from '../shared/economy-rules.js';
import { LIMITS, type CloudJob } from './schema.js';

/**
 * Longest wall-clock gap one tick may settle: three schedule intervals, at least 90 minutes (runs
 * with nothing to record skip their commit for up to an hour). Longer gaps (Actions outage, missed
 * schedules) earn nothing extra.
 */
export const settleCapMs = (intervalMinutes: number) => Math.max(90, intervalMinutes * 3) * 60_000;

function report(state: EmpireState, now: number, sector: string, text: string) {
  state.reports.unshift({ at: now, sector, text });
  state.reports = state.reports.slice(0, LIMITS.reports);
}

/** Cloud report wording; the host keeps its own in src/server/empire.ts. */
const CLOUD_TEXT: CityActionText = {
  founded: n => `Founding plan confirmed: ${n} buildings. Managers are appointed; each starts earning only after a real startup job you submit finishes its turn.`,
  floor: n => `Floor ${n} constructed.`,
  workstation: n => `Workstation ${n} installed.`,
  delegated: on => on ? 'Delegated oversight requested. The cloud coordinator continues rule-based monitoring; this does not start an AI supervisor.' : 'CEO resumed direct oversight.',
  reinvested: amount => `Founder reinvested ${amount} credits into the city.`,
  land: site => `${site.name} parcel acquired for ${site.landCost} credits.`,
  built: site => `${site.name} constructed with a manager appointment and one service employee.`,
  hired: (site, staff) => `${site.name}: ${staff}/${site.capacity} service employees.`,
  upgraded: (site, level) => `${site.name} upgraded to level ${level}.`,
};

/**
 * Applies one city action (the host EmpireAction contract minus queue-bound manager retries, which
 * are refused as an unknown operation). Mutates `state`; returns a user-safe error without changing
 * anything on failure.
 */
export function applyEmpireAction(state: EmpireState, action: EmpireAction, now: number): string | undefined {
  return applyCityAction(state, action, now, CLOUD_TEXT, (sector, text) => report(state, now, sector, text));
}

/**
 * Manager appointments follow their startup job (the linked cloud job, job.site). A finished turn
 * awaiting review counts as ready, matching the host rule "startup turn ended; brief not yet
 * verified". Once ready, the appointment stays ready: later sector jobs that queue, fail or are
 * cancelled never demote it. Until then, the most recent linked job is the current startup attempt.
 */
export function syncManagers(state: EmpireState, jobs: CloudJob[], now: number) {
  for (const sector of state.sectors) {
    const manager = sector.manager;
    if (!manager || manager.status === 'ready') continue;
    const linked = jobs.filter(job => job.site === sector.id).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    if (!linked.length) continue;
    const reached = linked.find(job => ['awaiting_review', 'accepted'].includes(job.status));
    const startup = reached ?? linked[0];
    const old = manager.status;
    manager.taskId = startup.id;
    manager.jobKey = `cloud-job-${startup.id}`;
    manager.status = reached ? 'ready'
      : startup.status === 'queued' ? 'queued'
        : ['waiting_for_approval', 'budget_paused'].includes(startup.status) ? 'needs_input'
          : ['running', 'dispatching', 'idle'].includes(startup.status) ? 'working' : 'offline';
    manager.error = manager.status === 'offline' ? startup.message.slice(0, 300) : undefined;
    if (old !== manager.status && ['ready', 'offline', 'needs_input'].includes(manager.status)) {
      report(state, now, 'Chief of staff', `${manager.name}: ${manager.status === 'ready' ? 'startup turn ended; brief not yet verified' : manager.status === 'offline' ? 'startup needs attention' : 'needs your input in provider controls'}.`);
    }
  }
}

export function syncWorkforce(state: EmpireState, jobs: CloudJob[]) {
  state.workforce = {
    working: jobs.filter(j => ['dispatching', 'running'].includes(j.status)).length,
    attention: jobs.filter(j => ['waiting_for_approval', 'budget_paused', 'dispatch_uncertain', 'unknown', 'idle', 'awaiting_review'].includes(j.status)).length,
    done: jobs.filter(j => j.status === 'accepted').length,
    queued: jobs.filter(j => j.status === 'queued').length,
  };
}

/** 500 credits once per job id, only after the user accepts a finished turn (not a verification). */
export function rewardAcceptedJob(state: EmpireState, job: CloudJob, now: number): boolean {
  if (!state.setup.completed || job.status !== 'accepted' || job.rewarded || state.economy.rewardedTasks.includes(job.id) || job.createdAt < state.economy.startedAt) return false;
  state.economy.rewardedTasks.push(job.id);
  const site = SITES.find(s => s.id === job.site) ?? SITES[0];
  const sector = state.sectors.find(s => s.id === site.id)!;
  const manager = job.site && sector.manager;
  creditTaskReward(state, now, {
    site: site.id,
    payeeId: manager ? manager.id : `agent-cloud-${job.id}`,
    payeeName: manager ? manager.name : 'Cloud AI worker',
    role: manager ? 'manager' : 'agent',
    label: `Accepted AI task: ${job.title}`,
  });
  report(state, now, 'Chief of staff', `Accepted task credited: ${job.title}. ${TASK_REWARD.revenue} city credits earned; ${TASK_REWARD.wages} paid to the worker and ${TASK_REWARD.dividend} to the founder.`);
  return true;
}

/**
 * Advances city time for `elapsedMs` of coordinator uptime: one real second is one city minute and
 * every city hour settles payroll exactly as the host does. The caller passes zero while shut down.
 */
export function advanceEconomy(state: EmpireState, elapsedMs: number, now: number, capMs = settleCapMs(30)): { minutes: number; hours: number } {
  const minutes = Math.floor(Math.max(0, Math.min(elapsedMs, capMs)) / 1000);
  state.minutes += minutes;
  for (const sector of state.sectors) sector.service = serviceCoverage(sector);
  if (!state.setup.completed) return { minutes, hours: 0 };
  const economy = state.economy;
  const targetHour = Math.floor(state.minutes / 60);
  let hours = 0, totals = { revenue: 0, wages: 0, upkeep: 0, dividend: 0 };
  const paused = new Set<string>();
  while (economy.lastHour < targetHour) {
    economy.lastHour++; hours++;
    const hour = settleOperatingHour(state, now);
    hour.paused.forEach(name => paused.add(name));
    totals = { revenue: totals.revenue + hour.revenue, wages: totals.wages + hour.wages, upkeep: totals.upkeep + hour.upkeep, dividend: totals.dividend + hour.dividend };
  }
  if (paused.size) report(state, now, 'Treasury', `Paused for at least one hour because payroll could not be funded: ${[...paused].join(', ')}.`);
  if (totals.revenue || totals.wages || totals.upkeep) {
    report(state, now, 'Treasury', `${hours} operating hour(s) closed: ${totals.revenue} revenue − ${totals.wages} wages − ${totals.upkeep} upkeep. Founder dividends ${totals.dividend}; treasury ${state.funds} credits.`);
  }
  return { minutes, hours };
}
