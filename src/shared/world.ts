/**
 * CITY-10: the city architect's world-additions document and the rules every change must pass. Pure data and pure
 * functions, shared by the office host (which writes `<dataDir>/world/additions.json`) and the game (which validates it
 * again before rendering). Data only: nothing here or in the document is ever executed.
 *
 * - The catalogue is a subset of the models already shipped in the Kenney CC0 city kits (footprints copied exactly from
 *   `src/client/public/models/city/manifest.json`; tests/world.test.ts fails on drift) plus two original procedural
 *   plants. Nothing new is downloaded.
 * - Lots are rectangles in the Meridian business district and Harbour works, proven clear of every road, kerb, plot,
 *   the garage (door, kerb slots, staircase, helipad), the quay and every district placement and collider by the same
 *   tests that check the district layout. The founding district (spawn, headquarters) has none.
 * - Every change is checked: known model; on the 0.25 m grid; inside a lot that allows its kind and district (or exactly
 *   on an anchor); clear of keep-clear boxes, the game's live colliders and other additions; avoid-rules; caps that keep
 *   the phone frame budget. A run applies all of its changes or none of them.
 */
import { DISTRICTS, PLOTS, GARAGE, type DistrictId } from './city.js';

export const WORLD_SCHEMA = 1;
export type AdditionKind = 'building' | 'decor' | 'landscape' | 'light' | 'sign';
export type WorldKit = 'commercial' | 'industrial' | 'streets' | 'flora';
export type ArchitectEngine = 'rules' | 'free' | 'premium';
export type Quarter = 0 | 1 | 2 | 3;
type GrowDistrict = Exclude<DistrictId, 'founding'>;

export interface CatalogEntry {
  id: string;
  kit: WorldKit;
  model: string;
  kind: AdditionKind;
  label: string;
  /** Model-space footprint [x, z] before scale (Kenney manifest bounds), and the model's height. */
  min: [number, number];
  max: [number, number];
  top: number;
  scale: number;
  districts: GrowDistrict[];
  /** Placed only on an anchor (façade decor). */
  anchorOnly?: true;
}

const B: GrowDistrict[] = ['business'], H: GrowDistrict[] = ['harbour'], BH: GrowDistrict[] = ['business', 'harbour'];
const entry = (kit: WorldKit, model: string, kind: AdditionKind, label: string, min: [number, number], max: [number, number], top: number, scale: number, districts: GrowDistrict[], anchorOnly = false): CatalogEntry =>
  ({ id: `${kit}/${model}`, kit, model, kind, label, min, max, top, scale, districts, ...(anchorOnly ? { anchorOnly: true as const } : {}) });

/** Kiosk-scale buildings (scale 6 instead of the district's 9), décor, lamps, the street sign and procedural plants. */
export const CATALOG: readonly CatalogEntry[] = [
  entry('commercial', 'building-a', 'building', 'corner shop', [-0.442, -0.47], [0.442, 0.47], 1.293, 6, B),
  entry('commercial', 'building-g', 'building', 'café pavilion', [-0.485, -0.461], [0.485, 0.461], 1.693, 6, B),
  entry('commercial', 'building-h', 'building', 'studio kiosk', [-0.442, -0.504], [0.442, 0.504], 1.293, 6, B),
  entry('industrial', 'building-k', 'building', 'workshop shed', [-0.651, -0.464], [0.651, 0.45], 0.773, 6, H),
  entry('commercial', 'detail-parasol-a', 'decor', 'café parasol', [-0.173, -0.2], [0.173, 0.2], 0.45, 9, B),
  entry('commercial', 'detail-awning-wide', 'decor', 'shop awning', [-0.4, 0.1], [0.4, 0.248], 0.4, 9, B, true),
  entry('streets', 'dumpster', 'decor', 'dumpster', [-0.13, -0.185], [0.145, 0.185], 0.209, 7, H),
  entry('industrial', 'shipping-container-a', 'decor', 'shipping container', [-0.186, -0.411], [0.186, 0.411], 0.348, 9, H),
  entry('industrial', 'shipping-container-b', 'decor', 'shipping container', [-0.186, -0.411], [0.186, 0.411], 0.348, 9, H),
  entry('industrial', 'shipping-container-c', 'decor', 'shipping container', [-0.186, -0.411], [0.186, 0.411], 0.348, 9, H),
  entry('industrial', 'detail-tank', 'decor', 'storage tank', [-0.424, -0.258], [0.424, 0.258], 0.415, 9, H),
  entry('streets', 'light-square', 'light', 'street lamp', [-0.025, -0.213], [0.025, 0.025], 0.6, 7, BH),
  entry('streets', 'light-curved-double', 'light', 'double lamp', [-0.025, -0.2], [0.025, 0.2], 0.675, 7, BH),
  entry('streets', 'road-sign-street', 'sign', 'street sign', [-0.171, -0.025], [0.025, 0.171], 0.475, 7, BH),
  entry('flora', 'tree-round', 'landscape', 'round tree', [-1.6, -1.6], [1.6, 1.6], 5.2, 1, BH),
  entry('flora', 'shrub', 'landscape', 'shrub', [-0.7, -0.7], [0.7, 0.7], 0.9, 1, BH),
];
export type CatalogId = string;
export const catalogEntry = (id: string): CatalogEntry | undefined => CATALOG.find((e) => e.id === id);

