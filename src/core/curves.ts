/**
 * Curves: control points → 256-entry LUT via monotone cubic (Fritsch–Carlson) interpolation,
 * so the curve never overshoots between points. Pure and DOM-free (used in the worker).
 *
 * Curves are carried inside the generic numeric `Params` record so they travel through the
 * filter worker unchanged: `c{ch}n` = point count, `c{ch}x{i}` / `c{ch}y{i}` = coordinates
 * (0..255), channel 0 = RGB (master), 1..3 = R, G, B.
 */
export type CurvePoint = [number, number];
/** [master, red, green, blue] */
export type Curves = [CurvePoint[], CurvePoint[], CurvePoint[], CurvePoint[]];

export const CURVE_CHANNELS = ['RGB', 'R', 'G', 'B'] as const;
export const MAX_CURVE_POINTS = 16;

export function identityCurve(): CurvePoint[] {
  return [
    [0, 0],
    [255, 255],
  ];
}
export function identityCurves(): Curves {
  return [identityCurve(), identityCurve(), identityCurve(), identityCurve()];
}

/** Sorts, clamps and de-duplicates points (same x → last wins); guarantees ≥ 2 points. */
export function normalizePoints(pts: CurvePoint[]): CurvePoint[] {
  const clean = pts
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p): CurvePoint => [Math.max(0, Math.min(255, p[0])), Math.max(0, Math.min(255, p[1]))])
    .sort((a, b) => a[0] - b[0]);
  const out: CurvePoint[] = [];
  for (const p of clean) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.5) out[out.length - 1] = p;
    else out.push(p);
  }
  if (out.length === 0) return identityCurve();
  if (out.length === 1) return [[0, out[0]![1]], [255, out[0]![1]]];
  return out.slice(0, MAX_CURVE_POINTS);
}

export function curveLut(points: CurvePoint[]): Uint8ClampedArray {
  const p = normalizePoints(points);
  const n = p.length;
  const lut = new Uint8ClampedArray(256);
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  // secant slopes
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1]! - ys[i]!) / Math.max(1e-6, xs[i + 1]! - xs[i]!));
  // tangents (Fritsch–Carlson)
  const m: number[] = new Array(n).fill(0);
  m[0] = d[0]!;
  m[n - 1] = d[n - 2]!;
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!, b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]!) {
      lut[x] = ys[0]!;
      continue;
    }
    if (x >= xs[n - 1]!) {
      lut[x] = ys[n - 1]!;
      continue;
    }
    while (seg < n - 2 && x > xs[seg + 1]!) seg++;
    const x0 = xs[seg]!, x1 = xs[seg + 1]!;
    const hgt = x1 - x0;
    const t = (x - x0) / hgt;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    lut[x] = Math.round(h00 * ys[seg]! + h10 * hgt * m[seg]! + h01 * ys[seg + 1]! + h11 * hgt * m[seg + 1]!);
  }
  return lut;
}

/** Per-channel LUTs with the master curve applied after each channel curve. */
export function curvesLuts(c: Curves): [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray] {
  const master = curveLut(c[0]);
  const out = [1, 2, 3].map((ch) => {
    const l = curveLut(c[ch]!);
    const r = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) r[i] = master[l[i]!]!;
    return r;
  });
  return out as [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray];
}

export function encodeCurves(c: Curves): Record<string, number> {
  const p: Record<string, number> = {};
  c.forEach((pts, ch) => {
    const n = normalizePoints(pts);
    p[`c${ch}n`] = n.length;
    n.forEach(([x, y], i) => {
      p[`c${ch}x${i}`] = x;
      p[`c${ch}y${i}`] = y;
    });
  });
  return p;
}

export function decodeCurves(p: Record<string, number>): Curves {
  const out = identityCurves();
  for (let ch = 0; ch < 4; ch++) {
    const n = Math.min(MAX_CURVE_POINTS, Math.floor(p[`c${ch}n`] ?? 0));
    if (n < 2) continue;
    const pts: CurvePoint[] = [];
    for (let i = 0; i < n; i++) pts.push([p[`c${ch}x${i}`] ?? 0, p[`c${ch}y${i}`] ?? 0]);
    out[ch] = normalizePoints(pts);
  }
  return out;
}

export function isIdentityCurve(pts: CurvePoint[]): boolean {
  const l = curveLut(pts);
  for (let i = 0; i < 256; i++) if (l[i] !== i) return false;
  return true;
}
