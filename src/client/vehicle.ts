import * as THREE from 'three';

/** Separating axes for a 2.14 × 4.72 m car against a world-aligned solid. */
export function vehicleOverlaps(x: number, z: number, yaw: number, box: { minX: number; maxX: number; minZ: number; maxZ: number }) {
  const dx = (box.minX + box.maxX) / 2 - x, dz = (box.minZ + box.maxZ) / 2 - z;
  const bx = (box.maxX - box.minX) / 2, bz = (box.maxZ - box.minZ) / 2;
  const c = Math.cos(yaw), s = Math.sin(yaw), ac = Math.abs(c), as = Math.abs(s);
  return Math.abs(dx) < bx + 1.07 * ac + 2.36 * as && Math.abs(dz) < bz + 1.07 * as + 2.36 * ac
    && Math.abs(dx * c - dz * s) < 1.07 + bx * ac + bz * as
    && Math.abs(dx * s + dz * c) < 2.36 + bx * as + bz * ac;
}

export interface VehicleMotion {
  speed: number;
  steering: number;
  throttle: number;
  braking: boolean;
  acceleration: number;
  rpm: number;
  gear: number;
}

/** A city-speed automatic transmission. Opposite input brakes before engaging reverse. */
export class Drivetrain implements VehicleMotion {
  speed = 0;
  steering = 0;
  throttle = 0;
  braking = false;
  acceleration = 0;
  rpm = 780;
  gear = 1;
  private reverseDelay = 0;
  update(dt: number, pedal: number, steer: number, fast: boolean, enabled = true) {
    const before = this.speed;
    this.braking = !enabled || pedal * this.speed < 0 || this.reverseDelay > 0;
    this.throttle = this.braking ? 0 : Math.abs(pedal);
    const maximum = pedal < 0 ? 4 : fast ? 18 : 12;
    if (this.braking) {
      this.speed = THREE.MathUtils.damp(this.speed, 0, 1.8, dt);
      this.speed = Math.sign(this.speed) * Math.max(0, Math.abs(this.speed) - 4 * dt);
      if (before !== 0 && this.speed === 0) this.reverseDelay = .25;
      else this.reverseDelay = Math.max(0, this.reverseDelay - dt);
    } else if (pedal) {
      const force = (pedal > 0 ? 3.4 : 2) * (1 - Math.min(1, Math.abs(this.speed) / maximum));
      this.speed += pedal * force * dt;
    } else {
      this.speed = Math.sign(this.speed) * Math.max(0, Math.abs(this.speed) - (.38 + this.speed * this.speed * .009) * dt);
    }
    if (Math.abs(this.speed) < .015) this.speed = 0;
    this.acceleration = (this.speed - before) / Math.max(dt, .001);
    // Reduce steering lock at speed; a bicycle model produces a continuous turning radius.
    this.steering = THREE.MathUtils.damp(this.steering, enabled ? -steer * (.57 / (1 + Math.abs(this.speed) * .055)) : 0, 7, dt);
    const v = Math.abs(this.speed);
    if (this.speed < -.1) this.gear = -1;
    else {
      if (this.gear < 1) this.gear = 1;
      if (this.gear === 1 && v > 4.8) this.gear = 2;
      if (this.gear === 2 && v > 9.3) this.gear = 3;
      if (this.gear === 3 && v < 7.7) this.gear = 2;
      if (this.gear === 2 && v < 3.4) this.gear = 1;
    }
    const ratio = this.gear === 3 ? 140 : this.gear === 2 ? 225 : 400;
    this.rpm = THREE.MathUtils.damp(this.rpm, 780 + v * ratio + this.throttle * 280, 5, dt);
    return this.speed / 2.9 * Math.tan(this.steering) * dt;
  }
  stop() { this.speed = 0; this.acceleration = 0; this.throttle = 0; this.reverseDelay = 0; }
}

