// Recolour masks for the body texture of each avatar: R = suit (jacket, trousers or skirt), G = shirt or blouse,
// B = tie. They come from the mesh rather than hand painting: body triangles are rasterized into texture space,
// grouped into UV islands, and each island is classified from its skin weights (hands and shoes are never
// recoloured), its place on the body (a tie hangs on the chest centre line) and its colour (shirts are light).
// `debug` writes a false-colour preview of the classification for review.
import type { AvatarId, OutfitRegion } from '../../src/shared/outfit';
import type { Rgba } from './images';

export interface MaskGeometry { P: number[]; U: number[]; J: number[]; W: number[]; index: number[] }
export type IslandClass = 'suit' | 'shirt' | 'tie' | 'skin' | 'shoe';
export interface RegionStats { /** Mean linear luminance of the region in the source texture. */ lum: number; /** Mean sRGB colour. */ color: string; /** Share of the texture. */ area: number }
export interface MaskResult { image: Rgba; regions: Partial<Record<OutfitRegion, RegionStats>>; preview: Rgba; islands: IslandInfo[] }
export interface IslandInfo { id: number; cls: IslandClass; tris: number; pixels: number; center: number[]; size: number[]; lum: number; sat: number; hue: number; group: string }

/**
 * Per-avatar corrections where the generic rules are not enough, by island id. Island ids are stable for a pinned
 * source (they follow FBX triangle order); `--debug` prints them with their position and colour.
 */
const OVERRIDES: Partial<Record<AvatarId, Partial<Record<IslandClass, number[]>>>> = {
  // Waistcoat over a grey shirt: the sleeves, shoulders, collar and shirt front are shirt.
  'business-m04': { shirt: [2, 3, 7, 8, 11, 12, 13, 14, 15] },
  // Purple shirt: collar and shirt front (its cuffs share the hands' islands; see the skin pixel rule).
  'business-m05': { shirt: [4, 5, 7] },
  // Striped top under a burgundy jacket.
  'business-f02': { shirt: [11, 12] },
  // Dark top inside the taupe jacket's neckline.
  'business-f03': { shirt: [40, 41] },
};

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Skin tones: warm hue (red ≥ green ≥ blue), some saturation; very dark texels (nails, creases) count as skin. */
function skinLike(r: number, g: number, b: number): boolean {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx < 60) return true;
  const sat = (mx - mn) / mx;
  return r >= g && g >= b * 0.9 && sat > 0.12;
}

/**
 * Bare skin (a neckline, bare legs) inside clothing: warm orange hue, clearly saturated and bright. Tighter than
 * skinLike so taupe, camel or burgundy fabric never counts.
 */
function skinTone(r: number, g: number, b: number): boolean {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx !== r || mx < 90) return false;
  const sat = (mx - mn) / mx, hue = (60 * (g - b)) / Math.max(1, mx - mn);
  return sat > 0.25 && sat < 0.75 && hue > 8 && hue < 45 && (r + g + b) / 3 > 95;
}

function boneGroup(name: string): 'hand' | 'foot' | 'body' {
  if (/Hand|Finger/.test(name)) return 'hand';
  if (/Foot|Toe/.test(name)) return 'foot';
  return 'body';
}

