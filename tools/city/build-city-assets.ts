/**
 * FREE-09 (CITY-05/07): builds the district and vehicle kits from official Kenney CC0 archives.
 *   npx tsx tools/city/build-city-assets.ts
 * Zips are downloaded once into the git-ignored .cache/kenney/, verified against tools/city/sources.json (SHA-256)
 * and extracted with `unzip`. Only the models listed per kit are written, one GLB per kit:
 *   - node hierarchy and transforms preserved, one root node per model (named after it);
 *   - tangents dropped (no normal maps), normals int8 and UVs uint16 (KHR_mesh_quantization), positions float;
 *   - images stripped: the palette ships as external WebP, 512² for desktop and 256² for phones / Save-Data
 *     (`cwebp`, lossless; the client picks the size like the avatar pipeline).
 * src/client/public/models/city/manifest.json records every shipped file with its SHA-256, kit, licence and source,
 * plus each model's bounds (used for collision footprints without loading the GLB).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { GlbWriter, readAccessor, readGlb } from '../avatars/glb.ts';
import { checkZipListing } from './zip-guard.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const CACHE = join(ROOT, '.cache', 'kenney');
const OUT = join(ROOT, 'src/client/public/models/city');
const sources = JSON.parse(readFileSync(join(import.meta.dirname, 'sources.json'), 'utf8'));
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function fetchKit(id: string, kit: Json): Promise<string> {
  // The extraction folder is tied to the archive hash, so a stale folder can never be rebuilt under a new hash.
  const zip = join(CACHE, `${id}.zip`), dir = join(CACHE, `${id}-${kit.sha256.slice(0, 16)}`);
  if (!existsSync(zip)) {
    mkdirSync(CACHE, { recursive: true });
    const res = await fetch(kit.zip);
    if (!res.ok) throw new Error(`${kit.zip}: HTTP ${res.status}`);
    writeFileSync(zip, new Uint8Array(await res.arrayBuffer()));
  }
  const got = sha256(readFileSync(zip));
  if (got !== kit.sha256) throw new Error(`${id}: zip SHA-256 ${got} does not match sources.json ${kit.sha256}`);
  if (!existsSync(dir)) {
    checkZipListing(execFileSync('zipinfo', [zip], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    execFileSync('unzip', ['-q', '-o', zip, '-d', dir]);
  }
  const licence = readFileSync(join(dir, 'License.txt'), 'utf8');
  if (!/Creative Commons Zero, CC0/.test(licence)) throw new Error(`${id}: License.txt is not CC0`);
  return join(dir, 'Models', 'GLB format');
}

function buildKit(id: string, kit: Json, glbDir: string) {
  const w = new GlbWriter();
  w.json.asset.generator = 'agent-empire tools/city/build-city-assets.ts';
  w.json.extensionsUsed = ['KHR_mesh_quantization'];
  w.json.extensionsRequired = ['KHR_mesh_quantization'];
  const materialIndex = new Map<string, number>();
  const material = (name: string) => {
    if (!materialIndex.has(name))
      materialIndex.set(name, w.add('materials', { name, doubleSided: true, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: name.endsWith('specular') ? 0.35 : 0.85 }, extras: { palette: id } }));
    return materialIndex.get(name)!;
  };
  const roots: number[] = [];
  const bounds: Record<string, { min: number[]; max: number[] }> = {};
  for (const model of kit.models as string[]) {
    const { json, bin } = readGlb(new Uint8Array(readFileSync(join(glbDir, `${model}.glb`))));
    const meshMap = new Map<number, number>();
    const box = new THREE.Box3();
    const copyMesh = (m: number) => {
      if (meshMap.has(m)) return meshMap.get(m)!;
      const primitives = json.meshes[m].primitives.map((p: Json) => {
        const pos = readAccessor(json, bin, p.attributes.POSITION).data;
        const nrm = readAccessor(json, bin, p.attributes.NORMAL).data;
        const uv = readAccessor(json, bin, p.attributes.TEXCOORD_0).data;
        const n8 = new Int8Array(nrm.length / 3 * 4);
        for (let i = 0; i < nrm.length / 3; i++) for (let c = 0; c < 3; c++) n8[i * 4 + c] = Math.round(Math.max(-1, Math.min(1, nrm[i * 3 + c])) * 127);
        const uv16 = new Uint16Array(uv.length);
        for (let i = 0; i < uv.length; i++) uv16[i] = Math.round(Math.max(0, Math.min(1, uv[i])) * 65535);
        const idx = readAccessor(json, bin, p.indices).data;
        const indices = pos.length / 3 > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx);
        // Int8 normals are padded to 4 bytes per vertex (vertex attributes must be 4-byte aligned).
        const normal = w.accessor(n8, 'VEC4', { normalized: true, target: 34962 });
        Object.assign(w.json.accessors[normal], { type: 'VEC3' });
        w.json.bufferViews[w.json.accessors[normal].bufferView].byteStride = 4;
        return {
          attributes: {
            POSITION: w.accessor(Float32Array.from(pos), 'VEC3', { bounds: true, target: 34962 }),
            NORMAL: normal,
            TEXCOORD_0: w.accessor(uv16, 'VEC2', { normalized: true, target: 34962 }),
          },
          indices: w.accessor(indices, 'SCALAR', { target: 34963 }),
          material: material(json.materials[p.material].name),
        };
      });
      const out = w.add('meshes', { name: json.meshes[m].name, primitives });
      meshMap.set(m, out);
      return out;
    };
    const copyNode = (n: number, parent: THREE.Matrix4): number => {
      const src = json.nodes[n];
      const local = new THREE.Matrix4().compose(
        new THREE.Vector3(...(src.translation ?? [0, 0, 0])),
        new THREE.Quaternion(...(src.rotation ?? [0, 0, 0, 1])),
        new THREE.Vector3(...(src.scale ?? [1, 1, 1])),
      );
      const world = parent.clone().multiply(local);
      const node: Json = { name: src.name };
      for (const k of ['translation', 'rotation', 'scale']) if (src[k]) node[k] = src[k];
      if (src.mesh !== undefined) {
        node.mesh = copyMesh(src.mesh);
        for (const p of json.meshes[src.mesh].primitives) {
          const a = json.accessors[p.attributes.POSITION];
          box.union(new THREE.Box3(new THREE.Vector3(...a.min), new THREE.Vector3(...a.max)).applyMatrix4(world));
        }
      }
      const index = w.add('nodes', node);
      if (src.children) w.json.nodes[index].children = src.children.map((c: number) => copyNode(c, world));
      return index;
    };
    const scene = json.scenes[json.scene ?? 0];
    const children = scene.nodes.map((n: number) => copyNode(n, new THREE.Matrix4()));
    roots.push(w.add('nodes', { name: model, children }));
    const r = (v: number) => Math.round(v * 1000) / 1000;
    bounds[model] = { min: box.min.toArray().map(r), max: box.max.toArray().map(r) };
  }
  w.json.scenes = [{ name: `kenney-${id}`, nodes: roots }];
  w.json.scene = 0;
  return { glb: w.toGlb(), bounds };
}

const manifest: Json = { generatedBy: 'tools/city/build-city-assets.ts', licence: sources.licence, licenceUrl: sources.licenceUrl, kits: {}, files: {} };
mkdirSync(OUT, { recursive: true });
for (const [id, kit] of Object.entries<Json>(sources.kits)) {
  const glbDir = await fetchKit(id, kit);
  const { glb, bounds } = buildKit(id, kit, glbDir);
  const record = (file: string, bytes: Uint8Array) => {
    manifest.files[file] = { kit: id, bytes: bytes.byteLength, sha256: sha256(bytes), licence: sources.licence, source: kit.page };
  };
  writeFileSync(join(OUT, `${id}.glb`), glb);
  record(`${id}.glb`, glb);
  for (const [suffix, size] of [['', 512], ['-phone', 256]] as const) {
    const file = `${id}${suffix}.webp`;
    execFileSync('cwebp', ['-quiet', '-lossless', '-exact', '-resize', String(size), String(size), join(glbDir, 'Textures', 'colormap.png'), '-o', join(OUT, file)]);
    record(file, readFileSync(join(OUT, file)));
  }
  manifest.kits[id] = { pack: kit.pack, author: kit.author, page: kit.page, zip: kit.zip, zipSha256: kit.sha256, models: bounds };
  console.log(`${id}: ${(glb.byteLength / 1024).toFixed(0)} KiB, ${kit.models.length} models`);
}
const licenceText = `# Kenney assets (CC0 1.0)\n\nThe files in this folder are built from Kenney (www.kenney.nl) packs released under Creative Commons Zero (CC0 1.0), ${sources.licenceUrl}.\nAttribution is not required; it is given gladly. Packs, archive checksums and the models used are listed in manifest.json and THIRD_PARTY_NOTICES.md.\n`;
writeFileSync(join(OUT, 'LICENSE-Kenney.md'), licenceText);
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
