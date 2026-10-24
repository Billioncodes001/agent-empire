import { Drivetrain, vehicleOverlaps } from './vehicle';
import { SEDAN, type RideSpec } from './rides';
import { Rotorcraft, airframeFloor, airframeTop } from './flight';
import { DEFAULT_KEYS, type KeyBindings, type Action } from './controls';
import { CITY } from '../shared/empire';
import * as THREE from 'three';
import { FLOOR } from '../shared/layout';
import type { ViewMode } from './state';
import type { Collider } from './world/office';

const RADIUS = 0.32;
/** Top of your head above your feet, for walking under the loft. */
const HEIGHT = 1.7;
/** The tallest ledge you walk up (or down) without jumping, like a stair. */
const STEP = 0.3;
const WALK = 1.65;
const RUN = 4.3;
const JUMP_V = 6.4;
const GRAVITY = 18;
/** Camera height above your feet in first person (the Person's eyes). */
export const EYE_HEIGHT = 1.66;
const LOOK_SPEED = 0.0022; // radians per pixel of mouse movement while the pointer is locked
const DRAG_LOOK_SPEED = 0.005;
const CENTER = new THREE.Vector2(0, 0);

export class PlayerController {
  pos = new THREE.Vector3();
  vy = 0;
  facing = Math.PI;
  moving = false;
  speed = 0;
  scripted = false;
  grounded = true;
  /** Heading of the camera. You look along (-sin, -cos) of it on the XZ plane. */
  camYaw = Math.PI * 0.15;
  camPitch = 0.16;
  camDist = 4.6;
  /** First-person look up (+) / down (-). */
  lookPitch = -0.02;
  view: ViewMode = 'first';
  /** Walk cycle phase, shared by the camera bob and the first-person hands. */
  walkPhase = 0;
  private bob = 0;
  /** Eased out after a step up or down, so the camera glides up stairs instead of popping. */
  stepOffset = 0;
  /**
   * A click (not a drag) on the scene, in normalized device coordinates.
   * In first person it is always the crosshair, (0, 0).
   */
  onClick: ((ndc: THREE.Vector2) => void) | null = null;
  private keys = new Set<string>();
  private drag: { x: number; y: number; moved: number; id?: number } | null = null;
  /** Set when this browser won't lock the pointer; first person falls back to drag-to-look. */
  private lockFailed = false;
  private lockPending = false;
  private everLocked = false;
  enabled = true;
  bindings: KeyBindings = { ...DEFAULT_KEYS };
  /** In any vehicle: the sedan, a bought garage car or the helicopter (`ride` says which). */
  driving = false;
  /** The footprint, height and camera offsets of what you drive (CITY-06/08); the sedan's when on foot. */
  ride: RideSpec = SEDAN;
  readonly vehicle = new Drivetrain();
  readonly flight = new Rotorcraft();
  private walkVelocity = new THREE.Vector2();
  // Hold the input basis through automatic camera recentering. Otherwise a held
  // sideways arrow continuously steers itself into a circle as the camera turns.
  private moveYaw = 0;
  private moveChord = '';
  /** Keep finishing a deliberate turn even when a brief key press has ended. */
  private turnTarget: number | null = null;
  private orbitGrace = 0;
  private followPending = false;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    private colliders: Collider[],
  ) {
    camera.rotation.order = 'YXZ';
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      this.keys.add(e.code);
      if (Object.values(this.bindings).includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.clearKeys());

    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (this.view === 'first' && e.pointerType === 'mouse' && !this.lockFailed) {
        if (this.locked) {
          if (e.button === 0) this.onClick?.(CENTER);
          return;
        }
        this.lock();
      }
      // Drag to orbit (third person) or to look around (first person without pointer lock).
      // Track one pointer: a second finger (e.g. on the touch joystick) must not steer the camera.
      this.drag = { x: e.clientX, y: e.clientY, moved: 0, id: e.pointerId };
    });
    window.addEventListener('pointerup', (e) => {
      const d = this.drag;
      if (d && d.id !== e.pointerId) return;
      this.drag = null;
      // A click that captured the mouse is not also a click on the world.
      if (!d || d.moved > 5 || !this.enabled || this.locked || this.lockPending || e.target !== dom) return;
      if (this.view === 'first') this.onClick?.(CENTER);
      else {
        const r = dom.getBoundingClientRect();
        this.onClick?.(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1));
      }
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.enabled) return;
      if (this.locked) {
        // Some platforms report a bogus huge jump right after locking.
        const clamp = (v: number) => THREE.MathUtils.clamp(v, -250, 250);
        this.look(clamp(e.movementX) * LOOK_SPEED, clamp(e.movementY) * LOOK_SPEED);
        return;
      }
      if (!this.drag || this.drag.id !== e.pointerId) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      if (this.view === 'first') this.look(dx * DRAG_LOOK_SPEED, dy * DRAG_LOOK_SPEED);
      else {
        const turn = -dx * 0.006;
        this.camYaw += turn;
        this.moveYaw += turn;
        this.orbitGrace = 1.2;
        this.followPending = false;
        this.camPitch = THREE.MathUtils.clamp(this.camPitch + dy * 0.004, 0.05, 1.3);
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.lockPending = false;
      // A lock that lands after a modal opened (e.g. a relock racing the next modal) is let go.
      if (this.locked && !this.enabled) {
        document.exitPointerLock();
        return;
      }
      if (this.locked) {
        this.everLocked = true;
        this.drag = null;
      }
    });
    document.addEventListener('pointerlockerror', () => {
      this.lockPending = false;
      // Locking right after Esc is refused for a moment; only give up if it never worked.
      if (!this.everLocked) this.lockFailed = true;
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        if (this.enabled && this.view === 'third') this.camDist = THREE.MathUtils.clamp(this.camDist + e.deltaY * 0.01, 2.5, 125);
        e.preventDefault();
      },
      { passive: false },
    );
  }

  get locked(): boolean {
    return document.pointerLockElement === this.dom;
  }

  /** Whether clicking the scene will capture the mouse for looking around. */
  get canLock(): boolean {
    return this.view === 'first' && !this.lockFailed && typeof this.dom.requestPointerLock === 'function';
  }

  setView(view: ViewMode) {
    if (view === this.view) return;
    if (view === 'first') {
      this.lookPitch = -0.02;
      // Enter eye/cockpit view facing forward; changing view never steers a car.
      this.camYaw = this.facing - Math.PI;
    } else {
      // Start the orbit camera behind where you were looking.
      this.camYaw = this.facing - Math.PI;
      this.unlock();
    }
    this.view = view;
    this.orbitGrace = 0;
    this.updateCamera(true);
  }

  unlock() {
    if (this.locked) document.exitPointerLock();
  }

  setAction(action: Action, pressed: boolean) {
    if (pressed && this.enabled) this.keys.add(this.bindings[action]);
    else this.keys.delete(this.bindings[action]);
  }

  get flying() { return this.driving && this.ride.kind === 'helicopter'; }
  get drivingSpeed() { return this.flying ? this.flight.speed : this.vehicle.speed; }

  clearKeys() {
    this.keys.clear();
    this.walkVelocity.set(0, 0);
    this.moveChord = '';
    this.turnTarget = null;
    this.followPending = false;
    this.drag = null;
  }

  /** Captures the mouse for looking around, as the first click on the scene does. */
  lock() {
    if (this.locked || this.lockPending) return;
    if (typeof this.dom.requestPointerLock !== 'function') {
      this.lockFailed = true;
      return;
    }
    this.lockPending = true;
    try {
      // Newer browsers return a promise; older ones report through pointerlockerror.
      const p = this.dom.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {
        this.lockPending = false;
        if (!this.everLocked) this.lockFailed = true;
      });
    } catch {
      this.lockPending = false;
      this.lockFailed = true;
    }
  }

  private look(dx: number, dy: number) {
    this.camYaw -= dx;
    // Only deliberate mouse input changes the held movement basis. Automatic
    // following must not turn a held left/right key into an endless circle.
    this.moveYaw -= dx;
    if (!this.driving) {
      if (this.moveChord && this.turnTarget !== null) {
        this.turnTarget -= dx;
        this.facing -= dx;
      } else {
        this.turnTarget = null;
        this.facing = this.camYaw + Math.PI;
      }
    }
    this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy, -1.45, 1.45);
  }

  update(dt: number) {
    dt = Math.min(dt, 0.05);
    if (dt <= 0) { this.updateCamera(false, 0); return; }
    this.orbitGrace = Math.max(0, this.orbitGrace - dt);
    if (this.scripted) { this.updateCamera(false, dt); return; }
    const before = this.pos.clone();
    const k = this.keys;
    let ix = 0;
    let iz = 0;
    if (this.enabled) {
      if (k.has(this.bindings.forward)) iz -= 1;
      if (k.has(this.bindings.backward)) iz += 1;
      if (k.has(this.bindings.left)) ix -= 1;
      if (k.has(this.bindings.right)) ix += 1;
    }
    this.moving = ix !== 0 || iz !== 0;
    if (this.flying) {
      this.vehicle.stop();
      this.fly(dt, ix, iz);
      this.speed = Math.hypot(this.pos.x - before.x, this.pos.z - before.z) / Math.max(dt, 0.001);
      this.moving = this.speed > 0.04 || !this.flight.landed;
      this.updateCamera(false, dt);
      return;
    }
    // The rotor spins down once the pilot has stepped out.
    if (this.flight.spool > 0) this.flight.update(dt, 0, 0, 0, false, 0);
    if (this.driving) {
      const turn = this.vehicle.update(dt, -iz, ix, k.has(this.bindings.run), this.enabled);
      this.facing += turn;
      const blockedTurn = !!this.blocker(this.pos.x, this.pos.z, this.pos.y);
      if (blockedTurn) this.facing -= turn;
      if (this.view === 'first' && !blockedTurn) this.camYaw += turn;
      const oldX=this.pos.x, oldZ=this.pos.z;
      this.tryMove(oldX + Math.sin(this.facing)*this.vehicle.speed*dt, oldZ);
      this.tryMove(this.pos.x, oldZ + Math.cos(this.facing)*this.vehicle.speed*dt);
      const distance = Math.hypot(this.pos.x-oldX,this.pos.z-oldZ);
      if (distance < .000001) this.vehicle.speed = 0;
      else this.vehicle.speed = Math.sign(this.vehicle.speed) * Math.min(Math.abs(this.vehicle.speed), distance / Math.max(dt, .001));
      this.moving = Math.abs(this.vehicle.speed)>.1;
      const desired = this.facing - Math.PI;
      if(this.view==='third' && !this.drag && this.orbitGrace === 0 && this.camDist < 20) this.followHeading(desired, dt);
    } else this.vehicle.stop();
    if (!this.driving) {
      const input = this.moving;
      const chord = `${ix},${iz}`;
      if (!input) this.moveChord = '';
      else if (chord !== this.moveChord) {
        this.moveYaw = this.camYaw;
        this.moveChord = chord;
      }
      const len = Math.hypot(ix, iz) || 1;
      ix /= len; iz /= len;
      const yaw = this.moveYaw;
      const sin = Math.sin(yaw), cos = Math.cos(yaw);
      const dx = ix * cos + iz * sin, dz = -ix * sin + iz * cos;
      if (input) this.turnTarget = Math.atan2(dx, dz);
      let alignment = 1;
      if (this.turnTarget !== null && this.enabled) {
        const diff = Math.atan2(Math.sin(this.turnTarget - this.facing), Math.cos(this.turnTarget - this.facing));
        this.facing += diff * (1 - Math.exp(-dt * 14));
        // Lead the step with the body turn instead of sliding sideways while
        // the model still faces forward. This also softens a running reversal.
        alignment = Math.max(0, Math.cos(this.turnTarget - this.facing));
        this.followPending = true;
        if (!input && Math.abs(diff) < .001) {
          this.facing = this.turnTarget;
          this.turnTarget = null;
        }
      }
      const speed = k.has(this.bindings.run) ? RUN : WALK;
      // Acceleration, braking and turns preserve stride continuity instead of snapping to full speed.
      const response = input ? 7 : 12;
      this.walkVelocity.x = THREE.MathUtils.damp(this.walkVelocity.x, dx * speed * alignment, response, dt);
      this.walkVelocity.y = THREE.MathUtils.damp(this.walkVelocity.y, dz * speed * alignment, response, dt);
      if (!this.enabled || this.walkVelocity.lengthSq() < .0004) this.walkVelocity.set(0, 0);
      this.tryMove(this.pos.x + this.walkVelocity.x * dt, this.pos.z);
      this.tryMove(this.pos.x, this.pos.z + this.walkVelocity.y * dt);
      if (this.view === 'first' && this.followPending) {
        this.camYaw = this.facing - Math.PI;
        this.followPending = false;
      } else if (this.view === 'third') {
        if (this.followPending && !this.drag && this.orbitGrace === 0 && this.camDist < 20) {
          this.followHeading(this.facing - Math.PI, dt);
        }
      }
    }

    const ground = groundAt(this.colliders, this.pos.x, this.pos.z, this.pos.y);
    const jump = this.enabled && k.has(this.bindings.jump) && !this.driving && this.grounded;
    if (jump) {
      this.vy = JUMP_V;
      this.grounded = false;
    } else if (this.grounded && this.pos.y > ground && this.pos.y - ground <= STEP + 0.02) {
      // Walking down a stair: stay on your feet rather than falling a step.
      this.stepOffset += this.pos.y - ground;
      this.pos.y = ground;
    }
    this.vy -= GRAVITY * dt;
    this.pos.y += this.vy * dt;
    if (this.pos.y <= ground) {
      this.pos.y = ground;
      this.vy = 0;
      this.grounded = true;
    } else if (this.pos.y > ground + 0.02) {
      this.grounded = false;
    }
    const ceiling = ceilingAt(this.colliders, this.pos.x, this.pos.z, this.pos.y);
    if (this.pos.y + HEIGHT > ceiling) {
      this.pos.y = Math.max(ground, ceiling - HEIGHT);
      this.vy = Math.min(this.vy, 0);
    }
    this.stepOffset *= Math.exp(-dt * 16);
    this.speed = Math.hypot(this.pos.x-before.x,this.pos.z-before.z)/Math.max(dt,.001);
    this.moving = this.speed > .04;
    const walking = this.moving && this.grounded && !this.driving;
    this.walkPhase += walking ? dt*this.speed*Math.PI*2/(this.speed>2.5?2.9:1.55) : 0;
    const bob = walking ? Math.abs(Math.sin(this.walkPhase)) * 0.035 : 0;
    this.bob += (bob - this.bob) * Math.min(1, dt * 18);
    this.updateCamera(false, dt);
  }

  /** CITY-08: the helicopter. Horizontal collision as for cars; vertical between the floor beneath and the ceiling. */
  private fly(dt: number, ix: number, iz: number) {
    const k = this.keys, f = this.flight, half = this.ride.half;
    const lift = this.enabled ? (k.has(this.bindings.jump) ? 1 : 0) - (k.has(this.bindings.run) ? 1 : 0) : 0;
    const below = airframeFloor(this.colliders, this.pos.x, this.pos.z, this.facing, half, this.pos.y);
    const turn = f.update(dt, -iz, ix, lift, true, this.pos.y - below);
    if (turn) {
      this.facing += turn;
      if (this.blocker(this.pos.x, this.pos.z, this.pos.y)) this.facing -= turn;
      else if (this.view === 'first') this.camYaw += turn;
    }
    const oldX = this.pos.x, oldZ = this.pos.z;
    this.tryMove(oldX + Math.sin(this.facing) * f.speed * dt, oldZ);
    this.tryMove(this.pos.x, oldZ + Math.cos(this.facing) * f.speed * dt);
    const distance = Math.hypot(this.pos.x - oldX, this.pos.z - oldZ);
    f.speed = distance < 1e-6 ? 0 : Math.sign(f.speed) * Math.min(Math.abs(f.speed), distance / Math.max(dt, 0.001));
    const floor = airframeFloor(this.colliders, this.pos.x, this.pos.z, this.facing, half, this.pos.y);
    const top = airframeTop(this.colliders, this.pos.x, this.pos.z, this.facing, half, this.pos.y, this.ride.height);
    let y = this.pos.y + f.vy * dt;
    if (y <= floor) { y = floor; f.vy = Math.max(0, f.vy); }
    if (y >= top) { y = top; f.vy = Math.min(0, f.vy); }
    this.pos.y = y;
    this.vy = 0;
    this.grounded = y - floor < 0.05;
    this.stepOffset = 0;
    if (this.view === 'third' && !this.drag && this.orbitGrace === 0) this.followHeading(this.facing - Math.PI, dt);
  }

  private followHeading(yaw: number, dt: number) {
    const delta = Math.atan2(Math.sin(yaw - this.camYaw), Math.cos(yaw - this.camYaw));
    this.camYaw += delta * (1 - Math.exp(-dt * 3));
    this.followPending = Math.abs(delta) > .001;
  }

  updateCamera(snap = false, dt = 1 / 60) {
    if (this.view === 'first') {
      const e=this.ride.eye;
      const eye=this.driving?new THREE.Vector3(e[0],e[1],e[2]).applyAxisAngle(new THREE.Vector3(0,1,0),this.facing):new THREE.Vector3(0,EYE_HEIGHT+this.bob+this.stepOffset,0);
      this.camera.position.copy(this.pos).add(eye);
      this.camera.rotation.set(this.lookPitch, this.camYaw, 0);
      return;
    }
    const target = new THREE.Vector3(this.pos.x, this.pos.y + this.stepOffset + 1.3, this.pos.z);
    // CITY-08: the chase camera pulls back and tilts down with altitude, bringing the skyline and city into view.
    const flying = this.flying;
    const altitude = flying ? this.pos.y - groundAt(this.colliders, this.pos.x, this.pos.z, this.pos.y) : 0;
    const dist = flying ? Math.min(125, this.camDist + altitude * 0.6) : this.camDist;
    const pitch = flying
      ? Math.max(this.camPitch, 0.16 + THREE.MathUtils.smoothstep(altitude, 4, 80) * 0.62)
      : Math.max(this.camPitch, THREE.MathUtils.smoothstep(this.camDist,14,60)*.88);
    const off = new THREE.Vector3(
      Math.sin(this.camYaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(this.camYaw) * Math.cos(pitch),
    ).multiplyScalar(dist);
    const cam = target.clone().add(off);
    // Keep the camera inside the room so walls never block the view, and under the loft or its roof.
    const m = 0.4;
    const bounds = this.pos.z >= CITY.minZ ? CITY : FLOOR;
    cam.x = THREE.MathUtils.clamp(cam.x, bounds.minX + m - (bounds === CITY ? 35 : 0), bounds.maxX - m + (bounds === CITY ? 35 : 0));
    cam.z = THREE.MathUtils.clamp(cam.z, bounds.minZ + m - (bounds === CITY ? 35 : 0), bounds.maxZ - m + (bounds === CITY ? 35 : 0));
    const floorY = groundAt(this.colliders, this.pos.x, this.pos.z, this.pos.y);
    const roof = ceilingAt(this.colliders, cam.x, cam.z, floorY) - 0.3;
    const above = flying ? Math.max(110, this.pos.y + 80) : this.pos.z >= CITY.minZ ? 110 : 3.5;
    cam.y = THREE.MathUtils.clamp(cam.y, floorY + 0.6, Math.max(floorY + 0.6, Math.min(floorY + above, roof)));
    // Ease first, then resolve occlusion on the actual rendered position. Easing
    // an already-clipped target can otherwise leave the camera behind a wall.
    if (!snap) cam.lerpVectors(this.camera.position, cam, 1 - Math.exp(-dt * 17.26));
    // Pull the shoulder camera forward before it crosses any solid building/furniture face.
    // An explicit district overview (>20m) is intentionally free of street-level occlusion.
    if (dist < 20) {
      const direction = cam.clone().sub(target).normalize();
      const ray = new THREE.Ray(target, direction);
      let distance = cam.distanceTo(target);
      for (const c of this.colliders) {
        if (c.top <= (c.bottom ?? 0)) continue;
        const bounds = new THREE.Box3(new THREE.Vector3(c.minX-.12,c.bottom??0,c.minZ-.12),new THREE.Vector3(c.maxX+.12,c.top,c.maxZ+.12));
        if (bounds.containsPoint(target)) continue;
        const hit=ray.intersectBox(bounds,new THREE.Vector3());
        if(hit)distance=Math.min(distance,Math.max(.35,hit.distanceTo(target)-.18));
      }
      cam.copy(target).addScaledVector(direction,distance);
    }
    this.camera.position.copy(cam);
    this.camera.lookAt(target);
  }

  /** Unit vector the character is facing, on the XZ plane. */
  forward(): THREE.Vector2 {
    return new THREE.Vector2(Math.sin(this.facing), Math.cos(this.facing));
  }

  /** What stands in your way at (x, z) with your feet at `y`, or null. */
  private blocker(x: number, z: number, y: number): Collider | null {
    let hit: Collider | null = null;
    // A vehicle is at least as tall as a person (the sedan keeps the original 1.7 m clearance).
    const tall = this.driving ? Math.max(HEIGHT, this.ride.height) : HEIGHT;
    for (const c of this.colliders) {
      // Stood on top of it, or passing beneath it.
      if (y >= c.top - 0.05 || y + tall <= (c.bottom ?? 0)) continue;
      if (!(this.driving ? vehicleOverlaps(x, z, this.facing, c, this.ride.half) : touches(c, x, z, RADIUS))) continue;
      if (!hit || c.top > hit.top) hit = c;
    }
    return hit;
  }

  private tryMove(x: number, z: number) {
    const bounds = this.pos.z >= CITY.minZ ? CITY : FLOOR;
    const { w, l } = this.ride.half;
    const halfX = this.driving ? Math.abs(Math.cos(this.facing)) * w + Math.abs(Math.sin(this.facing)) * l : RADIUS;
    const halfZ = this.driving ? Math.abs(Math.sin(this.facing)) * w + Math.abs(Math.cos(this.facing)) * l : RADIUS;
    x = THREE.MathUtils.clamp(x, bounds.minX + halfX, bounds.maxX - halfX);
    z = THREE.MathUtils.clamp(z, bounds.minZ + halfZ, bounds.maxZ - halfZ);
    const hit = this.blocker(x, z, this.pos.y);
    if (!hit) {
      this.pos.x = x;
      this.pos.z = z;
      return;
    }
    // A stair: step up onto it if there's room there.
    if (this.driving) return;
    const up = hit.top - this.pos.y;
    if (!this.grounded || up > STEP || this.blocker(x, z, hit.top) || this.pos.y + HEIGHT + up > ceilingAt(this.colliders, x, z, this.pos.y)) return;
    this.pos.set(x, hit.top, z);
    this.stepOffset -= up;
  }
}

