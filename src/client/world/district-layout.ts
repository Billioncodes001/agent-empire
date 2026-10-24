/**
 * FREE-09 (CITY-07): the pure layout of the Meridian business district and Harbour works (no rendering, no assets
 * loaded), so tests can walk and drive across it with the same colliders the game uses. Model footprints come from
 * the kit manifest written by tools/city/build-city-assets.ts.
 */
import manifest from '../public/models/city/manifest.json';
import { GARAGE, PLOTS, type DistrictId } from '../../shared/city';
import { vehicleOverlaps } from '../vehicle';

export type Kit = 'commercial' | 'industrial' | 'streets' | 'vehicles';
export interface Placement { kit: Kit; model: string; x: number; z: number; yaw: number; scale: number; district: DistrictId; furniture: boolean }
export interface Rect { x: number; z: number; w: number; d: number }
export interface Box { minX: number; maxX: number; minZ: number; maxZ: number; top: number; bottom?: number }

const SCALE: Record<Kit, number> = { commercial: 9, industrial: 9, streets: 7, vehicles: 1.8 };
const kits = manifest.kits as unknown as Record<Kit, { models: Record<string, { min: number[]; max: number[] }> }>;
export const modelBounds = (kit: Kit, model: string) => kits[kit].models[model];

/** Axis-aligned footprint of a placement (yaw is a multiple of 90°). */
export function footprint(p: Placement, pad = 0): Box {
  const b = modelBounds(p.kit, p.model);
  const quarter = Math.round(p.yaw / (Math.PI / 2)) & 3;
  const [x0, x1, z0, z1] = quarter === 0 ? [b.min[0], b.max[0], b.min[2], b.max[2]]
    : quarter === 1 ? [b.min[2], b.max[2], -b.max[0], -b.min[0]]
      : quarter === 2 ? [-b.max[0], -b.min[0], -b.max[2], -b.min[2]]
        : [-b.max[2], -b.min[2], b.min[0], b.max[0]];
  return { minX: p.x + x0 * p.scale - pad, maxX: p.x + x1 * p.scale + pad, minZ: p.z + z0 * p.scale - pad, maxZ: p.z + z1 * p.scale + pad, top: b.max[1] * p.scale };
}

/** New streets (asphalt rectangles, world metres). They meet the founding district's z = 62, 90, 118, 146 and 208 roads. */
export const ROADS: Rect[] = [
  { x: 101.75, z: 62, w: 96.5, d: 10 },
  { x: 101.75, z: 90, w: 96.5, d: 10 },
  { x: 101.5, z: 118, w: 97, d: 8 },
  { x: 76.5, z: 146, w: 47, d: 8 },
  { x: 102.5, z: 175, w: 95, d: 10 },
  { x: 101.5, z: 208, w: 97, d: 8 },
  { x: 100, z: 119, w: 12, d: 178 },
];
/** Building blocks between the streets; each row places models left to right while they fit. */
const ROWS: { district: DistrictId; kit: Kit; x0: number; x1: number; z: number; yaw: number; models: string[] }[] = [
  { district: 'business', kit: 'commercial', x0: 56.5, x1: 91.5, z: 45, yaw: 0, models: ['building-skyscraper-a', 'building-skyscraper-c', 'building-h'] },
  { district: 'business', kit: 'commercial', x0: 109, x1: 123, z: 45, yaw: 0, models: ['building-skyscraper-b'] },
  { district: 'business', kit: 'commercial', x0: 109, x1: 148, z: 76, yaw: 0, models: ['building-skyscraper-d', 'building-skyscraper-e', 'building-skyscraper-a'] },
  { district: 'business', kit: 'commercial', x0: 56.5, x1: 91.5, z: 105, yaw: Math.PI, models: ['building-e', 'building-g', 'building-a'] },
  { district: 'business', kit: 'commercial', x0: 109, x1: 123, z: 105, yaw: Math.PI, models: ['building-m'] },
  { district: 'harbour', kit: 'industrial', x0: 56.5, x1: 91.5, z: 133, yaw: 0, models: ['building-a', 'building-k'] },
  { district: 'harbour', kit: 'industrial', x0: 109, x1: 148, z: 134, yaw: 0, models: ['building-f', 'building-c'] },
  { district: 'harbour', kit: 'industrial', x0: 56.5, x1: 91.5, z: 160.5, yaw: 0, models: ['detail-tank-large', 'water-tower', 'chimney-large'] },
  { district: 'harbour', kit: 'industrial', x0: 109, x1: 117.5, z: 154, yaw: 0, models: ['building-o'] },
  { district: 'harbour', kit: 'industrial', x0: 139, x1: 148, z: 159, yaw: 0, models: ['detail-tank'] },
  { district: 'harbour', kit: 'industrial', x0: 109, x1: 148, z: 191, yaw: 0, models: ['building-q', 'shipping-container-a', 'shipping-container-b', 'shipping-container-c', 'shipping-container-a'] },
  { district: 'harbour', kit: 'industrial', x0: 109, x1: 148, z: 199.5, yaw: Math.PI / 2, models: ['shipping-container-c', 'shipping-container-a', 'shipping-container-b', 'shipping-container-c'] },
];

