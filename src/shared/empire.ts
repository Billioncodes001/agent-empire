export const CITY = { minX: -55, maxX: 55, minZ: 30, maxZ: 153 };
export const SITES = [
  {
    id: 'hq',
    name: 'Empire headquarters',
    sector: 'Technology',
    x: -24,
    z: 48,
    color: '#c7d6db',
    cost: 0,
    capacity: 16,
    landCost: 0,
    rate: 0,
  },
  {
    id: 'home',
    name: 'Founder residence',
    sector: 'Residential',
    x: 24,
    z: 48,
    color: '#e8ddcb',
    cost: 0,
    capacity: 1,
    landCost: 0,
    rate: 0,
  },
  {
    id: 'hospital',
    name: 'Harbour hospital',
    sector: 'Healthcare',
    x: -24,
    z: 76,
    color: '#e3eeee',
    cost: 24000,
    capacity: 12,
    landCost: 0,
    rate: 180,
  },
  {
    id: 'school',
    name: 'Discovery academy',
    sector: 'Education',
    x: 24,
    z: 76,
    color: '#dec9af',
    cost: 18000,
    capacity: 10,
    landCost: 0,
    rate: 145,
  },
  {
    id: 'cafe',
    name: 'Common Ground café',
    sector: 'Hospitality',
    x: -24,
    z: 104,
    color: '#d5b598',
    cost: 8000,
    capacity: 6,
    landCost: 0,
    rate: 100,
  },
  {
    id: 'utilities',
    name: 'Clean energy campus',
    sector: 'Infrastructure',
    x: 24,
    z: 104,
    color: '#bdcdbd',
    cost: 20000,
    capacity: 8,
    landCost: 0,
    rate: 160,
  },
  {
    id: 'recreation',
    name: 'Waterfront recreation centre',
    sector: 'Recreation',
    x: -24,
    z: 132,
    color: '#bccbc4',
    cost: 12000,
    capacity: 8,
    landCost: 0,
    rate: 120,
  },
  {
    id: 'studio',
    name: 'Innovation studio',
    sector: 'Research',
    x: 24,
    z: 132,
    color: '#c3cdd4',
    cost: 22000,
    capacity: 10,
    landCost: 18000,
    rate: 195,
  },
] as const;
export type SiteId = (typeof SITES)[number]['id'];
export const STARTER_SITES = SITES.filter((s) => s.cost > 0 && s.landCost === 0);
export const MANAGER_NAMES: Record<SiteId, string> = {
  hq: 'Alex · Chief of staff',
  home: 'Residence',
  hospital: 'Maya · Health director',
  school: 'Daniel · Academy director',
  cafe: 'Amara · Café manager',
  utilities: 'Noah · Energy director',
  recreation: 'Leila · Recreation director',
  studio: 'Jordan · Research director',
};
export type ManagerStatus = 'pending' | 'queued' | 'working' | 'needs_input' | 'ready' | 'offline';
export interface SectorManager {
  id: string;
  name: string;
  status: ManagerStatus;
  attempt: number;
  jobKey: string;
  taskId?: string;
  workerId?: string;
  error?: string;
}
export interface SectorState {
  id: SiteId;
  owned: boolean;
  built: boolean;
  staff: number;
  service: number;
  level: number;
  revenue: number;
  wages: number;
  upkeep: number;
  manager?: SectorManager;
}
export interface EmpireReport {
  at: number;
  sector: string;
  text: string;
}
export interface EmployeeAccount {
  name: string;
  site: SiteId;
  role: 'manager' | 'service' | 'agent';
  earned: number;
}
export interface LedgerEntry {
  at: number;
  minute: number;
  label: string;
  revenue: number;
  wages: number;
  upkeep: number;
  dividend: number;
  capital: number;
  balance: number;
}
export interface EmpireState {
  version: 2;
  updatedAt: number;
  minutes: number;
  funds: number;
  delegated: boolean;
  setup: { completed: boolean; selected: SiteId[]; completedAt?: number };
  sectors: SectorState[];
  reports: EmpireReport[];
  workforce: {
    working: number;
    attention: number;
    done: number;
    queued: number;
  };
  economy: {
    startedAt: number;
    lastHour: number;
    revenue: number;
    wages: number;
    upkeep: number;
    dividends: number;
    capital: number;
    ownerBalance: number;
    rewardedTasks: string[];
    employees: Record<string, EmployeeAccount>;
    ledger: LedgerEntry[];
  };
}
export type EmpireAction =
  | { kind: 'delegate'; enabled: boolean }
  | { kind: 'found'; sites: SiteId[] }
  | {
      kind: 'build' | 'hire' | 'buy-land' | 'upgrade' | 'retry-manager';
      site: SiteId;
    }
  | { kind: 'reinvest' };
export function newSector(id: SiteId): SectorState {
  const site = SITES.find((s) => s.id === id)!;
  return {
    id,
    owned: site.landCost === 0,
    built: site.cost === 0,
    staff: 0,
    service: 0,
    level: 1,
    revenue: 0,
    wages: 0,
    upkeep: 0,
  };
}
export function initialEmpire(now = Date.now()): EmpireState {
  return {
    version: 2,
    updatedAt: now,
    minutes: 480,
    funds: 100000,
    delegated: true,
    setup: { completed: false, selected: [] },
    sectors: SITES.map((s) => newSector(s.id)),
    reports: [
      {
        at: now,
        sector: 'Executive',
        text: 'Choose your founding buildings. City income, salaries and expansion use simulation credits; actual AI usage is billed by your provider.',
      },
    ],
    workforce: { working: 0, attention: 0, done: 0, queued: 0 },
    economy: {
      startedAt: now,
      lastHour: 8,
      revenue: 0,
      wages: 0,
      upkeep: 0,
      dividends: 0,
      capital: 0,
      ownerBalance: 0,
      rewardedTasks: [],
      employees: {},
      ledger: [],
    },
  };
}
export const managerAvailable = (sector: SectorState) =>
  !!sector.manager && ['working', 'needs_input', 'ready'].includes(sector.manager.status);
export const upgradeCost = (sector: SectorState) => Math.round((SITES.find((s) => s.id === sector.id)!.cost || 12000) * 0.5 * sector.level);
/** One simulated hour is one minute of server uptime. Revenue requires an actual manager assignment. */
export function hourlyRates(sector: SectorState) {
  const site = SITES.find((s) => s.id === sector.id)!;
  if (!sector.built || sector.id === 'home' || !managerAvailable(sector)) return { revenue: 0, wages: 0, upkeep: 0 };
  const revenue = sector.staff > 0 ? Math.round((site.rate + sector.staff * 28) * (1 + (sector.level - 1) * 0.3)) : 0;
  return {
    revenue,
    wages: (sector.id === 'hq' ? 60 : 40) + sector.staff * 18,
    upkeep: sector.id === 'hq' ? 10 : 20 * sector.level,
  };
}
