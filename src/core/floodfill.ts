import type { PixelBuffer } from './types';

/**
 * Computes a fill mask (1 = fill) starting at (sx, sy). `tolerance` is the maximum
 * per-channel difference (0..255, RGBA) from the seed color. Scanline algorithm with
 * span-start pushes keeps the stack small even for huge regions.
 */
export function floodMask(
  buf: PixelBuffer,
  sx: number,
  sy: number,
  tolerance: number,
  contiguous = true,
): Uint8Array {
  const { width: w, height: h, data } = buf;
  const mask = new Uint8Array(w * h);
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const i0 = (sy * w + sx) * 4;
  const r0 = data[i0]!, g0 = data[i0 + 1]!, b0 = data[i0 + 2]!, a0 = data[i0 + 3]!;
  const t = Math.max(0, tolerance);
  const match = (p: number): boolean => {
    const i = p * 4;
    // Fully transparent pixels match each other regardless of their (meaningless) RGB.
    if (a0 === 0 && data[i + 3]! <= t) return true;
    return (
      Math.abs(data[i]! - r0) <= t &&
      Math.abs(data[i + 1]! - g0) <= t &&
      Math.abs(data[i + 2]! - b0) <= t &&
      Math.abs(data[i + 3]! - a0) <= t
    );
  };

  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (match(p)) mask[p] = 1;
    return mask;
  }

  const stack: number[] = [sy * w + sx];
  while (stack.length) {
    const p = stack.pop()!;
    if (mask[p] || !match(p)) continue;
    const y = (p / w) | 0;
    const row = y * w;
    let l = p - row;
    let r = l;
    while (l > 0 && !mask[row + l - 1] && match(row + l - 1)) l--;
    while (r < w - 1 && !mask[row + r + 1] && match(row + r + 1)) r++;
    let upIn = false;
    let dnIn = false;
    for (let x = l; x <= r; x++) {
      mask[row + x] = 1;
      if (y > 0) {
        const q = row - w + x;
        if (!mask[q] && match(q)) {
          if (!upIn) {
            stack.push(q);
            upIn = true;
          }
        } else upIn = false;
      }
      if (y < h - 1) {
        const q = row + w + x;
        if (!mask[q] && match(q)) {
          if (!dnIn) {
            stack.push(q);
            dnIn = true;
          }
        } else dnIn = false;
      }
    }
  }
  return mask;
}

/** Writes `color` into buf wherever mask=1, weighted by an optional selection alpha (0..255). */
export function applyFill(
  buf: PixelBuffer,
  mask: Uint8Array,
  color: [number, number, number, number],
  selAlpha?: Uint8ClampedArray | null,
): void {
  const d = buf.data;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const k = selAlpha ? selAlpha[p * 4 + 3]! / 255 : 1;
    if (k <= 0) continue;
    const i = p * 4;
    if (k >= 1) {
      d[i] = color[0];
      d[i + 1] = color[1];
      d[i + 2] = color[2];
      d[i + 3] = color[3];
    } else {
      d[i] = d[i]! + (color[0] - d[i]!) * k;
      d[i + 1] = d[i + 1]! + (color[1] - d[i + 1]!) * k;
      d[i + 2] = d[i + 2]! + (color[2] - d[i + 2]!) * k;
      d[i + 3] = d[i + 3]! + (color[3] - d[i + 3]!) * k;
    }
  }
}
