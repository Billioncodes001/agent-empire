import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Tower } from '../src/client/tower';
import { PlayerController } from '../src/client/player';
import { initialEmpire } from '../src/shared/empire';
import { FLOOR, FLOOR_RISE } from '../src/shared/layout';
import { store } from '../src/client/state';
import type { Office, Collider } from '../src/client/world/office';
import type { Net } from '../src/client/net';
class Element extends EventTarget {
 className = ''; textContent = ''; style = {}; onclick: unknown;
 append(..._children: unknown[]) {} setAttribute() {}
}
for (const view of ['first', 'third'] as const) test(`elevator gates access, opens and closes doors, grounds arrival and restores ${view} person`, () => {
 const root = new Element(), doc = new EventTarget();
 Object.assign(doc, { createElement: () => new Element(), getElementById: () => root, querySelector: () => root });
 Object.assign(globalThis, { document: doc, window: new EventTarget(), Node: Element });
 store.empire = initialEmpire(); store.empire.office = { floors: 3, workstations: 17 };
 const slab: Collider = { ...FLOOR, top: 0, bottom: -.2 }, colliders = [slab];
 const camera = new THREE.PerspectiveCamera(), player = new PlayerController(camera, root as unknown as HTMLElement, colliders);
 const doors: boolean[] = [];
 const office = { floor: 0, group: new THREE.Group(), setFloor(floor: number) { this.floor = floor; this.setElevation(floor * FLOOR_RISE); }, setElevation(y: number) { this.group.position.y = y; slab.top = y; slab.bottom = y - .2; }, elevator: { update(_dt: number, open: boolean) { doors.push(open); }, setFloor() {} } } as unknown as Office;
 const tower = new Tower({ send() {} } as unknown as Net, player, office, () => {});
 player.pos.set(0, 0, 7);
 (tower as any).begin(1); assert.equal(tower.active, false, 'travel requires physical proximity');
 player.pos.set(7, 0, -5.9); player.view = view; player.camYaw = .3;
 (tower as any).begin(3); assert.equal(tower.active, false, 'unbuilt floor cannot be selected');
 (tower as any).begin(2); assert.equal(tower.active, true); assert.equal(player.scripted, true);
 for (let i = 0; i < 720; i++) { player.update(1/60); tower.update(1/60); }
 assert.equal(tower.active, false); assert.equal(player.scripted, false); assert.equal(office.floor, 2);
 assert.ok(Math.abs(player.pos.y - 2 * FLOOR_RISE) < .001);
 assert.equal(player.view, view); assert.equal(player.camYaw, .3);
 assert.ok(doors.includes(false) && doors.includes(true), 'doors physically close and reopen');
 player.setAction('forward', true); player.update(.05);
 assert.ok(player.speed > 0 && player.grounded, 'movement resumes on the destination slab');
 assert.ok(camera.position.y > 2 * FLOOR_RISE && camera.position.y < 2 * FLOOR_RISE + 4);
});
