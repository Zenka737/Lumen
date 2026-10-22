import { toCompositeOp } from './blend';
import { createCanvas, ctx2d, scratchCanvas } from './canvas';
import type { Doc, Layer, LiveStroke } from './document';
import type { Rect } from './types';
import { rectClip, rectUnion } from './types';
import type { Viewport } from './viewport';
import { FILTERS } from '../filters/filters';

/**
 * `base` with an in-progress stroke merged in (stroke clipped by the document selection).
 * `clip` (layer coords) limits work to a dirty region during painting.
 */
function withLive(base: HTMLCanvasElement, live: LiveStroke, layer: Layer, docMask: HTMLCanvasElement | null, clip: Rect | null, key: string): HTMLCanvasElement {
  if (live.replace) return live.canvas;
  const w = base.width, h = base.height;
  const r = clip ? rectClip(clip, w, h) : { x: 0, y: 0, w, h };
  if (!r) return base;
  const tmp = scratchCanvas(key, w, h);
  const stroke = scratchCanvas('stroke-masked', w, h);
  const tc = ctx2d(tmp);
  const sc = ctx2d(stroke);
  sc.save();
  sc.beginPath();
  sc.rect(r.x, r.y, r.w, r.h);
  sc.clip();
  sc.clearRect(r.x, r.y, r.w, r.h);
  sc.drawImage(live.canvas, 0, 0);
  if (docMask) {
    sc.globalCompositeOperation = 'destination-in';
    sc.drawImage(docMask, -layer.meta.x, -layer.meta.y);
  }
  sc.restore();
  tc.save();
  tc.beginPath();
  tc.rect(r.x, r.y, r.w, r.h);
  tc.clip();
  tc.clearRect(r.x, r.y, r.w, r.h);
  tc.drawImage(base, 0, 0);
  tc.globalAlpha = live.opacity;
  tc.globalCompositeOperation = live.erase ? 'destination-out' : 'source-over';
  tc.drawImage(stroke, 0, 0);
  tc.restore();
  return tmp;
}

/** The layer mask to apply (with a live mask stroke merged), or null. */
export function effectiveMask(layer: Layer, docMask: HTMLCanvasElement | null, clip: Rect | null, committedOnly: boolean): HTMLCanvasElement | null {
  if (!layer.mask || layer.meta.maskEnabled === false) return null;
  if (!committedOnly && layer.live?.mask) return withLive(layer.mask, layer.live, layer, docMask, clip, 'mask-live');
  return layer.mask;
}

/** Drawable source of a pixel layer (layer coords) with live stroke and mask resolved. */
function layerSource(layer: Layer, docMask: HTMLCanvasElement | null, clip: Rect | null, committedOnly: boolean): CanvasImageSource {
  const live = committedOnly ? null : layer.live;
  let src: HTMLCanvasElement = live && !live.mask ? withLive(layer.canvas, live, layer, docMask, clip, 'layer-live') : layer.canvas;
  if (!committedOnly && layer.preview) {
    const p = scratchCanvas('layer-preview', layer.width, layer.height);
    const pc = ctx2d(p);
    pc.clearRect(0, 0, p.width, p.height);
    pc.drawImage(layer.preview, 0, 0, layer.width, layer.height);
    src = p;
  }
  const m = effectiveMask(layer, docMask, clip, committedOnly);
  if (!m) return src;
  const w = src.width, h = src.height;
  const r = clip ? rectClip(clip, w, h) : { x: 0, y: 0, w, h };
  if (!r) return src;
  const tmp = scratchCanvas('layer-masked', w, h);
  const tc = ctx2d(tmp);
  tc.save();
  tc.beginPath();
  tc.rect(r.x, r.y, r.w, r.h);
  tc.clip();
  tc.clearRect(r.x, r.y, r.w, r.h);
  tc.drawImage(src, 0, 0);
  tc.globalCompositeOperation = 'destination-in';
  tc.drawImage(m, 0, 0);
  tc.restore();
  return tmp;
}

