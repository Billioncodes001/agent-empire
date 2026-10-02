// Deterministic ZIP archives without external tools: the same files always give the same bytes (sorted entries,
// fixed 1980-01-01 timestamps, fixed permissions, deflate level 9 or stored when that is smaller). Used for the game
// bundle and the Windows desktop zip. readZip() checks every CRC, for verification and tests.
//
//   node tools/release/zip.mjs <dir> <out.zip> [--prefix <folder name inside the zip>]
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const DOS_TIME = 0;
const UTF8_FLAG = 0x0800;

/** Regular files under `dir` as sorted forward-slash paths; hidden files and folders are skipped. */
export function listFiles(dir) {
  const out = [];
  const walk = rel => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
      else if (entry.isSymbolicLink()) throw new Error(`Refusing to archive a symbolic link: ${child}`);
    }
  };
  walk('');
  return out.sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
}

/**
 * Builds a ZIP from [{ name, data, executable? }]. Entries are sorted by name; names must be relative,
 * forward-slash paths without `..`.
 */
export function createZip(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  if (sorted.length > 0xffff) throw new Error('Too many files for a non-ZIP64 archive');
  const locals = [];
  const centrals = [];
  let offset = 0;
  const seen = new Set();
  for (const { name, data, executable } of sorted) {
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..' || part === '' || part === '.'))
      throw new Error(`Unsafe archive path: ${name}`);
    if (seen.has(name)) throw new Error(`Duplicate archive path: ${name}`);
    seen.add(name);
    const raw = Buffer.from(data);
    const deflated = deflateRawSync(raw, { level: 9 });
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const crc = crc32(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    if (offset > 0xffffffff || raw.length > 0xffffffff) throw new Error('Archive too large for non-ZIP64');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8); central.writeUInt16LE(stored ? 0 : 8, 10); central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(((executable ? 0o100755 : 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

/** Zips every non-hidden file under `dir`, optionally inside a top-level folder `prefix`. */
export function zipDirectory(dir, { prefix = '' } = {}) {
  return createZip(listFiles(dir).map(rel => {
    const full = path.join(dir, rel);
    return { name: prefix ? `${prefix}/${rel}` : rel, data: readFileSync(full), executable: (statSync(full).mode & 0o111) !== 0 };
  }));
}

/** Reads a ZIP written by createZip (or any non-ZIP64 store/deflate archive), checking each CRC. */
export function readZip(buffer) {
  const buf = Buffer.from(buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(dataStart, dataStart + size);
    const data = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body) : null;
    if (!data) throw new Error(`Unsupported compression method ${method} for ${name}`);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    if (!name.endsWith('/')) files.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--prefix');
  const prefix = i >= 0 ? args[i + 1] : '';
  const [dir, out] = args.filter((_, j) => i < 0 || (j !== i && j !== i + 1));
  if (!dir || !out) { console.error('usage: zip.mjs <dir> <out.zip> [--prefix <folder>]'); process.exit(2); }
  const zip = zipDirectory(dir, { prefix });
  writeFileSync(out, zip);
  console.log(`${out}: ${readZip(zip).size} files, ${zip.length} bytes`);
}