export interface Lot { id: string; name: string; district: GrowDistrict; minX: number; maxX: number; minZ: number; maxZ: number; kinds: AdditionKind[]; /** Quarter turn that faces the nearest street (buildings, signs). */ face: Quarter }
const ALL: AdditionKind[] = ['building', 'decor', 'landscape', 'light', 'sign'];
export const LOTS: readonly Lot[] = [
  { id: 'meridian-north-verge', name: 'Meridian north verge', district: 'business', minX: 55.6, maxX: 91.0, minZ: 30.6, maxZ: 38.4, kinds: ALL, face: 0 },
  { id: 'meridian-north-east-verge', name: 'Meridian north-east verge', district: 'business', minX: 108.8, maxX: 149.4, minZ: 30.6, maxZ: 36.4, kinds: ['decor', 'landscape', 'light', 'sign'], face: 0 },
  { id: 'meridian-plaza-east-strip', name: 'Meridian Plaza east strip', district: 'business', minX: 144.8, maxX: 149.4, minZ: 97.8, maxZ: 110.8, kinds: ['landscape', 'light'], face: 3 },
  { id: 'harbour-quay-green', name: 'Harbour Quay green', district: 'harbour', minX: 108.8, maxX: 116.6, minZ: 142.6, maxZ: 153.4, kinds: ALL, face: 3 },
  { id: 'harbour-works-yard', name: 'Harbour works yard', district: 'harbour', minX: 120.0, maxX: 149.4, minZ: 146.0, maxZ: 153.4, kinds: ALL, face: 0 },
  { id: 'harbour-yard-west', name: 'Harbour Yard west lot', district: 'harbour', minX: 55.6, maxX: 63.4, minZ: 182.6, maxZ: 201.4, kinds: ['building', 'decor', 'landscape', 'light'], face: 2 },
  { id: 'harbour-yard-east', name: 'Harbour Yard east strip', district: 'harbour', minX: 84.6, maxX: 91.4, minZ: 182.6, maxZ: 201.4, kinds: ['decor', 'landscape', 'light', 'sign'], face: 1 },
];
export type LotId = string;

/** Fixed façade and terrace points for office-building décor: one addition each, exact pose. */
export interface Anchor { id: string; name: string; district: GrowDistrict; x: number; z: number; yaw: Quarter; models: string[] }
export const ANCHORS: readonly Anchor[] = [
  { id: 'awning-g', name: 'Café pavilion façade, Meridian south row', district: 'business', x: 75.5, z: 100.5, yaw: 2, models: ['commercial/detail-awning-wide'] },
  { id: 'awning-m', name: 'Tower façade, Meridian south-east', district: 'business', x: 114.5, z: 99.5, yaw: 2, models: ['commercial/detail-awning-wide'] },
  { id: 'terrace-1', name: 'Meridian terrace, west', district: 'business', x: 69, z: 115, yaw: 0, models: ['commercial/detail-parasol-a'] },
  { id: 'terrace-2', name: 'Meridian terrace, east', district: 'business', x: 79, z: 115, yaw: 0, models: ['commercial/detail-parasol-a'] },
];

