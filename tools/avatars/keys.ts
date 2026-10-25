// Keyframe reduction shared by the avatar build (build-avatars.ts) and the CHAR-02 clip build (build-clips.mts).
import * as THREE from 'three';

/**
 * Keys a linear (or slerp) interpolation can drop: a key is kept only when interpolating between its kept
 * neighbours would miss any original key by more than `tolerance` (radians for rotations, source units otherwise).
 */
export function reduceKeys(times: Float32Array, values: Float32Array, n: number, tolerance: number): number[] {
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
