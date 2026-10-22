import { createCanvas, ctx2d, disposeCanvas, readPixels } from '../core/canvas';
import { hexToRgb } from '../core/color';
import type { Layer } from '../core/document';
import type { Editor } from '../core/editor';
import { applyFill, floodMask } from '../core/floodfill';
import type { Viewport } from '../core/viewport';
import { checkbox, select, slider } from '../ui/controls';
import { h } from '../ui/dom';
import { icons } from '../ui/icons';
import type { Tool, ToolPointer } from './tool';

/* ------------------------------------------------------------------ Move */

export class MoveTool implements Tool {
  readonly id = 'move';
  readonly label = 'Перемещение';
  readonly key = 'v';
  readonly icon = icons.move;
  autoSelect = false;
  private drag: { layer: Layer; sx: number; sy: number; ox: number; oy: number } | null = null;
  constructor(private ed: Editor) {}
  get active(): boolean {
    return !!this.drag;
  }
  cursor(): string {
    return 'move';
  }

  /** Topmost visible layer with a non-transparent pixel under the point. */
  private pick(x: number, y: number): Layer | null {
    const ls = this.ed.doc.layers;
    for (let i = ls.length - 1; i >= 0; i--) {
      const l = ls[i]!;
      if (!l.meta.visible || l.meta.kind === 'adjustment') continue;
      const lx = Math.floor(x - l.meta.x), ly = Math.floor(y - l.meta.y);
      if (lx < 0 || ly < 0 || lx >= l.width || ly >= l.height) continue;
      if (readPixels(l.canvas, lx, ly, 1, 1).data[3]! > 8) return l;
    }
    return null;
  }

  down(p: ToolPointer): void {
    if (this.autoSelect || p.mod) {
      const hit = this.pick(p.x, p.y);
      if (hit) this.ed.selectLayer(hit.meta.id);
    }
    const layer = this.ed.editableLayer(false);
    if (!layer) return;
    this.drag = { layer, sx: p.x, sy: p.y, ox: layer.meta.x, oy: layer.meta.y };
  }
  move(p: ToolPointer): void {
    const d = this.drag;
    if (!d) return;
    let dx = p.x - d.sx, dy = p.y - d.sy;
    if (p.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
    const sn = this.ed.snapRect({ x: d.ox + dx, y: d.oy + dy, w: d.layer.width, h: d.layer.height });
    d.layer.meta.x = Math.round(d.ox + dx + (p.shift && dx === 0 ? 0 : sn.dx));
    d.layer.meta.y = Math.round(d.oy + dy + (p.shift && dy === 0 ? 0 : sn.dy));
    this.ed.redraw();
  }
  up(): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const nx = d.layer.meta.x, ny = d.layer.meta.y;
    d.layer.meta.x = d.ox;
    d.layer.meta.y = d.oy;
    this.ed.setLayerMeta(d.layer.meta.id, { x: nx, y: ny }, 'Перемещение');
  }
  cancel(): void {
    if (!this.drag) return;
    this.drag.layer.meta.x = this.drag.ox;
    this.drag.layer.meta.y = this.drag.oy;
    this.drag = null;
    this.ed.redraw();
  }
  keydown(e: KeyboardEvent): boolean {
    const step = e.shiftKey ? 10 : 1;
    const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const v = map[e.key];
    if (!v) return false;
    const l = this.ed.editableLayer(false);
    if (l) this.ed.setLayerMeta(l.meta.id, { x: l.meta.x + v[0], y: l.meta.y + v[1] }, 'Сдвиг', true);
    return true;
  }
  options(): HTMLElement {
    return h(
      'div',
      { class: 'opts' },
      checkbox('Автовыбор слоя', this.autoSelect, (v) => (this.autoSelect = v), 'Выбирать слой под курсором (или удерживайте Ctrl/⌘)'),
      h('span', { class: 'hint' }, 'Стрелки — сдвиг на 1px, Shift+стрелки — на 10px'),
    );
  }
}

