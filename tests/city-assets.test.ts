import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readGlb } from '../tools/avatars/glb';

const dir = resolve(import.meta.dirname, '../src/client/public/models/city');
const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'));
const sources = JSON.parse(readFileSync(resolve(import.meta.dirname, '../tools/city/sources.json'), 'utf8'));
const notices = readFileSync(resolve(import.meta.dirname, '../THIRD_PARTY_NOTICES.md'), 'utf8');

test('every shipped city asset file is listed with a CC0 licence, an official Kenney source and a matching checksum', () => {
  const shipped = readdirSync(dir).filter((f) => !['manifest.json', 'LICENSE-Kenney.md'].includes(f));
  assert.ok(shipped.length >= 12);
  for (const file of shipped) {
    const entry = manifest.files[file];
    assert.ok(entry, `${file} is missing from manifest.json`);
    assert.equal(entry.licence, 'CC0-1.0', file);
    assert.match(entry.source, /^https:\/\/kenney\.nl\/assets\//, file);
    assert.equal(createHash('sha256').update(readFileSync(resolve(dir, file))).digest('hex'), entry.sha256, `${file} checksum`);
  }
  assert.deepEqual(Object.keys(manifest.files).sort(), shipped.sort(), 'manifest lists no file that is not shipped');
});

test('each kit records its pack, archive URL and checksum in sources.json and THIRD_PARTY_NOTICES.md', () => {
  for (const [id, kit] of Object.entries<{ pack: string; zip: string; sha256: string; page: string; models: string[] }>(sources.kits)) {
    assert.match(kit.zip, /^https:\/\/kenney\.nl\/media\/pages\/assets\//, id);
    assert.match(kit.sha256, /^[0-9a-f]{64}$/, id);
    assert.equal(manifest.kits[id].zipSha256, kit.sha256, id);
    for (const needle of [kit.pack, kit.page, kit.sha256]) assert.ok(notices.includes(needle), `THIRD_PARTY_NOTICES.md lacks ${needle}`);
  }
});

test('kit GLBs contain exactly the listed models, quantized and without embedded images', () => {
  for (const [id, kit] of Object.entries<{ models: string[] }>(sources.kits)) {
    const { json } = readGlb(new Uint8Array(readFileSync(resolve(dir, `${id}.glb`))));
    const roots = json.scenes[0].nodes.map((n: number) => json.nodes[n].name);
    assert.deepEqual(roots, kit.models, id);
    assert.equal(json.images, undefined, `${id} embeds no images`);
    assert.ok(json.extensionsUsed.includes('KHR_mesh_quantization'), id);
    assert.deepEqual(Object.keys(manifest.kits[id].models), kit.models, `${id} bounds`);
  }
});
