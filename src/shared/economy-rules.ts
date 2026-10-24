/**
 * The one copy of the city economy rules (docs/ECONOMY.md), shared by the host (src/server/empire.ts)
 * and the cloud coordinator (src/cloud/economy.ts). Pure: no filesystem, queue or clock access; the
 * caller passes `now`. Each mode keeps its own report wording through `CityActionText`; amounts,
 * validation, error messages and ledger entries are identical in both modes.
 * All amounts are fictional simulation credits, never provider spending.
 */
import {
  hourlyRates, MANAGER_NAMES, officeFloorCost, SITES, STARTER_SITES, upgradeCost, workstationCost,
  type EmpireAction, type EmpireState, type SectorState, type SiteId,
} from './empire.js';
import { DESKS_PER_FLOOR } from './layout.js';
import { freeApronSlot, freeBay, GARAGE, MAX_NONCES, normalizeCity, PLOTS, PURCHASE_NONCE, VEHICLE_MODELS } from './city.js';

export type SiteDefinition = (typeof SITES)[number];

export const HIRE_COST = 1200;
export const SERVICE_WAGE = 18;
export const managerWage = (site: SiteId) => (site === 'hq' ? 60 : 40);
/** A completed (server) or accepted (cloud) AI task: revenue, worker pay and founder dividend. */
export const TASK_REWARD = { revenue: 500, wages: 50, dividend: 90 } as const;
export const DIVIDEND_SHARE = 0.2;
export const LEDGER_LIMIT = 100;

export const CAPITAL_LABELS: Record<string, string> = {
  'buy-land': 'Land purchase',
  build: 'Construction',
  hire: 'Recruitment',
  upgrade: 'Building upgrade',
  reinvest: 'Founder reinvestment',
  'office-floor': 'Headquarters floor construction',
  'office-workstation': 'Workstation installation',
  'buy-plot': 'District plot purchase',
  'buy-vehicle': 'Garage vehicle purchase',
};

export type EmployeeRole = 'manager' | 'service' | 'agent';

export function payEmployee(state: EmpireState, id: string, name: string, site: SiteId, role: EmployeeRole, amount: number) {
  const account = (state.economy.employees[id] ??= { name, site, role, earned: 0 });
  account.earned += amount;
}

export function recordLedger(state: EmpireState, now: number, label: string, revenue: number, wages: number, upkeep: number, dividend: number, capital = 0) {
  const e = state.economy;
  e.revenue += revenue; e.wages += wages; e.upkeep += upkeep; e.dividends += dividend; e.ownerBalance += dividend; e.capital += capital;
  state.funds += revenue - wages - upkeep - dividend - capital;
  e.ledger.unshift({ at: now, minute: state.minutes, label, revenue, wages, upkeep, dividend, capital, balance: state.funds });
  e.ledger = e.ledger.slice(0, LEDGER_LIMIT);
}

export function appointManager(sector: SectorState) {
  if (sector.id === 'home' || sector.manager) return;
  sector.manager = { id: `manager-${sector.id}`, name: MANAGER_NAMES[sector.id], status: 'pending', attempt: 1, jobKey: `empire-manager-${sector.id}-1` };
}

/** Service coverage percentage: staffing against capacity, plus 30% per level above one. */
export function serviceCoverage(sector: SectorState): number {
  const site = SITES.find(s => s.id === sector.id)!;
  return sector.built ? Math.min(100, Math.round((sector.staff / site.capacity) * 100 * (1 + (sector.level - 1) * 0.3))) : 0;
}

/** Report wording per mode. Rules and amounts never depend on it. */
export interface CityActionText {
  founded(builtCount: number): string;
  floor(floors: number): string;
  workstation(workstations: number): string;
  delegated(enabled: boolean): string;
  reinvested(amount: number): string;
  land(site: SiteDefinition): string;
  built(site: SiteDefinition): string;
  hired(site: SiteDefinition, staff: number): string;
  upgraded(site: SiteDefinition, level: number): string;
}

export type CityReport = (sector: string, text: string) => void;

/**
 * Applies one city action shared by both modes (everything except the host-only `retry-manager`).
 * Mutates `state`; returns a user-safe error without changing anything on failure. Capital spent is
 * moved into one ledger entry.
 */
