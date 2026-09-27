import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SURFACE, boxMesh, solid } from './materials';
import { textPlane } from './toon';
import { batchStaticMeshes } from './batching';
import { BAR_STOOLS, FURNISHING_COLLIDERS, MEETING, MEETING_CHAIRS, RECEPTION, RECEPTION_CHAIR, type Footprint } from './furnishing-layout';

const MAT = {
  laminate: solid('#d7d2c6', 0.55),
  charcoal: solid('#30363a', 0.5, 0.15),
  appliance: solid('#e6e6e1', 0.4, 0.05),
  screen: solid('#0e1316', 0.22, 0.35),
  steel: solid('#b7bcbe', 0.3, 0.8),
  rug: solid('#5d6460', 0.98),
  cushion: solid('#857a67', 0.95),
  paper: solid('#f2f0ea', 0.9),
};

const part = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => geo.translate(x, y, z);
/** One merged geometry per material, so every placed chair is two meshes that batch across the room. */
const chairGeometry = (() => {
  const fabric = mergeGeometries([part(new THREE.BoxGeometry(0.5, 0.08, 0.48), 0, 0.47, 0), part(new THREE.BoxGeometry(0.48, 0.42, 0.06), 0, 0.79, 0.23)])!;
  const frame = mergeGeometries([
    part(new THREE.CylinderGeometry(0.028, 0.028, 0.4, 8), 0, 0.23, 0),
    part(new THREE.CylinderGeometry(0.27, 0.27, 0.03, 16), 0, 0.02, 0),
    part(new THREE.BoxGeometry(0.04, 0.34, 0.04), 0, 0.6, 0.22),
  ])!;
  return { fabric, frame };
})();

/** An office chair whose sitter faces -z at rotY 0 (the same convention as the desks). */
function placeChair(parent: THREE.Object3D, x: number, z: number, rotY: number, fabric: THREE.Material = SURFACE.fabric) {
  for (const [geo, mat] of [[chairGeometry.fabric, fabric], [chairGeometry.frame, SURFACE.frame]] as const) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, 0, z);
    m.rotation.y = rotY;
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
  }
}

function cylinder(parent: THREE.Object3D, rTop: number, rBottom: number, h: number, mat: THREE.Material, x: number, y: number, z: number) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, 12), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  parent.add(m);
  return m;
}

function meetingRoom(g: THREE.Group) {
  const { x, z, length, width } = MEETING;
  boxMesh(g, 5.4, 0.015, 3.6, MAT.rug, x, 0.008, z).castShadow = false;
  boxMesh(g, length, 0.05, width, SURFACE.wood, x, 0.735, z);
  for (const dx of [-1.2, 1.2]) boxMesh(g, 0.08, 0.7, 0.9, SURFACE.frame, x + dx, 0.36, z);
  boxMesh(g, 0.32, 0.02, 0.18, MAT.charcoal, x, 0.77, z);
  for (const [cx, cz, rotY] of MEETING_CHAIRS) placeChair(g, cx, cz, rotY);
  // A wall display with a conferencing bar above a low credenza.
  boxMesh(g, 0.5, 0.7, 2, MAT.laminate, 17.7, 0.35, z);
  boxMesh(g, 0.52, 0.03, 2.02, SURFACE.wood, 17.7, 0.715, z);
  boxMesh(g, 0.05, 1.26, 2.24, MAT.screen, 17.94, 1.55, z);
  boxMesh(g, 0.06, 0.05, 0.4, MAT.charcoal, 17.92, 2.22, z);
  // Under the loft slab: a flush LED panel and one soft fill light.
  const led = new THREE.MeshStandardMaterial({ color: '#fff4e2', emissive: '#fff1dc', emissiveIntensity: 1.6 });
  boxMesh(g, 2.4, 0.03, 0.6, led, x, 2.72, z).castShadow = false;
  const fill = new THREE.PointLight('#fff1dc', 5, 7, 2);
  fill.position.set(x, 2.55, z);
  g.add(fill);
}

