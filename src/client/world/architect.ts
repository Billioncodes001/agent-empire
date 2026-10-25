/**
 * CITY-10: renders the city architect's additions (`ArchitectState.world` from an own-server host).
 *
 * - The document is validated again here with the shared rules, plus the live district colliders. An invalid document
 *   renders nothing; an invalid addition is skipped. Nothing is guessed or repaired in the game.
 * - Kit models reuse the templates the districts already loaded (no new downloads); the two plants are original
 *   procedural geometry. Each model is one InstancedMesh for all of its additions (one draw call per primitive).
 * - Built only once the district kits are in and there is at least one addition: an install without the file, or with
 *   the architect off, costs nothing. Low quality and Save-Data show buildings only.
 * - Walking up to an addition shows "Built by the city architect · day · reason": these are never agent work.
 */
import * as THREE from 'three';
import {
  WORLD_CAPS, catalogEntry, footprintOf, invalidAdditions, validateDocument, visibleKinds,
  type Box2, type WorldAddition, type WorldDocument,
} from '../../shared/world';
import { solid } from './materials';
import { textPlane } from './toon';
import type { Collider } from './office';
import type { Districts } from './districts';
import { colliderMaySolidify, type CarPose } from './district-layout';
import type { GraphicsQuality } from '../graphics';

const saveDataOn = () => typeof navigator !== 'undefined' && !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;

/** The procedural plants: a round tree (trunk and canopy) and a shrub. Original geometry, built once. */
function floraTemplates() {
  const bark = solid('#6b5a44', 0.9), leaves = solid('#4f7a4a', 0.85), shrub = solid('#5d8452', 0.85);
  const tree = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 2.4, 7), bark);
  trunk.position.y = 1.2;
  const canopy = new THREE.Mesh(new THREE.IcosahedronGeometry(1.55, 1), leaves);
  canopy.position.y = 3.55;
  canopy.scale.set(1, 0.92, 1);
  tree.add(trunk, canopy);
  const bush = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 1), shrub);
  ball.position.y = 0.46;
  ball.scale.set(1, 0.66, 1);
  bush.add(ball);
  return new Map<string, THREE.Object3D>([['flora/tree-round', tree], ['flora/shrub', bush]]);
}

