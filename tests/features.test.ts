import { describe, expect, it } from 'vitest';
import { curveLut, curvesLuts, decodeCurves, encodeCurves, identityCurves, isIdentityCurve, normalizePoints, type Curves } from '../src/core/curves';
import { rulerStep, snapPoint, snapRectOffset, snapTargets, snapValue } from '../src/core/guides';
import { inpaint } from '../src/core/inpaint';
import { combineMasks, distanceSq, featherMask, growMask, invertMask, maskBounds, maskOutline } from '../src/core/maskOps';
import { sanitizeAdjust, sanitizeGuides, sanitizeMeta, sanitizeShape, sanitizeText } from '../src/core/project';
import { applyMatrix, dragHandle, dragRotate, hitInside, initialXform, invertMatrix, isPureTranslation, xformBounds, xformCorners, xformMatrix } from '../src/core/transform';
import { cloneMeta, type LayerMeta } from '../src/core/types';
import { FILTERS, hasControls } from '../src/filters/filters';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('curves', () => {
  it('identity curve gives identity LUT', () => {
    const l = curveLut([[0, 0], [255, 255]]);
    for (let i = 0; i < 256; i++) expect(l[i]).toBe(i);
    expect(isIdentityCurve([[0, 0], [255, 255]])).toBe(true);
  });
  it('passes through control points and stays monotone', () => {
    const l = curveLut([[0, 0], [128, 200], [255, 255]]);
    expect(l[128]).toBe(200);
    expect(l[0]).toBe(0);
    expect(l[255]).toBe(255);
    for (let i = 1; i < 256; i++) expect(l[i]!).toBeGreaterThanOrEqual(l[i - 1]!);
  });
  it('clamps outside the end points (black/white point)', () => {
    const l = curveLut([[50, 0], [200, 255]]);
    expect(l[10]).toBe(0);
    expect(l[230]).toBe(255);
    expect(l[125]).toBeGreaterThan(110);
    expect(l[125]).toBeLessThan(145);
  });
  it('inverted curve', () => {
    const l = curveLut([[0, 255], [255, 0]]);
    expect(l[0]).toBe(255);
    expect(l[255]).toBe(0);
    expect(Math.abs(l[100]! - 155)).toBeLessThanOrEqual(1);
  });
  it('normalises unsorted / duplicate / out-of-range points', () => {
    expect(normalizePoints([[300, 10], [0, -5], [0, 20]])).toEqual([[0, 20], [255, 10]]);
    expect(normalizePoints([])).toEqual([[0, 0], [255, 255]]);
  });
  it('encode/decode round trip through numeric params', () => {
    const c: Curves = identityCurves();
    c[0] = [[0, 0], [64, 90], [255, 255]];
    c[2] = [[0, 30], [255, 220]];
    const back = decodeCurves(encodeCurves(c));
    expect(back).toEqual(c);
  });
  it('master curve applies after channel curves; filter uses them', () => {
    const c = identityCurves();
    c[1] = [[0, 0], [255, 128]]; // red halved
    c[0] = [[0, 255], [255, 0]]; // then inverted
    const [r, g] = curvesLuts(c);
    expect(r[255]).toBe(127);
    expect(g[0]).toBe(255);
    const buf = { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) };
    FILTERS.curves!.apply(buf, encodeCurves(c));
    expect(Array.from(buf.data)).toEqual([127, 255, 255, 255]);
    expect(hasControls(FILTERS.curves!)).toBe(true);
  });
});

describe('hue/saturation filter', () => {
  it('-100 saturation makes grey, hue 120 rotates red to green', () => {
    const buf = { width: 1, height: 1, data: new Uint8ClampedArray([200, 50, 50, 255]) };
    FILTERS.hueSat!.apply(buf, { hue: 0, saturation: -100, lightness: 0 });
    expect(buf.data[0]).toBe(buf.data[1]);
    expect(buf.data[1]).toBe(buf.data[2]);
    const red = { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) };
    FILTERS.hueSat!.apply(red, { hue: 120, saturation: 0, lightness: 0 });
    expect(Array.from(red.data)).toEqual([0, 255, 0, 255]);
  });
});

