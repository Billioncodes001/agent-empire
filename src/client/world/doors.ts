import * as THREE from 'three';
import { SURFACE as S, boxMesh as box } from './materials';
import type { Collider } from './office';

/** Two independently sliding glass leaves, with collision matching their opening. */
export function slidingDoor(parent: THREE.Object3D, x: number, z: number, width = 3.2) {
  const frame = new THREE.Group();
  frame.position.set(x, 0, z);
  parent.add(frame);
  const leaves = [-1, 1].map((side) => {
    const leaf = new THREE.Group();
    leaf.position.x = (side * width) / 4;
    box(leaf, width / 2 - 0.05, 2.8, 0.055, S.glass, 0, 1.4, 0);
    for (const dx of [-width / 4, width / 4]) box(leaf, 0.045, 2.8, 0.09, S.frame, dx, 1.4, 0);
    for (const y of [0.04, 2.76]) box(leaf, width / 2, 0.06, 0.09, S.frame, 0, y, 0);
    box(leaf, 0.04, 0.45, 0.09, S.bronze, -side * (width / 4 - 0.12), 1.3, 0.07);
    frame.add(leaf);
    return leaf;
  });
  box(frame, width * 2, 0.12, 0.22, S.frame, 0, 2.89, 0);
  let amount = 0;
  const collider: Collider = { minX: x - width / 2, maxX: x + width / 2, minZ: z - 0.12, maxZ: z + 0.12, top: 2.8 };
  return {
    frame,
    collider,
    update(dt: number, open: boolean) {
      amount = THREE.MathUtils.damp(amount, open ? 1 : 0, 7, dt);
      leaves.forEach((leaf, i) => (leaf.position.x = (i ? 1 : -1) * (width / 4 + amount * width * 0.49)));
      collider.top = amount > 0.72 ? 0 : 2.8;
    },
  };
}
