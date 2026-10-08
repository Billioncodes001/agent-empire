import * as THREE from 'three';
import { LOFT } from '../../shared/layout';
import { EXECUTIVES, type ExecutiveRole, type OrgState } from '../../shared/org';
import { ceoAvatar, chiefAvatar, type AvatarId, type Outfit } from '../../shared/outfit';
import { lookFromSeed } from '../../shared/avatar';
import { Person } from './character';
import { EXECUTIVE_DESKS, EXECUTIVE_DESK_SIZE, executiveApproach, executiveSeat } from './furnishing-layout';
import { mesh, roundedBox, textPlane, toon } from './toon';
import type { Collider, Interactable } from './office';

/**
 * Each executive's stable suit. None is ever the CEO's own suit: when the CEO wears the role's first
 * choice, the second is used, and the colours stay the role's (so a role is recognisable either way).
 */
const SUITS: Record<Exclude<ExecutiveRole, 'chief_of_staff'>, { avatars: [AvatarId, AvatarId]; colors: Omit<Outfit, 'avatar'> }> = {
  operations: { avatars: ['business-m03', 'business-m04'], colors: { suit: '#24402f', shirt: '#f4f3ef', tie: '#c19a35' } },
  finance: { avatars: ['business-f04', 'business-f02'], colors: { suit: '#1f2c4a', shirt: '#bcd3ea' } },
  marketing_sales: { avatars: ['business-f01', 'business-f03'], colors: { suit: '#5e1f2a', shirt: '#eee3c8' } },
  research: { avatars: ['business-m05', 'business-m06'], colors: { suit: '#6b7178', shirt: '#cfc6e6', tie: '#1f7a78' } },
};

/** The outfit an executive wears given the CEO's suit; the chief keeps the rule it always had. */
export function executiveOutfit(role: ExecutiveRole, ceo: AvatarId): Outfit {
  if (role === 'chief_of_staff') return { avatar: chiefAvatar(ceo) };
  const s = SUITS[role];
  const avatar = s.avatars[0] === ceo ? s.avatars[1] : s.avatars[0];
  // Drop a tie colour for avatars without one; sanitizeOutfit would drop it anyway.
  const tie = avatar.startsWith('business-f') || avatar === 'business-m06' ? undefined : s.colors.tie;
  return { avatar, suit: s.colors.suit, shirt: s.colors.shirt, ...(tie ? { tie } : {}) };
}

const PLATE = { bg: '#2a2219', color: '#e8cf93', size: 40, border: '#a07a3c' } as const;

function chairMesh(): THREE.Group {
  const g = new THREE.Group();
  const leather = toon('#1d1f24');
  g.add(mesh(roundedBox(0.6, 0.1, 0.56, 0.12), leather, 0, 0.5, 0));
  const back = mesh(roundedBox(0.6, 0.1, 0.78, 0.12), leather, 0, 0.95, 0.27);
  back.rotation.x = Math.PI / 2 - 0.1;
  g.add(back);
  g.add(mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.42, 8), toon('#6c757d'), 0, 0.26, 0));
  return g;
}

/**
 * Builds the five executive desks in the loft (loft-floor coordinates inside the office group). Each
 * desk has a brass name plate readable from the aisle; desks of unstaffed roles say so.
 */
