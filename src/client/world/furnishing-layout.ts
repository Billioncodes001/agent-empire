import type { WallId } from '../../shared/decor';

/** A walk-blocking footprint on the ground floor, in office coordinates (it follows the floor elevation once pushed). */
export interface Footprint {
  name: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  top: number;
}
const rect = (name: string, x: number, z: number, w: number, d: number, top: number): Footprint => ({ name, minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top });

/** Under the loft, east of the stairs, clear of the lounge and the loft posts. */
export const MEETING = { x: 13.8, z: 10.6, length: 3.2, width: 1.3 } as const;
/** West of the entrance, facing the door route; the door corridor and stairs stay open. */
export const RECEPTION = { x: -3.2, z: 10.4, length: 2.4, depth: 0.8 } as const;

/** [x, z, rotY]; at rotY 0 the sitter faces -z, as at the desks. */
export const MEETING_CHAIRS: readonly (readonly [number, number, number])[] = [
  ...[-1, 0, 1].flatMap((dx) => [[MEETING.x + dx, MEETING.z - 0.95, Math.PI] as const, [MEETING.x + dx, MEETING.z + 0.95, 0] as const]),
  [MEETING.x - MEETING.length / 2 - 0.55, MEETING.z, -Math.PI / 2],
];
export const RECEPTION_CHAIR = [RECEPTION.x - 0.95, RECEPTION.z, Math.PI / 2] as const;
export const BAR_STOOLS: readonly (readonly [number, number])[] = [-0.8, 0, 0.8].map((dx) => [-14.8 + dx, 8.1] as const);
/** Covers the seat and, whichever way the chair turns, its backrest. */
const CHAIR_SIZE = 0.62;
const STOOL_SIZE = 0.42;

// ---- Amenities (LIFE-02) ------------------------------------------------------------------------
// One office layout serves every HQ floor (office.setFloor only moves it), so each floor gets them.

export type AmenityKind = 'coffee' | 'cafeteria' | 'gym';
/** How a body uses a spot: standing, seated on a chair, walking a treadmill belt, pedalling, lifting or stretching. */
export type SpotPose = 'stand' | 'sit' | 'treadmill' | 'bike' | 'weights' | 'stretch';
/**
 * Where one person uses an amenity. `rotY` follows the chair convention (at 0 you face -z), so the
 * facing direction is (-sin rotY, -cos rotY). `approach` is the clear floor point a path ends at;
 * the last step from it to the spot may cross the spot's own equipment (a chair, a treadmill).
 */
export interface AmenitySpot {
  id: string;
  kind: AmenityKind;
  pose: SpotPose;
  x: number;
  z: number;
  rotY: number;
  /** Height of what you stand or sit on (a treadmill belt, a saddle), above the floor. */
  y: number;
  approach: { x: number; z: number };
}

/** The gym corner: east of the elevator approach, west of the services-board approach, south of the queue board. */
export const GYM = { minX: 10.4, maxX: 15.0, minZ: -9.9, maxZ: -4.5 } as const;
export const TREADMILLS: readonly (readonly [number, number])[] = [[11.05, -8.7], [12.25, -8.7]];
export const TREADMILL_SIZE = { width: 0.8, length: 1.9, belt: 0.2 } as const;
/** Saddle position; the bike points north (the rider faces -z). */
export const BIKE = { x: 13.75, z: -8.25, saddle: 0.8, lift: 0.3 } as const;
export const DUMBBELL_RACK = { x: 14.6, z: -6.4, width: 0.5, length: 1.5 } as const;
export const GYM_MATS: readonly (readonly [number, number])[] = [[11.2, -5.5], [12.4, -5.5]];

/** Cafeteria and breakfast counter, between the storage wall and the coffee bar, west of the desk pods. */
export const CAFETERIA = { minX: -17.95, maxX: -13.6, minZ: 1.7, maxZ: 7.2 } as const;
export const BREAKFAST = { x: -17.6, z: 3.7, depth: 0.6, length: 3.0, top: 0.92 } as const;
export const CAFE_TABLES: readonly (readonly [number, number])[] = [[-15.1, 3.1], [-15.1, 5.9]];
const CAFE_TABLE_SIZE = 0.9;
/** [x, z, rotY], four chairs to a table, each facing it. */
export const CAFE_CHAIRS: readonly (readonly [number, number, number])[] = CAFE_TABLES.flatMap(([x, z]) => [
  [x - 0.78, z, -Math.PI / 2] as const,
  [x + 0.78, z, Math.PI / 2] as const,
  [x, z - 0.78, Math.PI] as const,
  [x, z + 0.78, 0] as const,
]);

/** To one side of a chair, where you step in from before sitting down. */
const beside = (x: number, z: number, rotY: number, d: number) => ({ x: x + Math.cos(rotY) * d, z: z - Math.sin(rotY) * d });

