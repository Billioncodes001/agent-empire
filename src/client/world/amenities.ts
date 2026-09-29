import * as THREE from 'three';
import { SURFACE, boxMesh, solid } from './materials';
import { textPlane } from './toon';
import { batchStaticMeshes } from './batching';
import {
  AMENITY_INTERACTIONS, BIKE, BREAKFAST, CAFE_CHAIRS, CAFE_TABLES, CAFETERIA, DUMBBELL_RACK, GYM, GYM_MATS, TREADMILLS, TREADMILL_SIZE,
} from './furnishing-layout';
import type { Interactable } from './office';

// Materials follow furnishing.ts: measured PBR surfaces, no toon shading, no new binary assets.
const MAT = {
  rubber: solid('#2c3134', 0.95),
  rubberLine: solid('#4a5256', 0.9),
  belt: solid('#1d2123', 0.85),
  console: solid('#30363a', 0.45, 0.2),
  display: solid('#0e1316', 0.2, 0.35),
  steel: solid('#b7bcbe', 0.3, 0.8),
  iron: solid('#2b3033', 0.45, 0.6),
  grip: solid('#50585c', 0.8),
  matBlue: solid('#4f6a78', 0.95),
  matSage: solid('#6f7f6a', 0.95),
  laminate: solid('#d7d2c6', 0.55),
  tableTop: solid('#e9e5dc', 0.5),
  cushion: solid('#857a67', 0.95),
  ceramic: solid('#f2efe8', 0.35),
  glassJar: solid('#d9e4e2', 0.1, 0.1),
  cereal: solid('#c89b54', 0.8),
  granola: solid('#9b6a3c', 0.85),
  juice: solid('#e39a3a', 0.3),
  milk: solid('#f4f1ea', 0.4),
  croissant: solid('#c98a3e', 0.7),
  bread: solid('#b9824a', 0.8),
  apple: solid('#b8563f', 0.55),
  pear: solid('#8aa04e', 0.55),
  banana: solid('#d8b845', 0.6),
  chrome: solid('#d5d8d9', 0.18, 0.95),
  espresso: solid('#23282b', 0.35, 0.5),
  copper: solid('#b0714a', 0.3, 0.85),
  syrup: solid('#7a3d2a', 0.25),
  chalk: solid('#1f2a27', 0.9),
};

const BULB = new THREE.MeshStandardMaterial({ color: '#fff4e2', emissive: '#ffe2b0', emissiveIntensity: 2 });

function cyl(parent: THREE.Object3D, rTop: number, rBottom: number, h: number, mat: THREE.Material, x: number, y: number, z: number, segments = 14) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, segments), mat);
  m.position.set(x, y, z);
  // Tabletop-sized items skip the shadow pass; their contact shading comes from SSAO.
  m.castShadow = h > 0.25 || Math.max(rTop, rBottom) > 0.1;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}
function sphere(parent: THREE.Object3D, r: number, mat: THREE.Material, x: number, y: number, z: number) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 9), mat);
  m.position.set(x, y, z);
  m.castShadow = r > 0.1;
  parent.add(m);
  return m;
}
/** A cylinder lying along x (dumbbell handles, bar rails). */
function rod(parent: THREE.Object3D, r: number, len: number, mat: THREE.Material, x: number, y: number, z: number, axis: 'x' | 'z' = 'x') {
  const m = cyl(parent, r, r, len, mat, x, y, z, 10);
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  else m.rotation.x = Math.PI / 2;
  return m;
}