function reception(g: THREE.Group) {
  const { x, z, length, depth } = RECEPTION;
  boxMesh(g, depth - 0.1, 1.05, length, MAT.laminate, x, 0.525, z);
  boxMesh(g, depth + 0.1, 0.05, length + 0.1, SURFACE.wood, x, 1.095, z);
  boxMesh(g, 0.02, 0.06, length - 0.1, SURFACE.bronze, x + depth / 2 - 0.04, 0.9, z);
  // The receptionist's lower work surface and monitor face west, away from visitors.
  boxMesh(g, 0.5, 0.04, length - 0.2, SURFACE.wood, x - depth / 2 - 0.2, 0.74, z);
  boxMesh(g, 0.04, 0.33, 0.56, MAT.screen, x - 0.35, 0.99, z);
  boxMesh(g, 0.06, 0.22, 0.06, SURFACE.frame, x - 0.33, 0.87, z);
  boxMesh(g, 0.18, 0.02, 0.45, MAT.charcoal, x - 0.6, 0.77, z);
  placeChair(g, RECEPTION_CHAIR[0], RECEPTION_CHAIR[1], RECEPTION_CHAIR[2], MAT.charcoal);
  const sign = textPlane('RECEPTION', { color: '#303b3e', size: 40 });
  sign.scale.setScalar(1.1 / sign.geometry.parameters.width);
  sign.position.set(x + depth / 2 - 0.035, 0.7, z);
  sign.rotation.y = Math.PI / 2;
  g.add(sign);
  // Low storage under the south window behind reception.
  boxMesh(g, 2.5, 0.7, 0.45, MAT.laminate, -5.15, 0.35, 12.72);
  boxMesh(g, 2.52, 0.03, 0.47, SURFACE.wood, -5.15, 0.715, 12.72);
  for (const dx of [-0.83, 0, 0.83]) boxMesh(g, 0.3, 0.02, 0.02, SURFACE.frame, -5.15 + dx, 0.55, 12.49);
  // Visitor seating facing the counter.
  for (const cz of [9.85, 11.35]) {
    boxMesh(g, 0.8, 0.3, 0.8, MAT.cushion, -7.9, 0.3, cz);
    boxMesh(g, 0.16, 0.5, 0.8, MAT.cushion, -8.22, 0.6, cz);
    for (const s of [-1, 1]) boxMesh(g, 0.7, 0.18, 0.1, MAT.cushion, -7.92, 0.52, cz + s * 0.35);
    for (const sx of [-1, 1]) for (const s of [-1, 1]) boxMesh(g, 0.04, 0.15, 0.04, SURFACE.frame, -7.9 + sx * 0.33, 0.075, cz + s * 0.33);
  }
  cylinder(g, 0.23, 0.23, 0.03, SURFACE.wood, -7.9, 0.505, 10.6);
  cylinder(g, 0.025, 0.025, 0.49, SURFACE.frame, -7.9, 0.25, 10.6);
  cylinder(g, 0.18, 0.18, 0.02, SURFACE.frame, -7.9, 0.01, 10.6);
}

function kitchen(g: THREE.Group) {
  const top = 1.03;
  // Sink, faucet, microwave, kettle, mugs and a fruit bowl on the existing counter (x -17..-12).
  boxMesh(g, 0.55, 0.012, 0.4, MAT.steel, -13.2, top + 0.006, 12.2);
  boxMesh(g, 0.45, 0.014, 0.3, MAT.charcoal, -13.2, top + 0.008, 12.2);
  cylinder(g, 0.02, 0.022, 0.3, MAT.steel, -13.2, top + 0.15, 12.55);
  boxMesh(g, 0.03, 0.03, 0.2, MAT.steel, -13.2, top + 0.29, 12.46);
  boxMesh(g, 0.5, 0.3, 0.38, MAT.appliance, -16.6, top + 0.15, 12.38);
  boxMesh(g, 0.32, 0.2, 0.01, MAT.screen, -16.66, top + 0.15, 12.185);
  cylinder(g, 0.08, 0.095, 0.22, MAT.steel, -14.8, top + 0.11, 12.35);
  for (const dx of [0, 0.14]) cylinder(g, 0.04, 0.035, 0.1, MAT.appliance, -15.15 + dx, top + 0.05, 11.95);
  cylinder(g, 0.17, 0.1, 0.08, SURFACE.wood, -13.95, top + 0.04, 12.3);
  ['#c9a24a', '#b8563f', '#8aa04e'].forEach((c, i) => {
    const fruit = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), solid(c, 0.55));
    fruit.position.set(-13.99 + i * 0.05, top + 0.1, 12.28 + (i % 2) * 0.05);
    g.add(fruit);
  });
  // Standing coffee bar with stools, north of the counter so the coffee machine stays reachable.
  boxMesh(g, 2.8, 0.05, 0.6, SURFACE.wood, -14.8, 1.035, 8.85);
  for (const dx of [-1.25, 1.25]) boxMesh(g, 0.06, 1.01, 0.5, SURFACE.frame, -14.8 + dx, 0.505, 8.85);
  boxMesh(g, 2.5, 0.03, 0.03, SURFACE.frame, -14.8, 0.3, 8.62);
  for (const [sx, sz] of BAR_STOOLS) {
    cylinder(g, 0.19, 0.19, 0.05, MAT.charcoal, sx, 0.76, sz);
    cylinder(g, 0.025, 0.025, 0.72, SURFACE.frame, sx, 0.37, sz);
    cylinder(g, 0.2, 0.2, 0.02, SURFACE.frame, sx, 0.01, sz);
  }
  // Recycling and waste bins beside the fridge.
  for (const [dx, c] of [[-0.21, '#4f6f63'], [0.21, '#3b4144']] as const) {
    boxMesh(g, 0.36, 0.6, 0.36, solid(c, 0.6), -10.1 + dx, 0.3, 12.55);
    boxMesh(g, 0.37, 0.02, 0.37, MAT.charcoal, -10.1 + dx, 0.61, 12.55);
  }
}

