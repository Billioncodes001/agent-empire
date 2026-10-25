/**
 * CITY-09: rule-based growth, the architect's free engine and default fallback. Deterministic for a seed (the host uses
 * the local day and the document revision), it follows the journal's style guide and avoid-rules, and only ever
 * proposes changes `applyChanges` accepts:
 * 1. repairs first: an addition the rules no longer accept is moved within its lot, or removed;
 * 2. then growth: lots furthest below their density target get plants, lamps, décor, a sign or a small building, and
 *    now and then a free façade anchor gets its awning or parasol.
 */
import {
  ANCHORS, CATALOG, LOTS, WORLD_CAPS, avoidedBy, catalogEntry, footprintOf, invalidAdditions, placementProblem,
  type AdditionKind, type AvoidRule, type CatalogEntry, type Lot, type ProposedChange, type Quarter, type WorldAddition, type WorldDocument,
} from './world.js';

export interface GrowthOptions {
  seed: string;
  maxChanges: number;
  avoid: readonly AvoidRule[];
  /** Additions per square metre each district aims for (style guide). */
  density?: { business: number; harbour: number };
}

export const DEFAULT_DENSITY = { business: 0.03, harbour: 0.035 };
const KIND_WEIGHT: Record<AdditionKind, number> = { landscape: 3, light: 2, decor: 2, building: 1, sign: 0.6 };
const SIGN_NAMES: Record<string, string> = {
  'meridian-north-verge': 'MERIDIAN NORTH WALK', 'meridian-north-east-verge': 'NORTH-EAST VERGE', 'meridian-plaza-east-strip': 'PLAZA EAST',
  'harbour-quay-green': 'QUAY GREEN', 'harbour-works-yard': 'WORKS YARD', 'harbour-yard-west': 'YARD WEST', 'harbour-yard-east': 'YARD EAST',
};

function rng(seed: string) {
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], weight: (t: T) => number, r: () => number): T | undefined {
  const total = items.reduce((s, t) => s + Math.max(0, weight(t)), 0);
  if (total <= 0) return undefined;
  let x = r() * total;
  for (const t of items) { x -= Math.max(0, weight(t)); if (x <= 0) return t; }
  return items[items.length - 1];
}

const q = (n: number) => Math.round(n * 4) / 4;
const area = (l: Lot) => (l.maxX - l.minX) * (l.maxZ - l.minZ);

/** A free grid position for `e` in `lot`, or undefined after a bounded number of tries. */
function findSpot(e: CatalogEntry, lot: Lot, yaw: Quarter, others: readonly WorldAddition[], avoid: readonly AvoidRule[], r: () => number, text?: string) {
  const f = footprintOf(e, 0, 0, yaw);
  const x0 = Math.ceil((lot.minX - f.minX) * 4) / 4, x1 = Math.floor((lot.maxX - f.maxX) * 4) / 4;
  const z0 = Math.ceil((lot.minZ - f.minZ) * 4) / 4, z1 = Math.floor((lot.maxZ - f.maxZ) * 4) / 4;
  if (x1 < x0 || z1 < z0) return undefined;
  for (let i = 0; i < 30; i++) {
    const p = { model: e.id, lot: lot.id, x: q(x0 + r() * (x1 - x0)), z: q(z0 + r() * (z1 - z0)), yaw, ...(text ? { text } : {}) };
    if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) continue;
    if (!placementProblem(p, others, { avoid })) return p;
  }
  return undefined;
}

function reasonFor(e: CatalogEntry, where: string): string {
  const label = e.label[0].toUpperCase() + e.label.slice(1);
  const text = e.kind === 'building' ? `A small ${e.label} to fill the empty ${where}`
    : e.kind === 'decor' ? `${label} to make the ${where} feel lived in`
      : e.kind === 'landscape' ? `${label} for shade and green on the ${where}`
        : e.kind === 'light' ? `A ${e.label} so the ${where} is lit at night`
          : `A street sign naming the ${where}`;
  return text.slice(0, WORLD_CAPS.reason);
}