export interface Box2 { minX: number; maxX: number; minZ: number; maxZ: number }
export interface Obstacle extends Box2 { top?: number }
export interface KeepClear extends Box2 { label: string }

/** Copies of the shipped street grid (district-layout ROADS, with their 2.3 m kerbs), the plots and the garage block. */
const ROAD_RECTS = [
  { x: 101.75, z: 62, w: 96.5, d: 10 }, { x: 101.75, z: 90, w: 96.5, d: 10 }, { x: 101.5, z: 118, w: 97, d: 8 }, { x: 76.5, z: 146, w: 47, d: 8 },
  { x: 102.5, z: 175, w: 95, d: 10 }, { x: 101.5, z: 208, w: 97, d: 8 }, { x: 100, z: 119, w: 12, d: 178 },
];
const PLOT_W = 20, PLOT_D = 14;
export const KEEP_CLEAR: readonly KeepClear[] = [
  ...ROAD_RECTS.map((r) => { const along = r.w > r.d; return { label: `road at ${r.x}, ${r.z}`, minX: r.x - r.w / 2 - (along ? 0 : 2.3), maxX: r.x + r.w / 2 + (along ? 0 : 2.3), minZ: r.z - r.d / 2 - (along ? 2.3 : 0), maxZ: r.z + r.d / 2 + (along ? 2.3 : 0) }; }),
  // A plot pad and its sign just south of it.
  ...PLOTS.map((p) => ({ label: `plot ${p.id}`, minX: p.x - PLOT_W / 2 - 0.2, maxX: p.x + PLOT_W / 2 + 0.2, minZ: p.z - PLOT_D / 2 - 0.2, maxZ: p.z + PLOT_D / 2 + 1.4 })),
  // The garage shell, its roller door and kerb slots to the z = 90 road, and the east staircase to the rooftop helipad.
  { label: 'garage, stairs and helipad', minX: GARAGE.x - GARAGE.width / 2 - 0.4, maxX: GARAGE.x + GARAGE.width / 2 + 2.4, minZ: GARAGE.z - GARAGE.depth / 2 - 0.4, maxZ: 90 },
  { label: 'harbour quay', minX: 55, maxX: 150, minZ: 212, maxZ: 218 },
  { label: 'district signs', minX: 94, maxX: 106, minZ: 29, maxZ: 32 },
  { label: 'founding district (spawn and headquarters)', minX: -60, maxX: 55, minZ: 0, maxZ: 230 },
];

/** Caps that keep the phone frame budget (FREE-09 method, +1.5 ms) with every addition present. */
export const WORLD_CAPS = {
  total: 48,
  perKind: { building: 6, decor: 14, landscape: 16, light: 12, sign: 4 } as Record<AdditionKind, number>,
  perDay: 5,
  perRun: 5,
  signText: 24,
  reason: 140,
} as const;

export interface AdditionPlacement { model: CatalogId; x: number; z: number; yaw: Quarter; lot?: LotId; anchor?: string; text?: string }
export interface WorldAddition extends AdditionPlacement {
  id: string;
  day: string;
  runId: string;
  engine: ArchitectEngine;
  reason: string;
  addedAt: number;
}
export interface WorldDocument { schema: 1; revision: number; additions: WorldAddition[]; /** Next W number (never reused). */ nextId?: number }

export type ProposedChange =
  | ({ op: 'place'; reason: string } & AdditionPlacement)
  | { op: 'move'; id: string; x: number; z: number; yaw: Quarter; lot?: LotId; reason: string }
  | { op: 'remove'; id: string; reason: string };

/** A change as applied, with the before/after it needs to be undone exactly. */
export interface AppliedChange {
  id: string;
  op: 'place' | 'move' | 'remove';
  additionId: string;
  model: CatalogId;
  lot?: LotId;
  anchor?: string;
  reason: string;
  repair: boolean;
  before?: WorldAddition;
  after?: WorldAddition;
  undone?: boolean;
}

/** An owner's "don't build". `anchor` scopes a rule to one façade or terrace anchor (from undoing an anchored placement). */
export interface AvoidRule { id: string; model?: CatalogId; lot?: LotId; anchor?: string; text: string; at: number; source: 'undo' | 'owner' }

