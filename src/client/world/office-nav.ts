/** Where workers can walk on an HQ floor, derived from the shared layout. Pure; tested in office-life.test.ts. */
import { DESKS, DESK_SIZE, FLOOR, LIFT, LOFT, STAIRS, deskSeat, type DeskDef } from '../../shared/layout';
import { FURNISHING_COLLIDERS } from './furnishing-layout';
import { NavGrid, type NavBox, type Point } from './navgrid';

const box = (x: number, z: number, hw: number, hd: number): NavBox => ({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd });

/**
 * Fixed room fittings that office.ts builds outside the furnishing layout (kitchen counter and
 * fridge, lounge, plants, the elevator shaft, the stairs and loft posts). At runtime the grid also
 * takes every live office collider, so a stale copy here can only make paths more cautious.
 */
export const ROOM_FITTINGS: readonly NavBox[] = [
  { minX: -17, maxX: -12, minZ: 11.7, maxZ: 12.7 },
  { minX: -11.85, maxX: -10.75, minZ: 11.7, maxZ: 12.7 },
  { minX: 10, maxX: 11, minZ: -2.2, maxZ: 2.2 },
  { minX: 12.2, maxX: 13.8, minZ: -0.8, maxZ: 0.8 },
  box(12.5, 3.5, 0.5, 0.5),
  box(14.5, -3.4, 0.5, 0.5),
  ...([[-17.2, -12.2, 1.4], [17.2, -12.2, 1.5], [17.2, 12.2, 1.3], [-17.2, 8.5, 1.2], [5.5, -12.2, 1.1], [-6, 0, 1], [3.5, 0, 0.9], [8.5, 5, 1.1]] as const).map(([x, z, s]) => box(x, z, 0.3 * s, 0.3 * s)),
  { minX: LIFT.x - 2.8, maxX: LIFT.x + 2.8, minZ: LIFT.z - 1.7, maxZ: LIFT.doorZ + 0.35 },
  { minX: STAIRS.fromX, maxX: STAIRS.toX, minZ: STAIRS.minZ - 0.1, maxZ: STAIRS.maxZ },
  box(LOFT.minX + 0.15, LOFT.minZ + 0.15, 0.14, 0.14),
  box((LOFT.minX + LOFT.maxX) / 2, LOFT.minZ + 0.15, 0.14, 0.14),
];

/** Every desk top and every desk chair on the floor: nobody cuts through someone else's workstation. */
export function deskObstacles(): NavBox[] {
  const out: NavBox[] = [];
  for (const d of DESKS) {
    const hw = DESK_SIZE.width / 2 - 0.05, hd = DESK_SIZE.depth / 2 - 0.02;
    const c = Math.abs(Math.cos(d.rotY)) > 0.5;
    out.push(box(d.x, d.z, c ? hw : hd, c ? hd : hw));
    const seat = deskSeat(d, 0.9);
    out.push(box(seat.x, seat.z, 0.3, 0.3));
  }
  return out;
}

export const layoutObstacles = (): NavBox[] => [...FURNISHING_COLLIDERS, ...ROOM_FITTINGS, ...deskObstacles()];

export function buildNavGrid(extra: readonly NavBox[] = []): NavGrid {
  return new NavGrid(FLOOR, [...layoutObstacles(), ...extra]);
}

/** Seat root (where the seated body is placed) and the aisle point behind the chair, in office coordinates. */
export function deskPoints(desk: DeskDef): { seat: Point; exit: Point } {
  return { seat: deskSeat(desk, 0.93), exit: deskSeat(desk, 1.62) };
}