function storageAndPrint(g: THREE.Group) {
  // Full-height storage on the solid west wall between two windows.
  boxMesh(g, 0.45, 2.1, 2.6, MAT.laminate, -17.62, 1.05, 0);
  for (const dz of [-0.65, 0, 0.65]) boxMesh(g, 0.012, 2.02, 0.012, MAT.charcoal, -17.39, 1.05, dz);
  for (const dz of [-0.95, -0.35, 0.35, 0.95]) boxMesh(g, 0.02, 0.26, 0.02, SURFACE.frame, -17.38, 1.05, dz + (dz < 0 ? 0.25 : -0.25));
  // Copy corner by the elevator, clear of the pull-request board approach.
  boxMesh(g, 0.62, 0.45, 0.55, MAT.charcoal, 2.6, 0.225, -12.5);
  boxMesh(g, 0.6, 0.5, 0.52, MAT.appliance, 2.6, 0.7, -12.5);
  boxMesh(g, 0.6, 0.05, 0.5, MAT.charcoal, 2.6, 0.975, -12.5);
  boxMesh(g, 0.38, 0.02, 0.24, MAT.charcoal, 2.6, 0.82, -12.17);
  boxMesh(g, 0.22, 0.02, 0.3, MAT.paper, 2.6, 0.835, -12.2);
  boxMesh(g, 0.16, 0.08, 0.02, MAT.screen, 2.78, 0.93, -12.23);
  boxMesh(g, 0.9, 0.9, 0.42, MAT.laminate, 3.55, 0.45, -12.62);
  boxMesh(g, 0.92, 0.03, 0.44, SURFACE.wood, 3.55, 0.915, -12.62);
  for (const dx of [-0.2, 0.2]) boxMesh(g, 0.3, 0.2, 0.25, MAT.paper, 3.55 + dx, 1.03, -12.62);
}

/** Adds the meeting area, reception, kitchen details, storage and print corner. Returns walk-blocking footprints. */
export function furnishOffice(parent: THREE.Group): Footprint[] {
  const g = new THREE.Group();
  g.name = 'Office furnishing';
  meetingRoom(g);
  reception(g);
  kitchen(g);
  storageAndPrint(g);
  // Its meshes are direct children of this subgroup, so merge them here rather than relying on the caller's traversal.
  batchStaticMeshes(g);
  parent.add(g);
  return FURNISHING_COLLIDERS.map((c) => ({ ...c }));
}

const pedestal = mergeGeometries([part(new THREE.BoxGeometry(0.42, 0.58, 0.52), 0, 0.3, 0)])!;
/** Everyday items that make a workstation look used: a drawer pedestal, notebook and pen, and some water bottles. */
export function deskAccessories(desk: THREE.Group, index: number, height: number) {
  const ped = new THREE.Mesh(pedestal, MAT.laminate);
  ped.position.set(-0.72, 0, -0.12);
  ped.castShadow = ped.receiveShadow = true;
  desk.add(ped);
  const notebook = boxMesh(desk, 0.21, 0.012, 0.29, index % 2 ? MAT.charcoal : solid('#6f7f78', 0.8), 0.62, height + 0.006, 0.22);
  notebook.rotation.y = 0.12 + (index % 3) * 0.1;
  const pen = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.14, 6), SURFACE.frame);
  pen.position.set(0.76, height + 0.018, 0.22);
  pen.rotation.set(0, 0.2, Math.PI / 2);
  desk.add(pen);
  if (index % 2 === 0) cylinder(desk, 0.034, 0.034, 0.22, solid('#6d8f9a', 0.3, 0.1), 0.95, height + 0.11, 0.12);
}
