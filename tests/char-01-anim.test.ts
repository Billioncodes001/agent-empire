/**
 * CHAR-01 animation audit, on the shipped bodies and clips: walk and run strides play at the rate that matches the
 * founder's ground speed (no foot sliding), and a quick turn on the spot steps the feet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { prepareHumanModel, strideSpeed } from '../src/client/world/human';
import { AVATAR_IDS, avatarDef } from '../src/shared/outfit';

async function parseGlb(url: URL) {
  const bytes = await readFile(url);
  const length = bytes.readUInt32LE(12), data = JSON.parse(bytes.subarray(20, 20 + length).toString());
  if (data.buffers) data.buffers[0].uri = `data:application/octet-stream;base64,${bytes.subarray(28 + length).toString('base64')}`;
  for (const k of ['images', 'textures', 'samplers', 'extensionsRequired', 'extensionsUsed']) delete data[k];
  data.materials = [];
  for (const mesh of data.meshes ?? []) for (const p of mesh.primitives) delete p.material;
  (globalThis as { ProgressEvent?: unknown }).ProgressEvent ??= class { constructor(_t: string, d: object) { Object.assign(this, d); } };
  return new GLTFLoader().parseAsync(JSON.stringify(data), '');
}
const M = new URL('../src/client/public/models/avatars/', import.meta.url);
// The founder's controller speeds (player.ts WALK / RUN) and the cadence cap in Human.update.
const WALK = 1.65, RUN = 4.3, CAP = 1.6;

for (const id of AVATAR_IDS) test(`${id}: walk and run play at a rate where planted feet keep up with the ground`, async () => {
  const [mesh, clips] = await Promise.all([parseGlb(new URL(`${id}.glb`, M)), parseGlb(new URL(`clips-${avatarDef(id).body}.glb`, M))]);
  const model = clone(mesh.scene);
  prepareHumanModel(model, clips.animations, (mesh.scene.userData.height as number | undefined) ?? 1.78);
  const walk = strideSpeed(model, clips.animations.find((c) => c.name === 'walk_neutral')!)!;
  const run = strideSpeed(model, clips.animations.find((c) => c.name === 'run_neutral')!)!;
  assert.ok(walk > 0.9 && walk < 1.7, `walk stride ${walk.toFixed(2)} m/s`);
  assert.ok(run > 1.8 && run < 3.6 && run > walk * 1.4, `run stride ${run.toFixed(2)} m/s`);
  // Before CHAR-01 the clips played at speed / 1.45 and speed / 3.8 whatever the body: up to 40 % of a run slid.
  const slide = (speed: number, stride: number) => Math.abs(speed - stride * Math.min(CAP, speed / stride)) / speed;
  assert.ok(slide(WALK, walk) < 0.02, `walk slides ${(slide(WALK, walk) * 100).toFixed(0)} %`);
  assert.ok(slide(RUN, run) < 0.16, `run slides ${(slide(RUN, run) * 100).toFixed(0)} %`);
  assert.ok(slide(RUN, run) < Math.abs(RUN - run * (RUN / 3.8)) / RUN, 'less sliding than the fixed 3.8 m/s rate');
});

test('CHAR-01: a foot over a stair tread is lifted onto it, the other stays planted', async () => {
  const { Human } = await import('../src/client/world/human');
  const [mesh, clips] = await Promise.all([parseGlb(new URL('business-f01.glb', M)), parseGlb(new URL('clips-female.glb', M))]);
  const model = clone(mesh.scene);
  const mixer = prepareHumanModel(model, clips.animations, (mesh.scene.userData.height as number | undefined) ?? 1.78);
  const bones = new Map<string, THREE.Bone>();
  model.traverse((o) => { if (o instanceof THREE.Bone) bones.set(o.name.replace(/[^a-z0-9]/gi, '').toLowerCase(), o); });
  const human = Object.create(Human.prototype) as InstanceType<typeof Human>;
  const parent = new THREE.Group(), root = new THREE.Group();
  parent.add(root); root.add(model);
  const actions = new Map(clips.animations.map((c) => [c.name, mixer.clipAction(c)]));
  Object.assign(human, { root, model, mixer, bones, actions, ready: true, current: actions.get('idle_neutral_01'), motion: 'idle_neutral_01', transition: null, seatedBaseZ: model.position.z, typingBlend: 0, gestureTime: 0, turnLean: 0, reachRemaining: 0 });
  for (let i = 0; i < 20; i++) human.update(1 / 60, 0);
  const at = (b: string) => { root.updateWorldMatrix(true, true); return bones.get(b)!.getWorldPosition(new THREE.Vector3()); };
  const l = at('bip01lfoot'), r = at('bip01rfoot');
  const tread = 0.2, split = (l.x + r.x) / 2, leftHigh = l.x > split;
  human.groundFeet((x) => ((x > split) === leftHigh ? tread : 0));
  const l2 = at('bip01lfoot'), r2 = at('bip01rfoot');
  const [up, flat, flatBefore] = leftHigh === (l.x > r.x) ? [l2, r2, r] : [r2, l2, l];
  assert.ok(up.y > tread + 0.08, `foot lifted onto the tread: ${up.y.toFixed(3)}`);
  assert.ok(flat.distanceTo(flatBefore) < 0.01, 'the other foot is untouched');
});
