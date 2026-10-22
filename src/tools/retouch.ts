import { createCanvas, ctx2d, disposeCanvas, readPixels } from '../core/canvas';
import type { Layer } from '../core/document';
import { hexLuma, type Editor, type PaintTarget } from '../core/editor';
import { inpaint } from '../core/inpaint';
import { compositeDoc } from '../core/render';
import type { Rect } from '../core/types';
import { rectClip } from '../core/types';
import type { Viewport } from '../core/viewport';
import { checkbox, segmented, slider } from '../ui/controls';
import { h } from '../ui/dom';
import { icons } from '../ui/icons';
import { BrushTool } from './brush';
import { label } from './selection';
import type { Tool, ToolPointer } from './tool';

/* ------------------------------------------------------------------ Clone stamp */

/**
 * Clone stamp: Alt+click sets the source point, then strokes copy pixels from the source
 * at the same offset. The source is snapshotted at stroke start (no feedback loops).
 */
export class CloneTool extends BrushTool {
  aligned = true;
  sampleAll = false;
  private source: { x: number; y: number } | null = null;
  private offset: { x: number; y: number } | null = null;
  private sample: HTMLCanvasElement | null = null;
  private dabCanvas: HTMLCanvasElement | null = null;
  private curDoc: { x: number; y: number } | null = null;

  constructor(ed: Editor) {
    super(ed, false);
    this.id = 'clone';
    this.label = 'Штамп';
    this.key = 's';
    this.icon = icons.stamp;
    this.purpose = 'pixels';
    this.settings.hardness = 0.6;
    this.settings.pressureSize = false;
  }

  protected strokeColor(): string {
    return '#000000';
  }

  down(p: ToolPointer): void {
    if (p.alt) {
      this.source = { x: p.x, y: p.y };
      this.offset = null;
      this.ed.ui.toast('Источник штампа задан', 'info');
      this.ed.renderer?.markView();
      return;
    }
    super.down({ ...p, alt: false });
  }

  protected beginStroke(p: ToolPointer): boolean {
    if (!this.source) {
      this.ed.ui.toast('Сначала Alt+щелчок — задайте источник', 'warn');
      return false;
    }
    if (!this.offset || !this.aligned) this.offset = { x: this.source.x - p.x, y: this.source.y - p.y };
    const W = this.ed.doc.width, H = this.ed.doc.height;
    const c = createCanvas(W, H);
    const cx = ctx2d(c);
    if (this.sampleAll) compositeDoc(this.ed.doc, cx, { committedOnly: true });
    else cx.drawImage(this.layer!.canvas, this.layer!.meta.x, this.layer!.meta.y);
    disposeCanvas(this.sample);
    this.sample = c;
    this.curDoc = { x: p.x, y: p.y };
    return true;
  }

  protected dab(x: number, y: number, pr: number): void {
    const layer = this.layer!, off = this.offset!, sample = this.sample!;
    const size = this.dabSize(pr);
    const d = Math.max(2, Math.ceil(size));
    const r = size / 2;
    if (!this.dabCanvas) this.dabCanvas = createCanvas(d, d);
    const t = this.dabCanvas;
    if (t.width !== d || t.height !== d) {
      t.width = d;
      t.height = d;
    }
    const tc = ctx2d(t);
    tc.globalCompositeOperation = 'copy';
    const sx = x + layer.meta.x + off.x - r, sy = y + layer.meta.y + off.y - r;
    tc.drawImage(sample, sx, sy, size, size, 0, 0, d, d);
    tc.globalCompositeOperation = 'destination-in';
    tc.drawImage(this.getStamp('#000000'), 0, 0, d, d);
    tc.globalCompositeOperation = 'source-over';
    const ctx = this.sctx!;
    ctx.globalAlpha = Math.max(0.01, this.settings.flow);
    ctx.drawImage(t, x - r, y - r, size, size);
    this.curDoc = { x: x + layer.meta.x, y: y + layer.meta.y };
    this.markDab(x, y, size);
  }

  protected commitStroke(layer: Layer, stroke: HTMLCanvasElement, bounds: Rect | null, target: PaintTarget): void {
    const opacity = this.settings.opacity;
    this.ed.pixelEdit(layer, bounds, 'Штамп', (ctx) => {
      ctx.globalAlpha = opacity;
      ctx.drawImage(stroke, 0, 0);
    }, target);
    disposeCanvas(this.sample);
    this.sample = null;
    if (!this.aligned) this.offset = null;
  }

  cancel(): void {
    super.cancel();
    disposeCanvas(this.sample);
    this.sample = null;
  }

