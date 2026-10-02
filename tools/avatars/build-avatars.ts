/**
 * `npm run build:avatars` — builds the corporate avatars from pinned Microsoft Rocketbox sources (MIT).
 *
 *   1. Downloads each avatar's FBX and texture TGAs at ROCKETBOX_COMMIT into .cache/rocketbox/ and verifies them
 *      against tools/avatars/sources.lock.json (`--relock` records new checksums when deliberately moving the pin).
 *   2. Parses the FBX with three's FBXLoader and writes a mesh-only GLB per avatar: the skinned mesh welded and
 *      split per material, the Bip01 skeleton laid out exactly like the clip rigs (same node names, same pelvis
 *      frame), external WebP textures (EXT_texture_webp) at 1024² and 512².
 *   3. Writes one recolour mask per avatar (suit / shirt / tie) and its region statistics.
 *   4. Builds the shared clip files from the licensed founder (male) and chief-of-staff (female) rigs: rotations
 *      for every bone, translation for the pelvis only, no scale tracks, so a clip never imposes the source body's
 *      bone lengths on another avatar.
 *
 * Needs `cwebp` on PATH. Outputs go to src/client/public/models/avatars/ and are committed; downloaded inputs are not.
 * Flags: --only=<id,…> builds a subset (clips are always rebuilt), --debug writes mask previews and island tables to
 * .cache/avatar-debug/, --relock records checksums after a deliberate change of ROCKETBOX_COMMIT.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { avatarDef, type AvatarId } from '../../src/shared/outfit';
import { SOURCES, sourcePaths, type AvatarSource } from './catalog';
import { GlbWriter, readAccessor, readGlb } from './glb';
import { cwebpVersion, decodeTga, downscale, encodePng, encodeWebp, type Rgba } from './images';
import { buildMask } from './masks';
import { ROCKETBOX_COMMIT, fetchSource } from './sources';

const ROOT = process.cwd();
const OUT = join(ROOT, 'src/client/public/models/avatars');
/** Clip sources: the licensed Rocketbox rigs with retargeted clips (Tidewater's joe/marta, see THIRD_PARTY_NOTICES.md). */
const RIGS = join(ROOT, 'tools/avatars/rigs');
/** Shipped texture sizes: desktop, and phones / Save-Data (selected at load time, see src/client/world/avatars.ts). */
export const TEXTURE_SIZES = [1024, 512] as const;
const relock = process.argv.includes('--relock');
const debug = process.argv.includes('--debug');
const DEBUG = join(ROOT, '.cache', 'avatar-debug');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');

// FBXLoader asks for images; the build reads the TGAs itself.
(THREE.ImageLoader.prototype as unknown as { load: () => object }).load = () => ({});
(THREE.TextureLoader.prototype as unknown as { load: () => THREE.Texture }).load = () => new THREE.Texture();

const sanitize = (name: string) => name.replace(/\s+/g, '_');
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

// ---- Clip source rigs --------------------------------------------------------------------------------------
interface ClipRig { file: string; json: ReturnType<typeof readGlb>['json']; bin: Uint8Array; pelvisLocal: THREE.Quaternion; pelvisParent: THREE.Matrix4; pelvisHeight: number }
async function clipRig(file: string): Promise<ClipRig> {
  const { json, bin } = readGlb(await readFile(join(RIGS, file)));
  const parentOf = new Map<number, number>();
  json.nodes.forEach((n: { children?: number[] }, i: number) => n.children?.forEach((c) => parentOf.set(c, i)));
  const local = (i: number) => {
    const n = json.nodes[i];
    return new THREE.Matrix4().compose(new THREE.Vector3(...(n.translation ?? [0, 0, 0])), new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(n.scale ?? [1, 1, 1])));
  };
  const world = (i: number): THREE.Matrix4 => (parentOf.has(i) ? world(parentOf.get(i)!).multiply(local(i)) : local(i));
  const pelvis = json.nodes.findIndex((n: { name: string }) => sanitize(n.name) === 'Bip01_Pelvis');
  const p = json.nodes[pelvis];
  const pelvisWorld = new THREE.Vector3().setFromMatrixPosition(world(pelvis));
  return { file, json, bin, pelvisLocal: new THREE.Quaternion(...p.rotation), pelvisParent: world(parentOf.get(pelvis)!), pelvisHeight: pelvisWorld.y };
}

