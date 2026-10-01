import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

const assets = new Map<string, Promise<GLTF>>();
export type VehiclePose = { phase: 'reach' | 'enter' | 'exit' | 'drive'; progress: number; steering?: number; handle?: THREE.Vector3; feet?: { l: THREE.Vector3; r: THREE.Vector3 } };
/**
 * A procedural layer over the recorded clips for a worker using an office amenity. It is only
 * ever set by the routine controller from a real server state (see routines.ts).
 */
export type HumanActivity = 'none' | 'bike' | 'weights' | 'stretch' | 'coffee' | 'eat';
function source(url: string) {
  if (!assets.has(url)) assets.set(url, new GLTFLoader().loadAsync(url).then((gltf) => { guardHumanMaterials(gltf.scene); return gltf; }));
  return assets.get(url)!;
}

/** Map slots a glTF metallic-roughness material can carry; all are copied when a texture repair arrives. */
const MAP_SLOTS = ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'aoMap', 'alphaMap', 'emissiveMap'] as const;
type HumanMaterial = THREE.MeshStandardMaterial;
function humanMaterials(root: THREE.Object3D): HumanMaterial[] {
  const out = new Set<HumanMaterial>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if ((mat as HumanMaterial).isMeshStandardMaterial) out.add(mat as HumanMaterial);
  });
  return [...out];
}
/**
 * Every material on both licensed rigs carries a base-colour texture (models.test.ts). One without it, or whose
 * image never decoded, is a texture that failed: GLTFLoader logs it and builds the material without the map.
 */
export function missingHumanTextures(root: THREE.Object3D): string[] {
  return humanMaterials(root).filter((m) => !m.map || !m.map.image).map((m) => m.name || '(unnamed)');
}
/**
 * glTF's metallicFactor defaults to 1, scaled by the ORM texture's blue channel. When that texture fails to
 * decode the skin and clothes become pure metal, which reflects only the sky lighting: before (or without) the
 * environment the player renders as a black silhouette. People are dielectric, so without a metalness map the
 * material is made non-metal (and, without its colour map, a neutral fabric tone instead of black).
 */
export function guardHumanMaterials(root: THREE.Object3D) {
  for (const m of humanMaterials(root)) {
    if (!m.metalnessMap && m.metalness > 0) { m.metalness = 0; m.needsUpdate = true; }
    if (!m.map && !m.userData.fallbackTone) { m.color.set('#9a8f84'); m.userData.fallbackTone = true; m.needsUpdate = true; }
  }
}
/** Copies the decoded textures and factors of a fresh load into the shared materials that every clone uses. */
export function repairHumanMaterials(target: THREE.Object3D, fresh: THREE.Object3D): number {
  const byName = new Map(humanMaterials(fresh).map((m) => [m.name, m]));
  let repaired = 0;
  for (const m of humanMaterials(target)) {
    const good = byName.get(m.name);
    if (!good || !good.map?.image) continue;
    for (const slot of MAP_SLOTS) (m as unknown as Record<string, THREE.Texture | null>)[slot] = good[slot];
    m.color.copy(good.color);
    m.metalness = good.metalness;
    m.roughness = good.roughness;
    delete m.userData.fallbackTone;
    m.needsUpdate = true; // the map defines change the shader program
    repaired++;
  }
  return repaired;
}
const repairs = new Map<string, Promise<boolean>>();
/**
 * A rig whose embedded textures failed (seen on iOS on first launch) is loaded again, at most twice. Fixed
 * textures are copied into the shared materials in place, so bodies already in the scene update too.
 */
function repairSource(url: string, gltf: GLTF): Promise<boolean> {
  if (!repairs.has(url)) {
    repairs.set(url, (async () => {
      for (const delay of [1500, 5000]) {
        await new Promise((r) => setTimeout(r, delay));
        try {
          const fresh = await new GLTFLoader().loadAsync(url);
          repairHumanMaterials(gltf.scene, fresh.scene);
          if (!missingHumanTextures(gltf.scene).length) return true;
        } catch (error) {
          console.warn('Human textures could not be reloaded', error);
        }
      }
      return false;
    })());
  }
  return repairs.get(url)!;
}

/**
 * Normalized run_neutral phase where both feet are off the floor (the flight part of a stride,
 * measured on both rigs in models.test.ts). A held frame of it is the airborne base pose.
 */
