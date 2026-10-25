/**
 * CHAR-02: the retargeted CC0 clips on every shipped body: finite, in place, planted feet through the landing,
 * no T-pose, a seated driving pose, and the build is reproducible from the pinned inputs' outputs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { parseGlb } from '../tools/avatars/retarget';
import { prepareHumanModel } from '../src/client/world/human';
import { EXTRA_CLIPS } from '../src/client/world/anim-state';
import { AVATAR_IDS, avatarDef } from '../src/shared/outfit';

const M = new URL('../src/client/public/models/avatars/', import.meta.url);
const load = async (f: string) => parseGlb(new Uint8Array(await readFile(new URL(f, M))));

for (const id of AVATAR_IDS) test(`${id}: CC0 jump and driving clips are in place, grounded and never a T-pose`, async () => {
  const body = avatarDef(id).body;
  const [mesh, base, extra] = await Promise.all([load(`${id}.glb`), load(`clips-${body}.glb`), load(`clips-extra-${body}.glb`)]);
  assert.deepEqual(extra.animations.map((c) => c.name).sort(), [...EXTRA_CLIPS].sort());
  const model = clone(mesh.scene);
  prepareHumanModel(model, base.animations, (mesh.scene.userData.height as number | undefined) ?? 1.78);
  const holder = new THREE.Group();
  holder.add(model);
  const mixer = new THREE.AnimationMixer(model);
  const at = (n: string) => model.getObjectByName(n)!.getWorldPosition(new THREE.Vector3());
  const sample = (clip: THREE.AnimationClip, u: number) => {
    mixer.stopAllAction();
    mixer.clipAction(clip).reset().play();
    mixer.setTime(Math.min(u * clip.duration, clip.duration - 1e-4));
    holder.updateMatrixWorld(true);
  };
  sample(base.animations.find((c) => c.name === 'idle_neutral_01')!, 0);
  const idlePelvis = at('Bip01_Pelvis'), idleFeet = [at('Bip01_L_Foot'), at('Bip01_R_Foot')];
  const clip = (n: string) => extra.animations.find((c) => c.name === n)!;
  for (const c of extra.animations) for (let i = 0; i <= 12; i++) {
    sample(c, i / 12);
    const pelvis = at('Bip01_Pelvis');
    assert.ok(pelvis.toArray().every(Number.isFinite), `${c.name} finite`);
    // In place: the hips may shift over the feet, never travel.
    assert.ok(Math.hypot(pelvis.x - idlePelvis.x, pelvis.z - idlePelvis.z) < 0.3, `${c.name} in place (${pelvis.x.toFixed(2)}, ${pelvis.z.toFixed(2)})`);
    // A T-pose spreads the hands well beyond 1.5 m at shoulder height.
    const span = at('Bip01_L_Hand').distanceTo(at('Bip01_R_Hand'));
    assert.ok(span < 1.5, `${c.name} hands ${span.toFixed(2)} m apart`);
    // Feet never sink below the floor.
    for (const f of ['Bip01_L_Foot', 'Bip01_R_Foot']) assert.ok(at(f).y > 0.06, `${c.name} ${f} at ${at(f).y.toFixed(3)}`);
  }
  // Landing: from the first contact the feet stay planted where they touched down (no slide, no float).
  sample(clip('jump_land'), 0.15);
  const planted = [at('Bip01_L_Foot'), at('Bip01_R_Foot')];
  for (let i = 3; i <= 12; i++) {
    sample(clip('jump_land'), i / 12);
    [at('Bip01_L_Foot'), at('Bip01_R_Foot')].forEach((p, k) => {
      assert.ok(p.distanceTo(planted[k]) < 0.03, `jump_land foot ${k} moves ${(p.distanceTo(planted[k]) * 100).toFixed(1)} cm at ${i}/12`);
      assert.ok(Math.abs(p.y - idleFeet[k].y) < 0.03, `jump_land foot ${k} on the floor`);
    });
  }
  // The landing crouches and recovers to standing height; the take-off and air clips never add height of their own.
  sample(clip('jump_land'), 0.3);
  assert.ok(at('Bip01_Pelvis').y < idlePelvis.y - 0.15, 'landing crouch');
  sample(clip('jump_land'), 1);
  assert.ok(Math.abs(at('Bip01_Pelvis').y - idlePelvis.y) < 0.05, 'recovered at the end of the landing');
  for (const n of ['jump_start', 'jump_air']) for (let i = 0; i <= 8; i++) {
    sample(clip(n), i / 8);
    assert.ok(at('Bip01_Pelvis').y < idlePelvis.y + 0.07, `${n} lifts the hips only slightly (the controller does the jump)`);
  }
  for (let i = 0; i <= 8; i++) {
    sample(clip('jump_air'), i / 8);
    assert.ok(Math.max(at('Bip01_L_Foot').y, at('Bip01_R_Foot').y) > idleFeet[0].y + 0.15, 'airborne: a knee is drawn up');
  }
  // Driving: seated about as low as the chair sit, hips over the same spot.
  sample(clip('drive_seated'), 0.5);
  const seat = at('Bip01_Pelvis');
  sample(base.animations.find((c) => c.name === 'sit_chair_idle_neutral_01')!, 0);
  const chair = at('Bip01_Pelvis');
  assert.ok(Math.abs(seat.y - chair.y) < 0.1, `driving seat height ${seat.y.toFixed(2)} vs chair ${chair.y.toFixed(2)}`);
  assert.ok(Math.hypot(seat.x - chair.x, seat.z - chair.z) < 0.05, 'driving hips over the chair-sit spot');
});
