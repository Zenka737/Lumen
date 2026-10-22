import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv, type HSV } from '../../core/color';
import type { Editor } from '../../core/editor';
import { h } from '../dom';
import { icons } from '../icons';

const SWATCHES = [
  '#000000', '#3a3a3c', '#7d7d82', '#bdbdc2', '#ffffff', '#ff3b30', '#ff9500', '#ffcc00',
  '#34c759', '#00c7be', '#30b0c7', '#007aff', '#5856d6', '#af52de', '#ff2d55', '#a2845e',
  '#7f1d1d', '#9a3412', '#854d0e', '#14532d', '#134e4a', '#1e3a8a', '#4c1d95', '#831843',
];

/** HSV color picker bound to the editor's foreground/background colors. */
export function createColorPanel(ed: Editor): HTMLElement {
  let target: 'fg' | 'bg' = 'fg';
  let hsv: HSV = rgbToHsv(hexToRgb(ed.fg)!);

  const sv = h('div', { class: 'cp-sv', tabindex: '0', role: 'slider', 'aria-label': 'Насыщенность и яркость' });
  const svKnob = h('div', { class: 'cp-knob' });
  sv.append(svKnob);
  const hue = h('div', { class: 'cp-hue', tabindex: '0', role: 'slider', 'aria-label': 'Цветовой тон', 'aria-valuemin': '0', 'aria-valuemax': '360' });
  const hueKnob = h('div', { class: 'cp-hue-knob' });
  hue.append(hueKnob);

  const fgChip = h('button', { class: 'cp-chip fg', type: 'button', 'aria-label': 'Основной цвет', 'data-tip': 'Основной цвет' });
  const bgChip = h('button', { class: 'cp-chip bg', type: 'button', 'aria-label': 'Фоновый цвет', 'data-tip': 'Фоновый цвет' });
  const swapBtn = h('button', { class: 'icon-btn small', type: 'button', html: icons.swap, 'aria-label': 'Поменять местами', 'data-tip': 'Поменять цвета', 'data-key': 'X', onclick: () => ed.swapColors() });
  const hex = h('input', { class: 'cp-hex', type: 'text', maxlength: '7', spellcheck: 'false', 'aria-label': 'HEX' });
  const rgbIn = (['r', 'g', 'b'] as const).map((k) => h('input', { class: 'cp-rgb', type: 'number', min: '0', max: '255', 'aria-label': k.toUpperCase() }));
  const swatchGrid = h('div', { class: 'cp-swatches' });
  const recent = h('div', { class: 'cp-swatches recent' });

  const current = () => (target === 'fg' ? ed.fg : ed.bg);

  const paint = () => {
    const pure = rgbToHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 }));
    sv.style.setProperty('--hue', pure);
    svKnob.style.left = `${hsv.s * 100}%`;
    svKnob.style.top = `${(1 - hsv.v) * 100}%`;
    hueKnob.style.left = `${(hsv.h / 360) * 100}%`;
    hue.setAttribute('aria-valuenow', String(Math.round(hsv.h)));
    fgChip.style.background = ed.fg;
    bgChip.style.background = ed.bg;
    fgChip.classList.toggle('on', target === 'fg');
    bgChip.classList.toggle('on', target === 'bg');
    const cur = current();
    if (document.activeElement !== hex) hex.value = cur;
    const rgb = hexToRgb(cur)!;
    rgbIn.forEach((el, i) => {
      if (document.activeElement !== el) el.value = String([rgb.r, rgb.g, rgb.b][i]);
    });
    recent.replaceChildren(...ed.recentColors.map(swatch));
  };

  let internal = false;
  const commit = () => {
    internal = true;
    ed.setColor(target, rgbToHex(hsvToRgb(hsv)));
    internal = false;
    paint();
  };

  const dragArea = (el: HTMLElement, fn: (fx: number, fy: number) => void) => {
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const r = el.getBoundingClientRect();
        fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
      };
      move(e);
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        ed.pushRecent(current());
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  };
  dragArea(sv, (fx, fy) => {
    hsv = { ...hsv, s: fx, v: 1 - fy };
    commit();
  });
  dragArea(hue, (fx) => {
    hsv = { ...hsv, h: fx * 359.9 };
    commit();
  });
  sv.addEventListener('keydown', (e) => {
    const d = e.shiftKey ? 0.1 : 0.02;
    const m: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] };
    const v = m[e.key];
    if (!v) return;
    e.preventDefault();
    e.stopPropagation();
    hsv = { ...hsv, s: Math.max(0, Math.min(1, hsv.s + v[0])), v: Math.max(0, Math.min(1, hsv.v + v[1])) };
    commit();
  });
  hue.addEventListener('keydown', (e) => {
    const d = (e.shiftKey ? 15 : 3) * (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0);
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    hsv = { ...hsv, h: (hsv.h + d + 360) % 360 };
    commit();
  });

  hex.addEventListener('keydown', (e) => e.stopPropagation());
  hex.addEventListener('change', () => {
    const v = hex.value.startsWith('#') ? hex.value : `#${hex.value}`;
    const rgb = hexToRgb(v);
    if (!rgb) {
      paint();
      return;
    }
    hsv = rgbToHsv(rgb);
    commit();
    ed.pushRecent(current());
  });
  rgbIn.forEach((el) => {
    el.addEventListener('keydown', (e) => e.stopPropagation());
    el.addEventListener('change', () => {
      const [r, g, b] = rgbIn.map((x) => Math.max(0, Math.min(255, Number(x.value) || 0))) as [number, number, number];
      hsv = rgbToHsv({ r, g, b });
      commit();
    });
  });

  const setTarget = (t: 'fg' | 'bg') => {
    target = t;
    hsv = rgbToHsv(hexToRgb(current())!);
    paint();
  };
  fgChip.addEventListener('click', () => setTarget('fg'));
  bgChip.addEventListener('click', () => setTarget('bg'));

  function swatch(c: string): HTMLElement {
    const b = h('button', { class: 'swatch', type: 'button', style: `background:${c}`, 'aria-label': c, title: `${c} — щелчок: основной, Alt+щелчок: фоновый` });
    b.addEventListener('click', (e) => {
      const which = e.altKey ? 'bg' : target;
      ed.setColor(which, c);
      if (which === target) hsv = rgbToHsv(hexToRgb(c)!);
      paint();
    });
    return b;
  }
  swatchGrid.append(...SWATCHES.map(swatch));

  ed.events.on('colors', () => {
    if (!internal) hsv = rgbToHsv(hexToRgb(current())!);
    paint();
  });
  paint();

  return h(
    'div',
    { class: 'color-panel' },
    sv,
    hue,
    h(
      'div',
      { class: 'cp-row' },
      h('div', { class: 'cp-chips' }, bgChip, fgChip),
      swapBtn,
      h('label', { class: 'cp-field' }, h('span', null, 'HEX'), hex),
      ...rgbIn.map((el, i) => h('label', { class: 'cp-field small' }, h('span', null, 'RGB'[i]!), el)),
    ),
    swatchGrid,
    h('div', { class: 'cp-sub' }, 'Недавние'),
    recent,
  );
}
