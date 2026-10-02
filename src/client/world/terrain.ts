import * as THREE from 'three';
import { SURFACE as S, boxMesh as box, solid } from './materials';
import type { Vegetation } from './vegetation';

/** Finite coastal ground, beach banks, civic gardens and perimeter streets. */
export function buildTerrain(group: THREE.Group, foliage: Vegetation) {
  const geo = new THREE.PlaneGeometry(210, 330, 105, 165);
  geo.rotateX(-Math.PI / 2);
  geo.translate(40, 0, 70);
  const p = geo.attributes.position,
    colors = [];
  const grass = new THREE.Color('#798165'),
    sand = new THREE.Color('#b0a487');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      z = p.getZ(i);
    const edge = Math.min(x + 61, 145 - x, z + 95, 235 - z);
    const bank = THREE.MathUtils.smoothstep(edge, 0, 12);
    const relief = x > 75 ? Math.sin((x - 75) * 0.037) * Math.sin((z + 40) * 0.018) * 5 : 0;
    p.setY(i, -1.3 + bank * 1.27 + Math.max(0, relief));
    const noise = (Math.sin(x * 1.71 + z * 0.83) * Math.cos(z * 2.43 - x * 0.38) + 1) * 0.035;
    const c = sand
      .clone()
      .lerp(grass, bank)
      .multiplyScalar(0.94 + noise);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const landMat = S.stone.clone();
  landMat.vertexColors = true;
  landMat.color.set('#ffffff');
  landMat.roughness = 1;
  const terrain = new THREE.Mesh(geo, landMat);
  terrain.receiveShadow = true;
  group.add(terrain);
  // Perimeter roads connect the six blocks and enclose the managed district.
  for (const z of [25, 118, 146, 208]) {
    box(group, 106, 0.14, 8, S.road, 0, -0.045, z);
    for (const dz of [-5.3, 5.3]) box(group, 106, 0.16, 2.4, S.concrete, 0, -0.015, z + dz);
    for (let x = -48; x < 49; x += 5) box(group, 2, 0.01, 0.1, solid('#cec8ad'), x, 0.03, z);
  }
  for (const x of [-43, 43]) {
    box(group, 7, 0.13, 98, S.road, x, -0.035, 75);
    for (const dx of [-4.6, 4.6]) box(group, 2, 0.15, 98, S.concrete, x + dx, -0.01, 75);
  }
  // Planting beds break up the space between blocks; paths remain continuous.
  for (const z of [39, 75, 105, 135, 196])
    for (const x of [-39, 38, 60]) {
      if (Math.abs(x) < 40 && z > 45 && z < 118) continue;
      box(group, 8, 0.18, 12, S.stone, x, -0.08, z);
      box(group, 7.5, 0.1, 11.5, solid('#4d5645'), x, 0.03, z);
      for (let i = 0; i < 4; i++) foliage.shrub(x - 2 + i * 1.35, z + 3 * Math.sin(i * 2.5), 0.7);
    }
  // Greenbelt has physical depth, footpaths and tree canopy instead of a flat green backdrop.
  for (let z = -65; z < 224; z += 13) {
    foliage.tree(70 + 6 * Math.sin(z), z, 7 + ((z % 4) + 4));
    foliage.tree(89 + 9 * Math.cos(z * 0.4), z + 5, 9);
    if (z < 20 || z > 148) foliage.tree(-47, z, 7);
  }
  const path = box(group, 3, 0.07, 280, S.stone, 61, -0.04, 75);
  path.name = 'Greenbelt walking path';
  for (let z = 35; z < 124; z += 14) {
    // Curbside parking stalls on the east side of the avenue.
    for (const side of [-1, 1]) box(group, 2.4, 0.009, 0.085, solid('#c6c4ad'), side * 5.9, 0.043, z);
  }
  // Low coastal rock outcrops create a readable shoreline at every zoom level.
  const rocks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), solid('#827e70'), 100);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 100; i++) {
    const side = i < 55;
    const z = side ? -81 + i * 5.7 : 222 + 3 * Math.sin(i);
    dummy.position.set(side ? -59 - 2 * Math.sin(i) : -50 + (i - 55) * 4.4, -0.15, z);
    dummy.rotation.set(i * 0.61, i * 0.24, i * 0.1);
    dummy.scale.set(1.6 + (i % 3) * 0.4, 0.65 + (i % 4) * 0.2, 1.3);
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
  }
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  group.add(rocks);
}
