/**
 * Pure single-channel (alpha, 0..255) mask operations used by selection refinement and
 * the magic wand: exact Euclidean grow/shrink, gaussian-ish feather, combine, bounds and a
 * marching-squares outline for marching ants. DOM-free, unit tested.
 */
import type { Rect } from './types';

export type Alpha = Uint8ClampedArray | Uint8Array;

const INF = 1e20;

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    d[q] = dq * dq + f[v[k]!]!;
  }
}

/** Squared Euclidean distance from every pixel to the nearest pixel where `inside(p)` is true. */
export function distanceSq(w: number, h: number, inside: (p: number) => boolean): Float64Array {
  const grid = new Float64Array(w * h);
  for (let p = 0; p < w * h; p++) grid[p] = inside(p) ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]!;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x]!;
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[row + x] = d[x]!;
  }
  return grid;
}

/** Expands (r > 0) or contracts (r < 0) the selection (threshold 50%) by |r| pixels. */
export function growMask(a: Alpha, w: number, h: number, r: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h);
  if (r === 0) {
    out.set(a);
    return out;
  }
  if (r > 0) {
    const d = distanceSq(w, h, (p) => a[p]! >= 128);
    const r2 = r * r;
    for (let p = 0; p < w * h; p++) out[p] = d[p]! <= r2 ? 255 : 0;
  } else {
    const d = distanceSq(w, h, (p) => a[p]! < 128);
    const r2 = r * r;
    // pixels outside the document count as unselected
    for (let p = 0; p < w * h; p++) {
      const x = p % w, y = (p / w) | 0;
      const edge = Math.min(x + 1, y + 1, w - x, h - y);
      out[p] = d[p]! > r2 && edge > -r ? 255 : 0;
    }
  }
  return out;
}

function boxBlur1(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horiz: boolean): void {
  const inv = 1 / (2 * r + 1);
  const len = horiz ? w : h, lines = horiz ? h : w;
  for (let l = 0; l < lines; l++) {
    const at = (i: number) => (horiz ? l * w + i : i * w + l);
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[at(Math.min(len - 1, Math.max(0, k)))]!;
    for (let i = 0; i < len; i++) {
      dst[at(i)] = acc * inv;
      acc += src[at(Math.min(len - 1, i + r + 1))]! - src[at(Math.max(0, i - r))]!;
    }
  }
}

/** Softens the edge: three box passes ≈ gaussian with sigma ≈ radius / 2. */
export function featherMask(a: Alpha, w: number, h: number, radius: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h);
  if (radius < 0.5) {
    out.set(a);
    return out;
  }
  const buf = Float32Array.from(a);
  const tmp = new Float32Array(w * h);
  const r = Math.max(1, Math.round(radius / 2));
  for (let pass = 0; pass < 3; pass++) {
    boxBlur1(buf, tmp, w, h, r, true);
    boxBlur1(tmp, buf, w, h, r, false);
  }
  for (let p = 0; p < w * h; p++) out[p] = buf[p]!;
  return out;
}

export function invertMask(a: Alpha): Uint8ClampedArray {
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i++) out[i] = 255 - a[i]!;
  return out;
}

/** Combines b into a: add = max, sub = a·(1−b), intersect = min. */
export function combineMasks(a: Alpha, b: Alpha, mode: 'add' | 'sub' | 'intersect'): Uint8ClampedArray {
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    out[i] = mode === 'add' ? Math.max(x, y) : mode === 'intersect' ? Math.min(x, y) : (x * (255 - y)) / 255;
  }
  return out;
}

/** Tight bounds of non-zero pixels (null when empty). */
export function maskBounds(a: Alpha, w: number, h: number): Rect | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!a[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Pixel-edge outline of the region alpha ≥ 128 as a flat list of segments
 * [x0, y0, x1, y1, ...] in pixel-corner coordinates. Collinear runs are merged so large
 * rectangles cost a handful of segments.
 */
export function maskOutline(a: Alpha, w: number, h: number): number[] {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && a[y * w + x]! >= 128;
  const segs: number[] = [];
  // horizontal edges: between row y-1 and y
  for (let y = 0; y <= h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && on(x, y - 1) !== on(x, y);
      if (edge && start < 0) start = x;
      else if (!edge && start >= 0) {
        segs.push(start, y, x, y);
        start = -1;
      }
    }
  }
  for (let x = 0; x <= w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && on(x - 1, y) !== on(x, y);
      if (edge && start < 0) start = y;
      else if (!edge && start >= 0) {
        segs.push(x, start, x, y);
        start = -1;
      }
    }
  }
  return segs;
}
