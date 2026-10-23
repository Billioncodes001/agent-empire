import * as THREE from 'three';
import { FLOOR_RISE, DESKS_PER_FLOOR } from '../shared/layout';
import { officeFloorCost, workstationCost } from '../shared/empire';
import type { PlayerController } from './player';
import type { Office } from './world/office';
import type { Net } from './net';
import { store } from './state';
import { h, openModal } from './ui/dom';
import { LIFT } from '../shared/layout';

export class Tower {
  private ride: { to: number; fromFloor: number; origin: THREE.Vector3; t: number; walk: number; travel: number; view: 'first' | 'third'; yaw: number; distance: number } | null = null;
  private status = h('div.lift-status', { 'aria-live': 'polite' });
  private button = h('button.btn', { title: 'Headquarters floors and workstations' }, 'Headquarters');
  constructor(private net: Net, private player: PlayerController, private office: Office, private onFloor: () => void) {
    document.querySelector('.topbar .controls')?.append(this.button);
    document.getElementById('hud')!.append(this.status);
    this.button.onclick = () => this.open();
    store.on('empire', () => this.sync());
    this.sync();
  }
  private capacityKey = "";
  private sync() {
    const key = `${this.office.floor}:${store.empire.office.workstations}`;
    if (this.capacityKey === key) return;
    this.capacityKey = key;
    if (!this.ride) this.office.setFloor(this.office.floor, store.empire.office.workstations);
    this.button.textContent = `HQ · Floor ${this.office.floor + 1}`;
    this.onFloor();
  }
  get active() { return !!this.ride; }
  private near() { return this.player.pos.z < 30 && Math.hypot(this.player.pos.x - LIFT.x, this.player.pos.z - LIFT.doorZ) < 4; }
  open() {
    if (this.ride) return;
    const close = h('button.btn', { 'aria-label': 'Close headquarters' }, 'Close');
    const body = h('div.body.tower-body');
    let unsub = () => {};
    const modal = openModal(h('div.modal.tower-modal.ae-dark', { role: 'dialog', 'aria-label': 'Headquarters' },
      h('header', {}, h('h2', {}, 'Headquarters'), close), body), { onClose: () => unsub() });
    let rendered = "";
    const draw = () => {
      const key = JSON.stringify([store.empire.office, store.empire.funds, store.empire.setup.completed, store.workers.size, this.office.floor, this.near()]);
      if (key === rendered) return;
      rendered = key;
      const { office, funds, setup } = store.empire;
      const occupied = store.workers.size;
      const seats = office.floors * DESKS_PER_FLOOR;
      const purchase = (kind: 'office-floor' | 'office-workstation', label: string, cost: number, blocked = false) => h('button.btn', {
        type: 'button', disabled: !setup.completed || funds < cost || blocked,
        onclick: () => this.net.send({ t: 'empire.action', action: { kind } }),
      }, `${label} · ${cost.toLocaleString()} cr`);
      body.replaceChildren(
        h('p.tower-eyebrow', {}, 'BUILD THE SPACE. GROW THE TEAM.'),
        h('div.tower-metrics', {}, ...[
          [office.floors, 'Operational floors'], [office.workstations, 'Furnished desks'], [Math.max(0, office.workstations - occupied), 'Available seats'],
        ].map(([value, label]) => h('div', {}, h('strong', {}, String(value)), h('span', {}, String(label))))),
        h('p', {}, `Treasury ${Math.round(funds).toLocaleString()} cr. Each floor provides space for ${DESKS_PER_FLOOR} workstations. Install computers and furniture before employing additional workers.`),
        h('div.tower-purchases', {}, purchase('office-workstation', 'Install workstation', workstationCost(office), office.workstations >= seats), purchase('office-floor', 'Build next floor', officeFloorCost(office))),
        h('p.setting-note', {}, office.workstations >= seats ? 'This floor is fully furnished. Build another floor to keep expanding.' : `${seats - office.workstations} spaces remain to furnish. Workstations stay yours when a worker finishes or leaves.`),
        h('h3', {}, 'Elevator directory'),
        h('p.setting-note', {}, this.near() ? 'Select an operational floor. Your character will walk into the elevator.' : 'Walk to the elevator in the north side of the office to travel between floors.'),
        h('div.floor-directory', {}, ...Array.from({ length: office.floors }, (_, floor) => {
          const desks = Math.max(0, Math.min(16, office.workstations - floor * 16));
          return h('button.floor-card', { type: 'button', disabled: floor === this.office.floor || !this.near(), 'aria-label': `Take elevator to floor ${floor + 1}`,
            onclick: () => { modal.close(); this.begin(floor); } },
          h('b', {}, String(floor + 1).padStart(2, '0')), h('span', {}, floor === 0 ? 'Operations & street lobby' : 'Agent workspace'), h('small', {}, `${desks} / 16 desks${floor === this.office.floor ? ' · You are here' : ''}`));
        })),
        h('p.setting-note', {}, 'There is no fixed worker-count ceiling. Purchased workstations determine capacity; the task queue’s separate concurrency setting and provider budget control how many agents run at once.'),
      );
    };
    unsub = store.on('empire', draw); draw(); close.onclick = () => modal.close();
  }
  private begin(to: number) {
    if (!this.near() || this.player.scripted || to < 0 || to >= store.empire.office.floors || to === this.office.floor) return;
    const p = this.player;
    this.ride = { to, fromFloor: this.office.floor, origin: p.pos.clone(), t: 0, walk: Math.max(1.5, Math.hypot(p.pos.x - LIFT.x, p.pos.z - LIFT.z) / 1.4), travel: Math.min(12, 2 + Math.abs(to - this.office.floor) * .7), view: p.view, yaw: p.camYaw, distance: p.camDist };
    p.scripted = true; p.clearKeys(); p.vy = 0; p.stepOffset = 0;
  }
  update(dt: number) {
    const r = this.ride, p = this.player;
    if (!r) {
      this.office.elevator.update(dt, this.near(), this.office.group.position.y);
      this.status.textContent = '';
      return;
    }
    r.t += dt;
    const closeAt = r.walk + .65, moveAt = closeAt + 1, arriveAt = moveAt + r.travel, leaveAt = arriveAt + 1;
    const smooth = (n: number) => { const v = THREE.MathUtils.clamp(n, 0, 1); return v * v * (3 - 2 * v); };
    const fromY = r.fromFloor * FLOOR_RISE, toY = r.to * FLOOR_RISE;
    if (r.t < closeAt) {
      const u = THREE.MathUtils.clamp((r.t - .65) / r.walk, 0, 1);
      p.pos.copy(r.origin).lerp(new THREE.Vector3(LIFT.x, fromY, LIFT.z), u);
      p.facing = Math.atan2(LIFT.x - r.origin.x, LIFT.z - r.origin.z);
      p.speed = r.t > .65 ? 1.4 : 0; p.moving = p.speed > 0;
      this.status.textContent = 'Entering elevator';
    } else if (r.t < leaveAt) {
      p.setView('first'); p.camYaw = Math.PI; p.lookPitch = -.03;
      p.speed = 0; p.moving = false; p.facing = 0;
      const u = smooth((r.t - moveAt) / r.travel);
      const y = THREE.MathUtils.lerp(fromY, toY, u);
      this.office.setElevation(y); p.pos.set(LIFT.x, y, LIFT.z);
      this.office.elevator.setFloor(Math.round(y / FLOOR_RISE));
      this.status.textContent = r.t < moveAt ? 'Doors closing' : r.t < arriveAt ? `Elevator · ${r.fromFloor + 1} → ${r.to + 1}` : `Floor ${r.to + 1} · Doors opening`;
      if (r.t >= arriveAt && this.office.floor !== r.to) { this.office.setFloor(r.to, store.empire.office.workstations); this.onFloor(); }
    } else {
      const u = Math.min(1, (r.t - leaveAt) / 1.5);
      p.pos.set(LIFT.x, toY, LIFT.z + u * 2.8); p.facing = 0; p.speed = 1.8; p.moving = true;
      this.status.textContent = `Arriving on floor ${r.to + 1}`;
      if (u >= 1) {
        this.ride = null; p.scripted = false; p.speed = 0; p.moving = false; p.clearKeys(); p.vy = 0;
        p.setView(r.view); p.camYaw = r.yaw; p.camDist = r.distance; p.updateCamera(true); this.sync();
      }
    }
    this.office.elevator.update(dt, r.t < closeAt || r.t >= arriveAt, this.office.group.position.y);
    p.updateCamera();
  }
}
