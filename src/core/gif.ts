/** Minimal animated GIF89a encoder (global palette via median cut, LZW). DOM-free. */

export type Rgb = [number, number, number];

/** Median-cut palette (up to `maxColors`, power of two padded) from RGBA samples. */
export function buildPalette(rgba: Uint8ClampedArray | Uint8Array, maxColors = 256, step = 1): Rgb[] {
  const px: Rgb[] = [];
  for (let i = 0; i < rgba.length; i += 4 * step) px.push([rgba[i]!, rgba[i + 1]!, rgba[i + 2]!]);
  if (px.length === 0) return [[0, 0, 0]];
  let boxes: Rgb[][] = [px];
  while (boxes.length < maxColors) {
    // split the box with the widest channel range (and more than one distinct colour)
    let bi = -1, best = 0, ch = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of b) {
          if (p[c]! < lo) lo = p[c]!;
          if (p[c]! > hi) hi = p[c]!;
        }
        const range = (hi - lo) * Math.sqrt(b.length);
        if (hi > lo && range > best) {
          best = range;
          bi = i;
          ch = c;
        }
      }
    });
    if (bi < 0) break;
    const b = boxes[bi]!;
    b.sort((p, q) => p[ch]! - q[ch]!);
    const mid = b.length >> 1;
    boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }
  boxes = boxes.filter((b) => b.length > 0);
  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0;
    for (const p of b) {
      r += p[0]!;
      g += p[1]!;
      bl += p[2]!;
    }
    return [Math.round(r / b.length), Math.round(g / b.length), Math.round(bl / b.length)] as Rgb;
  });
}

/** Maps RGBA pixels to palette indices (nearest colour, memoised on 15-bit colour). */
export function indexPixels(rgba: Uint8ClampedArray | Uint8Array, palette: Rgb[]): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  const cache = new Int16Array(32768).fill(-1);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = cache[key]!;
    if (idx < 0) {
      let best = Infinity;
      idx = 0;
      for (let p = 0; p < palette.length; p++) {
        const c = palette[p]!;
        const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
        if (d < best) {
          best = d;
          idx = p;
          if (d === 0) break;
        }
      }
      cache[key] = idx;
    }
    out[j] = idx;
  }
  return out;
}

/** GIF-flavoured variable-width LZW (LSB first). */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  const out: number[] = [];
  let cur = 0, bits = 0;
  const emit = (code: number, size: number) => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(cur & 255);
      cur >>>= 8;
      bits -= 8;
    }
  };
  let size = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map<number, number>();
  emit(clear, size);
  if (indices.length === 0) {
    emit(eoi, size);
  } else {
    let prefix = indices[0]!;
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i]!;
      const key = (prefix << 8) | k;
      const hit = dict.get(key);
      if (hit !== undefined) {
        prefix = hit;
        continue;
      }
      emit(prefix, size);
      if (next < 4096) {
        dict.set(key, next++);
        if (next - 1 === 1 << size && size < 12) size++;
      } else {
        emit(clear, size);
        dict = new Map();
        size = minCodeSize + 1;
        next = eoi + 1;
      }
      prefix = k;
    }
    emit(prefix, size);
    emit(eoi, size);
  }
  if (bits > 0) out.push(cur & 255);
  return Uint8Array.from(out);
}

export interface GifFrame {
  /** RGBA, width*height*4 */
  rgba: Uint8ClampedArray | Uint8Array;
  /** Display time in milliseconds. */
  delayMs: number;
}

export function encodeGif(width: number, height: number, frames: GifFrame[], opts: { loop?: boolean; maxColors?: number } = {}): Uint8Array {
  if (frames.length === 0) throw new Error('GIF: нет кадров');
  const bytes: number[] = [];
  const w16 = (v: number) => bytes.push(v & 255, (v >> 8) & 255);
  // palette from a sample of every frame
  const sample: number[] = [];
  const per = Math.max(1, Math.floor((width * height) / 4000));
  const merged = new Uint8Array(Math.ceil((width * height * frames.length) / per) * 4);
  let m = 0;
  for (const f of frames) for (let i = 0; i < width * height; i += per) {
    merged[m++] = f.rgba[i * 4]!;
    merged[m++] = f.rgba[i * 4 + 1]!;
    merged[m++] = f.rgba[i * 4 + 2]!;
    merged[m++] = 255;
  }
  void sample;
  const pal = buildPalette(merged.subarray(0, m), Math.min(256, opts.maxColors ?? 256));
  let bitsPer = 1;
  while (1 << bitsPer < pal.length) bitsPer++;
  while (pal.length < 1 << bitsPer) pal.push([0, 0, 0]);
  for (const c of 'GIF89a') bytes.push(c.charCodeAt(0));
  w16(width);
  w16(height);
  bytes.push(0x80 | 0x70 | (bitsPer - 1), 0, 0);
  for (const c of pal) bytes.push(c[0], c[1], c[2]);
  if (opts.loop !== false) bytes.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
  const minCode = Math.max(2, bitsPer);
  for (const f of frames) {
    bytes.push(0x21, 0xf9, 4, 0x04, 0, 0, 0, 0); // GCE: disposal 1, no transparency
    const gce = bytes.length - 8;
    const cs = Math.max(2, Math.round(f.delayMs / 10));
    bytes[gce + 4] = cs & 255;
    bytes[gce + 5] = (cs >> 8) & 255;
    bytes.push(0x2c);
    w16(0);
    w16(0);
    w16(width);
    w16(height);
    bytes.push(0);
    bytes.push(minCode);
    const data = lzwEncode(indexPixels(f.rgba, pal), minCode);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      bytes.push(n);
      for (let j = 0; j < n; j++) bytes.push(data[i + j]!);
    }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}
