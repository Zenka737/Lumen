/**
 * Pure (DOM-free) geometry for vector-like shapes: polygons with per-corner rounding.
 * A path is a list of M/L/C/Z commands in the shape's box space (0,0)-(w,h).
 */
import type { CornerStyle, ShapeData } from './types';

export type PathCmd =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: 'Z' };

type Pt = { x: number; y: number };

export const MIN_SIDES = 3;
export const MAX_SIDES = 60;

/** Effective per-corner radii [tl, tr, br, bl] of a rect. */
export function cornerRadii(s: Pick<ShapeData, 'radius' | 'radii'>): [number, number, number, number] {
  const r = s.radii;
  if (r && r.length === 4) return [Math.max(0, r[0]), Math.max(0, r[1]), Math.max(0, r[2]), Math.max(0, r[3])];
  const v = Math.max(0, s.radius);
  return [v, v, v, v];
}

/** Vertices of a regular n-gon / n-point star inscribed in the box, first vertex pointing up. */
export function polygonPoints(w: number, h: number, sides: number, innerRatio?: number): Pt[] {
  const n = Math.max(MIN_SIDES, Math.min(MAX_SIDES, Math.round(sides)));
  const star = innerRatio !== undefined;
  const count = star ? n * 2 : n;
  const cx = w / 2, cy = h / 2;
  const out: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const k = star && i % 2 === 1 ? Math.max(0.05, Math.min(0.98, innerRatio!)) : 1;
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    out.push({ x: cx + Math.cos(a) * (w / 2) * k, y: cy + Math.sin(a) * (h / 2) * k });
  }
  return out;
}

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: Pt) => Math.hypot(a.x, a.y);
const unit = (a: Pt): Pt => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};

/**
 * Closed polygon with every vertex replaced by a corner of the given style and radius.
 * Radii are clamped so that neighbouring corners never overlap on a shared edge.
 */
export function roundedPolygon(pts: Pt[], radii: number[], style: CornerStyle = 'round'): PathCmd[] {
  const n = pts.length;
  if (n < 3) return [];
  const prev = (i: number) => pts[(i + n - 1) % n]!;
  const next = (i: number) => pts[(i + 1) % n]!;
  const u1 = pts.map((p, i) => unit(sub(prev(i), p))); // towards previous vertex
  const u2 = pts.map((p, i) => unit(sub(next(i), p))); // towards next vertex
  // tangent length d = r / tan(theta/2), theta = interior angle at the vertex
  const tangent = pts.map((_, i) => {
    const r = Math.max(0, radii[i] ?? 0);
    if (r === 0) return 0;
    const cos = Math.max(-1, Math.min(1, u1[i]!.x * u2[i]!.x + u1[i]!.y * u2[i]!.y));
    const theta = Math.acos(cos);
    if (theta < 1e-3 || Math.PI - theta < 1e-3) return 0;
    return r / Math.tan(theta / 2);
  });
  // style stretch: 'smooth' reaches further along each edge than a circular arc
  const stretch = style === 'smooth' ? 1.45 : 1;
  const d = tangent.map((t) => t * stretch);
  // keep neighbouring corners from overlapping on a shared edge
  const scale = pts.map(() => 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const l = len(sub(pts[j]!, pts[i]!));
    const need = d[i]! + d[j]!;
    if (need > l && need > 0) {
      const f = l / need;
      scale[i] = Math.min(scale[i]!, f);
      scale[j] = Math.min(scale[j]!, f);
    }
  }
  const out: PathCmd[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const di = d[i]! * scale[i]!;
    if (di < 0.01) {
      out.push(i === 0 ? { op: 'M', x: p.x, y: p.y } : { op: 'L', x: p.x, y: p.y });
      continue;
    }
    const a = { x: p.x + u1[i]!.x * di, y: p.y + u1[i]!.y * di };
    const b = { x: p.x + u2[i]!.x * di, y: p.y + u2[i]!.y * di };
    out.push(i === 0 ? { op: 'M', x: a.x, y: a.y } : { op: 'L', x: a.x, y: a.y });
    if (style === 'cut') {
      out.push({ op: 'L', x: b.x, y: b.y });
    } else if (style === 'inverse') {
      // concave "ticket" corner: a circular arc centred on the vertex
      const cos = Math.max(-1, Math.min(1, u1[i]!.x * u2[i]!.x + u1[i]!.y * u2[i]!.y));
      const theta = Math.acos(cos);
      const hl = (4 / 3) * Math.tan(theta / 4) * di;
      const cross = u1[i]!.x * u2[i]!.y - u1[i]!.y * u2[i]!.x;
      const s = cross > 0 ? 1 : -1;
      // tangent at `a` (on the circle around p) is u1 rotated by +-90deg, towards `b`
      const t1 = { x: -u1[i]!.y * s, y: u1[i]!.x * s };
      const t2 = { x: u2[i]!.y * s, y: -u2[i]!.x * s };
      out.push({ op: 'C', x1: a.x + t1.x * hl, y1: a.y + t1.y * hl, x2: b.x + t2.x * hl, y2: b.y + t2.y * hl, x: b.x, y: b.y });
    } else {
      // circular fillet (round) or its extended, curvature-continuous cousin (smooth)
      const cos = Math.max(-1, Math.min(1, u1[i]!.x * u2[i]!.x + u1[i]!.y * u2[i]!.y));
      const theta = Math.acos(cos);
      const phi = Math.PI - theta; // turn angle
      const r = Math.max(0, radii[i] ?? 0);
      let hl = (4 / 3) * Math.tan(phi / 4) * (r * (di / Math.max(1e-6, tangent[i]! * stretch)));
      if (style === 'smooth') hl = di * 0.62;
      out.push({
        op: 'C',
        x1: a.x - u1[i]!.x * hl,
        y1: a.y - u1[i]!.y * hl,
        x2: b.x - u2[i]!.x * hl,
        y2: b.y - u2[i]!.y * hl,
        x: b.x,
        y: b.y,
      });
    }
  }
  out.push({ op: 'Z' });
  return out;
}

/** Path of a rect / polygon / star shape; null for ellipse and line (drawn natively). */
export function shapePathCommands(s: ShapeData): PathCmd[] | null {
  const style = s.cornerStyle ?? 'round';
  if (s.type === 'rect') {
    const [tl, tr, br, bl] = cornerRadii(s);
    const pts = [{ x: 0, y: 0 }, { x: s.w, y: 0 }, { x: s.w, y: s.h }, { x: 0, y: s.h }];
    // a corner can never be rounder than half of the shorter side
    const cap = Math.min(s.w, s.h) / 2;
    const radii = [tl, tr, br, bl].map((r) => Math.min(r, cap));
    return roundedPolygon(pts, radii, style);
  }
  if (s.type === 'polygon' || s.type === 'star') {
    const pts = polygonPoints(s.w, s.h, s.sides ?? (s.type === 'star' ? 5 : 6), s.type === 'star' ? s.innerRatio ?? 0.5 : undefined);
    const r = Math.max(0, s.radius);
    return roundedPolygon(pts, pts.map(() => r), style);
  }
  return null;
}