/* ------------------------------------------------------------------ Fill bucket */

export class FillTool implements Tool {
  readonly id = 'fill';
  readonly label = 'Заливка';
  readonly key = 'g';
  readonly icon = icons.fill;
  tolerance = 32;
  contiguous = true;
  opacity = 1;
  constructor(private ed: Editor) {}
  cursor(): string {
    return 'crosshair';
  }
  down(p: ToolPointer): void {
    const layer = this.ed.editableLayer(true, 'pixels');
    if (!layer) return;
    const lx = Math.floor(p.x - layer.meta.x), ly = Math.floor(p.y - layer.meta.y);
    if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) return;
    const maskCanvas = this.ed.layerMask(layer);
    let sel: Uint8ClampedArray | null = null;
    if (maskCanvas) {
      sel = readPixels(maskCanvas, 0, 0, layer.width, layer.height).data;
      disposeCanvas(maskCanvas);
      if (sel[(ly * layer.width + lx) * 4 + 3]! === 0) return; // clicked outside the selection
    }
    const w = layer.width, hh = layer.height;
    const src = readPixels(layer.canvas, 0, 0, w, hh);
    const mask = floodMask(src, lx, ly, this.tolerance, this.contiguous);
    let x0 = w, y0 = hh, x1 = -1, y1 = -1;
    for (let y = 0; y < hh; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++)
        if (mask[row + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    }
    if (x1 < 0) return;
    const rgb = hexToRgb(this.ed.fg)!;
    const out = new ImageData(w, hh);
    applyFill(out, mask, [rgb.r, rgb.g, rgb.b, 255], sel);
    const tmp = createCanvas(w, hh);
    ctx2d(tmp).putImageData(out, 0, 0);
    const rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    this.ed.pixelEdit(layer, rect, 'Заливка', (ctx) => {
      ctx.globalAlpha = this.opacity;
      ctx.drawImage(tmp, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
    });
    disposeCanvas(tmp);
    this.ed.pushRecent(this.ed.fg);
  }
  options(): HTMLElement {
    return h(
      'div',
      { class: 'opts' },
      slider({ label: 'Допуск', min: 0, max: 255, step: 1, value: this.tolerance, compact: true, onInput: (v) => (this.tolerance = v) }).el,
      slider({ label: 'Непрозр.', min: 1, max: 100, step: 1, value: this.opacity * 100, unit: '%', compact: true, onInput: (v) => (this.opacity = v / 100) }).el,
      checkbox('Смежные пиксели', this.contiguous, (v) => (this.contiguous = v)),
    );
  }
}

/* ------------------------------------------------------------------ Eyedropper */

export class EyedropperTool implements Tool {
  readonly id = 'eyedropper';
  readonly label = 'Пипетка';
  readonly key = 'i';
  readonly icon = icons.eyedropper;
  size = 1;
  private pressed = false;
  private hoverAt: { sx: number; sy: number; color: string | null } | null = null;
  constructor(private ed: Editor) {}
  cursor(): string {
    return 'crosshair';
  }
  private pick(p: ToolPointer): void {
    const c = this.ed.sampleColor(p.x, p.y, this.size);
    this.hoverAt = { sx: p.sx, sy: p.sy, color: c };
    if (c) this.ed.setColor(p.alt ? 'bg' : 'fg', c);
    this.ed.renderer?.markView();
  }
  down(p: ToolPointer): void {
    this.pressed = true;
    this.pick(p);
  }
  move(p: ToolPointer): void {
    if (this.pressed) this.pick(p);
  }
  up(): void {
    this.pressed = false;
    if (this.hoverAt?.color) this.ed.pushRecent(this.hoverAt.color);
    this.hoverAt = null;
    this.ed.renderer?.markView();
  }
  overlay(ctx: CanvasRenderingContext2D): void {
    const h0 = this.hoverAt;
    if (!h0 || !h0.color) return;
    ctx.beginPath();
    ctx.arc(h0.sx, h0.sy, 26, 0, Math.PI * 2);
    ctx.lineWidth = 10;
    ctx.strokeStyle = h0.color;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.5)';
    ctx.beginPath();
    ctx.arc(h0.sx, h0.sy, 31, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(h0.sx, h0.sy, 21, 0, Math.PI * 2);
    ctx.stroke();
  }
  options(): HTMLElement {
    return h(
      'div',
      { class: 'opts' },
      select<'1' | '3' | '5' | '11'>(
        'Образец',
        [
          { id: '1', label: 'Точка' },
          { id: '3', label: 'Среднее 3×3' },
          { id: '5', label: 'Среднее 5×5' },
          { id: '11', label: 'Среднее 11×11' },
        ],
        String(this.size) as '1',
        (v) => (this.size = Number(v)),
      ),
      h('span', { class: 'hint' }, 'Щелчок — основной цвет, Alt+щелчок — фоновый'),
    );
  }
}

/* ------------------------------------------------------------------ Zoom & Hand */

export class ZoomTool implements Tool {
  readonly id = 'zoom';
  readonly label = 'Масштаб';
  readonly key = 'z';
  readonly icon = icons.zoom;
  private start: { sx: number; sy: number; zoom: number; moved: boolean } | null = null;
  constructor(private ed: Editor) {}
  cursor(): string {
    return 'zoom-in';
  }
  down(p: ToolPointer): void {
    this.start = { sx: p.sx, sy: p.sy, zoom: this.ed.view.zoom, moved: false };
  }
  move(p: ToolPointer): void {
    const s = this.start;
    if (!s) return;
    const dx = p.sx - s.sx;
    if (Math.abs(dx) > 3) s.moved = true;
    if (s.moved) {
      // scrubby zoom: drag right to zoom in
      this.ed.view.zoomAt(s.zoom * Math.pow(1.01, dx), s.sx, s.sy);
      this.ed.viewChanged();
    }
  }
  up(p: ToolPointer): void {
    const s = this.start;
    this.start = null;
    if (s && !s.moved) {
      this.ed.view.stepZoom(p.alt ? -1 : 1, p.sx, p.sy);
      this.ed.viewChanged();
    }
  }
  options(): HTMLElement {
    return h(
      'div',
      { class: 'opts' },
      h('button', { class: 'btn', type: 'button', onclick: () => this.ed.actualPixels() }, '100%'),
      h('button', { class: 'btn', type: 'button', onclick: () => this.ed.fit() }, 'Подогнать'),
      h('span', { class: 'hint' }, 'Щелчок — приблизить, Alt+щелчок — отдалить, протяжка — плавный масштаб'),
    );
  }
}

export class HandTool implements Tool {
  readonly id = 'hand';
  readonly label = 'Рука';
  readonly key = 'h';
  readonly icon = icons.hand;
  private start: { sx: number; sy: number; px: number; py: number } | null = null;
  constructor(private ed: Editor) {}
  cursor(): string {
    return this.start ? 'grabbing' : 'grab';
  }
  down(p: ToolPointer): void {
    this.start = { sx: p.sx, sy: p.sy, px: this.ed.view.panX, py: this.ed.view.panY };
  }
  move(p: ToolPointer): void {
    if (!this.start) return;
    this.ed.view.panX = this.start.px + p.sx - this.start.sx;
    this.ed.view.panY = this.start.py + p.sy - this.start.sy;
    this.ed.viewChanged();
  }
  up(): void {
    this.start = null;
  }
  options(): HTMLElement {
    return h('div', { class: 'opts' }, h('button', { class: 'btn', type: 'button', onclick: () => this.ed.fit() }, 'Подогнать под экран'), h('span', { class: 'hint' }, 'Удерживайте Пробел для временной «руки» в любом инструменте'));
  }
}

export type { Viewport };