export const emptyWorld = (): WorldDocument => ({ schema: 1, revision: 0, additions: [] });

/**
 * FREE-02's filter for text a person cannot see: format characters (zero-width, bidi, soft hyphen, Unicode tags),
 * line/paragraph separators, private-use and unassigned code points and every control character except newline and
 * tab. Kept identical to `hasHiddenChars` in server/chief.ts (asserted in tests/world.test.ts).
 */
const CONTROL = /[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u{E0000}-\u{E007F}]|[^\P{Cc}\n\t]/u;
export const hasHiddenText = (text: string) => CONTROL.test(text);

const SIGN_RE = /^[A-Z0-9 .,'&-]+$/;
export function sanitizeSignText(raw: unknown): { ok: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'sign text must be a string' };
  if (hasHiddenText(raw)) return { error: 'sign text contains invisible or control characters' };
  const t = raw.trim().replace(/ +/g, ' ').toUpperCase();
  if (!t) return { error: 'sign text is empty' };
  if (t.length > WORLD_CAPS.signText) return { error: `sign text is longer than ${WORLD_CAPS.signText} characters` };
  if (!SIGN_RE.test(t)) return { error: 'sign text may only use letters A–Z, digits, spaces and . , \' & -' };
  return { ok: t };
}

export function cleanReason(raw: unknown, label = 'reason'): { ok: string } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: `${label} is missing` };
  const t = raw.trim();
  if (t.length > WORLD_CAPS.reason) return { error: `${label} is longer than ${WORLD_CAPS.reason} characters` };
  if (hasHiddenText(t)) return { error: `${label} contains invisible or control characters` };
  return { ok: t };
}

// ---- Geometry ---------------------------------------------------------------------------------------------------

/** The world-aligned footprint of a catalogue model at a pose (quarter turns, as district-layout's `footprint`). */
export function footprintOf(model: CatalogId | CatalogEntry, x: number, z: number, yaw: number, pad = 0): Box2 & { top: number } {
  const e = typeof model === 'string' ? catalogEntry(model) : model;
  if (!e) return { minX: x, maxX: x, minZ: z, maxZ: z, top: 0 };
  const [mx, mz] = e.min, [Mx, Mz] = e.max;
  const q = ((Math.round(yaw) % 4) + 4) % 4;
  const [x0, x1, z0, z1] = q === 0 ? [mx, Mx, mz, Mz] : q === 1 ? [mz, Mz, -Mx, -mx] : q === 2 ? [-Mx, -mx, -Mz, -mz] : [-Mz, -mz, mx, Mx];
  return { minX: x + x0 * e.scale - pad, maxX: x + x1 * e.scale + pad, minZ: z + z0 * e.scale - pad, maxZ: z + z1 * e.scale + pad, top: e.top * e.scale };
}
/** The space an addition claims against other additions: its footprint, and never less than 0.8 m around its base. */
function claim(p: AdditionPlacement): Box2 {
  const f = footprintOf(p.model, p.x, p.z, p.yaw, 0.3);
  return { minX: Math.min(f.minX, p.x - 0.4), maxX: Math.max(f.maxX, p.x + 0.4), minZ: Math.min(f.minZ, p.z - 0.4), maxZ: Math.max(f.maxZ, p.z + 0.4) };
}
const overlaps = (a: Box2, b: Box2) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
const inside = (a: Box2, b: Box2) => a.minX >= b.minX - 1e-9 && a.maxX <= b.maxX + 1e-9 && a.minZ >= b.minZ - 1e-9 && a.maxZ <= b.maxZ + 1e-9;
const onGrid = (n: number) => Math.abs(n * 4 - Math.round(n * 4)) < 1e-9;
const DISTRICT_NAME = Object.fromEntries(DISTRICTS.map((d) => [d.id, d.name])) as Record<DistrictId, string>;

export interface RuleOptions {
  avoid?: readonly AvoidRule[];
  /** The game's live district colliders (the server's lots are proven clear of them by tests). */
  obstacles?: readonly Obstacle[];
  /** Tests only: extra keep-clear boxes. */
  extraKeepClear?: readonly KeepClear[];
}

