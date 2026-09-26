import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Merge stationary siblings that share a material without crossing visibility/state boundaries. */
export function batchStaticMeshes(group: THREE.Group) {
  group.updateMatrixWorld(true);
  const batches = new Map<THREE.Material, THREE.Mesh[]>();
  for (const child of [...group.children]) {
    if (
      !(child instanceof THREE.Mesh) ||
      child instanceof THREE.InstancedMesh ||
      child instanceof THREE.SkinnedMesh ||
      child.children.length ||
      Array.isArray(child.material) ||
      child.material instanceof THREE.ShaderMaterial
    )
      continue;
    if (child.material.transparent) continue;
    const items = batches.get(child.material) ?? [];
    items.push(child);
    batches.set(child.material, items);
  }
  for (const [material, items] of batches) {
    if (items.length < 3) continue;
    const geometries = items.map((m) => {
      m.updateMatrix();
      return m.geometry.clone().applyMatrix4(m.matrix);
    });
    const merged = mergeGeometries(geometries, false);
    for (const geo of geometries) geo.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = items.some((m) => m.castShadow);
    mesh.receiveShadow = true;
    mesh.name = 'Batched architecture';
    group.add(mesh);
    for (const item of items) {
      group.remove(item);
      item.geometry.dispose();
    }
  }
}