function row(r: (typeof ROWS)[number], out: Placement[]) {
  let x = r.x0;
  for (const model of r.models) {
    const probe: Placement = { kit: r.kit, model, x: 0, z: r.z, yaw: r.yaw, scale: SCALE[r.kit], district: r.district, furniture: false };
    const f = footprint(probe);
    const width = f.maxX - f.minX;
    if (x + width > r.x1) continue;
    out.push({ ...probe, x: x - f.minX });
    x += width + 1.6;
  }
}

/** Lamps along both kerbs of each new street, traffic lights at avenue junctions, a few props and parked cars. */
function furniture(out: Placement[]) {
  const s = (model: string, x: number, z: number, yaw: number, district: DistrictId, kit: Kit = 'streets') =>
    out.push({ kit, model, x, z, yaw, scale: SCALE[kit], district, furniture: kit === 'streets' });
  for (const z of [62, 90, 175]) {
    const district: DistrictId = z < 120 ? 'business' : 'harbour';
    for (let x = 60; x < 148; x += 16) {
      if (Math.abs(x - 100) < 9 || (z === 90 && x > 60 && x < 86)) continue;
      // The lamp arm extends along the model's −z; yaw turns it over the carriageway.
      s('light-square', x, z - 6.6, Math.PI, district);
      s('light-square', x + 8, z + 6.6, 0, district);
    }
  }
  for (let z = 36; z < 205; z += 18) {
    if ([62, 90, 118, 146, 175].some((r) => Math.abs(z - r) < 9)) continue;
    const side = (z / 18) % 2 < 1 ? -1 : 1;
    s('light-square', 100 + side * 7.4, z, side < 0 ? -Math.PI / 2 : Math.PI / 2, z < 120 ? 'business' : 'harbour');
  }
  for (const z of [62, 90, 118, 175]) s('traffic-light', 107.4, z + 6.2, Math.PI, z < 120 ? 'business' : 'harbour');
  for (const [x, z] of [[90, 112], [88, 140], [118, 150]]) s('dumpster', x, z, 0, z < 120 ? 'business' : 'harbour');
  for (const x of [60, 70, 80]) s('detail-parasol-a', x + 4, 115, 0, 'business', 'commercial');
  for (const x of [64, 83]) s('detail-awning-wide', x, 100.2, Math.PI, 'business', 'commercial');
  for (const [x, z] of [[96.5, 140], [96.5, 143], [103.5, 168]]) s('construction-cone', x, z, 0, 'harbour');
  s('construction-barrier', 103.5, 171, Math.PI / 2, 'harbour');
  s('road-sign-street', 107.6, 55.6, 0, 'business');
  // Kerbside lamps either side of the garage's roller door.
  for (const dx of [-5.2, 5.2]) s('light-square', GARAGE.door.x + dx, GARAGE.door.z + 0.6, Math.PI, 'business');
  // Plaza lamps on the parasol terrace.
  for (const x of [62, 90]) s('light-curved-double', x, 116.5, 0, 'business');
  // Parked kerbside vehicles: Car Kit ambience, not owned by the founder.
  out.push({ kit: 'vehicles', model: 'taxi', x: 118, z: 58.6, yaw: Math.PI / 2, scale: SCALE.vehicles, district: 'business', furniture: false });
  out.push({ kit: 'vehicles', model: 'delivery', x: 112, z: 171.4, yaw: -Math.PI / 2, scale: SCALE.vehicles, district: 'harbour', furniture: false });
}

export interface DistrictLayout { placements: Placement[]; colliders: Box[]; garage: { walls: Box[]; door: Box; kiosk: { x: number; z: number } } }

