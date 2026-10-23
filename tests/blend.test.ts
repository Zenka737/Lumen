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

describe('extra blend modes', () => {
  const lumOf = (c: number[]) => 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;
  it('separable: hard-light, exclusion, dodge, burn', async () => {
    const { blendChannel } = await import('../src/core/blend');
    close(blendChannel('hard-light', 0.4, 0.25), 2 * 0.4 * 0.25);
    close(blendChannel('hard-light', 0.4, 0.75), 0.4 + (2 * 0.75 - 1) - 0.4 * (2 * 0.75 - 1));
    close(blendChannel('exclusion', 0.5, 0.5), 0.5);
    close(blendChannel('exclusion', 1, 1), 0);
    close(blendChannel('color-dodge', 0.25, 0.5), 0.5);
    close(blendChannel('color-dodge', 0, 1), 0);
    close(blendChannel('color-dodge', 0.5, 1), 1);
    close(blendChannel('color-burn', 0.75, 0.5), 0.5);
    close(blendChannel('color-burn', 1, 0), 1);
    close(blendChannel('color-burn', 0.5, 0), 0);
  });
  it('non-separable modes: a colour blended with itself is unchanged', async () => {
    const { blendRgb } = await import('../src/core/blend');
    const c: [number, number, number] = [0.8, 0.4, 0.2];
    for (const m of ['hue', 'saturation', 'color', 'luminosity'] as const) {
      const r = blendRgb(m, c, c);
      for (let i = 0; i < 3; i++) close(r[i]!, c[i]!, 1e-9);
    }
  });
  it('luminosity keeps the backdrop colour but takes the source brightness', async () => {
    const { blendRgb } = await import('../src/core/blend');
    const r = blendRgb('luminosity', [1, 0, 0], [0.5, 0.5, 0.5]);
    close(lumOf(r), 0.5, 1e-6);
    expect(r[0]).toBeGreaterThan(r[1]!);
  });
  it('color keeps the backdrop brightness but takes the source colour', async () => {
    const { blendRgb } = await import('../src/core/blend');
    const r = blendRgb('color', [0.5, 0.5, 0.5], [1, 0, 0]);
    close(lumOf(r), 0.5, 1e-6);
    expect(r[0]).toBeGreaterThan(r[2]!);
  });
  it('saturation of a grey source desaturates; hue of a grey backdrop stays grey', async () => {
    const { blendRgb } = await import('../src/core/blend');
    const gray = blendRgb('saturation', [0.9, 0.3, 0.1], [0.5, 0.5, 0.5]);
    close(gray[0]!, gray[1]!, 1e-6);
    close(gray[1]!, gray[2]!, 1e-6);
    const g2 = blendRgb('hue', [0.5, 0.5, 0.5], [1, 0, 0]);
    close(g2[0]!, g2[1]!, 1e-6);
  });
  it('all non-separable results stay in range', async () => {
    const { blendRgb, BLEND_MODES } = await import('../src/core/blend');
    const vals = [0, 0.25, 0.7, 1];
    for (const m of BLEND_MODES) for (const a of vals) for (const b of vals) for (const c of vals) {
      const r = blendRgb(m.id, [a, b, c], [c, a, b]);
      for (const v of r) {
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
  it('blendPixel works for non-separable modes and every mode maps to a canvas operation', async () => {
    const { blendPixel, toCompositeOp, BLEND_MODES } = await import('../src/core/blend');
    expect(blendPixel([255, 0, 0, 255], [128, 128, 128, 255], 'color')).toEqual([blendPixel([255, 0, 0, 255], [128, 128, 128, 255], 'color')[0], blendPixel([255, 0, 0, 255], [128, 128, 128, 255], 'color')[1], blendPixel([255, 0, 0, 255], [128, 128, 128, 255], 'color')[2], 255]);
    const ops = new Set(['source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);
    for (const m of BLEND_MODES) expect(ops.has(toCompositeOp(m.id))).toBe(true);
  });
});