function treadmill(g: THREE.Group, x: number, z: number) {
  const { width, length, belt } = TREADMILL_SIZE;
  // Deck and belt run north-south; the console stands at the north (-z) end, facing the runner.
  boxMesh(g, width, belt - 0.04, length, MAT.console, x, (belt - 0.04) / 2, z);
  boxMesh(g, width - 0.22, 0.02, length - 0.2, MAT.belt, x, belt - 0.02, z + 0.05);
  for (const s of [-1, 1]) {
    boxMesh(g, 0.1, 0.03, length - 0.1, MAT.grip, x + s * (width / 2 - 0.05), belt - 0.015, z + 0.05);
    // Uprights and handrails.
    const post = boxMesh(g, 0.06, 1.15, 0.08, MAT.steel, x + s * (width / 2 - 0.04), belt + 0.5, z - length / 2 + 0.2);
    post.rotation.x = -0.12;
    rod(g, 0.022, 0.55, MAT.grip, x + s * (width / 2 - 0.04), belt + 0.92, z - length / 2 + 0.5, 'z');
  }
  boxMesh(g, width, 0.08, 0.18, MAT.console, x, belt + 1.1, z - length / 2 + 0.14);
  const screen = boxMesh(g, 0.36, 0.2, 0.02, MAT.display, x, belt + 1.2, z - length / 2 + 0.24);
  screen.rotation.x = -0.35;
  boxMesh(g, 0.2, 0.06, 0.12, MAT.console, x, 0.08, z + length / 2 - 0.02);
}

function bike(g: THREE.Group) {
  const { x, z, saddle } = BIKE;
  // Rider faces -z. Crank centre 0.33 m up, 0.22 m ahead of the saddle; bars 0.52 m ahead (human.ts pedal/hand targets).
  boxMesh(g, 0.5, 0.06, 0.12, MAT.iron, x, 0.03, z + 0.25);
  boxMesh(g, 0.5, 0.06, 0.12, MAT.iron, x, 0.03, z - 0.78);
  boxMesh(g, 0.08, 0.06, 1.05, MAT.iron, x, 0.07, z - 0.27);
  const seatPost = boxMesh(g, 0.06, saddle - 0.12, 0.06, MAT.iron, x, (saddle - 0.12) / 2 + 0.05, z + 0.03);
  seatPost.rotation.x = 0.18;
  boxMesh(g, 0.2, 0.06, 0.28, MAT.console, x, saddle - 0.03, z);
  const down = boxMesh(g, 0.07, 0.95, 0.07, MAT.iron, x, 0.52, z - 0.5);
  down.rotation.x = -0.35;
  // Flywheel under a shroud, crank and pedals.
  const fly = cyl(g, 0.24, 0.24, 0.06, MAT.steel, x, 0.34, z - 0.62, 24);
  fly.rotation.z = Math.PI / 2;
  const hub = cyl(g, 0.07, 0.07, 0.14, MAT.iron, x, 0.33, z - 0.22, 12);
  hub.rotation.z = Math.PI / 2;
  for (const s of [-1, 1]) boxMesh(g, 0.1, 0.03, 0.06, MAT.console, x + s * 0.13, 0.33 + s * 0.13, z - 0.22);
  // Handlebars and a small console.
  rod(g, 0.022, 0.5, MAT.grip, x, 1.02, z - 0.52);
  boxMesh(g, 0.05, 0.25, 0.05, MAT.iron, x, 0.92, z - 0.6);
  const display = boxMesh(g, 0.18, 0.12, 0.03, MAT.display, x, 1.1, z - 0.64);
  display.rotation.x = -0.4;
}

