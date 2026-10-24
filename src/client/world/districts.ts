/**
 * FREE-09 (CITY-05/07): renders the Meridian business district, Harbour works and the Meridian motor garage.
 * - Kenney CC0 kits are instanced per model and district (one draw call per model primitive per district), so each
 *   district is frustum-culled as a unit; street furniture is hidden beyond 170 m and on the Low preset.
 * - Palette textures: 256² on phones and with Save-Data, 512² elsewhere (same rule as the avatars).
 * - Lamps are emissive; no dynamic lights are added. The roller door is the only animation, and it is functional.
 * - Plot signs and garage vehicles follow the authoritative save (`EmpireState.city`); nothing here grants credits.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DISTRICTS, GARAGE, PLOTS, VEHICLE_MODELS, normalizeCity, type CityState, type PlotId } from '../../shared/city';
import { SURFACE as S, boxMesh as box, solid } from './materials';
import { textPlane } from './toon';
import { batchStaticMeshes } from './batching';
import { districtLayout, liveCarPose, settleSlots, slotClear, type CarPose, footprint, PLOT_PAD, plotSign, ROADS, type Box, type Kit, type Placement } from './district-layout';
import type { Collider } from './office';
import type { GraphicsQuality } from '../graphics';

const KITS: Kit[] = ['commercial', 'industrial', 'streets', 'vehicles'];
export function cityTextureSuffix(): '' | '-phone' {
  if (typeof navigator === 'undefined' || typeof matchMedia !== 'function') return '';
  const saveData = !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
  return saveData || phone ? '-phone' : '';
}
export type CityTarget = { kind: 'garage' } | { kind: 'plot'; plot: PlotId };

function sign(parent: THREE.Object3D, text: string, x: number, y: number, z: number, width: number, yaw = 0) {
  const m = textPlane(text, { size: 64, color: '#eee9dd' });
  m.position.set(x, y, z);
  m.rotation.y = yaw;
  m.scale.setScalar(width / m.geometry.parameters.width);
  parent.add(m);
  return m;
}

export function buildDistricts(parent: THREE.Group) {
  const group = new THREE.Group();
  group.name = 'FREE-09 districts';
  parent.add(group);
  const layout = districtLayout();
  const colliders: Collider[] = layout.colliders.map((c) => ({ ...c }));
  // Asphalt, kerbs and lane markings in the founding district's own materials, so the street grid reads continuous.
  for (const r of ROADS) {
    box(group, r.w, 0.13, r.d, S.road, r.x, -0.03, r.z);
    const along = r.w > r.d;
    for (const side of [-1, 1]) {
      if (along) box(group, r.w, 0.17, 2.3, S.concrete, r.x, -0.01, r.z + side * (r.d / 2 + 1.15));
      else box(group, 2.3, 0.17, r.d, S.concrete, r.x + side * (r.d / 2 + 1.15), -0.01, r.z);
    }
    const length = along ? r.w : r.d;
    for (let t = -length / 2 + 3; t < length / 2 - 3; t += 4.5)
      box(group, along ? 2 : 0.12, 0.009, along ? 0.12 : 2, solid('#d1c8a5'), along ? r.x + t : r.x, 0.041, along ? r.z : r.z + t);
  }
  // Harbour quay: timber deck, kerb, bollards and rail at the water's edge.
  box(group, 95, 0.25, 5, S.wood, 102.5, -0.02, 214.5);
  box(group, 95, 0.5, 0.35, S.concrete, 102.5, -0.15, 217.1);
  for (let x = 57; x < 150; x += 3) box(group, 0.06, 1.1, 0.06, S.frame, x, 0.55, 216.8);
  for (const y of [0.45, 0.85, 1.1]) box(group, 95, 0.045, 0.04, S.frame, 102.5, y, 216.8);
  for (let x = 60; x < 150; x += 12) box(group, 0.4, 0.6, 0.4, solid('#2b3134'), x, 0.3, 213);
  colliders.push({ minX: 55, maxX: 150, minZ: 216.6, maxZ: 217.2, top: 1.2 });
  sign(group, 'MERIDIAN BUSINESS DISTRICT', 100, 4.4, 30.5, 9);
  sign(group, 'HARBOUR WORKS', 100, 4.4, 121.6, 6);
  batchStaticMeshes(group);

  // Plots: paving, corner posts and a sign that follows the save.
  const plotSigns = new Map<PlotId, THREE.Mesh>();
  const plotGroups = new Map<PlotId, THREE.Group>();
  for (const p of PLOTS) {
    const g = new THREE.Group();
    group.add(g);
    plotGroups.set(p.id, g);
    box(g, PLOT_PAD.w, 0.08, PLOT_PAD.d, S.stone, p.x, 0.015, p.z);
    for (const dx of [-1, 1]) for (const dz of [-1, 1]) box(g, 0.12, 1.2, 0.12, S.frame, p.x + dx * PLOT_PAD.w / 2, 0.6, p.z + dz * PLOT_PAD.d / 2);
    box(g, 0.1, 2.2, 0.1, S.frame, p.x, 1.1, plotSign(p.id).z - 0.1);
    batchStaticMeshes(g);
  }
  function setPlotSign(id: PlotId, owned: boolean) {
    const p = PLOTS.find((q) => q.id === id)!;
    const old = plotSigns.get(id);
    if (old && old.userData.owned === owned) return;
    if (old) { old.removeFromParent(); old.geometry.dispose(); (old.material as THREE.Material).dispose(); }
    const text = owned ? `${p.name.toUpperCase()} / OWNED` : `${p.name.toUpperCase()} / FOR SALE ${p.cost.toLocaleString('en-US')} CR`;
    const m = sign(plotGroups.get(id)!, text, p.x, 2.1, plotSign(id).z, 7);
    m.userData.owned = owned;
    plotSigns.set(id, m);
  }

  // Meridian motor garage: concrete shell, glazed clerestory, ceiling light strips, painted bays and a kiosk.
  const garage = new THREE.Group();
  garage.name = GARAGE.name;
  group.add(garage);
  const { x: gx, z: gz, width: gw, depth: gd, door } = GARAGE;
  box(garage, gw, 0.1, gd, S.concrete, gx, 0.02, gz);
  for (const w of layout.garage.walls.slice(0, 5)) box(garage, w.maxX - w.minX, 5.2, w.maxZ - w.minZ, S.plaster, (w.minX + w.maxX) / 2, 2.6, (w.minZ + w.maxZ) / 2);
  box(garage, gw + 0.6, 0.3, gd + 0.6, S.concrete, gx, 5.4, gz);
  box(garage, gw, 0.8, 0.05, S.glass, gx, 5.6, gz + gd / 2 + 0.25);
  // Facade: stone plinth, cornice, pilasters, ribbed cladding panels with clerestory windows, a door surround and kerb.
  const front = gz + gd / 2 + 0.2;
  box(garage, gw + 0.3, 0.45, 0.12, S.stone, gx, 0.22, front + 0.06);
  box(garage, gw + 0.5, 0.35, 0.25, S.concrete, gx, 5.15, front + 0.1);
  for (const x of [gx - gw / 2, door.x - door.width / 2 - 0.3, door.x + door.width / 2 + 0.3, gx + gw / 2]) box(garage, 0.5, 5.2, 0.22, S.concrete, x, 2.6, front + 0.08);
  for (const [x0, x1] of [[gx - gw / 2 + 0.25, door.x - door.width / 2 - 0.55], [door.x + door.width / 2 + 0.55, gx + gw / 2 - 0.25]]) {
    const cx = (x0 + x1) / 2, w = x1 - x0;
    for (let x = x0 + 0.2; x < x1; x += 0.4) box(garage, 0.06, 2.4, 0.06, solid('#8f9a9a', 0.5, 0.4), x, 1.65, front + 0.04);
    box(garage, w - 0.6, 1.1, 0.04, S.glass, cx, 3.75, front + 0.03);
    for (const y of [3.18, 4.32]) box(garage, w - 0.5, 0.07, 0.1, S.frame, cx, y, front + 0.06);
    for (let i = 1; i < 3; i++) box(garage, 0.06, 1.1, 0.1, S.frame, x0 + 0.3 + ((w - 0.6) * i) / 3, 3.75, front + 0.06);
  }
  box(garage, door.width + 0.6, 0.3, 0.4, S.frame, door.x, 4.75, door.z + 0.1);
  for (const dx of [-1, 1]) box(garage, 0.18, 4.6, 0.3, S.frame, door.x + dx * (door.width / 2 + 0.09), 2.3, door.z + 0.1);
  box(garage, door.width + 1, 0.16, 0.6, S.concrete, door.x, 0.05, door.z + 0.4);
  // A warm emissive bar under the canopy lights the door at every time of day without a dynamic light.
  box(garage, door.width - 0.4, 0.06, 0.18, new THREE.MeshStandardMaterial({ color: '#fff4dc', emissive: '#ffe6b8', emissiveIntensity: 1.6 }), door.x, 4.56, door.z + 0.32);
  const strip = new THREE.MeshStandardMaterial({ color: '#fff4dc', emissive: '#fff1d0', emissiveIntensity: 1.4 });
  for (const b of GARAGE.bays) {
    box(garage, 0.6, 0.06, 4.4, strip, b.x, 5.15, b.z);
    for (const dx of [-2.4, 2.4]) box(garage, 0.1, 0.012, 5.2, solid('#e6e1cf'), b.x + dx, 0.075, b.z);
  }
  box(garage, 1.6, 1.05, 0.8, S.wood, 81.8, 0.53, 82.8);
  box(garage, 0.5, 0.35, 0.04, solid('#7e9697'), 81.8, 1.3, 82.6);
  // The sign board is sized to its text with padding.
  const label = sign(garage, GARAGE.name.toUpperCase(), door.x, 5.95, front + 0.36, 7.6);
  const labelH = label.geometry.parameters.height * label.scale.y;
  box(garage, 7.6 + 0.9, labelH + 0.4, 0.14, solid('#1d2a2e', 0.4, 0.3), door.x, 5.95, front + 0.26);
  const rollerDoor = new THREE.Group();
  rollerDoor.position.set(door.x, 0, door.z);
  garage.add(rollerDoor);
  box(rollerDoor, door.width, 4.6, 0.08, solid('#9aa3a3', 0.6, 0.5), 0, 2.3, 0);
  for (let y = 0.4; y < 4.6; y += 0.4) box(rollerDoor, door.width, 0.03, 0.1, S.frame, 0, y, 0);
  batchStaticMeshes(garage);
  const doorCollider: Collider = { ...layout.garage.door };
  colliders.push(doorCollider);
  let doorOpen = 0;

  // Bay and apron colliders are allocated once and raised only while a vehicle stands there (the colliders array
  // is copied into the player's list at start-up, so it must not grow later).
  const baySlots = GARAGE.bays.map((b) => ({ x: b.x, z: b.z, yaw: 0, collider: { minX: b.x - 1.1, maxX: b.x + 1.1, minZ: b.z - 2.4, maxZ: b.z + 2.4, top: 0 } as Collider, occupied: false }));
  const apronSlots = GARAGE.apron.map((a) => ({ x: a.x, z: a.z, yaw: a.yaw, collider: { minX: a.x - 2.4, maxX: a.x + 2.4, minZ: a.z - 1.1, maxZ: a.z + 1.1, top: 0 } as Collider, occupied: false }));
  colliders.push(...baySlots.map((s) => s.collider), ...apronSlots.map((s) => s.collider));

  // Instanced kit models, grouped per district for culling and LOD.
  const districtGroups = new Map(DISTRICTS.map((d) => {
    const g = new THREE.Group(); g.name = d.name; group.add(g);
    const furniture = new THREE.Group(); furniture.name = `${d.name} street furniture`; g.add(furniture);
    return [d.id, { group: g, furniture, center: new THREE.Vector3((d.minX + d.maxX) / 2, 0, (d.minZ + d.maxZ) / 2) }] as const;
  }));
  const templates = new Map<string, THREE.Object3D>();
  const garageCars = new THREE.Group();
  garageCars.name = 'Garage vehicles';
  group.add(garageCars);
  let ready = false, failed = false, city: CityState = normalizeCity(undefined), quality: GraphicsQuality = 'medium';

  const placementMatrix = (p: { x: number; z: number; yaw: number; scale: number }) =>
    new THREE.Matrix4().compose(new THREE.Vector3(p.x, 0, p.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw), new THREE.Vector3(p.scale, p.scale, p.scale));

  function instance(placements: Placement[]) {
    const byKey = new Map<string, Placement[]>();
    for (const p of placements) {
      const key = `${p.district}|${p.furniture}|${p.kit}|${p.model}`;
      (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(p);
    }
    for (const [key, list] of byKey) {
      const [district, furniture, kit, model] = key.split('|');
      const template = templates.get(`${kit}/${model}`);
      if (!template) continue;
      template.updateMatrixWorld(true);
      const parentGroup = districtGroups.get(district as never)!;
      template.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const mesh = new THREE.InstancedMesh(o.geometry, o.material, list.length);
        list.forEach((p, i) => mesh.setMatrixAt(i, placementMatrix(p).multiply(o.matrixWorld)));
        mesh.castShadow = furniture === 'false';
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        (furniture === 'true' ? parentGroup.furniture : parentGroup.group).add(mesh);
      });
    }
  }

  function placeGarageCars() {
    garageCars.traverse((o) => { if (o instanceof THREE.InstancedMesh) o.dispose(); });
    garageCars.clear();
    if (!ready) return;
    const slots = [...baySlots, ...apronSlots];
    settleSlots(slots, slots.map((s) => city.vehicles.some((v) => (v.apron !== undefined ? apronSlots[v.apron] : baySlots[v.bay]) === s)));
    for (const v of city.vehicles) {
      const asset = VEHICLE_MODELS.find((m) => m.id === v.model)!.asset;
      const template = templates.get(`vehicles/${asset}`);
      const slot = v.apron !== undefined ? apronSlots[v.apron] : baySlots[v.bay];
      // A newly occupied slot turns solid in update() once the sedan and the founder are clear of it.
      if (!template) continue;
      const car = template.clone();
      car.name = `Owned ${v.model} (${v.id})`;
      car.position.set(slot.x, 0, slot.z);
      car.rotation.y = slot.yaw;
      car.scale.setScalar(1.8);
      car.userData.vehicleId = v.id;
      car.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; } });
      garageCars.add(car);
    }
  }

  const suffix = cityTextureSuffix();
  const loader = new GLTFLoader();
  const textureLoader = new THREE.TextureLoader();
  Promise.all(KITS.map(async (kit) => {
    const [gltf, map] = await Promise.all([loader.loadAsync(`/models/city/${kit}.glb`), textureLoader.loadAsync(`/models/city/${kit}${suffix}.webp`)]);
    map.flipY = false;
    map.colorSpace = THREE.SRGBColorSpace;
    map.magFilter = THREE.NearestFilter;
    gltf.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        m.map = map;
        // The Kenney palette is bright and flat; a slight grade sits it beside the founding district's surfaces.
        if (kit !== 'vehicles') m.color = new THREE.Color('#d6d4cf');
        // Kenney lamp heads and lit windows share the palette's pale cells; a little emission keeps them readable.
        if (kit === 'streets') { m.emissive = new THREE.Color('#fff0c8'); m.emissiveMap = map; m.emissiveIntensity = 0.25; }
        m.needsUpdate = true;
      }
    });
    for (const root of gltf.scene.children) templates.set(`${kit}/${root.name}`, root);
  })).then(() => {
    instance(layout.placements);
    ready = true;
    placeGarageCars();
  }, (e) => { failed = true; console.warn('City district kits unavailable', e); });

  const near = (a: { x: number; z: number }, p: { x: number; z: number }, r: number) => Math.hypot(a.x - p.x, a.z - p.z) < r;
  return {
    group,
    colliders,
    layout,
    /** True once every kit is in, or when loading failed (the splash then stops waiting and the console says why). */
    get ready() { return ready || failed; },
    get loaded() { return ready; },
    garageCars,
    sync(raw: unknown) {
      const next = normalizeCity(raw);
      const changed = JSON.stringify(next.vehicles) !== JSON.stringify(city.vehicles);
      city = next;
      for (const p of PLOTS) setPlotSign(p.id, city.plots.includes(p.id));
      if (changed) placeGarageCars();
    },
    get city() { return city; },
    setQuality(q: GraphicsQuality) { quality = q; },
    update(dt: number, player: THREE.Vector3, sedan: CarPose, driving: boolean, facing = 0) {
      const car = liveCarPose(driving, player, facing, sedan);
      // Street furniture LOD: hidden on Low and beyond 170 m of a district's centre.
      for (const d of districtGroups.values()) d.furniture.visible = quality !== 'low' && d.center.distanceTo(player) < 170;
      const wants = near(door, player, 6.5) || near(door, car.position, 7);
      doorOpen = THREE.MathUtils.clamp(doorOpen + (wants ? dt : -dt) / 1.2, 0, 1);
      rollerDoor.position.y = doorOpen * 4.3;
      rollerDoor.scale.y = 1 - doorOpen * 0.85;
      doorCollider.top = doorOpen > 0.85 ? 0 : 4.6;
      void driving;
      for (const s of [...baySlots, ...apronSlots])
        if (s.occupied && s.collider.top === 0 && slotClear(s.collider, car, player, driving)) s.collider.top = 1.7;
    },
    /** Apron slots the live sedan or the founder currently occupies (sent with "Bring out"; the host adds saved ones). */
    apronBlocked(player: THREE.Vector3, car: { position: THREE.Vector3; rotation: { y: number } }) {
      return apronSlots.flatMap((s, i) => (slotClear(s.collider, car, player) ? [] : [i]));
    },
    /** What the interaction key does here: the garage kiosk, or a plot's sign. */
    targetAt(p: THREE.Vector3): CityTarget | null {
      if (near(layout.garage.kiosk, p, 2.6)) return { kind: 'garage' };
      const plot = PLOTS.find((q) => near(plotSign(q.id), p, 3.5));
      return plot ? { kind: 'plot', plot: plot.id } : null;
    },
    hintAt(p: THREE.Vector3, key: string): string {
      const t = this.targetAt(p);
      if (t?.kind === 'garage') return `${key} Garage: buy, bring out or store vehicles`;
      if (t?.kind === 'plot') {
        const plot = PLOTS.find((q) => q.id === t.plot)!;
        return city.plots.includes(plot.id) ? `${plot.name} · owned` : `${key} ${plot.name} · ${plot.cost.toLocaleString('en-US')} city credits`;
      }
      if (near(door, p, 5)) return `${GARAGE.name} · walk or drive through the roller door`;
      return '';
    },
    footprint,
  };
}
export type Districts = ReturnType<typeof buildDistricts>;
