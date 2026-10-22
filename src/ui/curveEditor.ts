import { CURVE_CHANNELS, curveLut, MAX_CURVE_POINTS, normalizePoints, type CurvePoint, type Curves } from '../core/curves';
import { segmented } from './controls';
import { h } from './dom';

const COLORS = ['#e8e8e8', '#ff5a5a', '#43d17a', '#4f8cff'];

/** Luminance + per-channel histograms (256 bins each) of an RGBA buffer, subsampled. */
export function histograms(data: Uint8ClampedArray, maxSamples = 400_000): Uint32Array[] {
  const out = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const n = data.length / 4;
  const step = Math.max(1, Math.floor(n / maxSamples));
  for (let p = 0; p < n; p += step) {
    const i = p * 4;
    if (data[i + 3]! < 8) continue;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    out[0]![Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]!++;
    out[1]![r]!++;
    out[2]![g]!++;
    out[3]![b]!++;
  }
  return out;
}

/**
 * Interactive curve editor: click to add a point, drag to move, drag off the graph or
 * double-click to delete. Channel switch RGB / R / G / B.
 */
export function curveEditor(o: { curves: Curves; histogram?: Uint32Array[] | null; onChange(c: Curves, final: boolean): void }): { el: HTMLElement; set(c: Curves): void } {
  let curves = o.curves.map((c) => normalizePoints(c)) as Curves;
  let ch = 0;
  const SIZE = 256;
  const canvas = h('canvas', { class: 'curve-canvas', width: String(SIZE * 2), height: String(SIZE * 2), 'aria-label': 'Кривая (щелчок — добавить точку)' });
  const info = h('span', { class: 'hint mono' }, 'Вход: — · Выход: —');
  let active = -1;
  let drag: { idx: number; removed: boolean } | null = null;

  const toPt = (e: PointerEvent | MouseEvent): CurvePoint => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 255, (1 - (e.clientY - r.top) / r.height) * 255];
  };
  const draw = () => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    const sx = W / 255, sy = H / 255;
    ctx.clearRect(0, 0, W, H);
    // histogram
    const hist = o.histogram?.[ch];
    if (hist) {
      let max = 1;
      for (let i = 0; i < 256; i++) max = Math.max(max, hist[i]!);
      ctx.fillStyle = 'rgba(128,128,128,0.28)';
      const lm = Math.log(max + 1);
      for (let i = 0; i < 256; i++) {
        const v = (Math.log(hist[i]! + 1) / lm) * H;
        ctx.fillRect(i * sx, H - v, Math.ceil(sx), v);
      }
    }
    // grid
    ctx.strokeStyle = 'rgba(128,128,128,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      ctx.moveTo((W * i) / 4, 0);
      ctx.lineTo((W * i) / 4, H);
      ctx.moveTo(0, (H * i) / 4);
      ctx.lineTo(W, (H * i) / 4);
    }
    ctx.moveTo(0, H);
    ctx.lineTo(W, 0);
    ctx.stroke();
    // other channels faintly
    const plot = (pts: CurvePoint[], color: string, width: number, alpha: number) => {
      const lut = curveLut(pts);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let x = 0; x < 256; x++) {
        const px = x * sx, py = H - lut[x]! * sy;
        x ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    curves.forEach((pts, i) => {
      if (i !== ch && (pts.length > 2 || pts[0]![1] !== 0 || pts[1]![1] !== 255)) plot(pts, COLORS[i]!, 2, 0.35);
    });
    plot(curves[ch], ch === 0 ? getComputedStyle(canvas).color || '#ddd' : COLORS[ch]!, 3, 1);
    curves[ch].forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p[0] * sx, H - p[1] * sy, i === active ? 9 : 7, 0, Math.PI * 2);
      ctx.fillStyle = i === active ? '#4f8cff' : '#fff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
    const a = curves[ch][active];
    info.textContent = a ? `Вход: ${Math.round(a[0])} · Выход: ${Math.round(a[1])}` : 'Щелчок — добавить точку, двойной — удалить';
  };

  const nearest = (p: CurvePoint): number => {
    const r = canvas.getBoundingClientRect();
    const tol = (12 / r.width) * 255;
    let best = -1, bd = tol;
    curves[ch].forEach((q, i) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d <= bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const p = toPt(e);
    let idx = nearest(p);
    if (idx < 0) {
      if (curves[ch].length >= MAX_CURVE_POINTS) return;
      const pts = curves[ch].slice();
      const x = Math.max(1, Math.min(254, p[0]));
      pts.push([x, Math.max(0, Math.min(255, p[1]))]);
      pts.sort((a, b) => a[0] - b[0]);
      curves[ch] = pts;
      idx = pts.findIndex((q) => q[0] === x);
      o.onChange(curves, false);
    }
    active = idx;
    drag = { idx, removed: false };
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const pts = curves[ch].slice();
    const i = drag.idx;
    const p = toPt(e);
    const last = pts.length - 1;
    const outside = p[1] < -30 || p[1] > 285 || p[0] < -30 || p[0] > 285;
    if (outside && i !== 0 && i !== last) {
      if (!drag.removed) {
        drag.removed = true;
        curves[ch] = pts.filter((_, k) => k !== i);
        active = -1;
        o.onChange(curves, false);
        draw();
      }
      return;
    }
    if (drag.removed) return;
    const lo = i === 0 ? 0 : pts[i - 1]![0] + 1;
    const hi = i === last ? 255 : pts[i + 1]![0] - 1;
    pts[i] = [Math.max(lo, Math.min(hi, p[0])), Math.max(0, Math.min(255, p[1]))];
    curves[ch] = pts;
    o.onChange(curves, false);
    draw();
  });
  const up = () => {
    if (!drag) return;
    drag = null;
    o.onChange(curves, true);
    draw();
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('dblclick', (e) => {
    const i = nearest(toPt(e));
    if (i > 0 && i < curves[ch].length - 1) {
      curves[ch] = curves[ch].filter((_, k) => k !== i);
      active = -1;
      o.onChange(curves, true);
      draw();
    }
  });
  canvas.addEventListener('keydown', (e) => {
    // arrow keys nudge the selected point
    const pts = curves[ch];
    const a = pts[active];
    if (!a) return;
    const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    e.stopPropagation();
    const k = e.shiftKey ? 10 : 1;
    const next = pts.slice();
    next[active] = [Math.max(0, Math.min(255, a[0] + v[0] * k)), Math.max(0, Math.min(255, a[1] + v[1] * k))];
    curves[ch] = normalizePoints(next);
    o.onChange(curves, true);
    draw();
  });
  canvas.tabIndex = 0;

  const chans = segmented(
    CURVE_CHANNELS.map((c, i) => ({ id: String(i), label: c, tip: i === 0 ? 'Все каналы' : `Канал ${c}` })),
    '0',
    (v) => {
      ch = Number(v);
      active = -1;
      draw();
    },
  );
  const el = h('div', { class: 'curve-editor' }, chans, h('div', { class: 'curve-box' }, canvas), info);
  requestAnimationFrame(draw);
  return {
    el,
    set(c: Curves) {
      curves = c.map((x) => normalizePoints(x)) as Curves;
      active = -1;
      draw();
    },
  };
}
