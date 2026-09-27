import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

const assets = new Map<string, Promise<GLTF>>();
function source(url: string) {
  if (!assets.has(url)) assets.set(url, new GLTFLoader().loadAsync(url));
  return assets.get(url)!;
}
/** Shared source geometry/textures, independent skeleton and mixer for each adult. */
export class Human {
  readonly root = new THREE.Group();
  ready = false;
  private mixer?: THREE.AnimationMixer;
  private model?: THREE.Object3D;
  private bones = new Map<string, THREE.Bone>();
  private disposed = false;
  private actions = new Map<string, THREE.AnimationAction>();
  private current?: THREE.AnimationAction;
  private motion = '';
  private transition: { name: string; progress: number } | null = null;
  private reachRemaining = 0;
  private typingBlend = 0;
  private seatedBaseZ = 0;
  private gestureTime = Math.random() * 30;
  private lastYaw?: number;
  private turnLean = 0;
  constructor(variant = 0) {
    this.root.name = 'Realistic human';
    void source(variant % 2 ? '/models/chief-of-staff.glb' : '/models/founder.glb')
      .then((gltf) => {
        if (this.disposed) return;
        const model = clone(gltf.scene);
        this.mixer = prepareHumanModel(model, gltf.animations);
        for (const clip of gltf.animations) this.actions.set(clip.name, this.mixer.clipAction(clip));
        this.current = this.actions.get('idle_neutral_01');
        this.motion = 'idle_neutral_01';
        model.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
          if (o instanceof THREE.Bone) this.bones.set(o.name.replace(/[^a-z0-9]/gi, '').toLowerCase(), o);
        });
        this.root.add(model);
        this.model = model;
        this.seatedBaseZ = model.position.z;
        this.ready = true;
      })
      .catch((error) => {
        console.warn('Human model could not load', error);
        this.root.userData.assetError = true;
      });
  }
  private rotate(name: string, angle: number) {
    const bone = this.bones.get(name);
    if (!bone || !this.model) return;
    // Rotate around the model's lateral axis in the bone parent's space, regardless of source rig axes.
    bone.parent!.updateWorldMatrix(true, false);
    const q = this.model.getWorldQuaternion(new THREE.Quaternion());
    const axis = new THREE.Vector3(1, 0, 0)
      .applyQuaternion(q)
      .applyQuaternion(bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert());
    bone.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
  }
  reach() {
    this.reachRemaining = 0.6;
  }
  private placeHand(side: 'l' | 'r', x: number, y: number, z: number, weight = 1) {
    const hand = this.bones.get(`bip01${side}hand`);
    if (!hand) return;
    this.root.updateWorldMatrix(true, true);
    const target = hand.getWorldPosition(new THREE.Vector3()).lerp(this.root.localToWorld(new THREE.Vector3(x, y, z)), weight);
    for (let iteration = 0; iteration < 8; iteration++)
      for (const part of ['forearm', 'upperarm']) {
        const bone = this.bones.get(`bip01${side}${part}`);
        if (!bone?.parent) continue;
        const origin = bone.getWorldPosition(new THREE.Vector3());
        const current = hand.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
        const desired = target.clone().sub(origin).normalize();
        const delta = new THREE.Quaternion().setFromUnitVectors(current, desired);
        const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion());
        bone.quaternion.premultiply(parent.clone().invert().multiply(delta).multiply(parent));
        bone.updateWorldMatrix(true, true);
      }
  }
  private alignTypingHand(side: 'l' | 'r', weight: number) {
    const hand = this.bones.get(`bip01${side}hand`), middle = this.bones.get(`bip01${side}finger2`);
    const index = this.bones.get(`bip01${side}finger1`), pinky = this.bones.get(`bip01${side}finger4`);
    if (!hand?.parent || !middle || !index || !pinky) return;
    this.root.updateWorldMatrix(true, true);
    const forward = middle.getWorldPosition(new THREE.Vector3()).sub(hand.getWorldPosition(new THREE.Vector3())).normalize();
    const across = pinky.getWorldPosition(new THREE.Vector3()).sub(index.getWorldPosition(new THREE.Vector3()));
    across.addScaledVector(forward, -across.dot(forward)).normalize();
    const normal = new THREE.Vector3().crossVectors(forward, across).normalize();
    const source = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, normal, forward));
    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion()), sign = side === 'l' ? 1 : -1;
    const target = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(sign, 0, 0).applyQuaternion(rootQ), new THREE.Vector3(0, sign, 0).applyQuaternion(rootQ), new THREE.Vector3(0, 0, 1).applyQuaternion(rootQ)));
    const delta = new THREE.Quaternion().slerp(target.multiply(source.invert()), weight);
    const parent = hand.parent.getWorldQuaternion(new THREE.Quaternion());
    hand.quaternion.premultiply(parent.clone().invert().multiply(delta).multiply(parent));
    hand.updateWorldMatrix(true, true);
  }
  setTransition(name: string | null, progress = 0) {
    this.transition = name ? { name, progress } : null;
  }
  update(dt: number, moving: number | boolean = false, seated = false, typing = false, driving = false) {
    if (!this.mixer || !this.model) return;
    const speed = typeof moving === 'number' ? moving : moving ? 1.65 : 0;
    const name =
      this.transition?.name ??
      (seated ? 'sit_chair_idle_neutral_01' : speed > 0.08 ? (speed > 2.5 ? 'run_neutral' : 'walk_neutral') : 'idle_neutral_01');
    const next = this.actions.get(name) ?? this.actions.get('idle_neutral_01');
    if (next && name !== this.motion) {
      const old = this.current;
      const locomotion = (n: string) => n === 'walk_neutral' || n === 'run_neutral';
      const phase = old && locomotion(this.motion) && locomotion(name) ? (old.time / old.getClip().duration) % 1 : 0;
      next.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();
      next.time = phase * next.getClip().duration;
      next.paused = false;
      next.setLoop(THREE.LoopRepeat, Infinity);
      if (old && old !== next) old.crossFadeTo(next, this.transition ? 0.16 : 0.22, false);
      this.current = next;
      this.motion = name;
    }
    if (this.current) {
      if (this.transition) {
        this.current.setLoop(THREE.LoopOnce, 1);
        this.current.clampWhenFinished = true;
        this.current.paused = true;
        this.current.time = Math.min(0.9999, Math.max(0, this.transition.progress)) * this.current.getClip().duration;
      } else {
        this.current.paused = false;
        this.current.setEffectiveTimeScale(
          name === 'walk_neutral' ? Math.max(0.15, speed / 1.45) : name === 'run_neutral' ? Math.max(0.3, speed / 3.8) : 1,
        );
      }
    }
    this.mixer.update(dt);
    if (driving) {
      this.placeHand('l', .13, .9, .57);
      this.placeHand('r', -.13, .9, .57);
    }
    this.gestureTime += dt;
    this.typingBlend = THREE.MathUtils.damp(this.typingBlend, typing && seated && !driving ? 1 : 0, 5, dt);
    this.model.position.z = this.seatedBaseZ + this.typingBlend * .18;
    if (this.typingBlend > .005) {
      this.rotate('bip01spine', this.typingBlend * .1);
      const t = this.gestureTime;
      // Elbows solve toward the keyboard in world space, with short thinking pauses and individual finger taps.
      const burst = Math.sin(t * .72) > -.45 ? 1 : .12;
      for (const [side, sign] of [['l', 1], ['r', -1]] as const) {
        this.placeHand(side, sign * (.15 + Math.sin(t * 1.6 + sign) * .025), .82 + Math.sin(t * 8 + sign) * .006 * burst, .53, this.typingBlend);
        this.alignTypingHand(side, this.typingBlend);
        for (let finger = 1; finger <= 4; finger++) {
          const bone = this.bones.get(`bip01${side}finger${finger}1`);
          if (bone) bone.rotation.z += Math.max(0, Math.sin(t * (8 + finger) + finger * 2 + sign)) * .18 * burst * this.typingBlend;
        }
      }
    }
    // Small upper-body balance during a turn; recorded pelvis, knee and foot tracks remain intact.
    const yaw = this.root.parent?.rotation.y ?? 0;
    const yawSpeed = this.lastYaw === undefined ? 0 : Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw)) / Math.max(dt, .001);
    this.lastYaw = yaw;
    this.turnLean = THREE.MathUtils.damp(this.turnLean, !seated && speed > .4 ? THREE.MathUtils.clamp(-yawSpeed * .015, -.07, .07) : 0, 6, dt);
    this.model.rotation.z = this.turnLean;
    this.root.userData.motion = typing && seated ? 'seated-keyboard' : name;
    // The source clips contain hip settling, knee flexion and planted heel/toe motion.
    // No synthetic thigh or calf rotations are added on top of recorded locomotion.
    if (this.reachRemaining > 0 && !seated) {
      this.reachRemaining = Math.max(0, this.reachRemaining - dt);
      const reach = Math.sin((1 - this.reachRemaining / 0.6) * Math.PI);
      this.rotate('bip01rupperarm', -reach * 0.7);
      this.rotate('bip01rforearm', -reach * 0.45);
    }
  }
  dispose() {
    this.disposed = true;
    this.mixer?.stopAllAction();
    this.root.clear();
  }
}

/** Evaluate the skeleton before normalizing its dimensions to human scale. */
export function prepareHumanModel(model: THREE.Object3D, animations: THREE.AnimationClip[]) {
  // The cloned Rocketbox skeleton must be evaluated before measuring a skinned mesh.
  // Measuring stale bone matrices produces a centimetre-high bound and a 100x giant.
  const mixer = new THREE.AnimationMixer(model);
  const idle = animations.find((a) => a.name === 'idle_neutral_01') ?? animations[0];
  if (idle) mixer.clipAction(idle).play();
  mixer.update(0);
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) {
      o.skeleton.update();
      o.computeBoundingBox();
    }
  });
  const bounds = new THREE.Box3().setFromObject(model),
    height = bounds.max.y - bounds.min.y;
  const scale = 1.78 / Math.max(height, 0.01),
    center = bounds.getCenter(new THREE.Vector3());
  model.scale.setScalar(scale);
  model.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
  return mixer;
}
