import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AMENITY_COLLIDERS, AMENITY_SPOTS, BAR_STOOLS, BREAKFAST, CAFE_CHAIRS, CAFE_TABLES, CAFETERIA, FURNISHING_COLLIDERS, FURNISHING_FIXTURES, GYM, MEETING_CHAIRS, RECEPTION_CHAIR, TREADMILLS, type Footprint,
} from '../src/client/world/furnishing-layout';
import { BOARDS, DESKS, DESK_SIZE, FLOOR, LIFT, LOFT, SPAWN, STAIRS, TV, deskSeat } from '../src/shared/layout';

type Box = { minX: number; maxX: number; minZ: number; maxZ: number };
const overlaps = (a: Box, b: Box) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
const around = (x: number, z: number, r: number): Box => ({ minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r });
const clearOf = (zone: Box, label: string) => {
  for (const f of FURNISHING_COLLIDERS) assert.ok(!overlaps(f, zone), `${f.name} blocks ${label}`);
};

test('funded desk seats, desk tops and their interaction spots stay clear', () => {
  for (const d of DESKS) {
    clearOf({ minX: d.x - DESK_SIZE.width / 2 - 0.3, maxX: d.x + DESK_SIZE.width / 2 + 0.3, minZ: d.z - DESK_SIZE.depth / 2 - 0.3, maxZ: d.z + DESK_SIZE.depth / 2 + 0.3 }, `${d.id} desk`);
    const seat = deskSeat(d, 0.9);
    clearOf(around(seat.x, seat.z, 0.9), `${d.id} seat`);
    const use = deskSeat(d, 1.25);
    clearOf(around(use.x, use.z, 1), `${d.id} interaction`);
  }
});

test('exit, entrance aisle, stairs, elevator and loft posts stay usable', () => {
  clearOf({ minX: -2.7, maxX: 2.7, minZ: 7, maxZ: FLOOR.maxZ }, 'the exit door and entrance aisle');
  clearOf({ minX: STAIRS.fromX - 0.3, maxX: STAIRS.toX + 0.3, minZ: STAIRS.minZ - 0.8, maxZ: STAIRS.maxZ }, 'the stairs and their foot');
  clearOf({ minX: LIFT.x - 3, maxX: LIFT.x + 3, minZ: LIFT.z - 1.7, maxZ: LIFT.doorZ + 3.5 }, 'the elevator and its approach');
  for (const x of [LOFT.minX + 0.15, (LOFT.minX + LOFT.maxX) / 2]) clearOf(around(x, LOFT.minZ + 0.15, 0.7), 'a loft post');
  // The way into the meeting area between the loft posts and the lounge.
  clearOf({ minX: LOFT.minX + 0.5, maxX: 17.5, minZ: LOFT.minZ + 0.1, maxZ: LOFT.minZ + 0.9 }, 'the meeting-area walkway');
  clearOf(around(SPAWN.x, SPAWN.z, 1.2), 'the spawn point');
});

test('every board, the TV and the coffee machine keep their approach', () => {
  for (const [key, b] of Object.entries(BOARDS)) {
    const nx = Math.sin(b.rotY), nz = Math.cos(b.rotY);
    const ax = b.x + nx * 1.6, az = b.z + nz * 1.6;
    const half = b.width / 2;
    // From the wall out past the approach spot, across the board's width.
    const along = Math.abs(nz) > 0.5;
    clearOf(
      along
        ? { minX: b.x - half, maxX: b.x + half, minZ: Math.min(b.z, az + nz * 1.2), maxZ: Math.max(b.z, az + nz * 1.2) }
        : { minX: Math.min(b.x, ax + nx * 1.2), maxX: Math.max(b.x, ax + nx * 1.2), minZ: b.z - half, maxZ: b.z + half },
      `the ${key} board`,
    );
  }
  clearOf({ minX: TV.x - 6, maxX: TV.x, minZ: TV.z - TV.width / 2, maxZ: TV.z + TV.width / 2 }, 'the TV lounge');
  clearOf(around(-15.7, 10.9, 1), 'the coffee machine');
});

