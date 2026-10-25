/**
 * CHAR-02: retargets clips from another humanoid rig (Quaternius' Rigify-style UAL skeleton) onto the shipped
 * Rocketbox clip rigs (`Bip01_*`), in node with three.js, so the build is reproducible without Blender.
 *
 * Method (calibrated world-space deltas): both rigs are posed in a reference standing idle (the source's idle clip,
 * the target's `idle_neutral_01`). Per frame, each mapped source bone's world rotation relative to its reference is
 * applied, in world space, to the target bone's reference world rotation:
 *
 *   T(t) = R · S(t) · S_ref⁻¹ · R⁻¹ · T_ref
 *
 * where R is the yaw that turns the source's facing into the target's. Bone axes and rest poses may differ freely;
 * at the source's idle the target is exactly in its own idle, so the Rocketbox look is kept. Only the pelvis carries
 * translation: its reference height plus the source's height change (scaled by the pelvis-height ratio), clamped by
 * `lift`, never any horizontal travel (clips are in place; the controller moves the body).
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GlbWriter, readGlb } from './glb.ts';
import { reduceKeys } from './keys.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Rocketbox Bip01 bone ← Quaternius UAL (Rigify DEF-) bone. Bones not listed keep their reference pose. */
export const UAL_TO_BIP01: Record<string, string> = (() => {
  const map: Record<string, string> = {
    Bip01_Pelvis: 'DEF-hips', Bip01_Spine: 'DEF-spine.001', Bip01_Spine1: 'DEF-spine.002', Bip01_Spine2: 'DEF-spine.003',
    Bip01_Neck: 'DEF-neck', Bip01_Head: 'DEF-head',
  };
  for (const [side, s] of [['L', 'L'], ['R', 'R']] as const) {
    Object.assign(map, {
      [`Bip01_${side}_Clavicle`]: `DEF-shoulder.${s}`, [`Bip01_${side}_UpperArm`]: `DEF-upper_arm.${s}`,
      [`Bip01_${side}_Forearm`]: `DEF-forearm.${s}`, [`Bip01_${side}_Hand`]: `DEF-hand.${s}`,
      [`Bip01_${side}_Thigh`]: `DEF-thigh.${s}`, [`Bip01_${side}_Calf`]: `DEF-shin.${s}`,
      [`Bip01_${side}_Foot`]: `DEF-foot.${s}`, [`Bip01_${side}_Toe0`]: `DEF-toe.${s}`,
    });
    ['thumb', 'f_index', 'f_middle', 'f_ring', 'f_pinky'].forEach((finger, f) => {
      for (let k = 0; k < 3; k++) map[`Bip01_${side}_Finger${f}${k ? k : ''}`] = `DEF-${finger}.0${k + 1}.${s}`;
    });
  }
  return map;
})();

/** Parses a GLB in node for its skeleton and animations (materials, textures and images dropped). */
export async function parseGlb(bytes: Uint8Array): Promise<GLTF> {
  const { json, bin } = readGlb(bytes);
  if (json.buffers) json.buffers[0].uri = `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`;
  for (const k of ['images', 'textures', 'samplers', 'extensionsRequired', 'extensionsUsed']) delete json[k];
  json.materials = [];
  for (const mesh of json.meshes ?? []) for (const p of mesh.primitives) delete p.material;
  (globalThis as { ProgressEvent?: unknown }).ProgressEvent ??= class { constructor(_t: string, d: object) { Object.assign(this, d); } };
  return new GLTFLoader().parseAsync(JSON.stringify(json), '');
}

