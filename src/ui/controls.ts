import { h } from './dom';

/** Reusable form controls used by the options bar, panels and dialogs. */

export interface SliderHandle {
  el: HTMLElement;
  set(v: number): void;
  get(): number;
}

export function slider(o: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  compact?: boolean;
  tip?: string;
  onInput(v: number): void;
  onCommit?(v: number): void;
}): SliderHandle {
  const decimals = o.step < 1 ? (String(o.step).split('.')[1]?.length ?? 2) : 0;
  const fmt = (v: number) => v.toFixed(decimals);
  const range = h('input', { type: 'range', min: o.min, max: o.max, step: o.step, value: o.value, 'aria-label': o.label, class: 'range' });
  const num = h('input', { type: 'number', min: o.min, max: o.max, step: o.step, value: fmt(o.value), class: 'num', 'aria-label': `${o.label} (значение)` });
  const fill = () => {
    const t = ((Number(range.value) - o.min) / (o.max - o.min)) * 100;
    range.style.setProperty('--fill', `${t}%`);
  };
  const set = (v: number) => {
    const c = Math.max(o.min, Math.min(o.max, v));
    range.value = String(c);
    num.value = fmt(c);
    fill();
  };
  range.addEventListener('input', () => {
    num.value = fmt(Number(range.value));
    fill();
    o.onInput(Number(range.value));
  });
  range.addEventListener('change', () => o.onCommit?.(Number(range.value)));
  const fromNum = () => {
    const v = Number(num.value);
    if (!isFinite(v)) return set(Number(range.value));
    set(v);
    o.onInput(Number(range.value));
    o.onCommit?.(Number(range.value));
  };
  // 'change' fires once on Enter (via blur) or focus loss — never call fromNum twice
  num.addEventListener('change', fromNum);
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') num.blur();
    e.stopPropagation();
  });
  // double-click label resets to initial value
  const initial = o.value;
  const lab = h('span', { class: 'ctl-label', title: 'Двойной щелчок — сброс' }, o.label);
  lab.addEventListener('dblclick', () => {
    set(initial);
    o.onInput(initial);
    o.onCommit?.(initial);
  });
  fill();
  const el = h(
    'label',
    { class: `ctl slider${o.compact ? ' compact' : ''}`, 'data-tip': o.tip },
    lab,
    range,
    h('span', { class: 'num-wrap' }, num, o.unit ? h('span', { class: 'unit' }, o.unit) : null),
  );
  return { el, set, get: () => Number(range.value) };
}

export function checkbox(label: string, value: boolean, onChange: (v: boolean) => void, tip?: string): HTMLElement {
  const input = h('input', { type: 'checkbox', checked: value });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'ctl check', 'data-tip': tip }, input, h('span', { class: 'box' }), h('span', null, label));
}

export function select<T extends string>(label: string, options: { id: T; label: string }[], value: T, onChange: (v: T) => void): HTMLElement {
  const s = h('select', { class: 'select', 'aria-label': label });
  for (const o of options) s.append(h('option', { value: o.id, selected: o.id === value }, o.label));
  s.addEventListener('change', () => onChange(s.value as T));
  return h('label', { class: 'ctl' }, label ? h('span', { class: 'ctl-label' }, label) : null, s);
}

export function segmented<T extends string>(options: { id: T; label?: string; icon?: string; tip?: string }[], value: T, onChange: (v: T) => void): HTMLElement {
  const wrap = h('div', { class: 'segmented', role: 'radiogroup' });
  const btns = options.map((o) => {
    const b = h('button', { class: `seg${o.id === value ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(o.id === value), 'data-tip': o.tip, 'aria-label': o.tip ?? o.label }, );
    if (o.icon) b.insertAdjacentHTML('beforeend', o.icon);
    if (o.label) b.append(h('span', null, o.label));
    b.addEventListener('click', () => {
      btns.forEach((x) => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
      onChange(o.id);
    });
    return b;
  });
  wrap.append(...btns);
  return wrap;
}

export function button(label: string, onClick: () => void, opts: { primary?: boolean; icon?: string; tip?: string; ghost?: boolean } = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', class: `btn${opts.primary ? ' primary' : ''}${opts.ghost ? ' ghost' : ''}`, 'data-tip': opts.tip });
  if (opts.icon) b.insertAdjacentHTML('beforeend', opts.icon);
  if (label) b.append(h('span', null, label));
  b.addEventListener('click', onClick);
  return b;
}

export function iconButton(icon: string, tip: string, onClick: (e: MouseEvent) => void, key?: string): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'icon-btn', 'aria-label': tip, 'data-tip': tip, 'data-key': key });
  b.innerHTML = icon;
  b.addEventListener('click', onClick);
  return b;
}

export function divider(): HTMLElement {
  return h('span', { class: 'opt-divider', 'aria-hidden': 'true' });
}