test('furniture fits the room, avoids existing fixtures and leaves real aisles', () => {
  const existing: [string, Box][] = [
    ['kitchen counter', { minX: -17, maxX: -12, minZ: 11.7, maxZ: 12.7 }],
    ['fridge', { minX: -11.85, maxX: -10.75, minZ: 11.7, maxZ: 12.7 }],
    ['couch', { minX: 10, maxX: 11, minZ: -2.2, maxZ: 2.2 }],
    ['coffee table', { minX: 12.2, maxX: 13.8, minZ: -0.8, maxZ: 0.8 }],
    ...([[12.5, 3.5], [14.5, -3.4]] as const).map(([x, z]) => ['beanbag', around(x, z, 0.5)] as [string, Box]),
    ...([[-17.2, -12.2, 1.4], [17.2, -12.2, 1.5], [17.2, 12.2, 1.3], [-17.2, 8.5, 1.2], [5.5, -12.2, 1.1], [-6, 0, 1], [3.5, 0, 0.9], [8.5, 5, 1.1]] as const).map(
      ([x, z, s]) => ['plant', around(x, z, 0.3 * s)] as [string, Box],
    ),
  ];
  for (const f of FURNISHING_COLLIDERS) {
    assert.ok(f.minX >= FLOOR.minX && f.maxX <= FLOOR.maxX && f.minZ >= FLOOR.minZ && f.maxZ <= FLOOR.maxZ, `${f.name} is inside the walls`);
    assert.ok(f.top > 0 && f.top < 2.75, `${f.name} has a believable height`);
    for (const [name, box] of existing) assert.ok(!overlaps(f, box), `${f.name} overlaps the ${name}`);
  }
  const named = (name: string) => FURNISHING_COLLIDERS.filter((f) => f.name === name);
  const gapZ = (a: Footprint, b: Box) => b.minZ - a.maxZ;
  for (const stool of named('bar stool')) assert.ok(stool.minZ - 7.1 >= 0.5, 'bar stools leave the desk-pod aisle open');
  assert.ok(gapZ(named('coffee bar')[0], { minX: -17, maxX: -12, minZ: 11.7, maxZ: 12.7 }) >= 2, 'the kitchen aisle stays at least 2 m');
  assert.ok(-1.4 - named('reception counter')[0].maxX >= 1.2, 'reception leaves over a metre beside the door');
  const table = named('meeting table')[0];
  assert.ok(Math.min(...named('meeting chair').map((c) => c.minZ)) - LOFT.minZ >= 1, 'the meeting chairs leave the walkway under the loft edge');
  assert.ok(named('meeting chair').every((c) => overlaps(c, { ...table, minX: table.minX - 0.8, maxX: table.maxX + 0.1, minZ: table.minZ - 0.8, maxZ: table.maxZ + 0.8 })), 'meeting chairs sit at the table');
});

