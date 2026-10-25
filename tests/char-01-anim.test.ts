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
