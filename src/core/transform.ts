/**
 * Free-transform math (pure). A transform maps a source bitmap of size w×h whose original
 * centre sits at (cx, cy) in the document onto: translate(cx+tx, cy+ty)·rotate(rot)·scale(sx, sy)
 * about its centre. Negative scale = flip.
 */
import type { Matrix } from './document';
import type { Rect } from './types';

export interface XformState {
  w: number;
  h: number;
  cx: number;
  cy: number;
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  /** Radians, clockwise on screen (y down). */
  rot: number;
}

export interface Pt {
  x: number;
  y: number;
}

export function initialXform(r: Rect): XformState {
  return { w: r.w, h: r.h, cx: r.x + r.w / 2, cy: r.y + r.h / 2, tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 };
}

export function xformMatrix(s: XformState): Matrix {
  const cos = Math.cos(s.rot), sin = Math.sin(s.rot);
  const a = cos * s.sx, b = sin * s.sx, c = -sin * s.sy, d = cos * s.sy;
  const X = s.cx + s.tx, Y = s.cy + s.ty;
  return [a, b, c, d, X - (a * s.w) / 2 - (c * s.h) / 2, Y - (b * s.w) / 2 - (d * s.h) / 2];
}

export function applyMatrix(m: Matrix, x: number, y: number): Pt {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function invertMatrix(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}

export function isIdentity(s: XformState): boolean {
  return s.tx === 0 && s.ty === 0 && s.sx === 1 && s.sy === 1 && Math.abs(s.rot) < 1e-9;
}

/** True when the transform is a pure integer translation (keeps pixels and editability exact). */
export function isPureTranslation(s: XformState): boolean {
  return s.sx === 1 && s.sy === 1 && Math.abs(s.rot) < 1e-9 && Number.isInteger(s.tx) && Number.isInteger(s.ty);
}

/** Corners nw, ne, se, sw in document coordinates. */
export function xformCorners(s: XformState): Pt[] {
  const m = xformMatrix(s);
  return [applyMatrix(m, 0, 0), applyMatrix(m, s.w, 0), applyMatrix(m, s.w, s.h), applyMatrix(m, 0, s.h)];
}

/** Integer bounding box of the transformed bitmap. */
export function xformBounds(s: XformState): Rect {
  const c = xformCorners(s);
  const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
  const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys));
  const x1 = Math.ceil(Math.max(...xs)), y1 = Math.ceil(Math.max(...ys));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** Point in the centred, un-rotated frame of `s` (units: document pixels). */
function toCentred(s: XformState, p: Pt): Pt {
  const dx = p.x - (s.cx + s.tx), dy = p.y - (s.cy + s.ty);
  const cos = Math.cos(-s.rot), sin = Math.sin(-s.rot);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}
function fromCentred(s: XformState, p: Pt): Pt {
  const cos = Math.cos(s.rot), sin = Math.sin(s.rot);
  return { x: s.cx + s.tx + p.x * cos - p.y * sin, y: s.cy + s.ty + p.x * sin + p.y * cos };
}

/**
 * Scale by dragging a handle. (hx, hy) ∈ {0, 0.5, 1} is the handle position in unit
 * coordinates of the box; the opposite point stays fixed. `keepRatio` (Shift) scales
 * uniformly; `fromCentre` (Alt) keeps the centre fixed instead.
 */
export function dragHandle(s0: XformState, hx: number, hy: number, p: Pt, keepRatio: boolean, fromCentre = false): XformState {
  const q = toCentred(s0, p);
  const ax = fromCentre ? 0 : (0.5 - hx) * s0.w * s0.sx;
  const ay = fromCentre ? 0 : (0.5 - hy) * s0.h * s0.sy;
  const k = fromCentre ? 0.5 : 1;
  let sx = hx === 0.5 ? s0.sx : (q.x - ax) / ((2 * hx - 1) * s0.w * k);
  let sy = hy === 0.5 ? s0.sy : (q.y - ay) / ((2 * hy - 1) * s0.h * k);
  if (keepRatio) {
    const kx = sx / s0.sx, ky = sy / s0.sy;
    let m: number;
    if (hx === 0.5) m = Math.abs(ky);
    else if (hy === 0.5) m = Math.abs(kx);
    else m = Math.max(Math.abs(kx), Math.abs(ky));
    sx = s0.sx * m * (hx === 0.5 ? 1 : Math.sign(kx) || 1);
    sy = s0.sy * m * (hy === 0.5 ? 1 : Math.sign(ky) || 1);
  }
  const minS = 1 / Math.max(s0.w, s0.h);
  if (Math.abs(sx) < minS) sx = minS * (Math.sign(sx) || 1);
  if (Math.abs(sy) < minS) sy = minS * (Math.sign(sy) || 1);
  if (fromCentre) return { ...s0, sx, sy };
  // keep the anchor fixed in document space
  const anchorDoc = fromCentred(s0, { x: ax, y: ay });
  const a2 = { x: (0.5 - hx) * s0.w * sx, y: (0.5 - hy) * s0.h * sy };
  const cos = Math.cos(s0.rot), sin = Math.sin(s0.rot);
  const cX = anchorDoc.x - (a2.x * cos - a2.y * sin);
  const cY = anchorDoc.y - (a2.x * sin + a2.y * cos);
  return { ...s0, sx, sy, tx: cX - s0.cx, ty: cY - s0.cy };
}

/** Rotation by dragging around the centre; `snap` rounds to 15°. */
export function dragRotate(s0: XformState, start: Pt, p: Pt, snap: boolean): XformState {
  const X = s0.cx + s0.tx, Y = s0.cy + s0.ty;
  let rot = s0.rot + Math.atan2(p.y - Y, p.x - X) - Math.atan2(start.y - Y, start.x - X);
  if (snap) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
  return { ...s0, rot: normAngle(rot) };
}

export function normAngle(a: number): number {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return r;
}

/** Whether a document point lies inside the transformed box. */
export function hitInside(s: XformState, p: Pt): boolean {
  const inv = invertMatrix(xformMatrix(s));
  if (!inv) return false;
  const l = applyMatrix(inv, p.x, p.y);
  return l.x >= 0 && l.y >= 0 && l.x <= s.w && l.y <= s.h;
}
