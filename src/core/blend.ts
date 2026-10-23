import type { BlendMode } from './types';

/**
 * Blend modes. Rendering uses Canvas2D globalCompositeOperation (GPU accelerated, W3C
 * Compositing spec). The pure functions below implement the same math and are used in
 * tests and anywhere we need deterministic per-pixel results.
 */
export const BLEND_MODES: { id: BlendMode; label: string }[] = [
  { id: 'normal', label: 'Обычный' },
  { id: 'multiply', label: 'Умножение' },
  { id: 'screen', label: 'Экран' },
  { id: 'overlay', label: 'Перекрытие' },
  { id: 'darken', label: 'Затемнение' },
  { id: 'lighten', label: 'Замена светлым' },
  { id: 'soft-light', label: 'Мягкий свет' },
  { id: 'hard-light', label: 'Жёсткий свет' },
  { id: 'color-dodge', label: 'Осветление основы' },
  { id: 'color-burn', label: 'Затемнение основы' },
  { id: 'difference', label: 'Разница' },
  { id: 'exclusion', label: 'Исключение' },
  { id: 'hue', label: 'Цветовой тон' },
  { id: 'saturation', label: 'Насыщенность' },
  { id: 'color', label: 'Цвет' },
  { id: 'luminosity', label: 'Яркость' },
];

const NON_SEPARABLE = new Set<BlendMode>(['hue', 'saturation', 'color', 'luminosity']);
export const isNonSeparable = (m: BlendMode): boolean => NON_SEPARABLE.has(m);

export function isBlendMode(v: unknown): v is BlendMode {
  return BLEND_MODES.some((m) => m.id === v);
}

export function toCompositeOp(mode: BlendMode): GlobalCompositeOperation {
  return mode === 'normal' ? 'source-over' : mode;
}

/** Separable blend function B(Cb, Cs) on 0..1 channels (W3C). */
export function blendChannel(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case 'normal':
      return cs;
    case 'multiply':
      return cb * cs;
    case 'screen':
      return cb + cs - cb * cs;
    case 'overlay':
      return hardLight(cs, cb);
    case 'darken':
      return Math.min(cb, cs);
    case 'lighten':
      return Math.max(cb, cs);
    case 'difference':
      return Math.abs(cb - cs);
    case 'hard-light':
      return hardLight(cb, cs);
    case 'exclusion':
      return cb + cs - 2 * cb * cs;
    case 'color-dodge':
      return cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs));
    case 'color-burn':
      return cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs);
    case 'soft-light': {
      if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
      const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
      return cb + (2 * cs - 1) * (d - cb);
    }
    default:
      return cs;
  }
}

type Rgb3 = [number, number, number];
const lum = (c: Rgb3) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const clipColor = (c: Rgb3): Rgb3 => {
  const l = lum(c), n = Math.min(...c), x = Math.max(...c);
  let out: Rgb3 = [...c];
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n)) as Rgb3;
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as Rgb3;
  return out;
};
const setLum = (c: Rgb3, l: number): Rgb3 => {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
};
const sat = (c: Rgb3) => Math.max(...c) - Math.min(...c);
const setSat = (c: Rgb3, s: number): Rgb3 => {
  const idx = [0, 1, 2].sort((a, b) => c[a]! - c[b]!);
  const [mn, md, mx] = idx as [number, number, number];
  const out: Rgb3 = [0, 0, 0];
  if (c[mx]! > c[mn]!) {
    out[md] = ((c[md]! - c[mn]!) * s) / (c[mx]! - c[mn]!);
    out[mx] = s;
  }
  return out;
};

/** Non-separable blend (hue / saturation / color / luminosity) of backdrop `cb` and source `cs`, 0..1 RGB. */
export function blendRgb(mode: BlendMode, cb: Rgb3, cs: Rgb3): Rgb3 {
  switch (mode) {
    case 'hue':
      return setLum(setSat(cs, sat(cb)), lum(cb));
    case 'saturation':
      return setLum(setSat(cb, sat(cs)), lum(cb));
    case 'color':
      return setLum(cs, lum(cb));
    case 'luminosity':
      return setLum(cb, lum(cs));
    default:
      return [blendChannel(mode, cb[0], cs[0]), blendChannel(mode, cb[1], cs[1]), blendChannel(mode, cb[2], cs[2])];
  }
}

/** Hard-light; overlay(Cb, Cs) == hardLight(Cs, Cb). */
function hardLight(cb: number, cs: number): number {
  return cs <= 0.5 ? cb * 2 * cs : cb + (2 * cs - 1) - cb * (2 * cs - 1);
}

export type RGBA = [number, number, number, number];

/**
 * Composite a source pixel over a backdrop pixel (both 0..255 straight alpha),
 * with blend mode and layer opacity. Returns 0..255 straight alpha.
 */
export function blendPixel(src: RGBA, dst: RGBA, mode: BlendMode, opacity = 1): RGBA {
  const as = (src[3] / 255) * opacity;
  const ab = dst[3] / 255;
  const ao = as + ab * (1 - as);
  if (ao <= 0) return [0, 0, 0, 0];
  const out: RGBA = [0, 0, 0, Math.round(ao * 255)];
  const csv: Rgb3 = [src[0] / 255, src[1] / 255, src[2] / 255];
  const cbv: Rgb3 = [dst[0] / 255, dst[1] / 255, dst[2] / 255];
  const blended = blendRgb(mode, cbv, csv);
  for (let i = 0; i < 3; i++) {
    const cs = csv[i]!;
    const cb = cbv[i]!;
    const mixed = (1 - ab) * cs + ab * blended[i]!;
    const co = as * mixed + ab * cb * (1 - as);
    out[i] = Math.round(Math.max(0, Math.min(1, co / ao)) * 255);
  }
  return out;
}
