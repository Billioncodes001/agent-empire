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
  model.updateWorldMatrix(true, true);
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
for (const name of ['founder.glb', 'chief-of-staff.glb'])
  test(`${name}: recorded locomotion and sit clips have finite grounded poses`, async () => {
    const gltf = await geometryAsset(name),
      model = clone(gltf.scene),
      mixer = prepareHumanModel(model, gltf.animations);
    for (const clipName of ['walk_neutral', 'run_neutral', 'sit_chair_idle_neutral_01', 'sit_down_chair_01', 'sit_stand_up_chair_01']) {
      const clip = gltf.animations.find((c) => c.name === clipName);
      assert.ok(clip, clipName);
      mixer.stopAllAction();
      mixer.clipAction(clip).reset().play();
      for (let frame = 0; frame < 30; frame++) {
        mixer.update(clip.duration / 30);
        const b = bounds(model),
          size = b.getSize(new THREE.Vector3());
        assert.ok(size.toArray().every(Number.isFinite), `${clipName} finite`);
        assert.ok(size.y > 0.7 && size.y < 2.1, `${clipName} height ${size.y}`);
        assert.ok(b.min.y > -0.18 && b.min.y < 0.5, `${clipName} feet ${b.min.y}`);
        assert.ok(Math.abs(b.getCenter(new THREE.Vector3()).x) < 0.6, `${clipName} remains in place`);
      }
    }
  });
test('sedan driver door pivots separately from the shell', async () => {
  const gltf = await geometryAsset('executive-sedan.glb'),
    hinge = gltf.scene.getObjectByName('Driver_door_hinge');
  assert.ok(hinge);
  const panel = hinge.getObjectByName('Driver_door_panel');
  assert.ok(panel);
  const before = bounds(panel).getCenter(new THREE.Vector3());
  hinge.rotation.y = 1.08;
  const after = bounds(panel).getCenter(new THREE.Vector3());
  assert.ok(before.distanceTo(after) > 0.35);
  assert.ok(gltf.scene.getObjectByName('Steering_wheel'));
});
