/**
 * Pure city economy for cloud mode, following docs/ECONOMY.md with the shared rate helpers in
 * src/shared/empire.ts. The host's Empire class (src/server/empire.ts) owns the same rules for a
 * running server but is bound to the filesystem and live queue; this module is its clock-injected,
 * queue-free counterpart. All amounts are simulation credits, never provider spending.
 */
import {
  hourlyRates, MANAGER_NAMES, officeFloorCost, SITES, STARTER_SITES, upgradeCost, workstationCost,
  type EmpireAction, type EmpireState, type SectorState, type SiteId,
} from '../shared/empire.js';
import { DESKS_PER_FLOOR } from '../shared/layout.js';
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
function pay(state: EmpireState, id: string, name: string, site: SiteId, role: 'manager' | 'service' | 'agent', amount: number) {
  const account = (state.economy.employees[id] ??= { name, site, role, earned: 0 });
  account.earned += amount;
}
function ledger(state: EmpireState, now: number, label: string, revenue: number, wages: number, upkeep: number, dividend: number, capital = 0) {
  const e = state.economy;
  e.revenue += revenue; e.wages += wages; e.upkeep += upkeep; e.dividends += dividend; e.ownerBalance += dividend; e.capital += capital;
  state.funds += revenue - wages - upkeep - dividend - capital;
  e.ledger.unshift({ at: now, minute: state.minutes, label, revenue, wages, upkeep, dividend, capital, balance: state.funds });
  e.ledger = e.ledger.slice(0, 100);
}
function appoint(sector: SectorState) {
  if (sector.id === 'home' || sector.manager) return;
  sector.manager = { id: `manager-${sector.id}`, name: MANAGER_NAMES[sector.id], status: 'pending', attempt: 1, jobKey: `empire-manager-${sector.id}-1` };
}

/**
 * Applies one city action (the host EmpireAction contract minus queue-bound manager retries).
 * Mutates `state`; returns a user-safe error without changing anything on failure.
 */
export function applyEmpireAction(state: EmpireState, action: EmpireAction, now: number): string | undefined {
  const beforeFunds = state.funds;
  if (action.kind === 'found') {
    if (state.setup.completed) return 'Founding setup is already complete';
    if (!Array.isArray(action.sites) || action.sites.length > STARTER_SITES.length || new Set(action.sites).size !== action.sites.length
      || action.sites.some(id => !STARTER_SITES.some(s => s.id === id))) return 'Choose valid starting buildings';
    for (const sector of state.sectors) {
      if (action.sites.includes(sector.id)) { sector.built = true; sector.owned = true; }
      if (sector.built) { appoint(sector); if (!['hq', 'home'].includes(sector.id)) sector.staff = Math.max(1, sector.staff); }
    }
    state.setup = { completed: true, selected: [...action.sites], completedAt: now };
    state.delegated = true;
    state.economy.startedAt = now;
    state.economy.lastHour = Math.floor(state.minutes / 60);
    report(state, now, 'Chief of staff', `Founding plan confirmed: ${state.sectors.filter(s => s.built).length} buildings. Managers are appointed; each starts earning only after a real startup job you submit finishes its turn.`);
  } else if (action.kind === 'office-floor' || action.kind === 'office-workstation') {
    if (!state.setup.completed) return 'Complete founding setup first';
    const office = state.office; const floor = action.kind === 'office-floor';
    if (!floor && office.workstations >= office.floors * DESKS_PER_FLOOR) return 'Build another floor before adding workstations';
    const cost = floor ? officeFloorCost(office) : workstationCost(office);
    if (state.funds < cost) return 'Insufficient simulation credits';
    state.funds -= cost;
    if (floor) office.floors++; else office.workstations++;
    report(state, now, 'Headquarters', floor ? `Floor ${office.floors} constructed.` : `Workstation ${office.workstations} installed.`);
  } else if (action.kind === 'delegate') {
    if (typeof action.enabled !== 'boolean') return 'Invalid delegation setting';
    state.delegated = action.enabled;
    report(state, now, 'Executive', action.enabled ? 'Delegated oversight requested. The cloud coordinator continues rule-based monitoring; this does not start an AI supervisor.' : 'CEO resumed direct oversight.');
  } else if (action.kind === 'reinvest') {
    if (state.economy.ownerBalance <= 0) return 'No founder earnings available';
    state.funds += state.economy.ownerBalance;
    report(state, now, 'Treasury', `Founder reinvested ${state.economy.ownerBalance} credits into the city.`);
    state.economy.ownerBalance = 0;
  } else if (action.kind === 'build' || action.kind === 'hire' || action.kind === 'buy-land' || action.kind === 'upgrade') {
    const site = SITES.find(s => s.id === action.site); const sector = state.sectors.find(s => s.id === action.site);
    if (!site || !sector) return 'Unknown site';
    if (action.kind === 'buy-land') {
      if (sector.owned) return 'Land already owned';
      if (state.funds < site.landCost) return 'Insufficient simulation credits';
      state.funds -= site.landCost; sector.owned = true;
      report(state, now, 'Expansion', `${site.name} parcel acquired for ${site.landCost} credits.`);
    } else if (action.kind === 'build') {
      if (sector.built) return 'Already built';
      if (!sector.owned) return 'Buy this land first';
      if (state.funds < site.cost) return 'Insufficient simulation credits';
      state.funds -= site.cost; sector.built = true; sector.staff = 1; appoint(sector);
      report(state, now, site.sector, `${site.name} constructed with a manager appointment and one service employee.`);
    } else if (action.kind === 'hire') {
      if (sector.id === 'hq') return 'Employ AI workers at a furnished headquarters workstation';
      if (!sector.built) return 'Build this site first';
      if (sector.staff >= site.capacity) return 'Team is at capacity';
      if (state.funds < 1200) return 'Hiring requires 1,200 simulation credits';
      state.funds -= 1200; sector.staff++;
      report(state, now, site.sector, `${site.name}: ${sector.staff}/${site.capacity} service employees.`);
    } else {
      if (sector.id === 'hq') return 'Expand headquarters through floors and workstations';
      if (!sector.built) return 'Build this site first';
      if (sector.id === 'home' || sector.level >= 3) return 'No further upgrades available';
      const cost = upgradeCost(sector);
      if (state.funds < cost) return 'Insufficient simulation credits';
      state.funds -= cost; sector.level++;
      report(state, now, site.sector, `${site.name} upgraded to level ${sector.level}.`);
    }
  } else return 'Unknown operation';
  if (state.funds !== beforeFunds) {
    const capital = beforeFunds - state.funds; state.funds = beforeFunds;
    const site = 'site' in action ? SITES.find(s => s.id === action.site)?.name : '';
    const label = ({ 'buy-land': 'Land purchase', build: 'Construction', hire: 'Recruitment', upgrade: 'Building upgrade', reinvest: 'Founder reinvestment', 'office-floor': 'Headquarters floor construction', 'office-workstation': 'Workstation installation' } as Record<string, string>)[action.kind] ?? action.kind;
    ledger(state, now, `${label}${site ? ' · ' + site : ''}`, 0, 0, 0, 0, capital);
  }
  return undefined;
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
  pay(state, manager ? manager.id : `agent-cloud-${job.id}`, manager ? manager.name : 'Cloud AI worker', site.id, manager ? 'manager' : 'agent', 50);
  sector.revenue += 500; sector.wages += 50;
  ledger(state, now, `Accepted AI task: ${job.title}`, 500, 50, 0, 90);
  report(state, now, 'Chief of staff', `Accepted task credited: ${job.title}. 500 city credits earned; 50 paid to the worker and 90 to the founder.`);
  return true;
}

