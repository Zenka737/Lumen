import type { Editor } from '../core/editor';
import type { Rect } from '../core/types';
import type { Viewport } from '../core/viewport';
import { button, select } from '../ui/controls';
import { h } from '../ui/dom';
import { icons } from '../ui/icons';
import { label } from './selection';
import type { Tool, ToolPointer } from './tool';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';
const RATIOS: { id: string; label: string; r: number }[] = [
  { id: 'free', label: 'Свободно', r: 0 },
  { id: '1:1', label: '1 : 1', r: 1 },
  { id: '4:3', label: '4 : 3', r: 4 / 3 },
  { id: '3:2', label: '3 : 2', r: 3 / 2 },
  { id: '16:9', label: '16 : 9', r: 16 / 9 },
  { id: '3:4', label: '3 : 4', r: 3 / 4 },
  { id: '9:16', label: '9 : 16', r: 9 / 16 },
];

/** Crop: drag a box, adjust with handles, Enter applies, Esc cancels. */
export class CropTool implements Tool {
  readonly id = 'crop';
  readonly label = 'Рамка (кадрирование)';
  readonly key = 'c';
  readonly icon = icons.crop;
  rect: Rect | null = null;
  ratio = 'free';
  private drag: { handle: Handle | 'new'; sx: number; sy: number; orig: Rect | null } | null = null;
  private hoverHandle: Handle | null = null;
  constructor(private ed: Editor) {}

