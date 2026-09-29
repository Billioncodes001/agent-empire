/** Walkable-floor grid and A* paths for workers walking between desks and amenities. Pure; no three.js. */

export interface NavBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
export interface Point {
  x: number;
  z: number;
}

const SQRT2 = Math.SQRT2;

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  /** 1 = blocked (an obstacle grown by the walker's radius, or outside the room). */
  private readonly blocked: Uint8Array;
  constructor(
    readonly bounds: NavBox,
    obstacles: readonly NavBox[],
    readonly cell = 0.2,
    readonly radius = 0.3,
  ) {
    this.cols = Math.ceil((bounds.maxX - bounds.minX) / cell);
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
    this.blocked = new Uint8Array(this.cols * this.rows);
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) {
        const x = bounds.minX + (c + 0.5) * cell, z = bounds.minZ + (r + 0.5) * cell;
        if (x - radius < bounds.minX || x + radius > bounds.maxX || z - radius < bounds.minZ || z + radius > bounds.maxZ) this.blocked[r * this.cols + c] = 1;
      }
    for (const o of obstacles) this.block(o);
  }
  private block(o: NavBox) {
    const { cell, radius, bounds } = this;
    const c0 = Math.max(0, Math.floor((o.minX - radius - bounds.minX) / cell)), c1 = Math.min(this.cols - 1, Math.floor((o.maxX + radius - bounds.minX) / cell));
    const r0 = Math.max(0, Math.floor((o.minZ - radius - bounds.minZ) / cell)), r1 = Math.min(this.rows - 1, Math.floor((o.maxZ + radius - bounds.minZ) / cell));
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const x = bounds.minX + (c + 0.5) * cell, z = bounds.minZ + (r + 0.5) * cell;
        // Grow the box by the radius with rounded corners.
        const dx = Math.max(o.minX - x, 0, x - o.maxX), dz = Math.max(o.minZ - z, 0, z - o.maxZ);
        if (dx * dx + dz * dz < radius * radius) this.blocked[r * this.cols + c] = 1;
      }
  }
  private col(x: number) { return Math.floor((x - this.bounds.minX) / this.cell); }
  private row(z: number) { return Math.floor((z - this.bounds.minZ) / this.cell); }
  private inside(c: number, r: number) { return c >= 0 && r >= 0 && c < this.cols && r < this.rows; }
  isFree(x: number, z: number): boolean {
    const c = this.col(x), r = this.row(z);
    return this.inside(c, r) && !this.blocked[r * this.cols + c];
  }
  private center(i: number): Point {
    return { x: this.bounds.minX + ((i % this.cols) + 0.5) * this.cell, z: this.bounds.minZ + (Math.floor(i / this.cols) + 0.5) * this.cell };
  }
  /** The free cell nearest to a point (breadth-first), for a start or goal that sits next to furniture. */
  nearestFree(p: Point, maxDistance = 1.5): Point | null {
    const c = this.col(p.x), r = this.row(p.z);
    const reach = Math.ceil(maxDistance / this.cell);
    let best = -1, bestD = Infinity;
    for (let dr = -reach; dr <= reach; dr++)
      for (let dc = -reach; dc <= reach; dc++) {
        const cc = c + dc, rr = r + dr;
        if (!this.inside(cc, rr) || this.blocked[rr * this.cols + cc]) continue;
        const d = dc * dc + dr * dr;
        if (d < bestD) { bestD = d; best = rr * this.cols + cc; }
      }
    return best < 0 || Math.sqrt(bestD) * this.cell > maxDistance ? null : this.center(best);
  }
  /** Whether a straight walk from a to b stays on free cells (sampled at a quarter cell). */
  clearLine(a: Point, b: Point): boolean {
    const d = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(d / (this.cell * 0.25)));
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      if (!this.isFree(a.x + (b.x - a.x) * u, a.z + (b.z - a.z) * u)) return false;
    }
    return true;
  }
  /**
   * A* over 8-connected free cells (no corner cutting), then shortened by line of sight. Returns
   * the waypoints after `from`, ending exactly at `to`, or null when no walkable route exists.
   */
  findPath(from: Point, to: Point): Point[] | null {
    const start = this.isFree(from.x, from.z) ? from : this.nearestFree(from);
    const goal = this.isFree(to.x, to.z) ? to : this.nearestFree(to);
    if (!start || !goal) return null;
    const cols = this.cols, n = cols * this.rows;
    const s = this.row(start.z) * cols + this.col(start.x), g = this.row(goal.z) * cols + this.col(goal.x);
    const gScore = new Float32Array(n).fill(Infinity), came = new Int32Array(n).fill(-1), closed = new Uint8Array(n);
    const gc = g % cols, gr = Math.floor(g / cols);
    const h = (i: number) => {
      const dx = Math.abs((i % cols) - gc), dz = Math.abs(Math.floor(i / cols) - gr);
      return (dx + dz + (SQRT2 - 2) * Math.min(dx, dz)) * this.cell;
    };
    // Binary heap of [f, index].
    const heap: number[] = [];
    const push = (f: number, i: number) => {
      heap.push(f, i);
      let k = heap.length / 2 - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heap[p * 2] <= heap[k * 2]) break;
        [heap[p * 2], heap[k * 2]] = [heap[k * 2], heap[p * 2]];
        [heap[p * 2 + 1], heap[k * 2 + 1]] = [heap[k * 2 + 1], heap[p * 2 + 1]];
        k = p;
      }
    };
    const pop = () => {
      const i = heap[1];
      const lastF = heap[heap.length - 2], lastI = heap[heap.length - 1];
      heap.length -= 2;
      if (heap.length) {
        heap[0] = lastF; heap[1] = lastI;
        let k = 0;
        for (;;) {
          const l = k * 2 + 1, r = l + 1;
          let m = k;
          if (l * 2 < heap.length && heap[l * 2] < heap[m * 2]) m = l;
          if (r * 2 < heap.length && heap[r * 2] < heap[m * 2]) m = r;
          if (m === k) break;
          [heap[m * 2], heap[k * 2]] = [heap[k * 2], heap[m * 2]];
          [heap[m * 2 + 1], heap[k * 2 + 1]] = [heap[k * 2 + 1], heap[m * 2 + 1]];
          k = m;
        }
      }
      return i;
    };
    gScore[s] = 0;
    push(h(s), s);
    let found = s === g;
    while (heap.length && !found) {
      const i = pop();
      if (closed[i]) continue;
      closed[i] = 1;
      if (i === g) { found = true; break; }
      const c = i % cols, r = Math.floor(i / cols);
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const cc = c + dc, rr = r + dr;
          if (!this.inside(cc, rr)) continue;
          const j = rr * cols + cc;
          if (this.blocked[j] || closed[j]) continue;
          // No squeezing diagonally between two blocked cells.
          if (dr && dc && (this.blocked[r * cols + cc] || this.blocked[rr * cols + c])) continue;
          const cost = gScore[i] + (dr && dc ? SQRT2 : 1) * this.cell;
          if (cost < gScore[j]) {
            gScore[j] = cost;
            came[j] = i;
            push(cost + h(j), j);
          }
        }
    }
    if (!found) return null;
    const cells: Point[] = [];
    for (let i = g; i !== s && i >= 0; i = came[i]) cells.push(this.center(i));
    cells.reverse();
    const raw = [start, ...cells.slice(0, -1), goal];
    // String-pull: keep only the corners that line of sight needs.
    const out: Point[] = [];
    let anchor = start;
    for (let k = 1; k < raw.length; k++) {
      if (k === raw.length - 1 || !this.clearLine(anchor, raw[k + 1])) {
        out.push(raw[k]);
        anchor = raw[k];
      }
    }
    if (start !== from) out.unshift(start);
    if (goal !== to) out.push({ x: to.x, z: to.z });
    return out;
  }
}

/** Total length of from → waypoints. */
export function pathLength(from: Point, points: readonly Point[]): number {
  let d = 0, a = from;
  for (const p of points) { d += Math.hypot(p.x - a.x, p.z - a.z); a = p; }
  return d;
}
