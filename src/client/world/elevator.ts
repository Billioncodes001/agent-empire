import * as THREE from 'three';
import { boxMesh as box, SURFACE as S } from './materials';
import { textPlane } from './toon';
import type { Collider } from './office';

import { LIFT } from '../../shared/layout';
/** Brushed steel cab, illuminated ceiling and mechanically sliding opaque door leaves. */
export function buildElevator() {
  const group = new THREE.Group();
  group.position.set(LIFT.x, 0, LIFT.z);
  const steel = new THREE.MeshStandardMaterial({ color: '#929d9f', metalness: .78, roughness: .3 });
  const doors = new THREE.Group(); group.add(doors);
  box(group, 3.4, .12, 3.2, S.stone, 0, .02, 0);
  box(group, 3.4, .16, 3.2, S.frame, 0, 3, 0);
  box(group, 2.5, .025, 2.3, new THREE.MeshStandardMaterial({ color: '#ebeee6', emissive: '#e4eed9', emissiveIntensity: 1 }), 0, 2.91, 0);
  box(group, 3.4, 3, .12, steel, 0, 1.5, -1.55);
  for (const side of [-1, 1]) {
    box(group, .12, 3, 3.2, steel, side * 1.65, 1.5, 0);
    box(group, .055, .055, 2.5, S.bronze, side * 1.55, 1, -.1);
    box(group, 1.5, 3.1, .18, S.stone, side * 2.04, 1.5, 1.74);
  }
  box(group, 2.9, .055, .055, S.bronze, 0, 1, -1.43);
  const leaves = [-1, 1].map(side => {
    const leaf = new THREE.Group(); doors.add(leaf);
    box(leaf, 1.27, 2.72, .09, steel, 0, 1.37, 1.55);
    box(leaf, .018, 2.68, .01, S.frame, side * -.61, 1.37, 1.61);
    return leaf;
  });
  box(group, .20, .45, .035, S.frame, 1.91, 1.25, 1.6);
  box(group, .07, .07, .04, S.bronze, 1.91, 1.3, 1.64);
  let sign: ReturnType<typeof textPlane>;
  let displayedFloor = -1;
  const setFloor = (floor: number) => {
    if (displayedFloor === floor) return;
    displayedFloor = floor;
    if (sign) { group.remove(sign); sign.geometry.dispose(); sign.material.map?.dispose(); sign.material.dispose(); }
    sign = textPlane(`LEVEL ${String(floor + 1).padStart(2, '0')}`, { color: '#d2e4da', size: 40 });
    sign.scale.setScalar(.34); sign.position.set(0, 2.84, 1.65); group.add(sign);
  };
  setFloor(0);
  const collider: Collider = { minX: 5.72, maxX: 8.28, minZ: -7.3, maxZ: -7.08, top: 2.75 };
  const colliders: Collider[] = [collider,
    { minX: 4.21, maxX: 5.72, minZ: -7.14, maxZ: -6.85, top: 3.1 },
    { minX: 8.28, maxX: 9.79, minZ: -7.14, maxZ: -6.85, top: 3.1 },
    { minX: 5.28, maxX: 5.52, minZ: -10.3, maxZ: -7.08, top: 3 },
    { minX: 8.48, maxX: 8.72, minZ: -10.3, maxZ: -7.08, top: 3 },
    { minX: 5.28, maxX: 8.72, minZ: -10.34, maxZ: -10.14, top: 3 },
  ];
  let opening = 0;
  return { group, colliders, setFloor, update(dt: number, open: boolean, elevation: number) {
    opening = THREE.MathUtils.damp(opening, open ? 1 : 0, 6, dt);
    leaves.forEach((leaf, i) => { leaf.position.x = (i ? 1 : -1) * (.635 + opening * 1.23); });
    collider.bottom = elevation; collider.top = elevation + (opening > .85 ? 0 : 2.75);
  } };
}
