/**
 * CITY-06: turns a Kenney Car Kit model into a drivable ride. The kit cars have no separate doors or interior, so this
 * adds a driver's door leaf painted with the body's own palette cell (shown only while open), and a dashboard, steering
 * wheel and roof header that frame the first-person view (the opaque body hides them from outside). The kit's named
 * wheels spin and the front pair steers; the body pitches and banks slightly, except under reduced motion.
 */
import * as THREE from 'three';
import { KENNEY_SCALE, type RideSpec } from '../rides';
import type { VehicleMotion } from '../vehicle';

const trim = new THREE.MeshStandardMaterial({ color: '#1b2225', roughness: 0.7, metalness: 0.2 });
const tint = new THREE.MeshStandardMaterial({ color: '#16242a', roughness: 0.05, metalness: 0.6, transparent: true, opacity: 0.6, depthWrite: false });

/** The palette UV covering the largest share of a mesh's vertices: the car's body colour. */
function dominantUv(mesh: THREE.Mesh): [number, number] | null {
  const uv = mesh.geometry.getAttribute('uv');
  if (!uv) return null;
  const counts = new Map<string, number>();
  let best: string | null = null;
  for (let i = 0; i < uv.count; i++) {
    const key = `${uv.getX(i).toFixed(3)},${uv.getY(i).toFixed(3)}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (!best || n > counts.get(best)!) best = key;
  }
  return best ? (best.split(',').map(Number) as [number, number]) : null;
}

export function dressKenneyCar(template: THREE.Object3D, spec: RideSpec) {
  const root = new THREE.Group();
  const model = template.clone();
  model.position.set(0, 0, 0);
  model.rotation.set(0, 0, 0);
  model.scale.setScalar(KENNEY_SCALE);
  const body = new THREE.Group();
  root.add(body);
  body.add(model);
  const wheels: { front: boolean; node: THREE.Object3D }[] = [];
  let bodyMesh: THREE.Mesh | undefined;
  model.traverse((o) => {
    if (o.name.startsWith('wheel-')) { o.rotation.order = 'YXZ'; wheels.push({ front: o.name.includes('front'), node: o }); }
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.parent?.name === 'body' || o.name === 'body') bodyMesh ??= o;
    }
  });
  // Wheels stay on the ground; only the sprung body leans.
  // (Kit wheels are direct children of the unrotated model, so moving them to the root only applies the kit scale.)
  for (const w of wheels) {
    w.node.position.multiplyScalar(KENNEY_SCALE);
    w.node.scale.multiplyScalar(KENNEY_SCALE);
    root.add(w.node);
  }

  // Driver's door leaf, hinged at its front edge on the −x side.
  const { w, l } = spec.half;
  const zc = spec.seat[2];
  const hinge = new THREE.Group();
  hinge.position.set(-w - 0.02, 0, zc + 0.6);
  body.add(hinge);
  const leaf = new THREE.Group();
  leaf.visible = false;
  hinge.add(leaf);
  const panel = new THREE.BoxGeometry(0.05, 0.62, 1.15);
  const uv = bodyMesh ? dominantUv(bodyMesh) : null;
  const material = bodyMesh && uv ? bodyMesh.material as THREE.Material : trim;
  if (uv) { const a = panel.getAttribute('uv'); for (let i = 0; i < a.count; i++) a.setXY(i, uv[0], uv[1]); }
  leaf.add(Object.assign(new THREE.Mesh(panel, material), { castShadow: true }).translateX(-0.03).translateY(spec.height * 0.38).translateZ(-0.58));
  leaf.add(new THREE.Mesh(new THREE.BoxGeometry(0.04, spec.height * 0.24, 1.0), tint).translateX(-0.03).translateY(spec.height * 0.66).translateZ(-0.55));
  const handlePoint = new THREE.Object3D();
  handlePoint.position.set(-0.08, spec.height * 0.52, -0.95);
  leaf.add(handlePoint);

  // First-person cabin framing (inside the opaque body).
  const eye = spec.eye;
  const dash = new THREE.Mesh(new THREE.BoxGeometry(w * 1.6, 0.16, 0.32), trim);
  dash.position.set(0, eye[1] - 0.42, zc + 0.78);
  body.add(dash);
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.025, 8, 24), trim);
  wheel.position.set(eye[0], eye[1] - 0.36, zc + 0.52);
  wheel.rotation.x = -0.35;
  body.add(wheel);
  const header = new THREE.Mesh(new THREE.BoxGeometry(w * 1.5, 0.07, 0.12), trim);
  header.position.set(0, Math.min(spec.height - 0.15, eye[1] + 0.3), zc + 0.35);
  body.add(header);
  void l;

  let spin = 0, pitch = 0, roll = 0;
  return {
    root,
    setDoor(amount: number) {
      leaf.visible = amount > 0.01;
      hinge.rotation.y = amount * 1.05;
    },
    handle: () => handlePoint.getWorldPosition(new THREE.Vector3()),
    animate(dt: number, motion: VehicleMotion, running: boolean, reduced: boolean) {
      spin = (spin + motion.speed * dt / (0.3 * KENNEY_SCALE)) % (Math.PI * 2);
      for (const x of wheels) { x.node.rotation.x = spin; x.node.rotation.y = x.front ? motion.steering : 0; }
      wheel.rotation.z = -motion.steering * 2.4;
      const lean = running && !reduced;
      pitch = THREE.MathUtils.damp(pitch, lean ? THREE.MathUtils.clamp(motion.acceleration * 0.007, -0.035, 0.035) : 0, 5, dt);
      roll = THREE.MathUtils.damp(roll, lean ? THREE.MathUtils.clamp(motion.speed * motion.speed * Math.tan(motion.steering) * 0.0007, -0.035, 0.035) : 0, 5, dt);
      body.rotation.x = pitch;
      body.rotation.z = roll;
    },
  };
}
