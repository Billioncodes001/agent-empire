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


test('review 6: the asset tool refuses symlinks, escaping paths and oversized archives before extracting', async () => {
  const { checkZipListing } = await import('../tools/city/zip-guard');
  const head = 'Archive:  x.zip\nZip file size: 10 bytes, number of entries: 2\n';
  const ok = `${head}-rw-a--     2.3 ntf      703 tx defN 26-Oct-10 11:35 License.txt\ndrwx---     2.3 ntf        0 bx stor 26-Oct-10 11:35 Models/\n2 files, 703 bytes uncompressed\n`;
  assert.deepEqual(checkZipListing(ok), { entries: 2, bytes: 703 });
  assert.throws(() => checkZipListing(`${head}lrwxrwxrwx  3.0 unx       11 bx stor 26-Oct-10 11:35 Models/link\n`), /symlink/);
  assert.throws(() => checkZipListing(`${head}-rw-r--r--  3.0 unx       11 tx defN 26-Oct-10 11:35 ../evil.txt\n`), /escapes/);
  assert.throws(() => checkZipListing(`${head}-rw-r--r--  3.0 unx  9999999 tx defN 26-Oct-10 11:35 big.bin\n`, 1000), /beyond/);
  // Re-review 3: an entry line the parser cannot read must not be skipped silently.
  assert.throws(() => checkZipListing(`${head}-rw-a--     2.3 ntf      703 tx defN 26-Oct-10 11:35 License.txt\n?? unparseable entry ??\n`), /declares 2 entries but 1/);
  assert.throws(() => checkZipListing('-rw-a--     2.3 ntf      703 tx defN 26-Oct-10 11:35 License.txt\n'), /no entry count/);
});

test('CITY-06/08: every drivable model is a pinned Car Kit model, and the helicopter ships no downloaded files', async () => {
  const { VEHICLE_MODELS } = await import('../src/shared/city');
  for (const m of VEHICLE_MODELS) assert.ok(manifest.kits.vehicles.models[m.asset], `${m.asset} is not in the pinned Car Kit build`);
  const shipped = readdirSync(dir);
  assert.ok(!shipped.some((f) => /heli/i.test(f)), 'no helicopter asset file');
  assert.ok(!sources.kits.helicopter, 'no helicopter source in the pinned pipeline');
  assert.match(notices, /The pinned packs contain no helicopter, so the helicopter, the helipad and the garage staircase are original procedural geometry/);
});
