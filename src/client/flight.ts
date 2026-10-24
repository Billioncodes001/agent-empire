/**
 * CITY-08: a simple, forgiving rotorcraft model for the company helicopter, plus the pure safety queries the player
 * controller uses (floor, ceiling, where landing allows an exit). No physics engine: speeds are damped toward the
 * input, so the helicopter hovers when the controls are released.
 *
 * Safety envelope: the airframe never goes below the terrain (y = 0) or the top of whatever solid is beneath it, never
 * above FLIGHT.ceiling, and never into a solid's volume (the controller's horizontal collision). Climbing is always
 * possible below the ceiling, so the helicopter cannot be trapped.
 */
import * as THREE from 'three';
import { HELIPAD } from '../shared/city';
import { vehicleOverlaps, type VehicleMotion } from './vehicle';

export const FLIGHT = {
  /** Highest altitude above the terrain (metres). The tallest district tower is about 49 m. */
  ceiling: 90,
  /** Rotor spin-up before lift-off is possible. */
  spoolSeconds: 2.2,
  cruise: 22,
  reverse: 6,
  climb: 6,
  descend: 5,
  /** Yaw rate at full stick (rad/s). */
  turn: 1.1,
} as const;

type Solid = { minX: number; maxX: number; minZ: number; maxZ: number; top: number; bottom?: number };
type Half = { w: number; l: number };

/** The highest solid top at or below `y` under the airframe's footprint, or the terrain (0). */
export function airframeFloor(solids: readonly Solid[], x: number, z: number, yaw: number, half: Half, y: number): number {
  let floor = 0;
  for (const c of solids) {
    if (c.top <= floor || c.top > y + 1e-6 || c.top <= (c.bottom ?? 0)) continue;
    if (vehicleOverlaps(x, z, yaw, c, half)) floor = c.top;
  }
  return floor;
}

/** The highest `y` the airframe base may reach: the flight ceiling, or an overhang's underside minus the airframe height. */
export function airframeTop(solids: readonly Solid[], x: number, z: number, yaw: number, half: Half, y: number, height: number): number {
  let top: number = FLIGHT.ceiling;
  for (const c of solids) {
    const bottom = c.bottom ?? 0;
    if (bottom <= 0 || c.top <= bottom || bottom < y + height - 1e-6 || bottom - height >= top) continue;
    if (vehicleOverlaps(x, z, yaw, c, half)) top = bottom - height;
  }
  return Math.max(y, top);
}

/**
 * Where the pilot may step out: at street level, or on the rooftop helipad. Never in the air, and never on another
 * roof (there is no way down from a tower roof on foot).
 */
export function landingSpot(pos: { x: number; y: number; z: number }, floor: number): 'street' | 'pad' | null {
  if (pos.y - floor > 0.05) return null;
  if (floor <= 0.15) return 'street';
  const onPad = Math.abs(pos.x - HELIPAD.x) <= HELIPAD.size / 2 && Math.abs(pos.z - HELIPAD.z) <= HELIPAD.size / 2 && Math.abs(floor - HELIPAD.y) < 0.05;
  return onPad ? 'pad' : null;
}

export class Rotorcraft implements VehicleMotion {
  /** Forward airspeed along the heading (m/s); negative is backwards. */
  speed = 0;
  /** Yaw rate (rad/s); negative turns right, matching the car's steering sign. */
  steering = 0;
  throttle = 0;
  braking = false;
  acceleration = 0;
  rpm = 0;
  gear = 1;
  vy = 0;
  /** Rotor speed, 0 (stopped) to 1 (flight rpm). */
  spool = 0;
  landed = true;
  /** Visual attitude: nose down when flying forward, banked into turns (zero under reduced motion in the rig). */
  pitch = 0;
  roll = 0;
  /** Main rotor phase (radians). */
  rotor = 0;

  /**
   * `pedal` forward/back, `turn` right positive, `lift` +1 climb / −1 descend, `running` engine on, `agl` height of the
   * base above what is beneath it. Returns the heading change for this step.
   */
  update(dt: number, pedal: number, turn: number, lift: number, running: boolean, agl: number) {
    const before = this.speed;
    this.spool = THREE.MathUtils.clamp(this.spool + (running ? dt / FLIGHT.spoolSeconds : -dt / 3), 0, 1);
    const airborne = agl > 0.05;
    const ready = running && this.spool >= 1;
    let target = 0;
    if (lift > 0 && ready) target = FLIGHT.climb;
    // Descent eases off close to the ground or roof, so every touchdown is gentle.
    else if (lift < 0 && airborne) target = -Math.min(FLIGHT.descend, Math.max(1.2, agl * 0.9));
    else if (airborne && !ready) target = -2;
    this.vy = THREE.MathUtils.damp(this.vy, target, 3, dt);
    if (!airborne && this.vy < 0) this.vy = 0;
    const flying = airborne || this.vy > 0.01;
    const want = !flying || !ready ? 0 : pedal > 0 ? pedal * FLIGHT.cruise : pedal * FLIGHT.reverse;
    this.speed = THREE.MathUtils.damp(this.speed, want, flying ? 1.2 : 4, dt);
    if (Math.abs(this.speed) < 0.01) this.speed = 0;
    this.steering = THREE.MathUtils.damp(this.steering, flying && ready ? -turn * FLIGHT.turn : 0, 4, dt);
    if (Math.abs(this.steering) < 1e-4) this.steering = 0;
    this.acceleration = (this.speed - before) / Math.max(dt, 0.001);
    this.throttle = Math.min(1, Math.abs(lift) + Math.abs(pedal) * 0.5) * this.spool;
    this.rpm = this.spool > 0 ? 780 + this.spool * 1700 + this.throttle * 300 : 0;
    this.pitch = THREE.MathUtils.damp(this.pitch, flying ? THREE.MathUtils.clamp(-(this.speed / FLIGHT.cruise) * 0.16 - this.acceleration * 0.01, -0.22, 0.12) : 0, 2.5, dt);
    this.roll = THREE.MathUtils.damp(this.roll, flying ? -this.steering * Math.min(1, Math.abs(this.speed) / 8) * 0.22 : 0, 3, dt);
    this.landed = !airborne && this.vy <= 0.01;
    this.rotor = (this.rotor + this.spool * dt * 38) % (Math.PI * 2);
    return this.steering * dt;
  }
  stop() { this.speed = 0; this.vy = 0; this.steering = 0; this.acceleration = 0; this.throttle = 0; }
  /** What the engine sound follows: rotor rpm, no tyre roll. */
  audio(): VehicleMotion {
    return { speed: 0, steering: 0, throttle: this.throttle, braking: false, acceleration: 0, rpm: this.rpm, gear: 1 };
  }
}
