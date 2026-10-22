import { cloneCanvas, createCanvas, ctx2d, disposeCanvas } from '../core/canvas';
import type { Layer, Matrix } from '../core/document';
import { bakeMask, canvasAlpha, whiteCanvas, type Editor } from '../core/editor';
import { maskBounds } from '../core/maskOps';
import { renderShape, shapePad } from '../core/vector';
import { applyMatrix, dragHandle, dragRotate, hitInside, initialXform, isIdentity, isPureTranslation, xformBounds, xformCorners, xformMatrix, type Pt, type XformState } from '../core/transform';
import type { Rect } from '../core/types';
import { rectClip } from '../core/types';
import type { Viewport } from '../core/viewport';
import { button } from '../ui/controls';
import { h } from '../ui/dom';
import { icons } from '../ui/icons';
import { label } from './selection';
import type { Tool, ToolPointer } from './tool';

type Grab = { kind: 'scale'; hx: number; hy: number } | { kind: 'rotate' } | { kind: 'move' };

interface Session {
  layer: Layer;
  /** Source rect in document coordinates. */
  src: Rect;
  /** Unmasked source pixels (src-sized). */
  float: HTMLCanvasElement;
  /** Mask pixels travelling with the float (whole-layer mode). */
  floatMask: HTMLCanvasElement | null;
  /** Layer canvas with the selection cut out (selection mode). */
  base: HTMLCanvasElement | null;
  selection: boolean;
  s: XformState;
}

const HANDLES: [number, number][] = [
  [0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5],
];

/**
 * Free transform (⌘/Ctrl+T) of the active layer or of the selected pixels: drag inside to
 * move, handles to scale (Shift keeps proportions, Alt from centre), outside to rotate
 * (Shift snaps 15°). Enter applies, Esc cancels. One undo step.
 */
export class TransformTool implements Tool {
  readonly id = 'transform';
  readonly label = 'Свободное трансформирование';
  readonly key = '';
  readonly icon = icons.transform;
  private sess: Session | null = null;
  private drag: { grab: Grab; start: Pt; s0: XformState } | null = null;
  private hoverGrab: Grab | null = null;
  private prevTool = 'move';
  constructor(private ed: Editor) {}

  get active(): boolean {
    return !!this.sess;
  }
  private isCurrent(): boolean {
    return (this.ed.tool as Tool | null) === (this as Tool);
  }

  /** Begins a session (called by the ⌘T command). */
  start(): void {
    if (this.sess) return;
    const prev = this.ed.tool;
    const layer = this.ed.editableLayer(true);
    if (!layer) return;
    if (layer.meta.kind === 'adjustment') {
      this.ed.ui.toast('Корректирующий слой нельзя трансформировать', 'warn');
      return;
    }
    const selRect = this.ed.doc.selection.active ? this.ed.layerSelRect(layer) : null;
    let sess: Session | null = null;
    if (selRect && layer.meta.kind !== 'text' && layer.meta.kind !== 'shape') {
      const r = rectClip(selRect, layer.width, layer.height);
      if (!r) {
        this.ed.ui.toast('Выделение вне слоя', 'warn');
        return;
      }
      const sel = this.ed.layerMask(layer)!;
      const float = createCanvas(r.w, r.h);
      const fc = ctx2d(float);
      fc.drawImage(layer.canvas, -r.x, -r.y);
      fc.globalCompositeOperation = 'destination-in';
      fc.drawImage(sel, -r.x, -r.y);
      const base = cloneCanvas(layer.canvas);
      const bc = ctx2d(base);
      bc.globalCompositeOperation = 'destination-out';
      bc.drawImage(sel, 0, 0);
      disposeCanvas(sel);
      const src = { x: r.x + layer.meta.x, y: r.y + layer.meta.y, w: r.w, h: r.h };
      sess = { layer, src, float, floatMask: null, base, selection: true, s: initialXform(src) };
    } else {
      const b = maskBounds(canvasAlpha(layer.canvas), layer.width, layer.height);
      if (!b) {
        this.ed.ui.toast('Слой пуст — нечего трансформировать', 'warn');
        return;
      }
      const crop = (c: HTMLCanvasElement) => {
        const o = createCanvas(b.w, b.h);
        ctx2d(o).drawImage(c, -b.x, -b.y);
        return o;
      };
      const src = { x: b.x + layer.meta.x, y: b.y + layer.meta.y, w: b.w, h: b.h };
      sess = { layer, src, float: crop(layer.canvas), floatMask: layer.mask ? crop(layer.mask) : null, base: null, selection: false, s: initialXform(src) };
    }
    this.prevTool = prev && prev.id !== this.id ? prev.id : 'move';
    this.sess = sess;
    const preview = sess.floatMask && layer.meta.maskEnabled !== false ? bakeMask({ canvas: sess.float, mask: sess.floatMask, meta: layer.meta } as Layer) : sess.float;
    layer.xform = { base: sess.base, float: preview, m: xformMatrix(sess.s), maskAfter: sess.selection };
    if (!this.isCurrent()) this.ed.setTool(this.id);
    this.ed.redraw();
    this.ed.events.emit('toolOptions', undefined);
  }

