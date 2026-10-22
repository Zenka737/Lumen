import { createCanvas, ctx2d } from '../core/canvas';
import type { Editor } from '../core/editor';
import type { ShapeData } from '../core/types';
import { drawShape, shapePad } from '../core/vector';
import type { Viewport } from '../core/viewport';
import { checkbox, segmented, slider } from '../ui/controls';
import { h } from '../ui/dom';
import { icons } from '../ui/icons';
import { label } from './selection';
import type { Tool, ToolPointer } from './tool';

type Kind = 'rect' | 'ellipse' | 'line';

/** Rectangle / ellipse / line. Shift constrains (square, circle, 45° lines). */
export class ShapeTool implements Tool {
  readonly id = 'shape';
  readonly label = 'Фигуры';
  readonly key = 'u';
  kind: Kind = 'rect';
  fill = true;
  stroke = false;
  strokeWidth = 4;
  radius = 0;
  newLayer = true;
  private a: { x: number; y: number } | null = null;
  private b: { x: number; y: number } | null = null;
  constructor(private ed: Editor) {}

  get icon(): string {
    return icons.shape;
  }
  get active(): boolean {
    return !!this.a;
  }
  cursor(): string {
    return 'crosshair';
  }

  down(p: ToolPointer): void {
    if (!this.newLayer && !this.ed.editableLayer()) return;
    this.a = this.ed.snap(p.x, p.y);
    this.b = { ...this.a };
  }
  move(p: ToolPointer): void {
    if (!this.a) return;
    let { x, y } = p.shift ? p : this.ed.snap(p.x, p.y);
    if (p.shift) {
      const dx = x - this.a.x, dy = y - this.a.y;
      if (this.kind === 'line') {
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        x = this.a.x + Math.cos(ang) * len;
        y = this.a.y + Math.sin(ang) * len;
      } else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        x = this.a.x + Math.sign(dx || 1) * m;
        y = this.a.y + Math.sign(dy || 1) * m;
      }
    }
    this.b = { x, y };
    this.ed.renderer?.markView();
  }

  /** Current drag as shape data plus the document position of its box. */
  private data(): { sd: ShapeData; x: number; y: number } {
    const a = this.a!, b = this.b!;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), hh = Math.abs(b.y - a.y);
    const fg = this.ed.fg, bg = this.ed.bg;
    const sd: ShapeData =
      this.kind === 'line'
        ? { type: 'line', w, h: hh, fill: null, stroke: fg, strokeWidth: this.strokeWidth, radius: 0, x1: a.x - x, y1: a.y - y, x2: b.x - x, y2: b.y - y }
        : { type: this.kind, w, h: hh, fill: this.fill ? fg : null, stroke: this.stroke ? (this.fill ? bg : fg) : null, strokeWidth: this.strokeWidth, radius: this.kind === 'rect' ? this.radius : 0 };
    return { sd, x, y };
  }

  up(): void {
    const a = this.a, b = this.b;
    if (!a || !b) return;
    const tooSmall = Math.hypot(b.x - a.x, b.y - a.y) < 2;
    if (tooSmall || (!this.fill && !this.stroke && this.kind !== 'line')) {
      this.a = this.b = null;
      this.ed.renderer?.markView();
      return;
    }
    const names: Record<Kind, string> = { rect: 'Прямоугольник', ellipse: 'Эллипс', line: 'Линия' };
    const { sd, x, y } = this.data();
    try {
      if (this.newLayer) {
        this.ed.addShapeLayer(sd, x, y, names[this.kind]);
      } else {
        const l = this.ed.editableLayer(true, 'pixels');
        if (l) {
          const pad = shapePad(sd);
          const mask = this.ed.layerMask(l);
          const rect = { x: Math.floor(x - l.meta.x) - pad, y: Math.floor(y - l.meta.y) - pad, w: Math.ceil(sd.w) + pad * 2 + 2, h: Math.ceil(sd.h) + pad * 2 + 2 };
          this.ed.pixelEdit(l, rect, names[this.kind], (ctx) => {
            if (!mask) return drawShape(ctx, sd, x - l.meta.x, y - l.meta.y);
            const t = createCanvas(l.width, l.height);
            const tc = ctx2d(t);
            drawShape(tc, sd, x - l.meta.x, y - l.meta.y);
            tc.globalCompositeOperation = 'destination-in';
            tc.drawImage(mask, 0, 0);
            ctx.drawImage(t, 0, 0);
          });
        }
      }
      this.ed.pushRecent(this.ed.fg);
    } finally {
      this.a = this.b = null;
      this.ed.renderer?.markView();
    }
  }
  cancel(): void {
    this.a = this.b = null;
    this.ed.renderer?.markView();
  }

  overlay(ctx: CanvasRenderingContext2D, view: Viewport): void {
    if (!this.a || !this.b) return;
    ctx.save();
    ctx.globalAlpha = 0.9;
    const { sd, x, y } = this.data();
    const o = view.toScreen(x, y);
    drawShape(ctx, sd, o.x, o.y, view.zoom);
    ctx.restore();
    const s = view.toScreen(Math.max(this.a.x, this.b.x), Math.max(this.a.y, this.b.y));
    label(ctx, `${Math.round(Math.abs(this.b.x - this.a.x))} × ${Math.round(Math.abs(this.b.y - this.a.y))}`, s.x + 8, s.y + 8);
  }

  options(): HTMLElement {
    return h(
      'div',
      { class: 'opts' },
      segmented<Kind>(
        [
          { id: 'rect', icon: icons.shapeRect, tip: 'Прямоугольник' },
          { id: 'ellipse', icon: icons.shapeEllipse, tip: 'Эллипс' },
          { id: 'line', icon: icons.shapeLine, tip: 'Линия' },
        ],
        this.kind,
        (v) => (this.kind = v),
      ),
      checkbox('Заливка', this.fill, (v) => (this.fill = v), 'Заливка основным цветом'),
      checkbox('Обводка', this.stroke, (v) => (this.stroke = v), 'Обводка (фоновым цветом при включённой заливке)'),
      slider({ label: 'Толщина', min: 1, max: 200, step: 1, value: this.strokeWidth, unit: 'px', compact: true, onInput: (v) => (this.strokeWidth = v) }).el,
      slider({ label: 'Скругление', min: 0, max: 500, step: 1, value: this.radius, unit: 'px', compact: true, onInput: (v) => (this.radius = v) }).el,
      checkbox('Слой-фигура', this.newLayer, (v) => (this.newLayer = v), 'Создавать редактируемый слой-фигуру (иначе рисовать пикселями на активном слое)'),
      h('span', { class: 'hint' }, 'Двойной щелчок по фигуре — правка в «Свойствах»'),
    );
  }
}