export function applyCityAction(state: EmpireState, action: EmpireAction, now: number, text: CityActionText, report: CityReport): string | undefined {
  const beforeFunds = state.funds;
  if (action.kind === 'found') {
    if (state.setup.completed) return 'Founding setup is already complete';
    if (!Array.isArray(action.sites) || action.sites.length > STARTER_SITES.length || new Set(action.sites).size !== action.sites.length
      || action.sites.some(id => !STARTER_SITES.some(s => s.id === id))) return 'Choose valid starting buildings';
    for (const sector of state.sectors) {
      if (action.sites.includes(sector.id)) { sector.built = true; sector.owned = true; }
      if (sector.built) { appointManager(sector); if (!['hq', 'home'].includes(sector.id)) sector.staff = Math.max(1, sector.staff); }
    }
    state.setup = { completed: true, selected: [...action.sites], completedAt: now };
    state.delegated = true;
    state.economy.startedAt = now;
    state.economy.lastHour = Math.floor(state.minutes / 60);
    report('Chief of staff', text.founded(state.sectors.filter(s => s.built).length));
  } else if (action.kind === 'office-floor' || action.kind === 'office-workstation') {
    if (!state.setup.completed) return 'Complete founding setup first';
    const office = state.office; const floor = action.kind === 'office-floor';
    if (!floor && office.workstations >= office.floors * DESKS_PER_FLOOR) return 'Build another floor before adding workstations';
    const cost = floor ? officeFloorCost(office) : workstationCost(office);
    if (!Number.isSafeInteger(cost) || state.funds < cost) return 'Insufficient simulation credits';
    state.funds -= cost;
    if (floor) office.floors++; else office.workstations++;
    report('Headquarters', floor ? text.floor(office.floors) : text.workstation(office.workstations));
  } else if (action.kind === 'delegate') {
    if (typeof action.enabled !== 'boolean') return 'Invalid delegation setting';
    state.delegated = action.enabled;
    report('Executive', text.delegated(action.enabled));
  } else if (action.kind === 'reinvest') {
    if (state.economy.ownerBalance <= 0) return 'No founder earnings available';
    state.funds += state.economy.ownerBalance;
    report('Treasury', text.reinvested(state.economy.ownerBalance));
    state.economy.ownerBalance = 0;
  } else if (action.kind === 'build' || action.kind === 'hire' || action.kind === 'buy-land' || action.kind === 'upgrade') {
    const site = SITES.find(s => s.id === action.site); const sector = state.sectors.find(s => s.id === action.site);
    if (!site || !sector) return 'Unknown site';
    if (action.kind === 'buy-land') {
      if (sector.owned) return 'Land already owned';
      if (state.funds < site.landCost) return 'Insufficient simulation credits';
      state.funds -= site.landCost; sector.owned = true;
      report('Expansion', text.land(site));
    } else if (action.kind === 'build') {
      if (sector.built) return 'Already built';
      if (!sector.owned) return 'Buy this land first';
      if (state.funds < site.cost) return 'Insufficient simulation credits';
      state.funds -= site.cost; sector.built = true; sector.staff = 1; appointManager(sector);
      report(site.sector, text.built(site));
    } else if (action.kind === 'hire') {
      if (sector.id === 'hq') return 'Employ AI workers at a furnished headquarters workstation';
      if (!sector.built) return 'Build this site first';
      if (sector.staff >= site.capacity) return 'Team is at capacity';
      if (state.funds < HIRE_COST) return 'Hiring requires 1,200 simulation credits';
      state.funds -= HIRE_COST; sector.staff++;
      report(site.sector, text.hired(site, sector.staff));
    } else {
      if (sector.id === 'hq') return 'Expand headquarters through floors and workstations';
      if (!sector.built) return 'Build this site first';
      if (sector.id === 'home' || sector.level >= 3) return 'No further upgrades available';
      const cost = upgradeCost(sector);
      if (state.funds < cost) return 'Insufficient simulation credits';
      state.funds -= cost; sector.level++;
      report(site.sector, text.upgraded(site, sector.level));
    }
  } else if (action.kind === 'buy-plot' || action.kind === 'buy-vehicle' || action.kind === 'vehicle-spawn' || action.kind === 'vehicle-store') {
    const error = applyGarageAction(state, action, now, report);
    if (error) return error;
  } else return 'Unknown operation';
  if (state.funds !== beforeFunds) {
    const capital = beforeFunds - state.funds; state.funds = beforeFunds;
    // Labels come from the action kind's own fields only; stray fields (e.g. `site` on buy-plot) are ignored.
    const site = action.kind === 'buy-plot' ? PLOTS.find(p => p.id === action.plot)?.name
      : action.kind === 'buy-vehicle' ? VEHICLE_MODELS.find(m => m.id === action.model)?.name
        : 'site' in action ? SITES.find(s => s.id === action.site)?.name : '';
    const label = CAPITAL_LABELS[action.kind] ?? action.kind;
    recordLedger(state, now, `${label}${site ? ' · ' + site : ''}`, 0, 0, 0, 0, capital);
  }
  return undefined;
}

type GarageAction = Extract<EmpireAction, { kind: 'buy-plot' | 'buy-vehicle' | 'vehicle-spawn' | 'vehicle-store' }>;
/**
 * FREE-09 (CITY-05/07): district plots and garage vehicles. Purchases spend fictional city credits (the caller moves
 * them into one capital ledger entry); bringing a vehicle out or storing it is free. Validates before mutating.
 */
