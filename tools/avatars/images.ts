// Image steps of the avatar build without new npm dependencies: three's TGALoader decodes the Rocketbox TGAs,
// resizing and masks run on plain RGBA arrays, PNG is written with node:zlib, and `cwebp` (libwebp's CLI, a
// system tool) encodes the shipped WebP files.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';

/** Top-down RGBA8 pixels. */
export interface Rgba { width: number; height: number; data: Uint8Array }

export function decodeTga(file: string): Rgba {
  const bytes = readFileSync(file);
  const parsed = new TGALoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as unknown as Rgba;
  return { width: parsed.width, height: parsed.height, data: parsed.data };
}

/**
 * Box-filter downscale by an integer factor so the width is at most `size` (sources are 2048² or 1024², a few small
 * ones like glasses are 512×256; nothing is upscaled).
 */
export function downscale(src: Rgba, size: number): Rgba {
  const f = Math.max(1, Math.round(src.width / size));
  if (src.width % f || src.height % f) throw new Error(`cannot scale ${src.width}x${src.height} to ${size}`);
  if (f === 1) return src;
  const w = src.width / f, h = src.height / f;
  const out = new Uint8Array(w * h * 4), n = f * f;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) sum += src.data[((y * f + dy) * src.width + x * f + dx) * 4 + c];
        out[(y * w + x) * 4 + c] = Math.round(sum / n);
      }
  return { width: w, height: h, data: out };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array) {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Uint8Array) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(body).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}
/** Lossless RGBA (or RGB when `alpha` is false) PNG. */
export function encodePng(img: Rgba, alpha = true): Buffer {
  const ch = alpha ? 4 : 3, stride = img.width * ch + 1;
  const raw = Buffer.alloc(stride * img.height);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      for (let c = 0; c < ch; c++) raw[y * stride + 1 + x * ch + c] = img.data[(y * img.width + x) * 4 + c];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array())]);
}

/** WebP via cwebp. `quality` 0–100 (lossy); `lossless` for masks. Deterministic for the same input and cwebp version. */
export function encodeWebp(img: Rgba, opts: { quality?: number; alpha?: boolean; lossless?: boolean } = {}): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-webp-'));
  try {
    const png = join(dir, 'in.png'), out = join(dir, 'out.webp');
    writeFileSync(png, encodePng(img, opts.alpha ?? false));
    const args = opts.lossless ? ['-lossless', '-z', '9', '-exact'] : ['-q', String(opts.quality ?? 82), '-m', '6', '-sharp_yuv', '-alpha_q', '100'];
    execFileSync('cwebp', [...args, '-metadata', 'none', '-quiet', png, '-o', out]);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function cwebpVersion(): string {
  try {
    return execFileSync('cwebp', ['-version']).toString().trim();
  } catch {
    throw new Error('`cwebp` (libwebp) is required on PATH to encode avatar textures (macOS: brew install webp; Debian/Ubuntu: apt install webp).');
  }
}