export function avoidedBy(p: Pick<AdditionPlacement, 'model' | 'lot' | 'anchor'>, avoid: readonly AvoidRule[] = []): AvoidRule | undefined {
  return avoid.find((r) => (r.model === undefined || r.model === p.model) && (r.lot === undefined || r.lot === p.lot) && (r.anchor === undefined || r.anchor === p.anchor) && (r.model !== undefined || r.lot !== undefined || r.anchor !== undefined));
}

/**
 * Why this placement is not allowed beside `others` (which must not include itself), or undefined. Checks the model,
 * position, lot or anchor, keep-clear boxes, live colliders, other additions, sign text and avoid-rules. Caps are
 * checked by `applyChanges` / `validateDocument`.
 */
export function placementProblem(p: AdditionPlacement, others: readonly WorldAddition[], opts: RuleOptions = {}): string | undefined {
  const e = catalogEntry(p.model);
  if (!e) return `unknown model "${String(p.model).slice(0, 60)}"`;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return 'the position must be finite numbers';
  if (!onGrid(p.x) || !onGrid(p.z)) return 'the position must be on the 0.25 m grid';
  if (!Number.isInteger(p.yaw) || p.yaw < 0 || p.yaw > 3) return 'yaw must be a quarter turn (0, 1, 2 or 3)';
  if ((p.lot === undefined) === (p.anchor === undefined)) return 'an addition needs exactly one of a lot or an anchor';
  if (e.kind === 'sign') {
    if (p.text === undefined) return 'a sign needs its text';
    const t = sanitizeSignText(p.text);
    if ('error' in t) return t.error;
    if (t.ok !== p.text) return 'sign text must already be in its clean form (upper case, single spaces)';
  } else if (p.text !== undefined) return 'only signs carry text';
  const f = footprintOf(e, p.x, p.z, p.yaw);
  if (p.anchor !== undefined) {
    const a = ANCHORS.find((x) => x.id === p.anchor);
    if (!a) return `unknown anchor "${String(p.anchor).slice(0, 40)}"`;
    if (!a.models.includes(e.id)) return `anchor ${a.id} does not allow ${e.label}s`;
    if (p.x !== a.x || p.z !== a.z || p.yaw !== a.yaw) return `an anchored addition must sit at its exact anchor pose (${a.x}, ${a.z}, yaw ${a.yaw})`;
    const taken = others.find((o) => o.anchor === a.id);
    if (taken) return `anchor ${a.id} is taken by ${taken.id}`;
  } else {
    if (e.anchorOnly) return `a ${e.label} goes only on an anchor`;
    const lot = LOTS.find((l) => l.id === p.lot);
    if (!lot) return `unknown lot "${String(p.lot).slice(0, 40)}"`;
    if (!e.districts.includes(lot.district)) return `a ${e.label} is not used in the ${DISTRICT_NAME[lot.district]}`;
    if (!lot.kinds.includes(e.kind)) return `${lot.name} does not allow ${e.kind}`;
    if (!inside(f, lot)) return `the ${e.label} is outside the lot ${lot.name}`;
    for (const k of [...KEEP_CLEAR, ...(opts.extraKeepClear ?? [])]) if (overlaps(footprintOf(e, p.x, p.z, p.yaw, 0.2), k)) return `the ${e.label} overlaps the ${k.label}`;
  }
  for (const o of opts.obstacles ?? []) if (overlaps(f, o)) return `the ${e.label} overlaps a district building, wall or post`;
  const mine = claim(p);
  for (const o of others) if (o.anchor === undefined || p.anchor === undefined) { if (overlaps(mine, claim(o))) return `the ${e.label} overlaps ${o.id}`; }
  const avoided = avoidedBy(p, opts.avoid);
  if (avoided) return `the owner asked not to build this ("${avoided.text.slice(0, 80)}")`;
  return undefined;
}