describe('mask operations', () => {
  const W = 9, H = 9;
  const square = () => {
    const a = new Uint8ClampedArray(W * H);
    for (let y = 3; y <= 5; y++) for (let x = 3; x <= 5; x++) a[y * W + x] = 255;
    return a;
  };
  it('distance transform is exact Euclidean', () => {
    const d = distanceSq(5, 1, (p) => p === 0);
    expect(Array.from(d)).toEqual([0, 1, 4, 9, 16]);
    const d2 = distanceSq(3, 3, (p) => p === 0);
    expect(d2[8]).toBe(8);
  });
  it('grow and shrink', () => {
    const g = growMask(square(), W, H, 1);
    expect(maskBounds(g, W, H)).toEqual({ x: 2, y: 2, w: 5, h: 5 });
    // corners of a radius-1 grow stay off (circular structuring element)
    expect(g[2 * W + 2]).toBe(0);
    const g2 = growMask(square(), W, H, 2);
    expect(g2[2 * W + 2]).toBe(255);
    const s = growMask(square(), W, H, -1);
    expect(maskBounds(s, W, H)).toEqual({ x: 4, y: 4, w: 1, h: 1 });
    expect(maskBounds(growMask(square(), W, H, -2), W, H)).toBeNull();
  });
  it('shrink treats the document edge as unselected', () => {
    const full = new Uint8ClampedArray(W * H).fill(255);
    expect(maskBounds(growMask(full, W, H, -2), W, H)).toEqual({ x: 2, y: 2, w: 5, h: 5 });
  });
  it('feather softens edges but keeps the core', () => {
    const big = new Uint8ClampedArray(40 * 40);
    for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) big[y * 40 + x] = 255;
    const f = featherMask(big, 40, 40, 6);
    expect(f[20 * 40 + 20]).toBe(255);
    const edge = f[20 * 40 + 10]!;
    expect(edge).toBeGreaterThan(60);
    expect(edge).toBeLessThan(200);
    expect(f[20 * 40 + 4]!).toBeLessThan(edge);
  });
  it('invert / combine / bounds', () => {
    const a = new Uint8ClampedArray([0, 255, 128]);
    expect(Array.from(invertMask(a))).toEqual([255, 0, 127]);
    const b = new Uint8ClampedArray([255, 255, 0]);
    expect(Array.from(combineMasks(a, b, 'add'))).toEqual([255, 255, 128]);
    expect(Array.from(combineMasks(a, b, 'sub'))).toEqual([0, 0, 128]);
    expect(Array.from(combineMasks(a, b, 'intersect'))).toEqual([0, 255, 0]);
    expect(maskBounds(new Uint8ClampedArray(4), 2, 2)).toBeNull();
  });
  it('outline of a square is its 4 merged edges', () => {
    const segs = maskOutline(square(), W, H);
    expect(segs.length).toBe(16);
    expect(segs).toContain(3);
    expect(segs).toContain(6);
  });
});

describe('free transform math', () => {
  const s0 = initialXform({ x: 10, y: 20, w: 100, h: 50 });
  it('identity maps the source rect onto itself', () => {
    const m = xformMatrix(s0);
    expect(applyMatrix(m, 0, 0)).toEqual({ x: 10, y: 20 });
    expect(applyMatrix(m, 100, 50)).toEqual({ x: 110, y: 70 });
    expect(xformBounds(s0)).toEqual({ x: 10, y: 20, w: 100, h: 50 });
    expect(isPureTranslation({ ...s0, tx: 3, ty: -2 })).toBe(true);
  });
  it('inverse matrix round-trips', () => {
    const m = xformMatrix({ ...s0, rot: 0.7, sx: 1.5, sy: -0.5, tx: 4 });
    const inv = invertMatrix(m)!;
    const p = applyMatrix(m, 33, 12);
    const q = applyMatrix(inv, p.x, p.y);
    close(q.x, 33);
    close(q.y, 12);
  });
  it('dragging the SE handle scales with the NW corner fixed', () => {
    const s = dragHandle(s0, 1, 1, { x: 210, y: 120 }, false);
    close(s.sx, 2);
    close(s.sy, 2);
    const c = xformCorners(s);
    close(c[0]!.x, 10);
    close(c[0]!.y, 20);
    close(c[2]!.x, 210);
    close(c[2]!.y, 120);
  });
  it('Shift keeps proportions, edge handles scale one axis, dragging past the anchor flips', () => {
    const s = dragHandle(s0, 1, 1, { x: 310, y: 30 }, true);
    close(s.sx, s.sy);
    close(s.sx, 3);
    const e = dragHandle(s0, 1, 0.5, { x: 60, y: 999 }, false);
    close(e.sx, 0.5);
    close(e.sy, 1);
    const f = dragHandle(s0, 1, 0.5, { x: -90, y: 0 }, false);
    expect(f.sx).toBeLessThan(0);
  });
  it('Alt scales around the centre', () => {
    const s = dragHandle(s0, 1, 1, { x: 160, y: 95 }, false, true);
    close(s.sx, 2);
    close(s.tx, 0);
  });
  it('rotation keeps the centre; Shift snaps to 15°', () => {
    const r = dragRotate(s0, { x: 200, y: 45 }, { x: 60, y: 200 }, false);
    close(r.rot, Math.PI / 2);
    const c = xformCorners(r);
    close((c[0]!.x + c[2]!.x) / 2, 60);
    close((c[0]!.y + c[2]!.y) / 2, 45);
    const snapped = dragRotate(s0, { x: 200, y: 45 }, { x: 200, y: 60 }, true);
    close((snapped.rot * 180) / Math.PI % 15, 0, 1e-6);
    expect(hitInside(r, { x: 60, y: 45 })).toBe(true);
    expect(hitInside(r, { x: 105, y: 45 })).toBe(false);
  });
});