export interface ClipSpec {
  /** Name in the shipped clip file. */
  name: string;
  /** Source animation name. */
  from: string;
  /** Source window in seconds (defaults to the whole clip). */
  start?: number;
  end?: number;
  /** Highest the pelvis may rise above its reference height (m); a jump's height comes from the controller. */
  lift?: number;
  /** Lowest the pelvis may drop below its reference height (m). */
  drop?: number;
  /** Share of the source's horizontal hip shift that is kept (default 1; 0 keeps the target's own, e.g. a seat). */
  shift?: number;
  /** Plant each ankle where the source's is (scaled), default true. Off for seated clips whose feet the game places. */
  plant?: boolean;
  /** Share (0–1) of the source's arm movement kept, relative to the standing idle (default: all of it). */
  calm?: number;
  /** Sample rate before key reduction. */
  fps?: number;
}

export interface RetargetedClip {
  name: string;
  duration: number;
  times: Float32Array;
  /** Local rotation per target bone (xyzw per frame). */
  rotations: Map<string, Float32Array>;
  /** Pelvis local translation (xyz per frame). */
  pelvis: Float32Array;
}

const byName = (root: THREE.Object3D) => {
  const m = new Map<string, THREE.Object3D>();
  root.traverse((o) => { if (o.name) m.set(o.name, o); });
  return m;
};
/** Forward of a standing body (unit, horizontal) from its thighs: up × (right thigh − left thigh). */
function facing(left: THREE.Object3D, right: THREE.Object3D): THREE.Vector3 {
  const r = right.getWorldPosition(new THREE.Vector3()).sub(left.getWorldPosition(new THREE.Vector3()));
  return new THREE.Vector3(0, 1, 0).cross(r).setY(0).normalize();
}
const ARM = /^Bip01_[LR]_(Clavicle|UpperArm|Forearm|Hand)$/;
const IDENTITY = new THREE.Quaternion();
/** Largest horizontal hip shift (m) kept from a source clip; anything beyond would be root travel. */
export const MAX_SHIFT = 0.3;
/** Moves the ankle to world point `goal` by bending thigh and calf (CCD), keeping the foot's world rotation. */
function plantFoot(thigh: THREE.Object3D, calf: THREE.Object3D, foot: THREE.Object3D, goal: THREE.Vector3) {
  const a = new THREE.Vector3(), o = new THREE.Vector3(), from = new THREE.Vector3(), to = new THREE.Vector3();
  if (foot.getWorldPosition(a).distanceTo(goal) < 0.004) return;
  const footWorld = foot.getWorldQuaternion(new THREE.Quaternion());
  const q = new THREE.Quaternion(), pq = new THREE.Quaternion();
  for (let i = 0; i < 12; i++) for (const bone of [calf, thigh]) {
    bone.getWorldPosition(o);
    from.copy(foot.getWorldPosition(a)).sub(o).normalize();
    to.copy(goal).sub(o).normalize();
    q.setFromUnitVectors(from, to);
    bone.parent!.getWorldQuaternion(pq);
    bone.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq)).normalize();
    bone.updateMatrixWorld(true);
  }
  foot.parent!.getWorldQuaternion(pq);
  foot.quaternion.copy(pq.invert().multiply(footWorld)).normalize();
  foot.updateMatrixWorld(true);
}
const lowest = (root: THREE.Object3D, names: string[]) => Math.min(...names.map((n) => root.getObjectByName(n)!.getWorldPosition(new THREE.Vector3()).y));

/**
 * Retargets `specs` from `source` onto `target` (a clip rig scene with `targetIdle` among `targetClips`).
 * Deterministic: same inputs, same output.
 */