function capProblem(additions: readonly Pick<WorldAddition, 'model'>[]): string | undefined {
  if (additions.length > WORLD_CAPS.total) return `the world may hold at most ${WORLD_CAPS.total} additions`;
  for (const [kind, max] of Object.entries(WORLD_CAPS.perKind) as [AdditionKind, number][]) {
    const n = additions.filter((a) => catalogEntry(a.model)?.kind === kind).length;
    if (n > max) return `the world may hold at most ${max} ${kind === 'decor' ? 'décor items' : kind === 'landscape' ? 'plants' : kind === 'light' ? 'lamps' : `${kind}s`}`;
  }
  return undefined;
}

/** Additions the current rules (and, in the game, the live colliders) no longer accept, with the reason. */
export function invalidAdditions(doc: WorldDocument, opts: RuleOptions = {}): { id: string; problem: string }[] {
  const out: { id: string; problem: string }[] = [];
  doc.additions.forEach((a, i) => {
    // Earlier valid additions win; a later one that overlaps them is the invalid one.
    const others = doc.additions.filter((o, j) => j < i && !out.some((x) => x.id === o.id));
    const problem = placementProblem(a, others, { ...opts, avoid: [] });
    if (problem) out.push({ id: a.id, problem });
  });
  return out;
}

// ---- The document -----------------------------------------------------------------------------------------------

const ADDITION_KEYS = ['id', 'model', 'x', 'z', 'yaw', 'lot', 'anchor', 'text', 'day', 'runId', 'engine', 'reason', 'addedAt'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strictly validates a stored or received document. Unknown fields, bad values and broken rules are refused. */
export function validateDocument(raw: unknown, opts: RuleOptions = {}): { ok: WorldDocument } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'the world document must be an object' };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!['schema', 'revision', 'additions', 'nextId'].includes(k)) return { error: `unexpected field "${k.slice(0, 40)}"` };
  if (r.schema !== WORLD_SCHEMA) return { error: 'unsupported world schema' };
  if (!Number.isSafeInteger(r.revision) || (r.revision as number) < 0) return { error: 'revision is invalid' };
  if (!Array.isArray(r.additions)) return { error: 'additions must be a list' };
  if (r.nextId !== undefined && (!Number.isSafeInteger(r.nextId) || (r.nextId as number) < 1)) return { error: 'nextId is invalid' };
  const additions: WorldAddition[] = [];
  const ids = new Set<string>();
  for (const [i, entryRaw] of r.additions.entries()) {
    const n = `addition ${i + 1}`;
    if (!entryRaw || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) return { error: `${n} is not an object` };
    const a = entryRaw as Record<string, unknown>;
    for (const k of Object.keys(a)) if (!ADDITION_KEYS.includes(k)) return { error: `${n} has an unexpected field "${k.slice(0, 40)}"` };
    if (typeof a.id !== 'string' || !/^W[1-9]\d{0,6}$/.test(a.id)) return { error: `${n} id is invalid` };
    if (ids.has(a.id)) return { error: `${n} is a duplicate of ${a.id}` };
    ids.add(a.id);
    if (typeof a.model !== 'string' || !catalogEntry(a.model)) return { error: `${n}: unknown model "${String(a.model).slice(0, 60)}"` };
    if (typeof a.x !== 'number' || typeof a.z !== 'number' || !Number.isFinite(a.x) || !Number.isFinite(a.z)) return { error: `${n}: the position must be finite numbers` };
    if (!onGrid(a.x) || !onGrid(a.z)) return { error: `${n}: the position must be on the 0.25 m grid` };
    if (!Number.isInteger(a.yaw) || (a.yaw as number) < 0 || (a.yaw as number) > 3) return { error: `${n}: yaw must be a quarter turn` };
    if (a.lot !== undefined && typeof a.lot !== 'string') return { error: `${n}: lot is invalid` };
    if (a.anchor !== undefined && typeof a.anchor !== 'string') return { error: `${n}: anchor is invalid` };
    if ((a.lot === undefined) === (a.anchor === undefined)) return { error: `${n}: needs exactly one of a lot or an anchor` };
    if (a.text !== undefined && typeof a.text !== 'string') return { error: `${n}: text is invalid` };
    if (typeof a.day !== 'string' || !DAY_RE.test(a.day)) return { error: `${n}: day is invalid` };
    if (typeof a.runId !== 'string' || !/^R[1-9]\d{0,8}$/.test(a.runId)) return { error: `${n}: runId is invalid` };
    if (a.engine !== 'rules' && a.engine !== 'free' && a.engine !== 'premium') return { error: `${n}: engine is invalid` };
    const reason = cleanReason(a.reason);
    if ('error' in reason) return { error: `${n}: ${reason.error}` };
    if (!Number.isSafeInteger(a.addedAt) || (a.addedAt as number) < 0) return { error: `${n}: addedAt is invalid` };
    additions.push({ id: a.id, model: a.model, x: a.x, z: a.z, yaw: a.yaw as Quarter, ...(a.lot !== undefined ? { lot: a.lot as string } : {}), ...(a.anchor !== undefined ? { anchor: a.anchor as string } : {}),
      ...(a.text !== undefined ? { text: a.text as string } : {}), day: a.day, runId: a.runId, engine: a.engine, reason: reason.ok, addedAt: a.addedAt as number });
  }
  const cap = capProblem(additions);
  if (cap) return { error: cap };
  const doc: WorldDocument = { schema: 1, revision: r.revision as number, additions, ...(r.nextId !== undefined ? { nextId: r.nextId as number } : {}) };
  const bad = invalidAdditions(doc, opts);
  if (bad.length) return { error: `${bad[0].id}: ${bad[0].problem}` };
  return { ok: doc };
}