  get active(): boolean {
    return !!this.drag;
  }
  cursor(): string {
    const map: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };
    return this.hoverHandle ? map[this.hoverHandle] : 'crosshair';
  }
  private ratioValue(): number {
    return RATIOS.find((r) => r.id === this.ratio)?.r ?? 0;
  }

  private hit(p: ToolPointer): Handle | null {
    const r = this.rect;
    if (!r) return null;
    const v = this.ed.view;
    const a = v.toScreen(r.x, r.y), b = v.toScreen(r.x + r.w, r.y + r.h);
    const tol = 9;
    const nearX = (x: number) => Math.abs(p.sx - x) <= tol;
    const nearY = (y: number) => Math.abs(p.sy - y) <= tol;
    const inX = p.sx > a.x - tol && p.sx < b.x + tol, inY = p.sy > a.y - tol && p.sy < b.y + tol;
    if (!inX || !inY) return null;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (nearX(a.x) && nearY(a.y)) return 'nw';
    if (nearX(b.x) && nearY(a.y)) return 'ne';
    if (nearX(a.x) && nearY(b.y)) return 'sw';
    if (nearX(b.x) && nearY(b.y)) return 'se';
    if (nearY(a.y) && Math.abs(p.sx - mx) < (b.x - a.x) / 2) return 'n';
    if (nearY(b.y) && Math.abs(p.sx - mx) < (b.x - a.x) / 2) return 's';
    if (nearX(a.x) && Math.abs(p.sy - my) < (b.y - a.y) / 2) return 'w';
    if (nearX(b.x) && Math.abs(p.sy - my) < (b.y - a.y) / 2) return 'e';
    return 'move';
  }

  hover(p: ToolPointer): void {
    const hh = this.hit(p);
    if (hh !== this.hoverHandle) {
      this.hoverHandle = hh;
      this.ed.events.emit('tool', this.id); // refresh cursor
    }
  }

  down(p: ToolPointer): void {
    const hh = this.hit(p);
    if (!hh) p = { ...p, ...this.ed.snap(p.x, p.y) };
    this.drag = { handle: hh ?? 'new', sx: p.x, sy: p.y, orig: this.rect ? { ...this.rect } : null };
    if (!hh) this.rect = { x: Math.round(p.x), y: Math.round(p.y), w: 0, h: 0 };
  }

  move(p: ToolPointer): void {
    const d = this.drag;
    if (!d) return this.hover(p);
    if (d.handle !== 'move') p = { ...p, ...this.ed.snap(p.x, p.y) };
    const W = this.ed.doc.width, H = this.ed.doc.height;
    const ratio = this.ratioValue();
    const cx = (v: number) => Math.max(0, Math.min(W, Math.round(v)));
    const cy = (v: number) => Math.max(0, Math.min(H, Math.round(v)));
    if (d.handle === 'new') {
      let x1 = p.x, y1 = p.y;
      if (ratio) {
        const w = x1 - d.sx;
        y1 = d.sy + Math.sign(y1 - d.sy || 1) * Math.abs(w) / ratio;
      }
      const ax = cx(d.sx), ay = cy(d.sy), bx = cx(x1), by = cy(y1);
      this.rect = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
    } else if (d.orig) {
      const o = d.orig;
      const dx = p.x - d.sx, dy = p.y - d.sy;
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      if (d.handle === 'move') {
        const nx = Math.max(0, Math.min(W - o.w, Math.round(o.x + dx)));
        const ny = Math.max(0, Math.min(H - o.h, Math.round(o.y + dy)));
        this.rect = { x: nx, y: ny, w: o.w, h: o.h };
      } else {
        if (d.handle.includes('w')) x0 = cx(o.x + dx);
        if (d.handle.includes('e')) x1 = cx(o.x + o.w + dx);
        if (d.handle.includes('n')) y0 = cy(o.y + dy);
        if (d.handle.includes('s')) y1 = cy(o.y + o.h + dy);
        if (ratio && d.handle.length === 2) {
          const w = Math.abs(x1 - x0);
          const hNew = w / ratio;
          if (d.handle.includes('n')) y0 = cy(y1 - hNew);
          else y1 = cy(y0 + hNew);
        }
        this.rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      }
    }
    this.ed.renderer?.markView();
  }

  up(): void {
    this.drag = null;
    if (this.rect && (this.rect.w < 2 || this.rect.h < 2)) this.rect = null;
    this.ed.events.emit('toolOptions', undefined);
    this.ed.renderer?.markView();
  }

  apply(): void {
    if (!this.rect) return;
    const r = this.rect;
    this.rect = null;
    this.ed.crop(r);
    this.ed.events.emit('toolOptions', undefined);
  }
  cancel(): void {
    this.drag = null;
    this.rect = null;
    this.ed.renderer?.markView();
    this.ed.events.emit('toolOptions', undefined);
  }
  deactivate(): void {
    this.cancel();
  }

  keydown(e: KeyboardEvent): boolean {
    if (e.key === 'Enter' && this.rect) {
      this.apply();
      return true;
    }
    if (e.key === 'Escape' && this.rect) {
      this.cancel();
      return true;
    }
    return false;
  }

  overlay(ctx: CanvasRenderingContext2D, view: Viewport): void {
    const r = this.rect;
    if (!r) return;
    const a = view.toScreen(r.x, r.y), b = view.toScreen(r.x + r.w, r.y + r.h);
    const w = b.x - a.x, hh = b.y - a.y;
    ctx.beginPath();
    ctx.rect(0, 0, view.width, view.height);
    ctx.rect(a.x, a.y, w, hh);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      ctx.moveTo(a.x + (w * i) / 3, a.y);
      ctx.lineTo(a.x + (w * i) / 3, b.y);
      ctx.moveTo(a.x, a.y + (hh * i) / 3);
      ctx.lineTo(b.x, a.y + (hh * i) / 3);
    }
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(a.x, a.y, w, hh);
    ctx.fillStyle = '#fff';
    const s = 8;
    for (const [hx, hy] of [
      [a.x, a.y], [b.x, a.y], [a.x, b.y], [b.x, b.y],
      [(a.x + b.x) / 2, a.y], [(a.x + b.x) / 2, b.y], [a.x, (a.y + b.y) / 2], [b.x, (a.y + b.y) / 2],
    ] as [number, number][]) {
      ctx.fillRect(hx - s / 2, hy - s / 2, s, s);
      ctx.strokeStyle = 'rgba(0,0,0,.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(hx - s / 2, hy - s / 2, s, s);
    }
    label(ctx, `${r.w} × ${r.h}`, a.x, Math.max(4, a.y - 26));
  }

  options(): HTMLElement {
    return h(
      'div',
      { class: 'opts' },
      select('Пропорции', RATIOS.map((r) => ({ id: r.id, label: r.label })), this.ratio, (v) => (this.ratio = v)),
      button('Применить', () => this.apply(), { primary: true, icon: icons.check, tip: 'Enter' }),
      button('Отмена', () => this.cancel(), { ghost: true, tip: 'Esc' }),
      h('span', { class: 'hint' }, this.rect ? `${this.rect.w} × ${this.rect.h} px` : 'Протяните рамку по изображению'),
    );
  }
}
