/**
 * CITY-08: the company helicopter, built procedurally (no CC0 helicopter exists in the pinned Kenney packs, and nothing
 * new is downloaded). Local frame: +z is the nose, −x the pilot's door, y = 0 the skid soles. About 2,600 triangles in
 * eleven draw calls; static parts are merged.
 *
 * Reduced motion: the main rotor is shown as a static translucent disc instead of spinning blades, and the airframe
 * does not pitch or bank.
 */
import * as THREE from 'three';
import { batchStaticMeshes } from './batching';
import type { VehicleMotion } from '../vehicle';

const paint = new THREE.MeshStandardMaterial({ color: '#2f5d62', roughness: 0.38, metalness: 0.35 });
const stripe = new THREE.MeshStandardMaterial({ color: '#d9c7a1', roughness: 0.5, metalness: 0.1 });
const dark = new THREE.MeshStandardMaterial({ color: '#1d2427', roughness: 0.6, metalness: 0.4 });
const metal = new THREE.MeshStandardMaterial({ color: '#8d969a', roughness: 0.35, metalness: 0.8 });
const glass = new THREE.MeshStandardMaterial({ color: '#1b2a30', roughness: 0.05, metalness: 0.6, transparent: true, opacity: 0.55, depthWrite: false });

function mesh(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  parent.add(m);
  return m;
}

/** Flight state the rig reads; a plain VehicleMotion (no rotor fields) leaves the rotor still. */
type RotorState = VehicleMotion & { rotor?: number; spool?: number; pitch?: number; roll?: number };