  overlay(ctx: CanvasRenderingContext2D, view: Viewport): void {
    super.overlay(ctx, view);
    let src: { x: number; y: number } | null = null;
    if (this.stroke && this.offset && this.curDoc) src = { x: this.curDoc.x + this.offset.x, y: this.curDoc.y + this.offset.y };
    else if (this.source && (!this.offset || !this.aligned)) src = this.source;
    if (!src) return;
    const s = view.toScreen(src.x, src.y);
    ctx.lineWidth = 1.5;
    for (const [col, w] of [['rgba(0,0,0,.6)', 2.5], ['#fff', 1]] as const) {
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(s.x - 8, s.y);
      ctx.lineTo(s.x + 8, s.y);
      ctx.moveTo(s.x, s.y - 8);
      ctx.lineTo(s.x, s.y + 8);
      ctx.stroke();
    }
  }

  protected extraOptions(): (HTMLElement | string)[] {
    return [
      checkbox('Выравнивание', this.aligned, (v) => {
        this.aligned = v;
        this.offset = null;
      }, 'Источник движется вместе с кистью между мазками'),
      checkbox('Все слои', this.sampleAll, (v) => (this.sampleAll = v), 'Брать образец со всех видимых слоёв'),
      h('span', { class: 'hint' }, this.source ? 'Alt+щелчок — новый источник' : 'Alt+щелчок — задать источник'),
    ];
  }
}

/* ------------------------------------------------------------------ Spot healing (lite) */

/** Paint over a blemish; on release the area is rebuilt from its surroundings. */
export class HealTool extends BrushTool {
  constructor(ed: Editor) {
    super(ed, false);
    this.id = 'heal';
    this.label = 'Точечное восстановление';
    this.key = 'j';
    this.icon = icons.heal;
    this.purpose = 'pixels';
    this.settings.hardness = 0.5;
    this.settings.pressureSize = false;
  }
  protected strokeColor(): string {
    return '#000000';
  }
  protected liveOpacity(): number {
    return 0.45;
  }

  protected commitStroke(layer: Layer, stroke: HTMLCanvasElement, bounds: Rect | null): void {
    if (!bounds) return;
    const margin = Math.ceil(this.settings.size * 1.5) + 4;
    const r = rectClip({ x: bounds.x - margin, y: bounds.y - margin, w: bounds.w + margin * 2, h: bounds.h + margin * 2 }, layer.width, layer.height);
    if (!r) return;
    const img = readPixels(layer.canvas, r.x, r.y, r.w, r.h);
    const sd = readPixels(stroke, r.x, r.y, r.w, r.h).data;
    const hole = new Uint8ClampedArray(r.w * r.h);
    let any = false;
    for (let i = 0; i < hole.length; i++) {
      hole[i] = sd[i * 4 + 3]!;
      if (hole[i]) any = true;
    }
    if (!any) return;
    inpaint(img, hole);
    const out = createCanvas(r.w, r.h);
    ctx2d(out).putImageData(img, 0, 0);
    this.ed.pixelEdit(layer, r, 'Точечное восстановление', (ctx) => {
      ctx.clearRect(r.x, r.y, r.w, r.h);
      ctx.drawImage(out, r.x, r.y);
    });
    disposeCanvas(out);
  }

  protected extraOptions(): (HTMLElement | string)[] {
    return [h('span', { class: 'hint' }, 'Закрасьте дефект — область восстановится по окружению')];
  }
}

/* ------------------------------------------------------------------ Gradient */

type GradKind = 'linear' | 'radial';

/** Drag to draw a linear or radial gradient (main → background colour, or → transparent). */
export class GradientTool implements Tool {
  readonly id = 'gradient';
  readonly label = 'Градиент';
  readonly key = 'g';
  readonly icon = icons.gradient;
  kind: GradKind = 'linear';
  toTransparent = false;
  opacity = 1;
  private a: { x: number; y: number } | null = null;
  private b: { x: number; y: number } | null = null;
  private layer: Layer | null = null;
  private target: PaintTarget = 'pixels';
  private live: HTMLCanvasElement | null = null;
  /** Selection mask in layer coords for this drag (false = none). */
  private sel: HTMLCanvasElement | false | null = null;
  constructor(private ed: Editor) {}
  get active(): boolean {
    return !!this.a;
  }
  cursor(): string {
    return 'crosshair';
  }