/**
 * Keys a linear (or slerp) interpolation can drop: a key is kept only when interpolating between its kept
 * neighbours would miss any original key by more than `tolerance` (radians for rotations, source units otherwise).
 */
function reduceKeys(times: Float32Array, values: Float32Array, n: number, tolerance: number): number[] {
  const count = times.length;
  if (count <= 2) return [...Array(count).keys()];
  const a = new THREE.Quaternion(), b = new THREE.Quaternion(), c = new THREE.Quaternion();
  const error = (from: number, to: number, k: number) => {
    const t = (times[k] - times[from]) / (times[to] - times[from]);
    if (n === 4) {
      a.fromArray(values, from * 4); b.fromArray(values, to * 4); c.fromArray(values, k * 4);
      return a.slerp(b, t).angleTo(c);
    }
    let e = 0;
    for (let i = 0; i < n; i++) e = Math.max(e, Math.abs(values[from * n + i] + (values[to * n + i] - values[from * n + i]) * t - values[k * n + i]));
    return e;
  };
  const kept = [0];
  let from = 0;
  for (let next = 2; next < count; next++) {
    let ok = true;
    for (let k = from + 1; k < next && ok; k++) if (error(from, next, k) > tolerance) ok = false;
    if (!ok) { from = next - 1; kept.push(from); }
  }
  kept.push(count - 1);
  return kept;
}

/** Shared clips: rotation on every bone, translation on the pelvis only, no scale; constant tracks keep one key. */
function buildClips(rig: ClipRig): Buffer {
  const { json, bin } = rig;
  const w = new GlbWriter();
  const joints = new Set<number>(json.skins[0].joints);
  const keep = (i: number) => joints.has(i) && sanitize(json.nodes[i].name) !== 'neutral_bone';
  // Node layout: the rig's root (pelvis parent) and its joints, without the mesh.
  const parentOf = new Map<number, number>();
  json.nodes.forEach((n: { children?: number[] }, i: number) => n.children?.forEach((c) => parentOf.set(c, i)));
  const pelvis = json.nodes.findIndex((n: { name: string }) => sanitize(n.name) === 'Bip01_Pelvis');
  const rootIndex = parentOf.get(pelvis)!;
  const order: number[] = [];
  const visit = (i: number) => { order.push(i); for (const c of json.nodes[i].children ?? []) if (keep(c)) visit(c); };
  visit(rootIndex);
  const map = new Map(order.map((src, dst) => [src, dst]));
  w.json.nodes = order.map((i) => {
    const n = json.nodes[i];
    const out: Record<string, unknown> = { name: sanitize(n.name) };
    for (const k of ['translation', 'rotation', 'scale'] as const) if (n[k]) out[k] = n[k].map(r6);
    const children = (n.children ?? []).filter((c: number) => map.has(c)).map((c: number) => map.get(c));
    if (children.length) out.children = children;
    return out;
  });
  w.json.scenes = [{ nodes: [0], extras: { pelvisHeight: r6(rig.pelvisHeight), source: rig.file } }];
  w.json.scene = 0;
  w.json.animations = [];
  const inputs = new Map<number, number>();
  for (const anim of json.animations) {
    const channels: unknown[] = [], samplers: unknown[] = [];
    for (const ch of anim.channels) {
      const node = ch.target.node, path = ch.target.path;
      if (!map.has(node) || path === 'scale' || path === 'weights') continue;
      if (path === 'translation' && node !== pelvis) continue;
      const s = anim.samplers[ch.sampler];
      const out = readAccessor(json, bin, s.output), times = readAccessor(json, bin, s.input);
      const n = out.itemSize;
      let constant = true;
      for (let i = 1; i < out.count && constant; i++) for (let c = 0; c < n; c++) if (Math.abs(out.data[i * n + c] - out.data[c]) > (path === 'rotation' ? 2e-5 : 1e-3)) { constant = false; break; }
      let input: number;
      let values: Float32Array;
      if (constant) {
        input = w.accessor(new Float32Array([times.data[0]]), 'SCALAR', { bounds: true });
        values = out.data.slice(0, n);
      } else {
        const keep = reduceKeys(times.data, out.data, n, path === 'rotation' ? 0.0008 : 0.04);
        if (keep.length === out.count) {
          if (!inputs.has(s.input)) inputs.set(s.input, w.accessor(times.data, 'SCALAR', { bounds: true }));
          input = inputs.get(s.input)!;
          values = out.data;
        } else {
          input = w.accessor(new Float32Array(keep.map((k) => times.data[k])), 'SCALAR', { bounds: true });
          values = new Float32Array(keep.flatMap((k) => [...out.data.subarray(k * n, k * n + n)]));
        }
      }
      let output: number;
      if (path === 'rotation') {
        // Normalized int16 quaternions (core glTF): half the bytes, ~3e-5 precision.
        const q = new Int16Array(values.length);
        for (let i = 0; i < values.length; i += 4) {
          let x = values[i], y = values[i + 1], z = values[i + 2], ww = values[i + 3];
          const len = Math.hypot(x, y, z, ww) || 1;
          // Keep neighbouring keys in the same hemisphere so interpolation takes the short way.
          if (i >= 4) { const d = (q[i - 4] * x + q[i - 3] * y + q[i - 2] * z + q[i - 1] * ww); if (d < 0) { x = -x; y = -y; z = -z; ww = -ww; } }
          q[i] = Math.round((x / len) * 32767); q[i + 1] = Math.round((y / len) * 32767); q[i + 2] = Math.round((z / len) * 32767); q[i + 3] = Math.round((ww / len) * 32767);
        }
        output = w.accessor(q, 'VEC4', { normalized: true });
      } else output = w.accessor(values, 'VEC3');
      samplers.push({ input, output, interpolation: s.interpolation ?? 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: map.get(node), path } });
    }
    w.json.animations.push({ name: anim.name, channels, samplers });
  }
  return w.toGlb();
}