function dumbbellRack(g: THREE.Group) {
  const { x, z, width, length } = DUMBBELL_RACK;
  // Two tiers of pairs, lighter on top, on a steel A-frame facing west.
  for (const s of [-1, 1]) {
    const leg = boxMesh(g, 0.05, 0.9, 0.05, MAT.iron, x + 0.12, 0.45, z + s * (length / 2 - 0.05));
    leg.rotation.z = 0.12;
    boxMesh(g, 0.05, 0.85, 0.05, MAT.iron, x - 0.12, 0.425, z + s * (length / 2 - 0.05));
  }
  for (const [y, dx, r] of [[0.36, -0.1, 0.07], [0.72, 0.05, 0.05]] as const) {
    boxMesh(g, width - 0.12, 0.03, length - 0.05, MAT.iron, x + dx, y - r - 0.02, z);
    for (let i = 0; i < 5; i++) {
      const dz = -length / 2 + 0.18 + i * ((length - 0.36) / 4);
      rod(g, 0.014, 0.28, MAT.steel, x + dx, y, z + dz, 'x');
      for (const e of [-0.11, 0.11]) {
        const plate = cyl(g, r - i * 0.004, r - i * 0.004, 0.05, MAT.iron, x + dx + e, y, z + dz, 12);
        plate.rotation.z = Math.PI / 2;
      }
    }
  }
  // Kettlebells on the floor beside the rack.
  for (let i = 0; i < 3; i++) {
    const kz = z - length / 2 - 0.25 - i * 0.28;
    sphere(g, 0.1 - i * 0.012, MAT.iron, x, 0.1 - i * 0.012, kz);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 6, 14, Math.PI), MAT.iron);
    handle.position.set(x, 0.19 - i * 0.02, kz);
    g.add(handle);
  }
}

function gym(g: THREE.Group) {
  const w = GYM.maxX - GYM.minX, d = GYM.maxZ - GYM.minZ, cx = (GYM.minX + GYM.maxX) / 2, cz = (GYM.minZ + GYM.maxZ) / 2;
  // Interlocking rubber tiles with a lighter border mark the gym zone on the oak floor.
  boxMesh(g, w, 0.012, d, MAT.rubber, cx, 0.006, cz).castShadow = false;
  for (const [bw, bd, bx, bz] of [[w, 0.06, cx, GYM.minZ + 0.03], [w, 0.06, cx, GYM.maxZ - 0.03], [0.06, d, GYM.minX + 0.03, cz], [0.06, d, GYM.maxX - 0.03, cz]] as const)
    boxMesh(g, bw, 0.016, bd, MAT.rubberLine, bx, 0.008, bz).castShadow = false;
  for (const [x, z] of TREADMILLS) treadmill(g, x, z);
  bike(g);
  dumbbellRack(g);
  GYM_MATS.forEach(([x, z], i) => {
    boxMesh(g, 0.65, 0.012, 1.8, i ? MAT.matSage : MAT.matBlue, x, 0.018, z).castShadow = false;
    // A rolled towel at the head of each mat.
    rod(g, 0.045, 0.5, MAT.laminate, x, 0.07, z - 0.8, 'x');
  });
  // A stability ball and a water station on the gym floor edge.
  sphere(g, 0.3, solid('#7c8f88', 0.7), 13.55, 0.3, -5.1);
  cyl(g, 0.14, 0.14, 0.42, MAT.console, 14.7, 0.21, -9.5, 16);
  cyl(g, 0.12, 0.12, 0.34, solid('#b8d4dc', 0.1, 0.05), 14.7, 0.6, -9.5, 16);
  const sign = textPlane('GYM', { color: '#d6dfcf', size: 44 });
  sign.scale.setScalar(0.5 / sign.geometry.parameters.width);
  sign.position.set(GYM.minX + 0.4, 0.02, GYM.maxZ - 0.25);
  sign.rotation.x = -Math.PI / 2;
  g.add(sign);
}

