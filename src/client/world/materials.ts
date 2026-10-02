import * as THREE from 'three';
const loader = new THREE.TextureLoader();
const maps = new Map<string, THREE.Texture>();
function texture(name: string, color = false) {
  if (!maps.has(name)) {
    const t = loader.load(`/textures/${name}`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    maps.set(name, t);
  }
  return maps.get(name)!;
}
export const SURFACE = {
  concrete: new THREE.MeshStandardMaterial({
    color: '#d5d0c5',
    map: texture('concrete_wall_006-color.jpg', true),
    normalMap: texture('concrete_wall_006-normal.jpg'),
    roughnessMap: texture('concrete_wall_006-rough.jpg'),
    roughness: 0.92,
    normalScale: new THREE.Vector2(0.35, 0.35),
  }),
  road: new THREE.MeshStandardMaterial({
    color: '#74797e',
    map: texture('asphalt_02-color.jpg', true),
    normalMap: texture('asphalt_02-normal.jpg'),
    roughnessMap: texture('asphalt_02-rough.jpg'),
    roughness: 0.91,
    normalScale: new THREE.Vector2(0.45, 0.45),
  }),
  wood: new THREE.MeshStandardMaterial({
    color: '#a89175',
    map: texture('wood-color.jpg', true),
    normalMap: texture('wood-normal.jpg'),
    roughnessMap: texture('wood-rough.jpg'),
    roughness: 0.67,
    normalScale: new THREE.Vector2(0.25, 0.25),
  }),
  stone: new THREE.MeshStandardMaterial({
    color: '#aca69a',
    map: texture('concrete_wall_006-color.jpg', true),
    normalMap: texture('concrete_wall_006-normal.jpg'),
    roughness: 0.82,
    normalScale: new THREE.Vector2(0.2, 0.2),
  }),
  glass: new THREE.MeshPhysicalMaterial({
    color: '#688c9b',
    metalness: 0.25,
    roughness: 0.075,
    envMapIntensity: 1.4,
    clearcoat: 1,
    transparent: true,
    opacity: 0.67,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
  frame: new THREE.MeshStandardMaterial({ color: '#242c30', metalness: 0.8, roughness: 0.27 }),
  plaster: new THREE.MeshStandardMaterial({ color: '#ded8cc', roughness: 0.9 }),
  fabric: new THREE.MeshStandardMaterial({ color: '#6b7774', roughness: 0.97 }),
  bronze: new THREE.MeshStandardMaterial({ color: '#a48a5e', metalness: 0.85, roughness: 0.35 }),
};
const colors = new Map<string, THREE.MeshStandardMaterial>();
export function solid(color: string, roughness = 0.65, metalness = 0) {
  const key = `${color}|${roughness}|${metalness}`;
  if (!colors.has(key)) colors.set(key, new THREE.MeshStandardMaterial({ color, roughness, metalness }));
  return colors.get(key)!;
}
/** Meter-scaled UVs prevent the stretching that makes large buildings look like toy blocks. */
export function boxMesh(parent: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const p = geo.attributes.position,
    n = geo.attributes.normal,
    uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(n.getY(i)) > 0.5) uv.setXY(i, (p.getX(i) + x) / 3, (p.getZ(i) + z) / 3);
    else if (Math.abs(n.getX(i)) > 0.5) uv.setXY(i, (p.getZ(i) + z) / 3, (p.getY(i) + y) / 3);
    else uv.setXY(i, (p.getX(i) + x) / 3, (p.getY(i) + y) / 3);
  }
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}
