import { batchStaticMeshes } from './batching';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { SITES, type EmpireState } from '../../shared/empire';
import { lookFromSeed } from '../../shared/avatar';
import { Person } from './character';
import { textPlane } from './toon';
import { SURFACE as S, boxMesh as box, solid } from './materials';
import { Vegetation } from './vegetation';
import type { Collider } from './office';

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
function curtain(g: THREE.Group, w: number, h: number, d: number, floors: number) {
  // Set glazing in front of a recessed core: reflections coexist with visible structural depth.
  box(g, w - 0.7, h, d - 0.7, solid('#303a3a'), 0, h / 2, 0);
  for (const face of [-1, 1]) {
    box(g, w, h - 0.3, 0.035, S.glass, 0, h / 2, (face * d) / 2);
    for (let x = -w / 2; x <= w / 2 + 0.01; x += 1.5) box(g, 0.07, h, 0.16, S.frame, x, h / 2, face * (d / 2 + 0.06));
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
  const buildings = new Map<string, THREE.Group>();
  const plots = new Map<string, THREE.Group>();
  const foliage = new Vegetation();
  group.add(foliage.group);
  box(group, 2000, 0.2, 2000, solid('#697458'), 944, -0.22, 80);
  box(group, 15, 0.13, 130, S.road, 0, -0.03, -40);
  box(group, 15, 0.13, 210, S.road, 0, -0.03, 238);
  // Continuous asphalt, raised stone kerbs, measured paving joints and storm drains.
  box(group, 15, 0.13, 112, S.road, 0, -0.03, 77);
  for (const z of [62, 90]) box(group, 107, 0.13, 10, S.road, 0, -0.029, z);
  for (const x of [-9.4, 9.4]) {
    box(group, 3.7, 0.17, 106, S.concrete, x, -0.01, 77);
    box(group, 0.17, 0.24, 106, S.stone, x + Math.sign(x) * -1.8, 0.015, 77);
    for (let z = 26; z < 130; z += 1.5) box(group, 3.6, 0.006, 0.018, solid('#656963'), x, 0.081, z);
  }
  for (const z of [55.7, 68.3, 83.7, 96.3]) box(group, 104, 0.17, 2.3, S.concrete, 0, -0.01, z);
  for (let z = 28; z < 132; z += 4.5)
    if (Math.abs(z - 62) > 6 && Math.abs(z - 90) > 6) box(group, 0.12, 0.009, 2, solid('#d1c8a5'), 0, 0.041, z);
  for (const z of [57, 67, 85, 95]) for (let x = -6; x <= 6; x += 1.8) box(group, 1.1, 0.01, 2, solid('#d5d2bd'), x, 0.043, z);
  for (let z = 34; z < 127; z += 12)
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
  water.position.set(-757, -0.32, 80);
  group.add(water);
  for (let z = 31; z < 126; z += 12) {
    foliage.tree(-48, z, 6.5);
    seat(group, -50, z + 3);
  }
  // Buildings remain tied to the actual construction state.
  for (const site of SITES) {
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
      for (const dx of [-9, 9])
        colliders.push({ minX: site.x + dx - 0.2, maxX: site.x + dx + 0.2, minZ: site.z - 6, maxZ: site.z + 6, top: 3.6 });
      colliders.push({ minX: site.x - 9, maxX: site.x + 9, minZ: site.z - 6.2, maxZ: site.z - 5.8, top: 3.6 });
      for (const dx of [-5.5, 5.5])
        colliders.push({ minX: site.x + dx - 3.5, maxX: site.x + dx + 3.5, minZ: site.z + 5.9, maxZ: site.z + 6.1, top: 3.6 });
      colliders.push({ minX: site.x - 9, maxX: site.x + 9, minZ: site.z - 6, maxZ: site.z + 6, bottom: 3.58, top: 3.85 });
    } else {
      curtain(b, 18, height, 12, hq ? 3 : hospital ? 2 : 1);
      // Solid vertical service spine and an articulated entrance portico.
      box(b, 3, height + 0.4, 12.6, S.concrete, -6.5, (height + 0.4) / 2, 0);
      box(b, 3, height + 0.4, 0.12, S.wood, -6.5, (height + 0.4) / 2, 6.36);
      for (let x = -7.9; x < -5.1; x += 0.18) box(b, 0.035, height + 0.4, 0.12, S.frame, x, (height + 0.4) / 2, 6.44);
      box(b, 7, 0.18, 3.2, S.frame, 2.2, 3.4, 7.3);
      for (const x of [-1, 5.4]) box(b, 0.13, 3.4, 0.13, S.frame, x, 1.7, 8.8);
      box(b, 3.2, 2.8, 0.06, S.glass, 2.2, 1.4, 6.2);
      for (const x of [0.6, 2.2, 3.8]) box(b, 0.06, 2.8, 0.1, S.frame, x, 1.4, 6.25);
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
      const c = { minX: site.x - 9.2, maxX: site.x + 9.2, minZ: site.z - 6.3, maxZ: site.z + 6.3, top: height };
      siteColliders.set(site.id, c);
      colliders.push(c);
    }
    box(b, 22, 0.1, 3, S.concrete, 0, 0.015, 8.2);
    for (const dx of [-10, 10]) {
      box(b, 1.3, 0.45, 5, S.concrete, dx, 0.23, 4);
      for (const z of [2.2, 3.5, 4.8]) foliage.shrub(site.x + dx, site.z + z, 0.65);
    }
    foliage.tree(site.x + 10, site.z - 7, 7);
    foliage.tree(site.x - 10, site.z - 7, 6);
  }
  // Layered urban horizon: setback towers, balconies and glazing, rather than flat silhouettes.
  for (let i = 0; i < 13; i++) {
    const b = new THREE.Group();
    b.position.set(-43 + i * 8.5, 0, 152 + (i % 3) * 17);
    group.add(b);
    curtain(b, 6, 12 + (i % 5) * 4.5, 8, 4 + (i % 5));
    for (let f = 1; f < 4; f++) box(b, 7, 0.15, 1.8, S.concrete, 0, f * 3, 4.5);
  }
  for (const z of [-45, -15, 14, 188])
    for (const x of [-27, 27]) {
      const block = new THREE.Group();
      block.position.set(x, 0, z);
      group.add(block);
      curtain(block, 16, 12 + (Math.abs(z) % 5) * 2, 13, 4);
      box(block, 4, 14, 13.4, S.concrete, -5, 7, 0);
      for (let floor = 1; floor < 4; floor++) box(block, 16.5, 0.2, 2, S.stone, 0, floor * 3.3, 7);
      foliage.tree(x - Math.sign(x) * 11, z + 8, 8);
    }
  for (let z = -58; z < 26; z += 14) for (const x of [-11, 11]) foliage.palm(x, z, 8);
  for (let z = 30; z < 155; z += 13) {
    foliage.tree(47, z, 8);
    foliage.tree(62, z + 5, 10);
  }
  foliage.finish();
  for (const child of group.children) if (child instanceof THREE.Group && child !== foliage.group) batchStaticMeshes(child);
  batchStaticMeshes(group);
  const chief = new Person('Chief of staff', '#345f65', lookFromSeed('empire-chief'));
  chief.showLabel(false);
  const citizens = Array.from({ length: 8 }, (_, i) => {
    const p = new Person('Resident', '#8c9a9e', { ...lookFromSeed(`citizen-${i}`), style: i % 2 });
    p.showLabel(false);
    group.add(p.root);
    return p;
  });
  const car = new THREE.Group();
  car.name = 'Executive sedan';
  car.position.set(5, 0, 45);
  group.add(car);
  new GLTFLoader().load(
    '/models/executive-sedan.glb',
    (gltf) => {
      const model = gltf.scene.getObjectByName('Executive_Sedan');
      if (!model) return;
      model.removeFromParent();
      model.rotation.y = Math.PI;
      car.add(model);
      car.userData.ready = true;
      model.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
    },
    undefined,
    (e) => console.warn('Vehicle model unavailable', e),
  );
  return {
    group,
    colliders,
    car,
    chief: chief.root,
    sync(state: EmpireState) {
      for (const sector of state.sectors) {
        buildings.get(sector.id)!.visible = sector.built;
        plots.get(sector.id)!.visible = !sector.built;
        const c = siteColliders.get(sector.id);
        if (c) c.top = sector.built ? (sector.id === 'hq' ? 11.4 : sector.id === 'hospital' ? 8 : 4) : 0;
      }
    },
    update(t: number, delegated: boolean, dt = 0.016) {
      foliage.update(t);
      water.material.uniforms.time.value = t * 0.35;
      chief.root.position.set(delegated ? 5 : 8, 0, 9);
      chief.update(dt, t, false, false);
      citizens.forEach((p, i) => {
        const phase = (t * 0.85 + i * 11) % 160;
        const z = phase < 80 ? 35 + phase : 195 - phase;
        p.root.position.set(i % 2 ? 9.4 : -9.4, 0, z);
        p.root.rotation.y = phase < 80 ? 0 : Math.PI;
        p.update(dt, t, true, false);
      });
    },
  };
}