/** Applies an adjustment layer to `rc` (region canvas whose origin is document (rx, ry)). */
export function applyAdjustmentLayer(layer: Layer, rc: CanvasRenderingContext2D, rx: number, ry: number, rw: number, rh: number, mask: HTMLCanvasElement | null): void {
  const a = layer.meta.adjust;
  const def = a ? FILTERS[a.filterId] : undefined;
  if (!a || !def) return;
  const img = rc.getImageData(0, 0, rw, rh);
  const orig = mask || layer.meta.opacity < 1 ? new Uint8ClampedArray(img.data) : null;
  def.apply(img, a.params);
  if (orig) {
    const d = img.data;
    let md: Uint8ClampedArray | null = null;
    if (mask) {
      const mc = scratchCanvas('adj-mask', rw, rh);
      const mx = ctx2d(mc, { willReadFrequently: true });
      mx.clearRect(0, 0, rw, rh);
      mx.drawImage(mask, layer.meta.x - rx, layer.meta.y - ry);
      md = mx.getImageData(0, 0, rw, rh).data;
    }
    const op = layer.meta.opacity;
    for (let i = 0; i < d.length; i += 4) {
      const k = md ? (md[i + 3]! / 255) * op : op;
      if (k >= 1) continue;
      d[i] = orig[i]! + (d[i]! - orig[i]!) * k;
      d[i + 1] = orig[i + 1]! + (d[i + 1]! - orig[i + 1]!) * k;
      d[i + 2] = orig[i + 2]! + (d[i + 2]! - orig[i + 2]!) * k;
      d[i + 3] = orig[i + 3]!;
    }
  }
  rc.putImageData(img, 0, 0);
}

export interface CompositeOptions {
  /** Document-space region to recomposite. */
  clip?: Rect | null;
  /** Ignore previews, live strokes and transform previews (exports, eyedropper on committed pixels). */
  committedOnly?: boolean;
  /** Stop before this layer index (used to read "what is below" an adjustment). */
  until?: number;
}

function drawLayers(doc: Doc, ctx: CanvasRenderingContext2D, opts: CompositeOptions, region: Rect, adjust: ((l: Layer) => void) | null): void {
  const clip = opts.clip ?? null;
  const committed = !!opts.committedOnly;
  const docMask = doc.selection.active ? doc.selection.mask(doc.width, doc.height) : null;
  const n = Math.min(doc.layers.length, opts.until ?? doc.layers.length);
  for (let i = 0; i < n; i++) {
    const layer = doc.layers[i]!;
    if (!layer.meta.visible || layer.meta.opacity <= 0) continue;
    if (!committed && layer.editing) continue;
    if (layer.meta.kind === 'adjustment') {
      adjust?.(layer);
      continue;
    }
    ctx.globalAlpha = layer.meta.opacity;
    ctx.globalCompositeOperation = toCompositeOp(layer.meta.blend);
    if (!committed && layer.xform) {
      const x = layer.xform;
      const t = scratchCanvas('xform', region.w, region.h);
      const tc = ctx2d(t);
      tc.setTransform(1, 0, 0, 1, 0, 0);
      tc.clearRect(0, 0, region.w, region.h);
      tc.translate(-region.x, -region.y);
      if (x.base) tc.drawImage(x.base, layer.meta.x, layer.meta.y);
      tc.save();
      tc.transform(...x.m);
      tc.imageSmoothingQuality = 'high';
      tc.drawImage(x.float, 0, 0);
      tc.restore();
      const m = x.maskAfter ? effectiveMask(layer, null, null, true) : null;
      if (m) {
        tc.globalCompositeOperation = 'destination-in';
        tc.drawImage(m, layer.meta.x, layer.meta.y);
        tc.globalCompositeOperation = 'source-over';
      }
      tc.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(t, region.x, region.y);
      continue;
    }
    const lclip = clip ? { x: clip.x - layer.meta.x, y: clip.y - layer.meta.y, w: clip.w, h: clip.h } : null;
    ctx.drawImage(layerSource(layer, docMask, lclip, committed), layer.meta.x, layer.meta.y);
  }
}

function hasAdjustments(doc: Doc, until: number): boolean {
  for (let i = 0; i < Math.min(until, doc.layers.length); i++) {
    const l = doc.layers[i]!;
    if (l.meta.kind === 'adjustment' && l.meta.visible && l.meta.opacity > 0) return true;
  }
  return false;
}