  /** Paints the gradient over a canvas in layer coordinates. */
  private paint(ctx: CanvasRenderingContext2D, layer: Layer, target: PaintTarget): void {
    const a = this.a!, b = this.b!;
    const ax = a.x - layer.meta.x, ay = a.y - layer.meta.y, bx = b.x - layer.meta.x, by = b.y - layer.meta.y;
    const g =
      this.kind === 'linear'
        ? ctx.createLinearGradient(ax, ay, bx, by)
        : ctx.createRadialGradient(ax, ay, 0, ax, ay, Math.max(0.5, Math.hypot(bx - ax, by - ay)));
    if (target === 'mask') {
      // masks store visibility in alpha: luminance of fg/bg → alpha
      const l0 = hexLuma(this.ed.fg) / 255, l1 = this.toTransparent ? 0 : hexLuma(this.ed.bg) / 255;
      g.addColorStop(0, `rgba(255,255,255,${l0})`);
      g.addColorStop(1, `rgba(255,255,255,${l1})`);
    } else {
      g.addColorStop(0, this.ed.fg);
      g.addColorStop(1, this.toTransparent ? hexToRgba(this.ed.fg, 0) : this.ed.bg);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  down(p: ToolPointer): void {
    const layer = this.ed.editableLayer(true, 'paint');
    if (!layer) return;
    this.layer = layer;
    this.target = this.ed.paintTarget(layer);
    const pt = this.ed.snap(p.x, p.y);
    this.a = pt;
    this.b = { ...pt };
  }
  move(p: ToolPointer): void {
    if (!this.a || !this.layer) return;
    let x = p.x, y = p.y;
    if (p.shift) {
      const dx = x - this.a.x, dy = y - this.a.y;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      x = this.a.x + Math.cos(ang) * len;
      y = this.a.y + Math.sin(ang) * len;
    } else ({ x, y } = this.ed.snap(x, y));
    this.b = { x, y };
    const l = this.layer;
    const tc = this.target === 'mask' ? l.mask! : l.canvas;
    if (!this.live) this.live = createCanvas(tc.width, tc.height);
    const lc = ctx2d(this.live);
    lc.globalCompositeOperation = 'copy';
    lc.drawImage(tc, 0, 0);
    lc.globalCompositeOperation = 'source-over';
    if (!this.sel) this.sel = this.ed.layerMask(l) ?? false;
    this.compose(lc, l, this.target, this.sel || null);
    l.live = { canvas: this.live, opacity: 1, erase: false, mask: this.target === 'mask', replace: true };
    this.ed.redraw();
  }

  /** Draws the gradient onto `ctx` (target canvas, layer coords) the way it is committed. */
  private compose(ctx: CanvasRenderingContext2D, l: Layer, target: PaintTarget, sel: HTMLCanvasElement | null): void {
    const t = createCanvas(ctx.canvas.width, ctx.canvas.height);
    const tc = ctx2d(t);
    this.paint(tc, l, target);
    if (sel) {
      tc.globalCompositeOperation = 'destination-in';
      tc.drawImage(sel, 0, 0);
    }
    ctx.save();
    if (target === 'mask') {
      // replace mask values (inside the selection), blended by opacity
      ctx.globalAlpha = this.opacity;
      ctx.globalCompositeOperation = 'destination-out';
      if (sel) ctx.drawImage(sel, 0, 0);
      else ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = this.opacity;
    ctx.drawImage(t, 0, 0);
    ctx.restore();
    disposeCanvas(t);
  }

  up(): void {
    const a = this.a, b = this.b, l = this.layer;
    const live = this.live;
    const sel = this.sel || null;
    const target = this.target;
    this.reset();
    if (!a || !b || !l) return;
    try {
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1) return;
      this.a = a;
      this.b = b;
      this.ed.pixelEdit(l, this.ed.layerSelRect(l), 'Градиент', (ctx) => this.compose(ctx, l, target, sel), target);
      if (target === 'pixels') this.ed.pushRecent(this.ed.fg);
    } finally {
      this.a = this.b = null;
      disposeCanvas(sel);
      disposeCanvas(live);
      this.ed.redraw();
    }
  }
  private reset(): void {
    if (this.layer) this.layer.live = null;
    this.layer = null;
    this.a = this.b = null;
    this.live = null;
    this.sel = null;
  }
  cancel(): void {
    disposeCanvas(this.live);
    this.reset();
    this.ed.redraw();
  }
  overlay(ctx: CanvasRenderingContext2D, view: Viewport): void {
    if (!this.a || !this.b) return;
    const a = view.toScreen(this.a.x, this.a.y), b = view.toScreen(this.b.x, this.b.y);
    for (const [col, w] of [['rgba(0,0,0,.55)', 3], ['#fff', 1.25]] as const) {
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (const q of [a, b]) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    label(ctx, `${Math.round(Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y))} px`, b.x + 10, b.y + 10);
  }
  options(): HTMLElement {
    return h(
      'div',
      { class: 'opts' },
      segmented<GradKind>(
        [
          { id: 'linear', label: 'Линейный', tip: 'Линейный градиент' },
          { id: 'radial', label: 'Радиальный', tip: 'Радиальный градиент' },
        ],
        this.kind,
        (v) => (this.kind = v),
      ),
      checkbox('В прозрачность', this.toTransparent, (v) => (this.toTransparent = v), 'Основной цвет → прозрачный (иначе основной → фоновый)'),
      slider({ label: 'Непрозр.', min: 1, max: 100, step: 1, value: Math.round(this.opacity * 100), unit: '%', compact: true, onInput: (v) => (this.opacity = v / 100) }).el,
      h('span', { class: 'hint' }, 'Протяните по холсту · Shift — шаг 45° · на маске — плавный переход'),
    );
  }
}

function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