export const AMENITY_SPOTS: readonly AmenitySpot[] = [
  // Coffee: at the machine and counter (facing the south wall) and at the bar (facing north).
  { id: 'coffee-machine', kind: 'coffee', pose: 'stand', x: -15.7, z: 11.05, rotY: Math.PI, y: 0, approach: { x: -15.7, z: 11.05 } },
  { id: 'coffee-counter', kind: 'coffee', pose: 'stand', x: -14.5, z: 11.05, rotY: Math.PI, y: 0, approach: { x: -14.5, z: 11.05 } },
  { id: 'coffee-bar-west', kind: 'coffee', pose: 'stand', x: -15.3, z: 9.6, rotY: 0, y: 0, approach: { x: -15.3, z: 9.6 } },
  { id: 'coffee-bar-east', kind: 'coffee', pose: 'stand', x: -14.3, z: 9.6, rotY: 0, y: 0, approach: { x: -14.3, z: 9.6 } },
  ...CAFE_CHAIRS.map(([x, z, rotY], i): AmenitySpot => ({ id: `cafe-chair-${i + 1}`, kind: 'cafeteria', pose: 'sit', x, z, rotY, y: 0, approach: beside(x, z, rotY, 0.55) })),
  ...TREADMILLS.map(([x, z], i): AmenitySpot => ({ id: `treadmill-${i + 1}`, kind: 'gym', pose: 'treadmill', x, z: z + 0.25, rotY: 0, y: TREADMILL_SIZE.belt, approach: { x, z: z + TREADMILL_SIZE.length / 2 + 0.55 } })),
  { id: 'bike', kind: 'gym', pose: 'bike', x: BIKE.x, z: BIKE.z, rotY: 0, y: BIKE.lift, approach: { x: BIKE.x + 0.7, z: BIKE.z } },
  { id: 'dumbbells', kind: 'gym', pose: 'weights', x: DUMBBELL_RACK.x - 0.7, z: DUMBBELL_RACK.z, rotY: -Math.PI / 2, y: 0, approach: { x: DUMBBELL_RACK.x - 0.7, z: DUMBBELL_RACK.z } },
  ...GYM_MATS.map(([x, z], i): AmenitySpot => ({ id: `mat-${i + 1}`, kind: 'gym', pose: 'stretch', x, z, rotY: 0, y: 0, approach: { x, z } })),
];

export const AMENITY_COLLIDERS: readonly Footprint[] = [
  ...TREADMILLS.map(([x, z]) => rect('treadmill', x, z, TREADMILL_SIZE.width, TREADMILL_SIZE.length, 1.35)),
  rect('exercise bike', BIKE.x, BIKE.z - 0.3, 0.6, 1.25, 1.1),
  rect('dumbbell rack', DUMBBELL_RACK.x, DUMBBELL_RACK.z, DUMBBELL_RACK.width, DUMBBELL_RACK.length, 0.9),
  rect('breakfast counter', BREAKFAST.x, BREAKFAST.z, BREAKFAST.depth, BREAKFAST.length, BREAKFAST.top),
  ...CAFE_TABLES.map(([x, z]) => rect('cafeteria table', x, z, CAFE_TABLE_SIZE, CAFE_TABLE_SIZE, 0.76)),
  ...CAFE_CHAIRS.map(([x, z]) => rect('cafeteria chair', x, z, CHAIR_SIZE, CHAIR_SIZE, 0.51)),
];

/** Where the player can use each amenity (an E interaction, like the coffee machine). */
export const AMENITY_INTERACTIONS: readonly { kind: 'gym' | 'cafeteria'; x: number; z: number; radius: number }[] = [
  { kind: 'gym', x: 12.7, z: -7.1, radius: 2.6 },
  { kind: 'cafeteria', x: -16.3, z: 3.7, radius: 1.6 },
];

export const FURNISHING_COLLIDERS: readonly Footprint[] = [
  rect('meeting table', MEETING.x, MEETING.z, MEETING.length, MEETING.width, 0.76),
  rect('meeting credenza', 17.7, MEETING.z, 0.5, 2, 0.7),
  rect('reception counter', RECEPTION.x, RECEPTION.z, RECEPTION.depth, RECEPTION.length, 1.12),
  rect('reception work surface', RECEPTION.x - RECEPTION.depth / 2 - 0.2, RECEPTION.z, 0.5, RECEPTION.length - 0.2, 0.76),
  rect('reception storage', -5.15, 12.72, 2.5, 0.45, 0.74),
  rect('waiting chair', -7.9, 9.85, 0.8, 0.8, 0.45),
  rect('waiting chair', -7.9, 11.35, 0.8, 0.8, 0.45),
  rect('side table', -7.9, 10.6, 0.46, 0.46, 0.52),
  rect('coffee bar', -14.8, 8.85, 2.8, 0.6, 1.06),
  rect('recycling bins', -10.1, 12.55, 0.85, 0.4, 0.62),
  rect('storage wall', -17.62, 0, 0.45, 2.6, 2.1),
  rect('printer', 2.6, -12.5, 0.7, 0.62, 1.05),
  rect('paper cabinet', 3.55, -12.62, 0.9, 0.42, 0.9),
  ...MEETING_CHAIRS.map(([x, z]) => rect('meeting chair', x, z, CHAIR_SIZE, CHAIR_SIZE, 0.51)),
  rect('reception chair', RECEPTION_CHAIR[0], RECEPTION_CHAIR[1], CHAIR_SIZE, CHAIR_SIZE, 0.51),
  ...BAR_STOOLS.map(([x, z]) => rect('bar stool', x, z, STOOL_SIZE, STOOL_SIZE, 0.79)),
  ...AMENITY_COLLIDERS,
];

/** Wall areas the furniture covers, so hung pictures avoid them: [wall, u (x or z along it), center y, width, height]. */
export const FURNISHING_FIXTURES: readonly (readonly [WallId, number, number, number, number])[] = [
  ['east', MEETING.z, 1.1, 2.3, 2.2],
  ['south', -5.15, 0.37, 2.5, 0.74],
  ['south', -10.1, 0.31, 0.85, 0.62],
  ['west', 0, 1.05, 2.6, 2.1],
  ['north', 3.05, 0.55, 1.9, 1.1],
  // The breakfast counter and what stands on it, under the west window.
  ['west', BREAKFAST.z, 0.6, BREAKFAST.length, 1.2],
];
