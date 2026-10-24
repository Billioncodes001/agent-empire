/**
 * FREE-09 (CITY-05/07): expanded districts, purchasable plots and garage vehicle ownership. Shared by the host, the
 * cloud coordinator and the game. All prices are fictional city credits, never provider spending.
 *
 * Save compatibility: `EmpireState.city` is optional. A save written before FREE-09 has none and loads unchanged in
 * the original district with no plots or garage vehicles (`normalizeCity(undefined)`); the empire `version` stays 2.
 */
export type DistrictId = 'founding' | 'business' | 'harbour';
export interface District { id: DistrictId; name: string; minX: number; maxX: number; minZ: number; maxZ: number }
/** World-space rectangles (metres). The founding district is the original block west of x = 55. */
export const DISTRICTS: readonly District[] = [
  { id: 'founding', name: 'Founding district', minX: -55, maxX: 55, minZ: 30, maxZ: 153 },
  { id: 'business', name: 'Meridian business district', minX: 55, maxX: 150, minZ: 30, maxZ: 120 },
  { id: 'harbour', name: 'Harbour works', minX: 55, maxX: 150, minZ: 120, maxZ: 215 },
];
export const districtAt = (x: number, z: number): DistrictId | undefined =>
  DISTRICTS.find((d) => x >= d.minX && x < d.maxX && z >= d.minZ && z < d.maxZ)?.id;

export const PLOTS = [
  { id: 'meridian-north', district: 'business', name: 'Meridian North parcel', x: 134, z: 44, cost: 30000 },
  { id: 'meridian-plaza', district: 'business', name: 'Meridian Plaza parcel', x: 134, z: 104, cost: 42000 },
  { id: 'harbour-quay', district: 'harbour', name: 'Harbour Quay parcel', x: 128, z: 162, cost: 26000 },
  { id: 'harbour-yard', district: 'harbour', name: 'Harbour Yard parcel', x: 74, z: 190, cost: 20000 },
] as const;
export type PlotId = (typeof PLOTS)[number]['id'];

/** Purchasable garage vehicles (Kenney Car Kit). The executive sedan is the founder's starter car and is not listed. */
export const VEHICLE_MODELS = [
  { id: 'hatchback', name: 'City hatchback', asset: 'hatchback-sports', cost: 9000 },
  { id: 'van', name: 'Service van', asset: 'van', cost: 14000 },
  { id: 'coupe', name: 'Sports coupe', asset: 'sedan-sports', cost: 16000 },
  { id: 'suv', name: 'Luxury SUV', asset: 'suv-luxury', cost: 24000 },
] as const;
export type VehicleModelId = (typeof VEHICLE_MODELS)[number]['id'];

/** Meridian motor garage: storage bays inside, apron slots on the kerb outside the roller door (world metres). */
export const GARAGE = {
  name: 'Meridian motor garage',
  x: 72, z: 78, width: 22, depth: 14,
  door: { x: 72, z: 85, width: 6 },
  bays: [{ x: 63.5, z: 76 }, { x: 68.5, z: 76 }, { x: 75.5, z: 76 }, { x: 80.5, z: 76 }],
  /** Parallel to the z = 90 road, facing east. */
  apron: [{ x: 66, z: 88.4, yaw: Math.PI / 2 }, { x: 78, z: 88.4, yaw: Math.PI / 2 }],
} as const;

/**
 * CITY-08: the company helicopter, bought once with fictional city credits. It stands on the helipad on the Meridian
 * motor garage roof (deck at y = 6.3 m), reached by the staircase on the garage's east wall. `yaw` is its parked heading.
 */
export const HELICOPTER = { name: 'Company helicopter', cost: 45000 } as const;
export const HELIPAD = { name: 'Meridian rooftop helipad', x: 72, z: 78, y: 6.3, size: 12, yaw: Math.PI / 2, kiosk: { x: 80.2, z: 73.6 } } as const;

export interface OwnedVehicle { id: string; model: VehicleModelId; bay: number; apron?: number; purchasedAt: number }
/**
 * `nonces`: the most recent purchase nonces, so a repeated click or replayed cloud intent buys only once.
 * `helicopter` (CITY-08) is present only once bought; saves written before CITY-08 have no such field.
 */
export interface CityState { schema: 1; plots: PlotId[]; vehicles: OwnedVehicle[]; nonces?: string[]; helicopter?: true }

export const PURCHASE_NONCE = /^[A-Za-z0-9-]{8,64}$/;
export const MAX_NONCES = 32;
const VEHICLE_ID = /^vehicle-\d{1,3}$/;
export const newCity = (): CityState => ({ schema: 1, plots: [], vehicles: [], nonces: [] });

/** Validates a saved `city` block; a missing block is a pre-FREE-09 save. Throws on anything malformed. */
export function normalizeCity(value: unknown): CityState {
  if (value === undefined || value === null) return newCity();
  const v = value as Partial<CityState>;
  const fail = (why: string): never => { throw new Error(`Invalid city save: ${why}`); };
  if (v.schema !== 1 || !Array.isArray(v.plots) || !Array.isArray(v.vehicles)) fail('schema');
  const plots = [...new Set(v.plots!)];
  if (plots.some((p) => !PLOTS.some((d) => d.id === p))) fail('unknown plot');
  const nonces = v.nonces ?? [];
  if (!Array.isArray(nonces) || nonces.length > MAX_NONCES || nonces.some((n) => typeof n !== 'string' || !PURCHASE_NONCE.test(n))) fail('nonces');
  if (v.helicopter !== undefined && v.helicopter !== true) fail('helicopter');
  const bays = new Set<number>(), aprons = new Set<number>(), ids = new Set<string>();
  for (const x of v.vehicles!) {
    if (!x || typeof x.id !== 'string' || !VEHICLE_ID.test(x.id) || ids.has(x.id)) fail('vehicle id');
    if (!VEHICLE_MODELS.some((m) => m.id === x.model)) fail('vehicle model');
    if (!Number.isInteger(x.bay) || x.bay < 0 || x.bay >= GARAGE.bays.length || bays.has(x.bay)) fail('vehicle bay');
    if (x.apron !== undefined && (!Number.isInteger(x.apron) || x.apron < 0 || x.apron >= GARAGE.apron.length || aprons.has(x.apron))) fail('vehicle apron');
    if (!Number.isFinite(x.purchasedAt) || x.purchasedAt < 0) fail('vehicle purchase time');
    ids.add(x.id); bays.add(x.bay); if (x.apron !== undefined) aprons.add(x.apron);
  }
  // Only known fields are kept: nothing else from a save reaches the UI or the next save.
  return {
    schema: 1, plots,
    vehicles: v.vehicles!.map((x) => ({ id: x.id, model: x.model, bay: x.bay, ...(x.apron !== undefined ? { apron: x.apron } : {}), purchasedAt: x.purchasedAt })),
    nonces: [...nonces],
    ...(v.helicopter ? { helicopter: true as const } : {}),
  };
}

export const freeBay = (city: CityState) => GARAGE.bays.findIndex((_, i) => !city.vehicles.some((v) => v.bay === i));
/** First apron slot no saved vehicle holds and the client did not report blocked (sedan, player). -1 when none. */
export function freeApronSlot(city: CityState, blocked: readonly number[] = []): number {
  return GARAGE.apron.findIndex((_, i) => !blocked.includes(i) && !city.vehicles.some((v) => v.apron === i));
}