/** Authored wheel pivots keep steering and rolling independent; only the sprung body leans. */
export class VehicleRig {
  private roll = 0;
  private pitch = 0;
  private spin = 0;
  private wheels: { front: boolean; steer: THREE.Object3D; spin: THREE.Object3D }[] = [];
  private body?: THREE.Object3D;
  private wheel?: THREE.Object3D;
  private lamps: THREE.MeshStandardMaterial[] = [];
  private display?: { context: CanvasRenderingContext2D; texture: THREE.CanvasTexture };
  private displayTime = 0;
  constructor(model: THREE.Object3D) {
    this.body = model.getObjectByName('Sprung_body');
    this.wheel = model.getObjectByName('Steering_control');
    for (const id of ['FL', 'FR', 'RL', 'RR']) {
      const steer = model.getObjectByName(`Wheel_${id}`), spin = model.getObjectByName(`Spin_${id}`);
      if (steer && spin) this.wheels.push({ front: id[0] === 'F', steer, spin });
    }
    model.traverse(o => {
      if (o instanceof THREE.Mesh) for (const m of Array.isArray(o.material) ? o.material : [o.material])
        if (m.name === 'Brake lamp' && m instanceof THREE.MeshStandardMaterial) this.lamps.push(m);
    });
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 256;
      const context = canvas.getContext('2d');
      if (context) {
        const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(.407, .157), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
        screen.position.set(.43, 1.065, -.859); (this.body ?? model).add(screen);
        this.display = { context, texture };
      }
    }
  }
  update(dt: number, motion: VehicleMotion, running: boolean) {
    this.spin = (this.spin + motion.speed * dt / .37) % (Math.PI * 2);
    for (const w of this.wheels) {
      w.steer.rotation.y = w.front ? motion.steering : 0;
      w.spin.rotation.x = this.spin;
    }
    this.pitch = THREE.MathUtils.damp(this.pitch, running ? THREE.MathUtils.clamp(motion.acceleration * .007, -.035, .035) : 0, 5, dt);
    this.roll = THREE.MathUtils.damp(this.roll, running ? THREE.MathUtils.clamp(motion.speed * motion.speed * Math.tan(motion.steering) * .0007, -.035, .035) : 0, 5, dt);
    if (this.body) { this.body.rotation.x = this.pitch; this.body.rotation.z = this.roll; }
    if (this.wheel) this.wheel.rotation.z = -motion.steering * 2.4;
    for (const lamp of this.lamps) lamp.emissiveIntensity = running && motion.braking ? 3 : .35;
    this.displayTime -= dt;
    if (this.display && this.displayTime <= 0) {
      this.displayTime = .1;
      const { context: c, texture } = this.display;
      c.fillStyle = '#091217'; c.fillRect(0, 0, 768, 256);
      c.textAlign = 'center'; c.fillStyle = '#d7e4e4'; c.font = '500 104px system-ui';
      c.fillText(String(Math.round(Math.abs(motion.speed) * 3.6)), 384, 140);
      c.font = '22px system-ui'; c.fillStyle = '#8badaf'; c.fillText('km/h', 384, 181);
      c.font = '40px system-ui'; c.fillStyle = motion.braking ? '#ef9f80' : '#d7e4e4';
      c.fillText(running ? motion.gear < 0 ? 'R' : `D${motion.gear}` : 'P', 100, 126);
      c.fillStyle = '#77bdb8'; c.font = '28px system-ui'; c.fillText(running ? String(Math.round(motion.rpm)) : '—', 650, 122);
      c.font = '18px system-ui'; c.fillText('RPM', 650, 157);
      c.fillStyle = '#23363d'; c.fillRect(48, 221, 672, 5);
      c.fillStyle = '#77bdb8'; c.fillRect(48, 221, 672 * (running ? Math.min(1, motion.rpm / 4500) : 0), 5);
      texture.needsUpdate = true;
    }
  }
}