function breakfastCounter(g: THREE.Group) {
  const { x, z, depth, length, top } = BREAKFAST;
  boxMesh(g, depth - 0.06, top - 0.04, length, MAT.laminate, x, (top - 0.04) / 2, z);
  boxMesh(g, depth + 0.04, 0.04, length + 0.04, SURFACE.wood, x, top - 0.02, z);
  // Cereal and granola dispensers (glass cylinders on a stand).
  for (const [dz, mat] of [[-1.25, MAT.cereal], [-1.0, MAT.granola], [-0.75, MAT.cereal]] as const) {
    cyl(g, 0.07, 0.07, 0.3, MAT.glassJar, x, top + 0.21, z + dz, 12);
    cyl(g, 0.064, 0.064, 0.2, mat, x, top + 0.16, z + dz, 12);
    boxMesh(g, 0.12, 0.06, 0.12, MAT.console, x, top + 0.03, z + dz);
  }
  // Juice and milk jugs, stacked bowls and cups.
  cyl(g, 0.06, 0.07, 0.24, MAT.juice, x + 0.05, top + 0.12, z - 0.35, 12);
  cyl(g, 0.06, 0.07, 0.24, MAT.milk, x + 0.05, top + 0.12, z - 0.18, 12);
  for (let i = 0; i < 5; i++) cyl(g, 0.08, 0.05, 0.035, MAT.ceramic, x + 0.08, top + 0.02 + i * 0.03, z + 0.08, 14);
  for (let i = 0; i < 4; i++) cyl(g, 0.11, 0.1, 0.02, MAT.ceramic, x + 0.05, top + 0.012 + i * 0.022, z + 0.32, 16);
  // A pastry board under a glass cloche, a bread board and a fruit bowl.
  boxMesh(g, 0.36, 0.02, 0.46, SURFACE.wood, x + 0.02, top + 0.01, z + 0.72);
  for (let i = 0; i < 5; i++) {
    const c = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.07, 3, 8), MAT.croissant);
    c.rotation.set(0, i * 0.7, Math.PI / 2);
    c.position.set(x + 0.02 + (i % 2 ? 0.07 : -0.07), top + 0.05, z + 0.56 + i * 0.075);
    c.castShadow = true;
    g.add(c);
  }
  const cloche = new THREE.Mesh(new THREE.SphereGeometry(0.24, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), SURFACE.glass);
  cloche.position.set(x + 0.02, top + 0.02, z + 0.72);
  cloche.scale.set(0.8, 0.75, 1);
  g.add(cloche);
  boxMesh(g, 0.3, 0.03, 0.22, SURFACE.wood, x + 0.02, top + 0.015, z + 1.15);
  const loaf = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.14, 3, 10), MAT.bread);
  loaf.rotation.x = Math.PI / 2;
  loaf.position.set(x + 0.02, top + 0.08, z + 1.15);
  g.add(loaf);
  cyl(g, 0.15, 0.09, 0.07, MAT.ceramic, x + 0.05, top + 0.035, z + 1.36, 16);
  [MAT.apple, MAT.pear, MAT.apple, MAT.pear].forEach((m, i) => sphere(g, 0.04, m, x + 0.02 + (i % 2) * 0.06, top + 0.09, z + 1.31 + Math.floor(i / 2) * 0.08));
  const banana = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 6, 12, Math.PI * 0.8), MAT.banana);
  banana.position.set(x + 0.07, top + 0.1, z + 1.4);
  banana.rotation.x = -Math.PI / 2;
  g.add(banana);
  const sign = textPlane('BREAKFAST', { color: '#303b3e', size: 40 });
  sign.scale.setScalar(1 / sign.geometry.parameters.width);
  sign.position.set(x + depth / 2 + 0.005, top - 0.22, z);
  sign.rotation.y = Math.PI / 2;
  g.add(sign);
}

/** A cafeteria chair (seat, back, four legs) whose sitter faces -z at rotY 0. */
function cafeChair(g: THREE.Group, x: number, z: number, rotY: number) {
  const c = new THREE.Group();
  boxMesh(c, 0.46, 0.05, 0.44, MAT.cushion, 0, 0.47, 0);
  boxMesh(c, 0.44, 0.34, 0.04, SURFACE.wood, 0, 0.72, 0.21);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) boxMesh(c, 0.035, 0.46, 0.035, SURFACE.frame, sx * 0.19, 0.23, sz * 0.18);
  c.position.set(x, 0, z);
  c.rotation.y = rotY;
  // Bake the chair's placement into its parts so all eight chairs batch together with the room.
  c.updateMatrixWorld(true);
  for (const part of [...c.children] as THREE.Mesh[]) {
    part.geometry.applyMatrix4(part.matrixWorld);
    part.position.set(0, 0, 0);
    part.rotation.set(0, 0, 0);
    g.add(part);
  }
}

