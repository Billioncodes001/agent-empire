export const CITY = { minX: -55, maxX: 55, minZ: 30, maxZ: 125 };
export const SITES = [
  { id: 'hq', name: 'Empire headquarters', sector: 'Technology', x: -24, z: 48, color: '#c7d6db', cost: 0, capacity: 16 },
  { id: 'home', name: 'Founder residence', sector: 'Residential', x: 24, z: 48, color: '#e8ddcb', cost: 0, capacity: 1 },
  { id: 'hospital', name: 'Harbour hospital', sector: 'Healthcare', x: -24, z: 76, color: '#e3eeee', cost: 24000, capacity: 12 },
  { id: 'school', name: 'Discovery academy', sector: 'Education', x: 24, z: 76, color: '#dec9af', cost: 18000, capacity: 10 },
  { id: 'cafe', name: 'Common Ground café', sector: 'Hospitality', x: -24, z: 104, color: '#d5b598', cost: 8000, capacity: 6 },
  { id: 'utilities', name: 'Clean energy campus', sector: 'Infrastructure', x: 24, z: 104, color: '#bdcdbd', cost: 20000, capacity: 8 },
] as const;
export type SiteId = typeof SITES[number]['id'];
export interface SectorState { id: SiteId; built: boolean; staff: number; service: number; }
export interface EmpireReport { at: number; sector: string; text: string; }
export interface EmpireState {
  version: 1; updatedAt: number; minutes: number; funds: number; delegated: boolean;
  sectors: SectorState[]; reports: EmpireReport[];
  workforce: { working: number; attention: number; done: number; queued: number };
}
export type EmpireAction = { kind: 'delegate'; enabled: boolean } | { kind: 'build' | 'hire'; site: SiteId };
export function initialEmpire(now = Date.now()): EmpireState {
  return { version: 1, updatedAt: now, minutes: 480, funds: 100000, delegated: false,
    sectors: SITES.map(s => ({ id: s.id, built: s.cost === 0, staff: 0, service: 0 })),
    reports: [{ at: now, sector: 'Executive', text: 'Welcome to your founding district. Construction and service staff use simulation credits; AI usage is tracked separately.' }],
    workforce: { working: 0, attention: 0, done: 0, queued: 0 } };
}
