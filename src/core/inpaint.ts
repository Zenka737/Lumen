/**
 * "Healing-lite": fills a hole from its surroundings with a push–pull pyramid
 * (Gortler et al.). Known pixels keep their value; unknown pixels receive a smooth
 * membrane interpolated from the boundary. Pure / DOM-free.
 */
import type { PixelBuffer } from './types';

interface Level {
  w: number;
  h: number;
  /** premultiplied-by-weight RGBA */
  c: Float32Array;
  wt: Float32Array;
}

/**
 * `hole` holds 0..255 per pixel (255 = fully replace). Edits `buf` in place and also blends
 * the result by the hole value so soft brush edges stay soft.
 */
export function inpaint(buf: PixelBuffer, hole: ArrayLike<number>): void {
  const { width: W, height: H, data } = buf;
  const n = W * H;
  const base: Level = { w: W, h: H, c: new Float32Array(n * 4), wt: new Float32Array(n) };
  let anyKnown = false;
  for (let p = 0; p < n; p++) {
    const k = hole[p]! >= 8 ? 0 : 1;
    base.wt[p] = k;
    if (k) anyKnown = true;
    for (let ch = 0; ch < 4; ch++) base.c[p * 4 + ch] = data[p * 4 + ch]! * k;
  }
  if (!anyKnown) return;
  // pull: build coarser levels
  const levels: Level[] = [base];
  while (levels[levels.length - 1]!.w > 1 || levels[levels.length - 1]!.h > 1) {
    const f = levels[levels.length - 1]!;
    const w = Math.max(1, Math.ceil(f.w / 2)), h = Math.max(1, Math.ceil(f.h / 2));
    const L: Level = { w, h, c: new Float32Array(w * h * 4), wt: new Float32Array(w * h) };
    for (let y = 0; y < f.h; y++)
      for (let x = 0; x < f.w; x++) {
        const fp = y * f.w + x, cp = (y >> 1) * w + (x >> 1);
        L.wt[cp] += f.wt[fp]!;
        for (let ch = 0; ch < 4; ch++) L.c[cp * 4 + ch] += f.c[fp * 4 + ch]!;
      }
    // normalise so weights saturate at 1 (keeps colour = c / wt)
    for (let p = 0; p < w * h; p++) {
      const s = L.wt[p]!;
      if (s > 1) {
        for (let ch = 0; ch < 4; ch++) L.c[p * 4 + ch] /= s;
        L.wt[p] = 1;
      }
    }
    levels.push(L);
  }
  // push: fill each level's missing weight from the (already filled) coarser level
  for (let li = levels.length - 2; li >= 0; li--) {
    const f = levels[li]!, c = levels[li + 1]!;
    for (let y = 0; y < f.h; y++)
      for (let x = 0; x < f.w; x++) {
        const fp = y * f.w + x;
        const miss = 1 - Math.min(1, f.wt[fp]!);
        if (miss <= 0) continue;
        // bilinear sample of the coarse level (colour = c / wt, coarse already fully filled)
        const gx = Math.min(c.w - 1, Math.max(0, (x - 0.5) / 2)), gy = Math.min(c.h - 1, Math.max(0, (y - 0.5) / 2));
        const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(c.w - 1, x0 + 1), y1 = Math.min(c.h - 1, y0 + 1);
        const tx = gx - x0, ty = gy - y0;
        const taps: [number, number][] = [
          [y0 * c.w + x0, (1 - tx) * (1 - ty)],
          [y0 * c.w + x1, tx * (1 - ty)],
          [y1 * c.w + x0, (1 - tx) * ty],
          [y1 * c.w + x1, tx * ty],
        ];
        for (let ch = 0; ch < 4; ch++) {
          let v = 0, ws = 0;
          for (const [cp, wgt] of taps) {
            const cw = c.wt[cp]!;
            if (cw <= 0) continue;
            v += (c.c[cp * 4 + ch]! / cw) * wgt;
            ws += wgt;
          }
          if (ws > 0) f.c[fp * 4 + ch] += (v / ws) * miss;
        }
        f.wt[fp] = 1;
      }
  }
  for (let p = 0; p < n; p++) {
    const k = hole[p]! / 255;
    if (k <= 0) continue;
    const wt = base.wt[p]! || 1;
    for (let ch = 0; ch < 4; ch++) {
      const filled = base.c[p * 4 + ch]! / wt;
      data[p * 4 + ch] = data[p * 4 + ch]! * (1 - k) + filled * k;
    }
  }
}
