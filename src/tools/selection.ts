import type { Editor } from '../core/editor';
import type { SelPart, SelShape } from '../core/selection';
import { shapePath } from '../core/selection';
import type { Viewport } from '../core/viewport';
import { checkbox, segmented, slider } from '../ui/controls';
import { h } from '../ui/dom';
import { icons } from '../ui/icons';
import type { Tool, ToolPointer } from './tool';

type Mode = 'new' | 'add' | 'sub';

function modeFrom(p: ToolPointer, base: Mode): Mode {
  if (p.shift && p.alt) return base;
  if (p.shift) return 'add';
  if (p.alt) return 'sub';
  return base;
}

function commit(ed: Editor, shape: SelShape, mode: Mode): void {
  const parts: SelPart[] = mode === 'new' ? [] : ed.doc.selection.getParts();
  if (mode === 'sub' && !ed.doc.selection.active) return;
  parts.push({ shape, mode: mode === 'sub' ? 'sub' : 'add' });
  ed.setSelection(parts, 'Выделение', mode === 'new' ? null : ed.doc.selection.getRaster());
}

function modeOptions(get: () => Mode, set: (m: Mode) => void): HTMLElement {
  return segmented<Mode>(
    [
      { id: 'new', label: 'Новое', tip: 'Новое выделение' },
      { id: 'add', label: '+', tip: 'Добавить (Shift)' },
      { id: 'sub', label: '−', tip: 'Вычесть (Alt)' },
    ],
    get(),
    set,
  );
}

/** Rectangular / elliptical marquee. Shift while dragging constrains to square/circle. */
export class MarqueeTool implements Tool {
  readonly id = 'marquee';
  readonly label = 'Выделение';
  readonly key = 'm';
  shape: 'rect' | 'ellipse' = 'rect';
  baseMode: Mode = 'new';
  private start: { x: number; y: number } | null = null;
  private cur: SelShape | null = null;
  private mode: Mode = 'new';
  constructor(private ed: Editor) {}
  get icon(): string {
    return this.shape === 'rect' ? icons.marquee : icons.marqueeEllipse;
  }
  get active(): boolean {
    return !!this.start;
  }
  cursor(): string {
    return 'crosshair';
  }
  /** Toggle rect/ellipse (pressing M again). */
  cycle(): void {
    this.shape = this.shape === 'rect' ? 'ellipse' : 'rect';
    this.ed.events.emit('toolOptions', undefined);
    this.ed.events.emit('tool', this.id);
  }
  down(p: ToolPointer): void {
    this.start = this.ed.snap(p.x, p.y);
    this.mode = modeFrom(p, this.baseMode);
    this.cur = null;
  }
  move(p: ToolPointer): void {
    if (!this.start) return;
    const q = p.shift || p.alt ? p : this.ed.snap(p.x, p.y);
    let w = q.x - this.start.x, hh = q.y - this.start.y;
    if (p.shift && this.mode !== 'add') {
      const m = Math.max(Math.abs(w), Math.abs(hh));
      w = Math.sign(w || 1) * m;
      hh = Math.sign(hh || 1) * m;
    }
    let x = this.start.x, y = this.start.y;
    if (p.alt && this.mode === 'new') {
      // draw from centre
      x -= w;
      y -= hh;
      w *= 2;
      hh *= 2;
    }
    const r = { x: Math.round(Math.min(x, x + w)), y: Math.round(Math.min(y, y + hh)), w: Math.round(Math.abs(w)), h: Math.round(Math.abs(hh)) };
    this.cur = { type: this.shape, ...r };
    this.ed.renderer?.markView();
  }
  up(): void {
    const s = this.cur;
    const mode = this.mode;
    this.start = null;
    this.cur = null;
    if (s && s.type !== 'poly' && s.w >= 1 && s.h >= 1) commit(this.ed, s, mode);
    else if (mode === 'new') this.ed.deselect();
    this.ed.renderer?.markView();
  }
  cancel(): void {
    this.start = null;
    this.cur = null;
    this.ed.renderer?.markView();
  }
  overlay(ctx: CanvasRenderingContext2D, view: Viewport): void {
    if (!this.cur) return;
    drawShapePreview(ctx, view, this.cur);
    if (this.cur.type !== 'poly') {
      const t = `${this.cur.w} × ${this.cur.h}`;
      const s = view.toScreen(this.cur.x + this.cur.w, this.cur.y + this.cur.h);
      label(ctx, t, s.x + 8, s.y + 8);
    }
  }
  options(): HTMLElement {
    return h(
      'div',
      { class: 'opts' },
      segmented<'rect' | 'ellipse'>(
        [
          { id: 'rect', icon: icons.marquee, tip: 'Прямоугольная область' },
          { id: 'ellipse', icon: icons.marqueeEllipse, tip: 'Овальная область' },
        ],
        this.shape,
        (v) => {
          this.shape = v;
          this.ed.events.emit('tool', this.id);
        },
      ),
      modeOptions(() => this.baseMode, (m) => (this.baseMode = m)),
      h('span', { class: 'hint' }, 'Shift — квадрат/добавить · Alt — от центра/вычесть · Ctrl+D — снять'),
    );
  }
}