export function buildArchitectLayer(parent: THREE.Group, districts: Districts) {
  const group = new THREE.Group();
  group.name = 'City architect additions';
  parent.add(group);
  // Allocated once: the colliders array is copied into the player's list at start-up. Solid only once nobody stands in one.
  const colliders: Collider[] = Array.from({ length: WORLD_CAPS.total }, () => ({ minX: 0, maxX: 0, minZ: 0, maxZ: 0, top: 0 }));
  const pending: { collider: Collider; box: Collider }[] = [];
  let doc: WorldDocument | undefined;
  let shown: WorldAddition[] = [];
  /** Footprints of the shown additions, computed once per rebuild (the hint runs every frame). */
  let shownBoxes: Box2[] = [];
  let quality: GraphicsQuality = 'medium';
  let built = '';
  let flora: Map<string, THREE.Object3D> | undefined;
  let warned = '';
  const stats = { rendered: 0, skipped: 0, invalid: '' as string, revision: -1 };

  function clear() {
    for (const child of [...group.children]) {
      child.removeFromParent();
      child.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.dispose();
        // Sign text planes own their geometry, texture and material; instanced meshes share the template's.
        if (o instanceof THREE.Mesh && o.userData.ownsResources) { o.geometry.dispose(); const m = o.material as THREE.MeshBasicMaterial; m.map?.dispose(); m.dispose(); }
      });
    }
    for (const c of colliders) Object.assign(c, { minX: 0, maxX: 0, minZ: 0, maxZ: 0, top: 0 });
    pending.length = 0;
  }

  function colliderFor(a: WorldAddition): Collider {
    const e = catalogEntry(a.model)!;
    const f = footprintOf(e, a.x, a.z, a.yaw, 0.05);
    if (e.kind === 'light' || e.kind === 'sign') return { minX: a.x - 0.15, maxX: a.x + 0.15, minZ: a.z - 0.15, maxZ: a.z + 0.15, top: 3 };
    if (a.model === 'flora/tree-round') return { minX: a.x - 0.3, maxX: a.x + 0.3, minZ: a.z - 0.3, maxZ: a.z + 0.3, top: 3 };
    return { ...f };
  }

  function rebuild() {
    clear();
    stats.rendered = 0;
    shown = []; shownBoxes = [];
    if (!doc || !doc.additions.length || !districts.loaded) return;
    const kinds = visibleKinds({ quality, saveData: saveDataOn() });
    shown = doc.additions.filter((a) => kinds.includes(catalogEntry(a.model)!.kind));
    shownBoxes = shown.map((a) => footprintOf(a.model, a.x, a.z, a.yaw));
    const byModel = new Map<string, WorldAddition[]>();
    for (const a of shown) (byModel.get(a.model) ?? byModel.set(a.model, []).get(a.model)!).push(a);
    for (const [model, list] of byModel) {
      const e = catalogEntry(model)!;
      const template = e.kit === 'flora' ? (flora ??= floraTemplates()).get(model) : districts.template(e.kit, e.model);
      if (!template) continue;
      template.updateMatrixWorld(true);
      template.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const mesh = new THREE.InstancedMesh(o.geometry, o.material, list.length);
        list.forEach((a, i) => mesh.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(a.x, 0, a.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (a.yaw * Math.PI) / 2), new THREE.Vector3(e.scale, e.scale, e.scale)).multiply(o.matrixWorld)));
        mesh.castShadow = e.kind === 'building' || e.kind === 'landscape';
        mesh.receiveShadow = true;
        mesh.name = `Architect ${model}`;
        mesh.computeBoundingSphere();
        group.add(mesh);
      });
    }
    // Street-sign blades carry their (already sanitised) text.
    for (const a of shown.filter((x) => catalogEntry(x.model)!.kind === 'sign' && x.text)) {
      const t = textPlane(a.text!, { size: 48, color: '#eee9dd' });
      t.userData.ownsResources = true;
      const yaw = (a.yaw * Math.PI) / 2;
      t.scale.setScalar(1.5 / t.geometry.parameters.width);
      t.position.set(a.x + Math.sin(yaw) * 0.25, 2.55, a.z + Math.cos(yaw) * 0.25);
      t.rotation.y = yaw;
      group.add(t);
    }
    shown.forEach((a, i) => { if (i < colliders.length) pending.push({ collider: colliders[i], box: colliderFor(a) }); });
    stats.rendered = shown.length;
  }

  function refresh() {
    const key = `${doc?.revision ?? -1}|${doc?.additions.length ?? 0}|${quality}|${saveDataOn()}|${districts.loaded}`;
    if (key === built) return;
    built = key;
    rebuild();
  }

  void districts.kitsLoaded.then(() => refresh());

  const near = (b: Box2, p: { x: number; z: number }, r: number) => p.x > b.minX - r && p.x < b.maxX + r && p.z > b.minZ - r && p.z < b.maxZ + r;
  return {
    group,
    colliders,
    stats,
    /** The world from the host's architect state. Missing (older hosts, cloud mode) is an empty world. */
    sync(raw: unknown) {
      if (raw === undefined || raw === null) { doc = undefined; refresh(); return; }
      const v = validateDocument(raw);
      if ('error' in v) {
        doc = undefined;
        stats.invalid = v.error;
        if (warned !== v.error) { warned = v.error; console.warn(`City architect additions not shown: ${v.error}`); }
        refresh();
        return;
      }
      // The live district colliders (the host's lots are proven clear of them; this guards a changed layout).
      const bad = invalidAdditions(v.ok, { obstacles: districts.layout.colliders });
      stats.skipped = bad.length;
      stats.revision = v.ok.revision;
      stats.invalid = '';
      doc = bad.length ? { ...v.ok, additions: v.ok.additions.filter((a) => !bad.some((b) => b.id === a.id)) } : v.ok;
      refresh();
    },
    setQuality(q: GraphicsQuality) { quality = q; refresh(); },
    /** `bodies`: the live vehicles (the driven ride, the parked sedan); `driving`: the founder is one of them. */
    update(player: THREE.Vector3, bodies: readonly CarPose[] = [], driving = false) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const { collider, box } = pending[i];
        if (!colliderMaySolidify(box, player, bodies, driving)) continue;
        Object.assign(collider, box);
        pending.splice(i, 1);
      }
    },
    /** "Built by the city architect · day · reason" near an addition at street level. */
    hint(p: THREE.Vector3): string {
      if (p.y > 2) return '';
      const i = shownBoxes.findIndex((b) => near(b, p, 1.6));
      const a = i >= 0 ? shown[i] : undefined;
      if (!a) return '';
      const reason = a.reason.length > 90 ? `${a.reason.slice(0, 87)}…` : a.reason;
      return `Built by the city architect · ${a.day} · ${reason}`;
    },
  };
}
export type ArchitectLayer = ReturnType<typeof buildArchitectLayer>;
