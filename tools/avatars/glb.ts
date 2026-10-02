// A small glTF 2.0 binary reader/writer for the avatar build: just enough for skinned meshes, materials with
// external WebP images and keyframe animations. Output is deterministic for the same input.

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const FLOAT = 5126, UNSIGNED_BYTE = 5121, UNSIGNED_SHORT = 5123, UNSIGNED_INT = 5125, SHORT = 5122, BYTE = 5120;
const SIZE: Record<number, number> = { [FLOAT]: 4, [UNSIGNED_BYTE]: 1, [UNSIGNED_SHORT]: 2, [UNSIGNED_INT]: 4, [SHORT]: 2, [BYTE]: 1 };
const COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const ARRAY = { [FLOAT]: Float32Array, [UNSIGNED_BYTE]: Uint8Array, [UNSIGNED_SHORT]: Uint16Array, [UNSIGNED_INT]: Uint32Array, [SHORT]: Int16Array, [BYTE]: Int8Array } as const;
type Typed = Float32Array | Uint8Array | Uint16Array | Uint32Array | Int16Array | Int8Array;

export function readGlb(bytes: Uint8Array): { json: Json; bin: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const binStart = 20 + jsonLength;
  const bin = binStart < bytes.byteLength ? bytes.subarray(binStart + 8, binStart + 8 + view.getUint32(binStart, true)) : new Uint8Array();
  return { json, bin };
}

/** An accessor's elements as a float array (normalized integers are dequantized), honouring byteStride. */
export function readAccessor(json: Json, bin: Uint8Array, index: number): { data: Float32Array; itemSize: number; count: number } {
  const a = json.accessors[index], bv = json.bufferViews[a.bufferView];
  const itemSize = COUNT[a.type], size = SIZE[a.componentType], stride = bv.byteStride ?? itemSize * size;
  const view = new DataView(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0));
  const out = new Float32Array(a.count * itemSize);
  const scale = !a.normalized ? 1 : a.componentType === BYTE ? 1 / 127 : a.componentType === SHORT ? 1 / 32767 : a.componentType === UNSIGNED_BYTE ? 1 / 255 : a.componentType === UNSIGNED_SHORT ? 1 / 65535 : 1;
  for (let i = 0; i < a.count; i++)
    for (let c = 0; c < itemSize; c++) {
      const o = i * stride + c * size;
      let v: number;
      switch (a.componentType) {
        case FLOAT: v = view.getFloat32(o, true); break;
        case UNSIGNED_BYTE: v = view.getUint8(o); break;
        case BYTE: v = view.getInt8(o); break;
        case UNSIGNED_SHORT: v = view.getUint16(o, true); break;
        case SHORT: v = view.getInt16(o, true); break;
        default: v = view.getUint32(o, true);
      }
      out[i * itemSize + c] = a.normalized ? Math.max(-1, v * scale) : v;
    }
  return { data: out, itemSize, count: a.count };
}

export class GlbWriter {
  readonly json: Json = { asset: { version: '2.0', generator: 'agent-empire tools/avatars/build-avatars.ts' }, buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [] };
  private chunks: Uint8Array[] = [];
  private length = 0;

  private push(bytes: Uint8Array): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) { this.chunks.push(new Uint8Array(pad)); this.length += pad; }
    const offset = this.length;
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    return offset;
  }

  bufferView(data: Typed, target?: number, byteStride?: number): number {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const view: Json = { buffer: 0, byteOffset: this.push(bytes.slice()), byteLength: bytes.byteLength };
    if (target) view.target = target;
    if (byteStride) view.byteStride = byteStride;
    return this.json.bufferViews.push(view) - 1;
  }

  /** Adds an accessor; POSITION-like data gets min/max when `bounds` is set (required for positions and anim inputs). */
  accessor(data: Typed, type: keyof typeof COUNT, opts: { normalized?: boolean; bounds?: boolean; target?: number } = {}): number {
    const componentType = data instanceof Float32Array ? FLOAT : data instanceof Uint8Array ? UNSIGNED_BYTE : data instanceof Uint16Array ? UNSIGNED_SHORT : data instanceof Uint32Array ? UNSIGNED_INT : data instanceof Int16Array ? SHORT : BYTE;
    const n = COUNT[type], count = data.length / n;
    // Vertex attributes of 1- and 2-byte components must start and stride on 4-byte boundaries.
    const a: Json = { bufferView: this.bufferView(data, opts.target), componentType, count, type };
    if (opts.normalized) a.normalized = true;
    if (opts.bounds) {
      const min = new Array(n).fill(Infinity), max = new Array(n).fill(-Infinity);
      for (let i = 0; i < count; i++) for (let c = 0; c < n; c++) { const v = data[i * n + c]; if (v < min[c]) min[c] = v; if (v > max[c]) max[c] = v; }
      a.min = min.map((v) => Math.fround(v));
      a.max = max.map((v) => Math.fround(v));
    }
    return this.json.accessors.push(a) - 1;
  }

  add(key: string, item: Json): number {
    (this.json[key] ??= []).push(item);
    return this.json[key].length - 1;
  }

  toGlb(): Buffer {
    this.json.buffers[0].byteLength = this.length;
    if (!this.length) { delete this.json.buffers; }
    const enc = new TextEncoder().encode(JSON.stringify(this.json));
    const jsonPad = (4 - (enc.length % 4)) % 4, binPad = (4 - (this.length % 4)) % 4;
    const jsonChunk = Buffer.concat([Buffer.from(enc), Buffer.alloc(jsonPad, 0x20)]);
    const binChunk = Buffer.concat([...this.chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), Buffer.alloc(binPad)]);
    const total = 12 + 8 + jsonChunk.length + (this.length ? 8 + binChunk.length : 0);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(total, 8);
    const jh = Buffer.alloc(8);
    jh.writeUInt32LE(jsonChunk.length, 0);
    jh.writeUInt32LE(0x4e4f534a, 4);
    const parts = [header, jh, jsonChunk];
    if (this.length) {
      const bh = Buffer.alloc(8);
      bh.writeUInt32LE(binChunk.length, 0);
      bh.writeUInt32LE(0x004e4942, 4);
      parts.push(bh, binChunk);
    }
    return Buffer.concat(parts);
  }
}