function cafeteria(g: THREE.Group) {
  const w = CAFETERIA.maxX - CAFETERIA.minX, d = CAFETERIA.maxZ - CAFETERIA.minZ;
  boxMesh(g, w - 0.4, 0.012, d - 0.3, solid('#6d6a60', 0.97), (CAFETERIA.minX + CAFETERIA.maxX) / 2 + 0.2, 0.006, (CAFETERIA.minZ + CAFETERIA.maxZ) / 2).castShadow = false;
  breakfastCounter(g);
  CAFE_TABLES.forEach(([x, z], i) => {
    boxMesh(g, 0.9, 0.04, 0.9, MAT.tableTop, x, 0.74, z);
    cyl(g, 0.04, 0.04, 0.7, SURFACE.frame, x, 0.37, z, 10);
    cyl(g, 0.26, 0.28, 0.03, SURFACE.frame, x, 0.015, z, 18);
    // Set for breakfast: plates, a mug, a juice glass and a small vase.
    for (const [dx, dz] of [[-0.24, 0], [0.24, 0], [0, -0.24], [0, 0.24]] as const) cyl(g, 0.1, 0.09, 0.015, MAT.ceramic, x + dx, 0.768, z + dz, 16);
    cyl(g, 0.04, 0.035, 0.09, MAT.ceramic, x + 0.12, 0.805, z - 0.12, 12);
    cyl(g, 0.03, 0.028, 0.1, MAT.juice, x - 0.12, 0.81, z + 0.12, 10);
    cyl(g, 0.035, 0.03, 0.12, i ? MAT.pear : MAT.copper, x, 0.82, z, 10);
  });
  for (const [x, z, rotY] of CAFE_CHAIRS) cafeChair(g, x, z, rotY);
  // A menu board on the storage wall end, readable from the aisle.
  const board = boxMesh(g, 0.04, 0.7, 0.9, MAT.chalk, -17.35, 1.55, 1.65);
  board.castShadow = false;
  const menu = textPlane('TODAY · oats · eggs · fruit', { color: '#e8e3d4', size: 26 });
  menu.scale.setScalar(0.8 / menu.geometry.parameters.width);
  menu.position.set(-17.325, 1.55, 1.65);
  menu.rotation.y = Math.PI / 2;
  g.add(menu);
  // Warm pendants over the tables.
  for (const [x, z] of CAFE_TABLES) {
    cyl(g, 0.006, 0.006, 1.3, SURFACE.frame, x, 3.55, z, 4);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.18, 18, 1, true), MAT.copper);
    shade.position.set(x, 2.84, z);
    g.add(shade);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), BULB);
    bulb.position.set(x, 2.78, z);
    g.add(bulb);
  }
}