/** Freehand lasso. */
export class LassoTool implements Tool {
  readonly id = 'lasso';
  readonly label = 'Лассо';
  readonly key = 'l';
  readonly icon = icons.lasso;
  baseMode: Mode = 'new';
  private pts: number[] | null = null;
  private mode: Mode = 'new';
  constructor(private ed: Editor) {}
  get active(): boolean {
    return !!this.pts;
  }
  cursor(): string {
    return 'crosshair';
  }
  down(p: ToolPointer): void {
    this.pts = [p.x, p.y];
    this.mode = modeFrom(p, this.baseMode);
  }
  move(p: ToolPointer): void {
    if (!this.pts) return;
    const n = this.pts.length;
    const dx = p.x - this.pts[n - 2]!, dy = p.y - this.pts[n - 1]!;
    if (dx * dx + dy * dy * 1 < (1 / this.ed.view.zoom) ** 2 * 4) return;
    this.pts.push(p.x, p.y);
    this.ed.renderer?.markView();
  }
  up(): void {
    const pts = this.pts;
    this.pts = null;
    if (pts && pts.length >= 6) commit(this.ed, { type: 'poly', pts }, this.mode);
    else if (this.mode === 'new') this.ed.deselect();
    this.ed.renderer?.markView();
  }
  cancel(): void {
    this.pts = null;
    this.ed.renderer?.markView();
  }
  overlay(ctx: CanvasRenderingContext2D, view: Viewport): void {
    if (this.pts && this.pts.length >= 4) drawShapePreview(ctx, view, { type: 'poly', pts: this.pts });
  }
  options(): HTMLElement {
    return h('div', { class: 'opts' }, modeOptions(() => this.baseMode, (m) => (this.baseMode = m)), h('span', { class: 'hint' }, 'Обведите область. Shift — добавить, Alt — вычесть'));
  }
}

/** Magic wand: selects pixels of similar colour (tolerance, contiguous, all layers). */
export class MagicWandTool implements Tool {
  readonly id = 'wand';
  readonly label = 'Волшебная палочка';
  readonly key = 'w';
  readonly icon = icons.wand;
  tolerance = 32;
  contiguous = true;
  sampleAll = false;
  baseMode: Mode = 'new';
  constructor(private ed: Editor) {}
  cursor(): string {
    return 'crosshair';
  }
  down(p: ToolPointer): void {
    const mode = modeFrom(p, this.baseMode);
    this.ed.setBusy('Волшебная палочка…');
    try {
      this.ed.magicWand(p.x, p.y, this.tolerance, this.contiguous, this.sampleAll, mode);
    } finally {
      this.ed.setBusy(null);
    }
  }
  options(): HTMLElement {
    return h(
      'div',
      { class: 'opts' },
      modeOptions(() => this.baseMode, (m) => (this.baseMode = m)),
      slider({ label: 'Допуск', min: 0, max: 255, step: 1, value: this.tolerance, compact: true, tip: 'Насколько цвет может отличаться от образца', onInput: (v) => (this.tolerance = v) }).el,
      checkbox('Смежные пиксели', this.contiguous, (v) => (this.contiguous = v), 'Только связанная область (иначе — все похожие пиксели)'),
      checkbox('Все слои', this.sampleAll, (v) => (this.sampleAll = v), 'Образец по сведённому изображению'),
      h('span', { class: 'hint' }, 'Shift — добавить, Alt — вычесть'),
    );
  }
}

export function drawShapePreview(ctx: CanvasRenderingContext2D, view: Viewport, s: SelShape): void {
  ctx.save();
  ctx.translate(view.panX, view.panY);
  ctx.scale(view.zoom, view.zoom);
  const path = shapePath(s);
  ctx.lineWidth = 1 / view.zoom;
  ctx.strokeStyle = '#fff';
  ctx.stroke(path);
  ctx.setLineDash([4 / view.zoom, 4 / view.zoom]);
  ctx.strokeStyle = '#000';
  ctx.stroke(path);
  ctx.restore();
}

export function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.save();
  ctx.font = '500 11px Inter, system-ui, sans-serif';
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = 'rgba(20,20,24,0.85)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, 20, 5);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 6, y + 10.5);
  ctx.restore();
}