export const RUN_FLIGHT_PHASE = 0.16;
/** Walk → run above this speed (m/s); run → walk below RUN_EXIT. The gap stops flicker at the boundary. */
export const RUN_ENTER = 2.7;
export const RUN_EXIT = 2.3;
/** A fall shorter than this is a step or a stair edge: no airborne pose and no landing dip. */
const MIN_FLIGHT = 0.12;
const LANDING_TIME = 0.3;
/** Ankle-bone height above the floor when standing, on both rigs (models.test.ts). */
const ANKLE = 0.1;
const FLIGHT = 'airborne_flight';

/** Which recorded clip a grounded, standing body plays at this speed, with hysteresis between walk and run. */
export function locomotionClip(speed: number, previous: string): 'idle_neutral_01' | 'walk_neutral' | 'run_neutral' {
  if (speed <= 0.08) return 'idle_neutral_01';
  return (previous === 'run_neutral' ? speed > RUN_EXIT : speed > RUN_ENTER) ? 'run_neutral' : 'walk_neutral';
}

/** Landing dip (m) over normalized landing time u: a quick drop, then an eased recovery. */
export function landingDip(u: number, depth: number): number {
  if (u <= 0 || u >= 1) return 0;
  if (u < 0.3) return depth * Math.sin((u / 0.3) * Math.PI / 2);
  const v = (u - 0.3) / 0.7;
  return depth * (1 - v * v * (3 - 2 * v));
}