/** An espresso station, grinder, cups, syrups and a pastry case on the existing coffee bar (x -16.2..-13.4, z 8.55..9.15, top 1.06). */
function coffeeUpgrade(g: THREE.Group) {
  const top = 1.06, z = 8.85;
  // Twin-group espresso machine facing the kitchen aisle (south, +z).
  boxMesh(g, 0.62, 0.36, 0.42, MAT.chrome, -15.55, top + 0.18, z - 0.02);
  boxMesh(g, 0.64, 0.05, 0.44, MAT.espresso, -15.55, top + 0.385, z - 0.02);
  for (const dx of [-0.15, 0.15]) {
    cyl(g, 0.035, 0.035, 0.06, MAT.espresso, -15.55 + dx, top + 0.22, z + 0.22, 10);
    rod(g, 0.01, 0.14, MAT.espresso, -15.55 + dx, top + 0.22, z + 0.3, 'z');
    cyl(g, 0.03, 0.025, 0.06, MAT.ceramic, -15.55 + dx, top + 0.035, z + 0.2, 10);
  }
  boxMesh(g, 0.5, 0.02, 0.14, MAT.steel, -15.55, top + 0.01, z + 0.21);
  // Cups warming on top.
  for (let i = 0; i < 6; i++) cyl(g, 0.03, 0.025, 0.05, MAT.ceramic, -15.78 + (i % 3) * 0.1, top + 0.435, z - 0.1 + Math.floor(i / 3) * 0.1, 10);
  // Grinder with a bean hopper.
  boxMesh(g, 0.16, 0.24, 0.2, MAT.espresso, -15.08, top + 0.12, z);
  cyl(g, 0.08, 0.05, 0.16, MAT.glassJar, -15.08, top + 0.32, z, 12);
  cyl(g, 0.07, 0.045, 0.1, MAT.granola, -15.08, top + 0.3, z, 12);
  // Syrup bottles and a milk pitcher.
  for (let i = 0; i < 3; i++) cyl(g, 0.025, 0.028, 0.2, MAT.syrup, -14.82 + i * 0.07, top + 0.1, z - 0.14, 8);
  cyl(g, 0.04, 0.05, 0.1, MAT.steel, -14.8, top + 0.05, z + 0.12, 12);
  // Glass pastry case.
  boxMesh(g, 0.6, 0.03, 0.4, SURFACE.wood, -14.2, top + 0.015, z);
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.07, 3, 8), MAT.croissant);
    c.rotation.set(0, i * 0.6, Math.PI / 2);
    c.position.set(-14.4 + i * 0.13, top + 0.06, z + (i % 2 ? 0.07 : -0.05));
    g.add(c);
  }
  const case_ = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.26, 0.4), SURFACE.glass);
  case_.position.set(-14.2, top + 0.16, z);
  g.add(case_);
  // Stacked takeaway cups and a small chalk menu.
  for (let i = 0; i < 6; i++) cyl(g, 0.045, 0.036, 0.1, solid('#e9e3d6', 0.8), -13.72, top + 0.05 + i * 0.03, z + 0.1, 12);
  const easel = boxMesh(g, 0.3, 0.36, 0.02, MAT.chalk, -13.65, top + 0.2, z - 0.15);
  easel.rotation.x = -0.15;
  const menu = textPlane('ESPRESSO · FLAT WHITE · TEA', { color: '#e8e3d4', size: 22 });
  menu.scale.setScalar(0.26 / menu.geometry.parameters.width);
  menu.position.set(-13.65, top + 0.21, z - 0.137);
  menu.rotation.set(-0.15, 0, 0);
  g.add(menu);
  // Two copper pendants over the bar.
  for (const x of [-15.5, -14.1]) {
    cyl(g, 0.006, 0.006, 1.6, SURFACE.frame, x, 3.4, z, 4);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.2, 18, 1, true), MAT.copper);
    shade.position.set(x, 2.52, z);
    g.add(shade);
  }
  // No extra light: every added light costs every lit material on the floor. Emissive bulbs read as lit.
  for (const x of [-15.5, -14.1]) {
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), BULB);
    bulb.position.set(x, 2.46, z);
    g.add(bulb);
  }
}

/**
 * Gym corner, cafeteria with breakfast counter, and the expanded coffee bar. Walk-blocking
 * footprints come from AMENITY_COLLIDERS (already part of FURNISHING_COLLIDERS). Returns the
 * player interactions; each amenity group carries its own for crosshair picking.
 */
export function buildAmenities(parent: THREE.Group): Interactable[] {
  const out: Interactable[] = [];
  for (const [name, build, kind] of [['Gym', gym, 'gym'], ['Cafeteria', cafeteria, 'cafeteria'], ['Coffee bar', coffeeUpgrade, null]] as const) {
    const g = new THREE.Group();
    g.name = name;
    build(g);
    batchStaticMeshes(g);
    const spot = kind && AMENITY_INTERACTIONS.find((i) => i.kind === kind);
    if (spot) {
      const it: Interactable = { ...spot };
      g.userData.interact = it;
      out.push(it);
    }
    parent.add(g);
  }
  return out;
}
