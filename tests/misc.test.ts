import { describe, expect, it } from 'vitest';
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../src/core/color';
import { applyFill, floodMask } from '../src/core/floodfill';
import { rectClip, rectUnion } from '../src/core/types';
import { Viewport } from '../src/core/viewport';
import type { PixelBuffer } from '../src/core/types';

describe('color conversions', () => {
  it('hex <-> rgb round trip, short form, invalid input', () => {
    expect(hexToRgb('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(hexToRgb('abc')).toEqual({ r: 170, g: 187, b: 204 });
    expect(hexToRgb('#zzz')).toBeNull();
    expect(rgbToHex({ r: 255, g: 128, b: 0 })).toBe('#ff8000');
    expect(rgbToHex({ r: 300, g: -5, b: 7.6 })).toBe('#ff0008');
  });
  it('hsv round trip across the wheel', () => {
    for (let h = 0; h < 360; h += 37) {
      const rgb = hsvToRgb({ h, s: 0.7, v: 0.8 });
      const back = rgbToHsv(rgb);
      expect(Math.abs(back.h - h)).toBeLessThan(1.5);
      expect(Math.abs(back.s - 0.7)).toBeLessThan(0.02);
    }
  });
});

describe('flood fill', () => {
  // 5x5: left half white, right half black, column 2 is a black wall
  const make = (): PixelBuffer => {
    const w = 5, h = 5;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = x === 2 ? 0 : 255;
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
    return { data, width: w, height: h };
  };
  it('contiguous fill stops at walls', () => {
    const m = floodMask(make(), 0, 0, 10, true);
    expect(m.reduce((s, v) => s + v, 0)).toBe(10);
    expect(m[3]).toBe(0);
  });
  it('global fill selects all matching pixels', () => {
    const m = floodMask(make(), 0, 0, 10, false);
    expect(m.reduce((s, v) => s + v, 0)).toBe(20);
  });
  it('out of bounds seed gives empty mask; applyFill writes colour', () => {
    expect(floodMask(make(), -1, 0, 0).some((v) => v)).toBe(false);
    const b = make();
    const m = floodMask(b, 4, 4, 0, true);
    applyFill(b, m, [255, 0, 0, 255]);
    expect(Array.from(b.data.slice((4 * 5 + 4) * 4, (4 * 5 + 4) * 4 + 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(b.data.slice(0, 4))).toEqual([255, 255, 255, 255]);
  });
});

describe('viewport & rects', () => {
  it('zoomAt keeps the anchor point fixed', () => {
    const v = new Viewport();
    v.panX = 30;
    v.panY = 40;
    const before = v.toDoc(200, 150);
    v.zoomAt(3.5, 200, 150);
    const after = v.toDoc(200, 150);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
  it('fit makes the document fully visible and centred', () => {
    const v = new Viewport();
    v.width = 1000;
    v.height = 600;
    v.fit(4000, 2000, 0);
    expect(v.zoom).toBeCloseTo(0.25);
    expect(v.panY).toBe(50);
  });
  it('stepZoom moves through presets', () => {
    const v = new Viewport();
    v.stepZoom(1);
    expect(v.zoom).toBe(1.5);
    v.stepZoom(-1);
    v.stepZoom(-1);
    expect(v.zoom).toBe(0.667);
  });
  it('rect helpers', () => {
    expect(rectClip({ x: -5, y: 2.5, w: 10, h: 100 }, 20, 20)).toEqual({ x: 0, y: 2, w: 5, h: 18 });
    expect(rectClip({ x: 30, y: 0, w: 5, h: 5 }, 20, 20)).toBeNull();
    expect(rectUnion({ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: 5, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 6, h: 6 });
  });
});