function applyGarageAction(state: EmpireState, action: GarageAction, now: number, report: CityReport): string | undefined {
  const city = normalizeCity(state.city);
  if (action.kind === 'buy-plot' || action.kind === 'buy-vehicle') {
    if (!state.setup.completed) return 'Complete founding setup first';
    if (typeof action.nonce !== 'string' || !PURCHASE_NONCE.test(action.nonce)) return 'Invalid purchase request';
    if (city.nonces?.includes(action.nonce)) return 'This purchase was already made';
  }
  if (action.kind === 'buy-plot') {
    const plot = PLOTS.find(p => p.id === action.plot);
    if (!plot) return 'Unknown plot';
    if (city.plots.includes(plot.id)) return 'Plot already owned';
    if (state.funds < plot.cost) return 'Insufficient simulation credits';
    state.funds -= plot.cost; city.plots.push(plot.id);
    report('Expansion', `${plot.name} acquired for ${plot.cost.toLocaleString('en-US')} city credits. Building on district parcels is coming in a later update.`);
  } else if (action.kind === 'buy-vehicle') {
    const model = VEHICLE_MODELS.find(m => m.id === action.model);
    if (!model) return 'Unknown vehicle';
    const bay = freeBay(city);
    if (bay < 0) return 'Every garage bay is occupied';
    if (state.funds < model.cost) return 'Insufficient simulation credits';
    state.funds -= model.cost;
    let n = city.vehicles.length + 1;
    while (city.vehicles.some(v => v.id === `vehicle-${n}`)) n++;
    city.vehicles.push({ id: `vehicle-${n}`, model: model.id, bay, purchasedAt: now });
    report('Garage', `${model.name} bought for ${model.cost.toLocaleString('en-US')} city credits and parked in bay ${bay + 1} of ${GARAGE.name}.`);
  } else {
    const vehicle = city.vehicles.find(v => v.id === action.vehicle);
    if (!vehicle) return 'Unknown vehicle';
    if (action.kind === 'vehicle-store') {
      if (vehicle.apron === undefined) return 'Vehicle is already in its bay';
      delete vehicle.apron;
    } else {
      if (vehicle.apron !== undefined) return 'Vehicle is already outside';
      const blocked = Array.isArray(action.blocked) ? action.blocked.filter(i => Number.isInteger(i)) : [];
      const slot = freeApronSlot(city, blocked);
      if (slot < 0) return 'The garage apron is occupied. Move the vehicle blocking the exit, then try again.';
      vehicle.apron = slot;
    }
  }
  if (action.kind === 'buy-plot' || action.kind === 'buy-vehicle') city.nonces = [...(city.nonces ?? []), action.nonce].slice(-MAX_NONCES);
  state.city = city;
  return undefined;
}

/** Credits one finished AI task to its sector and payee (the caller enforces once-per-task). */
export function creditTaskReward(state: EmpireState, now: number, reward: { site: SiteId; payeeId: string; payeeName: string; role: EmployeeRole; label: string }) {
  const sector = state.sectors.find(s => s.id === reward.site)!;
  payEmployee(state, reward.payeeId, reward.payeeName, reward.site, reward.role, TASK_REWARD.wages);
  sector.revenue += TASK_REWARD.revenue; sector.wages += TASK_REWARD.wages;
  recordLedger(state, now, reward.label, TASK_REWARD.revenue, TASK_REWARD.wages, 0, TASK_REWARD.dividend);
}

export interface HourSettlement { revenue: number; wages: number; upkeep: number; dividend: number; paused: string[] }

/**
 * Settles one operating hour: each staffed sector pays wages and upkeep and earns revenue if the
 * treasury can fund its payroll, otherwise it pauses for the hour. 20% of the positive operating
 * result is the founder dividend. Writes one ledger entry when anything moved.
 */
export function settleOperatingHour(state: EmpireState, now: number): HourSettlement {
  let revenue = 0, wages = 0, upkeep = 0;
  const paused: string[] = [];
  for (const sector of state.sectors) {
    const rate = hourlyRates(sector);
    if (!rate.wages) continue;
    if (state.funds + revenue + rate.revenue - wages - upkeep < rate.wages + rate.upkeep) { paused.push(SITES.find(s => s.id === sector.id)!.name); continue; }
    revenue += rate.revenue; wages += rate.wages; upkeep += rate.upkeep;
    sector.revenue += rate.revenue; sector.wages += rate.wages; sector.upkeep += rate.upkeep;
    payEmployee(state, sector.manager!.id, sector.manager!.name, sector.id, 'manager', managerWage(sector.id));
    for (let i = 0; i < sector.staff; i++) payEmployee(state, `service-${sector.id}-${i}`, `Service employee ${i + 1}`, sector.id, 'service', SERVICE_WAGE);
  }
  const dividend = Math.floor(Math.max(0, revenue - wages - upkeep) * DIVIDEND_SHARE);
  if (revenue || wages || upkeep) recordLedger(state, now, 'Hourly sector operations', revenue, wages, upkeep, dividend);
  return { revenue, wages, upkeep, dividend, paused };
}
