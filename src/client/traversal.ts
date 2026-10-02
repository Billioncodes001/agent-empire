import * as THREE from 'three';
import type { PlayerController } from './player';
import type { Person } from './world/character';
import type { Office } from './world/office';
import type { buildCity } from './world/city';
import { entrance, entranceAccess } from './navigation';
import { SITES } from '../shared/empire';
import { store } from './state';
import { h, modalOpen, toast } from './ui/dom';
import { keyLabel } from './controls';
import type { CarCue } from './world-audio';

type Transition = {
  kind: 'exit-office' | 'enter-office' | 'enter-car' | 'exit-car';
  time: number;
  from: THREE.Vector3;
  view: 'first' | 'third';
  yaw: number;
  switched: boolean;
  cues: Set<CarCue>;
};
export const ease = (t: number) => {
  const p = THREE.MathUtils.clamp(t, 0, 1);
  return p * p * (3 - 2 * p);
};
/** Doorways trigger traversal; only the nearby driver's door uses the interaction key. */
export class Traversal {
  private current: Transition | null = null;
  private cooldown = 0;
  private hint = h('div.traversal-hint', { 'aria-live': 'polite' });
  private fade = h('div.door-fade');
  constructor(
    private player: PlayerController,
    private person: Person,
    private office: Office,
    private city: ReturnType<typeof buildCity>,
    private delegate: () => void,
    private carAudio: (cue: CarCue, position: THREE.Vector3) => void = () => {},
  ) {
    document.getElementById('hud')!.append(this.hint);
    document.body.append(this.fade);
  }
  get state() {
    return this.current?.kind ?? (this.player.driving ? 'driving' : 'walking');
  }
  private carPoint(x: number, y: number, z: number) {
    return new THREE.Vector3(x, y, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.city.car.rotation.y).add(this.city.car.position);
  }
  private begin(kind: Transition['kind']) {
    if (this.current) return;
    const p = this.player;
    this.current = { kind, time: 0, from: p.pos.clone(), view: p.view, yaw: p.camYaw, switched: false, cues: new Set() };
    p.clearKeys();
    p.scripted = true;
    p.vy = 0;
    p.stepOffset = 0;
    p.grounded = true;
    if (kind.includes('car')) {
      if (kind === 'exit-car') this.carAudio('engine-stop', this.city.car.position);
      if (kind === 'exit-car') p.pos.copy(this.carPoint(-0.43, 0.1, 0.05));
      p.driving = false;
      p.setView('third');
      p.camDist = 5.5;
      p.camPitch = 0.2;
      p.camYaw = this.city.car.rotation.y - Math.PI * 0.65;
    }
  }
  interactCar() {
    const p = this.player;
    if (this.current) return true;
    if (p.driving) {
      if (Math.abs(p.drivingSpeed) > 0.5) {
        toast('Stop the car before opening the door.', 'info');
        return true;
      }
      const exit = this.carPoint(-1.8, 0, 0.1);
      const blocked = this.office.colliders.some(
        (c) =>
          c !== this.city.carCollider &&
          c.top > 0.4 &&
          (c.bottom ?? 0) < 1.7 &&
          exit.x > c.minX - 0.35 &&
          exit.x < c.maxX + 0.35 &&
          exit.z > c.minZ - 0.35 &&
          exit.z < c.maxZ + 0.35,
      );
      if (blocked) {
        toast('The driver’s side is blocked. Park with space beside the door.', 'info');
        return true;
      }
      this.begin('exit-car');
      return true;
    }
    if (p.pos.z < 30 || p.pos.distanceTo(this.city.car.position) > 3.8) return false;
    if (p.pos.distanceTo(this.carPoint(-1.65, 0, 0.1)) > 2) {
      toast('Walk around to the driver’s door.', 'info');
      return true;
    }
    if (!this.city.car.userData.ready) return true;
    this.begin('enter-car');
    return true;
  }
  update(dt: number) {
    const p = this.player;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.office.entranceDoor.update(dt, this.office.floor === 0 && p.pos.z < 30 && Math.abs(p.pos.x) < 2.5 && p.pos.z > 9.3);
    this.office.entranceDoor.collider.bottom = this.office.group.position.y;
    this.office.entranceDoor.collider.top += this.office.group.position.y;
    if (this.current) {
      this.animate(dt);
      if (p.moving) p.walkPhase += dt * p.speed * Math.PI * 2 / 1.55;
      return;
    }
    this.person.pose = p.driving ? 'drive' : 'stand';
    this.person.setTransition(null);
    this.person.setVehiclePose(p.driving ? { phase: 'drive', progress: 1, steering: p.vehicle.steering } : null);
    const front = entrance('hq');
    if (!modalOpen() && p.enabled && !p.driving && p.grounded && p.moving && this.cooldown === 0) {
      if (this.office.floor === 0 && p.pos.z < 30 && Math.abs(p.pos.x) < 1.03 && p.pos.z > 12.1 && Math.cos(p.facing) > 0.25) this.begin('exit-office');
      else if (Math.abs(p.pos.x - front.x) < 1.12 && p.pos.z > front.z && p.pos.z < front.z + 1.3 && Math.cos(p.facing) < -0.25)
        this.begin('enter-office');
    }
    if (p.driving) this.hint.textContent = `${Math.round(Math.abs(p.drivingSpeed) * 3.6)} km/h · ${p.vehicle.gear < 0 ? 'R' : `D${p.vehicle.gear}`} · ${keyLabel(p.bindings.backward)} Brake / reverse · ${keyLabel(p.bindings.interact)} Exit · ${keyLabel(p.bindings.camera)} Camera`;
    else if (p.pos.z < 30)
      this.hint.textContent = p.pos.z > 8 && Math.abs(p.pos.x) < 4 ? (this.office.floor === 0 ? 'Walk through the glass doors to the waterfront' : 'Take the elevator to floor 1 for the street exit') : '';
    else if (p.pos.distanceTo(this.city.car.position) < 3.8)
      this.hint.textContent = `${keyLabel(p.bindings.interact)} Enter vehicle at driver’s door`;
    else {
      const site = SITES.find((s) => {
        const e = entrance(s.id);
        return Math.hypot(e.x - p.pos.x, e.z - p.pos.z) < 4;
      });
      if (site) {
        const access = entranceAccess(site.id, store.empire, store.workers.values());
        this.hint.textContent = access.allowed ? `Walk through the entrance · ${site.name}` : access.reason;
      } else {
        const inside = SITES.find((s) => s.id !== 'hq' && Math.abs(s.x - p.pos.x) < 8 && Math.abs(s.z - p.pos.z) < 5.5);
        this.hint.textContent = inside
          ? `${keyLabel(p.bindings.interact)} ${inside.id === 'home' ? 'Home / research computer' : 'Building operations'}`
          : '';
      }
    }
  }
  private finish() {
    const p = this.player,
      t = this.current!;
    this.current = null;
    this.cooldown = 1.5;
    p.scripted = false;
    p.clearKeys();
    p.speed = 0;
    p.moving = false;
    p.stepOffset = 0;
    p.vy = 0;
    this.person.setTransition(null);
    this.person.setVehiclePose(p.driving ? { phase: 'drive', progress: 1 } : null);
    this.fade.style.opacity = '0';
    if (t.kind.includes('car')) p.setView(t.view);
    p.updateCamera(true);
  }
  private animate(dt: number) {
    const t = this.current!,
      p = this.player;
    t.time += dt;
    this.hint.textContent = '';
    if (t.kind === 'exit-office' || t.kind === 'enter-office') {
      const leaving = t.kind === 'exit-office',
        u = t.time / 1.7;
      p.speed = 1.3;
      p.moving = true;
      p.facing = leaving ? 0 : Math.PI;
      const darkness = 1 - Math.min(1, Math.abs(u - 0.5) / 0.16);
      this.fade.style.opacity = String(darkness);
      if (u < 0.5) {
        p.pos.copy(t.from);
        p.pos.z += (leaving ? 1 : -1) * t.time * 1.25;
      } else {
        const door = entrance('hq');
        if (!t.switched) {
          t.switched = true;
          if (leaving) this.delegate();
          p.camYaw = leaving ? Math.PI : 0;
          p.camDist = 4.6;
          p.camPitch = 0.16;
          p.lookPitch = -0.02;
        }
        p.pos.set(leaving ? door.x : 0, 0, leaving ? door.z + 0.65 + (u - 0.5) * 2.8 : 12.3 - (u - 0.5) * 2.8);
        p.updateCamera(true);
      }
      if (u >= 1) this.finish();
      return;
    }
    const entering = t.kind === 'enter-car';
    const door = this.carPoint(-1.65, 0, 0.1),
      seat = this.carPoint(-0.43, 0.1, 0.05);
    // Approach, open, lower into seat / stand up, then close. All phases remain visible.
    const approach = entering ? 0.9 : 0;
    const openAt = approach,
      bodyAt = openAt + 0.65,
      closeAt = bodyAt + 2.6,
      end = closeAt + 0.7;
    const cue = (name: CarCue, at: number) => {
      if (t.time >= at && !t.cues.has(name)) { t.cues.add(name); this.carAudio(name, this.city.car.position); }
    };
    cue('door-open', openAt + .1);
    cue('door-close', end - .14);
    if (entering) cue('engine-start', end - .03);
    p.facing = this.city.car.rotation.y;
    if (t.time < approach) {
      const u = ease(t.time / approach);
      p.pos.lerpVectors(t.from, door, u);
      p.facing = Math.atan2(door.x - t.from.x, door.z - t.from.z);
      p.speed = t.from.distanceTo(door) / approach;
      p.moving = true;
    } else if (t.time < bodyAt) {
      p.pos.copy(entering ? door : seat);
      p.moving = false;
      p.speed = 0;
      this.person.pose = entering ? 'stand' : 'sit';
      this.city.setCarDoor(ease((t.time - openAt) / 0.65));
      p.facing += entering ? Math.PI / 2 : 0;
      const handle = this.city.car.getObjectByName('Driver_handle')?.getWorldPosition(new THREE.Vector3()) ?? this.carPoint(-1, .98, .35);
      this.person.setVehiclePose({ phase: 'reach', progress: (t.time - openAt) / .65, handle });
    } else if (t.time < closeAt) {
      const u = (t.time - bodyAt) / 2.6;
      this.person.setTransition(entering ? 'sit_down_chair_01' : 'sit_stand_up_chair_01', u);
      const seated = entering ? u : 1 - u;
      // Lower the pelvis beside the seat before rotating the legs through the aperture.
      p.pos.lerpVectors(door, seat, ease((seated - .08) / .84));
      p.facing += Math.PI / 2 * (1 - ease((seated - .3) / .65));
      const foot = (side: 'l' | 'r') => {
        const lift = ease((seated - (side === 'r' ? .25 : .60)) / .35);
        return this.carPoint(side === 'r' ? -1.44 : -1.66, .1, side === 'r' ? .35 : -.02)
          .lerp(this.carPoint(side === 'r' ? -.56 : -.30, .32, .67), lift)
          .add(new THREE.Vector3(0, Math.sin(lift * Math.PI) * .23, 0));
      };
      this.person.setVehiclePose({ phase: entering ? 'enter' : 'exit', progress: u, feet: { l: foot('l'), r: foot('r') } });
      p.speed = 0;
      p.moving = false;
      this.city.setCarDoor(1);
    } else {
      this.person.setTransition(null);
      this.person.pose = entering ? 'drive' : 'stand';
      const closeProgress = ease((t.time - closeAt) / .7);
      const handle = this.city.car.getObjectByName('Driver_handle')?.getWorldPosition(new THREE.Vector3());
      this.person.setVehiclePose(handle ? { phase: 'reach', progress: 1 - closeProgress, handle } : null);
      p.pos.copy(entering ? seat : door);
      this.city.setCarDoor(1 - ease((t.time - closeAt) / 0.7));
    }
    if (t.time >= end) {
      this.city.setCarDoor(0);
      if (entering) {
        p.driving = true;
        p.pos.copy(this.city.car.position);
        p.camDist = 7;
        p.camYaw = this.city.car.rotation.y - Math.PI;
      } else {
        p.driving = false;
        p.pos.copy(door);
        p.camDist = 4.6;
      }
      this.finish();
    }
    p.updateCamera();
  }
  placeDriver() {
    if (!this.player.driving) return;
    this.person.root.position.copy(this.carPoint(-0.43, 0.1, 0.05));
    this.person.root.rotation.y = this.city.car.rotation.y;
  }
}
