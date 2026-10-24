import { VehicleRig, type VehicleMotion } from '../vehicle';
import { buildTerrain } from './terrain';
import { slidingDoor } from './doors';
import { entranceAccess, assignedWorkers } from '../navigation';
import { store } from '../state';
import { FLOOR_RISE } from '../../shared/layout';
import { managerAvailable } from '../../shared/empire';
import { managerTyping, typingPose } from '../ui/status';
import { batchStaticMeshes } from './batching';
import * as THREE from 'three';
import { GRAPHICS, type GraphicsQuality } from '../graphics';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { SITES, type EmpireState } from '../../shared/empire';
import { lookFromSeed, type Look } from '../../shared/avatar';
import { ceoAvatar, chiefAvatar, workerAvatar, workerOutfit } from '../../shared/outfit';
import { Person } from './character';
import { textPlane } from './toon';
import { SURFACE as S, boxMesh as box, solid } from './materials';
import { Vegetation } from './vegetation';
import type { Collider } from './office';
import { buildDistricts } from './districts';
import { SKYLINE_TOWERS, skylineColliders } from './district-layout';
export type { Ride } from '../rides';

function sign(parent: THREE.Object3D, text: string, x: number, y: number, z: number, width: number) {
  const m = textPlane(text, { size: 64, color: '#eee9dd' });
  m.position.set(x, y, z);
  m.scale.setScalar(width / m.geometry.parameters.width);
  parent.add(m);
  return m;
}
function seat(g: THREE.Object3D, x: number, z: number) {
  for (let i = 0; i < 5; i++) box(g, 1.8, 0.06, 0.075, S.wood, x, 0.48, z + i * 0.1);
  for (const d of [-0.7, 0.7]) box(g, 0.055, 0.43, 0.5, S.frame, x + d, 0.24, z + 0.2);
  for (let i = 0; i < 3; i++) box(g, 1.8, 0.07, 0.07, S.wood, x, 0.72 + i * 0.12, z + 0.48);
}
function curtain(g: THREE.Group, w: number, h: number, d: number, floors: number, accessible = false) {
  // Set glazing in front of a recessed core: reflections coexist with visible structural depth.
  if (!accessible) box(g, w - 0.7, h, d - 0.7, solid('#303a3a'), 0, h / 2, 0);
  else {
    if (h > 3.3) box(g, w - 0.7, h - 3.3, d - 0.7, solid('#303a3a'), 0, 3.3 + (h - 3.3) / 2, 0);
    box(g, w, 0.14, d, S.stone, 0, 0, 0);
    box(g, w, 0.14, d, S.plaster, 0, 3.2, 0);
    box(g, w, 3.2, 0.16, S.plaster, 0, 1.6, -d / 2 + 0.15);
  }
  for (const face of [-1, 1]) {
    if (accessible && face === 1) {
      box(g, 9.6, 2.95, 0.035, S.glass, -4.2, 1.5, d / 2);
      box(g, 5.2, 2.95, 0.035, S.glass, 6.4, 1.5, d / 2);
      if (h > 3.15) box(g, w, h - 3.15, 0.035, S.glass, 0, 3.15 + (h - 3.15) / 2, d / 2);
    } else box(g, w, h - 0.3, 0.035, S.glass, 0, h / 2, (face * d) / 2);
    for (let x = -w / 2; x <= w / 2 + 0.01; x += 1.5)
      if (!accessible || face !== 1 || x < 0.6 || x > 3.8) box(g, 0.07, h, 0.16, S.frame, x, h / 2, face * (d / 2 + 0.06));
    for (let f = 0; f <= floors; f++) box(g, w + 0.2, 0.15, 0.4, S.stone, 0, 0.12 + (f * h) / floors, (face * d) / 2);
  }
  for (const side of [-1, 1]) {
    box(g, 0.035, h - 0.3, d, S.glass, (side * w) / 2, h / 2, 0);
    for (let z = -d / 2; z <= d / 2 + 0.01; z += 1.5) box(g, 0.16, h, 0.07, S.frame, side * (w / 2 + 0.06), h / 2, z);
    for (let f = 0; f <= floors; f++) box(g, 0.4, 0.15, d + 0.2, S.stone, (side * w) / 2, 0.12 + (f * h) / floors, 0);
  }
  box(g, w + 0.6, 0.22, d + 0.6, S.concrete, 0, h + 0.15, 0);
}
function residence(g: THREE.Group) {
  box(g, 18, 0.16, 13, S.wood, 0, 0.02, 0);
  box(g, 18, 3.6, 0.25, S.concrete, 0, 1.8, -6);
  for (const x of [-9, 9]) box(g, 0.25, 3.6, 12, S.concrete, x, 1.8, 0);
  box(g, 18.5, 0.25, 13.6, S.concrete, 0, 3.72, 0);
  // Split front glazing leaves an actual opening into the residence.
  for (const x of [-5.5, 5.5]) {
    box(g, 7, 3.5, 0.04, S.glass, x, 1.8, 6);
    for (const dx of [-3.5, 0, 3.5]) box(g, 0.065, 3.5, 0.1, S.frame, x + dx, 1.8, 6.08);
  }
  box(g, 18, 0.12, 0.3, S.frame, 0, 3.5, 6.1);
  for (let x = -8.5; x < 9; x += 0.45) box(g, 0.05, 0.08, 2.8, S.wood, x, 3.7, 7.4);
  // Upholstered lounge, low stone table, fitted kitchen and a home workstation.
  box(g, 3.5, 0.45, 1.1, S.fabric, -5, 0.43, -2.5);
  box(g, 3.5, 0.65, 0.23, S.fabric, -5, 0.85, -3);
  for (const x of [-6.65, -3.35]) box(g, 0.25, 0.6, 1.15, S.fabric, x, 0.6, -2.5);
  box(g, 2.1, 0.09, 0.9, S.stone, -5, 0.38, -0.1);
  box(g, 1.6, 0.3, 0.6, S.frame, -5, 0.18, -0.1);
  box(g, 4, 0.85, 0.8, S.wood, 5, 0.42, -5.2);
  box(g, 4, 0.06, 0.85, S.stone, 5, 0.88, -5.2);
  box(g, 2, 0.06, 0.85, S.wood, 5, 0.78, -2.6);
  for (const x of [4.2, 5.8]) box(g, 0.04, 0.75, 0.7, S.frame, x, 0.38, -2.6);
  box(g, 0.85, 0.5, 0.055, S.frame, 5, 1.15, -2.8);
  box(g, 0.77, 0.42, 0.012, solid('#9daeb1'), 5, 1.15, -2.764);
  box(g, 0.05, 0.3, 0.04, S.frame, 5, 0.87, -2.8);
  box(g, 0.32, 0.025, 0.2, S.frame, 5, 0.81, -2.8);
  box(g, 0.6, 0.42, 0.6, S.fabric, 5, 0.24, -1.5);
  box(g, 0.6, 0.55, 0.08, S.fabric, 5, 0.65, -1.22);
  box(g, 2.1, 0.43, 2.3, S.wood, 4, 0.25, 2.7);
  box(g, 2, 0.22, 2.2, solid('#e3e0d8'), 4, 0.57, 2.7);
  box(g, 2, 0.06, 1.6, S.fabric, 4, 0.7, 3);
  box(g, 2.1, 0.8, 0.12, S.wood, 4, 0.8, 1.52);
  sign(g, 'PRIVATE RESIDENCE', -5, 2.8, 6.2, 3);
}
export function buildCity() {
  const group = new THREE.Group();
  group.name = 'Coastal city';
  const colliders: Collider[] = [];
  const siteColliders = new Map<string, Collider>();
  const sectorCollision = new Map<string, { collider: Collider; top: number }[]>();
  const buildings = new Map<string, THREE.Group>();
  const upgrades = new Map<string, THREE.Group[]>();
  const plots = new Map<string, THREE.Group>();
  const doors = new Map<string, ReturnType<typeof slidingDoor>>();
  const staffViews = new Map<string, Person>();
  const foliage = new Vegetation();
  group.add(foliage.group);
  buildTerrain(group, foliage);
  box(group, 15, 0.13, 98, S.road, 0, -0.03, -24);
  box(group, 15, 0.13, 86, S.road, 0, -0.03, 172);
  // Continuous asphalt, raised stone kerbs, measured paving joints and storm drains.
  box(group, 15, 0.13, 112, S.road, 0, -0.03, 77);
  for (const z of [62, 90]) box(group, 107, 0.13, 10, S.road, 0, -0.029, z);
  for (const x of [-9.4, 9.4]) {
    box(group, 3.7, 0.17, 126, S.concrete, x, -0.01, 87);
    box(group, 0.17, 0.24, 126, S.stone, x + Math.sign(x) * -1.8, 0.015, 87);
    for (let z = 26; z < 150; z += 1.5) box(group, 3.6, 0.006, 0.018, solid('#656963'), x, 0.081, z);
  }
  for (const z of [55.7, 68.3, 83.7, 96.3]) box(group, 104, 0.17, 2.3, S.concrete, 0, -0.01, z);
  for (let z = 28; z < 132; z += 4.5)
    if (Math.abs(z - 62) > 6 && Math.abs(z - 90) > 6) box(group, 0.12, 0.009, 2, solid('#d1c8a5'), 0, 0.041, z);
  for (const z of [57, 67, 85, 95]) for (let x = -6; x <= 6; x += 1.8) box(group, 1.1, 0.01, 2, solid('#d5d2bd'), x, 0.043, z);
  for (let z = 34; z < 151; z += 12)
    for (const x of [-10.4, 10.4]) {
      foliage.palm(x + Math.sign(x) * 1.4, z, 7.5 + (z % 3));
      box(group, 0.12, 5, 0.12, S.frame, x, 2.5, z + 4);
      box(group, 1.2, 0.1, 0.14, S.frame, x - Math.sign(x) * 0.5, 5, z + 4);
      box(group, 0.65, 0.025, 0.12, solid('#ece7cc'), x - Math.sign(x) * 0.65, 4.94, z + 4);
      const drain = box(group, 0.4, 0.015, 0.65, S.frame, Math.sign(x) * 7.1, 0.053, z + 3);
      for (let i = 0; i < 7; i++) box(drain, 0.35, 0.01, 0.025, solid('#060a0b'), 0, 0.012, -0.26 + i * 0.085);
      seat(group, x + Math.sign(x) * 1.8, z + 5);
    }
  // Seafront boardwalk: the water plane reflects the actual scene and carries animated normals.
  box(group, 5, 0.23, 125, S.wood, -53, -0.02, 79);
  box(group, 0.35, 0.5, 126, S.concrete, -55.5, -0.15, 79);
  for (let z = 18; z < 144; z += 2.8) box(group, 0.06, 1.1, 0.06, S.frame, -55.3, 0.55, z);
  for (const y of [0.4, 0.8, 1.1]) box(group, 0.045, 0.04, 126, S.frame, -55.3, y, 80);
  const normals = new THREE.TextureLoader().load('/textures/asphalt_02-normal.jpg');
  normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
  const water = new Water(new THREE.PlaneGeometry(1400, 1400), {
    textureWidth: 512,
    textureHeight: 512,
    waterNormals: normals,
    sunDirection: new THREE.Vector3(-0.5, 0.7, 0.4),
    sunColor: 0xffeed4,
    waterColor: 0x1f5962,
    distortionScale: 2.5,
    fog: true,
  });
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, -0.32, 80);
  group.add(water);
  for (let z = 31; z < 126; z += 12) {
    foliage.tree(-48, z, 6.5);
    seat(group, -50, z + 3);
  }
  // Buildings remain tied to the actual construction state.
  for (const site of SITES) {
    const colliderStart = colliders.length;
    const plot = new THREE.Group();
    group.add(plot);
    plots.set(site.id, plot);
    box(plot, 22, 0.08, 18, S.stone, site.x, 0.015, site.z);
    for (const dx of [-10, 10]) box(plot, 0.07, 1.2, 17, S.frame, site.x + dx, 0.6, site.z);
    sign(plot, `${site.name.toUpperCase()} / FUTURE SITE`, site.x, 1.4, site.z + 8, 8);
    const b = new THREE.Group();
    b.position.set(site.x, 0, site.z);
    group.add(b);
    buildings.set(site.id, b);
    const home = site.id === 'home',
      hq = site.id === 'hq',
      hospital = site.id === 'hospital';
    const height = hq ? 11.4 : hospital ? 8 : 4;
    if (home) {
      residence(b);
      const door = slidingDoor(b, 0, 6, 4);
      doors.set(site.id, door);
      door.collider.minX += site.x;
      door.collider.maxX += site.x;
      door.collider.minZ += site.z;
      door.collider.maxZ += site.z;
      colliders.push(door.collider);
      for (const dx of [-9, 9])
        colliders.push({
          minX: site.x + dx - 0.2,
          maxX: site.x + dx + 0.2,
          minZ: site.z - 6,
          maxZ: site.z + 6,
          top: 3.6,
        });
      colliders.push({
        minX: site.x - 9,
        maxX: site.x + 9,
        minZ: site.z - 6.2,
        maxZ: site.z - 5.8,
        top: 3.6,
      });
      for (const dx of [-5.5, 5.5])
        colliders.push({
          minX: site.x + dx - 3.5,
          maxX: site.x + dx + 3.5,
          minZ: site.z + 5.9,
          maxZ: site.z + 6.1,
          top: 3.6,
        });
      colliders.push({
        minX: site.x - 9,
        maxX: site.x + 9,
        minZ: site.z - 6,
        maxZ: site.z + 6,
        bottom: 3.58,
        top: 3.85,
      });
    } else {
      curtain(b, 18, height, 12, hq ? 3 : hospital ? 2 : 1, !hq);
      // Solid vertical service spine and an articulated entrance portico.
      box(b, 3, height + 0.4, 12.6, S.concrete, -6.5, (height + 0.4) / 2, 0);
      box(b, 3, height + 0.4, 0.12, S.wood, -6.5, (height + 0.4) / 2, 6.36);
      for (let x = -7.9; x < -5.1; x += 0.18) box(b, 0.035, height + 0.4, 0.12, S.frame, x, (height + 0.4) / 2, 6.44);
      box(b, 7, 0.18, 3.2, S.frame, 2.2, 3.4, 7.3);
      for (const x of [-1, 5.4]) box(b, 0.13, 3.4, 0.13, S.frame, x, 1.7, 8.8);
      const door = slidingDoor(b, 2.2, 6.4);
      doors.set(site.id, door);
      door.collider.minX += site.x;
      door.collider.maxX += site.x;
      door.collider.minZ += site.z;
      door.collider.maxZ += site.z;
      colliders.push(door.collider);
      if (!hq) {
        for (const x of [-2, 3, 6]) {
          box(b, 2, 0.09, 0.9, S.wood, x, 0.77, -2.8);
          for (const dx of [-0.8, 0.8]) box(b, 0.06, 0.73, 0.7, S.frame, x + dx, 0.37, -2.8);
          box(b, 0.66, 0.42, 0.055, S.frame, x, 1.06, -3);
          box(b, 0.59, 0.35, 0.012, solid('#7e9697'), x, 1.06, -2.965);
          box(b, 0.04, 0.25, 0.04, S.frame, x, 0.86, -3);
          box(b, 0.58, 0.12, 0.58, S.fabric, x, 0.46, -1.9);
          box(b, 0.58, 0.48, 0.08, S.fabric, x, 0.73, -1.63);
        }
        box(b, 3, 0.85, 1, S.wood, -2, 0.42, 2.8);
        sign(b, site.sector.toUpperCase(), 2, 2.4, -5.75, 5);
        const light = new THREE.PointLight('#fff2dc', 35, 14, 2);
        light.position.set(1, 2.9, 0);
        b.add(light);
      }
      sign(b, site.name.toUpperCase(), 2.2, 3.05, 6.4, hq ? 7 : 6);
      if (hospital) {
        box(b, 1.4, 0.35, 0.12, solid('#9a3933'), -6.5, 5.7, 6.52);
        box(b, 0.35, 1.4, 0.12, solid('#9a3933'), -6.5, 5.7, 6.53);
      }
      if (site.id === 'cafe') {
        for (const x of [-3, 1, 5]) {
          box(b, 1.2, 0.055, 1.2, S.wood, x, 0.78, 10);
          box(b, 0.12, 0.75, 0.12, S.frame, x, 0.38, 10);
          seat(b, x, 11.3);
        }
        for (let x = -3.5; x < 6; x += 0.4) box(b, 0.075, 0.12, 4.5, S.wood, x, 3.65, 8.5);
      }
      for (const x of [-3, 3, 6]) {
        box(b, 1.5, 0.65, 2, S.frame, x, height + 0.52, -2);
        for (let z = -2.8; z < -1.2; z += 0.15) box(b, 1.5, 0.04, 0.035, S.stone, x, height + 0.86, z);
      }
      if (site.id === 'utilities')
        for (let i = 0; i < 4; i++) {
          const p = box(b, 3, 0.08, 5, solid('#173042', 0.2, 0.45), -6 + i * 4, height + 0.6, 0);
          p.rotation.x = 0.25;
        }
      if (hq) {
        const c = {
          minX: site.x - 9.2,
          maxX: site.x + 9.2,
          minZ: site.z - 6.3,
          maxZ: site.z + 6.3,
          top: height,
        };
        siteColliders.set(site.id, c);
        colliders.push(c);
      } else {
        for (const dx of [-9, 9])
          colliders.push({
            minX: site.x + dx - 0.15,
            maxX: site.x + dx + 0.15,
            minZ: site.z - 6,
            maxZ: site.z + 6,
            top: height,
          });
        colliders.push({
          minX: site.x - 9,
          maxX: site.x + 9,
          minZ: site.z - 6.2,
          maxZ: site.z - 5.8,
          top: height,
        });
        for (const [a, b] of [
          [-9, 0.6],
          [3.8, 9],
        ])
          colliders.push({
            minX: site.x + a,
            maxX: site.x + b,
            minZ: site.z + 5.9,
            maxZ: site.z + 6.1,
            top: height,
          });
        colliders.push({
          minX: site.x - 9,
          maxX: site.x + 9,
          minZ: site.z - 6,
          maxZ: site.z + 6,
          bottom: 3.1,
          top: height,
        });
        for (const x of [-2, 3, 6])
          colliders.push({
            minX: site.x + x - 1,
            maxX: site.x + x + 1,
            minZ: site.z - 3.3,
            maxZ: site.z - 2.3,
            top: 0.82,
          });
      }
    }
    const improvements = [new THREE.Group(), new THREE.Group()];
    improvements[0].name = 'Level 2 solar upgrade';
    improvements[1].name = 'Level 3 planted terrace';
    if (!home) {
      for (const x of [-2, 2, 6]) {
        const panel = box(improvements[0], 2.4, 0.1, 2.8, solid('#193447', 0.25, 0.45), x, height + 0.7, -3.5);
        panel.rotation.x = 0.2;
        box(improvements[1], 2.1, 0.5, 1.2, S.stone, x, 0.25, 8);
        box(improvements[1], 1.9, 0.7, 1, solid('#425b43'), x, 0.8, 8);
      }
    }
    improvements.forEach((g) => b.add(g));
    upgrades.set(site.id, improvements);
    if (site.id === 'recreation') {
      for (const x of [1, 5]) {
        box(b, 1.2, 0.025, 2, solid('#607b72'), x, 0.1, 1);
        for (const dx of [-0.6, 0.6]) box(b, 0.06, 1.5, 0.06, S.frame, x + dx, 0.75, -0.3);
        box(b, 1.4, 0.06, 0.06, S.frame, x, 1.5, -0.3);
      }
      sign(b, 'WELLNESS / COMMUNITY', 2, 2.4, -5.6, 5);
    }
    box(b, 22, 0.1, 3, S.concrete, 0, 0.015, 8.2);
    for (const dx of [-10, 10]) {
      box(b, 1.3, 0.45, 5, S.concrete, dx, 0.23, 4);
      for (const z of [2.2, 3.5, 4.8]) foliage.shrub(site.x + dx, site.z + z, 0.65);
    }
    foliage.tree(site.x + 10, site.z - 7, 7);
    foliage.tree(site.x - 10, site.z - 7, 6);
    sectorCollision.set(
      site.id,
      colliders.slice(colliderStart).map((collider) => ({ collider, top: collider.top })),
    );
  }
  // Layered urban horizon: setback towers, balconies and glazing, rather than flat silhouettes.
  // FREE-09: the walkable city now reaches z = 215, so the skyline towers are solid (district-layout.ts).
  for (const t of SKYLINE_TOWERS) {
    const b = new THREE.Group();
    b.position.set(t.x, 0, t.z);
    group.add(b);
    curtain(b, 6, t.height, 8, 4 + (t.i % 5));
    for (let f = 1; f < 4; f++) box(b, 7, 0.15, 1.8, S.concrete, 0, f * 3, 4.5);
  }
  colliders.push(...skylineColliders());
  for (const z of [-45, -15, 14, 188])
    for (const x of [-27, 27]) {
      const block = new THREE.Group();
      block.position.set(x, 0, z);
      group.add(block);
      curtain(block, 16, 12 + (Math.abs(z) % 5) * 2, 13, 4);
      box(block, 4, 14, 13.4, S.concrete, -5, 7, 0);
      for (let floor = 1; floor < 4; floor++) box(block, 16.5, 0.2, 2, S.stone, 0, floor * 3.3, 7);
      foliage.tree(x - Math.sign(x) * 11, z + 8, 8);
      if (z > 30) colliders.push({ minX: x - 8, maxX: x + 8, minZ: z - 7, maxZ: z + 8, top: 14 });
    }
  for (let z = -58; z < 26; z += 14) for (const x of [-11, 11]) foliage.palm(x, z, 8);
  for (let z = 30; z < 155; z += 13) {
    foliage.tree(47, z, 8);
  }
  foliage.finish();
  for (const child of group.children) if (child instanceof THREE.Group && child !== foliage.group) batchStaticMeshes(child);
  batchStaticMeshes(group);
  // FREE-09 districts and garage, added after batching: the roller door, plot signs and instanced kits stay separate.
  const districts = buildDistricts(group);
  colliders.push(...districts.colliders);
  // The chief of staff dresses by the CEO's choice (never in the same suit); see shared/outfit.ts.
  const chief = new Person('Chief of staff', '#345f65', lookFromSeed('empire-chief'), { avatar: chiefAvatar(ceoAvatar(store.profile.look.style)) });
  chief.showLabel(false);
  // Seated at the chief of staff's loft desk by ExecutiveBodies (world/executives.ts).
  chief.pose = 'sit';
  chief.root.position.set(8, 0, 9);
  const citizens = Array.from({ length: 8 }, (_, i) => {
    const p = new Person('Resident', '#8c9a9e', lookFromSeed(`citizen-${i}`), { avatar: workerAvatar(`citizen-${i}`) });
    p.showLabel(false);
    group.add(p.root);
    return p;
  });
  const car = new THREE.Group();
  car.name = 'Executive sedan';
  car.position.set(5, 0, 45);
  const carCollider: Collider = {
    minX: 4,
    maxX: 6,
    minZ: 42.6,
    maxZ: 47.4,
    top: 1.55,
  };
  colliders.push(carCollider);
  group.add(car);
  let vehicleRig: VehicleRig | undefined;
  new GLTFLoader().load(
    '/models/executive-sedan.glb',
    (gltf) => {
      const model = gltf.scene.getObjectByName('Executive_Sedan');
      if (!model) return;
      model.removeFromParent();
      model.rotation.y = Math.PI;
      car.add(model);
      vehicleRig = new VehicleRig(model);
      car.userData.ready = true;
      model.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
            if (mat.name === 'Smoked panoramic glass') {
              mat.transparent = true;
              mat.opacity = 0.38;
              mat.depthWrite = false;
              // The glazed shell has outward normals; avoid drawing its tinted back faces
              // over the windshield when the camera is inside the cabin.
              mat.side = THREE.FrontSide;
            }
          }
        }
      });
    },
    undefined,
    (e) => console.warn('Vehicle model unavailable', e),
  );
  const tower = new THREE.Group();
  buildings.get('hq')!.add(tower);
  let towerFloors = -1;
  function growTower(floors: number) {
    if (floors === towerFloors) return;
    towerFloors = floors;
    tower.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    tower.clear();
    const upper = Math.max(8, floors - 2), height = upper * FLOOR_RISE;
    const shaft = new THREE.Group(); shaft.position.y = 11.6; tower.add(shaft);
    curtain(shaft, 14, height, 10, upper);
    for (const side of [-1, 1]) box(shaft, .28, height + 1.8, 10.5, S.stone, side * 7.25, height / 2, 0);
    box(shaft, 15.2, 1.1, 11, S.frame, 0, height + .8, 0);
    box(shaft, .15, 6, .15, S.frame, 0, height + 3.6, 0);
    const occupied = new THREE.MeshStandardMaterial({ color: '#b6c5a5', emissive: '#91ab7d', emissiveIntensity: .4, roughness: .45 });
    for (let f = 0; f < floors; f++) for (const side of [-1, 1]) box(tower, 12, .18, .04, occupied, 0, f * FLOOR_RISE + 2.6, side * 6.13);
    batchStaticMeshes(shaft); batchStaticMeshes(tower);
    const collider = siteColliders.get('hq'); if (collider) collider.top = 12.7 + height;
  }
  const reflectOcean = water.onBeforeRender;
  let crowd = 4;
  return {
    setQuality(quality: GraphicsQuality) {
      const profile = GRAPHICS[quality];
      water.onBeforeRender = profile.reflections ? reflectOcean : () => {};
      crowd = profile.citizens;
      districts.setQuality(quality);
    },
    districts,
    group,
    colliders,
    car,
    carCollider,
    doors,
    animateCar(dt: number, motion: VehicleMotion, running: boolean) { vehicleRig?.update(dt, motion, running); },
    setCarDoor(amount: number) {
      const hinge = car.getObjectByName('Driver_door_hinge');
      if (hinge) hinge.rotation.y = amount * 1.08;
    },
    chief: chief.root,
    /** Re-dresses the chief of staff after the CEO picks a suit. */
    dressChief(look: Look) { chief.setOutfit({ avatar: chiefAvatar(ceoAvatar(look.style)) }); },
    sync(state: EmpireState) {
      growTower(state.office.floors);
      districts.sync(state.city);
      for (const sector of state.sectors) {
        buildings.get(sector.id)!.visible = sector.built;
        plots.get(sector.id)!.visible = !sector.built;
        upgrades.get(sector.id)?.forEach((g, i) => (g.visible = sector.level >= i + 2));
        for (const item of sectorCollision.get(sector.id) ?? []) item.collider.top = sector.built ? item.top : 0;
        const c = siteColliders.get(sector.id);
        if (c) c.top = sector.built ? (sector.id === 'hq' ? 12.7 + Math.max(8, state.office.floors - 2) * FLOOR_RISE : sector.id === 'hospital' ? 8 : 4) : 0;
      }
    },
    update(t: number, dt = 0.016, playerPosition = new THREE.Vector3(), driving = false, facing = 0) {
      const yaw = car.rotation.y,
        halfX = Math.abs(Math.cos(yaw)) * 1.03 + Math.abs(Math.sin(yaw)) * 2.35,
        halfZ = Math.abs(Math.sin(yaw)) * 1.03 + Math.abs(Math.cos(yaw)) * 2.35;
      Object.assign(carCollider, {
        minX: car.position.x - halfX,
        maxX: car.position.x + halfX,
        minZ: car.position.z - halfZ,
        maxZ: car.position.z + halfZ,
        top: driving ? 0 : 1.55,
      });
      foliage.update(t);
      districts.update(dt, playerPosition, car, driving, facing);
      const displayedWorkers = new Set<string>();
      const ev = store.evidence();
      for (const site of SITES) {
        const allowed = entranceAccess(site.id, store.empire, store.workers.values()).allowed;
        const x = site.x + (site.id === 'home' ? 0 : 2.2);
        const near = !driving && Math.abs(playerPosition.x - x) < 2.7 && Math.abs(playerPosition.z - site.z - 6.4) < 3.6;
        const inside = playerPosition.z < site.z + 6.3 && Math.abs(playerPosition.x - site.x) < 8.8;
        doors.get(site.id)?.update(dt, (allowed || inside) && near);
        if (!store.empire.sectors.find((s) => s.id === site.id)?.built) doors.get(site.id)!.collider.top = 0;
        if (site.id === 'hq' || site.id === 'home') continue;
        const sector = store.empire.sectors.find((s) => s.id === site.id)!;
        const assigned = assignedWorkers(site.id, store.workers.values())
          .filter((w) => w.id !== sector.manager?.workerId)
          .map((w) => ({ id: w.id, name: w.name, color: w.color, outfit: workerOutfit(w), typing: typingPose(w, ev.fresh) }));
        if (managerAvailable(sector))
          assigned.unshift({
            id: sector.manager!.id,
            name: sector.manager!.name,
            color: '#567b70',
            outfit: workerOutfit({ id: sector.manager!.id }),
            typing: managerTyping(sector, store.queue.tasks, store.workers, ev),
          });
        assigned.splice(3);
        for (let i = 0; i < assigned.length; i++) {
          const worker = assigned[i];
          displayedWorkers.add(worker.id);
          let person = staffViews.get(worker.id);
          if (!person) {
            person = new Person(worker.name, worker.color, lookFromSeed(worker.id), worker.outfit);
            group.add(person.root);
            staffViews.set(worker.id, person);
          }
          person.setOutfit(worker.outfit);
          person.pose = worker.typing ? 'type' : 'sit';
          person.root.position.set(site.x + [-2, 3, 6][i], 0, site.z - 1.9);
          person.root.rotation.y = Math.PI;
          person.root.visible = allowed;
          person.update(dt, t, false, false);
        }
      }
      for (const [id, person] of staffViews)
        if (!displayedWorkers.has(id)) {
          person.root.removeFromParent();
          person.dispose();
          staffViews.delete(id);
        }
      water.material.uniforms.time.value = t * 0.35;
      chief.update(dt, t, false, false);
      citizens.forEach((p, i) => {
        p.root.visible = i < crowd;
        if (!p.root.visible) return;
        const a = t * 0.022 + (i * Math.PI) / 4,
          side = i % 2 ? 1 : -1;
        const x = side * (9.6 + Math.sin(a) * 0.65),
          z = 77 + Math.cos(a) * 37;
        const dx = side * Math.cos(a) * 0.65 * 0.022,
          dz = -Math.sin(a) * 37 * 0.022;
        p.root.position.set(x, 0, z);
        p.root.rotation.y = Math.atan2(dx, dz);
        p.update(dt, t, true, false, Math.hypot(dx, dz));
      });
    },
  };
}
