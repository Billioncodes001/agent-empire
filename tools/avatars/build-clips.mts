/**
 * CHAR-02: builds the extra animation clips (jump phases, driving seat) from free CC0 animation libraries.
 *   npx tsx tools/avatars/build-clips.mts            build src/client/public/models/avatars/clips-extra-{male,female}.glb
 *   npx tsx tools/avatars/build-clips.mts --inspect  print the source clips' pelvis and foot heights (to pick windows)
 * Archives are downloaded once into the git-ignored .cache/quaternius/, verified against tools/avatars/sources.json
 * (SHA-256), listed with zip-guard before extraction, and their License.txt must state CC0. Clips are retargeted in
 * node onto the shipped Rocketbox clip rigs (tools/avatars/retarget.ts): no Blender, no Mixamo, nothing paid.
 * src/client/public/models/avatars/clips-extra.json records every shipped file with its SHA-256, licence and source.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { checkZipListing } from '../city/zip-guard.ts';
import { parseGlb, retarget, writeClipGlb, type ClipSpec } from './retarget.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const CACHE = join(ROOT, '.cache', 'quaternius');
const OUT = join(ROOT, 'src/client/public/models/avatars');
const sources = JSON.parse(readFileSync(join(import.meta.dirname, 'sources.json'), 'utf8'));
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function fetchPack(id: string, pack: Json): Promise<string> {
  // The extraction folder is tied to the archive hash, so a stale folder can never be reused under a new hash.
  const zip = join(CACHE, `${id}.zip`), dir = join(CACHE, `${id}-${pack.sha256.slice(0, 16)}`);
  if (!existsSync(zip)) {
    mkdirSync(CACHE, { recursive: true });
    const res = await fetch(pack.zip);
    if (!res.ok) throw new Error(`${pack.zip}: HTTP ${res.status}`);
    writeFileSync(zip, new Uint8Array(await res.arrayBuffer()));
  }
  const got = sha256(readFileSync(zip));
  if (got !== pack.sha256) throw new Error(`${id}: zip SHA-256 ${got} does not match sources.json ${pack.sha256}`);
  if (!existsSync(dir)) {
    checkZipListing(execFileSync('zipinfo', [zip], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    execFileSync('unzip', ['-q', '-o', zip, '-d', dir]);
  }
  const licence = readFileSync(join(dir, pack.licenceFile), 'utf8');
  if (!/CC0 1\.0 Universal/.test(licence)) throw new Error(`${id}: ${pack.licenceFile} is not CC0`);
  return dir;
}

async function inspect(id: string, pack: Json, dir: string) {
  const gltf = await parseGlb(new Uint8Array(readFileSync(join(dir, pack.glb))));
  const scene = gltf.scene, mixer = new THREE.AnimationMixer(scene), v = new THREE.Vector3();
  const y = (n: string) => scene.getObjectByName(n)!.getWorldPosition(v).y;
  const sample = (clip: THREE.AnimationClip, t: number) => { mixer.stopAllAction(); mixer.clipAction(clip).reset().play(); mixer.setTime(t); scene.updateMatrixWorld(true); };
  sample(gltf.animations.find((a) => a.name === pack.idle)!, 0);
  const hip0 = y('DEF-hips');
  for (const spec of pack.clips as ClipSpec[]) {
    const clip = gltf.animations.find((a) => a.name === spec.from)!;
    console.log(`${id} ${spec.from} ${clip.duration.toFixed(2)} s (pelvis Δ, left foot, right foot in cm)`);
    for (let t = 0; t <= clip.duration + 1e-6; t += 1 / 15) {
      sample(clip, t);
      const zz = (n: string) => scene.getObjectByName(n)!.getWorldPosition(v); console.log(`  ${t.toFixed(2)} z ${(zz('DEF-footL').z*100).toFixed(1)} ${(zz('DEF-footR').z*100).toFixed(1)} hipz ${(zz('DEF-hips').z*100).toFixed(1)} ${((y('DEF-hips') - hip0) * 100).toFixed(1).padStart(6)} ${(y('DEF-footL') * 100).toFixed(1).padStart(6)} ${(y('DEF-footR') * 100).toFixed(1).padStart(6)}`);
    }
  }
}

const manifest: Json = { generatedBy: 'tools/avatars/build-clips.mts', licence: sources.licence, licenceUrl: sources.licenceUrl, packs: {}, files: {} };
for (const [id, pack] of Object.entries<Json>(sources.packs)) {
  const dir = await fetchPack(id, pack);
  if (process.argv.includes('--inspect')) { await inspect(id, pack, dir); continue; }
  const source = await parseGlb(new Uint8Array(readFileSync(join(dir, pack.glb))));
  for (const body of ['male', 'female'] as const) {
    const rigBytes = new Uint8Array(readFileSync(join(OUT, `clips-${body}.glb`)));
    const clips = retarget(source, pack.idle, await parseGlb(rigBytes), 'idle_neutral_01', pack.clips);
    const glb = writeClipGlb(rigBytes, clips, { source: `${pack.pack} by ${pack.author}`, licence: sources.licence, clips: pack.clips.map((c: ClipSpec) => c.name) });
    const file = `clips-extra-${body}.glb`;
    writeFileSync(join(OUT, file), glb);
    manifest.files[file] = { pack: id, bytes: glb.byteLength, sha256: sha256(glb), licence: sources.licence, source: pack.page, clips: Object.fromEntries((pack.clips as ClipSpec[]).map((c) => [c.name, c.from])) };
    console.log(`${file}: ${(glb.byteLength / 1024).toFixed(1)} KiB, ${clips.length} clips`);
  }
  manifest.packs[id] = { pack: pack.pack, author: pack.author, page: pack.page, authorPage: pack.authorPage, zip: pack.zip, zipSha256: pack.sha256 };
}
if (!process.argv.includes('--inspect')) writeFileSync(join(OUT, 'clips-extra.json'), `${JSON.stringify(manifest, null, 2)}\n`);