export function buildMask(id: AvatarId, tex: Rgba, geo: MaskGeometry, boneNames: string[], regionsWanted: OutfitRegion[]): MaskResult {
  const size = tex.width;
  const tris = geo.index.length / 3;
  // Union-find over triangles that share a texture-space vertex (same UV and position).
  const parent = Array.from({ length: tris }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map<string, number>();
  for (let t = 0; t < tris; t++)
    for (let k = 0; k < 3; k++) {
      const v = geo.index[t * 3 + k];
      const key = `${Math.round(geo.U[v * 2] * 4096)},${Math.round(geo.U[v * 2 + 1] * 4096)},${Math.round(geo.P[v * 3] * 1e4)},${Math.round(geo.P[v * 3 + 1] * 1e4)},${Math.round(geo.P[v * 3 + 2] * 1e4)}`;
      const o = owner.get(key);
      if (o === undefined) owner.set(key, t);
      else parent[find(t)] = find(o);
    }
  const islandOf = new Map<number, number>();
  const triIsland = new Int32Array(tris);
  for (let t = 0; t < tris; t++) {
    const r = find(t);
    if (!islandOf.has(r)) islandOf.set(r, islandOf.size);
    triIsland[t] = islandOf.get(r)!;
  }
  const n = islandOf.size;
  // Island statistics: bone groups by weight, 3D extent, and the texels it covers.
  const groups = Array.from({ length: n }, () => ({ hand: 0, foot: 0, body: 0 }));
  const min = Array.from({ length: n }, () => [Infinity, Infinity, Infinity]), max = Array.from({ length: n }, () => [-Infinity, -Infinity, -Infinity]);
  const count = new Int32Array(n);
  for (let t = 0; t < tris; t++) {
    const i = triIsland[t];
    count[i]++;
    for (let k = 0; k < 3; k++) {
      const v = geo.index[t * 3 + k];
      for (let c = 0; c < 4; c++) groups[i][boneGroup(boneNames[geo.J[v * 4 + c]])] += geo.W[v * 4 + c];
      for (let c = 0; c < 3; c++) { min[i][c] = Math.min(min[i][c], geo.P[v * 3 + c]); max[i][c] = Math.max(max[i][c], geo.P[v * 3 + c]); }
    }
  }
  // Rasterize triangles into an island-id map (with a 2-texel dilation so seams are covered after filtering).
  const label = new Int32Array(size * size).fill(-1);
  for (let t = 0; t < tris; t++) {
    const pts = [0, 1, 2].map((k) => { const v = geo.index[t * 3 + k]; return [geo.U[v * 2] * size - 0.5, geo.U[v * 2 + 1] * size - 0.5]; });
    const [x0, y0] = pts[0], [x1, y1] = pts[1], [x2, y2] = pts[2];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)) / area, w1 = ((x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)) / area, w2 = 1 - w0 - w1;
        if (w0 >= -0.02 && w1 >= -0.02 && w2 >= -0.02) label[y * size + x] = triIsland[t];
      }
  }
  for (let pass = 0; pass < 2; pass++) {
    const prev = label.slice();
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (prev[y * size + x] >= 0) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < size && yy < size && prev[yy * size + xx] >= 0) { label[y * size + x] = prev[yy * size + xx]; break; }
        }
      }
  }
  const sum = Array.from({ length: n }, () => [0, 0, 0, 0]);
  for (let p = 0; p < size * size; p++) {
    const i = label[p];
    if (i < 0) continue;
    sum[i][0] += tex.data[p * 4]; sum[i][1] += tex.data[p * 4 + 1]; sum[i][2] += tex.data[p * 4 + 2]; sum[i][3]++;
  }
  const islands: IslandInfo[] = [];
  for (let i = 0; i < n; i++) {
    const g = groups[i], total = g.hand + g.foot + g.body || 1;
    const px = sum[i][3] || 1;
    const [r, gg, b] = [sum[i][0] / px / 255, sum[i][1] / px / 255, sum[i][2] / px / 255];
    const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), sat = mx ? (mx - mn) / mx : 0;
    const hue = mx === r && mx > mn ? (60 * (gg - b)) / (mx - mn) : mx === gg && mx > mn ? 120 + (60 * (b - r)) / (mx - mn) : mx > mn ? 240 + (60 * (r - gg)) / (mx - mn) : 0;
    const center = [0, 1, 2].map((c) => (min[i][c] + max[i][c]) / 2), extent = [0, 1, 2].map((c) => max[i][c] - min[i][c]);
    const group = g.hand / total > 0.5 ? 'hand' : g.foot / total > 0.5 ? 'foot' : 'body';
    let cls: IslandClass;
    // Hands are skin; cuffs and sleeve ends are also weighted to the hand, but they are fabric-coloured.
    if (group === 'hand' && sat > 0.3) cls = 'skin';
    else if (group === 'foot') cls = 'shoe';
    // A tie (blade and knot) is a narrow separate piece on the chest centre line, in front of the shirt.
    else if (regionsWanted.includes('tie') && Math.abs(center[0]) < 0.01 && center[2] > 0.05 && extent[0] < 0.13 && (extent[1] > 0.15 || center[1] > 1.43)) cls = 'tie';
    else if (skinTone(r * 255, gg * 255, b * 255)) cls = 'skin';
    else if (lum > 0.38 && sat < 0.3) cls = 'shirt';
    else cls = 'suit';
    for (const [forced, ids] of Object.entries(OVERRIDES[id] ?? {})) if (ids.includes(i)) cls = forced as IslandClass;
    islands.push({ id: i, cls, tris: count[i], pixels: sum[i][3], center: center.map((v) => +v.toFixed(3)), size: extent.map((v) => +v.toFixed(3)), lum: +lum.toFixed(3), sat: +sat.toFixed(3), hue: Math.round(hue), group });
  }
  // Mask and statistics.
  const image: Rgba = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  const preview: Rgba = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  const COLORS: Record<IslandClass, number[]> = { suit: [90, 90, 200], shirt: [240, 240, 240], tie: [220, 40, 40], skin: [240, 170, 120], shoe: [20, 20, 20] };
  const acc: Record<string, number[]> = {};
  for (let p = 0; p < size * size; p++) {
    image.data[p * 4 + 3] = 255;
    const i = label[p];
    if (i < 0) { preview.data.set([0, 60, 0, 255], p * 4); continue; }
    let cls = islands[i].cls;
    // Fabric inside a hand island (a cuff modelled with the hand): light, and not skin-coloured.
    if (cls === 'skin' && islands[i].group === 'hand' && !skinLike(tex.data[p * 4], tex.data[p * 4 + 1], tex.data[p * 4 + 2])) cls = 'shirt';
    // Bare skin painted into a clothing piece (a neckline) keeps its colour; skipped on warm fabric (taupe, camel),
    // whose own highlights would read as skin.
    const warmFabric = islands[i].sat > 0.2 && islands[i].hue > 5 && islands[i].hue < 50;
    if ((cls === 'suit' || cls === 'shirt') && !warmFabric && skinTone(tex.data[p * 4], tex.data[p * 4 + 1], tex.data[p * 4 + 2])) cls = 'skin';
    const channel = cls === 'suit' ? 0 : cls === 'shirt' ? 1 : cls === 'tie' ? 2 : -1;
    const c = COLORS[cls];
    // The preview blends the class colour with the texture so painted detail stays readable.
    for (let k = 0; k < 3; k++) preview.data[p * 4 + k] = Math.round(c[k] * 0.55 + tex.data[p * 4 + k] * 0.45);
    preview.data[p * 4 + 3] = 255;
    if (channel < 0 || !regionsWanted.includes(cls as OutfitRegion)) continue;
    image.data[p * 4 + channel] = 255;
    const a = (acc[cls] ??= [0, 0, 0, 0, 0]);
    const r = tex.data[p * 4], g = tex.data[p * 4 + 1], b = tex.data[p * 4 + 2];
    a[0] += r; a[1] += g; a[2] += b;
    a[3] += 0.2126 * srgbToLinear(r / 255) + 0.7152 * srgbToLinear(g / 255) + 0.0722 * srgbToLinear(b / 255);
    a[4]++;
  }
  const regions: Partial<Record<OutfitRegion, RegionStats>> = {};
  for (const [cls, a] of Object.entries(acc)) regions[cls as OutfitRegion] = { lum: +(a[3] / a[4]).toFixed(4), color: hex(a[0] / a[4], a[1] / a[4], a[2] / a[4]), area: +(a[4] / (size * size)).toFixed(4) };
  return { image, regions, preview, islands };
}
