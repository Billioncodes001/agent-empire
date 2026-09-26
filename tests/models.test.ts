import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { prepareHumanModel } from '../src/client/world/human';

// Exercise the actual shipped meshes/rigs on the CPU; texture decode requires a browser.
async function geometryAsset(name: string) {
  const bytes = await readFile(new URL(`../src/client/public/models/${name}`, import.meta.url));
  const length = bytes.readUInt32LE(12),
    data = JSON.parse(bytes.subarray(20, 20 + length).toString());
  data.buffers[0].uri = `data:application/octet-stream;base64,${bytes.subarray(28 + length).toString('base64')}`;
  delete data.images;
  delete data.textures;
  data.materials = [];
  for (const mesh of data.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  globalThis.ProgressEvent ??= class ProgressEvent {
    constructor(_type: string, data: object) {
      Object.assign(this, data);
    }
  } as typeof globalThis.ProgressEvent;
  return new GLTFLoader().parseAsync(JSON.stringify(data), '');
}
function bounds(model: THREE.Object3D) {
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) {
      o.skeleton.update();
      o.computeBoundingBox();
    }
  });
  return new THREE.Box3().setFromObject(model);
}
for (const name of ['founder.glb', 'chief-of-staff.glb'])
  test(`${name}: animation stays at adult scale and clones have independent bones`, async () => {
    const gltf = await geometryAsset(name),
      one = clone(gltf.scene),
      two = clone(gltf.scene);
    const mixer = prepareHumanModel(one, gltf.animations);
    prepareHumanModel(two, gltf.animations);
    for (let frame = 0; frame < 120; frame++) mixer.update(1 / 60);
    const box = bounds(one),
      size = box.getSize(new THREE.Vector3());
    assert.ok(size.y > 1.65 && size.y < 1.95, `animated height ${size.y}`);
    assert.ok(Math.abs(box.min.y) < 0.1, `feet at ${box.min.y}`);
    assert.ok(size.x < 1 && size.z < 1, `human proportions ${size.toArray()}`);
    const a = one.getObjectByName('Bip01_L_Thigh'),
      b = two.getObjectByName('Bip01_L_Thigh');
    assert.ok(a && b);
    assert.notEqual(a, b);
    const saved = b.quaternion.clone();
    a.rotateX(0.5);
    assert.ok(b.quaternion.equals(saved));
  });
test('sedan export contains a standalone vehicle at road scale', async () => {
  const gltf = await geometryAsset('executive-sedan.glb');
  const car = gltf.scene.getObjectByName('Executive_Sedan');
  assert.ok(car);
  const size = bounds(car).getSize(new THREE.Vector3());
  assert.ok(size.x > 1.8 && size.x < 2.4);
  assert.ok(size.y > 1.3 && size.y < 1.9);
  assert.ok(size.z > 4 && size.z < 5.2);
  assert.equal(car.getObjectByName('Preview_ground'), undefined);
});
