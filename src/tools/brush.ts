import { createCanvas, ctx2d, disposeCanvas } from '../core/canvas';
import type { Layer } from '../core/document';
import { hexLuma, type Editor, type PaintTarget } from '../core/editor';
import type { Rect } from '../core/types';
import { rectUnion } from '../core/types';
import type { Viewport } from '../core/viewport';
import { checkbox, divider, slider, type SliderHandle } from '../ui/controls';
import { h } from '../ui/dom';
import { icons } from '../ui/icons';
import type { Tool, ToolPointer } from './tool';

export interface BrushSettings {
  size: number;
  hardness: number;
  opacity: number;
  flow: number;
  smoothing: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
}

/**
 * Brush & eraser. Dabs are stamped into a separate stroke canvas at full strength;
 * the stroke is shown live at the chosen opacity (no overlap build-up, like Photoshop)
 * and merged into the layer on pointer-up as a single history step.
 */
export class BrushTool implements Tool {
  id: string;
  label: string;
  key: string;
  icon: string;
  settings: BrushSettings = { size: 24, hardness: 0.8, opacity: 1, flow: 1, smoothing: 0.35, pressureSize: true, pressureOpacity: false };
  protected layer: Layer | null = null;
  protected stroke: HTMLCanvasElement | null = null;
  protected sctx: CanvasRenderingContext2D | null = null;
  protected bounds: Rect | null = null;
  protected last: { x: number; y: number; p: number } | null = null;
  private smooth: { x: number; y: number } | null = null;
  private residual = 0;
  private stamp: HTMLCanvasElement | null = null;
  private stampKey = '';
  protected cursorPos: { sx: number; sy: number } | null = null;
  private sizeHandle: SliderHandle | null = null;
  /** Target of the stroke in progress. */
  protected target: PaintTarget = 'pixels';
  /** Stroke erases (eraser, or black paint on a mask). */
  protected erasing = false;

  constructor(
    protected ed: Editor,
    readonly erase: boolean,
  ) {
    this.id = erase ? 'eraser' : 'brush';
    this.label = erase ? 'Ластик' : 'Кисть';
    this.key = erase ? 'e' : 'b';
    this.icon = erase ? icons.eraser : icons.brush;
    if (erase) this.settings.hardness = 0.9;
  }

  /** What the stroke may paint on: 'paint' allows masks, 'pixels' needs layer pixels. */
  protected purpose: 'paint' | 'pixels' = 'paint';
  /** Colour stamped into the stroke canvas. */
  protected strokeColor(): string {
    return this.erasing || this.target === 'mask' ? '#ffffff' : this.ed.fg;
  }
  /** Opacity the live stroke is shown with. */
  protected liveOpacity(): number {
    return this.settings.opacity;
  }
  /** Hook for subclasses before the first dab; return false to abort. */
  protected beginStroke(_p: ToolPointer): boolean {
    return true;
  }

  get active(): boolean {
    return !!this.stroke;
  }

  cursor(): string {
    return this.ed.view.zoom * this.settings.size >= 6 ? 'none' : 'crosshair';
  }

  setSize(v: number): void {
    this.settings.size = Math.max(1, Math.min(1000, Math.round(v)));
    this.sizeHandle?.set(this.settings.size);
    this.ed.renderer?.markView();
  }

