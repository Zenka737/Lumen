/**
 * Non-destructive layer styles (drop shadow, outer glow, outline, colour / gradient overlay).
 * The effects are kept as data on the layer and rendered at composite time.
 */
import { createCanvas, ctx2d } from './canvas';
import type { LayerFx } from './types';

export const MAX_FX_PAD = 400;

export function defaultFx(): Required<LayerFx> {
  return {
    shadow: { on: false, color: '#000000', opacity: 0.45, dx: 6, dy: 8, blur: 14 },
    glow: { on: false, color: '#7aa2ff', opacity: 0.9, blur: 18, strength: 2 },
    stroke: { on: false, color: '#000000', width: 4, pos: 'outside', opacity: 1 },
    overlay: { on: false, mode: 'gradient', color: '#ff6a3d', color2: '#7a4dff', angle: 90, opacity: 1 },
  };
}

/** True if at least one effect is switched on. */
export function hasFx(fx: LayerFx | undefined): boolean {
  return !!fx && !!(fx.shadow?.on || fx.glow?.on || fx.stroke?.on || fx.overlay?.on);
}

/** Extra canvas margin (px, each side) the enabled effects need around the layer. */
export function fxPad(fx: LayerFx | undefined): number {
  if (!fx) return 0;
  let p = 0;
  if (fx.shadow?.on) p = Math.max(p, Math.ceil(Math.max(Math.abs(fx.shadow.dx), Math.abs(fx.shadow.dy)) + fx.shadow.blur * 2));
  if (fx.glow?.on) p = Math.max(p, Math.ceil(fx.glow.blur * 2));
  if (fx.stroke?.on && fx.stroke.pos !== 'inside') p = Math.max(p, Math.ceil(fx.stroke.pos === 'center' ? fx.stroke.width / 2 : fx.stroke.width) + 1);
  return Math.min(MAX_FX_PAD, p);
}

/** Offsets for approximating a morphological dilation by `r` pixels. */
export function dilationOffsets(r: number): [number, number][] {
  const out: [number, number][] = [[0, 0]];
  if (r <= 0) return out;
  for (const rr of r > 3 ? [r, r * 0.66, r * 0.33] : [r]) {
    const n = Math.max(8, Math.min(48, Math.ceil(2 * Math.PI * rr)));
    for (let i = 0; i < n; i++) out.push([Math.cos((i * 2 * Math.PI) / n) * rr, Math.sin((i * 2 * Math.PI) / n) * rr]);
  }
  return out;
}

/** Copy of `src` (placed at (ox, oy) in a w×h canvas) filled with a flat colour, keeping its alpha. */
function silhouette(src: CanvasImageSource, w: number, h: number, ox: number, oy: number, color: string): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const x = ctx2d(c);
  x.drawImage(src, ox, oy);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color;
  x.fillRect(0, 0, w, h);
  return c;
}

function dilate(mask: HTMLCanvasElement, r: number): HTMLCanvasElement {
  const out = createCanvas(mask.width, mask.height);
  const x = ctx2d(out);
  for (const [dx, dy] of dilationOffsets(r)) x.drawImage(mask, dx, dy);
  return out;
}

/** Renders the layer with its styles; the result is `pad` px larger on every side. */
export function renderFx(src: HTMLCanvasElement, fx: LayerFx): { canvas: HTMLCanvasElement; pad: number } {
  const pad = fxPad(fx);
  const w = src.width + pad * 2, h = src.height + pad * 2;
  const out = createCanvas(w, h);
  const ctx = ctx2d(out);

  // blurred, tinted copies underneath the layer
  const underlay = (color: string, opacity: number, dx: number, dy: number, blur: number, times = 1) => {
    const sil = silhouette(src, w, h, pad, pad, color);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
    if (blur > 0) ctx.filter = `blur(${blur / 2}px)`;
    for (let i = 0; i < times; i++) ctx.drawImage(sil, dx, dy);
    ctx.restore();
  };
  if (fx.shadow?.on) underlay(fx.shadow.color, fx.shadow.opacity, fx.shadow.dx, fx.shadow.dy, fx.shadow.blur);
  if (fx.glow?.on) underlay(fx.glow.color, fx.glow.opacity, 0, 0, fx.glow.blur, Math.max(1, Math.round(fx.glow.strength)));

  const st = fx.stroke;
  if (st?.on && st.width > 0 && st.pos !== 'inside') {
    const r = st.pos === 'center' ? st.width / 2 : st.width;
    const ring = dilate(silhouette(src, w, h, pad, pad, st.color), r);
    ctx.save();
    ctx.globalAlpha = st.opacity;
    ctx.drawImage(ring, 0, 0);
    ctx.restore();
  }

  ctx.drawImage(src, pad, pad);

  const ov = fx.overlay;
  if (ov?.on) {
    const t = createCanvas(w, h);
    const tx = ctx2d(t);
    tx.drawImage(src, pad, pad);
    tx.globalCompositeOperation = 'source-in';
    if (ov.mode === 'gradient') {
      const a = (ov.angle * Math.PI) / 180;
      const cx = pad + src.width / 2, cy = pad + src.height / 2;
      const rx = (Math.cos(a) * src.width) / 2, ry = (Math.sin(a) * src.height) / 2;
      const g = tx.createLinearGradient(cx - rx, cy - ry, cx + rx, cy + ry);
      g.addColorStop(0, ov.color);
      g.addColorStop(1, ov.color2);
      tx.fillStyle = g;
    } else tx.fillStyle = ov.color;
    tx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.globalAlpha = ov.opacity;
    ctx.drawImage(t, 0, 0);
    ctx.restore();
  }

  if (st?.on && st.width > 0 && (st.pos === 'inside' || st.pos === 'center')) {
    // inside part of the outline: layer pixels that lie within `r` of the outside
    const r = st.pos === 'center' ? st.width / 2 : st.width;
    const inverse = createCanvas(w, h);
    const ix = ctx2d(inverse);
    ix.fillStyle = '#000';
    ix.fillRect(0, 0, w, h);
    ix.globalCompositeOperation = 'destination-out';
    ix.drawImage(src, pad, pad);
    const band = dilate(inverse, r);
    const bx = ctx2d(band);
    bx.globalCompositeOperation = 'destination-in';
    bx.drawImage(src, pad, pad);
    bx.globalCompositeOperation = 'source-in';
    bx.fillStyle = st.color;
    bx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.globalAlpha = st.opacity;
    ctx.drawImage(band, 0, 0);
    ctx.restore();
  }
  return { canvas: out, pad };
}