/** Composites all visible layers (bottom→top) into ctx (document space). */
export function compositeDoc(doc: Doc, ctx: CanvasRenderingContext2D, opts: CompositeOptions = {}): void {
  const clip = opts.clip ?? null;
  const region: Rect = clip ? rectClip(clip, doc.width, doc.height) ?? { x: 0, y: 0, w: 1, h: 1 } : { x: 0, y: 0, w: doc.width, h: doc.height };
  ctx.save();
  if (clip) {
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    ctx.clearRect(clip.x, clip.y, clip.w, clip.h);
  } else ctx.clearRect(0, 0, doc.width, doc.height);
  if (!hasAdjustments(doc, opts.until ?? doc.layers.length)) {
    drawLayers(doc, ctx, opts, region, null);
    ctx.restore();
    return;
  }
  // Adjustment layers need the pixels below them: composite into a region buffer.
  const buf = createCanvas(region.w, region.h);
  const bc = ctx2d(buf, { willReadFrequently: true });
  bc.translate(-region.x, -region.y);
  drawLayers(doc, bc, opts, region, (l) => {
    bc.save();
    bc.setTransform(1, 0, 0, 1, 0, 0);
    bc.globalAlpha = 1;
    bc.globalCompositeOperation = 'source-over';
    const m = effectiveMask(l, doc.selection.active ? doc.selection.mask(doc.width, doc.height) : null, clip ? { x: clip.x - l.meta.x, y: clip.y - l.meta.y, w: clip.w, h: clip.h } : null, !!opts.committedOnly);
    applyAdjustmentLayer(l, bc, region.x, region.y, region.w, region.h, m);
    bc.restore();
  });
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(buf, region.x, region.y);
  buf.width = buf.height = 1;
  ctx.restore();
}

/** Flattened copy of the committed document. */
export function flattenToCanvas(doc: Doc): HTMLCanvasElement {
  const c = createCanvas(doc.width, doc.height);
  compositeDoc(doc, ctx2d(c), { committedOnly: true });
  return c;
}

export interface OverlayPainter {
  (ctx: CanvasRenderingContext2D, view: Viewport): void;
}

/**
 * requestAnimationFrame render loop with dirty flags: the document composite is only
 * rebuilt when pixels/structure change (optionally just a dirty rect), and the view is
 * only repainted when something visible changed.
 */
export class Renderer {
  readonly composite: HTMLCanvasElement;
  private cctx: CanvasRenderingContext2D;
  private ctx: CanvasRenderingContext2D;
  private docDirty = true;
  private dirtyRect: Rect | null = null;
  private viewDirty = true;
  private raf = 0;
  private dpr = 1;
  private antsPhase = 0;
  private lastAnts = 0;
  private checker: CanvasPattern | null = null;
  private colors = { bg: '#1b1c1f', grid: 'rgba(128,128,128,0.35)', checkA: '#ffffff', checkB: '#d9d9d9', shadow: 'rgba(0,0,0,0.45)' };
  overlays: OverlayPainter[] = [];
  showPixelGrid = true;
  showGuides = true;
  /** Index of the guide under the pointer (highlighted). */
  hotGuide = -1;
  onFrame: (() => void) | null = null;