// Scratch objects: the per-frame pose layers below allocate nothing.
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _axis = new THREE.Vector3();
const _feet = [new THREE.Vector3(), new THREE.Vector3()];
const _pedal = new THREE.Vector3();

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
  private vehiclePose: VehiclePose | null = null;
  private bonePose?: Map<string, THREE.Quaternion>;
  // Airborne state. Every field below tolerates `undefined`: models.test.ts builds bare instances.
  private airborneInput?: boolean;
  private landingGrace?: number;
  private airTime?: number;
  private inFlight?: boolean;
  private groundedFor?: number;
  private air?: number;
  private vy?: number;
  private minVy?: number;
  private lastRootY?: number;
  private landing?: number;
  private landingDepth?: number;
  private baseY?: number;
  private activity?: HumanActivity;
  private activityBlend?: number;
  private detail?: boolean;
  private props?: Map<string, THREE.Object3D>;
  /** True once the body is loaded with every texture decoded (false while a failed texture is being reloaded). */
  get materialsReady(): boolean {
    return this.ready && !!this.model && !missingHumanTextures(this.model).length;
  }
  constructor(variant = 0) {
    this.root.name = 'Realistic human';
    const url = variant % 2 ? '/models/chief-of-staff.glb' : '/models/founder.glb';
    void source(url)
      .then((gltf) => {
        if (this.disposed) return;
        if (missingHumanTextures(gltf.scene).length) {
          this.root.userData.textureError = true;
          void repairSource(url, gltf).then((ok) => { if (ok) delete this.root.userData.textureError; });
        }
        const model = clone(gltf.scene);
        this.mixer = prepareHumanModel(model, gltf.animations);
        for (const clip of gltf.animations) this.actions.set(clip.name, this.mixer.clipAction(clip));
        // A second action on the run clip holds the flight frame while the stride action keeps its own time.
        const run = gltf.animations.find((c) => c.name === 'run_neutral');
        if (run) {
          const flight = run.clone();
          flight.name = FLIGHT;
          this.actions.set(FLIGHT, this.mixer.clipAction(flight));
        }
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
        this.baseY = model.position.y;
        this.ready = true;
      })
      .catch((error) => {
        console.warn('Human model could not load', error);
        this.root.userData.assetError = true;
      });
  }
  /** Rotate a bone about one of the model's own axes (0 lateral, 1 up, 2 forward), expressed in the bone parent's space. */
  private rotate(name: string, angle: number, axisIndex: 0 | 1 | 2 = 0) {
    const bone = this.bones.get(name);
    if (!bone || !this.model || !angle) return;
    // Rotate around the model's axis in the bone parent's space, regardless of source rig axes.
    bone.parent!.updateWorldMatrix(true, false);
    this.model.getWorldQuaternion(_q);
    _axis.set(axisIndex === 0 ? 1 : 0, axisIndex === 1 ? 1 : 0, axisIndex === 2 ? 1 : 0)
      .applyQuaternion(_q)
      .applyQuaternion(bone.parent!.getWorldQuaternion(_q2).invert());
    bone.quaternion.premultiply(_q3.setFromAxisAngle(_axis, angle)).normalize();
  }
  reach() {
    this.reachRemaining = 0.6;
  }
  /** Airborne (jumping or falling) as the caller's physics sees it. `grace` absorbs a brief false "grounded" from interpolated peers. */
  setAirborne(airborne: boolean, grace = 0) {
    this.airborneInput = airborne;
    this.landingGrace = grace;
  }
  /** Procedural amenity layer; `detail` false skips the IK-heavy parts (low quality preset). */
  setActivity(activity: HumanActivity, detail = true) {
    this.activity = activity;
    this.detail = detail;
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
  setVehiclePose(pose: VehiclePose | null) { this.vehiclePose = pose; }
  /** Two-bone foot IK toward a root-local target; allocation-free. */
  private placeFoot(side: 'l' | 'r', target: THREE.Vector3, weight: number, iterations = 8) {
    const foot = this.bones.get(`bip01${side}foot`);
    if (!foot) return;
    this.root.updateWorldMatrix(true, true);
    const goal = foot.getWorldPosition(_v3).lerp(this.root.localToWorld(_v2.copy(target)), weight);
    for (let i = 0; i < iterations; i++) for (const part of ['calf', 'thigh']) {
      const bone = this.bones.get(`bip01${side}${part}`);
      if (!bone?.parent) continue;
      const origin = bone.getWorldPosition(_v);
      const from = foot.getWorldPosition(_v2).sub(origin).normalize();
      _q.setFromUnitVectors(from, _axis.copy(goal).sub(origin).normalize());
      bone.parent.getWorldQuaternion(_q2);
      bone.quaternion.premultiply(_q3.copy(_q2).invert().multiply(_q).multiply(_q2)); bone.updateWorldMatrix(true, true);
    }
  }
  /** Track airborne time, vertical speed and landings; returns whether the flight pose applies. */
  private updateFlight(dt: number): boolean {
    const y = this.root.getWorldPosition(_v).y;
    let rising = false;
    if (dt > 0 && this.lastRootY !== undefined) {
      const raw = (y - this.lastRootY) / dt;
      this.vy = THREE.MathUtils.damp(this.vy ?? 0, raw, 18, dt);
      // A take-off shows on its first frame, however long that frame was.
      rising = raw > 1;
    }
    this.lastRootY = y;
    const airborne = !!this.airborneInput;
    if (airborne) {
      this.airTime = (this.airTime ?? 0) + dt;
      this.groundedFor = 0;
      this.minVy = Math.min(this.minVy ?? 0, this.vy ?? 0);
    } else this.groundedFor = (this.groundedFor ?? 0) + dt;
    const airTime = this.airTime ?? 0;
    // Latched for the rest of this flight once it counts, so the pose never flickers back to a clip.
    const took = (this.inFlight ||= airTime > MIN_FLIGHT || (airborne && (rising || (this.vy ?? 0) > 1)));
    if (!airborne && airTime > 0 && (this.groundedFor ?? 0) >= (this.landingGrace ?? 0)) {
      // Touchdown: a real flight earns a dip proportional to how fast it came down.
      if (airTime > MIN_FLIGHT) {
        this.landing = LANDING_TIME;
        this.landingDepth = THREE.MathUtils.clamp(-(this.minVy ?? 0) * 0.011, 0.03, 0.085);
      }
      this.airTime = 0;
      this.minVy = 0;
      this.inFlight = false;
      return false;
    }
    return took && airTime > 0;
  }
  update(dt: number, moving: number | boolean = false, seated = false, typing = false, driving = false) {
    if (!this.mixer || !this.model) return;
    const speed = typeof moving === 'number' ? moving : moving ? 1.65 : 0;
    const flying = !seated && !driving && !this.transition && this.updateFlight(dt);
    const name =
      this.transition?.name ??
      (seated ? 'sit_chair_idle_neutral_01' : flying && this.actions.has(FLIGHT) ? FLIGHT : locomotionClip(speed, this.motion));
    const next = this.actions.get(name) ?? this.actions.get('idle_neutral_01');
    if (next && name !== this.motion) {
      const old = this.current;
      const locomotion = (n: string) => n === 'walk_neutral' || n === 'run_neutral';
      // Walk and run share foot contacts at the same normalized phase, so switching keeps the stride.
      const phase = old && locomotion(this.motion) && locomotion(name) ? (old.time / old.getClip().duration) % 1
        : this.motion === FLIGHT && locomotion(name) ? 0.45 : name === FLIGHT ? RUN_FLIGHT_PHASE : 0;
      next.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();
      next.time = phase * next.getClip().duration;
      next.paused = false;
      next.setLoop(THREE.LoopRepeat, Infinity);
      const fade = this.transition ? 0.16 : name === FLIGHT ? 0.12 : this.motion === FLIGHT ? 0.08 : locomotion(name) && locomotion(this.motion) ? 0.3 : 0.22;
      if (old && old !== next) old.crossFadeTo(next, fade, false);
      this.current = next;
      this.motion = name;
    }
    if (this.current) {
      if (this.transition) {
        this.current.setLoop(THREE.LoopOnce, 1);
        this.current.clampWhenFinished = true;
        this.current.paused = true;
        this.current.time = Math.min(0.9999, Math.max(0, this.transition.progress)) * this.current.getClip().duration;
      } else if (name === FLIGHT) {
        // Held, not played: a stride frame with both feet up. The layer below tucks it by vertical speed.
        this.current.paused = true;
        this.current.time = RUN_FLIGHT_PHASE * this.current.getClip().duration;
      } else {
        this.current.paused = false;
        this.current.setEffectiveTimeScale(
          name === 'walk_neutral' ? Math.max(0.15, speed / 1.45) : name === 'run_neutral' ? Math.max(0.3, speed / 3.8) : 1,
        );
      }
    }
    // Mixer bindings skip unchanged values on a held frame. Restore the last clean pose so
    // IK and posture offsets never accumulate, even when a transition is paused for review.
    this.bonePose?.forEach((q, name) => this.bones.get(name)?.quaternion.copy(q));
    this.mixer.update(dt);
    this.bonePose ??= new Map();
    this.bones.forEach((bone, name) => {
      if (!this.bonePose!.has(name)) this.bonePose!.set(name, new THREE.Quaternion());
      this.bonePose!.get(name)!.copy(bone.quaternion);
    });
    if (driving) {
      const turn = (this.vehiclePose?.steering ?? 0) * 2.4;
      for (const [side, sign] of [['l', 1], ['r', -1]] as const) {
        this.placeHand(side, sign * .145 * Math.cos(turn), .80 + sign * .145 * Math.sin(turn), .57);
        this.placeFoot(side, _pedal.set(sign * .13, .22, .62), 1);
      }
    }
    const car = this.vehiclePose;
    if (car && car.phase !== 'drive') {
      const u = THREE.MathUtils.clamp(car.progress, 0, 1);
      if (car.phase === 'reach' && car.handle) {
        const target = this.root.worldToLocal(car.handle.clone());
        this.placeHand('r', target.x, target.y, target.z, Math.sin(Math.PI * Math.min(1, u) * .85));
      } else {
        const seat = car.phase === 'enter' ? u : 1 - u;
        this.rotate('bip01spine', Math.sin(Math.PI * seat) * .28);
        this.rotate('bip01head', Math.sin(Math.PI * seat) * .12);
        // Right leg enters first, then the left clears the sill; reverse order on exit.
        if (car.feet) for (const side of ['l', 'r'] as const) this.placeFoot(side, this.root.worldToLocal(car.feet[side].clone()), 1);
        else {
          this.placeFoot('r', _pedal.set(-.13, .22, .62), THREE.MathUtils.smoothstep(seat, .30, .72));
          this.placeFoot('l', _pedal.set(.13, .22, .62), THREE.MathUtils.smoothstep(seat, .64, .98));
        }
      }
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
    this.flightLayer(dt, flying);
    this.activityLayer(dt, seated && !driving);
    // Small upper-body balance during a turn; recorded pelvis, knee and foot tracks remain intact.
    const yaw = this.root.parent?.rotation.y ?? 0;
    const yawSpeed = this.lastYaw === undefined ? 0 : Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw)) / Math.max(dt, .001);
    this.lastYaw = yaw;
    this.turnLean = THREE.MathUtils.damp(this.turnLean, !seated && !flying && speed > .4 ? THREE.MathUtils.clamp(-yawSpeed * .015, -.07, .07) : 0, 6, dt);
    this.model.rotation.z = this.turnLean;
    this.root.userData.motion = typing && seated ? 'seated-keyboard' : flying ? 'airborne' : (this.landing ?? 0) > 0 ? 'landing' : name;
    // The source clips contain hip settling, knee flexion and planted heel/toe motion.
    // No synthetic thigh or calf rotations are added on top of recorded locomotion.
    if (this.reachRemaining > 0 && !seated) {
      this.reachRemaining = Math.max(0, this.reachRemaining - dt);
      const reach = Math.sin((1 - this.reachRemaining / 0.6) * Math.PI);
      this.rotate('bip01rupperarm', -reach * 0.7);
      this.rotate('bip01rforearm', -reach * 0.45);
    }
  }
  /**
   * Airborne and landing layer. In the air the held flight frame gets its knees drawn up while
   * rising and reaching down for the floor while falling, with the arms lifted for balance. On
   * touchdown the hips drop and recover while foot IK keeps both feet planted.
   */
  private flightLayer(dt: number, flying: boolean) {
    const model = this.model!;
    this.baseY ??= model.position.y;
    this.air = THREE.MathUtils.damp(this.air ?? 0, flying ? 1 : 0, flying ? 16 : 60, dt);
    const air = this.air;
    if (air > .005) {
      const rise = THREE.MathUtils.clamp((this.vy ?? 0) / 6.4, -1, 1);
      // Knees come up most on the way up and straighten toward the landing.
      const tuck = air * THREE.MathUtils.clamp(0.55 + 0.35 * rise, 0.15, 0.9);
      this.rotate('bip01lthigh', -0.55 * tuck);
      this.rotate('bip01rthigh', -0.35 * tuck);
      this.rotate('bip01lcalf', 0.95 * tuck);
      this.rotate('bip01rcalf', 0.8 * tuck);
      this.rotate('bip01spine', 0.08 * air);
      // Arms lift forward and out, a little higher at take-off.
      const lift = air * (0.32 + 0.18 * Math.max(0, rise));
      this.rotate('bip01lupperarm', -lift);
      this.rotate('bip01rupperarm', -lift * 0.8);
      this.rotate('bip01lupperarm', lift * 0.6, 2);
      this.rotate('bip01rupperarm', -lift * 0.6, 2);
    }
    let dip = 0;
    if ((this.landing ?? 0) > 0 && !flying) {
      this.landing = Math.max(0, this.landing! - dt);
      dip = landingDip(1 - this.landing / LANDING_TIME, this.landingDepth ?? 0.05);
    } else if (flying) this.landing = 0;
    if (dip > 0.001) {
      // Record where the feet are, lower the hips, then bend the knees to keep the feet there.
      this.root.updateWorldMatrix(true, true);
      const feet = ['l', 'r'] as const;
      feet.forEach((side, i) => {
        const foot = this.bones.get(`bip01${side}foot`);
        // Planted on the floor, even while the flight pose is still fading out of the first frames.
        if (foot) this.root.worldToLocal(foot.getWorldPosition(_feet[i])).y = ANKLE;
      });
      model.position.y = this.baseY - dip;
      this.rotate('bip01spine', dip * 2.2);
      // Seed a forward knee bend of the right size (a near-straight chain barely bends under CCD), then solve.
      const bend = Math.sqrt((2 * dip) / 0.85);
      for (const side of feet) {
        this.rotate(`bip01${side}thigh`, -bend);
        this.rotate(`bip01${side}calf`, 2 * bend);
      }
      feet.forEach((side, i) => this.placeFoot(side, _feet[i], 1, 16));
    } else model.position.y = this.baseY;
  }
  /** Amenity poses, blended in and out so arriving and leaving never pops. */
  private activityLayer(dt: number, seated: boolean) {
    const activity = this.activity ?? 'none';
    const target = activity === 'none' ? 0 : 1;
    this.activityBlend = THREE.MathUtils.damp(this.activityBlend ?? 0, target, 4, dt);
    const w = this.activityBlend;
    this.showProp('cup', activity === 'coffee' && w > .5);
    this.showProp('dumbbell-l', activity === 'weights' && w > .5);
    this.showProp('dumbbell-r', activity === 'weights' && w > .5);
    if (w < .005 || activity === 'none') return;
    const t = this.gestureTime, detail = this.detail !== false;
    switch (activity) {
      case 'bike': {
        if (!seated) break;
        // Pedal circles under the saddle, hands on the bars. Geometry: amenities.ts (bike).
        if (detail) {
          for (const [side, sign, phase] of [['l', 1, 0], ['r', -1, Math.PI]] as const) {
            const a = t * 5.2 + phase;
            this.placeFoot(side, _pedal.set(sign * .12, .03 + Math.sin(a) * .15, .22 + Math.cos(a) * .15), w);
          }
          for (const [side, sign] of [['l', 1], ['r', -1]] as const) this.placeHand(side, sign * .22, .74, .52, w);
        }
        this.rotate('bip01spine', .22 * w);
        break;
      }
      case 'weights': {
        // Alternating curls: forearms swing up about the elbow.
        const l = Math.max(0, Math.sin(t * 1.9)), r = Math.max(0, Math.sin(t * 1.9 + Math.PI));
        this.rotate('bip01lforearm', -1.9 * l * w);
        this.rotate('bip01rforearm', -1.9 * r * w);
        break;
      }
      case 'stretch': {
        // Slow overhead reach and release.
        const s = (0.5 - 0.5 * Math.cos(t * 0.7)) * w;
        this.rotate('bip01lupperarm', -2.5 * s);
        this.rotate('bip01rupperarm', -2.5 * s);
        this.rotate('bip01spine', -.12 * s);
        break;
      }
      case 'coffee': {
        // Cup held at the chest; a sip every few seconds.
        const sip = Math.max(0, Math.sin(t * 0.9) - 0.8) / 0.2;
        this.rotate('bip01rupperarm', -(0.25 + 0.35 * sip) * w);
        this.rotate('bip01rforearm', -(1.35 + 0.5 * sip) * w);
        this.placeProp('cup', 'r');
        break;
      }
      case 'eat': {
        if (!seated) break;
        if (detail) for (const [side, sign] of [['l', 1], ['r', -1]] as const) this.placeHand(side, sign * .17, .8, .42, .85 * w);
        const bite = Math.max(0, Math.sin(t * 0.8) - 0.75) / 0.25;
        this.rotate('bip01rforearm', -1.1 * bite * w);
        this.rotate('bip01head', .12 * w);
        break;
      }
    }
    if (activity === 'weights') {
      this.placeProp('dumbbell-l', 'l');
      this.placeProp('dumbbell-r', 'r');
    }
  }
  private prop(name: string): THREE.Object3D {
    this.props ??= new Map();
    let p = this.props.get(name);
    if (!p) {
      p = new THREE.Group();
      p.name = `prop:${name}`;
      if (name === 'cup') {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(.042, .034, .1, 12), new THREE.MeshStandardMaterial({ color: '#f1eee6', roughness: .4 }));
        const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(.044, .04, .045, 12), new THREE.MeshStandardMaterial({ color: '#8a6a4a', roughness: .9 }));
        cup.position.y = sleeve.position.y = .04;
        p.add(cup, sleeve);
      } else {
        const iron = new THREE.MeshStandardMaterial({ color: '#2b3033', roughness: .45, metalness: .6 });
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(.014, .014, .2, 8), iron);
        bar.rotation.z = Math.PI / 2;
        p.add(bar);
        for (const x of [-.09, .09]) {
          const plate = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, .04, 12), iron);
          plate.rotation.z = Math.PI / 2;
          plate.position.x = x;
          p.add(plate);
        }
      }
      p.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });
      p.visible = false;
      this.root.add(p);
      this.props.set(name, p);
    }
    return p;
  }
  private showProp(name: string, visible: boolean) {
    const p = this.props?.get(name);
    if (p) p.visible = visible;
    else if (visible) this.prop(name).visible = true;
  }
  /** Keep a prop in the palm (between wrist and middle finger), upright in the body's frame. */
  private placeProp(name: string, side: 'l' | 'r') {
    const hand = this.bones.get(`bip01${side}hand`), finger = this.bones.get(`bip01${side}finger2`);
    if (!hand || !finger) return;
    const p = this.prop(name);
    this.root.updateWorldMatrix(true, true);
    hand.getWorldPosition(_v).lerp(finger.getWorldPosition(_v2), .5);
    p.position.copy(this.root.worldToLocal(_v));
    if (name === 'cup') p.position.y -= .03;
  }
  dispose() {
    this.disposed = true;
    this.mixer?.stopAllAction();
    this.props?.forEach((p) => p.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } }));
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
