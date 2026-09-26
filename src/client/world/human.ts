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
  private gait = 0;
  private blend = 0;
  private reachRemaining = 0;
  constructor(variant = 0) {
    this.root.name = 'Realistic human';
    void source(variant % 2 ? '/models/chief-of-staff.glb' : '/models/founder.glb')
      .then((gltf) => {
        if (this.disposed) return;
        const model = clone(gltf.scene);
        this.mixer = prepareHumanModel(model, gltf.animations);
        model.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
          if (o instanceof THREE.Bone) this.bones.set(o.name.replace(/[^a-z0-9]/gi, '').toLowerCase(), o);
        });
        this.root.add(model);
        this.model = model;
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
  update(dt: number, moving = false, seated = false, typing = false) {
    this.mixer?.update(dt);
    this.gait += dt * 7.5;
    this.blend = THREE.MathUtils.damp(this.blend, moving ? 1 : 0, 9, dt);
    if (!this.model) return;
    if (seated) {
      this.root.position.y = -0.48;
      this.rotate('bip01lthigh', -1.48);
      this.rotate('bip01rthigh', -1.48);
      this.rotate('bip01lcalf', 1.45);
      this.rotate('bip01rcalf', 1.45);
      this.rotate('bip01lupperarm', -0.6);
      this.rotate('bip01rupperarm', -0.6);
      this.rotate('bip01lforearm', -0.9 + (typing ? Math.sin(this.gait * 3) * 0.025 : 0));
      this.rotate('bip01rforearm', -0.9 + (typing ? Math.cos(this.gait * 3) * 0.025 : 0));
    } else {
      this.root.position.y = 0;
      const s = Math.sin(this.gait) * this.blend;
      this.rotate('bip01lthigh', s * 0.48);
      this.rotate('bip01rthigh', -s * 0.48);
      this.rotate('bip01lcalf', Math.max(0, -s) * 0.75);
      this.rotate('bip01rcalf', Math.max(0, s) * 0.75);
      this.rotate('bip01lupperarm', -s * 0.3);
      this.rotate('bip01rupperarm', s * 0.3);
    }
    if (this.reachRemaining > 0) {
      this.reachRemaining = Math.max(0, this.reachRemaining - dt);
      const reach = Math.sin((1 - this.reachRemaining / 0.6) * Math.PI);
      this.rotate('bip01rupperarm', -reach * 0.9);
      this.rotate('bip01rforearm', -reach * 0.5);
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
