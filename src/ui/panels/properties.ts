import { createCanvas, ctx2d } from '../../core/canvas';
import { decodeCurves, encodeCurves, identityCurves } from '../../core/curves';
import type { Layer } from '../../core/document';
import type { Editor } from '../../core/editor';
import { compositeDoc } from '../../core/render';
import type { AdjustData, ShapeData, TextAlign } from '../../core/types';
import { FILTER_LIST, FILTERS } from '../../filters/filters';
import { button, checkbox, select, slider } from '../controls';
import { curveEditor, histograms } from '../curveEditor';
import { clear, h } from '../dom';
import { icons } from '../icons';
import { ALIGNS, FONTS } from '../../tools/text';
import { CORNER_STYLES } from '../../tools/shape';
import { defaultFx } from '../../core/layerFx';
import { cornerRadii } from '../../core/shapePath';
import type { CornerStyle, LayerFx } from '../../core/types';

/**
 * Properties panel: the live adjustment session (sliders / curves + apply/cancel) when one
 * is active; otherwise the active layer's properties — adjustment-layer settings, text and
 * shape attributes (re-editable), position and quick adjustment shortcuts.
 */
export function createPropertiesPanel(ed: Editor): HTMLElement {
  const root = h('div', { class: 'props-panel' });

  const numField = (label: string, value: number, onChange: (v: number) => void, opts: { min?: number; step?: string } = {}) => {
    const input = h('input', { type: 'number', class: 'num', value: String(Math.round(value * 100) / 100), 'aria-label': label, min: opts.min, step: opts.step ?? '1' });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.blur();
    });
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (isFinite(v)) onChange(v);
    });
    return h('label', { class: 'prop-field' }, h('span', null, label), input);
  };
  const colorField = (label: string, value: string, onChange: (v: string) => void) => {
    const input = h('input', { type: 'color', class: 'color-input', value, 'aria-label': label, 'data-tip': label });
    input.addEventListener('change', () => onChange(input.value));
    return input;
  };

  const renderAdjust = () => {
    const a = ed.adjust!;
    const resets: (() => void)[] = [];
    const controls: HTMLElement[] = [];
    if (a.filter.custom === 'curves') {
      const ce = curveEditor({ curves: decodeCurves(a.params), histogram: histograms(a.srcData.data), onChange: (c) => ed.updateAdjust(encodeCurves(c)) });
      controls.push(ce.el);
      resets.push(() => {
        ce.set(identityCurves());
        ed.updateAdjust(encodeCurves(identityCurves()));
      });
    }
    for (const p of a.filter.params) {
      if (p.toggle) {
        controls.push(checkbox(p.label, (a.params[p.key] ?? p.def) >= 0.5, (v) => ed.updateAdjust({ [p.key]: v ? 1 : 0 })));
        continue;
      }
      const s = slider({ label: p.label, min: p.min, max: p.max, step: p.step, value: a.params[p.key] ?? p.def, unit: p.unit, onInput: (v) => ed.updateAdjust({ [p.key]: v }) });
      controls.push(s.el);
      resets.push(() => {
        s.set(p.def);
        ed.updateAdjust({ [p.key]: p.def });
      });
    }
    root.append(
      h('div', { class: 'adjust-head' }, h('span', { class: 'adjust-title' }, a.filter.label), h('span', { class: 'adjust-layer' }, `Слой: ${a.layer.meta.name}`)),
      h('div', { class: 'adjust-sliders' }, ...controls),
      checkbox('Предпросмотр', a.previewOn, (v) => ed.setPreview(v)),
      ed.doc.selection.active ? h('div', { class: 'hint' }, 'Применяется только к выделенной области') : '',
      h(
        'div',
        { class: 'adjust-actions' },
        button('Сброс', () => resets.forEach((r) => r()), { ghost: true, icon: icons.reset }),
        h('span', { class: 'spacer' }),
        button('Отмена', () => ed.cancelAdjust(), { tip: 'Esc' }),
        button('Применить', () => void ed.applyAdjust(), { primary: true, tip: 'Enter' }),
      ),
    );
  };

  /** Histogram of what lies below an adjustment layer (downsampled). */
  const histBelow = (l: Layer): Uint32Array[] | null => {
    try {
      const k = Math.min(1, 384 / Math.max(ed.doc.width, ed.doc.height));
      const c = createCanvas(Math.max(1, Math.round(ed.doc.width * k)), Math.max(1, Math.round(ed.doc.height * k)));
      const x = ctx2d(c, { willReadFrequently: true });
      x.scale(k, k);
      compositeDoc(ed.doc, x, { committedOnly: true, until: ed.doc.indexOf(l.meta.id) });
      const hst = histograms(x.getImageData(0, 0, c.width, c.height).data);
      c.width = c.height = 1;
      return hst;
    } catch {
      return null;
    }
  };

  const renderAdjLayer = (l: Layer) => {
    const a = l.meta.adjust;
    const def = a ? FILTERS[a.filterId] : undefined;
    if (!a || !def) return;
    let before: AdjustData = { filterId: a.filterId, params: { ...a.params } };
    const commit = () => {
      ed.commitAdjustmentLayer(l.meta.id, before);
      before = { filterId: l.meta.adjust!.filterId, params: { ...l.meta.adjust!.params } };
    };
    const controls: HTMLElement[] = [];
    if (def.custom === 'curves') {
      const ce = curveEditor({
        curves: decodeCurves(a.params),
        histogram: histBelow(l),
        onChange: (c, final) => {
          ed.previewAdjustmentLayer(l.meta.id, encodeCurves(c));
          if (final) commit();
        },
      });
      controls.push(ce.el);
    }
    for (const p of def.params) {
      controls.push(
        slider({
          label: p.label, min: p.min, max: p.max, step: p.step, value: a.params[p.key] ?? p.def, unit: p.unit,
          onInput: (v) => ed.previewAdjustmentLayer(l.meta.id, { [p.key]: v }),
          onCommit: () => commit(),
        }).el,
      );
    }
    root.append(
      h('div', { class: 'adjust-head' }, h('span', { class: 'adjust-title', html: icons.adjust }, h('span', null, def.label)), h('span', { class: 'adjust-layer' }, 'Корректирующий слой')),
      h('div', { class: 'adjust-sliders' }, ...controls),
      h('div', { class: 'hint' }, 'Влияет на все слои ниже. Рисуйте по маске, чтобы ограничить область.'),
      h(
        'div',
        { class: 'adjust-actions' },
        button('Сброс', () => {
          const params = def.custom === 'curves' ? encodeCurves(identityCurves()) : Object.fromEntries(def.params.map((p) => [p.key, p.def]));
          l.meta.adjust = { filterId: a.filterId, params };
          commit();
        }, { ghost: true, icon: icons.reset }),
        h('span', { class: 'spacer' }),
        button(l.meta.visible ? 'Выключить' : 'Включить', () => ed.setLayerMeta(l.meta.id, { visible: !l.meta.visible }, l.meta.visible ? 'Скрыть слой' : 'Показать слой'), { tip: 'Видимость слоя' }),
      ),
    );
  };

  const renderText = (l: Layer) => {
    const t = l.meta.text!;
    const upd = (patch: Partial<typeof t>, coalesce = false) => ed.updateText(l.meta.id, { ...l.meta.text!, ...patch }, 'Стиль текста', coalesce);
    root.append(
      h('div', { class: 'cp-sub' }, 'Текст'),
      h(
        'div',
        { class: 'prop-stack' },
        select('Шрифт', FONTS, FONTS.some((f) => f.id === t.font) ? t.font : FONTS[0]!.id, (v) => upd({ font: v })),
        slider({ label: 'Размер', min: 6, max: 400, step: 1, value: t.size, unit: 'px', onInput: () => undefined, onCommit: (v) => upd({ size: v }) }).el,
        h(
          'div',
          { class: 'prop-row' },
          colorField('Цвет текста', t.color, (v) => upd({ color: v })),
          checkbox('Жирный', t.bold, (v) => upd({ bold: v })),
          checkbox('Курсив', t.italic, (v) => upd({ italic: v })),
        ),
        select<TextAlign>('Выравнивание', ALIGNS, t.align, (v) => upd({ align: v })),
        h('div', { class: 'prop-row' }, button('Изменить текст', () => editText(l), { icon: icons.text, tip: 'Или двойной щелчок по тексту на холсте' }), button('Растрировать', () => ed.rasterizeLayer(l.meta.id), { ghost: true })),
      ),
    );
  };

  const editText = (l: Layer) => {
    const tool = ed.tools.find((x) => x.id === 'text') as unknown as { edit(l: Layer): void } | undefined;
    tool?.edit(l);
  };

  const renderShape = (l: Layer) => {
    const s = l.meta.shape!;
    const upd = (patch: Partial<ShapeData>) => ed.updateShape(l.meta.id, patch);
    const names: Record<ShapeData['type'], string> = { rect: 'Прямоугольник', ellipse: 'Эллипс', line: 'Линия', polygon: 'Многоугольник', star: 'Звезда' };
    const rounded = s.type === 'rect' || s.type === 'polygon' || s.type === 'star';
    const radii = cornerRadii(s);
    const perCorner = !!s.radii;
    root.append(
      h('div', { class: 'cp-sub' }, `Фигура: ${names[s.type]}`),
      h(
        'div',
        { class: 'prop-stack' },
        h('div', { class: 'prop-grid' }, numField('Ш', s.w, (v) => upd({ w: Math.max(1, v) }), { min: 1 }), numField('В', s.h, (v) => upd({ h: Math.max(s.type === 'line' ? 0 : 1, v) }), { min: 0 })),
        s.type !== 'line'
          ? h('div', { class: 'prop-row' }, checkbox('Заливка', !!s.fill, (v) => upd({ fill: v ? s.fill ?? ed.fg : null })), colorField('Цвет заливки', s.fill ?? ed.fg, (v) => upd({ fill: v })))
          : '',
        h(
          'div',
          { class: 'prop-row' },
          s.type !== 'line' ? checkbox('Обводка', !!s.stroke, (v) => upd({ stroke: v ? s.stroke ?? ed.bg : null })) : h('span', { class: 'ctl-label' }, 'Линия'),
          colorField('Цвет обводки', s.stroke ?? ed.bg, (v) => upd({ stroke: v })),
        ),
        slider({ label: 'Толщина', min: 0, max: 200, step: 1, value: s.strokeWidth, unit: 'px', onInput: () => undefined, onCommit: (v) => upd({ strokeWidth: v }) }).el,
        rounded
          ? slider({ label: 'Скругление', min: 0, max: 500, step: 1, value: s.radius, unit: 'px', onInput: () => undefined, onCommit: (v) => upd({ radius: v, radii: undefined }) }).el
          : '',
        s.type === 'rect'
          ? h(
              'div',
              { class: 'prop-stack' },
              checkbox('Свои радиусы углов', perCorner, (v) => upd({ radii: v ? [radii[0], radii[1], radii[2], radii[3]] : undefined })),
              perCorner
                ? h(
                    'div',
                    { class: 'prop-grid' },
                    ...(['↖', '↗', '↘', '↙'] as const).map((name, i) =>
                      numField(name, radii[i]!, (v) => {
                        const next = [...cornerRadii(l.meta.shape!)] as [number, number, number, number];
                        next[i] = Math.max(0, v);
                        upd({ radii: next });
                      }, { min: 0 }),
                    ),
                  )
                : '',
            )
          : '',
        rounded ? select<CornerStyle>('Стиль углов', CORNER_STYLES, s.cornerStyle ?? 'round', (v) => upd({ cornerStyle: v })) : '',
        s.type === 'polygon' || s.type === 'star'
          ? slider({ label: s.type === 'star' ? 'Лучей' : 'Сторон', min: 3, max: 60, step: 1, value: s.sides ?? (s.type === 'star' ? 5 : 6), onInput: () => undefined, onCommit: (v) => upd({ sides: v }) }).el
          : '',
        s.type === 'star' ? slider({ label: 'Глубина', min: 0.05, max: 0.98, step: 0.01, value: s.innerRatio ?? 0.5, onInput: () => undefined, onCommit: (v) => upd({ innerRatio: v }) }).el : '',
        h('div', { class: 'prop-row' }, button('Растрировать', () => ed.rasterizeLayer(l.meta.id), { ghost: true, tip: 'Превратить в обычный пиксельный слой' })),
      ),
    );
  };

  /** Layer styles: shadow, glow, outline, overlay (non-destructive). */
  const renderFx = (l: Layer) => {
    const def = defaultFx();
    const cur: Required<LayerFx> = {
      shadow: { ...def.shadow, ...l.meta.fx?.shadow },
      glow: { ...def.glow, ...l.meta.fx?.glow },
      stroke: { ...def.stroke, ...l.meta.fx?.stroke },
      overlay: { ...def.overlay, ...l.meta.fx?.overlay },
    };
    const set = <K extends keyof LayerFx>(key: K, patch: Partial<Required<LayerFx>[K]>, coalesce = true) => {
      const base = { shadow: { ...cur.shadow }, glow: { ...cur.glow }, stroke: { ...cur.stroke }, overlay: { ...cur.overlay } } as Required<LayerFx>;
      Object.assign(base[key] as object, patch);
      (cur as Required<LayerFx>)[key] = base[key];
      ed.setLayerFx(l.meta.id, base, coalesce);
    };
    const sl = (label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void, unit?: string) =>
      slider({ label, min, max, step, value, unit, compact: true, onInput });
    const group = (title: string, on: boolean, toggle: (v: boolean) => void, body: () => (HTMLElement | string)[]) =>
      h('div', { class: 'fx-group' }, checkbox(title, on, (v) => {
        toggle(v);
        setTimeout(() => render(true), 0);
      }), on ? h('div', { class: 'prop-stack' }, ...body()) : '');
    root.append(
      h('div', { class: 'cp-sub' }, 'Стили слоя'),
      h(
        'div',
        { class: 'prop-stack' },
        group('Тень', cur.shadow.on, (v) => set('shadow', { on: v }, false), () => [
          h('div', { class: 'prop-row' }, colorField('Цвет тени', cur.shadow.color, (v) => set('shadow', { color: v }, false))),
          sl('Непрозр.', 0, 1, 0.05, cur.shadow.opacity, (v) => set('shadow', { opacity: v })).el,
          sl('Смещ. X', -100, 100, 1, cur.shadow.dx, (v) => set('shadow', { dx: v }), 'px').el,
          sl('Смещ. Y', -100, 100, 1, cur.shadow.dy, (v) => set('shadow', { dy: v }), 'px').el,
          sl('Размытие', 0, 100, 1, cur.shadow.blur, (v) => set('shadow', { blur: v }), 'px').el,
        ]),
        group('Свечение', cur.glow.on, (v) => set('glow', { on: v }, false), () => [
          h('div', { class: 'prop-row' }, colorField('Цвет свечения', cur.glow.color, (v) => set('glow', { color: v }, false))),
          sl('Непрозр.', 0, 1, 0.05, cur.glow.opacity, (v) => set('glow', { opacity: v })).el,
          sl('Размытие', 0, 100, 1, cur.glow.blur, (v) => set('glow', { blur: v }), 'px').el,
          sl('Сила', 1, 6, 1, cur.glow.strength, (v) => set('glow', { strength: v })).el,
        ]),
        group('Обводка', cur.stroke.on, (v) => set('stroke', { on: v }, false), () => [
          h('div', { class: 'prop-row' }, colorField('Цвет обводки', cur.stroke.color, (v) => set('stroke', { color: v }, false))),
          sl('Толщина', 1, 100, 1, cur.stroke.width, (v) => set('stroke', { width: v }), 'px').el,
          select<'outside' | 'inside' | 'center'>('Положение', [{ id: 'outside', label: 'Снаружи' }, { id: 'center', label: 'По центру' }, { id: 'inside', label: 'Внутри' }], cur.stroke.pos, (v) => set('stroke', { pos: v }, false)),
        ]),
        group('Наложение цвета', cur.overlay.on, (v) => set('overlay', { on: v }, false), () => [
          select<'color' | 'gradient'>('Тип', [{ id: 'color', label: 'Цвет' }, { id: 'gradient', label: 'Градиент' }], cur.overlay.mode, (v) => {
            set('overlay', { mode: v }, false);
            setTimeout(() => render(true), 0);
          }),
          h('div', { class: 'prop-row' }, colorField('Цвет 1', cur.overlay.color, (v) => set('overlay', { color: v }, false)), cur.overlay.mode === 'gradient' ? colorField('Цвет 2', cur.overlay.color2, (v) => set('overlay', { color2: v }, false)) : ''),
          cur.overlay.mode === 'gradient' ? sl('Угол', -180, 180, 1, cur.overlay.angle, (v) => set('overlay', { angle: v }), '°').el : '',
          sl('Непрозр.', 0, 1, 0.05, cur.overlay.opacity, (v) => set('overlay', { opacity: v })).el,
        ]),
      ),
    );
  };

  const renderLayer = () => {
    const l = ed.active;
    if (!l) {
      root.append(h('div', { class: 'empty' }, 'Нет слоёв'));
      return;
    }
    if (l.meta.kind === 'adjustment') return renderAdjLayer(l);
    root.append(
      h('div', { class: 'prop-grid' },
        numField('X', l.meta.x, (v) => ed.setLayerMeta(l.meta.id, { x: Math.round(v) }, 'Позиция слоя')),
        numField('Y', l.meta.y, (v) => ed.setLayerMeta(l.meta.id, { y: Math.round(v) }, 'Позиция слоя')),
        h('label', { class: 'prop-field' }, h('span', null, 'Ш'), h('output', null, String(l.width))),
        h('label', { class: 'prop-field' }, h('span', null, 'В'), h('output', null, String(l.height))),
      ),
    );
    if (l.meta.kind === 'text' && l.meta.text) renderText(l);
    if (l.meta.kind === 'shape' && l.meta.shape) renderShape(l);
    renderFx(l);
    root.append(
      h('div', { class: 'cp-sub' }, 'Коррекция'),
      h('div', { class: 'quick-grid' }, ...FILTER_LIST.filter((f) => f.group === 'adjust').map((f) => h('button', { type: 'button', class: 'chip', onclick: () => ed.startAdjust(f.id) }, f.label))),
      h('div', { class: 'cp-sub' }, 'Фильтры'),
      h('div', { class: 'quick-grid' }, ...FILTER_LIST.filter((f) => f.group === 'filter').map((f) => h('button', { type: 'button', class: 'chip', onclick: () => ed.startAdjust(f.id) }, f.label))),
    );
  };

  let lastKey = '';
  let interacting = false;
  root.addEventListener('pointerdown', () => (interacting = true));
  window.addEventListener('pointerup', () => {
    if (!interacting) return;
    interacting = false;
    setTimeout(() => render(), 0);
  });
  const render = (force = false) => {
    const a = ed.adjust;
    const l = ed.active;
    const key = a
      ? `adj:${a.filter.id}:${a.layer.meta.id}:${a.previewOn}`
      : `layer:${l?.meta.id}:${l?.meta.kind}:${l?.meta.x}:${l?.meta.y}:${l?.width}x${l?.height}:${l?.meta.visible}:${ed.doc.selection.active}:${JSON.stringify(l?.meta.text ?? l?.meta.shape ?? l?.meta.adjust ?? '')}:${JSON.stringify(l?.meta.fx ?? '')}`;
    if (!force && key === lastKey) return;
    // don't rebuild controls under the user's pointer (drags would break); sync on release
    if (!force && interacting) return;
    lastKey = key;
    clear(root);
    if (a) renderAdjust();
    else renderLayer();
  };
  ed.events.on('adjust', () => render(true));
  ed.events.on('doc', () => render());
  ed.events.on('selection', () => render());
  render(true);
  return root;
}