// ---- Avatars -----------------------------------------------------------------------------------------------
interface BuiltAvatar { id: AvatarId; bytes: number; textures: Record<number, number>; triangles: number; vertices: number; bones: number; height: number }

function weld(positions: number[], normals: number[], uvs: number[], joints: number[], weights: number[]) {
  const key = new Map<string, number>();
  const P: number[] = [], N: number[] = [], U: number[] = [], J: number[] = [], W: number[] = [];
  const index: number[] = [];
  const q = (v: number, s: number) => Math.round(v * s);
  for (let i = 0; i < positions.length / 3; i++) {
    const k = [q(positions[i * 3], 1e5), q(positions[i * 3 + 1], 1e5), q(positions[i * 3 + 2], 1e5), q(normals[i * 3], 1e3), q(normals[i * 3 + 1], 1e3), q(normals[i * 3 + 2], 1e3), q(uvs[i * 2], 1e5), q(uvs[i * 2 + 1], 1e5), ...joints.slice(i * 4, i * 4 + 4), ...weights.slice(i * 4, i * 4 + 4)].join(',');
    let v = key.get(k);
    if (v === undefined) {
      v = P.length / 3;
      key.set(k, v);
      P.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      N.push(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
      U.push(uvs[i * 2], uvs[i * 2 + 1]);
      J.push(...joints.slice(i * 4, i * 4 + 4));
      W.push(...weights.slice(i * 4, i * 4 + 4));
    }
    index.push(v);
  }
  return { P, N, U, J, W, index };
}

/** Four influences as normalized bytes that sum to exactly 255. */
function quantizeWeights(w: number[]): number[] {
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  const exact = w.map((v) => (v / sum) * 255);
  const out = exact.map(Math.floor);
  let rest = 255 - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (rest <= 0) break; out[i]++; rest--; }
  return out;
}