export function retarget(source: GLTF, sourceIdle: string, target: GLTF, targetIdle: string, specs: ClipSpec[], rigMap = UAL_TO_BIP01): RetargetedClip[] {
  // GLTFLoader sanitizes node names (`DEF-spine.001` loads as `DEF-spine001`).
  const map = Object.fromEntries(Object.entries(rigMap).map(([t, s]) => [t, THREE.PropertyBinding.sanitizeNodeName(s)]));
  const src = source.scene, dst = target.scene;
  const srcBones = byName(src), dstBones = byName(dst);
  for (const [t, s] of Object.entries(map)) {
    if (!dstBones.has(t)) throw new Error(`target rig has no ${t}`);
    if (!srcBones.has(s)) throw new Error(`source rig has no ${s}`);
  }
  const srcClip = (name: string) => {
    const c = source.animations.find((a) => a.name === name);
    if (!c) throw new Error(`source has no animation ${name}`);
    return c;
  };
  const srcMixer = new THREE.AnimationMixer(src);
  const pose = (clip: THREE.AnimationClip, time: number) => {
    srcMixer.stopAllAction();
    srcMixer.clipAction(clip).reset().play();
    srcMixer.setTime(time);
    src.updateMatrixWorld(true);
  };

  // Reference poses.
  const dstMixer = new THREE.AnimationMixer(dst);
  const idle = target.animations.find((a) => a.name === targetIdle);
  if (!idle) throw new Error(`target has no ${targetIdle}`);
  dstMixer.clipAction(idle).play();
  dstMixer.setTime(0);
  dst.updateMatrixWorld(true);
  const dstOrder: THREE.Object3D[] = [];
  dst.traverse((o) => { if (o.name.startsWith('Bip01')) dstOrder.push(o); });
  const tRefWorld = new Map<string, THREE.Quaternion>(), tRefLocal = new Map<string, THREE.Quaternion>();
  for (const b of dstOrder) { tRefWorld.set(b.name, b.getWorldQuaternion(new THREE.Quaternion())); tRefLocal.set(b.name, b.quaternion.clone()); }
  const tPelvis = dstBones.get('Bip01_Pelvis')!;
  const tFeet = ['Bip01_L_Foot', 'Bip01_R_Foot'];
  const tPelvisRef = tPelvis.getWorldPosition(new THREE.Vector3()), tPelvisLocalRef = tPelvis.position.clone();
  const tAnkleRef = lowest(dst, tFeet), tHeight = tPelvisRef.y - tAnkleRef;
  const tFootRef = { L: dstBones.get('Bip01_L_Foot')!.getWorldPosition(new THREE.Vector3()), R: dstBones.get('Bip01_R_Foot')!.getWorldPosition(new THREE.Vector3()) };
  const tForward = facing(dstBones.get('Bip01_L_Thigh')!, dstBones.get('Bip01_R_Thigh')!);
  dstMixer.stopAllAction();
  dstMixer.uncacheRoot(dst);

  pose(srcClip(sourceIdle), 0);
  const sMap = (t: string) => srcBones.get(map[t])!;
  const sRefInv = new Map<string, THREE.Quaternion>();
  for (const t of Object.keys(map)) sRefInv.set(t, sMap(t).getWorldQuaternion(new THREE.Quaternion()).invert());
  const sPelvis = sMap('Bip01_Pelvis');
  const sPelvisRef = sPelvis.getWorldPosition(new THREE.Vector3());
  const sFeet = [map.Bip01_L_Foot, map.Bip01_R_Foot];
  const sAnkleRef = lowest(src, sFeet), sHeight = sPelvisRef.y - sAnkleRef;
  const sFootRef = { L: sMap('Bip01_L_Foot').getWorldPosition(new THREE.Vector3()), R: sMap('Bip01_R_Foot').getWorldPosition(new THREE.Vector3()) };
  const sForward = facing(sMap('Bip01_L_Thigh'), sMap('Bip01_R_Thigh'));
  const R = new THREE.Quaternion().setFromUnitVectors(sForward, tForward), Rinv = R.clone().invert();
  const scale = tHeight / sHeight;

  const q = new THREE.Quaternion(), parentQ = new THREE.Quaternion(), p = new THREE.Vector3();
  return specs.map((spec) => {
    const clip = srcClip(spec.from);
    const start = spec.start ?? 0, end = Math.min(spec.end ?? clip.duration, clip.duration), fps = spec.fps ?? 30;
    const frames = Math.max(2, Math.round((end - start) * fps) + 1);
    const times = new Float32Array(frames);
    const rotations = new Map<string, Float32Array>(dstOrder.map((b) => [b.name, new Float32Array(frames * 4)]));
    const pelvis = new Float32Array(frames * 3);
    for (let f = 0; f < frames; f++) {
      const t = start + ((end - start) * f) / (frames - 1);
      times[f] = t - start;
      pose(clip, t);
      for (const b of dstOrder) {
        if (map[b.name]) {
          // World delta from the source reference, turned into the target's facing, applied to the target reference.
          q.copy(R).multiply(sMap(b.name).getWorldQuaternion(parentQ)).multiply(sRefInv.get(b.name)!).multiply(Rinv);
          // Calmer arms: only part of the source's arm swing is kept (business clothes, not a stunt).
          if (spec.calm !== undefined && ARM.test(b.name)) q.copy(IDENTITY.clone().slerp(q, spec.calm));
          q.multiply(tRefWorld.get(b.name)!);
          b.parent!.getWorldQuaternion(parentQ);
          b.quaternion.copy(parentQ.invert().multiply(q)).normalize();
        } else b.quaternion.copy(tRefLocal.get(b.name)!);
        b.updateMatrixWorld(true);
      }
      // Pelvis height: the lower ankle sits as far above (or below) its standing height as the source's does, scaled,
      // so planted feet stay planted on the target's own leg lengths. Never any horizontal travel.
      const ankle = tAnkleRef + (lowest(src, sFeet) - sAnkleRef) * scale;
      const dy = THREE.MathUtils.clamp(ankle - lowest(dst, tFeet), -(spec.drop ?? 1), spec.lift ?? 0.06);
      // The source clips are in place (their root never travels), so the pelvis' horizontal offset is the hips shifting
      // over planted feet (a landing sits back). It is kept, turned and scaled, and capped so no travel can creep in.
      sPelvis.getWorldPosition(p).sub(sPelvisRef).setY(0).applyQuaternion(R).multiplyScalar(scale * (spec.shift ?? 1)).clampLength(0, MAX_SHIFT);
      p.add(tPelvisRef).setY(tPelvisRef.y + dy);
      tPelvis.parent!.worldToLocal(p);
      p.toArray(pelvis, f * 3);
      tPelvis.position.copy(p);
      tPelvis.updateMatrixWorld(true);
      // Each ankle then goes where the source's is, relative to its standing spot and scaled (two-bone IK on thigh and
      // calf, foot orientation kept): a planted foot stays put although the two rigs' hip widths and leg lengths differ.
      if (spec.plant !== false) for (const side of ['L', 'R'] as const) {
        sMap(`Bip01_${side}_Foot`).getWorldPosition(p).sub(sFootRef[side]).applyQuaternion(R).multiplyScalar(scale).add(tFootRef[side]);
        plantFoot(dstBones.get(`Bip01_${side}_Thigh`)!, dstBones.get(`Bip01_${side}_Calf`)!, dstBones.get(`Bip01_${side}_Foot`)!, p);
      }
      for (const b of dstOrder) b.quaternion.toArray(rotations.get(b.name)!, f * 4);
      tPelvis.position.copy(tPelvisLocalRef);
    }
    // Restore the reference pose for the next clip.
    for (const b of dstOrder) b.quaternion.copy(tRefLocal.get(b.name)!);
    dst.updateMatrixWorld(true);
    return { name: spec.name, duration: end - start, times, rotations, pelvis };
  });
}

