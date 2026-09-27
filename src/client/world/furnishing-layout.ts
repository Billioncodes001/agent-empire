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

export const FURNISHING_COLLIDERS: readonly Footprint[] = [
  rect('meeting table', MEETING.x, MEETING.z, MEETING.length, MEETING.width, 0.76),
  rect('meeting credenza', 17.7, MEETING.z, 0.5, 2, 0.7),
  rect('reception counter', RECEPTION.x, RECEPTION.z, RECEPTION.depth, RECEPTION.length, 1.12),
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
];

/** Wall areas the furniture covers, so hung pictures avoid them: [wall, u (x or z along it), center y, width, height]. */
export const FURNISHING_FIXTURES: readonly (readonly [WallId, number, number, number, number])[] = [
  ['east', MEETING.z, 1.1, 2.3, 2.2],
  ['south', -5.15, 0.37, 2.5, 0.74],
  ['south', -10.1, 0.31, 0.85, 0.62],
  ['west', 0, 1.05, 2.6, 2.1],
  ['north', 3.05, 0.55, 1.9, 1.1],
];
