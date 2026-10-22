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
  { id: 'difference', label: 'Разница' },
];

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
    case 'soft-light': {
      if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
      const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
      return cb + (2 * cs - 1) * (d - cb);
    }
    default:
      return cs;
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
  for (let i = 0; i < 3; i++) {
    const cs = src[i] / 255;
    const cb = dst[i] / 255;
    const mixed = (1 - ab) * cs + ab * blendChannel(mode, cb, cs);
    const co = as * mixed + ab * cb * (1 - as);
    out[i] = Math.round(Math.max(0, Math.min(1, co / ao)) * 255);
  }
  return out;
}
