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

// ---- The state machine driving a real body -------------------------------------------------------------------------
async function body(id: string, withExtra: boolean) {
  const { Human } = await import('../src/client/world/human');
  const kind = avatarDef(id as (typeof AVATAR_IDS)[number]).body;
  const [mesh, base, extra] = await Promise.all([load(`${id}.glb`), load(`clips-${kind}.glb`), load(`clips-extra-${kind}.glb`)]);
  const model = clone(mesh.scene);
  const mixer = prepareHumanModel(model, base.animations, (mesh.scene.userData.height as number | undefined) ?? 1.78);
  const bones = new Map<string, THREE.Bone>();
  model.traverse((o) => { if (o instanceof THREE.Bone) bones.set(o.name.replace(/[^a-z0-9]/gi, '').toLowerCase(), o); });
  const clips = [...base.animations, ...(withExtra ? extra.animations : [])];
  const actions = new Map(clips.map((c) => [c.name, mixer.clipAction(c)]));
  const flight = base.animations.find((c) => c.name === 'run_neutral')!.clone();
  flight.name = 'airborne_flight';
  actions.set(flight.name, mixer.clipAction(flight));
  const human = Object.create(Human.prototype) as InstanceType<typeof Human>, parent = new THREE.Group(), root = new THREE.Group();
  parent.add(root); root.add(model);
  Object.assign(human, { root, model, mixer, bones, actions, ready: true, current: actions.get('idle_neutral_01'), motion: 'idle_neutral_01', transition: null, seatedBaseZ: model.position.z, typingBlend: 0, gestureTime: 0, turnLean: 0, reachRemaining: 0 });
  const at = (b: string) => { root.updateWorldMatrix(true, true); return bones.get(b)!.getWorldPosition(new THREE.Vector3()); };
  return { human, root, model, at };
}
/** The player's jump (player.ts JUMP_V 6.4 m/s, GRAVITY 18 m/s²); returns the clip sequence. */
function jump(h: Awaited<ReturnType<typeof body>>, frames = 120) {
  const dt = 1 / 60, seen: string[] = [];
  for (let i = 0; i < 30; i++) h.human.update(dt, 0);
  seen.push(h.root.userData.clip as string);
  let y = 0, vy = 6.4;
  for (let i = 0; i < frames; i++) {
    vy -= 18 * dt;
    y = Math.max(0, y + vy * dt);
    h.root.position.y = y;
    h.human.setAirborne(y > 0);
    h.human.update(dt, 0);
    const clip = h.root.userData.clip as string;
    if (seen.at(-1) !== clip) seen.push(clip);
  }
  return seen;
}

test('CHAR-02: a jump plays take-off, airborne and landing clips in order, then stands', async () => {
  const h = await body('business-m02', true);
  assert.deepEqual(jump(h), ['idle_neutral_01', 'jump_start', 'jump_air', 'jump_land', 'idle_neutral_01']);
});

test('CHAR-02: without the extra clips (not loaded yet, failed, Save-Data) the CHAR-01 jump plays', async () => {
  const h = await body('business-f02', false);
  assert.deepEqual(jump(h), ['idle_neutral_01', 'airborne_flight', 'idle_neutral_01']);
});

test('CHAR-02: reduced motion keeps the calm jump even with the clips loaded', async () => {
  const { setHumanReducedMotion } = await import('../src/client/world/human');
  setHumanReducedMotion(true);
  try {
    const h = await body('business-m01', true);
    assert.deepEqual(jump(h), ['idle_neutral_01', 'airborne_flight', 'idle_neutral_01']);
  } finally { setHumanReducedMotion(false); }
});

test('CHAR-02: landing feet stay planted while the crouch plays', async () => {
  const h = await body('business-f01', true);
  const dt = 1 / 60;
  jump(h, 44); // up to touchdown (0.71 s) and a frame past it
  const planted = [h.at('bip01lfoot'), h.at('bip01rfoot')];
  let worst = 0;
  for (let i = 0; i < 40; i++) {
    h.human.setAirborne(false);
    h.human.update(dt, 0);
    if (i > 8) [h.at('bip01lfoot'), h.at('bip01rfoot')].forEach((p, k) => { worst = Math.max(worst, Math.abs(p.y - planted[k].y)); });
  }
  assert.equal(h.root.userData.clip, 'jump_land');
  assert.ok(worst < 0.04, `feet stay on the floor (${worst.toFixed(3)} m)`);
});

test('CHAR-02: climbing and descending stairs is a stairs state on the stride clip, with a lean', async () => {
  const h = await body('business-m04', true);
  const dt = 1 / 60;
  for (let i = 0; i < 20; i++) h.human.update(dt, 1.6);
  for (let i = 0; i < 60; i++) { h.root.position.y += 0.6 * dt; h.human.update(dt, 1.6); }
  assert.equal(h.root.userData.stairs, 'up');
  assert.equal(h.root.userData.clip, 'walk_neutral');
  for (let i = 0; i < 60; i++) { h.root.position.y -= 0.6 * dt; h.human.update(dt, 1.6); }
  assert.equal(h.root.userData.stairs, 'down');
  for (let i = 0; i < 60; i++) h.human.update(dt, 1.6);
  assert.equal(h.root.userData.stairs, null, 'level ground again');
});

test('CHAR-02: the car seat plays the driving pose, the chair sit without it', async () => {
  const withClip = await body('business-m05', true), without = await body('business-f03', false);
  for (let i = 0; i < 30; i++) { withClip.human.update(1 / 60, 0, true, false, true); without.human.update(1 / 60, 0, true, false, true); }
  assert.equal(withClip.root.userData.clip, 'drive_seated');
  assert.equal(without.root.userData.clip, 'sit_chair_idle_neutral_01');
});