  protected getStamp(color: string): HTMLCanvasElement {
    const d = Math.max(2, Math.min(512, Math.ceil(this.settings.size)));
    const key = `${d}|${this.settings.hardness}|${color}`;
    if (this.stamp && this.stampKey === key) return this.stamp;
    disposeCanvas(this.stamp);
    const c = createCanvas(d, d);
    const x = ctx2d(c);
    const r = d / 2;
    const hard = Math.max(0, Math.min(0.999, this.settings.hardness));
    const g = x.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, color);
    g.addColorStop(hard, color);
    // smooth fall-off: a few extra stops approximate a gaussian edge
    const rgb = color;
    g.addColorStop(hard + (1 - hard) * 0.5, hexAlpha(rgb, 0.5));
    g.addColorStop(1, hexAlpha(rgb, 0));
    x.fillStyle = g;
    x.beginPath();
    x.arc(r, r, r, 0, Math.PI * 2);
    x.fill();
    this.stamp = c;
    this.stampKey = key;
    return c;
  }

  down(p: ToolPointer): void {
    if (p.alt && !this.erase) {
      const c = this.ed.sampleColor(p.x, p.y);
      if (c) this.ed.setColor('fg', c);
      return;
    }
    const layer = this.ed.editableLayer(true, this.purpose);
    if (!layer) return;
    this.target = this.purpose === 'paint' ? this.ed.paintTarget(layer) : 'pixels';
    this.erasing = this.target === 'mask' ? this.erase || hexLuma(this.ed.fg) < 128 : this.erase;
    this.layer = layer;
    if (!this.beginStroke(p)) {
      this.layer = null;
      return;
    }
    const tc = this.target === 'mask' ? layer.mask! : layer.canvas;
    this.stroke = createCanvas(tc.width, tc.height);
    this.sctx = ctx2d(this.stroke);
    this.bounds = null;
    this.residual = 0;
    layer.live = { canvas: this.stroke, opacity: this.liveOpacity(), erase: this.erasing, mask: this.target === 'mask' };
    const lx = p.x - layer.meta.x, ly = p.y - layer.meta.y;
    this.smooth = { x: lx, y: ly };
    this.last = { x: lx, y: ly, p: this.pressure(p) };
    this.dab(lx, ly, this.last.p);
    this.flush();
  }

  private pressure(p: ToolPointer): number {
    // mouse reports 0.5 while pressed; treat as full pressure
    return p.pointerType === 'mouse' ? 1 : Math.max(0.05, p.pressure || 0.5);
  }

  move(p: ToolPointer): void {
    this.cursorPos = { sx: p.sx, sy: p.sy };
    if (!this.stroke || !this.layer || !this.last || !this.smooth) {
      this.ed.renderer?.markView();
      return;
    }
    const lx = p.x - this.layer.meta.x, ly = p.y - this.layer.meta.y;
    // exponential smoothing (lazy brush); stronger smoothing = more lag, steadier line
    const k = 1 - Math.min(0.92, this.settings.smoothing);
    this.smooth.x += (lx - this.smooth.x) * k;
    this.smooth.y += (ly - this.smooth.y) * k;
    if (p.shift) {
      this.smooth.x = lx;
      this.smooth.y = ly;
    }
    this.segmentTo(this.smooth.x, this.smooth.y, this.pressure(p));
    this.flush();
  }

  private segmentTo(x: number, y: number, pr: number): void {
    const last = this.last!;
    const dx = x - last.x, dy = y - last.y;
    const dist = Math.hypot(dx, dy);
    const spacing = Math.max(0.5, this.settings.size * (this.settings.pressureSize ? Math.min(last.p, pr) : 1) * 0.12);
    let t = spacing - this.residual;
    while (t <= dist) {
      const f = t / dist;
      this.dab(last.x + dx * f, last.y + dy * f, last.p + (pr - last.p) * f);
      t += spacing;
    }
    this.residual = dist - (t - spacing);
    this.last = { x, y, p: pr };
  }

  protected dabSize(pr: number): number {
    const s = this.settings;
    return Math.max(1, s.size * (s.pressureSize ? 0.15 + 0.85 * pr : 1));
  }

  protected dab(x: number, y: number, pr: number): void {
    const s = this.settings;
    const size = this.dabSize(pr);
    const r = size / 2;
    const ctx = this.sctx!;
    ctx.globalAlpha = Math.max(0.01, s.flow * (s.pressureOpacity ? pr : 1));
    ctx.drawImage(this.getStamp(this.strokeColor()), x - r, y - r, size, size);
    this.markDab(x, y, size);
  }

  protected markDab(x: number, y: number, size: number): void {
    const r = size / 2;
    const b = { x: Math.floor(x - r - 1), y: Math.floor(y - r - 1), w: Math.ceil(size + 3), h: Math.ceil(size + 3) };
    this.bounds = rectUnion(this.bounds, b);
    this.pendingDirty = rectUnion(this.pendingDirty, b);
  }

  private pendingDirty: Rect | null = null;
  private flush(): void {
    if (!this.pendingDirty || !this.layer) return;
    const r = this.pendingDirty;
    this.ed.redraw({ x: r.x + this.layer.meta.x, y: r.y + this.layer.meta.y, w: r.w, h: r.h });
    this.pendingDirty = null;
  }

  up(p: ToolPointer): void {
    if (!this.stroke || !this.layer) return;
    if (this.last && this.smooth) {
      // finish the smoothed line at the real pointer position
      const lx = p.x - this.layer.meta.x, ly = p.y - this.layer.meta.y;
      if (Math.hypot(lx - this.last.x, ly - this.last.y) > 0.5) this.segmentTo(lx, ly, this.last.p);
    }
    const layer = this.layer;
    const stroke = this.stroke;
    const bounds = this.bounds;
    const mask = this.ed.layerMask(layer);
    const target = this.target;
    this.reset();
    layer.live = null;
    if (mask) {
      const sc = ctx2d(stroke);
      sc.globalAlpha = 1;
      sc.globalCompositeOperation = 'destination-in';
      sc.drawImage(mask, 0, 0);
    }
    try {
      this.commitStroke(layer, stroke, bounds, target);
    } finally {
      disposeCanvas(stroke);
      disposeCanvas(mask);
    }
  }

  /** Merges the finished stroke (already clipped to the selection) into the target. */
  protected commitStroke(layer: Layer, stroke: HTMLCanvasElement, bounds: Rect | null, target: PaintTarget): void {
    const opacity = this.settings.opacity;
    const erasing = this.erasing;
    const label = target === 'mask' ? 'Кисть по маске' : this.erase ? 'Ластик' : 'Кисть';
    this.ed.pixelEdit(layer, bounds, label, (ctx) => {
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
      ctx.drawImage(stroke, 0, 0);
    }, target);
    if (!this.erase && target === 'pixels') this.ed.pushRecent(this.ed.fg);
  }

  cancel(): void {
    if (!this.stroke) return;
    if (this.layer) this.layer.live = null;
    disposeCanvas(this.stroke);
    this.reset();
    this.ed.redraw();
  }

  protected reset(): void {
    this.stroke = null;
    this.sctx = null;
    this.layer = null;
    this.last = null;
    this.smooth = null;
    this.bounds = null;
    this.pendingDirty = null;
  }

  hover(p: ToolPointer): void {
    this.cursorPos = { sx: p.sx, sy: p.sy };
    this.ed.renderer?.markView();
  }
  deactivate(): void {
    this.cursorPos = null;
  }

  overlay(ctx: CanvasRenderingContext2D, view: Viewport): void {
    if (!this.cursorPos) return;
    const r = (this.settings.size * view.zoom) / 2;
    const { sx, sy } = this.cursorPos;
    if (r < 3) return;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.stroke();
    ctx.lineWidth = 0.75;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    if (this.settings.hardness < 0.95 && r > 8) {
      ctx.beginPath();
      ctx.setLineDash([2, 3]);
      ctx.arc(sx, sy, r * Math.max(0.05, this.settings.hardness), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(sx - 0.5, sy - 0.5, 1, 1);
  }

  /** Mouse left the canvas: hide the size ring. */
  leave(): void {
    this.cursorPos = null;
    this.ed.renderer?.markView();
  }

  /** Extra controls placed before the common brush controls. */
  protected extraOptions(): (HTMLElement | string)[] {
    return [];
  }

  options(): HTMLElement {
    const s = this.settings;
    this.sizeHandle = slider({ label: 'Размер', min: 1, max: 1000, step: 1, value: s.size, unit: 'px', compact: true, tip: 'Размер кисти — [ и ]', onInput: (v) => this.setSize(v) });
    return h(
      'div',
      { class: 'opts' },
      ...this.extraOptions(),
      this.ed.paintTarget() === 'mask' && this.purpose === 'paint' ? h('span', { class: 'badge', 'data-tip': 'Белый — показать, чёрный — скрыть' }, 'Маска') : '',
      this.sizeHandle.el,
      slider({ label: 'Жёсткость', min: 0, max: 100, step: 1, value: Math.round(s.hardness * 100), unit: '%', compact: true, onInput: (v) => (s.hardness = v / 100) }).el,
      slider({ label: 'Непрозр.', min: 1, max: 100, step: 1, value: Math.round(s.opacity * 100), unit: '%', compact: true, tip: 'Непрозрачность мазка', onInput: (v) => (s.opacity = v / 100) }).el,
      slider({ label: 'Поток', min: 1, max: 100, step: 1, value: Math.round(s.flow * 100), unit: '%', compact: true, tip: 'Плотность (поток) отпечатков', onInput: (v) => (s.flow = v / 100) }).el,
      slider({ label: 'Сглаж.', min: 0, max: 90, step: 1, value: Math.round(s.smoothing * 100), unit: '%', compact: true, tip: 'Сглаживание линии', onInput: (v) => (s.smoothing = v / 100) }).el,
      divider(),
      checkbox('Размер от нажима', s.pressureSize, (v) => (s.pressureSize = v), 'Перо/стилус: сила нажатия меняет размер'),
      checkbox('Прозрачность от нажима', s.pressureOpacity, (v) => (s.pressureOpacity = v)),
    );
  }
}

function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
