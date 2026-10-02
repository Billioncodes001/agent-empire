import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Human, RUN_FLIGHT_PHASE, landingDip, locomotionClip, prepareHumanModel as prepareModel } from '../src/client/world/human';
import { AVATAR_IDS, avatarDef, isAvatarId } from '../src/shared/outfit';

// Exercise the actual shipped meshes/rigs on the CPU; texture decode requires a browser.
async function parseGlb(url: URL) {
  const bytes = await readFile(url);
  const length = bytes.readUInt32LE(12),
    data = JSON.parse(bytes.subarray(20, 20 + length).toString());
  if (data.buffers) data.buffers[0].uri = `data:application/octet-stream;base64,${bytes.subarray(28 + length).toString('base64')}`;
  delete data.images;
  delete data.textures;
  delete data.samplers;
  delete data.extensionsRequired;
  delete data.extensionsUsed;
  data.materials = [];
  for (const mesh of data.meshes ?? []) for (const primitive of mesh.primitives) delete primitive.material;
  globalThis.ProgressEvent ??= class ProgressEvent {
    constructor(_type: string, data: object) {
      Object.assign(this, data);
    }
  } as typeof globalThis.ProgressEvent;
  return new GLTFLoader().parseAsync(JSON.stringify(data), '');
}
const MODELS = new URL('../src/client/public/models/', import.meta.url);
/**
 * A shipped model. For a corporate avatar this is what the game assembles: its mesh-only GLB with the shared
 * clip file of its body as `animations` (see src/client/world/avatars.ts).
 */
