import { createCanvas, ctx2d, readPixels } from './canvas';
import { maskBounds, maskOutline } from './maskOps';
import type { Rect } from './types';

export type SelShape =
  | { type: 'rect'; x: number; y: number; w: number; h: number }
  | { type: 'ellipse'; x: number; y: number; w: number; h: number }
  | { type: 'poly'; pts: number[] };

export interface SelPart {
  shape: SelShape;
  mode: 'add' | 'sub';
}

export function shapePath(s: SelShape): Path2D {
  const p = new Path2D();
  if (s.type === 'rect') p.rect(s.x, s.y, s.w, s.h);
  else if (s.type === 'ellipse') p.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.max(0.01, s.w / 2), Math.max(0.01, s.h / 2), 0, 0, Math.PI * 2);
  else {
    for (let i = 0; i < s.pts.length; i += 2) {
      if (i === 0) p.moveTo(s.pts[0]!, s.pts[1]!);
      else p.lineTo(s.pts[i]!, s.pts[i + 1]!);
    }
    p.closePath();
  }
  return p;
}

export function shapeBounds(s: SelShape): Rect {
  if (s.type !== 'poly') return { x: s.x, y: s.y, w: s.w, h: s.h };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < s.pts.length; i += 2) {
    x0 = Math.min(x0, s.pts[i]!); x1 = Math.max(x1, s.pts[i]!);
    y0 = Math.min(y0, s.pts[i + 1]!); y1 = Math.max(y1, s.pts[i + 1]!);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface SelState {
  parts: SelPart[];
  /** Document-sized pixel mask (alpha) underneath the parts — from feather, wand, grow… */
  raster: HTMLCanvasElement | null;
}

/**
 * Selection = optional raster base mask plus an ordered list of add/subtract shapes.
 * The combined alpha mask is rasterised lazily (document-sized) and cached until the
 * selection changes. Raster canvases are treated as immutable (history keeps references).
 */
export class Selection {
  private parts: SelPart[] = [];
  private raster: HTMLCanvasElement | null = null;
  private rasterBounds: Rect | null = null;
  private maskCache: HTMLCanvasElement | null = null;
  private maskKey = '';
  private outlineCache: { key: string; paths: Path2D[] } | null = null;
  private version = 0;

  get active(): boolean {
    return !!this.raster || this.parts.some((p) => p.mode === 'add');
  }
  get hasRaster(): boolean {
    return !!this.raster;
  }
  getParts(): SelPart[] {
    return this.parts.map((p) => ({ mode: p.mode, shape: cloneShape(p.shape) }));
  }
  getRaster(): HTMLCanvasElement | null {
    return this.raster;
  }
  getState(): SelState {
    return { parts: this.getParts(), raster: this.raster };
  }
  setState(s: SelState): void {
    this.setParts(s.parts, s.raster);
  }
  /** Replaces the selection. `raster` must not be mutated afterwards. */
  setParts(parts: SelPart[], raster: HTMLCanvasElement | null = null): void {
    this.parts = parts.map((p) => ({ mode: p.mode, shape: cloneShape(p.shape) }));
    if (raster !== this.raster) {
      this.raster = raster;
      this.rasterBounds = null;
      if (raster) {
        const d = readPixels(raster, 0, 0, raster.width, raster.height).data;
        const a = new Uint8ClampedArray(raster.width * raster.height);
        for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3]!;
        this.rasterBounds = maskBounds(a, raster.width, raster.height);
        if (!this.rasterBounds) this.raster = null; // empty mask = no selection
      }
    }
    this.version++;
  }
  clear(): void {
    this.setParts([]);
  }
  /** Same content (cheap identity check used to skip no-op history steps). */
  equals(s: SelState): boolean {
    return s.raster === this.raster && JSON.stringify(s.parts) === JSON.stringify(this.parts);
  }

  /** Union of "add" bounds (conservative), clipped to the document. */
  bounds(docW: number, docH: number): Rect | null {
    let r: Rect | null = this.rasterBounds ? { ...this.rasterBounds } : null;
    for (const p of this.parts) {
      if (p.mode !== 'add') continue;
      const b = shapeBounds(p.shape);
      r = r ? union(r, b) : b;
    }
    if (!r) return null;
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(docW, Math.ceil(r.x + r.w)), y1 = Math.min(docH, Math.ceil(r.y + r.h));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Document-sized mask: white with alpha = selection coverage. */
  mask(docW: number, docH: number): HTMLCanvasElement | null {
    if (!this.active) return null;
    if (this.raster && !this.parts.length && this.raster.width === docW && this.raster.height === docH) return this.raster;
    const key = `${this.version}:${docW}x${docH}`;
    if (this.maskCache && this.maskKey === key) return this.maskCache;
    const c = this.maskCache && this.maskCache.width === docW && this.maskCache.height === docH ? this.maskCache : createCanvas(docW, docH);
    const ctx = ctx2d(c);
    ctx.clearRect(0, 0, docW, docH);
    if (this.raster) ctx.drawImage(this.raster, 0, 0);
    ctx.fillStyle = '#fff';
    for (const p of this.parts) {
      ctx.globalCompositeOperation = p.mode === 'add' ? 'source-over' : 'destination-out';
      ctx.fill(shapePath(p.shape));
    }
    ctx.globalCompositeOperation = 'source-over';
    this.maskCache = c;
    this.maskKey = key;
    return c;
  }

  /** Paths for marching ants (pixel contour of the mask when a raster is involved). */
  outlines(docW = 0, docH = 0): Path2D[] {
    if (!this.raster) return this.parts.map((p) => shapePath(p.shape));
    const key = `${this.version}:${docW}x${docH}`;
    if (this.outlineCache?.key === key) return this.outlineCache.paths;
    const m = this.mask(docW || this.raster.width, docH || this.raster.height);
    const paths: Path2D[] = [];
    if (m) {
      const d = readPixels(m, 0, 0, m.width, m.height).data;
      const a = new Uint8ClampedArray(m.width * m.height);
      for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3]!;
      const segs = maskOutline(a, m.width, m.height);
      const p = new Path2D();
      for (let i = 0; i < segs.length; i += 4) {
        p.moveTo(segs[i]!, segs[i + 1]!);
        p.lineTo(segs[i + 2]!, segs[i + 3]!);
      }
      paths.push(p);
    }
    this.outlineCache = { key, paths };
    return paths;
  }

  /** Inverse within the document (exact for hard-edged parts; null when a raster is involved). */
  inverted(docW: number, docH: number): SelPart[] | null {
    if (this.raster) return null;
    const out: SelPart[] = [{ mode: 'add', shape: { type: 'rect', x: 0, y: 0, w: docW, h: docH } }];
    for (const p of this.parts) out.push({ mode: p.mode === 'add' ? 'sub' : 'add', shape: cloneShape(p.shape) });
    return out;
  }
}

function cloneShape(s: SelShape): SelShape {
  return s.type === 'poly' ? { type: 'poly', pts: s.pts.slice() } : { ...s };
}
function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