  private sync(): void {
    const sess = this.sess;
    if (!sess?.layer.xform) return;
    sess.layer.xform.m = xformMatrix(sess.s);
    this.ed.redraw();
  }

  private end(): void {
    const sess = this.sess;
    this.sess = null;
    this.drag = null;
    if (sess) {
      sess.layer.xform = null;
      this.ed.redraw();
    }
    if (this.isCurrent()) this.ed.setTool(this.prevTool);
  }

  cancel(): void {
    if (!this.sess) return;
    this.end();
  }
  deactivate(): void {
    // switching tools mid-session applies, like Photoshop's "Apply transformation?" default
    if (this.sess) this.apply(false);
  }

  /** Commits the transform as one history step. */
  apply(restoreTool = true): void {
    const sess = this.sess;
    if (!sess) return;
    const { layer, s } = sess;
    layer.xform = null;
    this.sess = null;
    this.drag = null;
    if (!isIdentity(s)) this.commit(sess);
    else this.ed.redraw();
    if (restoreTool && this.isCurrent()) this.ed.setTool(this.prevTool);
  }

  private commit(sess: Session): void {
    const { layer, s, src } = sess;
    const m = xformMatrix(s);
    const bounds = xformBounds(s);
    const kind = layer.meta.kind;
    const pure = isPureTranslation(s);
    this.ed.structural('Свободное трансформирование', () => {
      // editable layers: translation keeps them, simple scaling edits their data
      if (kind === 'shape' && layer.meta.shape && Math.abs(s.rot) < 1e-9 && s.sx > 0 && s.sy > 0 && !pure) {
        const sh = layer.meta.shape;
        const w = Math.max(1, sh.w * s.sx), hgt = Math.max(sh.type === 'line' ? 0 : 1, sh.h * s.sy);
        const next = { ...sh, w, h: hgt };
        if (sh.type === 'line') {
          next.x1 = (sh.x1 ?? 0) * s.sx;
          next.y1 = (sh.y1 ?? 0) * s.sy;
          next.x2 = (sh.x2 ?? sh.w) * s.sx;
          next.y2 = (sh.y2 ?? sh.h) * s.sy;
        }
        const pad0 = shapePad(sh);
        const tl = applyMatrix(m, layer.meta.x + pad0 - src.x, layer.meta.y + pad0 - src.y);
        const c = renderShape(next);
        const pad = shapePad(next);
        layer.meta.shape = next;
        layer.canvas = c;
        layer.meta.x = Math.round(tl.x - pad);
        layer.meta.y = Math.round(tl.y - pad);
        if (layer.mask) layer.mask = whiteCanvas(c.width, c.height);
        return;
      }
      if (kind === 'text' && layer.meta.text && pure) {
        layer.meta.x += s.tx;
        layer.meta.y += s.ty;
        return;
      }
      if (kind === 'shape' && pure) {
        layer.meta.x += s.tx;
        layer.meta.y += s.ty;
        return;
      }
      const draw = (img: HTMLCanvasElement, into: HTMLCanvasElement, ox: number, oy: number) => {
        const x = ctx2d(into);
        x.save();
        x.translate(-ox, -oy);
        x.transform(...(m as Matrix));
        x.imageSmoothingQuality = 'high';
        x.drawImage(img, 0, 0);
        x.restore();
      };
      if (sess.selection) {
        const base = sess.base!;
        const x0 = Math.min(layer.meta.x, bounds.x), y0 = Math.min(layer.meta.y, bounds.y);
        const x1 = Math.max(layer.meta.x + layer.width, bounds.x + bounds.w), y1 = Math.max(layer.meta.y + layer.height, bounds.y + bounds.h);
        const c = createCanvas(x1 - x0, y1 - y0);
        ctx2d(c).drawImage(base, layer.meta.x - x0, layer.meta.y - y0);
        draw(sess.float, c, x0, y0);
        if (layer.mask) {
          const nm = whiteCanvas(c.width, c.height);
          const nc = ctx2d(nm);
          nc.clearRect(layer.meta.x - x0, layer.meta.y - y0, layer.mask.width, layer.mask.height);
          nc.drawImage(layer.mask, layer.meta.x - x0, layer.meta.y - y0);
          layer.mask = nm;
        }
        layer.canvas = c;
        layer.meta.x = x0;
        layer.meta.y = y0;
        // the selection follows the pixels
        const selMask = this.ed.doc.selection.mask(this.ed.doc.width, this.ed.doc.height);
        if (selMask) {
          const ns = createCanvas(this.ed.doc.width, this.ed.doc.height);
          const nx = ctx2d(ns);
          nx.transform(...(m as Matrix));
          nx.translate(-src.x, -src.y);
          nx.drawImage(selMask, 0, 0);
          this.ed.doc.selection.setParts([], ns);
        }
      } else {
        const c = createCanvas(bounds.w, bounds.h);
        draw(sess.float, c, bounds.x, bounds.y);
        if (sess.floatMask) {
          const nm = createCanvas(bounds.w, bounds.h);
          draw(sess.floatMask, nm, bounds.x, bounds.y);
          layer.mask = nm;
        }
        layer.canvas = c;
        layer.meta.x = bounds.x;
        layer.meta.y = bounds.y;
      }
      if (kind === 'text' || kind === 'shape') {
        delete layer.meta.text;
        delete layer.meta.shape;
        layer.meta.kind = 'raster';
      }
    });
    this.ed.events.emit('selection', undefined);
  }