const nextNumber = (doc: WorldDocument) => Math.max(doc.nextId ?? 1, ...doc.additions.map((a) => Number(a.id.slice(1)) + 1));

export interface ApplyMeta { day: string; runId: string; engine: ArchitectEngine; at: number; maxChanges: number; avoid?: readonly AvoidRule[]; /** Changes already applied today (per-day cap). */ appliedToday?: number; /** First change number (C…). */ firstChange?: number }

/**
 * Applies a run's changes in order, all or nothing. Each is validated against the world as it stands after the earlier
 * ones. Any problem refuses the whole run with "change N: …"; the input document is never modified.
 */
export function applyChanges(input: WorldDocument, changes: readonly ProposedChange[], meta: ApplyMeta): { ok: { doc: WorldDocument; applied: AppliedChange[] } } | { error: string } {
  const max = Math.min(meta.maxChanges, WORLD_CAPS.perRun);
  if (changes.length > max) return { error: `a run may make at most ${max} changes; this one has ${changes.length}` };
  if ((meta.appliedToday ?? 0) + changes.length > WORLD_CAPS.perDay) return { error: `the architect makes at most ${WORLD_CAPS.perDay} changes a day` };
  const doc: WorldDocument = structuredClone(input);
  let next = nextNumber(doc);
  let changeNo = meta.firstChange ?? 1;
  const applied: AppliedChange[] = [];
  const fail = (i: number, why: string) => ({ error: `change ${i + 1}: ${why}` });
  for (const [i, c] of changes.entries()) {
    const reason = cleanReason(c.reason);
    if ('error' in reason) return fail(i, reason.error);
    // Review 3: only rule-based growth marks repairs (which may move an addition despite an avoid-rule). A model's
    // "Repair" wording earns nothing.
    const repair = meta.engine === 'rules' && /^Repair\b/.test(reason.ok);
    if (c.op === 'place') {
      const p: AdditionPlacement = { model: c.model, x: c.x, z: c.z, yaw: c.yaw, ...(c.lot !== undefined ? { lot: c.lot } : {}), ...(c.anchor !== undefined ? { anchor: c.anchor } : {}), ...(c.text !== undefined ? { text: c.text } : {}) };
      const problem = placementProblem(p, doc.additions, { avoid: meta.avoid });
      if (problem) return fail(i, problem);
      const added: WorldAddition = { id: `W${next++}`, ...p, day: meta.day, runId: meta.runId, engine: meta.engine, reason: reason.ok, addedAt: meta.at };
      doc.additions.push(added);
      const cap = capProblem(doc.additions);
      if (cap) return fail(i, cap);
      applied.push({ id: `C${changeNo++}`, op: 'place', additionId: added.id, model: added.model, ...(added.lot ? { lot: added.lot } : {}), ...(added.anchor ? { anchor: added.anchor } : {}), reason: reason.ok, repair, after: structuredClone(added) });
    } else if (c.op === 'move') {
      const at = doc.additions.findIndex((a) => a.id === c.id);
      if (at < 0) return fail(i, `there is no addition ${String(c.id).slice(0, 20)}`);
      const before = doc.additions[at];
      if (before.anchor !== undefined) return fail(i, `${before.id} is anchored and cannot move`);
      const moved: WorldAddition = { ...before, x: c.x, z: c.z, yaw: c.yaw, lot: c.lot ?? before.lot, reason: reason.ok };
      const others = doc.additions.filter((a) => a.id !== c.id);
      const problem = placementProblem(moved, others, repair ? {} : { avoid: meta.avoid });
      if (problem) return fail(i, problem);
      doc.additions[at] = moved;
      applied.push({ id: `C${changeNo++}`, op: 'move', additionId: moved.id, model: moved.model, ...(moved.lot ? { lot: moved.lot } : {}), reason: reason.ok, repair, before: structuredClone(before), after: structuredClone(moved) });
    } else if (c.op === 'remove') {
      const at = doc.additions.findIndex((a) => a.id === c.id);
      if (at < 0) return fail(i, `there is no addition ${String(c.id).slice(0, 20)}`);
      const [before] = doc.additions.splice(at, 1);
      applied.push({ id: `C${changeNo++}`, op: 'remove', additionId: before.id, model: before.model, ...(before.lot ? { lot: before.lot } : {}), ...(before.anchor ? { anchor: before.anchor } : {}), reason: reason.ok, repair, before: structuredClone(before) });
    } else return fail(i, 'op must be place, move or remove');
  }
  if (applied.length) { doc.revision += 1; doc.nextId = next; }
  return { ok: { doc, applied } };
}