describe('guides & snapping', () => {
  const t = snapTargets([{ axis: 'v', pos: 100 }, { axis: 'h', pos: 40 }], 400, 300);
  it('snaps to guides, edges and centre within tolerance', () => {
    expect(snapValue(97, t.xs, 5)).toBe(100);
    expect(snapValue(90, t.xs, 5)).toBeNull();
    expect(snapPoint(198, 43, t, 5)).toEqual({ x: 200, y: 40 });
    expect(snapPoint(150, 120, t, 5)).toEqual({ x: 150, y: 120 });
  });
  it('rect snapping uses the closest edge', () => {
    expect(snapRectOffset({ x: 3, y: 50, w: 50, h: 50 }, t, 5)).toEqual({ dx: -3, dy: 0 });
    expect(snapRectOffset({ x: 48, y: 50, w: 50, h: 50 }, t, 5)).toEqual({ dx: 2, dy: 0 });
  });
  it('ruler step grows when zoomed out', () => {
    expect(rulerStep(1)).toBe(50);
    expect(rulerStep(0.1)).toBe(500);
    expect(rulerStep(10)).toBe(5);
  });
});

describe('healing (push–pull inpaint)', () => {
  it('fills a hole in a flat area with the surrounding colour', () => {
    const W = 16, H = 16;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let p = 0; p < W * H; p++) data.set([40, 120, 200, 255], p * 4);
    const hole = new Uint8ClampedArray(W * H);
    for (let y = 5; y < 11; y++)
      for (let x = 5; x < 11; x++) {
        hole[y * W + x] = 255;
        data.set([255, 0, 0, 255], (y * W + x) * 4);
      }
    inpaint({ width: W, height: H, data }, hole);
    const i = (8 * W + 8) * 4;
    expect(Array.from(data.slice(i, i + 4))).toEqual([40, 120, 200, 255]);
  });
  it('interpolates between different borders', () => {
    const W = 20, H = 4;
    const data = new Uint8ClampedArray(W * H * 4);
    const hole = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const v = x < 5 ? 0 : x >= 15 ? 200 : 77;
        data.set([v, v, v, 255], (y * W + x) * 4);
        if (x >= 5 && x < 15) hole[y * W + x] = 255;
      }
    inpaint({ width: W, height: H, data }, hole);
    const mid = data[(2 * W + 10) * 4]!;
    expect(mid).toBeGreaterThan(40);
    expect(mid).toBeLessThan(160);
    expect(data[(2 * W + 6) * 4]!).toBeLessThan(data[(2 * W + 13) * 4]!);
  });
});

describe('project sanitising (v2 data)', () => {
  it('keeps valid text/shape/adjust data and rejects garbage', () => {
    expect(sanitizeText({ text: 'Hi', size: 99999, color: 'red', align: 'center', bold: true })).toMatchObject({ text: 'Hi', size: 2000, color: '#000000', align: 'center', bold: true, italic: false });
    expect(sanitizeText({ size: 3 })).toBeUndefined();
    expect(sanitizeShape({ type: 'rect', w: 10, h: 5, fill: '#FF0000', stroke: null, strokeWidth: 2, radius: 3 })).toEqual({ type: 'rect', w: 10, h: 5, fill: '#ff0000', stroke: null, strokeWidth: 2, radius: 3 });
    expect(sanitizeShape({ type: 'star' })).toBeUndefined();
    expect(sanitizeAdjust({ filterId: 'curves', params: { c0n: 2, bad: 'x' } })).toEqual({ filterId: 'curves', params: { c0n: 2 } });
    expect(sanitizeAdjust({ filterId: 'blur', params: {} })).toBeUndefined();
    expect(sanitizeGuides([{ axis: 'v', pos: 10.6 }, { axis: 'q', pos: 1 }, null], 100, 100)).toEqual([{ axis: 'v', pos: 11 }]);
  });
  it('degrades layers whose editable data is missing', () => {
    const m = sanitizeMeta({ kind: 'text', name: 'T' } as Partial<LayerMeta>, 0);
    expect(m.kind).toBe('raster');
    const a = sanitizeMeta({ kind: 'adjustment', adjust: { filterId: 'levels', params: { gamma: 1.2 } }, maskEnabled: false } as Partial<LayerMeta>, 1);
    expect(a.kind).toBe('adjustment');
    expect(a.adjust?.params.gamma).toBe(1.2);
    expect(a.maskEnabled).toBe(false);
  });
  it('cloneMeta deep-copies nested data', () => {
    const m = sanitizeMeta({ kind: 'shape', shape: { type: 'ellipse', w: 4, h: 4, fill: '#000000', stroke: null, strokeWidth: 0, radius: 0 } } as Partial<LayerMeta>, 0);
    const c = cloneMeta(m);
    c.shape!.w = 99;
    expect(m.shape!.w).toBe(4);
  });
});
