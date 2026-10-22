import { describe, expect, it } from 'vitest';
import { BLEND_MODES, blendChannel, blendPixel, toCompositeOp } from '../src/core/blend';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('blend math', () => {
  it('separable blend functions match W3C definitions', () => {
    close(blendChannel('multiply', 0.5, 0.5), 0.25);
    close(blendChannel('screen', 0.5, 0.5), 0.75);
    close(blendChannel('darken', 0.2, 0.7), 0.2);
    close(blendChannel('lighten', 0.2, 0.7), 0.7);
    close(blendChannel('difference', 0.2, 0.7), 0.5);
    // overlay = hard-light with swapped args
    close(blendChannel('overlay', 0.25, 0.8), 2 * 0.25 * 0.8);
    close(blendChannel('overlay', 0.75, 0.8), 1 - 2 * (1 - 0.75) * (1 - 0.8));
    // soft-light: neutral grey source leaves backdrop unchanged
    close(blendChannel('soft-light', 0.3, 0.5), 0.3);
    close(blendChannel('normal', 0.3, 0.9), 0.9);
  });

  it('every mode is identity-safe with black/white extremes in range', () => {
    for (const m of BLEND_MODES) {
      for (const cb of [0, 0.5, 1]) for (const cs of [0, 0.5, 1]) {
        const v = blendChannel(m.id, cb, cs);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('blendPixel: opaque normal replaces, transparent source keeps backdrop', () => {
    expect(blendPixel([10, 20, 30, 255], [200, 200, 200, 255], 'normal')).toEqual([10, 20, 30, 255]);
    expect(blendPixel([10, 20, 30, 0], [200, 100, 50, 255], 'multiply')).toEqual([200, 100, 50, 255]);
  });

  it('blendPixel: multiply white over colour is a no-op, over transparent backdrop is plain source', () => {
    expect(blendPixel([255, 255, 255, 255], [120, 60, 30, 255], 'multiply')).toEqual([120, 60, 30, 255]);
    expect(blendPixel([120, 60, 30, 255], [0, 0, 0, 0], 'multiply')).toEqual([120, 60, 30, 255]);
  });

  it('blendPixel respects layer opacity', () => {
    const out = blendPixel([255, 255, 255, 255], [0, 0, 0, 255], 'normal', 0.5);
    expect(out[3]).toBe(255);
    expect(out[0]).toBe(128);
  });

  it('maps to canvas composite operations', () => {
    expect(toCompositeOp('normal')).toBe('source-over');
    expect(toCompositeOp('soft-light')).toBe('soft-light');
  });
});