/** Whether a body of radius `r` at (x, z) overlaps the collider's footprint. */
function touches(c: Collider, x: number, z: number, r: number): boolean {
  const nx = THREE.MathUtils.clamp(x, c.minX, c.maxX);
  const nz = THREE.MathUtils.clamp(z, c.minZ, c.maxZ);
  return (x - nx) ** 2 + (z - nz) ** 2 < r * r;
}

/** The floor under someone standing at (x, z) with their feet at `y`: the highest top they're on or above. */
export function groundAt(colliders: Collider[], x: number, z: number, y: number): number {
  let g = 0;
  for (const c of colliders) {
    if (c.top > 50 || y < c.top - 0.1 || c.top <= g) continue;
    if (touches(c, x, z, RADIUS)) g = c.top;
  }
  return g;
}

/** The underside of whatever is overhead at (x, z) for feet at `y` (the loft, its roof), or Infinity. */
function ceilingAt(colliders: Collider[], x: number, z: number, y: number): number {
  let top = Infinity;
  for (const c of colliders) {
    const b = c.bottom ?? 0;
    if (b <= y + 0.1 || b >= top) continue;
    if (touches(c, x, z, RADIUS)) top = b;
  }
  return top;
}

export function isTyping(e?: Event): boolean {
  const el = (e?.target as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable || !!el.closest?.('.xterm');
}
