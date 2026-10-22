import type { Editor } from '../core/editor';
import { rulerStep } from '../core/guides';
import { h } from './dom';

const RULER = 20;

export interface RulersHandle {
  el: HTMLElement[];
  /** Index of the guide near a view point (CSS px), or −1. */
  hitGuide(sx: number, sy: number): number;
  /** Starts dragging guide `i` with the pointer of `e` (captured on `el`). */
  dragGuide(i: number, e: PointerEvent, el: HTMLElement): void;
  setVisible(on: boolean): void;
  readonly visible: boolean;
}

/**
 * Pixel rulers along the top/left edge of the view. Dragging out of a ruler creates a
 * guide; guides are moved with the Move tool and removed by dragging them back onto a ruler.
 */
export function createRulers(ed: Editor, canvas: HTMLCanvasElement): RulersHandle {
  const top = h('canvas', { class: 'ruler ruler-top', 'aria-hidden': 'true', 'data-tip': 'Потяните вниз — горизонтальная направляющая' });
  const left = h('canvas', { class: 'ruler ruler-left', 'aria-hidden': 'true', 'data-tip': 'Потяните вправо — вертикальная направляющая' });
  const corner = h('div', { class: 'ruler-corner', 'aria-hidden': 'true' });
  let visible = true;
  let cursor: { x: number; y: number } | null = null;
  let raf = 0;

  const draw = () => {
    raf = 0;
    if (!visible) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const vw = ed.view.width, vh = ed.view.height;
    const cs = getComputedStyle(top);
    const fg = cs.color || '#999';
    const bg = cs.backgroundColor || '#222';
    const { zoom, panX, panY } = ed.view;
    const step = rulerStep(zoom);
    const minor = step / (step % 5 === 0 ? 5 : step % 2 === 0 ? 2 : 1);
    const one = (c: HTMLCanvasElement, horiz: boolean) => {
      const len = horiz ? vw : vh;
      const W = Math.round((horiz ? len : RULER) * dpr), H = Math.round((horiz ? RULER : len) * dpr);
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
      }
      c.style.width = `${horiz ? len : RULER}px`;
      c.style.height = `${horiz ? RULER : len}px`;
      const x = c.getContext('2d');
      if (!x) return;
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.fillStyle = bg;
      x.fillRect(0, 0, W, H);
      x.strokeStyle = fg;
      x.fillStyle = fg;
      x.globalAlpha = 0.75;
      x.lineWidth = 1;
      x.font = '9px Inter, system-ui, sans-serif';
      const pan = horiz ? panX : panY;
      const d0 = Math.floor((-pan / zoom) / minor) * minor;
      const d1 = (len - pan) / zoom;
      x.beginPath();
      for (let d = d0; d <= d1; d += minor) {
        const p = Math.round(pan + d * zoom) + 0.5;
        const major = Math.abs(d / step - Math.round(d / step)) < 1e-6;
        const t = major ? RULER : RULER * 0.3;
        if (horiz) {
          x.moveTo(p, RULER);
          x.lineTo(p, RULER - t);
        } else {
          x.moveTo(RULER, p);
          x.lineTo(RULER - t, p);
        }
        if (major) {
          const label = String(Math.round(d));
          if (horiz) x.fillText(label, p + 3, 9);
          else {
            x.save();
            x.translate(9, p + 3);
            x.rotate(-Math.PI / 2);
            x.textAlign = 'right';
            x.fillText(label, 0, 0);
            x.restore();
          }
        }
      }
      x.stroke();
      x.globalAlpha = 1;
      // cursor marker
      if (cursor) {
        const p = pan + (horiz ? cursor.x : cursor.y) * zoom;
        x.strokeStyle = '#4f8cff';
        x.beginPath();
        if (horiz) {
          x.moveTo(p, 0);
          x.lineTo(p, RULER);
        } else {
          x.moveTo(0, p);
          x.lineTo(RULER, p);
        }
        x.stroke();
      }
    };
    one(top, true);
    one(left, false);
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(draw);
  };
  ed.events.on('view', schedule);
  ed.events.on('doc', schedule);
  ed.events.on('cursor', (c) => {
    cursor = c;
    schedule();
  });
  new ResizeObserver(schedule).observe(canvas);

  const local = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };

  const dragGuide = (i: number, e: PointerEvent, el: HTMLElement) => {
    const g = ed.doc.guides[i];
    if (!g) return;
    el.setPointerCapture(e.pointerId);
    if (ed.renderer) ed.renderer.hotGuide = i;
    const move = (ev: PointerEvent) => {
      const { sx, sy } = local(ev);
      const d = ed.view.toDoc(sx, sy);
      let pos = g.axis === 'v' ? d.x : d.y;
      if (ed.snapEnabled) {
        const lim = g.axis === 'v' ? ed.doc.width : ed.doc.height;
        for (const t of [0, lim / 2, lim]) if (Math.abs(t - pos) * ed.view.zoom < 6) pos = t;
      }
      ed.moveGuide(i, pos);
      ed.events.emit('cursor', d);
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (ed.renderer) ed.renderer.hotGuide = -1;
      const { sx, sy } = local(ev);
      // dropped back onto a ruler (or outside the view) → delete
      const off = sx < (visible ? RULER : 0) || sy < (visible ? RULER : 0) || sx > ed.view.width || sy > ed.view.height;
      if (off || ev.type === 'pointercancel') ed.removeGuide(i);
      else ed.renderer?.markView();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const fromRuler = (axis: 'h' | 'v') => (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const { sx, sy } = local(e);
    const d = ed.view.toDoc(sx, sy);
    const i = ed.addGuide(axis, axis === 'v' ? d.x : d.y);
    dragGuide(i, e, e.currentTarget as HTMLElement);
  };
  top.addEventListener('pointerdown', fromRuler('h'));
  left.addEventListener('pointerdown', fromRuler('v'));

  return {
    el: [top, left, corner],
    hitGuide(sx, sy) {
      if (!ed.renderer?.showGuides) return -1;
      const { zoom, panX, panY } = ed.view;
      const gs = ed.doc.guides;
      for (let i = gs.length - 1; i >= 0; i--) {
        const g = gs[i]!;
        const d = g.axis === 'v' ? Math.abs(panX + g.pos * zoom - sx) : Math.abs(panY + g.pos * zoom - sy);
        if (d <= 4) return i;
      }
      return -1;
    },
    dragGuide,
    setVisible(on) {
      visible = on;
      for (const el of [top, left, corner]) el.hidden = !on;
      if (on) schedule();
    },
    get visible() {
      return visible;
    },
  };
}
