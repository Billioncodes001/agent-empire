import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { guardHumanMaterials, missingHumanTextures, repairHumanMaterials } from '../src/client/world/human';

/** A rig shaped like the shipped GLBs: body and head with glTF's default metallicFactor 1. */
function rig(textured: boolean) {
  const root = new THREE.Group();
  for (const name of ['body', 'head']) {
    const mat = new THREE.MeshStandardMaterial({ name, metalness: 1, roughness: 1 });
    if (textured) {
      const image = { width: 4, height: 4 };
      mat.map = Object.assign(new THREE.Texture(image), { name: `${name}_color` });
      mat.metalnessMap = mat.roughnessMap = Object.assign(new THREE.Texture(image), { name: `${name}_orm` });
      mat.normalMap = new THREE.Texture(image);
    }
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
  }
  return root;
}
const materials = (root: THREE.Object3D) => root.children.map((m) => (m as THREE.Mesh).material as THREE.MeshStandardMaterial);

test('a rig whose textures failed is reported and never left fully metallic (black without sky lighting)', () => {
  const failed = rig(false);
  assert.deepEqual(missingHumanTextures(failed), ['body', 'head']);
  guardHumanMaterials(failed);
  for (const m of materials(failed)) {
    assert.equal(m.metalness, 0, `${m.name} is dielectric`);
    assert.ok(m.color.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace).l > 0.4, `${m.name} has a visible fallback tone`);
  }
});

test('a fully textured rig is untouched', () => {
  const good = rig(true);
  assert.deepEqual(missingHumanTextures(good), []);
  guardHumanMaterials(good);
  for (const m of materials(good)) {
    assert.equal(m.metalness, 1, 'the ORM texture still scales metalness');
    assert.equal(m.color.getHex(), 0xffffff);
  }
});

test('a later successful load repairs the shared materials in place, so bodies already shown update', () => {
  const source = rig(false);
  guardHumanMaterials(source);
  const shown = clone(source); // the player already in the scene shares the source materials
  const versions = materials(source).map((m) => m.version);
  const fresh = rig(true);
  assert.equal(repairHumanMaterials(source, fresh), 2);
  assert.deepEqual(missingHumanTextures(source), []);
  assert.deepEqual(missingHumanTextures(shown), [], 'the clone sees the repaired textures');
  materials(source).forEach((m, i) => {
    assert.equal(m.map, materials(fresh)[i].map);
    assert.equal(m.metalnessMap, materials(fresh)[i].metalnessMap);
    assert.equal(m.metalness, 1);
    assert.equal(m.color.getHex(), 0xffffff, 'fallback tone removed');
    assert.ok(m.version > versions[i], 'needsUpdate set so the shader program is rebuilt with the maps');
  });
});

test('a reload that also failed does not overwrite the fallback', () => {
  const source = rig(false);
  guardHumanMaterials(source);
  assert.equal(repairHumanMaterials(source, rig(false)), 0);
  assert.deepEqual(missingHumanTextures(source), ['body', 'head']);
  assert.equal(materials(source)[0].metalness, 0);
});
