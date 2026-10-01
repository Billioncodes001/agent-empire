/**
 * Cloud-mode founding (followups-1): which paid startup jobs a founding plan queues, and what they may cost against
 * the user's limits. Pure, so the dialog copy and the intents it writes are unit-tested.
 */
import { MANAGER_NAMES, SITES, managerStartupPrompt, type EmpireState, type SiteId } from '../../shared/empire';
import type { CloudState } from '../../cloud/schema';
import { todaySpend } from './map';
import { stableUuid } from './uuid';

export interface FoundingBrief { site: SiteId; title: string; prompt: string }

/**
 * One startup brief per manager the plan appoints: the chief of staff, every selected site and any site already in
 * the district. A manager whose startup already reached a finished turn is not asked again.
 */
export function foundingBriefs(empire: EmpireState, selected: Iterable<SiteId>): FoundingBrief[] {
  const chosen = new Set(selected);
  return empire.sectors
    .filter((s) => s.id !== 'home' && (s.built || chosen.has(s.id)) && s.manager?.status !== 'ready')
    .sort((a, b) => SITES.findIndex((x) => x.id === a.id) - SITES.findIndex((x) => x.id === b.id))
    .map((s) => ({ site: s.id, title: `${MANAGER_NAMES[s.id]}: startup brief`, prompt: managerStartupPrompt(s.id, MANAGER_NAMES[s.id], 'coordinator') }));
}

/** What `jobs` startup jobs reserve against the limits recorded in the snapshot. */
export function foundingSpend(state: CloudState, jobs: number, now: number) {
  const today = todaySpend(state, now);
  const totalCents = jobs * today.perJobCents;
  // The coordinator admits a job while today's reservations plus its allowance fit the daily allowance (tick.ts).
  const leftTodayCents = Math.max(0, today.dailyCents - today.reservedCents);
  return { ...today, jobs, totalCents, leftTodayCents, fitsToday: totalCents <= leftTodayCents, maxConcurrent: state.meta.limits.maxConcurrent };
}

/**
 * A founding job's id is derived from the state repository, the Empire's creation time and the site, so the same plan
 * sent twice names the same jobs and the coordinator records the second as a duplicate (never a second payment).
 */
export function foundingJobId(repo: string, state: CloudState, site: SiteId): Promise<string> {
  return stableUuid(`agent-empire-founding:${repo.toLowerCase()}:${state.meta.createdAt}:${site}`);
}