export function buildExecutiveDesks(group: THREE.Group, colliders: Collider[]): Interactable[] {
  const floorY = LOFT.y;
  const { width, depth, height } = EXECUTIVE_DESK_SIZE;
  const wood = toon('#5b3a26');
  const top = toon('#7a5135');
  const out: Interactable[] = [];
  for (const d of EXECUTIVE_DESKS) {
    const def = EXECUTIVES[d.role];
    const desk = new THREE.Group();
    desk.name = `Executive desk · ${def.title}`;
    desk.add(mesh(roundedBox(width, 0.06, depth, 0.05), top, 0, height - 0.03, 0));
    desk.add(mesh(new THREE.BoxGeometry(width - 0.1, height - 0.1, 0.05), wood, 0, (height - 0.06) / 2, -depth / 2 + 0.06));
    for (const sx of [-1, 1]) desk.add(mesh(new THREE.BoxGeometry(0.06, height - 0.06, depth - 0.08), wood, sx * (width / 2 - 0.06), (height - 0.06) / 2, 0));
    // A slim monitor facing the sitter (who faces the glass) and a lamp.
    desk.add(mesh(roundedBox(0.56, 0.34, 0.04, 0.02), toon('#15181c'), -0.1, height + 0.28, -0.18));
    desk.add(mesh(new THREE.PlaneGeometry(0.5, 0.28), new THREE.MeshBasicMaterial({ color: def.active ? '#9fd8c9' : '#3b4046' }), -0.1, height + 0.28, -0.155, false));
    desk.add(mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.04, 12), toon('#a07a3c'), 0.45, height + 0.02, -0.15));
    desk.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 6), toon('#a07a3c'), 0.45, height + 0.17, -0.15));
    // Name plate on the aisle edge, angled up toward whoever approaches.
    const plate = textPlane(def.active ? def.name.toUpperCase() : `${def.title.toUpperCase()} · NOT STAFFED YET`, PLATE);
    plate.scale.multiplyScalar(0.32);
    plate.position.set(0.25, height + 0.06, depth / 2 - 0.08);
    plate.rotation.x = -0.5;
    desk.add(plate);
    const chair = chairMesh();
    chair.position.set(0, 0, executiveSeat(d).z - d.z);
    desk.add(chair);
    desk.position.set(d.x, floorY, d.z);
    desk.rotation.y = d.rotY;
    const stand = executiveApproach(d);
    const it: Interactable = { kind: 'executive', role: d.role, x: stand.x, z: stand.z, y: floorY, radius: 0.85 };
    desk.userData.interact = it;
    group.add(desk);
    colliders.push({ minX: d.x - width / 2, maxX: d.x + width / 2, minZ: d.z - depth / 2, maxZ: d.z + depth / 2, bottom: floorY, top: floorY + height });
    const seat = executiveSeat(d);
    colliders.push({ minX: seat.x - 0.31, maxX: seat.x + 0.31, minZ: seat.z - 0.31, maxZ: seat.z + 0.31, bottom: floorY, top: floorY + 0.51 });
    out.push(it);
  }
  return out;
}

/**
 * The executives' bodies, seated at their loft desks. They are rule-based monitors: they never walk,
 * type or take a workstation. The chief of staff is the existing city chief, moved to its office.
 */
export class ExecutiveBodies {
  readonly group = new THREE.Group();
  private people = new Map<ExecutiveRole, Person>();

  constructor(private chief: THREE.Object3D, ceoStyle: number) {
    this.group.name = 'Executives';
    for (const d of EXECUTIVE_DESKS) {
      if (d.role === 'chief_of_staff' || !EXECUTIVES[d.role].active) continue;
      const p = new Person(EXECUTIVES[d.role].name, '#a07a3c', lookFromSeed(`executive-${d.role}`), executiveOutfit(d.role, ceoAvatar(ceoStyle)));
      p.showLabel(false);
      p.pose = 'sit';
      this.place(p.root, d);
      this.group.add(p.root);
      this.people.set(d.role, p);
    }
    this.place(chief, EXECUTIVE_DESKS.find((d) => d.role === 'chief_of_staff')!);
  }

  private place(root: THREE.Object3D, d: (typeof EXECUTIVE_DESKS)[number]) {
    const seat = executiveSeat(d);
    root.position.set(seat.x, LOFT.y, seat.z + 0.03);
    root.rotation.y = d.rotY + Math.PI;
  }

  /** A body only for staffed roles the server reports active; nothing is shown that the server does not say. */
  sync(org: OrgState | null) {
    for (const [role, p] of this.people) p.root.visible = !!org?.executives.find((e) => e.role === role)?.active;
  }

  redress(ceoStyle: number) {
    for (const [role, p] of this.people) p.setOutfit(executiveOutfit(role, ceoAvatar(ceoStyle)));
  }

  update(dt: number, t: number) {
    for (const p of this.people.values()) if (p.root.visible) p.update(dt, t, false, false);
  }

  /** Seated executives with their worn avatar, for headless checks. */
  report() {
    return [...this.people].map(([role, p]) => ({ role, visible: p.root.visible, avatar: p.wearing.avatar, pose: p.pose, y: p.root.position.y }));
  }
}