/**
 * Advances city time for `elapsedMs` of coordinator uptime: one real second is one city minute and
 * every city hour settles payroll exactly as the host does. The caller passes zero while shut down.
 */
export function advanceEconomy(state: EmpireState, elapsedMs: number, now: number, capMs = settleCapMs(30)): { minutes: number; hours: number } {
  const minutes = Math.floor(Math.max(0, Math.min(elapsedMs, capMs)) / 1000);
  state.minutes += minutes;
  for (const sector of state.sectors) {
    const site = SITES.find(s => s.id === sector.id)!;
    sector.service = sector.built ? Math.min(100, Math.round((sector.staff / site.capacity) * 100 * (1 + (sector.level - 1) * 0.3))) : 0;
  }
  if (!state.setup.completed) return { minutes, hours: 0 };
  const economy = state.economy;
  const targetHour = Math.floor(state.minutes / 60);
  let hours = 0, totals = { revenue: 0, wages: 0, upkeep: 0, dividend: 0 };
  const paused = new Set<string>();
  while (economy.lastHour < targetHour) {
    economy.lastHour++; hours++;
    let revenue = 0, wages = 0, upkeep = 0;
    for (const sector of state.sectors) {
      const rate = hourlyRates(sector);
      if (!rate.wages) continue;
      if (state.funds + revenue + rate.revenue - wages - upkeep < rate.wages + rate.upkeep) { paused.add(SITES.find(s => s.id === sector.id)!.name); continue; }
      revenue += rate.revenue; wages += rate.wages; upkeep += rate.upkeep;
      sector.revenue += rate.revenue; sector.wages += rate.wages; sector.upkeep += rate.upkeep;
      pay(state, sector.manager!.id, sector.manager!.name, sector.id, 'manager', sector.id === 'hq' ? 60 : 40);
      for (let i = 0; i < sector.staff; i++) pay(state, `service-${sector.id}-${i}`, `Service employee ${i + 1}`, sector.id, 'service', 18);
    }
    const dividend = Math.floor(Math.max(0, revenue - wages - upkeep) * 0.2);
    if (revenue || wages || upkeep) ledger(state, now, 'Hourly sector operations', revenue, wages, upkeep, dividend);
    totals = { revenue: totals.revenue + revenue, wages: totals.wages + wages, upkeep: totals.upkeep + upkeep, dividend: totals.dividend + dividend };
  }
  if (paused.size) report(state, now, 'Treasury', `Paused for at least one hour because payroll could not be funded: ${[...paused].join(', ')}.`);
  if (totals.revenue || totals.wages || totals.upkeep) {
    report(state, now, 'Treasury', `${hours} operating hour(s) closed: ${totals.revenue} revenue − ${totals.wages} wages − ${totals.upkeep} upkeep. Founder dividends ${totals.dividend}; treasury ${state.funds} credits.`);
  }
  return { minutes, hours };
}