async function buildAvatar(src: AvatarSource, rigs: Record<'male' | 'female', ClipRig>): Promise<BuiltAvatar> {
  const def = avatarDef(src.id);
  const rig = rigs[def.body];
  const paths = sourcePaths(src);
  const fbxFile = await fetchSource(paths.fbx, relock);
  const buf = await readFile(fbxFile);
  const fbx = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  fbx.updateMatrixWorld(true);
  let mesh!: THREE.SkinnedMesh;
  fbx.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh; });
  const bones = mesh.skeleton.bones;
  const boneIndex = new Map(bones.map((b, i) => [b, i]));
  const pelvis = bones.find((b) => b.name === 'Bip01_Pelvis');
  if (!pelvis) throw new Error(`${src.id}: no Bip01_Pelvis`);

  // FBX centimetres → metres. The avatar root takes the clip rig's pelvis parent frame, so the pelvis has the same
  // local rest rotation as the clip source and its rotation/translation tracks mean the same thing on this body.
  const C = new THREE.Matrix4().makeScale(0.01, 0.01, 0.01);
  const pelvisWorld = C.clone().multiply(pelvis.matrixWorld);
  const pelvisLocal = new THREE.Matrix4().makeRotationFromQuaternion(rig.pelvisLocal);
  const avatarRoot = pelvisWorld.clone().multiply(pelvisLocal.clone().invert());
  const rootT = new THREE.Vector3(), rootQ = new THREE.Quaternion(), rootS = new THREE.Vector3();
  avatarRoot.decompose(rootT, rootQ, rootS);
  const pelvisHeight = new THREE.Vector3().setFromMatrixPosition(pelvisWorld).y;

  const w = new GlbWriter();
  w.json.extensionsUsed = ['EXT_texture_webp'];
  w.json.extensionsRequired = ['EXT_texture_webp'];
  // Nodes: 0 = mesh (scene root, identity), 1 = Avatar root, then the joints in skeleton order.
  const nodes: Record<string, unknown>[] = [{ name: 'AvatarMesh', mesh: 0, skin: 0 }, { name: 'Avatar', translation: rootT.toArray().map(r6), rotation: rootQ.toArray().map(r6), scale: rootS.toArray().map(r6), children: [] as number[] }];
  const jointNode = (i: number) => 2 + i;
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
  bones.forEach((b, i) => {
    // The pelvis always hangs from the avatar root (the clips' frame), even when a source also skins Bip01 above it.
    const parent = b !== pelvis && b.parent && boneIndex.has(b.parent as THREE.Bone) ? (b.parent as THREE.Bone) : null;
    if (parent) { pos.copy(b.position); quat.copy(b.quaternion); scl.copy(b.scale); }
    else {
      // Top joints (the pelvis, and Bip01 where a source skins it): placed in the avatar root's frame.
      avatarRoot.clone().invert().multiply(C.clone().multiply(b.matrixWorld)).decompose(pos, quat, scl);
      (nodes[1].children as number[]).push(jointNode(i));
    }
    const node: Record<string, unknown> = { name: b.name, translation: pos.toArray().map(r6), rotation: quat.toArray().map(r6) };
    if (Math.abs(scl.x - 1) + Math.abs(scl.y - 1) + Math.abs(scl.z - 1) > 1e-4) node.scale = scl.toArray().map(r6);
    const kids = b.children.filter((c) => c !== pelvis && boneIndex.has(c as THREE.Bone)).map((c) => jointNode(boneIndex.get(c as THREE.Bone)!));
    if (kids.length) node.children = kids;
    nodes.push(node);
  });
  w.json.nodes = nodes;
  w.json.scenes = [{ nodes: [0, 1] }];
  w.json.scene = 0;
  // Inverse bind matrices from the rest pose (bind and rest agree to 0.0004 cm on every source).
  const ibm = new Float32Array(bones.length * 16);
  bones.forEach((b, i) => C.clone().multiply(b.matrixWorld).invert().toArray(ibm, i * 16));
  w.json.skins = [{ inverseBindMatrices: w.accessor(ibm, 'MAT4'), joints: bones.map((_, i) => jointNode(i)), skeleton: 1 }];

  // Geometry: FBX triangles grouped by material, transformed to metres in the avatar's world.
  const g = mesh.geometry;
  const toWorld = C.clone().multiply(mesh.matrixWorld);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => m.name.replace(/^.*_/, ''));
  const A = g.attributes;
  const perMaterial = new Map<number, number[]>();
  for (const group of g.groups.length ? g.groups : [{ start: 0, count: A.position.count, materialIndex: 0 }]) {
    const list = perMaterial.get(group.materialIndex ?? 0) ?? [];
    for (let i = group.start; i < group.start + group.count; i++) list.push(g.index ? g.index.getX(i) : i);
    perMaterial.set(group.materialIndex ?? 0, list);
  }
  const v = new THREE.Vector3();
  const primitives: unknown[] = [];
  let triangles = 0, vertices = 0;
  const geometry: Record<string, { P: number[]; U: number[]; J: number[]; W: number[]; index: number[] }> = {};
  for (const [materialIndex, list] of [...perMaterial].sort((a, b) => a[0] - b[0])) {
    const P: number[] = [], N: number[] = [], U: number[] = [], J: number[] = [], W: number[] = [];
    for (const i of list) {
      v.fromBufferAttribute(A.position as THREE.BufferAttribute, i).applyMatrix4(toWorld);
      P.push(v.x, v.y, v.z);
      v.fromBufferAttribute(A.normal as THREE.BufferAttribute, i).applyMatrix3(normalMatrix).normalize();
      N.push(v.x, v.y, v.z);
      U.push(A.uv.getX(i), 1 - A.uv.getY(i));
      const joints = [0, 1, 2, 3].map((c) => A.skinIndex.getComponent(i, c));
      const weights = quantizeWeights([0, 1, 2, 3].map((c) => A.skinWeight.getComponent(i, c)));
      // Zero-weight slots point at joint 0 so no stray index matters.
      J.push(...joints.map((j, c) => (weights[c] ? j : 0)));
      W.push(...weights);
    }
    const welded = weld(P, N, U, J, W);
    const name = materials[materialIndex];
    geometry[name] = welded;
    const count = welded.P.length / 3;
    const attributes = {
      POSITION: w.accessor(new Float32Array(welded.P), 'VEC3', { bounds: true, target: 34962 }),
      NORMAL: w.accessor(new Float32Array(welded.N), 'VEC3', { target: 34962 }),
      TEXCOORD_0: w.accessor(new Float32Array(welded.U), 'VEC2', { target: 34962 }),
      JOINTS_0: w.accessor(new Uint8Array(welded.J), 'VEC4', { target: 34962 }),
      WEIGHTS_0: w.accessor(new Uint8Array(welded.W), 'VEC4', { normalized: true, target: 34962 }),
    };
    const indices = w.accessor(count < 65536 ? new Uint16Array(welded.index) : new Uint32Array(welded.index), 'SCALAR', { target: 34963 });
    primitives.push({ attributes, indices, material: materialIndex });
    triangles += welded.index.length / 3;
    vertices += count;
  }
  w.json.meshes = [{ name: src.id, primitives }];

  // Materials and textures. Images are external so desktop (1024²) and phones (512²) share one GLB.
  await mkdir(join(OUT, src.id), { recursive: true });
  const sizes: Record<number, number> = {};
  let bodyColor: Rgba | undefined;
  const textureFor = async (map: string, opts: { alpha?: boolean; normal?: boolean } = {}) => {
    const source = decodeTga(await fetchSource(paths.textures[map], relock));
    if (map === 'body_color') bodyColor = downscale(source, 512);
    for (const size of TEXTURE_SIZES) {
      const bytes = encodeWebp(downscale(source, size), { quality: opts.normal ? 90 : 84, alpha: opts.alpha });
      await writeFile(join(OUT, src.id, `${map}-${size}.webp`), bytes);
      sizes[size] = (sizes[size] ?? 0) + bytes.length;
    }
    const image = w.add('images', { uri: `${src.id}/${map}-${TEXTURE_SIZES[0]}.webp`, mimeType: 'image/webp', name: map });
    return w.add('textures', { sampler: 0, extensions: { EXT_texture_webp: { source: image } } });
  };
  w.json.samplers = [{ magFilter: 9729, minFilter: 9987 }];
  w.json.materials = [];
  for (const name of materials) {
    if (name === 'body' || name === 'head')
      w.json.materials.push({
        name,
        doubleSided: true,
        normalTexture: { index: await textureFor(`${name}_normal`, { normal: true }) },
        pbrMetallicRoughness: { baseColorTexture: { index: await textureFor(`${name}_color`) }, metallicFactor: 0, roughnessFactor: name === 'body' ? 0.78 : 0.58 },
      });
    else if (name === 'opacity')
      w.json.materials.push({ name, alphaMode: 'BLEND', doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: await textureFor('opacity_color', { alpha: true }) }, metallicFactor: 0, roughnessFactor: 0.6 } });
    else if (name === 'glasses')
      w.json.materials.push({
        name,
        alphaMode: 'BLEND',
        doubleSided: true,
        normalTexture: { index: await textureFor('glasses_normal', { normal: true }) },
        pbrMetallicRoughness: { baseColorTexture: { index: await textureFor('glasses_color', { alpha: true }) }, metallicFactor: 0, roughnessFactor: 0.25 },
      });
    else throw new Error(`${src.id}: unexpected material ${name}`);
  }

  // Recolour mask for the body texture and the mean brightness of each region (see masks.ts).
  const mask = buildMask(src.id, bodyColor!, geometry.body, bones.map((b) => b.name), def.regions);
  await writeFile(join(OUT, src.id, 'mask-512.webp'), encodeWebp(mask.image, { lossless: true }));
  if (debug) {
    await mkdir(DEBUG, { recursive: true });
    await writeFile(join(DEBUG, `${src.id}-mask.png`), encodePng(mask.preview, false));
    await writeFile(join(DEBUG, `${src.id}-islands.json`), JSON.stringify(mask.islands.filter((i) => i.pixels > 20), null, 1));
  }


  for (const region of def.regions) if (!mask.regions[region]) throw new Error(`${src.id}: mask has no ${region} (run with --debug and see .cache/avatar-debug/)`);
  const box = new THREE.Box3();
  for (const p of Object.values(geometry)) for (let i = 0; i < p.P.length; i += 3) box.expandByPoint(v.set(p.P[i], p.P[i + 1], p.P[i + 2]));
  const height = box.max.y - box.min.y;
  w.json.scenes[0].extras = { avatar: src.id, body: def.body, pelvisHeight: r6(pelvisHeight), clipPelvisHeight: r6(rig.pelvisHeight), height: r6(height), regions: mask.regions, source: `${src.name} @ ${ROCKETBOX_COMMIT.slice(0, 12)}` };
  if (Math.abs(pelvisHeight - rig.pelvisHeight) > 0.005) console.warn(`${src.id}: pelvis ${pelvisHeight.toFixed(3)} m vs clip rig ${rig.pelvisHeight.toFixed(3)} m`);
  const glb = w.toGlb();
  await writeFile(join(OUT, `${src.id}.glb`), glb);
  return { id: src.id, bytes: glb.length, textures: sizes, triangles, vertices, bones: bones.length, height };
}

async function main() {
  console.log(`cwebp: ${cwebpVersion()} · Rocketbox @ ${ROCKETBOX_COMMIT}`);
  await mkdir(OUT, { recursive: true });
  const rigs = { male: await clipRig('founder.glb'), female: await clipRig('chief-of-staff.glb') };
  for (const [body, rig] of Object.entries(rigs)) {
    const glb = buildClips(rig);
    await writeFile(join(OUT, `clips-${body}.glb`), glb);
    console.log(`clips-${body}.glb ${(glb.length / 1024).toFixed(0)} KiB from ${rig.file}`);
  }
  const report: BuiltAvatar[] = [];
  for (const src of SOURCES) {
    if (only && !only.includes(src.id)) continue;
    const built = await buildAvatar(src, rigs);
    report.push(built);
    console.log(`${built.id}.glb ${(built.bytes / 1024).toFixed(0)} KiB · ${built.triangles} tris · ${built.vertices} verts · ${built.bones} bones · ${built.height.toFixed(2)} m · textures ${TEXTURE_SIZES.map((s) => `${s}²: ${((built.textures[s] ?? 0) / 1024).toFixed(0)} KiB`).join(', ')}`);
  }
}

await main();
