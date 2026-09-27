import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Human, prepareHumanModel } from '../src/client/world/human';

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

test('Blender workstation has two independent display surfaces and fits a 2.2 m desk', async () => {
 const gltf = await geometryAsset('workstation.glb');
 const screens: THREE.Object3D[] = []; gltf.scene.traverse(o => { if (o.name.startsWith('MonitorScreen')) screens.push(o); });
 assert.equal(screens.length, 2);
 const size = bounds(gltf.scene).getSize(new THREE.Vector3());
 assert.ok(size.x < 2.2 && size.y < 1.6 && size.z < 1.1);
});
for (const asset of ['founder.glb', 'chief-of-staff.glb']) test(`${asset}: typing wrists reach the keyboard and fingers point along its surface`, async () => {
 const gltf = await geometryAsset(asset), model = clone(gltf.scene), mixer = prepareHumanModel(model, gltf.animations);
 const bones = new Map<string, THREE.Bone>();
 model.traverse(o => { if (o instanceof THREE.Bone) bones.set(o.name.replace(/[^a-z0-9]/gi, '').toLowerCase(), o); });
 const human = Object.create(Human.prototype) as Human;
 const root = new THREE.Group(); root.add(model);
 Object.assign(human, { root, model, mixer, bones, actions: new Map(gltf.animations.map(clip => [clip.name, mixer.clipAction(clip)])), current: mixer.clipAction(gltf.animations.find(c => c.name === 'idle_neutral_01')!), motion: 'idle_neutral_01', transition: null, seatedBaseZ: model.position.z, typingBlend: 0, gestureTime: 0, turnLean: 0, reachRemaining: 0 });
 for (let i = 0; i < 180; i++) human.update(1/60, false, true, true);
 root.updateWorldMatrix(true, true);
 for (const side of ['l', 'r']) {
  const hand = bones.get(`bip01${side}hand`)!.getWorldPosition(new THREE.Vector3());
  const finger = bones.get(`bip01${side}finger2`)!.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(hand.y - .82) < .05, `wrist height ${hand.y}`);
  assert.ok(Math.abs(hand.z - .53) < .05, `wrist depth ${hand.z}`);
  assert.ok(Math.abs(finger.y - hand.y) < .02, 'fingers stay parallel to keyboard');
  assert.ok(finger.z > hand.z, 'fingers extend toward keys');
 }
});

test('sedan wheels have independent steering and spin pivots attached outside the sprung body',async()=>{
 const gltf=await geometryAsset('executive-sedan.glb');
 const body=gltf.scene.getObjectByName('Sprung_body')!;
 assert.ok(body);assert.ok(body.getObjectByName('Driver_handle'));
 for(const id of ['FL','FR','RL','RR']){
  const steer=gltf.scene.getObjectByName(`Wheel_${id}`)!;const spin=steer?.getObjectByName(`Spin_${id}`);
  assert.ok(steer && spin,id);assert.notEqual(steer.parent,body);
  const before=bounds(spin).getCenter(new THREE.Vector3());
  spin.rotation.x=1;const after=bounds(spin).getCenter(new THREE.Vector3());
  assert.ok(before.distanceTo(after)<.04, `${id}: rolling around the axle, not the body`);
 }
});
for(const asset of ['founder.glb','chief-of-staff.glb']) test(`${asset}: held vehicle transition keeps a stable adult pose`,async()=>{
 const gltf=await geometryAsset(asset),model=clone(gltf.scene),mixer=prepareHumanModel(model,gltf.animations);
 const bones=new Map<string,THREE.Bone>();model.traverse(o=>{if(o instanceof THREE.Bone)bones.set(o.name.replace(/[^a-z0-9]/gi,'').toLowerCase(),o);});
 const human=Object.create(Human.prototype) as Human, root=new THREE.Group();root.add(model);
 Object.assign(human,{root,model,mixer,bones,actions:new Map(gltf.animations.map(c=>[c.name,mixer.clipAction(c)])),current:mixer.clipAction(gltf.animations.find(c=>c.name==='idle_neutral_01')!),motion:'idle_neutral_01',transition:null,seatedBaseZ:model.position.z,typingBlend:0,gestureTime:0,turnLean:0,reachRemaining:0});
 for(let i=0;i<90;i++) { human.setTransition('sit_down_chair_01',i/180);human.setVehiclePose({phase:'enter',progress:i/180});human.update(1/60); }
 human.update(0);const spine=bones.get('bip01spine')!.quaternion.clone(),head=bones.get('bip01head')!.getWorldPosition(new THREE.Vector3());
 for(let i=0;i<90;i++) human.update(0);
 assert.ok(spine.angleTo(bones.get('bip01spine')!.quaternion)<.001,'posture must not accumulate');
 root.updateWorldMatrix(true,true);
 assert.ok(head.distanceTo(bones.get('bip01head')!.getWorldPosition(new THREE.Vector3()))<.001,'head stays stable');
 human.setTransition(null);human.setVehiclePose({phase:'drive',progress:1,steering:.2});
 for(let i=0;i<60;i++)human.update(1/60,false,true,false,true);
 root.updateWorldMatrix(true,true);
 for(const side of ['l','r']) {const foot=bones.get(`bip01${side}foot`)!.getWorldPosition(new THREE.Vector3());assert.ok(Math.abs(foot.y-.22)<.06,`foot well ${foot.y}`);assert.ok(Math.abs(foot.z-.62)<.07,`foot well ${foot.z}`);}
});
