import { newCity, type CityState, type PlotId, type VehicleModelId } from './city.js';
/** Walkable city rectangle (founding district plus FREE-09's business and harbour districts east of x = 55). */
export const CITY = { minX: -55, maxX: 150, minZ: 30, maxZ: 215 };
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
/**
 * The bounded startup brief an appointed manager runs once. The server queues it after founding; in cloud mode the
 * founding dialog submits it as a paid cloud job. `monitor` names who keeps the simulation running afterwards.
 */
export function managerStartupPrompt(siteId: SiteId, managerName: string, monitor: 'server' | 'coordinator' = 'server'): string {
  const site = SITES.find((s) => s.id === siteId)!;
  return `Sector: ${site.sector} / ${site.name}\n\nYou are ${managerName}, an appointed manager in Agent Empire. This is a bounded startup task in the user's real project. Inspect the project and write a concise administrative brief to docs/empire/${site.id}-brief.md. Identify useful real AI tasks this sector could perform for this project, dependencies and questions for the founder. ${site.id === 'hq' ? 'As chief of staff, cover coordination, budgets, blockers and reporting across all selected sectors.' : 'Coordinate your sector with the chief of staff.'} Do not invent completed work, actual revenue, medical services or external activity. Do not start background jobs or contact anyone. Finish after producing the brief; ${monitor === 'server' ? 'the server handles' : 'the cloud coordinator in the user’s GitHub handles'} ongoing simulation monitoring.`;
}
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
/** Runtime observations, rebuilt after restart; never proof of an autonomous supervisor. */
export interface SupervisionState {
  schemaVersion: 1;
  serverRunId: string;
  observedAt: number;
  delegationRequested: boolean;
  monitor: { mode: 'rule_based'; lastCheckAt: number };
  chief: {
    phase: 'unassigned' | 'pending' | 'queued' | 'starting' | 'idle' | 'working' | 'needs_input' | 'turn_ended' | 'interrupted' | 'failed' | 'unknown';
    managerId?: string;
    taskId?: string;
    workerId?: string;
    reason?: string;
  };
  workforce: { active: number; attention: number; queued: number };
}
export interface EmpireState {
  version: 2;
  updatedAt: number;
  minutes: number;
  funds: number;
  delegated: boolean;
  /** Ephemeral projection; ignored when restoring a saved city. */
  supervision?: SupervisionState;
  setup: { completed: boolean; selected: SiteId[]; completedAt?: number };
  office: { floors: number; workstations: number };
  /** FREE-09 plots and garage vehicles. Absent in saves written before FREE-09 (see shared/city.ts normalizeCity). */
  city?: CityState;
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
  | { kind: 'reinvest' }
  | { kind: 'office-floor' | 'office-workstation' }
  /** `nonce`: one per click (shared/city.ts PURCHASE_NONCE); a repeat is refused so a purchase happens once. */
  | { kind: 'buy-plot'; plot: PlotId; nonce: string }
  | { kind: 'buy-vehicle'; model: VehicleModelId; nonce: string }
  /** `blocked`: apron slots the client sees occupied by live objects (the driven sedan, the founder). */
  | { kind: 'vehicle-spawn'; vehicle: string; blocked?: number[] }
  | { kind: 'vehicle-store'; vehicle: string };
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
    office: { floors: 1, workstations: 4 },
    city: newCity(),
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

/** Treasury purchases fund physical capacity; provider concurrency remains separately controlled. */
export const officeFloorCost = (office: EmpireState['office']) => 25000 * office.floors;
export const workstationCost = (office: EmpireState['office']) => 1500 + 250 * Math.floor(office.workstations / 16);
