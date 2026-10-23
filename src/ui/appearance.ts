/** Interface customisation: accent colour, corner radius, density and "liquid glass" panels. */
import { checkbox, select, slider } from './controls';
import { h } from './dom';
import { openDialog } from './overlays';

export interface Appearance {
  accent: string;
  /** Multiplier for corner radii (0.4 … 2). */
  radius: number;
  density: 'comfortable' | 'compact';
  glass: boolean;
  /** Backdrop blur in px. */
  glassBlur: number;
  /** Panel opacity, 0.25 … 0.95. */
  glassOpacity: number;
}

export const ACCENTS = ['#6d7cff', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b', '#22c55e', '#14b8a6', '#0ea5e9'];

export function defaultAppearance(isMacDesktop: boolean): Appearance {
  return { accent: ACCENTS[0]!, radius: 1, density: 'comfortable', glass: isMacDesktop, glassBlur: 28, glassOpacity: 0.55 };
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);

/** Validates stored / imported settings; anything odd falls back to the defaults. */
export function sanitizeAppearance(v: unknown, isMacDesktop = false): Appearance {
  const d = defaultAppearance(isMacDesktop);
  if (!v || typeof v !== 'object') return d;
  const o = v as Partial<Appearance>;
  return {
    accent: typeof o.accent === 'string' && /^#[0-9a-f]{6}$/i.test(o.accent) ? o.accent.toLowerCase() : d.accent,
    radius: clamp(o.radius, 0.4, 2, d.radius),
    density: o.density === 'compact' ? 'compact' : 'comfortable',
    glass: typeof o.glass === 'boolean' ? o.glass : d.glass,
    glassBlur: clamp(o.glassBlur, 0, 80, d.glassBlur),
    glassOpacity: clamp(o.glassOpacity, 0.25, 0.95, d.glassOpacity),
  };
}

/** CSS custom properties for the settings (pure; applied by `applyAppearance`). */
export function appearanceVars(a: Appearance): Record<string, string> {
  const r = parseInt(a.accent.slice(1, 3), 16), g = parseInt(a.accent.slice(3, 5), 16), b = parseInt(a.accent.slice(5, 7), 16);
  const compact = a.density === 'compact';
  return {
    '--accent': a.accent,
    '--accent-soft': `rgba(${r}, ${g}, ${b}, 0.16)`,
    '--accent-ring': `rgba(${r}, ${g}, ${b}, 0.55)`,
    '--radius-sm': `${Math.round(5 * a.radius * 10) / 10}px`,
    '--radius': `${Math.round(8 * a.radius * 10) / 10}px`,
    '--radius-lg': `${Math.round(12 * a.radius * 10) / 10}px`,
    '--topbar-h': compact ? '36px' : '42px',
    '--options-h': compact ? '36px' : '42px',
    '--status-h': compact ? '22px' : '26px',
    '--glass-blur': `${a.glassBlur}px`,
    '--glass-opacity': `${Math.round(a.glassOpacity * 100)}%`,
  };
}

const KEY = 'appearance';
const store = {
  get: (): unknown => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? 'null');
    } catch {
      return null;
    }
  },
  set: (a: Appearance) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(a));
    } catch {
      /* private mode */
    }
  },
};

type DesktopBridge = { platform?: string; setGlass?: (on: boolean) => Promise<unknown> | void };
const desktop = (): DesktopBridge | undefined => (window as unknown as { lumenDesktop?: DesktopBridge }).lumenDesktop;
export const isMacDesktop = (): boolean => desktop()?.platform === 'darwin';

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(appearanceVars(a))) root.style.setProperty(k, v);
  root.dataset.glass = a.glass ? 'on' : 'off';
  void desktop()?.setGlass?.(a.glass);
}

export function loadAppearance(): Appearance {
  return sanitizeAppearance(store.get(), isMacDesktop());
}

export function openAppearanceDialog(onChange: () => void): void {
  let a = loadAppearance();
  const set = (patch: Partial<Appearance>) => {
    a = { ...a, ...patch };
    store.set(a);
    applyAppearance(a);
    onChange();
  };
  const swatches = h(
    'div',
    { class: 'swatches', role: 'radiogroup', 'aria-label': 'Акцентный цвет' },
    ...ACCENTS.map((c) => {
      const b = h('button', { type: 'button', class: `swatch${c === a.accent ? ' on' : ''}`, style: `background:${c}`, role: 'radio', 'aria-checked': String(c === a.accent), 'aria-label': c });
      b.addEventListener('click', () => {
        swatches.querySelectorAll('.swatch').forEach((s) => {
          s.classList.remove('on');
          s.setAttribute('aria-checked', 'false');
        });
        b.classList.add('on');
        b.setAttribute('aria-checked', 'true');
        set({ accent: c });
      });
      return b;
    }),
  );
  const custom = h('input', { type: 'color', class: 'color-input', value: a.accent, 'aria-label': 'Свой цвет акцента' });
  custom.addEventListener('input', () => set({ accent: custom.value }));
  openDialog({
    title: 'Оформление',
    width: 420,
    body: h(
      'div',
      { class: 'form' },
      h('div', { class: 'field' }, h('span', null, 'Акцентный цвет'), h('div', { class: 'row2' }, swatches, custom)),
      slider({ label: 'Скругление', min: 0.4, max: 2, step: 0.1, value: a.radius, unit: '×', onInput: (v) => set({ radius: v }) }).el,
      select<'comfortable' | 'compact'>('Плотность', [{ id: 'comfortable', label: 'Обычная' }, { id: 'compact', label: 'Компактная' }], a.density, (v) => set({ density: v })),
      checkbox('Жидкое стекло (прозрачные панели)', a.glass, (v) => set({ glass: v }), 'Размытие и прозрачность панелей; на macOS окно просвечивает насквозь'),
      slider({ label: 'Размытие', min: 0, max: 80, step: 1, value: a.glassBlur, unit: 'px', onInput: (v) => set({ glassBlur: v }) }).el,
      slider({ label: 'Плотность панелей', min: 0.25, max: 0.95, step: 0.05, value: a.glassOpacity, onInput: (v) => set({ glassOpacity: v }) }).el,
    ),
    buttons: [
      {
        label: 'Сбросить',
        action: () => {
          set(defaultAppearance(isMacDesktop()));
        },
      },
      { label: 'Готово', primary: true },
    ],
  });
}