export function generateGrowth(doc: WorldDocument, opts: GrowthOptions): ProposedChange[] {
  const r = rng(opts.seed);
  const max = Math.max(0, Math.min(opts.maxChanges, WORLD_CAPS.perRun));
  const density = opts.density ?? DEFAULT_DENSITY;
  const sim: WorldAddition[] = structuredClone(doc.additions);
  const changes: ProposedChange[] = [];
  let pseudo = 1;

  // 1. Repairs.
  for (const bad of invalidAdditions({ ...doc, additions: sim })) {
    if (changes.length >= max) return changes;
    const at = sim.findIndex((a) => a.id === bad.id);
    const a = sim[at];
    const lot = a.lot ? LOTS.find((l) => l.id === a.lot) : undefined;
    const e = catalogEntry(a.model);
    const others = sim.filter((o) => o.id !== a.id);
    const spot = lot && e && !a.anchor ? findSpot(e, lot, a.yaw, others, [], r, a.text) : undefined;
    const why = bad.problem.slice(0, 80);
    if (spot) {
      changes.push({ op: 'move', id: a.id, x: spot.x, z: spot.z, yaw: spot.yaw, reason: `Repair: ${why}; moved within the lot`.slice(0, WORLD_CAPS.reason) });
      sim[at] = { ...a, x: spot.x, z: spot.z };
    } else {
      changes.push({ op: 'remove', id: a.id, reason: `Repair: ${why}`.slice(0, WORLD_CAPS.reason) });
      sim.splice(at, 1);
    }
  }

  // 2. Growth.
  const count = (kind: AdditionKind) => sim.filter((a) => catalogEntry(a.model)?.kind === kind).length;
  for (let attempt = 0; changes.length < max && attempt < 40 && sim.length < WORLD_CAPS.total; attempt++) {
    const freeAnchors = ANCHORS.filter((a) => !sim.some((s) => s.anchor === a.id) && a.models.some((m) => !avoidedBy({ model: m }, opts.avoid)));
    if (freeAnchors.length && count('decor') < WORLD_CAPS.perKind.decor && r() < 0.15) {
      const a = freeAnchors[Math.floor(r() * freeAnchors.length)];
      const model = a.models.find((m) => !avoidedBy({ model: m }, opts.avoid))!;
      const p = { model, anchor: a.id, x: a.x, z: a.z, yaw: a.yaw };
      if (!placementProblem(p, sim, { avoid: opts.avoid })) {
        const e = catalogEntry(model)!;
        const reason = `${e.label[0].toUpperCase()}${e.label.slice(1)} on the ${a.name}`.slice(0, WORLD_CAPS.reason);
        changes.push({ op: 'place', ...p, reason });
        sim.push({ id: `G${pseudo++}`, ...p, day: '2000-01-01', runId: 'R1', engine: 'rules', reason, addedAt: 0 });
        continue;
      }
    }
    const lot = pick(LOTS, (l) => Math.floor(area(l) * density[l.district]) - sim.filter((s) => s.lot === l.id).length, r);
    if (!lot) break;
    const options = CATALOG.filter((e) => !e.anchorOnly && lot.kinds.includes(e.kind) && e.districts.includes(lot.district) && count(e.kind) < WORLD_CAPS.perKind[e.kind]
      && !avoidedBy({ model: e.id, lot: lot.id }, opts.avoid) && !(e.kind === 'sign' && sim.some((s) => s.lot === lot.id && catalogEntry(s.model)?.kind === 'sign')));
    const e = pick(options, (o) => KIND_WEIGHT[o.kind] / options.filter((x) => x.kind === o.kind).length, r);
    if (!e) continue;
    const yaw: Quarter = e.kind === 'building' || e.kind === 'sign' || e.kind === 'light' ? lot.face : (Math.floor(r() * 4) as Quarter);
    const spot = findSpot(e, lot, yaw, sim, opts.avoid, r, e.kind === 'sign' ? SIGN_NAMES[lot.id] ?? 'CITY WALK' : undefined);
    if (!spot) continue;
    const reason = reasonFor(e, lot.name);
    changes.push({ op: 'place', ...spot, reason });
    sim.push({ id: `G${pseudo++}`, ...spot, day: '2000-01-01', runId: 'R1', engine: 'rules', reason, addedAt: 0 });
  }
  return changes;
}
