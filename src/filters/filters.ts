/**
 * Pure, DOM-free pixel filters. They operate in place on straight-alpha RGBA buffers and
 * run inside a Web Worker (see worker.ts) or in Node tests.
 */
import { curvesLuts, decodeCurves } from '../core/curves';
import type { PixelBuffer } from '../core/types';

export type Params = Record<string, number>;

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  unit?: string;
  /** Value is a distance in pixels — scaled when previewing on a downsampled copy. */
  spatial?: boolean;
  /** Render as checkbox (0/1). */
  toggle?: boolean;
}

export interface FilterDef {
  id: string;
  label: string;
  group: 'adjust' | 'filter';
  params: ParamDef[];
  /** Custom editor instead of (or in addition to) sliders. */
  custom?: 'curves';
  /** Per-pixel (non-spatial) filter usable as a non-destructive adjustment layer. */
  layerable?: boolean;
  apply(buf: PixelBuffer, p: Params): void;
}

/** True when the filter opens an interactive session (sliders or a custom editor). */
export function hasControls(def: FilterDef): boolean {
  return def.params.length > 0 || !!def.custom;
}

/** RGB → HSL helpers for the hue/saturation filter (all 0..1). */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function applyLut(buf: PixelBuffer, lr: ArrayLike<number>, lg: ArrayLike<number> = lr, lb: ArrayLike<number> = lr): void {
  const d = buf.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lr[d[i]!]!;
    d[i + 1] = lg[d[i + 1]!]!;
    d[i + 2] = lb[d[i + 2]!]!;
  }
}

function lut(fn: (v: number) => number): Uint8ClampedArray {
  const t = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) t[i] = fn(i);
  return t;
}

export function defaults(def: FilterDef): Params {
  const p: Params = {};
  for (const d of def.params) p[d.key] = d.def;
  return p;
}

/* ---------- blur core (gaussian approximated by 3 box passes, premultiplied alpha) ---------- */

export function boxesForGauss(sigma: number, n = 3): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))]!;
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * inv;
      acc += src[row + Math.min(w - 1, x + r + 1)]! - src[row + Math.max(0, x - r)]!;
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[Math.min(h - 1, Math.max(0, k)) * w + x]!;
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * inv;
      acc += src[Math.min(h - 1, y + r + 1) * w + x]! - src[Math.max(0, y - r) * w + x]!;
    }
  }
}

export function gaussianBlur(buf: PixelBuffer, sigma: number): void {
  if (!(sigma >= 0.3)) return;
  const { width: w, height: h, data } = buf;
  const n = w * h;
  const chans = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const a = data[i + 3]! / 255;
    chans[0]![p] = data[i]! * a;
    chans[1]![p] = data[i + 1]! * a;
    chans[2]![p] = data[i + 2]! * a;
    chans[3]![p] = data[i + 3]!;
  }
  const tmp = new Float32Array(n);
  const boxes = boxesForGauss(sigma, 3);
  for (const ch of chans) {
    for (const b of boxes) {
      const r = (b - 1) / 2;
      boxH(ch, tmp, w, h, r);
      boxV(tmp, ch, w, h, r);
    }
  }
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const a = chans[3]![p]!;
    data[i + 3] = a;
    if (a > 0.001) {
      const k = 255 / a;
      data[i] = chans[0]![p]! * k;
      data[i + 1] = chans[1]![p]! * k;
      data[i + 2] = chans[2]![p]! * k;
    }
  }
}

