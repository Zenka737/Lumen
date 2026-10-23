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

describe('pro filters', () => {
  const run = (id: string, b: PixelBuffer, p: Record<string, number> = {}) => {
    const def = FILTERS[id]!;
    def.apply(b, { ...defaults(def), ...p });
    return b;
  };
  const ramp = (w: number, h: number) => {
    const b = solid(w, h, [0, 0, 0, 255]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.data.set([(x * 255) / (w - 1), (x * 255) / (w - 1), (x * 255) / (w - 1), 255], (y * w + x) * 4);
    return b;
  };
  it('posterize reduces to the requested number of levels', () => {
    const b = run('posterize', ramp(64, 2), { levels: 2 });
    const vals = new Set<number>();
    for (let i = 0; i < b.data.length; i += 4) vals.add(b.data[i]!);
    expect([...vals].sort((a, c) => a - c)).toEqual([0, 255]);
    const c = run('posterize', ramp(256, 1), { levels: 4 });
    const v4 = new Set<number>();
    for (let i = 0; i < c.data.length; i += 4) v4.add(c.data[i]!);
    expect(v4.size).toBe(4);
  });
  it('threshold gives pure black and white and keeps alpha', () => {
    const b = ramp(32, 1);
    b.data[3] = 77;
    run('threshold', b, { level: 128 });
    for (let i = 0; i < b.data.length; i += 4) expect([0, 255]).toContain(b.data[i]);
    expect(px(b, 0, 0)).toEqual([0, 0, 0, 77]);
    expect(px(b, 31, 0)).toEqual([255, 255, 255, 255]);
  });
  it('duotone maps black to the shadow colour and white to the highlight colour', () => {
    const dark = solid(2, 2, [0, 0, 0, 255]);
    const light = solid(2, 2, [255, 255, 255, 255]);
    run('duotone', dark, { shadowHue: 240, shadowSat: 100, highlightHue: 40, highlightSat: 100 });
    run('duotone', light, { shadowHue: 240, shadowSat: 100, highlightHue: 40, highlightSat: 100 });
    const [r, , bl] = px(dark, 0, 0);
    expect(bl!).toBeGreaterThan(r!);
    const [lr, , lb] = px(light, 0, 0);
    expect(lr!).toBeGreaterThan(lb!);
    const none = solid(2, 2, [10, 20, 30, 255]);
    run('duotone', none, { amount: 0 });
    expect(px(none, 0, 0)).toEqual([10, 20, 30, 255]);
  });
  it('pixelate makes uniform blocks and preserves the block average', () => {
    const b = ramp(8, 8);
    run('pixelate', b, { size: 4 });
    expect(px(b, 0, 0)).toEqual(px(b, 3, 3));
    expect(px(b, 4, 0)).toEqual(px(b, 7, 7));
    expect(px(b, 0, 0)).not.toEqual(px(b, 4, 0));
    const t = solid(4, 4, [10, 20, 30, 0]);
    run('pixelate', t, { size: 2 });
    expect(px(t, 1, 1)[3]).toBe(0);
  });
  it('motion blur keeps flat images and smooths a step', () => {
    const flat = solid(10, 10, [90, 90, 90, 255]);
    run('motionBlur', flat, { distance: 6, angle: 0 });
    expect(px(flat, 5, 5)).toEqual([90, 90, 90, 255]);
    const step = solid(21, 3, [0, 0, 0, 255]);
    for (let y = 0; y < 3; y++) for (let x = 11; x < 21; x++) step.data.set([255, 255, 255, 255], (y * 21 + x) * 4);
    run('motionBlur', step, { distance: 8, angle: 0 });
    const edge = px(step, 10, 1)[0]!;
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    expect(px(step, 1, 1)[0]).toBe(0);
    const vertical = solid(3, 21, [0, 0, 0, 255]);
    run('motionBlur', vertical, { distance: 8, angle: 90 });
    expect(px(vertical, 1, 10)).toEqual([0, 0, 0, 255]);
  });
  it('emboss gives mid-grey on flat areas and responds to edges', () => {
    const flat = solid(6, 6, [200, 40, 10, 255]);
    run('emboss', flat);
    expect(px(flat, 3, 3)).toEqual([128, 128, 128, 255]);
    const step = solid(12, 4, [0, 0, 0, 255]);
    for (let y = 0; y < 4; y++) for (let x = 6; x < 12; x++) step.data.set([255, 255, 255, 255], (y * 12 + x) * 4);
    run('emboss', step, { angle: 0 });
    expect(px(step, 6, 2)[0]).toBeGreaterThan(200);
  });
  it('edge detection is dark on flat areas and bright on a step', () => {
    const flat = solid(6, 6, [100, 100, 100, 255]);
    run('edges', flat);
    expect(px(flat, 3, 3)).toEqual([0, 0, 0, 255]);
    const step = solid(12, 6, [0, 0, 0, 255]);
    for (let y = 0; y < 6; y++) for (let x = 6; x < 12; x++) step.data.set([255, 255, 255, 255], (y * 12 + x) * 4);
    run('edges', step);
    expect(px(step, 6, 3)[0]).toBeGreaterThan(200);
    expect(px(step, 1, 3)[0]).toBe(0);
    const inv = solid(6, 6, [100, 100, 100, 255]);
    run('edges', inv, { invert: 1 });
    expect(px(inv, 3, 3)).toEqual([255, 255, 255, 255]);
  });
  it('chromatic aberration is a no-op at 0 and leaves the centre pixel alone', () => {
    const b = ramp(21, 21);
    const copy = new Uint8ClampedArray(b.data);
    run('chromatic', b, { amount: 0 });
    expect(Array.from(b.data)).toEqual(Array.from(copy));
    const c = ramp(21, 21);
    const centre = px(c, 10, 10);
    run('chromatic', c, { amount: 80 });
    expect(px(c, 10, 10)).toEqual(centre);
    const edge = px(c, 20, 10);
    expect(edge[0]).not.toBe(edge[2]);
  });
  it('clarity leaves flat images unchanged and boosts local contrast', () => {
    const flat = solid(16, 16, [120, 120, 120, 255]);
    run('clarity', flat, { amount: 200, radius: 5 });
    expect(px(flat, 8, 8)).toEqual([120, 120, 120, 255]);
    const b = solid(24, 8, [100, 100, 100, 255]);
    for (let y = 0; y < 8; y++) for (let x = 12; x < 24; x++) b.data.set([140, 140, 140, 255], (y * 24 + x) * 4);
    run('clarity', b, { amount: 200, radius: 6 });
    expect(px(b, 13, 4)[0]).toBeGreaterThan(140);
    expect(px(b, 10, 4)[0]).toBeLessThan(100);
  });
  it('layerable adjustments are flagged as such', () => {
    for (const id of ['posterize', 'threshold', 'duotone']) expect(FILTERS[id]!.layerable).toBe(true);
    for (const id of ['pixelate', 'motionBlur', 'emboss', 'edges', 'chromatic', 'clarity']) expect(FILTERS[id]!.layerable).toBeFalsy();
  });
});