  flip(axis: 'h' | 'v'): void {
    const sess = this.sess;
    if (!sess) return;
    sess.s = axis === 'h' ? { ...sess.s, sx: -sess.s.sx } : { ...sess.s, sy: -sess.s.sy };
    this.sync();
  }
  rotateBy(deg: number): void {
    const sess = this.sess;
    if (!sess) return;
    sess.s = { ...sess.s, rot: sess.s.rot + (deg * Math.PI) / 180 };
    this.sync();
    this.ed.events.emit('toolOptions', undefined);
  }

  cursor(): string {
    const g = this.hoverGrab;
    if (!g) return 'default';
    if (g.kind === 'move') return 'move';
    if (g.kind === 'rotate') return 'alias';
    const rot = this.sess?.s.rot ?? 0;
    const ang = (Math.atan2(g.hy - 0.5, g.hx - 0.5) + rot) * (180 / Math.PI);
    const a = ((Math.round(ang / 45) % 4) + 4) % 4;
    return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][a]!;
  }

  private hit(p: ToolPointer): Grab | null {
    const sess = this.sess;
    if (!sess) return null;
    const v = this.ed.view;
    const m = xformMatrix(sess.s);
    for (const [hx, hy] of HANDLES) {
      const d = v.toScreen(m[0] * hx * sess.s.w + m[2] * hy * sess.s.h + m[4], m[1] * hx * sess.s.w + m[3] * hy * sess.s.h + m[5]);
      if (Math.abs(d.x - p.sx) <= 7 && Math.abs(d.y - p.sy) <= 7) return { kind: 'scale', hx, hy };
    }
    if (hitInside(sess.s, p)) return { kind: 'move' };
    return { kind: 'rotate' };
  }

  hover(p: ToolPointer): void {
    const g = this.hit(p);
    if (JSON.stringify(g) !== JSON.stringify(this.hoverGrab)) {
      this.hoverGrab = g;
      this.ed.events.emit('tool', this.id);
    }
  }

  down(p: ToolPointer): void {
    if (!this.sess) {
      this.start();
      return;
    }
    const grab = this.hit(p);
    if (!grab) return;
    this.drag = { grab, start: { x: p.x, y: p.y }, s0: { ...this.sess.s } };
  }

  move(p: ToolPointer): void {
    const d = this.drag, sess = this.sess;
    if (!d || !sess) return this.hover(p);
    const g = d.grab;
    if (g.kind === 'move') {
      let dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (p.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      let next: XformState = { ...d.s0, tx: d.s0.tx + dx, ty: d.s0.ty + dy };
      const sn = this.ed.snapRect(xformBounds(next));
      next = { ...next, tx: next.tx + sn.dx, ty: next.ty + sn.dy };
      // keep pixel-exact moves when nothing else changed
      if (d.s0.sx === 1 && d.s0.sy === 1 && d.s0.rot === 0) next = { ...next, tx: Math.round(next.tx), ty: Math.round(next.ty) };
      sess.s = next;
    } else if (g.kind === 'scale') sess.s = dragHandle(d.s0, g.hx, g.hy, p, p.shift, p.alt);
    else sess.s = dragRotate(d.s0, d.start, p, p.shift);
    this.sync();
  }

  up(): void {
    if (!this.drag) return;
    this.drag = null;
    this.ed.events.emit('toolOptions', undefined);
  }

  keydown(e: KeyboardEvent): boolean {
    if (!this.sess) return false;
    if (e.key === 'Enter') {
      this.apply();
      return true;
    }
    if (e.key === 'Escape') {
      this.cancel();
      return true;
    }
    const step = e.shiftKey ? 10 : 1;
    const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const v = map[e.key];
    if (v) {
      this.sess.s = { ...this.sess.s, tx: this.sess.s.tx + v[0], ty: this.sess.s.ty + v[1] };
      this.sync();
      return true;
    }
    return false;
  }

  overlay(ctx: CanvasRenderingContext2D, view: Viewport): void {
    const sess = this.sess;
    if (!sess) return;
    const cs = xformCorners(sess.s).map((c) => view.toScreen(c.x, c.y));
    ctx.beginPath();
    cs.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
    ctx.closePath();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#4f8cff';
    ctx.stroke();
    const m = xformMatrix(sess.s);
    for (const [hx, hy] of HANDLES) {
      const d = view.toScreen(m[0] * hx * sess.s.w + m[2] * hy * sess.s.h + m[4], m[1] * hx * sess.s.w + m[3] * hy * sess.s.h + m[5]);
      ctx.fillStyle = '#fff';
      ctx.fillRect(d.x - 4, d.y - 4, 8, 8);
      ctx.strokeStyle = '#4f8cff';
      ctx.strokeRect(d.x - 4, d.y - 4, 8, 8);
    }
    const c = view.toScreen(sess.s.cx + sess.s.tx, sess.s.cy + sess.s.ty);
    ctx.beginPath();
    ctx.arc(c.x, c.y, 3.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#4f8cff';
    ctx.stroke();
    if (this.drag) {
      const s = sess.s;
      const txt = this.drag.grab.kind === 'rotate' ? `${((s.rot * 180) / Math.PI).toFixed(1)}°` : `${Math.round(Math.abs(s.w * s.sx))} × ${Math.round(Math.abs(s.h * s.sy))}`;
      const top = cs.reduce((a, b) => (b.y < a.y ? b : a));
      label(ctx, txt, top.x + 10, top.y - 28);
    }
  }

  options(): HTMLElement {
    const sess = this.sess;
    if (!sess) return h('div', { class: 'opts' }, h('span', { class: 'hint' }, 'Нажмите ⌘/Ctrl+T, чтобы трансформировать слой или выделение'));
    const s = sess.s;
    const num = (lab: string, value: number, unit: string, set: (v: number) => void) => {
      const input = h('input', { type: 'number', class: 'num', value: String(+value.toFixed(1)), 'aria-label': lab, step: 'any' });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') input.blur();
      });
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (isFinite(v)) set(v);
      });
      return h('label', { class: 'ctl' }, h('span', { class: 'ctl-label' }, lab), input, h('span', { class: 'unit' }, unit));
    };
    return h(
      'div',
      { class: 'opts' },
      num('Ш', Math.abs(s.sx) * 100, '%', (v) => {
        if (!this.sess || v === 0) return;
        this.sess.s = { ...this.sess.s, sx: (Math.sign(this.sess.s.sx) * Math.abs(v)) / 100 };
        this.sync();
      }),
      num('В', Math.abs(s.sy) * 100, '%', (v) => {
        if (!this.sess || v === 0) return;
        this.sess.s = { ...this.sess.s, sy: (Math.sign(this.sess.s.sy) * Math.abs(v)) / 100 };
        this.sync();
      }),
      num('Угол', (s.rot * 180) / Math.PI, '°', (v) => {
        if (!this.sess) return;
        this.sess.s = { ...this.sess.s, rot: (v * Math.PI) / 180 };
        this.sync();
      }),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Отразить по горизонтали', 'data-tip': 'Отразить по горизонтали', html: icons.flipH, onclick: () => this.flip('h') }),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Отразить по вертикали', 'data-tip': 'Отразить по вертикали', html: icons.flipV, onclick: () => this.flip('v') }),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Повернуть на 90°', 'data-tip': 'Повернуть на 90° по часовой', html: icons.redo, onclick: () => this.rotateBy(90) }),
      button('Применить', () => this.apply(), { primary: true, icon: icons.check, tip: 'Enter' }),
      button('Отмена', () => this.cancel(), { ghost: true, tip: 'Esc' }),
      h('span', { class: 'hint' }, 'Shift — пропорционально / шаг 15°, Alt — от центра'),
    );
  }
}