test('gym, cafeteria and coffee amenities fit their zones without overlapping other furniture', () => {
  const others = FURNISHING_COLLIDERS.filter((f) => !AMENITY_COLLIDERS.includes(f));
  for (const a of AMENITY_COLLIDERS) {
    for (const f of others) assert.ok(!overlaps(a, f), `${a.name} overlaps the ${f.name}`);
    for (const b of AMENITY_COLLIDERS) if (a !== b) assert.ok(!overlaps(a, b), `${a.name} overlaps a ${b.name}`);
  }
  const gym = AMENITY_COLLIDERS.filter((f) => ['treadmill', 'exercise bike', 'dumbbell rack'].includes(f.name));
  assert.equal(gym.length, TREADMILLS.length + 2);
  for (const f of gym) assert.ok(f.minX >= GYM.minX && f.maxX <= GYM.maxX && f.minZ >= GYM.minZ && f.maxZ <= GYM.maxZ, `${f.name} is in the gym corner`);
  const cafe = AMENITY_COLLIDERS.filter((f) => f.name.startsWith('cafeteria') || f.name === 'breakfast counter');
  assert.equal(cafe.filter((f) => f.name === 'cafeteria table').length, CAFE_TABLES.length);
  assert.equal(cafe.filter((f) => f.name === 'cafeteria chair').length, CAFE_CHAIRS.length);
  for (const f of cafe) assert.ok(f.minX >= CAFETERIA.minX && f.maxX <= CAFETERIA.maxX && f.minZ >= CAFETERIA.minZ && f.maxZ <= CAFETERIA.maxZ, `${f.name} is in the cafeteria`);
  // A real aisle stays open between the cafeteria and the nearest desks.
  const westDesk = Math.min(...DESKS.map((d) => d.x - DESK_SIZE.width / 2));
  assert.ok(westDesk - Math.max(...cafe.map((f) => f.maxX)) >= 1.2, 'aisle between the cafeteria and the desks');
  assert.ok(BREAKFAST.x - BREAKFAST.depth / 2 >= FLOOR.minX, 'the breakfast counter stands inside the west wall');
});

test('every amenity use spot is reachable and clear, and seats sit in their own equipment', () => {
  assert.deepEqual(new Set(AMENITY_SPOTS.map((s) => s.kind)), new Set(['coffee', 'cafeteria', 'gym']));
  assert.equal(new Set(AMENITY_SPOTS.map((s) => s.id)).size, AMENITY_SPOTS.length, 'unique spot ids');
  for (const s of AMENITY_SPOTS) {
    assert.ok(s.x > FLOOR.minX + 0.3 && s.x < FLOOR.maxX - 0.3 && s.z > FLOOR.minZ + 0.3 && s.z < FLOOR.maxZ - 0.3, `${s.id} is in the room`);
    clearOf(around(s.approach.x, s.approach.z, 0.22), `the ${s.id} approach`);
    const containing = FURNISHING_COLLIDERS.filter((f) => overlaps(f, around(s.x, s.z, 0.01)));
    if (s.pose === 'sit' || s.pose === 'treadmill' || s.pose === 'bike') assert.equal(containing.length, 1, `${s.id} sits in exactly its own equipment`);
    else clearOf(around(s.x, s.z, 0.28), `the ${s.id} standing spot`);
  }
  // Coffee spots stay clear of the coffee machine's own approach and in the kitchen aisle.
  for (const s of AMENITY_SPOTS.filter((x) => x.kind === 'coffee')) assert.ok(s.z > 9.15 && s.z < 11.7, `${s.id} is in the kitchen aisle`);
  // Seats: a chair is registered at each cafeteria spot, facing its table.
  for (const s of AMENITY_SPOTS.filter((x) => x.pose === 'sit')) {
    const table = CAFE_TABLES.find(([x, z]) => Math.hypot(x - s.x, z - s.z) < 0.8)!;
    assert.ok(table, `${s.id} is at a table`);
    const fx = -Math.sin(s.rotY), fz = -Math.cos(s.rotY);
    assert.ok((table[0] - s.x) * fx + (table[1] - s.z) * fz > 0.6, `${s.id} faces the table`);
  }
});

test('chairs and stools block their seat and backrest, and wall fixtures are registered', () => {
  assert.equal(named('meeting chair').length, MEETING_CHAIRS.length);
  assert.equal(named('bar stool').length, BAR_STOOLS.length);
  const reception = named('reception chair')[0];
  assert.ok(reception.minX <= RECEPTION_CHAIR[0] - 0.3 && reception.maxX >= RECEPTION_CHAIR[0] + 0.3, 'the footprint reaches the backrest in every rotation');
  assert.equal(new Set(FURNISHING_FIXTURES.map(([wall]) => wall)).size, 4);
  function named(name: string) {
    return FURNISHING_COLLIDERS.filter((f) => f.name === name);
  }
});
