import { describe, expect, it } from 'vitest';
import { defaultFx, dilationOffsets, fxPad, hasFx, MAX_FX_PAD } from '../src/core/layerFx';
import { sanitizeFx, sanitizeMeta } from '../src/core/project';
import { cloneFx, cloneMeta, type LayerFx, type LayerMeta } from '../src/core/types';

describe('layer styles', () => {
  it('nothing is on by default', () => {
    expect(hasFx(undefined)).toBe(false);
    expect(hasFx(defaultFx())).toBe(false);
    expect(fxPad(defaultFx())).toBe(0);
  });
  it('detects enabled effects', () => {
    const fx = defaultFx();
    fx.glow.on = true;
    expect(hasFx(fx)).toBe(true);
  });
  it('pad covers shadow offset + blur, glow blur and outside stroke', () => {
    const fx = defaultFx();
    fx.shadow = { ...fx.shadow, on: true, dx: 10, dy: -20, blur: 5 };
    expect(fxPad(fx)).toBe(20 + 10);
    fx.glow = { ...fx.glow, on: true, blur: 40 };
    expect(fxPad(fx)).toBe(80);
    fx.stroke = { ...fx.stroke, on: true, width: 100, pos: 'outside' };
    expect(fxPad(fx)).toBe(101);
    fx.stroke.pos = 'center';
    expect(fxPad(fx)).toBe(80);
  });
  it('inside stroke needs no extra room; pad is capped', () => {
    const fx = defaultFx();
    fx.stroke = { ...fx.stroke, on: true, width: 30, pos: 'inside' };
    expect(fxPad(fx)).toBe(0);
    fx.shadow = { ...fx.shadow, on: true, dx: 5000, dy: 0, blur: 0 };
    expect(fxPad(fx)).toBe(MAX_FX_PAD);
  });
  it('dilation samples the full ring', () => {
    expect(dilationOffsets(0)).toEqual([[0, 0]]);
    const o = dilationOffsets(10);
    expect(o.length).toBeGreaterThan(30);
    const far = Math.max(...o.map(([x, y]) => Math.hypot(x, y)));
    expect(far).toBeCloseTo(10, 5);
    // symmetric: for every sample there is the opposite one
    expect(o.some(([x, y]) => Math.abs(x - 10) < 1e-9 && Math.abs(y) < 1e-9)).toBe(true);
    expect(o.some(([x, y]) => Math.abs(x + 10) < 1e-9 && Math.abs(y) < 1e-9)).toBe(true);
  });
});

describe('layer styles data', () => {
  it('sanitises values and rejects garbage', () => {
    const fx = sanitizeFx({
      shadow: { on: true, color: 'red', opacity: 9, dx: 1e9, dy: 3, blur: -5 },
      glow: { on: 1, color: '#ABCDEF', opacity: 0.5, blur: 10, strength: 99 },
      stroke: { on: true, color: '#000000', width: 4, pos: 'weird', opacity: 1 },
      overlay: { on: true, mode: 'x', color: '#ff0000', color2: '#00ff00', angle: 45, opacity: 0.5 },
    })!;
    expect(fx.shadow).toEqual({ on: true, color: '#000000', opacity: 1, dx: 300, dy: 3, blur: 0 });
    expect(fx.glow!.on).toBe(false);
    expect(fx.glow!.color).toBe('#abcdef');
    expect(fx.glow!.strength).toBe(6);
    expect(fx.stroke!.pos).toBe('outside');
    expect(fx.overlay!.mode).toBe('gradient');
    expect(sanitizeFx(null)).toBeUndefined();
    expect(sanitizeFx({})).toBeUndefined();
    expect(sanitizeFx('x')).toBeUndefined();
  });
  it('layer meta keeps fx except for adjustment layers', () => {
    const fx: LayerFx = { shadow: { on: true, color: '#112233', opacity: 0.5, dx: 1, dy: 2, blur: 3 } };
    const m = sanitizeMeta({ id: 'a', name: 'a', kind: 'raster', visible: true, locked: false, opacity: 1, blend: 'normal', x: 0, y: 0, fx }, 0);
    expect(m.fx?.shadow?.color).toBe('#112233');
    const a = sanitizeMeta({ id: 'b', name: 'b', kind: 'adjustment', visible: true, locked: false, opacity: 1, blend: 'normal', x: 0, y: 0, fx, adjust: { filterId: 'nope', params: {} } }, 1);
    expect(a.fx).toBeUndefined();
  });
  it('cloneMeta / cloneFx deep-copy', () => {
    const m: LayerMeta = { id: 'a', name: 'a', kind: 'raster', visible: true, locked: false, opacity: 1, blend: 'normal', x: 0, y: 0, fx: defaultFx() };
    const c = cloneMeta(m);
    c.fx!.shadow!.blur = 99;
    expect(m.fx!.shadow!.blur).toBe(14);
    const f = cloneFx(m.fx!);
    f.stroke!.width = 77;
    expect(m.fx!.stroke!.width).toBe(4);
  });
});