/**
 * Writes retargeted clips as a clip file shaped like clips-*.glb: the clip rig's node tree (no mesh), rotation tracks
 * (normalized int16, keys reduced; a constant track keeps one key) on the retargeted bones only, translation on the
 * pelvis only, no scale. Bones without a track (the face) keep the pose the previous clip left them in (the idle face).
 * All accessors share three buffer views and identical key times are stored once, so the JSON stays small.
 */
export function writeClipGlb(rigBytes: Uint8Array, clips: RetargetedClip[], extras: Json = {}, bones = Object.keys(UAL_TO_BIP01)): Buffer {
  const { json } = readGlb(rigBytes);
  const w = new GlbWriter();
  w.json.asset.generator = 'agent-empire tools/avatars/build-clips.mts';
  w.json.nodes = json.nodes.map((n: Json) => {
    const out: Json = { name: n.name };
    for (const k of ['translation', 'rotation', 'scale', 'children']) if (n[k]) out[k] = n[k];
    return out;
  });
  const index = new Map<string, number>(w.json.nodes.map((n: Json, i: number) => [n.name, i]));
  for (const bone of bones) if (!index.has(bone)) throw new Error(`clip rig has no node ${bone}`);
  w.json.scenes = [{ nodes: json.scenes[json.scene ?? 0].nodes, extras }];
  w.json.scene = 0;
  w.json.animations = [];
  const times: number[] = [], quats: number[] = [], vecs: number[] = [];
  const accessors: Json[] = [];
  const timeAccessor = new Map<string, number>();
  const input = (t: number[]) => {
    const key = t.map((x) => Math.fround(x)).join(',');
    if (!timeAccessor.has(key)) {
      accessors.push({ view: 0, byteOffset: times.length * 4, componentType: 5126, count: t.length, type: 'SCALAR', min: [Math.fround(t[0])], max: [Math.fround(t[t.length - 1])] });
      times.push(...t);
      timeAccessor.set(key, accessors.length - 1);
    }
    return timeAccessor.get(key)!;
  };
  for (const clip of clips) {
    const channels: Json[] = [], samplers: Json[] = [];
    const add = (node: string, path: 'rotation' | 'translation', values: Float32Array) => {
      const n = path === 'rotation' ? 4 : 3;
      let constant = true;
      for (let i = n; i < values.length && constant; i++) if (Math.abs(values[i] - values[i % n]) > (path === 'rotation' ? 2e-5 : 1e-3)) constant = false;
      const keep = constant ? [0] : reduceKeys(clip.times, values, n, path === 'rotation' ? 0.0015 : 0.004);
      const inputIndex = input(keep.map((k) => clip.times[k]));
      if (path === 'rotation') {
        accessors.push({ view: 1, byteOffset: quats.length * 2, componentType: 5122, normalized: true, count: keep.length, type: 'VEC4' });
        let prev: number[] | null = null;
        for (const k of keep) {
          let v = [...values.subarray(k * 4, k * 4 + 4)];
          const len = Math.hypot(...v) || 1;
          v = v.map((x) => x / len);
          // Same hemisphere as the previous key, so interpolation takes the short way.
          if (prev && v.reduce((sum, x, c) => sum + x * prev![c], 0) < 0) v = v.map((x) => -x);
          prev = v;
          quats.push(...v.map((x) => Math.round(x * 32767)));
        }
      } else {
        accessors.push({ view: 2, byteOffset: vecs.length * 4, componentType: 5126, count: keep.length, type: 'VEC3' });
        for (const k of keep) vecs.push(...values.subarray(k * 3, k * 3 + 3));
      }
      samplers.push({ input: inputIndex, output: accessors.length - 1, interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: index.get(node), path } });
    };
    for (const bone of bones) add(bone, 'rotation', clip.rotations.get(bone)!);
    add('Bip01_Pelvis', 'translation', clip.pelvis);
    w.json.animations.push({ name: clip.name, channels, samplers });
  }
  const views = [w.bufferView(new Float32Array(times)), w.bufferView(new Int16Array(quats)), w.bufferView(new Float32Array(vecs))];
  w.json.accessors = accessors.map(({ view, ...a }) => ({ bufferView: views[view], ...a }));
  return w.toGlb();
}
