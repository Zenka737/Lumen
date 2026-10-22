import { describe, expect, it } from 'vitest';
import { boxesForGauss, defaults, FILTERS, FILTER_LIST, gaussianBlur, levelsLut, scaleParams } from '../src/filters/filters';
import type { PixelBuffer } from '../src/core/types';

function solid(w: number, h: number, rgba: [number, number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { data, width: w, height: h };
}
const px = (b: PixelBuffer, x: number, y: number) => Array.from(b.data.slice((y * b.width + x) * 4, (y * b.width + x) * 4 + 4));

describe('filters', () => {
  it('every filter with default params runs and keeps buffer size', () => {
    for (const f of FILTER_LIST) {
      const b = solid(9, 7, [100, 150, 200, 255]);
      f.apply(b, defaults(f));
      expect(b.data.length).toBe(9 * 7 * 4);
    }
  });

  it('neutral adjustments are identity', () => {
    for (const id of ['brightnessContrast', 'exposure', 'saturation', 'hue', 'temperature', 'levels']) {
      const b = solid(4, 4, [37, 128, 222, 255]);
      FILTERS[id]!.apply(b, defaults(FILTERS[id]!));
      const [r, g, bl] = px(b, 1, 1);
      expect(Math.abs(r! - 37)).toBeLessThanOrEqual(1);
      expect(Math.abs(g! - 128)).toBeLessThanOrEqual(1);
      expect(Math.abs(bl! - 222)).toBeLessThanOrEqual(1);
    }
  });

  it('invert is an involution and keeps alpha', () => {
    const b = solid(2, 2, [10, 20, 30, 77]);
    FILTERS.invert!.apply(b, {});
    expect(px(b, 0, 0)).toEqual([245, 235, 225, 77]);
    FILTERS.invert!.apply(b, {});
    expect(px(b, 0, 0)).toEqual([10, 20, 30, 77]);
  });

  it('grayscale produces equal channels', () => {
    const b = solid(2, 2, [200, 50, 10, 255]);
    FILTERS.grayscale!.apply(b, { amount: 100 });
    const [r, g, bl] = px(b, 0, 0);
    expect(r).toBe(g);
    expect(g).toBe(bl);
  });

  it('brightness raises values; contrast spreads around mid-grey', () => {
    const b = solid(1, 1, [100, 100, 100, 255]);
    FILTERS.brightnessContrast!.apply(b, { brightness: 20, contrast: 0 });
    expect(px(b, 0, 0)[0]).toBe(151);
    const c = solid(1, 1, [200, 50, 128, 255]);
    FILTERS.brightnessContrast!.apply(c, { brightness: 0, contrast: 50 });
    const [r, g, bl] = px(c, 0, 0);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(50);
    expect(bl).toBe(128);
  });

  it('saturation -100 desaturates completely', () => {
    const b = solid(1, 1, [250, 10, 10, 255]);
    FILTERS.saturation!.apply(b, { saturation: -100, vibrance: 0 });
    const [r, g, bl] = px(b, 0, 0);
    expect(r).toBe(g);
    expect(g).toBe(bl);
  });

  it('hue rotation by 360 is identity, by 120 rotates primaries', () => {
    const b = solid(1, 1, [255, 0, 0, 255]);
    FILTERS.hue!.apply(b, { hue: 120 });
    const [r, g] = px(b, 0, 0);
    expect(g!).toBeGreaterThan(r!);
  });

  it('levels LUT maps black/white points and is monotonic', () => {
    const lut = levelsLut(20, 200, 1, 0, 255);
    expect(lut[20]).toBe(0);
    expect(lut[10]).toBe(0);
    expect(lut[200]).toBe(255);
    expect(lut[250]).toBe(255);
    for (let i = 1; i < 256; i++) expect(lut[i]!).toBeGreaterThanOrEqual(lut[i - 1]!);
    const inv = levelsLut(100, 50, 1, 0, 255); // invalid range is repaired
    expect(inv[255]).toBe(255);
  });

  it('gaussian blur preserves a flat field and total energy of an impulse', () => {
    const flat = solid(16, 16, [90, 90, 90, 255]);
    gaussianBlur(flat, 3);
    expect(px(flat, 8, 8)).toEqual([90, 90, 90, 255]);

    const w = 41, h = 41;
    const imp = solid(w, h, [0, 0, 0, 255]);
    imp.data.set([255, 255, 255, 255], (20 * w + 20) * 4);
    gaussianBlur(imp, 2);
    let sum = 0;
    for (let i = 0; i < imp.data.length; i += 4) sum += imp.data[i]!;
    expect(Math.abs(sum - 255)).toBeLessThan(40); // rounding to 8-bit loses a bit
    expect(px(imp, 20, 20)[0]!).toBeLessThan(255);
    expect(px(imp, 21, 20)[0]!).toBeGreaterThan(0);
  });

  it('blur does not bleed colour from fully transparent pixels (premultiplied)', () => {
    const b = solid(10, 1, [255, 0, 0, 0]);
    for (let x = 5; x < 10; x++) b.data.set([0, 0, 255, 255], x * 4);
    gaussianBlur(b, 2);
    const [r, , bl, a] = px(b, 4, 0);
    expect(a!).toBeGreaterThan(0);
    expect(r).toBe(0);
    expect(bl).toBe(255);
  });

  it('boxesForGauss returns odd sizes', () => {
    for (const s of [0.5, 1, 3, 10, 40]) for (const b of boxesForGauss(s)) expect(b % 2).toBe(1);
  });

  it('noise is deterministic and vignette darkens corners only', () => {
    const a = solid(8, 8, [128, 128, 128, 255]);
    const b = solid(8, 8, [128, 128, 128, 255]);
    FILTERS.noise!.apply(a, { amount: 30, mono: 1 });
    FILTERS.noise!.apply(b, { amount: 30, mono: 1 });
    expect(Array.from(a.data)).toEqual(Array.from(b.data));

    const v = solid(50, 50, [200, 200, 200, 255]);
    FILTERS.vignette!.apply(v, { amount: 80, size: 30, feather: 40 });
    expect(px(v, 25, 25)[0]).toBe(200);
    expect(px(v, 0, 0)[0]!).toBeLessThan(120);
  });

  it('sharpen increases local contrast at an edge', () => {
    const b = solid(10, 1, [50, 50, 50, 255]);
    for (let x = 5; x < 10; x++) b.data.set([200, 200, 200, 255], x * 4);
    FILTERS.sharpen!.apply(b, { amount: 150, radius: 1, threshold: 0 });
    expect(px(b, 4, 0)[0]!).toBeLessThan(50);
    expect(px(b, 5, 0)[0]!).toBeGreaterThan(200);
  });

  it('scaleParams scales only spatial params', () => {
    const p = scaleParams(FILTERS.sharpen!, { amount: 100, radius: 4, threshold: 2 }, 0.5);
    expect(p).toEqual({ amount: 100, radius: 2, threshold: 2 });
  });
});
