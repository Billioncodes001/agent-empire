/**
 * CITY-06/08: what the founder can drive or fly, as pure data shared by the player controller, the traversal and the
 * world. Offsets are in the ride's own frame: +z is forward, −x is the driver's side (the executive sedan's door side,
 * kept for every vehicle so the founder always gets in on the same side).
 *
 * Kenney Car Kit footprints come from the pinned kit manifest (tools/city/build-city-assets.ts) at the kit's 1.8 scale.
 */
import manifest from './public/models/city/manifest.json';
import { VEHICLE_MODELS, type VehicleModelId } from '../shared/city';

export type RideId = 'sedan' | VehicleModelId | 'helicopter';
export type Vec3 = readonly [number, number, number];
export interface RideSpec {
  id: RideId;
  kind: 'car' | 'helicopter';
  name: string;
  /** Body half-extents on the ground plane (metres): `w` across, `l` along the heading. */
  half: { w: number; l: number };
  /** Roof (or rotor mast) height above the ride's base. */
  height: number;
  /** Where the founder's root sits when seated. */
  seat: Vec3;
  /** Where the founder stands outside the driver's door. */
  door: Vec3;
  /** Fallback door-handle position when the model has no authored handle. */
  handle: Vec3;
  /** First-person camera. */
  eye: Vec3;
  /** Third-person chase distance after boarding. */
  chase: number;
}

/** The authored executive sedan (tools/build-sedan.py); unchanged from before CITY-06. */
export const SEDAN: RideSpec = {
  id: 'sedan', kind: 'car', name: 'Executive sedan',
  half: { w: 1.07, l: 2.36 }, height: 1.55,
  seat: [-0.43, 0.1, 0.05], door: [-1.65, 0, 0.1], handle: [-1, 0.98, 0.35], eye: [-0.43, 1.24, 0.05], chase: 7,
};

export const KENNEY_SCALE = 1.8;
const bounds = (manifest.kits as unknown as Record<string, { models: Record<string, { min: number[]; max: number[] }> }>).vehicles.models;
/** Cabin layout per Kenney model: driver's seat/eye along the body and the chase distance (tuned against screenshots). */
const CABIN: Record<VehicleModelId, { z: number; eye: number; chase: number }> = {
  hatchback: { z: -0.15, eye: 1.42, chase: 7.4 },
  van: { z: 0.55, eye: 1.78, chase: 8.4 },
  coupe: { z: -0.2, eye: 1.36, chase: 7.2 },
  suv: { z: 0.05, eye: 1.7, chase: 8 },
};
function kenney(id: VehicleModelId): RideSpec {
  const model = VEHICLE_MODELS.find((m) => m.id === id)!;
  const b = bounds[model.asset];
  const w = Math.max(-b.min[0], b.max[0]) * KENNEY_SCALE, l = Math.max(-b.min[2], b.max[2]) * KENNEY_SCALE;
  const c = CABIN[id], seatX = -Math.min(0.48, w * 0.38);
  return {
    id, kind: 'car', name: model.name,
    half: { w, l }, height: b.max[1] * KENNEY_SCALE,
    seat: [seatX, 0.22, c.z], door: [-(w + 0.55), 0, c.z + 0.05], handle: [-(w + 0.04), 1.05, c.z + 0.3],
    eye: [seatX, c.eye, c.z], chase: c.chase,
  };
}

/**
 * The procedural company helicopter (world/helicopter.ts). The collision footprint covers the fuselage from nose to tail
 * rotor and the skids; the main rotor disc is not collided with (a flight-game simplification, documented).
 */
export const HELICOPTER_SPEC: RideSpec = {
  id: 'helicopter', kind: 'helicopter', name: 'Company helicopter',
  half: { w: 1.25, l: 5.6 }, height: 3.4,
  seat: [-0.42, 0.62, 1.05], door: [-1.95, 0, 1.1], handle: [-1.2, 1.45, 1.4], eye: [-0.42, 1.92, 1.25], chase: 14,
};

export const RIDES: Record<RideId, RideSpec> = {
  sedan: SEDAN,
  hatchback: kenney('hatchback'),
  van: kenney('van'),
  coupe: kenney('coupe'),
  suv: kenney('suv'),
  helicopter: HELICOPTER_SPEC,
};
export const rideSpec = (id: RideId): RideSpec => RIDES[id];

/**
 * A ride standing in the world (world/city.ts provides them): the sedan, each bought garage vehicle and the helicopter.
 * `locked` explains why it cannot be boarded (the helicopter before it is bought).
 */
export interface Ride {
  key: string;
  spec: RideSpec;
  object: import('three').Object3D;
  ready: boolean;
  locked?: string;
  /** Driver's door, 0 closed to 1 open. */
  setDoor(amount: number): void;
  /** The authored door handle in world space, if the model has one. */
  handle?(): import('three').Vector3 | undefined;
  /** The founder boarded: the ride stops being a solid obstacle. */
  enter?(): void;
  /** The founder left it here: it becomes solid where it stands (once nobody overlaps it). */
  exit?(): void;
  animate(dt: number, motion: import('./vehicle').VehicleMotion, running: boolean, reduced: boolean): void;
  /** First person inside a model with opaque palette windows: hide the shell so the cabin framing and the road show. */
  cabinView?(on: boolean): void;
}