/** Undoes one applied change, if the addition is still exactly as that change left it. */
export function undoChange(input: WorldDocument, change: AppliedChange, opts: RuleOptions = {}): { ok: WorldDocument } | { error: string } {
  const doc: WorldDocument = structuredClone(input);
  const at = doc.additions.findIndex((a) => a.id === change.additionId);
  const same = (a: WorldAddition | undefined, b: WorldAddition | undefined) => JSON.stringify(a) === JSON.stringify(b);
  if (change.op === 'place' || change.op === 'move') {
    if (at < 0 || !same(doc.additions[at], change.after)) return { error: `${change.additionId} changed since; undo the later change first` };
    if (change.op === 'place') doc.additions.splice(at, 1);
    else {
      const problem = placementProblem(change.before!, doc.additions.filter((a) => a.id !== change.additionId), opts);
      if (problem) return { error: `${change.additionId} cannot go back: ${problem}` };
      doc.additions[at] = structuredClone(change.before!);
    }
  } else {
    if (at >= 0) return { error: `${change.additionId} exists again; undo the later change first` };
    const problem = placementProblem(change.before!, doc.additions, opts);
    if (problem) return { error: `${change.additionId} cannot come back: ${problem}` };
    doc.additions.push(structuredClone(change.before!));
    const cap = capProblem(doc.additions);
    if (cap) return { error: cap };
  }
  doc.revision += 1;
  doc.nextId = nextNumber(doc);
  return { ok: doc };
}

/** One line for a change, for the inbox, the journal and Settings. */
export function changeLabel(c: Pick<AppliedChange, 'op' | 'additionId' | 'model' | 'lot' | 'anchor' | 'repair'>): string {
  const e = catalogEntry(c.model);
  const where = c.anchor ? ANCHORS.find((a) => a.id === c.anchor)?.name ?? c.anchor : c.lot ? LOTS.find((l) => l.id === c.lot)?.name ?? c.lot : '';
  const verb = c.op === 'place' ? 'Built' : c.op === 'move' ? 'Moved' : 'Removed';
  return `${c.repair ? 'Repair · ' : ''}${verb} a ${e?.label ?? c.model} (${c.additionId})${where ? ` · ${where}` : ''}`;
}

/** What the game hides first to protect the frame budget. */
export function visibleKinds(opts: { quality: 'low' | 'medium' | 'high' | string; saveData: boolean }): AdditionKind[] {
  if (opts.quality === 'low') return ['building'];
  if (opts.saveData) return ['building'];
  return ['building', 'decor', 'landscape', 'light', 'sign'];
}
