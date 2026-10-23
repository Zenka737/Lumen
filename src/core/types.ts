/** Shared, DOM-free type definitions. */

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'soft-light'
  | 'difference';

export type LayerKind = 'raster' | 'image' | 'text' | 'shape' | 'adjustment';

export type TextAlign = 'left' | 'center' | 'right';

/** Re-editable text layer source (the layer canvas is rendered from it). */
export interface TextData {
  text: string;
  font: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
}

export type ShapeType = 'rect' | 'ellipse' | 'line' | 'polygon' | 'star';

/** How corners of rect / polygon / star shapes are rounded. */
export type CornerStyle = 'round' | 'smooth' | 'cut' | 'inverse';

/**
 * Re-editable vector-like shape. Geometry is local to the layer: the shape box is
 * (0,0,w,h) placed at (pad,pad) inside the layer canvas; lines run from (x1,y1) to (x2,y2)
 * in the same box space.
 */
export interface ShapeData {
  type: ShapeType;
  w: number;
  h: number;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  /** Uniform corner radius (rect corners unless `radii` is set; polygon / star vertices). */
  radius: number;
  /** Rect only: per-corner radii [top-left, top-right, bottom-right, bottom-left]; overrides `radius`. */
  radii?: [number, number, number, number];
  cornerStyle?: CornerStyle;
  /** polygon: number of sides, star: number of points. */
  sides?: number;
  /** star: inner radius as a fraction of the outer one. */
  innerRatio?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

/** Non-destructive adjustment layer settings (point filters only). */
export interface AdjustData {
  filterId: string;
  params: Record<string, number>;
}

/** Non-destructive layer styles, rendered at composite time. */
export interface LayerFx {
  shadow?: { on: boolean; color: string; opacity: number; dx: number; dy: number; blur: number };
  glow?: { on: boolean; color: string; opacity: number; blur: number; strength: number };
  stroke?: { on: boolean; color: string; width: number; pos: 'outside' | 'inside' | 'center'; opacity: number };
  overlay?: { on: boolean; mode: 'color' | 'gradient'; color: string; color2: string; angle: number; opacity: number };
}

export interface LayerMeta {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  locked: boolean;
  /** 0..1 */
  opacity: number;
  blend: BlendMode;
  /** Offset of the layer canvas inside the document, in document pixels. */
  x: number;
  y: number;
  /** Present when the layer has a mask: whether it is applied. */
  maskEnabled?: boolean;
  text?: TextData;
  shape?: ShapeData;
  adjust?: AdjustData;
  /** Layer styles (shadow, glow, outline, overlay). */
  fx?: LayerFx;
}

export function cloneFx(f: LayerFx): LayerFx {
  return { ...(f.shadow ? { shadow: { ...f.shadow } } : {}), ...(f.glow ? { glow: { ...f.glow } } : {}), ...(f.stroke ? { stroke: { ...f.stroke } } : {}), ...(f.overlay ? { overlay: { ...f.overlay } } : {}) };
}

/** Deep copy of layer metadata (nested data objects must never be shared between history states). */
export function cloneMeta(m: LayerMeta): LayerMeta {
  const out: LayerMeta = { ...m };
  if (m.text) out.text = { ...m.text };
  if (m.shape) out.shape = { ...m.shape, ...(m.shape.radii ? { radii: [...m.shape.radii] as [number, number, number, number] } : {}) };
  if (m.fx) out.fx = cloneFx(m.fx);
  if (m.adjust) out.adjust = { filterId: m.adjust.filterId, params: { ...m.adjust.params } };
  return out;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Minimal ImageData-compatible pixel container (usable in Node tests and workers). */
export interface PixelBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function rectUnion(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Integer-aligned intersection of rect with [0,0,w,h]; null when empty. */
export function rectClip(r: Rect, w: number, h: number): Rect | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.w));
  const y1 = Math.min(h, Math.ceil(r.y + r.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
