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
import { SEDAN, type Ride, type Vec3 } from './rides';
import { airframeFloor, landingSpot } from './flight';

type Transition = {
  kind: 'exit-office' | 'enter-office' | 'enter-car' | 'exit-car';
  time: number;
  from: THREE.Vector3;
  view: 'first' | 'third';
  yaw: number;
  switched: boolean;
  cues: Set<CarCue>;
  /** +1 driver's door, −1 passenger side (CITY-06: when the driver's side is blocked). */
  side: number;
};
export const ease = (t: number) => {
  const p = THREE.MathUtils.clamp(t, 0, 1);
  return p * p * (3 - 2 * p);
};
/**
 * Doorways trigger traversal; only the nearby driver's door uses the interaction key.
 * CITY-06/08: any ride (the sedan, a bought garage vehicle, the helicopter) is boarded, driven and left the same way,
 * using its own seat, door, handle and camera offsets (rides.ts).
 */
export class Traversal {
  private current: Transition | null = null;
  /** The ride being boarded, driven or left. */
  private active: Ride | null = null;
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
    return this.current?.kind ?? (this.player.flying ? 'flying' : this.player.driving ? 'driving' : 'walking');
  }
  /** The ride being driven or flown (or boarded/left right now). */
  get ride(): Ride | null {
    return this.active;
  }
  /** Every ride in the world; a city without the CITY-06 list (older fixtures) has only the sedan. */
  rides(): Ride[] {
    const city = this.city as ReturnType<typeof buildCity> & { rides?: () => Ride[] };
    if (city.rides) return city.rides();
    return [
      {
        key: 'sedan',
        spec: SEDAN,
        object: city.car,
        get ready() { return !!city.car.userData.ready; },
        setDoor: (v) => city.setCarDoor(v),
        handle: () => city.car.getObjectByName('Driver_handle')?.getWorldPosition(new THREE.Vector3()),
        animate() {},
      },
    ];
  }
  /** Takes over a ride the founder is already in (a test, or a restored state). */
  adopt(ride: Ride) {
    this.active = ride;
    ride.enter?.();
  }
  /** Moves the driven ride with the founder: the controller owns the pose while driving. */
  syncRide() {
    const r = this.active, p = this.player;
    if (!r || !p.driving || this.current) return;
    r.object.position.copy(p.pos);
    r.object.rotation.y = p.facing;
  }
  private get car(): THREE.Object3D {
    return this.active?.object ?? this.city.car;
  }
  private get spec() {
    return this.active?.spec ?? SEDAN;
  }
  private carPoint(x: number, y: number, z: number) {
    return new THREE.Vector3(x, y, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.car.rotation.y).add(this.car.position);
  }
  /** A ride-frame point, mirrored to the passenger side when `side` is −1, with an optional offset. */
  private at(v: Vec3, side = this.current?.side ?? 1, dx = 0, dy = 0, dz = 0) {
    return this.carPoint((v[0] + dx) * side, v[1] + dy, v[2] + dz);
  }
  private sideBlocked(side: number) {
    const s = this.spec;
    const exit = this.at([s.door[0] - 0.15, 0, s.door[2]], side);
    const base = this.car.position.y;
    return this.office.colliders.some(
      (c) =>
        c !== this.city.carCollider &&
        c.top > base + 0.4 &&
        (c.bottom ?? 0) < base + 1.7 &&
        exit.x > c.minX - 0.35 &&
        exit.x < c.maxX + 0.35 &&
        exit.z > c.minZ - 0.35 &&
        exit.z < c.maxZ + 0.35,
    );
  }
  private begin(kind: Transition['kind'], side = 1) {
    if (this.current) return;
    const p = this.player;
    this.current = { kind, time: 0, from: p.pos.clone(), view: p.view, yaw: p.camYaw, switched: false, cues: new Set(), side };
    p.clearKeys();
    p.scripted = true;
    p.vy = 0;
    p.stepOffset = 0;
    p.grounded = true;
    if (kind.includes('car')) {
      if (kind === 'exit-car') this.carAudio('engine-stop', this.car.position);
      if (kind === 'exit-car') p.pos.copy(this.at(this.spec.seat, 1));
      p.driving = false;
      p.ride = SEDAN;
      p.setView('third');
      p.camDist = Math.max(5.5, this.spec.chase * 0.75);
      p.camPitch = 0.2;
      p.camYaw = this.car.rotation.y - Math.PI * 0.65 * side;
    }
  }
  private near(): Ride | undefined {
    const p = this.player;
    return this.rides()
      .map((r) => ({ r, d: Math.hypot(p.pos.x - r.object.position.x, p.pos.z - r.object.position.z) }))
      .filter(({ r, d }) => d < r.spec.half.l + 1.5 && Math.abs(p.pos.y - r.object.position.y) < 1.5)
      .sort((a, b) => a.d - b.d)[0]?.r;
  }
  interactCar() {
    const p = this.player;
    if (this.current) return true;
    if (p.driving) {
      if (!this.active) this.active = this.rides().find((r) => r.key === 'sedan') ?? null;
      if (p.flying) {
        const floor = airframeFloor(this.office.colliders, p.pos.x, p.pos.z, p.facing, p.ride.half, p.pos.y);
        if (!p.flight.landed || Math.abs(p.flight.speed) > 0.5) {
          toast('Land first: hold the descend key until the skids touch down.', 'info');
          return true;
        }
        if (!landingSpot(p.pos, floor)) {
          toast('You can only step out on the helipad or at street level.', 'info');
          return true;
        }
      } else if (Math.abs(p.drivingSpeed) > 0.5) {
        toast('Stop the car before opening the door.', 'info');
        return true;
      }
      // The driver's side first; if a wall is there, climb across and out of the passenger side.
      const side = !this.sideBlocked(1) ? 1 : !this.sideBlocked(-1) ? -1 : 0;
      if (!side) {
        toast('Both doors are blocked. Move to where there is space beside the vehicle.', 'info');
        return true;
      }
      this.begin('exit-car', side);
      return true;
    }
    if (p.pos.z < 30) return false;
    const near = this.near();
    if (!near) return false;
    if (near.locked) {
      toast(near.locked, 'info');
      return true;
    }
    const prev = this.active;
    this.active = near;
    if (p.pos.distanceTo(this.at(near.spec.door, 1)) > 2) {
      this.active = prev;
      toast(near.spec.kind === 'helicopter' ? 'Walk around to the pilot’s door.' : 'Walk around to the driver’s door.', 'info');
      return true;
    }
    if (!near.ready) {
      this.active = prev;
      return true;
    }
    near.enter?.();
    this.begin('enter-car');
    return true;
  }
  /** What the hint says next to a ride, or ''. */
  private rideHint(): string {
    const p = this.player, r = this.near();
    if (!r) return '';
    if (r.locked) return r.locked;
    if (r.key === 'sedan') return `${keyLabel(p.bindings.interact)} Enter vehicle at driver’s door`;
    return r.spec.kind === 'helicopter'
      ? `${keyLabel(p.bindings.interact)} Board the helicopter at the pilot’s door`
      : `${keyLabel(p.bindings.interact)} Drive the ${r.spec.name.toLowerCase()} · driver’s door`;
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
    this.person.setVehiclePose(p.driving ? { phase: 'drive', progress: 1, steering: p.flying ? 0 : p.vehicle.steering } : null);
    const front = entrance('hq');
    if (!modalOpen() && p.enabled && !p.driving && p.grounded && p.moving && this.cooldown === 0) {
      if (this.office.floor === 0 && p.pos.z < 30 && Math.abs(p.pos.x) < 1.03 && p.pos.z > 12.1 && Math.cos(p.facing) > 0.25) this.begin('exit-office');
      else if (Math.abs(p.pos.x - front.x) < 1.12 && p.pos.z > front.z && p.pos.z < front.z + 1.3 && Math.cos(p.facing) < -0.25)
        this.begin('enter-office');
    }
    const rideHint = !p.driving && p.pos.z >= 30 ? this.rideHint() : '';
    const k = p.bindings;
    if (p.flying) {
      const floor = airframeFloor(this.office.colliders, p.pos.x, p.pos.z, p.facing, p.ride.half, p.pos.y);
      const exit = p.flight.landed && landingSpot(p.pos, floor) ? `${keyLabel(k.interact)} Exit · ` : '';
      this.hint.textContent = `${Math.round(Math.abs(p.drivingSpeed) * 3.6)} km/h · ${Math.round(p.pos.y)} m${p.flight.spool < 1 ? ' · rotor spinning up' : ''} · ${keyLabel(k.jump)} Climb · ${keyLabel(k.run)} Descend · ${exit}${keyLabel(k.camera)} Camera`;
    } else if (p.driving) this.hint.textContent = `${Math.round(Math.abs(p.drivingSpeed) * 3.6)} km/h · ${p.vehicle.gear < 0 ? 'R' : `D${p.vehicle.gear}`} · ${keyLabel(k.backward)} Brake / reverse · ${keyLabel(k.interact)} Exit · ${keyLabel(k.camera)} Camera`;
    else if (p.pos.z < 30)
      this.hint.textContent = p.pos.z > 8 && Math.abs(p.pos.x) < 4 ? (this.office.floor === 0 ? 'Walk through the glass doors to the waterfront' : 'Take the elevator to floor 1 for the street exit') : '';
    else if (rideHint) this.hint.textContent = rideHint;
    else if (this.city.districts?.hintAt(p.pos, keyLabel(k.interact))) this.hint.textContent = this.city.districts.hintAt(p.pos, keyLabel(k.interact));
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
          ? `${keyLabel(k.interact)} ${inside.id === 'home' ? 'Home / research computer' : 'Building operations'}`
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
    if (t.kind === 'exit-car') {
      // Parked where it was left (CITY-06): the ride turns solid there.
      this.active?.exit?.();
      this.active = null;
    }
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
    const spec = this.spec, side = t.side, car = this.car;
    const door = this.at(spec.door),
      seat = this.at(spec.seat, 1);
    const handleAt = () => (side === 1 ? this.active?.handle?.() : undefined) ?? this.at(spec.handle);
    // Approach, open, lower into seat / stand up, then close. All phases remain visible.
    const approach = entering ? 0.9 : 0;
    const openAt = approach,
      bodyAt = openAt + 0.65,
      closeAt = bodyAt + 2.6,
      end = closeAt + 0.7;
    const cue = (name: CarCue, at: number) => {
      if (t.time >= at && !t.cues.has(name)) { t.cues.add(name); this.carAudio(name, car.position); }
    };
    cue('door-open', openAt + .1);
    cue('door-close', end - .14);
    if (entering) cue('engine-start', end - .03);
    // Only the driver's door is hinged; a passenger-side exit has no door to swing.
    const setDoor = (v: number) => { if (side === 1) this.active?.setDoor(v); };
    p.facing = car.rotation.y;
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
      setDoor(ease((t.time - openAt) / 0.65));
      p.facing += entering ? side * Math.PI / 2 : 0;
      this.person.setVehiclePose({ phase: 'reach', progress: (t.time - openAt) / .65, handle: handleAt() });
    } else if (t.time < closeAt) {
      const u = (t.time - bodyAt) / 2.6;
      this.person.setTransition(entering ? 'sit_down_chair_01' : 'sit_stand_up_chair_01', u);
      const seated = entering ? u : 1 - u;
      // Lower the pelvis beside the seat before rotating the legs through the aperture.
      p.pos.lerpVectors(door, seat, ease((seated - .08) / .84));
      p.facing += side * Math.PI / 2 * (1 - ease((seated - .3) / .65));
      const foot = (leg: 'l' | 'r') => {
        const lift = ease((seated - (leg === 'r' ? .25 : .60)) / .35);
        const start = this.at(spec.door, side, leg === 'r' ? .21 : -.01, .1, leg === 'r' ? .25 : -.12);
        const inside = this.at(spec.seat, 1, leg === 'r' ? -.13 : .13, .22, .62);
        return start.lerp(inside, lift).add(new THREE.Vector3(0, Math.sin(lift * Math.PI) * .23, 0));
      };
      this.person.setVehiclePose({ phase: entering ? 'enter' : 'exit', progress: u, feet: { l: foot('l'), r: foot('r') } });
      p.speed = 0;
      p.moving = false;
      setDoor(1);
    } else {
      this.person.setTransition(null);
      this.person.pose = entering ? 'drive' : 'stand';
      const closeProgress = ease((t.time - closeAt) / .7);
      this.person.setVehiclePose(side === 1 ? { phase: 'reach', progress: 1 - closeProgress, handle: handleAt() } : null);
      p.pos.copy(entering ? seat : door);
      setDoor(1 - ease((t.time - closeAt) / 0.7));
    }
    if (t.time >= end) {
      setDoor(0);
      if (entering) {
        p.driving = true;
        p.ride = spec;
        p.pos.copy(car.position);
        p.facing = car.rotation.y;
        p.camDist = spec.chase;
        p.camYaw = car.rotation.y - Math.PI;
      } else {
        p.driving = false;
        p.ride = SEDAN;
        p.pos.copy(door);
        p.camDist = 4.6;
      }
      this.finish();
    }
    p.updateCamera();
  }
  placeDriver() {
    if (!this.player.driving) return;
    this.person.root.position.copy(this.at(this.spec.seat, 1));
    this.person.root.rotation.y = this.car.rotation.y;
  }
}