  constructor(
    private doc: () => Doc,
    private view: Viewport,
    readonly canvas: HTMLCanvasElement,
  ) {
    this.composite = createCanvas(1, 1);
    this.cctx = ctx2d(this.composite);
    this.ctx = ctx2d(canvas, { alpha: false });
    this.readTheme();
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      this.tick(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
  }

  /** Re-reads CSS custom properties (call on theme switch). */
  readTheme(): void {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
    this.colors = {
      bg: v('--canvas-bg', '#1b1c1f'),
      grid: v('--pixel-grid', 'rgba(128,128,128,0.35)'),
      checkA: v('--checker-a', '#ffffff'),
      checkB: v('--checker-b', '#d9d9d9'),
      shadow: v('--canvas-shadow', 'rgba(0,0,0,0.45)'),
    };
    this.checker = null;
    this.markView();
  }

  markDoc(rect?: Rect | null): void {
    if (rect === undefined || rect === null) {
      this.dirtyRect = null;
      this.docDirty = true;
    } else if (!this.docDirty || this.dirtyRect) {
      this.dirtyRect = this.docDirty ? rectUnion(this.dirtyRect, rect) : rect;
      this.docDirty = true;
    }
    this.viewDirty = true;
  }
  markView(): void {
    this.viewDirty = true;
  }

  resize(cssW: number, cssH: number): void {
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(cssW * this.dpr));
    const h = Math.max(1, Math.round(cssH * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.view.width = cssW;
    this.view.height = cssH;
    this.markView();
    this.tick(performance.now(), true);
  }

  private tick(t: number, force = false): void {
    const doc = this.doc();
    if (doc.selection.active && t - this.lastAnts > 90) {
      this.lastAnts = t;
      this.antsPhase = (this.antsPhase + 1) % 16;
      this.viewDirty = true;
    }
    if (!this.viewDirty && !this.docDirty && !force) return;
    try {
      this.render(doc);
    } catch (err) {
      console.error('[Lumen] render failed', err);
    }
    this.onFrame?.();
  }

  private ensureComposite(doc: Doc): void {
    if (this.composite.width !== doc.width || this.composite.height !== doc.height) {
      this.composite.width = doc.width;
      this.composite.height = doc.height;
      this.dirtyRect = null;
      this.docDirty = true;
    }
    if (!this.docDirty) return;
    const clip = this.dirtyRect ? rectClip(this.dirtyRect, doc.width, doc.height) : null;
    if (this.dirtyRect && !clip) {
      this.docDirty = false;
      this.dirtyRect = null;
      return;
    }
    compositeDoc(doc, this.cctx, { clip });
    this.docDirty = false;
    this.dirtyRect = null;
  }

  private checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    if (this.checker) return this.checker;
    const s = Math.round(8 * this.dpr);
    const c = createCanvas(s * 2, s * 2);
    const x = ctx2d(c);
    x.fillStyle = this.colors.checkA;
    x.fillRect(0, 0, s * 2, s * 2);
    x.fillStyle = this.colors.checkB;
    x.fillRect(0, 0, s, s);
    x.fillRect(s, s, s, s);
    this.checker = ctx.createPattern(c, 'repeat');
    return this.checker;
  }

  private render(doc: Doc): void {
    this.ensureComposite(doc);
    this.viewDirty = false;
    const ctx = this.ctx;
    const { zoom, panX, panY } = this.view;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // document rect in device pixels
    const dx = panX * dpr, dy = panY * dpr, dw = doc.width * zoom * dpr, dh = doc.height * zoom * dpr;
    ctx.save();
    ctx.shadowColor = this.colors.shadow;
    ctx.shadowBlur = 24 * dpr;
    ctx.shadowOffsetY = 4 * dpr;
    ctx.fillStyle = this.colors.checkA;
    ctx.fillRect(dx, dy, dw, dh);
    ctx.restore();
    const pat = this.checkerPattern(ctx);
    if (pat) {
      ctx.fillStyle = pat;
      ctx.fillRect(dx, dy, dw, dh);
    }
    ctx.imageSmoothingEnabled = zoom < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, dx, dy);
    ctx.drawImage(this.composite, 0, 0);

    // pixel grid at high zoom (only visible region)
    if (this.showPixelGrid && zoom >= 10) {
      const x0 = Math.max(0, Math.floor(-panX / zoom)), y0 = Math.max(0, Math.floor(-panY / zoom));
      const x1 = Math.min(doc.width, Math.ceil((this.view.width - panX) / zoom));
      const y1 = Math.min(doc.height, Math.ceil((this.view.height - panY) / zoom));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        const sx = Math.round(dx + x * zoom * dpr) + 0.5;
        ctx.moveTo(sx, dy + y0 * zoom * dpr);
        ctx.lineTo(sx, dy + y1 * zoom * dpr);
      }
      for (let y = y0; y <= y1; y++) {
        const sy = Math.round(dy + y * zoom * dpr) + 0.5;
        ctx.moveTo(dx + x0 * zoom * dpr, sy);
        ctx.lineTo(dx + x1 * zoom * dpr, sy);
      }
      ctx.strokeStyle = this.colors.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // marching ants
    if (doc.selection.active) {
      ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, dx, dy);
      const lw = 1 / zoom;
      ctx.lineWidth = lw;
      for (const p of doc.selection.outlines(doc.width, doc.height)) {
        ctx.setLineDash([]);
        ctx.strokeStyle = '#ffffff';
        ctx.stroke(p);
        ctx.setLineDash([4 / zoom, 4 / zoom]);
        ctx.lineDashOffset = -this.antsPhase / zoom / 2;
        ctx.strokeStyle = '#000000';
        ctx.stroke(p);
      }
      ctx.setLineDash([]);
    }

    // tool overlays in CSS px
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.showGuides && doc.guides.length) {
      doc.guides.forEach((g, i) => {
        ctx.beginPath();
        if (g.axis === 'v') {
          const x = Math.round(panX + g.pos * zoom) + 0.5;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, this.view.height);
        } else {
          const y = Math.round(panY + g.pos * zoom) + 0.5;
          ctx.moveTo(0, y);
          ctx.lineTo(this.view.width, y);
        }
        ctx.lineWidth = 1;
        ctx.strokeStyle = i === this.hotGuide ? '#ff3df2' : '#22d3ee';
        ctx.stroke();
      });
    }
    for (const o of this.overlays) {
      ctx.save();
      try {
        o(ctx, this.view);
      } finally {
        ctx.restore();
      }
    }
  }
}