/* ---------- deterministic RNG for noise ---------- */
function xorshift(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

/* ---------- registry ---------- */

export const FILTER_LIST: FilterDef[] = [
  {
    id: 'brightnessContrast',
    label: 'Яркость/Контраст',
    group: 'adjust',
    layerable: true,
    params: [
      { key: 'brightness', label: 'Яркость', min: -100, max: 100, step: 1, def: 0 },
      { key: 'contrast', label: 'Контраст', min: -100, max: 100, step: 1, def: 0 },
    ],
    apply(buf, p) {
      const br = (p.brightness ?? 0) * 2.55;
      const c = Math.max(-254, Math.min(254, (p.contrast ?? 0) * 2.55));
      const f = (259 * (c + 255)) / (255 * (259 - c));
      applyLut(buf, lut((v) => f * (v - 128) + 128 + br));
    },
  },
  {
    id: 'hueSat',
    label: 'Цветовой тон/Насыщенность',
    group: 'adjust',
    layerable: true,
    params: [
      { key: 'hue', label: 'Цветовой тон', min: -180, max: 180, step: 1, def: 0, unit: '°' },
      { key: 'saturation', label: 'Насыщенность', min: -100, max: 100, step: 1, def: 0 },
      { key: 'lightness', label: 'Яркость', min: -100, max: 100, step: 1, def: 0 },
    ],
    apply(buf, p) {
      const dh = (p.hue ?? 0) / 360;
      const ds = (p.saturation ?? 0) / 100;
      const dl = (p.lightness ?? 0) / 100;
      if (!dh && !ds && !dl) return;
      const d = buf.data;
      for (let i = 0; i < d.length; i += 4) {
        let [hh, ss, ll] = rgbToHsl(d[i]! / 255, d[i + 1]! / 255, d[i + 2]! / 255);
        hh = (hh + dh + 1) % 1;
        ss = ds >= 0 ? ss + (1 - ss) * ds * ss : ss * (1 + ds);
        ll = dl >= 0 ? ll + (1 - ll) * dl : ll * (1 + dl);
        const [r, g, b] = hslToRgb(hh, Math.max(0, Math.min(1, ss)), Math.max(0, Math.min(1, ll)));
        d[i] = r * 255;
        d[i + 1] = g * 255;
        d[i + 2] = b * 255;
      }
    },
  },
  {
    id: 'curves',
    label: 'Кривые',
    group: 'adjust',
    custom: 'curves',
    layerable: true,
    params: [],
    apply(buf, p) {
      const [lr, lg, lb] = curvesLuts(decodeCurves(p));
      applyLut(buf, lr, lg, lb);
    },
  },
  {
    id: 'exposure',
    label: 'Экспозиция',
    group: 'adjust',
    params: [
      { key: 'ev', label: 'Экспозиция', min: -3, max: 3, step: 0.05, def: 0, unit: 'EV' },
      { key: 'gamma', label: 'Гамма', min: 0.2, max: 3, step: 0.01, def: 1 },
    ],
    apply(buf, p) {
      const k = Math.pow(2, p.ev ?? 0);
      const g = 1 / Math.max(0.01, p.gamma ?? 1);
      applyLut(
        buf,
        lut((v) => {
          const lin = Math.pow(v / 255, 2.2) * k;
          return Math.pow(Math.min(1, Math.pow(lin, 1 / 2.2)), g) * 255;
        }),
      );
    },
  },
  {
    id: 'saturation',
    label: 'Насыщенность/Красочность',
    group: 'adjust',
    params: [
      { key: 'saturation', label: 'Насыщенность', min: -100, max: 100, step: 1, def: 0 },
      { key: 'vibrance', label: 'Красочность', min: -100, max: 100, step: 1, def: 0 },
    ],
    apply(buf, p) {
      const s = 1 + (p.saturation ?? 0) / 100;
      const vib = (p.vibrance ?? 0) / 100;
      const d = buf.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
        const l = lum(r, g, b);
        let f = s;
        if (vib !== 0) {
          const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
          f *= 1 + vib * (1 - sat);
        }
        d[i] = l + (r - l) * f;
        d[i + 1] = l + (g - l) * f;
        d[i + 2] = l + (b - l) * f;
      }
    },
  },
  {
    id: 'hue',
    label: 'Цветовой тон',
    group: 'adjust',
    params: [{ key: 'hue', label: 'Тон', min: -180, max: 180, step: 1, def: 0, unit: '°' }],
    apply(buf, p) {
      const a = ((p.hue ?? 0) * Math.PI) / 180;
      if (a === 0) return;
      const cos = Math.cos(a), sin = Math.sin(a);
      const m = [
        0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
        0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283,
        0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
      ] as const;
      const d = buf.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
        d[i] = m[0] * r + m[1] * g + m[2] * b;
        d[i + 1] = m[3] * r + m[4] * g + m[5] * b;
        d[i + 2] = m[6] * r + m[7] * g + m[8] * b;
      }
    },
  },
  {
    id: 'temperature',
    label: 'Температура/Оттенок',
    group: 'adjust',
    params: [
      { key: 'temperature', label: 'Температура', min: -100, max: 100, step: 1, def: 0 },
      { key: 'tint', label: 'Оттенок', min: -100, max: 100, step: 1, def: 0 },
    ],
    apply(buf, p) {
      const t = (p.temperature ?? 0) / 100;
      const n = (p.tint ?? 0) / 100;
      // multiplicative white-balance gains keep blacks black
      const gr = 1 + t * 0.3 + n * 0.08;
      const gg = 1 - n * 0.25;
      const gb = 1 - t * 0.3 + n * 0.08;
      applyLut(buf, lut((v) => v * gr), lut((v) => v * gg), lut((v) => v * gb));
    },
  },
  {
    id: 'levels',
    label: 'Уровни',
    group: 'adjust',
    layerable: true,
    params: [
      { key: 'inBlack', label: 'Вход: чёрная точка', min: 0, max: 253, step: 1, def: 0 },
      { key: 'inWhite', label: 'Вход: белая точка', min: 2, max: 255, step: 1, def: 255 },
      { key: 'gamma', label: 'Средние тона (гамма)', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'outBlack', label: 'Выход: чёрный', min: 0, max: 255, step: 1, def: 0 },
      { key: 'outWhite', label: 'Выход: белый', min: 0, max: 255, step: 1, def: 255 },
    ],
    apply(buf, p) {
      applyLut(buf, levelsLut(p.inBlack ?? 0, p.inWhite ?? 255, p.gamma ?? 1, p.outBlack ?? 0, p.outWhite ?? 255));
    },
  },
  {
    id: 'grayscale',
    label: 'Чёрно-белое',
    group: 'adjust',
    params: [{ key: 'amount', label: 'Сила', min: 0, max: 100, step: 1, def: 100, unit: '%' }],
    apply(buf, p) {
      const k = (p.amount ?? 100) / 100;
      const d = buf.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
        const l = lum(r, g, b);
        d[i] = r + (l - r) * k;
        d[i + 1] = g + (l - g) * k;
        d[i + 2] = b + (l - b) * k;
      }
    },
  },
  {
    id: 'sepia',
    label: 'Сепия',
    group: 'adjust',
    params: [{ key: 'amount', label: 'Сила', min: 0, max: 100, step: 1, def: 80, unit: '%' }],
    apply(buf, p) {
      const k = (p.amount ?? 80) / 100;
      const d = buf.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
        const sr = 0.393 * r + 0.769 * g + 0.189 * b;
        const sg = 0.349 * r + 0.686 * g + 0.168 * b;
        const sb = 0.272 * r + 0.534 * g + 0.131 * b;
        d[i] = r + (sr - r) * k;
        d[i + 1] = g + (sg - g) * k;
        d[i + 2] = b + (sb - b) * k;
      }
    },
  },
  {
    id: 'invert',
    label: 'Инверсия',
    group: 'adjust',
    params: [],
    apply(buf) {
      const d = buf.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255 - d[i]!;
        d[i + 1] = 255 - d[i + 1]!;
        d[i + 2] = 255 - d[i + 2]!;
      }
    },
  },
  {
    id: 'blur',
    label: 'Размытие по Гауссу',
    group: 'filter',
    params: [{ key: 'radius', label: 'Радиус', min: 0, max: 100, step: 0.5, def: 4, unit: 'px', spatial: true }],
    apply(buf, p) {
      gaussianBlur(buf, p.radius ?? 0);
    },
  },
  {
    id: 'sharpen',
    label: 'Резкость (нерезкая маска)',
    group: 'filter',
    params: [
      { key: 'amount', label: 'Эффект', min: 0, max: 500, step: 1, def: 100, unit: '%' },
      { key: 'radius', label: 'Радиус', min: 0.3, max: 20, step: 0.1, def: 1.5, unit: 'px', spatial: true },
      { key: 'threshold', label: 'Порог', min: 0, max: 255, step: 1, def: 0 },
    ],
    apply(buf, p) {
      const amount = (p.amount ?? 100) / 100;
      const th = p.threshold ?? 0;
      const blurred: PixelBuffer = { width: buf.width, height: buf.height, data: new Uint8ClampedArray(buf.data) };
      gaussianBlur(blurred, Math.max(0.3, p.radius ?? 1.5));
      const d = buf.data, bd = blurred.data;
      for (let i = 0; i < d.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const diff = d[i + c]! - bd[i + c]!;
          if (Math.abs(diff) >= th) d[i + c] = d[i + c]! + diff * amount;
        }
      }
    },
  },
  {
    id: 'vignette',
    label: 'Виньетка',
    group: 'filter',
    params: [
      { key: 'amount', label: 'Сила', min: -100, max: 100, step: 1, def: 50 },
      { key: 'size', label: 'Размер', min: 0, max: 100, step: 1, def: 50 },
      { key: 'feather', label: 'Растушёвка', min: 1, max: 100, step: 1, def: 60 },
    ],
    apply(buf, p) {
      const { width: w, height: h, data: d } = buf;
      const amt = (p.amount ?? 50) / 100;
      const inner = ((p.size ?? 50) / 100) * 1.2;
      const outer = inner + ((p.feather ?? 60) / 100) * 1.2 + 0.01;
      const cx = w / 2, cy = h / 2;
      for (let y = 0; y < h; y++) {
        const dy = (y + 0.5 - cy) / cy;
        for (let x = 0; x < w; x++) {
          const dx = (x + 0.5 - cx) / cx;
          const t = smoothstep(inner, outer, Math.sqrt(dx * dx + dy * dy)) * Math.abs(amt);
          if (t <= 0) continue;
          const i = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) d[i + c] = amt > 0 ? d[i + c]! * (1 - t) : d[i + c]! + (255 - d[i + c]!) * t;
        }
      }
    },
  },
  {
    id: 'noise',
    label: 'Шум',
    group: 'filter',
    params: [
      { key: 'amount', label: 'Количество', min: 0, max: 100, step: 1, def: 15, unit: '%' },
      { key: 'mono', label: 'Монохромный', min: 0, max: 1, step: 1, def: 1, toggle: true },
    ],
    apply(buf, p) {
      const amt = ((p.amount ?? 15) / 100) * 255;
      const mono = (p.mono ?? 1) >= 0.5;
      const rnd = xorshift(0x9e3779b9 ^ (buf.width * 73856093) ^ (buf.height * 19349663));
      const g = () => (rnd() + rnd() + rnd() - 1.5) * 1.15; // ~gaussian, sd≈0.58
      const d = buf.data;
      for (let i = 0; i < d.length; i += 4) {
        if (mono) {
          const n = g() * amt;
          d[i] = d[i]! + n;
          d[i + 1] = d[i + 1]! + n;
          d[i + 2] = d[i + 2]! + n;
        } else {
          d[i] = d[i]! + g() * amt;
          d[i + 1] = d[i + 1]! + g() * amt;
          d[i + 2] = d[i + 2]! + g() * amt;
        }
      }
    },
  },
  {
    id: 'posterize',
    label: 'Постеризация',
    group: 'adjust',
    layerable: true,
    params: [{ key: 'levels', label: 'Уровней', min: 2, max: 32, step: 1, def: 5 }],
    apply(buf, p) {
      const n = Math.max(2, Math.round(p.levels ?? 5));
      applyLut(buf, lut((v) => (Math.round((v / 255) * (n - 1)) * 255) / (n - 1)));
    },
  },
  {
    id: 'threshold',
    label: 'Порог (чёрно-белое)',
    group: 'adjust',
    layerable: true,
    params: [{ key: 'level', label: 'Порог', min: 0, max: 255, step: 1, def: 128 }],
    apply(buf, p) {
      const t = p.level ?? 128;
      const d = buf.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = lum(d[i]!, d[i + 1]!, d[i + 2]!) >= t ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    },
  },
  {
    id: 'duotone',
    label: 'Двухцветное тонирование',
    group: 'adjust',
    layerable: true,
    params: [
      { key: 'shadowHue', label: 'Тон теней', min: 0, max: 360, step: 1, def: 235, unit: '°' },
      { key: 'shadowSat', label: 'Насыщ. теней', min: 0, max: 100, step: 1, def: 65, unit: '%' },
      { key: 'highlightHue', label: 'Тон светов', min: 0, max: 360, step: 1, def: 38, unit: '°' },
      { key: 'highlightSat', label: 'Насыщ. светов', min: 0, max: 100, step: 1, def: 80, unit: '%' },
      { key: 'amount', label: 'Сила', min: 0, max: 100, step: 1, def: 100, unit: '%' },
    ],
    apply(buf, p) {
      const dark = hslToRgb(((p.shadowHue ?? 235) % 360) / 360, (p.shadowSat ?? 65) / 100, 0.14);
      const light = hslToRgb(((p.highlightHue ?? 38) % 360) / 360, (p.highlightSat ?? 80) / 100, 0.86);
      const k = (p.amount ?? 100) / 100;
      const d = buf.data;
      for (let i = 0; i < d.length; i += 4) {
        const l = lum(d[i]!, d[i + 1]!, d[i + 2]!) / 255;
        for (let c = 0; c < 3; c++) {
          const t = (dark[c]! + (light[c]! - dark[c]!) * l) * 255;
          d[i + c] = d[i + c]! + (t - d[i + c]!) * k;
        }
      }
    },
  },
  {
    id: 'pixelate',
    label: 'Мозаика',
    group: 'filter',
    params: [{ key: 'size', label: 'Размер', min: 2, max: 200, step: 1, def: 12, unit: 'px', spatial: true }],
    apply(buf, p) {
      const s = Math.max(1, Math.round(p.size ?? 12));
      const { width: w, height: h, data: d } = buf;
      for (let by = 0; by < h; by += s) {
        for (let bx = 0; bx < w; bx += s) {
          const ex = Math.min(w, bx + s), ey = Math.min(h, by + s);
          let r = 0, g = 0, b = 0, a = 0;
          for (let y = by; y < ey; y++) {
            for (let x = bx; x < ex; x++) {
              const i = (y * w + x) * 4;
              const al = d[i + 3]!;
              r += d[i]! * al;
              g += d[i + 1]! * al;
              b += d[i + 2]! * al;
              a += al;
            }
          }
          const n = (ex - bx) * (ey - by);
          const rr = a > 0 ? r / a : 0, gg = a > 0 ? g / a : 0, bb = a > 0 ? b / a : 0, aa = a / n;
          for (let y = by; y < ey; y++) {
            for (let x = bx; x < ex; x++) {
              const i = (y * w + x) * 4;
              d[i] = rr;
              d[i + 1] = gg;
              d[i + 2] = bb;
              d[i + 3] = aa;
            }
          }
        }
      }
    },
  },
  {
    id: 'motionBlur',
    label: 'Размытие в движении',
    group: 'filter',
    params: [
      { key: 'distance', label: 'Расстояние', min: 0, max: 200, step: 1, def: 20, unit: 'px', spatial: true },
      { key: 'angle', label: 'Угол', min: -180, max: 180, step: 1, def: 0, unit: '°' },
    ],
    apply(buf, p) {
      const dist = p.distance ?? 20;
      if (dist < 1) return;
      const { width: w, height: h, data: d } = buf;
      const src = new Uint8ClampedArray(d);
      const a = ((p.angle ?? 0) * Math.PI) / 180;
      const n = Math.min(96, Math.max(2, Math.ceil(dist)));
      const dx = Math.cos(a) * dist, dy = Math.sin(a) * dist;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let r = 0, g = 0, b = 0, al = 0;
          for (let k = 0; k < n; k++) {
            const t = n === 1 ? 0 : k / (n - 1) - 0.5;
            const sx = Math.min(w - 1, Math.max(0, Math.round(x + dx * t)));
            const sy = Math.min(h - 1, Math.max(0, Math.round(y + dy * t)));
            const i = (sy * w + sx) * 4;
            const aa = src[i + 3]!;
            r += src[i]! * aa;
            g += src[i + 1]! * aa;
            b += src[i + 2]! * aa;
            al += aa;
          }
          const o = (y * w + x) * 4;
          if (al > 0) {
            d[o] = r / al;
            d[o + 1] = g / al;
            d[o + 2] = b / al;
          }
          d[o + 3] = al / n;
        }
      }
    },
  },
  {
    id: 'emboss',
    label: 'Рельеф',
    group: 'filter',
    params: [
      { key: 'amount', label: 'Сила', min: 0, max: 500, step: 1, def: 100, unit: '%' },
      { key: 'angle', label: 'Угол света', min: -180, max: 180, step: 1, def: 135, unit: '°' },
    ],
    apply(buf, p) {
      const { width: w, height: h, data: d } = buf;
      const src = new Uint8ClampedArray(d);
      const a = ((p.angle ?? 135) * Math.PI) / 180;
      const ox = Math.cos(a), oy = Math.sin(a);
      const k = (p.amount ?? 100) / 100;
      const at = (x: number, y: number) => {
        const i = (Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))) * 4;
        return lum(src[i]!, src[i + 1]!, src[i + 2]!);
      };
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = 128 + (at(x + ox, y + oy) - at(x - ox, y - oy)) * k;
          const i = (y * w + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = v;
        }
      }
    },
  },
  {
    id: 'edges',
    label: 'Контуры (Собель)',
    group: 'filter',
    params: [
      { key: 'strength', label: 'Сила', min: 10, max: 500, step: 1, def: 100, unit: '%' },
      { key: 'invert', label: 'Тёмные линии', min: 0, max: 1, step: 1, def: 0, toggle: true },
    ],
    apply(buf, p) {
      const { width: w, height: h, data: d } = buf;
      const l = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) l[i] = lum(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!);
      const at = (x: number, y: number) => l[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
      const k = (p.strength ?? 100) / 100;
      const inv = (p.invert ?? 0) >= 0.5;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
          const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
          const m = Math.min(255, Math.hypot(gx, gy) * k * 0.5);
          const v = inv ? 255 - m : m;
          const i = (y * w + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = v;
        }
      }
    },
  },
  {
    id: 'chromatic',
    label: 'Хроматическая аберрация',
    group: 'filter',
    params: [{ key: 'amount', label: 'Сдвиг', min: 0, max: 100, step: 1, def: 15, unit: '‰' }],
    apply(buf, p) {
      const { width: w, height: h, data: d } = buf;
      const k = (p.amount ?? 15) / 1000;
      if (k <= 0) return;
      const src = new Uint8ClampedArray(d);
      const cx = (w - 1) / 2, cy = (h - 1) / 2;
      const sample = (x: number, y: number, c: number) => src[(Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))) * 4 + c]!;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          d[i] = sample(cx + (x - cx) * (1 + k), cy + (y - cy) * (1 + k), 0);
          d[i + 2] = sample(cx + (x - cx) * (1 - k), cy + (y - cy) * (1 - k), 2);
        }
      }
    },
  },
  {
    id: 'clarity',
    label: 'Чёткость (локальный контраст)',
    group: 'filter',
    params: [
      { key: 'amount', label: 'Эффект', min: -100, max: 300, step: 1, def: 60, unit: '%' },
      { key: 'radius', label: 'Радиус', min: 5, max: 100, step: 1, def: 30, unit: 'px', spatial: true },
    ],
    apply(buf, p) {
      const k = (p.amount ?? 60) / 100;
      const blurred: PixelBuffer = { width: buf.width, height: buf.height, data: new Uint8ClampedArray(buf.data) };
      gaussianBlur(blurred, Math.max(1, p.radius ?? 30));
      const d = buf.data, bd = blurred.data;
      for (let i = 0; i < d.length; i += 4) {
        const l = lum(d[i]!, d[i + 1]!, d[i + 2]!) / 255;
        const mid = 1 - Math.abs(l * 2 - 1); // strongest in the midtones
        for (let c = 0; c < 3; c++) d[i + c] = d[i + c]! + (d[i + c]! - bd[i + c]!) * k * mid;
      }
    },
  },
];

export const FILTERS: Record<string, FilterDef> = Object.fromEntries(FILTER_LIST.map((f) => [f.id, f]));

export function levelsLut(inB: number, inW: number, gamma: number, outB: number, outW: number): Uint8ClampedArray {
  if (inW <= inB) inW = inB + 1;
  const g = 1 / Math.max(0.01, gamma);
  return lut((v) => {
    const t = Math.max(0, Math.min(1, (v - inB) / (inW - inB)));
    return outB + (outW - outB) * Math.pow(t, g);
  });
}

/** Scales spatial params for a preview rendered at `scale` of full resolution. */
export function scaleParams(def: FilterDef, p: Params, scale: number): Params {
  const out: Params = { ...p };
  for (const d of def.params) if (d.spatial && out[d.key] !== undefined) out[d.key] = out[d.key]! * scale;
  return out;
}
