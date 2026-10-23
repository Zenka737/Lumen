import { describe, expect, it } from 'vitest';
import { buildPalette, encodeGif, indexPixels, lzwEncode } from '../src/core/gif';

/** Reference LZW decoder for GIF (to prove the encoder round-trips). */
function lzwDecode(data: Uint8Array, minCode: number): number[] {
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict.push([i]);
    dict.push([], []);
    size = minCode + 1;
  };
  reset();
  const out: number[] = [];
  let bitPos = 0;
  let prev: number[] | null = null;
  const read = () => {
    let v = 0;
    for (let i = 0; i < size; i++) {
      const byte = data[(bitPos + i) >> 3] ?? 0;
      v |= ((byte >> ((bitPos + i) & 7)) & 1) << i;
    }
    bitPos += size;
    return v;
  };
  while (bitPos < data.length * 8) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code]!;
    else if (prev) entry = [...prev, prev[0]!];
    else throw new Error('bad code');
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]!]);
    prev = entry;
    if (dict.length === 1 << size && size < 12) size++;
  }
  return out;
}

const pixels = (colors: [number, number, number][], w: number, h: number) => {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = colors[i % colors.length]!;
    a.set([c[0], c[1], c[2], 255], i * 4);
  }
  return a;
};

describe('lzw', () => {
  it('round-trips short, repetitive and long random data', () => {
    const cases: number[][] = [[0], [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3], Array.from({ length: 5000 }, (_, i) => (i * 7 + (i >> 3)) % 16), Array.from({ length: 20000 }, () => Math.floor(Math.random() * 256))];
    for (const c of cases) {
      const min = Math.max(2, Math.ceil(Math.log2(Math.max(...c, 3) + 1)));
      const enc = lzwEncode(Uint8Array.from(c), min);
      expect(lzwDecode(enc, min)).toEqual(c);
    }
  });
});

describe('palette', () => {
  it('keeps distinct colours exactly when there are few', () => {
    const p = buildPalette(pixels([[255, 0, 0], [0, 255, 0], [0, 0, 255]], 3, 1), 256);
    expect(p).toHaveLength(3);
    const idx = indexPixels(pixels([[255, 0, 0], [0, 0, 255]], 2, 1), p);
    expect(p[idx[0]!]).toEqual([255, 0, 0]);
    expect(p[idx[1]!]).toEqual([0, 0, 255]);
  });
  it('limits the palette size', () => {
    const a = new Uint8ClampedArray(4 * 1000);
    for (let i = 0; i < 1000; i++) a.set([i % 256, (i * 3) % 256, (i * 7) % 256, 255], i * 4);
    expect(buildPalette(a, 16).length).toBeLessThanOrEqual(16);
  });
});

describe('gif file', () => {
  it('writes a valid header, loop block, frames and trailer', () => {
    const w = 4, h = 3;
    const bytes = encodeGif(w, h, [{ rgba: pixels([[255, 0, 0]], w, h), delayMs: 100 }, { rgba: pixels([[0, 0, 255], [255, 255, 255]], w, h), delayMs: 40 }]);
    expect(String.fromCharCode(...bytes.subarray(0, 6))).toBe('GIF89a');
    expect(bytes[6]! | (bytes[7]! << 8)).toBe(w);
    expect(bytes[8]! | (bytes[9]! << 8)).toBe(h);
    expect(bytes[bytes.length - 1]).toBe(0x3b);
    const text = String.fromCharCode(...bytes);
    expect(text).toContain('NETSCAPE2.0');
    expect(text.split('\x21\xf9\x04').length - 1).toBe(2);
  });
  it('frame data decodes back to the palette indices', () => {
    const w = 8, h = 8;
    const frame = pixels([[10, 20, 30], [200, 100, 50], [0, 0, 0]], w, h);
    const bytes = encodeGif(w, h, [{ rgba: frame, delayMs: 50 }]);
    // locate image descriptor and read its sub-blocks
    const i0 = bytes.indexOf(0x2c, 13);
    const minCode = bytes[i0 + 10]!;
    const chunks: number[] = [];
    let p = i0 + 11;
    while (bytes[p] !== 0) {
      const n = bytes[p]!;
      chunks.push(...bytes.subarray(p + 1, p + 1 + n));
      p += n + 1;
    }
    const idx = lzwDecode(Uint8Array.from(chunks), minCode);
    expect(idx).toHaveLength(w * h);
    const gct = bytes.subarray(13, 13 + 3 * (1 << ((bytes[10]! & 7) + 1)));
    for (let k = 0; k < w * h; k++) {
      const c = [gct[idx[k]! * 3], gct[idx[k]! * 3 + 1], gct[idx[k]! * 3 + 2]];
      expect(c).toEqual([...frame.subarray(k * 4, k * 4 + 3)]);
    }
  });
  it('rejects an empty animation', () => {
    expect(() => encodeGif(1, 1, [])).toThrow();
  });
});
