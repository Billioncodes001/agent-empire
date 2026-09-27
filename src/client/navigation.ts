import { SITES, managerAvailable, type SiteId, type EmpireState } from '../shared/empire';
import type { WorkerInfo } from '../shared/protocol';

export function assignedWorkers(id: SiteId, workers: Iterable<WorkerInfo>): WorkerInfo[] {
  const site = SITES.find((s) => s.id === id)!;
  const prefix = `Sector: ${site.sector} / ${site.name}\n`;
  return [...workers].filter((w) => w.kind === 'agent' && w.prompt?.startsWith(prefix) && !['exited', 'offline'].includes(w.status));
}
export function entranceAccess(id: SiteId, state: EmpireState, workers: Iterable<WorkerInfo>) {
  if (!state.sectors.find((s) => s.id === id)?.built) return { allowed: false, reason: 'Construction required' };
  if (id === 'hq' || id === 'home') return { allowed: true, reason: id === 'home' ? 'Private residence' : 'Headquarters' };
  const count = assignedWorkers(id, workers).length;
  const sector = state.sectors.find(s => s.id === id)!;
  if (managerAvailable(sector)) return { allowed: true, reason: `${sector.manager!.name} · ${sector.manager!.status === 'ready' ? 'ready' : 'on duty'}` };
  return {
    allowed: count > 0,
    reason: count ? `${count} assigned AI worker${count === 1 ? '' : 's'}` : sector.manager ? `Manager ${sector.manager.status} · ${sector.manager.status === 'offline' ? 'retry in Management' : 'awaiting agent startup'}` : 'Assign an AI worker to open this building',
  };
}
export const entrance = (id: SiteId) => {
  const site = SITES.find((s) => s.id === id)!;
  return { x: site.x + (id === 'home' ? 0 : 2.2), z: site.z + 6.2 };
};
/** Interior coordinates occupy a separate room; map them to the actual headquarters. */
export function worldPosition(x: number, z: number) {
  return z < 30 ? { x: -24 + x * 0.35, z: 48 + z * 0.35 } : { x, z };
}
export const MAP_BOUNDS = { minX: -64, maxX: 66, minZ: 22, maxZ: 153 };
export function mapPoint(x: number, z: number, width: number, height: number) {
  return {
    x: ((x - MAP_BOUNDS.minX) / (MAP_BOUNDS.maxX - MAP_BOUNDS.minX)) * width,
    y: ((z - MAP_BOUNDS.minZ) / (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ)) * height,
  };
}
export function mapWorld(x: number, y: number, width: number, height: number) {
  return {
    x: MAP_BOUNDS.minX + (x / width) * (MAP_BOUNDS.maxX - MAP_BOUNDS.minX),
    z: MAP_BOUNDS.minZ + (y / height) * (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ),
  };
}