/** Garage shell: back and side walls, two front wall sections either side of the roller door, a roof slab. */
function garageBoxes() {
  const { x, z, width, depth, door } = GARAGE, x0 = x - width / 2, x1 = x + width / 2, z0 = z - depth / 2, z1 = z + depth / 2, top = 6;
  const walls: Box[] = [
    { minX: x0, maxX: x1, minZ: z0 - 0.2, maxZ: z0 + 0.2, top },
    { minX: x0 - 0.2, maxX: x0 + 0.2, minZ: z0, maxZ: z1, top },
    { minX: x1 - 0.2, maxX: x1 + 0.2, minZ: z0, maxZ: z1, top },
    { minX: x0, maxX: door.x - door.width / 2, minZ: z1 - 0.2, maxZ: z1 + 0.2, top },
    { minX: door.x + door.width / 2, maxX: x1, minZ: z1 - 0.2, maxZ: z1 + 0.2, top },
    { minX: x0, maxX: x1, minZ: z0, maxZ: z1, bottom: 5.2, top: 6.3 },
    { minX: 81, maxX: 82.6, minZ: 82.4, maxZ: 83.2, top: 1.1 },
  ];
  const doorBox: Box = { minX: door.x - door.width / 2, maxX: door.x + door.width / 2, minZ: door.z - 0.15, maxZ: door.z + 0.15, top: 4.6 };
  return { walls, door: doorBox, kiosk: { x: 81.8, z: 81.9 } };
}

export function districtLayout(): DistrictLayout {
  const placements: Placement[] = [];
  for (const r of ROWS) row(r, placements);
  furniture(placements);
  const garage = garageBoxes();
  const colliders: Box[] = placements.filter((p) => p.kit !== 'streets' || p.model === 'dumpster').map((p) => footprint(p, 0.1));
  // Lamp and signal posts are thin; a 0.3 m post keeps people from walking through them.
  for (const p of placements.filter((p) => p.kit === 'streets' && p.model !== 'dumpster'))
    colliders.push({ minX: p.x - 0.15, maxX: p.x + 0.15, minZ: p.z - 0.15, maxZ: p.z + 0.15, top: 3 });
  colliders.push(...garage.walls);
  return { placements, colliders, garage };
}

/**
 * The founding district's layered skyline north of the z = 146 road (rendered in city.ts). The thirteenth tower used to
 * stand at x = 59, inside Harbour works; it is gone. Colliders start beyond the road and its kerb (z > 152.5).
 */
export const SKYLINE_TOWERS = Array.from({ length: 12 }, (_, i) => ({ i, x: -43 + i * 8.5, z: 152 + (i % 3) * 17, height: 12 + (i % 5) * 4.5 }));
export const FOUNDING_KERB_146 = 152.5;
export const skylineColliders = (): Box[] =>
  SKYLINE_TOWERS.map((t) => ({ minX: t.x - 3.5, maxX: t.x + 3.5, minZ: Math.max(t.z - 4, FOUNDING_KERB_146 + 0.1), maxZ: t.z + 5.4, top: t.height }));

/**
 * Whether a garage bay or kerb slot can turn solid: the live sedan and the founder must be clear of it, otherwise a
 * vehicle bought or stored while they stand there would trap them inside its collider.
 */
export type CarPose = { position: { x: number; z: number }; rotation: { y: number } };
export function slotClear(box: Box, car: CarPose, player: { x: number; z: number }, driving = false) {
  // While driving, the founder is the car: its full 2.14 × 4.72 m body is tested, not a point at its centre.
  const person = !driving && player.x > box.minX - 0.4 && player.x < box.maxX + 0.4 && player.z > box.minZ - 0.4 && player.z < box.maxZ + 0.4;
  return !person && !vehicleOverlaps(car.position.x, car.position.z, car.rotation.y, box);
}
/** The sedan's pose this frame: while driving, the player controller has already moved it (city.car lags a frame). */
export const liveCarPose = (driving: boolean, player: { x: number; z: number }, facing: number, car: CarPose): CarPose =>
  driving ? { position: { x: player.x, z: player.z }, rotation: { y: facing } } : car;
/**
 * After the saved vehicles change: free slots turn non-solid; occupied slots that are already solid stay solid (so a
 * walker or the sedan is never let through a parked car); newly occupied ones wait for slotClear.
 */
export function settleSlots(slots: { occupied: boolean; collider: Box }[], occupiedNow: boolean[]) {
  slots.forEach((s, i) => {
    s.occupied = occupiedNow[i];
    if (!s.occupied) s.collider.top = 0;
  });
}

export const PLOT_PAD = { w: 20, d: 14 };
export const plotSign = (id: string) => {
  const p = PLOTS.find((q) => q.id === id)!;
  return { x: p.x, z: p.z + PLOT_PAD.d / 2 + 0.6 };
};