export function buildHelicopter() {
  const root = new THREE.Group();
  root.name = 'Company helicopter';
  const airframe = new THREE.Group();
  airframe.position.y = 0.01;
  root.add(airframe);
  const body = new THREE.Group();
  airframe.add(body);
  // Skids and struts.
  for (const side of [-1, 1]) {
    mesh(body, new THREE.CylinderGeometry(0.06, 0.06, 3.7, 10), metal, side * 1.05, 0.08, 0.3, Math.PI / 2);
    mesh(body, new THREE.CylinderGeometry(0.06, 0.06, 0.35, 10), metal, side * 1.05, 0.2, 2.18, 0.9);
    for (const z of [-0.6, 1.3]) mesh(body, new THREE.CylinderGeometry(0.05, 0.05, 0.95, 8), metal, side * 0.85, 0.52, z, 0, 0, side * 0.45);
  }
  // Fuselage: a streamlined pod, a belly stripe and the engine housing.
  const pod = new THREE.SphereGeometry(1, 28, 18);
  mesh(body, pod, paint, 0, 1.45, 0.25).scale.set(1.12, 0.98, 2.05);
  mesh(body, new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, Math.PI * 0.62, Math.PI * 0.2), stripe, 0, 1.45, 0.25).scale.set(1.13, 0.99, 2.06);
  mesh(body, new THREE.BoxGeometry(0.95, 0.5, 1.7), paint, 0, 2.38, -0.15);
  mesh(body, new THREE.BoxGeometry(0.7, 0.2, 0.5), dark, 0, 2.5, -0.95);
  // Tail boom, fin and stabiliser.
  mesh(body, new THREE.CylinderGeometry(0.13, 0.3, 4.3, 14), paint, 0, 1.82, -3.05, Math.PI / 2 + 0.06);
  mesh(body, new THREE.BoxGeometry(0.08, 1.15, 0.75), paint, 0, 2.3, -5.05, -0.35);
  mesh(body, new THREE.BoxGeometry(1.5, 0.06, 0.42), paint, 0, 1.72, -4.55);
  mesh(body, new THREE.CylinderGeometry(0.05, 0.05, 0.3, 8), metal, 0.12, 2.25, -5.2, 0, 0, Math.PI / 2);
  // Mast and hub.
  mesh(body, new THREE.CylinderGeometry(0.1, 0.12, 0.45, 12), metal, 0, 2.82, 0.15);
  // Static cockpit: two seats, the panel and the cyclic, seen through the canopy.
  for (const x of [-0.42, 0.42]) {
    mesh(body, new THREE.BoxGeometry(0.5, 0.12, 0.5), dark, x, 0.95, 1.0);
    mesh(body, new THREE.BoxGeometry(0.5, 0.65, 0.1), dark, x, 1.3, 0.72, -0.15);
  }
  mesh(body, new THREE.BoxGeometry(1.1, 0.22, 0.22), dark, 0, 1.27, 2.0, -0.6);
  mesh(body, new THREE.CylinderGeometry(0.02, 0.02, 0.55, 6), metal, -0.42, 1.18, 1.45, 0.35);
  batchStaticMeshes(body);
  // Canopy glass over the cockpit (kept separate: transparent).
  const canopy = mesh(airframe, new THREE.SphereGeometry(1, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), glass, 0, 1.38, 1.15, 0.35);
  canopy.scale.set(1.0, 0.95, 1.25);
  canopy.castShadow = false;
  // Pilot's door: a glazed leaf hinged at its front edge, shown only while open.
  const doorHinge = new THREE.Group();
  doorHinge.position.set(-1.08, 0, 1.75);
  airframe.add(doorHinge);
  const leaf = new THREE.Group();
  leaf.visible = false;
  doorHinge.add(leaf);
  mesh(leaf, new THREE.BoxGeometry(0.05, 0.55, 1.05), paint, -0.03, 1.05, -0.55);
  mesh(leaf, new THREE.BoxGeometry(0.04, 0.6, 0.95), glass, -0.03, 1.62, -0.55).castShadow = false;
  // Main rotor: four blades, and a disc used under reduced motion and as motion blur at speed.
  const rotor = new THREE.Group();
  rotor.position.set(0, 3.05, 0.15);
  airframe.add(rotor);
  const blade = new THREE.BoxGeometry(0.28, 0.04, 5.2);
  for (let i = 0; i < 4; i++) {
    const b = mesh(rotor, blade, dark, 0, 0, 0, 0, (i * Math.PI) / 2);
    b.geometry = blade.clone().translate(0, 0, 2.6);
  }
  mesh(rotor, new THREE.CylinderGeometry(0.22, 0.22, 0.16, 12), metal, 0, 0, 0);
  const discMat = new THREE.MeshBasicMaterial({ color: '#2a3236', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const disc = mesh(airframe, new THREE.CircleGeometry(5.2, 40), discMat, 0, 3.05, 0.15, -Math.PI / 2);
  disc.castShadow = false;
  const tail = new THREE.Group();
  tail.position.set(0.28, 2.25, -5.2);
  airframe.add(tail);
  for (const s of [-1, 1]) mesh(tail, new THREE.BoxGeometry(0.03, 0.62, 0.11), dark, 0, s * 0.31, 0);

  return {
    root,
    setDoor(amount: number) {
      leaf.visible = amount > 0.01;
      doorHinge.rotation.y = amount * 1.15;
    },
    handle: () => leaf.localToWorld(new THREE.Vector3(-0.08, 1.3, -0.95)),
    animate(dt: number, motion: RotorState, reduced: boolean) {
      const spool = motion.spool ?? 0;
      root.userData.rotor = reduced ? 'disc' : 'blades';
      airframe.rotation.x = reduced ? 0 : -(motion.pitch ?? 0);
      airframe.rotation.z = reduced ? 0 : motion.roll ?? 0;
      if (reduced) {
        rotor.children.forEach((c, i) => (c.visible = i === 4));
        discMat.opacity = 0.14 + spool * 0.12;
      } else {
        rotor.children.forEach((c) => (c.visible = true));
        rotor.rotation.y = motion.rotor ?? rotor.rotation.y;
        discMat.opacity = Math.max(0, spool - 0.6) * 0.35;
      }
      tail.rotation.x = reduced ? 0 : (motion.rotor ?? 0) * 3;
      void dt;
    },
  };
}
export type Helicopter = ReturnType<typeof buildHelicopter>;