async function geometryAsset(name: string) {
  if (!isAvatarId(name)) return parseGlb(new URL(name, MODELS));
  const [mesh, clips] = await Promise.all([parseGlb(new URL(`avatars/${name}.glb`, MODELS)), parseGlb(new URL(`avatars/clips-${avatarDef(name).body}.glb`, MODELS))]);
  return { scene: mesh.scene, animations: clips.animations };
}
/** As the game prepares a body: at the avatar's own height (scene extras), else the legacy 1.78 m. */
function prepareHumanModel(model: THREE.Object3D, animations: THREE.AnimationClip[]) {
  return prepareModel(model, animations, (model.userData.height as number | undefined) ?? 1.78);
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
for (const name of AVATAR_IDS)
  test(`${name}: animation stays at adult scale and clones have independent bones`, async () => {
    const gltf = await geometryAsset(name),
      one = clone(gltf.scene),
      two = clone(gltf.scene);
    const mixer = prepareHumanModel(one, gltf.animations);
    prepareHumanModel(two, gltf.animations);
    for (let frame = 0; frame < 120; frame++) mixer.update(1 / 60);
    const box = bounds(one),
      size = box.getSize(new THREE.Vector3());
    assert.ok(size.y > 1.6 && size.y < 1.95, `animated height ${size.y}`);
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
for (const name of AVATAR_IDS)
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
for (const asset of AVATAR_IDS) test(`${asset}: typing wrists reach the keyboard and fingers point along its surface`, async () => {
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
for(const asset of AVATAR_IDS) test(`${asset}: held vehicle transition keeps a stable adult pose`,async()=>{
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

// ---- LIFE-01: airborne, landing and walk/run blending ----------------------------------------------
async function bareHuman(asset: string) {
  const gltf = await geometryAsset(asset), model = clone(gltf.scene), mixer = prepareHumanModel(model, gltf.animations);
  const bones = new Map<string, THREE.Bone>();
  model.traverse(o => { if (o instanceof THREE.Bone) bones.set(o.name.replace(/[^a-z0-9]/gi, '').toLowerCase(), o); });
  const actions = new Map(gltf.animations.map(c => [c.name, mixer.clipAction(c)]));
  // As the Human constructor does: a second action on the run clip holds the flight frame.
  const flight = gltf.animations.find(c => c.name === 'run_neutral')!.clone();
  flight.name = 'airborne_flight';
  actions.set(flight.name, mixer.clipAction(flight));
  const human = Object.create(Human.prototype) as Human, parent = new THREE.Group(), root = new THREE.Group();
  parent.add(root); root.add(model);
  Object.assign(human, { root, model, mixer, bones, actions, current: actions.get('idle_neutral_01'), motion: 'idle_neutral_01', transition: null, seatedBaseZ: model.position.z, typingBlend: 0, gestureTime: 0, turnLean: 0, reachRemaining: 0 });
  const at = (bone: string) => { root.updateWorldMatrix(true, true); return bones.get(bone)!.getWorldPosition(new THREE.Vector3()); };
  return { gltf, human, root, model, mixer, bones, at };
}

for (const asset of AVATAR_IDS) test(`${asset}: the held flight frame has both feet off the floor`, async () => {
  const { gltf, model, mixer, at } = await bareHuman(asset);
  mixer.stopAllAction();
  const clip = gltf.animations.find(c => c.name === 'run_neutral')!;
  const action = mixer.clipAction(clip).reset().play();
  action.time = RUN_FLIGHT_PHASE * clip.duration;
  mixer.update(0);
  model.updateMatrixWorld(true);
  for (const side of ['l', 'r']) assert.ok(at(`bip01${side}foot`).y > 0.15, `${side} foot is up in the flight frame`);
});

for (const asset of AVATAR_IDS) test(`${asset}: a jump never plays the idle clip mid-air, tucks, and lands with planted feet`, async () => {
  const { human, root, model, at } = await bareHuman(asset);
  const dt = 1 / 60;
  for (let i = 0; i < 30; i++) human.update(dt, 0);
  const rest = at('bip01lfoot').y, restY = model.position.y;
  // The player's jump: JUMP_V 6.4 m/s against GRAVITY 18 m/s².
  let y = 0, vy = 6.4, peakTuck = 0, landedAt = -1, deepest = 0, worstFoot = 0;
  for (let i = 0; i < 90; i++) {
    vy -= 18 * dt;
    y = Math.max(0, y + vy * dt);
    root.position.y = y;
    human.setAirborne(y > 0);
    human.update(dt, 0);
    const motion = root.userData.motion as string;
    if (y > 0.05) {
      assert.notEqual(motion, 'idle_neutral_01', `frame ${i} is mid-air`);
      assert.equal(motion, 'airborne', `frame ${i} uses the flight pose`);
      peakTuck = Math.max(peakTuck, Math.min(at('bip01lfoot').y, at('bip01rfoot').y) - y - rest);
    } else if (y === 0 && landedAt < 0) landedAt = i;
    if (landedAt >= 0 && i - landedAt < 18) {
      deepest = Math.max(deepest, restY - model.position.y);
      // The touchdown frame may still be toe-first; from the next frame both heels are down.
      for (const side of ['l', 'r']) {
        const off = Math.abs(at(`bip01${side}foot`).y - rest);
        if (i === landedAt) assert.ok(off < 0.06, `touchdown foot ${off}`);
        else worstFoot = Math.max(worstFoot, off);
      }
    }
  }
  assert.ok(peakTuck > 0.12, `knees tuck the feet up ${peakTuck}`);
  assert.ok(landedAt > 0, 'lands');
  assert.ok(deepest > 0.025 && deepest < 0.095, `landing dip ${deepest}`);
  assert.ok(worstFoot < 0.03, `feet stay planted through the dip (${worstFoot})`);
  assert.equal(root.userData.motion, 'idle_neutral_01', 'recovers to standing');
  assert.ok(Math.abs(model.position.y - restY) < 1e-6, 'hips return to rest height');
});

test('walk ↔ run selection has hysteresis, so a speed hovering at the boundary does not flicker', () => {
  assert.equal(locomotionClip(0, 'walk_neutral'), 'idle_neutral_01');
  assert.equal(locomotionClip(1.65, 'idle_neutral_01'), 'walk_neutral');
  assert.equal(locomotionClip(4.3, 'walk_neutral'), 'run_neutral');
  let clip: string = 'walk_neutral', switches = 0;
  for (let i = 0; i < 200; i++) {
    const next = locomotionClip(2.5 + Math.sin(i * 1.7) * 0.18, clip);
    if (next !== clip) switches++;
    clip = next;
  }
  assert.equal(switches, 0, 'noise inside the hysteresis band never switches');
  assert.equal(landingDip(0, 0.06), 0);
  assert.ok(landingDip(0.3, 0.06) > 0.059);
  assert.equal(landingDip(1, 0.06), 0);
});

for (const asset of AVATAR_IDS) test(`${asset}: accelerating from walk to run keeps the stride continuous`, async () => {
  const { human, root, at } = await bareHuman(asset);
  const dt = 1 / 60;
  const feet = () => ['l', 'r'].map(s => root.worldToLocal(at(`bip01${s}foot`)));
  let before = feet(), steady = 0, switching = 0, switches = 0, last = 'idle_neutral_01';
  for (let i = 0; i < 240; i++) {
    // 1.65 m/s walk, ramp to a 4.3 m/s run over one second, hold, then back.
    const speed = i < 60 ? 1.65 : i < 120 ? 1.65 + (4.3 - 1.65) * ((i - 60) / 60) : i < 180 ? 4.3 : 4.3 - (4.3 - 1.65) * Math.min(1, (i - 180) / 40);
    human.update(dt, speed);
    const now = feet(), jump = Math.max(now[0].distanceTo(before[0]), now[1].distanceTo(before[1]));
    const motion = root.userData.motion as string;
    if (motion !== last) { if (i > 0) switches++; last = motion; }
    // Largest per-frame foot travel while settled in a run versus across the cross-fades.
    if (i >= 150 && i < 180) steady = Math.max(steady, jump);
    if ((i >= 60 && i < 150) || i >= 180) switching = Math.max(switching, jump);
    before = now;
  }
  assert.equal(switches, 2, 'one walk→run and one run→walk switch');
  assert.ok(switching < steady * 1.35, `no pop across the blend (${switching.toFixed(3)} vs steady ${steady.toFixed(3)})`);
});

for (const asset of AVATAR_IDS) test(`${asset}: amenity poses never accumulate and let go cleanly`, async () => {
  const { human, root, bones } = await bareHuman(asset);
  for (const activity of ['weights', 'stretch', 'coffee'] as const) {
    human.setActivity(activity);
    for (let i = 0; i < 120; i++) human.update(1 / 60, 0);
    for (let i = 0; i < 5; i++) human.update(0, 0);
    const q = bones.get('bip01rforearm')!.quaternion.clone();
    for (let i = 0; i < 30; i++) human.update(0, 0);
    assert.ok(q.angleTo(bones.get('bip01rforearm')!.quaternion) < 1e-3, `${activity}: a held frame does not drift`);
  }
  human.setActivity('none');
  for (let i = 0; i < 180; i++) human.update(1 / 60, 0);
  const props = root.children.filter(o => o.name.startsWith('prop:'));
  assert.ok(props.length > 0 && props.every(p => !p.visible), 'cup and dumbbells are put away');
});

// ---- Corporate avatars: shared clips, rest poses and shipped files ----------------------------------------
const CLIP_NAMES = ['idle_neutral_01', 'walk_neutral', 'run_neutral', 'sit_chair_idle_neutral_01', 'sit_down_chair_01', 'sit_stand_up_chair_01', 'sit_down_chair_left', 'sit_stand_up_chair_left', 'wave_01'];
for (const body of ['male', 'female'] as const) test(`clips-${body}.glb: rotations on every bone, translation only on the pelvis, no scale`, async () => {
  const clips = await parseGlb(new URL(`avatars/clips-${body}.glb`, MODELS));
  const names = clips.animations.map((c) => c.name);
  for (const name of CLIP_NAMES) assert.ok(names.includes(name), `${body} clips include ${name}`);
  for (const clip of clips.animations)
    for (const track of clip.tracks) {
      const [node, property] = track.name.split('.');
      assert.notEqual(property, 'scale', `${clip.name}: ${track.name} would impose the source body's proportions`);
      if (property === 'position') assert.equal(node, 'Bip01_Pelvis', `${clip.name}: only the pelvis translates (${track.name})`);
    }
});

for (const id of AVATAR_IDS) test(`${id}: rest pose matches its clip rig bone for bone, so shared clips retarget without distortion`, async () => {
  const [mesh, clips] = await Promise.all([parseGlb(new URL(`avatars/${id}.glb`, MODELS)), parseGlb(new URL(`avatars/clips-${avatarDef(id).body}.glb`, MODELS))]);
  const bones = new Map<string, THREE.Object3D>();
  mesh.scene.traverse((o) => { if ((o as THREE.Bone).isBone) bones.set(o.name, o); });
  const rig = new Map<string, THREE.Object3D>();
  clips.scene.traverse((o) => { if (o.name.startsWith('Bip01_')) rig.set(o.name, o); });
  assert.ok(bones.size >= 80, `${bones.size} bones`);
  let worst = 0, worstName = '';
  for (const [name, source] of rig) {
    const bone = bones.get(name);
    assert.ok(bone, `${id} has ${name}`);
    const angle = bone.quaternion.angleTo(source.quaternion);
    if (angle > worst) { worst = angle; worstName = name; }
  }
  assert.ok(worst < THREE.MathUtils.degToRad(1), `rest rotations within 1° (worst ${THREE.MathUtils.radToDeg(worst).toFixed(2)}° at ${worstName})`);
  // Clips move the pelvis in its parent's frame: both rigs must agree on that frame and the hip height.
  mesh.scene.updateMatrixWorld(true);
  clips.scene.updateMatrixWorld(true);
  const pelvis = bones.get('Bip01_Pelvis')!, source = rig.get('Bip01_Pelvis')!;
  const q = (o: THREE.Object3D) => o.getWorldQuaternion(new THREE.Quaternion());
  assert.ok(q(pelvis.parent!).angleTo(q(source.parent!)) < 1e-3, 'pelvis parent frame matches the clip rig');
  const height = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).y;
  assert.ok(Math.abs(height(pelvis) - height(source)) < 0.01, `hip height ${height(pelvis).toFixed(3)} vs clip rig ${height(source).toFixed(3)}`);
  // Every animated bone exists on the avatar.
  for (const clip of clips.animations) for (const track of clip.tracks) assert.ok(bones.has(track.name.split('.')[0]), `${clip.name} targets ${track.name}`);
});

for (const id of AVATAR_IDS) test(`${id}: ships textured, non-metallic materials with both texture sizes and a recolour mask`, async () => {
  const bytes = await readFile(new URL(`avatars/${id}.glb`, MODELS));
  const length = bytes.readUInt32LE(12), json = JSON.parse(bytes.subarray(20, 20 + length).toString());
  assert.deepEqual(json.extensionsRequired, ['EXT_texture_webp']);
  const names = json.materials.map((m: { name: string }) => m.name);
  assert.ok(names.includes('body') && names.includes('head'), names.join());
  for (const m of json.materials) {
    assert.equal(m.pbrMetallicRoughness.metallicFactor, 0, `${m.name} is dielectric`);
    const texture = json.textures[m.pbrMetallicRoughness.baseColorTexture.index];
    const uri = json.images[texture.extensions.EXT_texture_webp.source].uri as string;
    assert.match(uri, new RegExp(`^${id}/.+-1024\\.webp$`));
    for (const size of [1024, 512]) {
      const file = await readFile(new URL(`avatars/${uri.replace('-1024.webp', `-${size}.webp`)}`, MODELS));
      assert.equal(file.subarray(8, 12).toString(), 'WEBP', `${uri} at ${size}`);
    }
  }
  const mask = await readFile(new URL(`avatars/${id}/mask-512.webp`, MODELS));
  assert.equal(mask.subarray(8, 12).toString(), 'WEBP');
  const extras = json.scenes[0].extras;
  assert.equal(extras.avatar, id);
  assert.ok(extras.height > 1.6 && extras.height < 1.95, `height ${extras.height}`);
  for (const region of avatarDef(id).regions) assert.ok(extras.regions[region]?.area > 0.001, `${id} has a ${region} region`);
  if (!avatarDef(id).regions.includes('tie')) assert.equal(extras.regions.tie, undefined, 'no tie region on a tieless outfit');
});
