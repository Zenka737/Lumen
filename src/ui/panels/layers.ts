import { BLEND_MODES } from '../../core/blend';
import { ctx2d } from '../../core/canvas';
import type { Layer } from '../../core/document';
import { ADJUSTMENT_LAYER_TYPES, type Editor } from '../../core/editor';
import { FILTERS } from '../../filters/filters';
import type { BlendMode } from '../../core/types';
import { iconButton, select, slider } from '../controls';
import { clear, h } from '../dom';
import { icons } from '../icons';

const THUMB = 34;

/** Layers panel: list (top = topmost), visibility/lock toggles, rename, drag reorder. */
export function createLayersPanel(ed: Editor): HTMLElement {
  const list = h('div', { class: 'layer-list', role: 'listbox', 'aria-label': 'Слои' });
  const blendWrap = h('div', { class: 'layer-blend' });
  const adjMenu = h('div', { class: 'adj-menu', role: 'menu' });
  for (const id of ADJUSTMENT_LAYER_TYPES) {
    const def = FILTERS[id]!;
    adjMenu.append(
      h('button', { type: 'button', class: 'menu-item', role: 'menuitem', onclick: () => { adjMenu.classList.remove('open'); ed.addAdjustmentLayer(id); } }, def.label),
    );
  }
  const adjMenuBtn = h('span', { class: 'adj-wrap' }, iconButton(icons.adjust, 'Новый корректирующий слой', (e) => {
    e.stopPropagation();
    adjMenu.classList.toggle('open');
  }), adjMenu);
  document.addEventListener('pointerdown', (e) => {
    if (!adjMenuBtn.contains(e.target as Node)) adjMenu.classList.remove('open');
  });
  const footer = h(
    'div',
    { class: 'panel-footer' },
    iconButton(icons.plus, 'Новый слой', () => ed.addLayer(), '⇧Ctrl+N'),
    iconButton(icons.copy, 'Дублировать слой', () => ed.duplicateLayer(), 'Ctrl+J'),
    iconButton(icons.merge, 'Объединить с нижним', () => ed.mergeDown(), 'Ctrl+E'),
    iconButton(icons.mask, 'Добавить маску слоя (из выделения, если оно есть)', () => ed.addMask()),
    adjMenuBtn,
    h('span', { class: 'spacer' }),
    iconButton(icons.trash, 'Удалить слой', () => ed.deleteLayer(), 'Del'),
  );
  const thumbs = new Map<string, { canvas: HTMLCanvasElement; version: number; src: HTMLCanvasElement }>();
  const maskThumbs = new Map<string, { canvas: HTMLCanvasElement; version: number; src: HTMLCanvasElement }>();

  const drawMaskThumb = (l: Layer, c: HTMLCanvasElement) => {
    const ctx = ctx2d(c);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = THUMB * dpr;
    c.height = THUMB * dpr;
    const m = l.mask!;
    const k = Math.min(c.width / m.width, c.height / m.height);
    const w = m.width * k, hh = m.height * k;
    ctx.fillStyle = '#000';
    ctx.fillRect((c.width - w) / 2, (c.height - hh) / 2, w, hh);
    ctx.drawImage(m, (c.width - w) / 2, (c.height - hh) / 2, w, hh);
  };

  const drawThumb = (l: Layer, c: HTMLCanvasElement) => {
    const ctx = ctx2d(c);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = THUMB * dpr;
    c.height = THUMB * dpr;
    ctx.clearRect(0, 0, c.width, c.height);
    // thumbnail shows the layer in document context
    const W = ed.doc.width, H = ed.doc.height;
    const k = Math.min(c.width / W, c.height / H);
    const ox = (c.width - W * k) / 2, oy = (c.height - H * k) / 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, W * k, H * k);
    ctx.clip();
    ctx.drawImage(l.canvas, ox + l.meta.x * k, oy + l.meta.y * k, l.width * k, l.height * k);
    ctx.restore();
  };

  let dragging: { id: string; from: number; startY: number; el: HTMLElement; started: boolean; target: number } | null = null;

  window.addEventListener('pointerup', () => {
    if (dragging && !dragging.started) dragging = null;
  });

  const rebuild = () => {
    const layers = ed.doc.layers;
    const active = ed.active;
    clear(list);
    const seen = new Set<string>();
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i]!;
      seen.add(l.meta.id);
      let t = thumbs.get(l.meta.id);
      if (!t || t.src !== l.canvas) {
        t = { canvas: t?.canvas ?? h('canvas', { class: 'thumb-canvas' }), version: -1, src: l.canvas };
        thumbs.set(l.meta.id, t);
      }
      if (t.version !== l.pixelVersion) {
        drawThumb(l, t.canvas);
        t.version = l.pixelVersion;
      }
      const name = h('span', { class: 'layer-name', title: 'Двойной щелчок — переименовать' }, l.meta.name);
      const isAdj = l.meta.kind === 'adjustment';
      const target = l === active && l.mask && (ed.maskEdit || isAdj) ? 'mask' : 'pixels';
      const thumbEl = isAdj
        ? h('span', { class: 'thumb adj-thumb', html: icons.adjust, 'data-tip': FILTERS[l.meta.adjust?.filterId ?? '']?.label ?? 'Коррекция' })
        : h('span', { class: `thumb${l === active && target === 'pixels' && l.mask ? ' target' : ''}`, 'data-tip': l.meta.kind === 'text' ? 'Двойной щелчок — изменить текст' : undefined }, t.canvas);
      thumbEl.addEventListener('click', (e) => {
        e.stopPropagation();
        ed.selectLayer(l.meta.id);
        ed.setMaskEdit(false);
      });
      if (l.meta.kind === 'text') {
        thumbEl.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          (ed.tools.find((x) => x.id === 'text') as unknown as { edit(l: Layer): void } | undefined)?.edit(l);
        });
      }
      let maskEl: HTMLElement | null = null;
      if (l.mask) {
        let mt = maskThumbs.get(l.meta.id);
        if (!mt || mt.src !== l.mask) {
          mt = { canvas: mt?.canvas ?? h('canvas', { class: 'thumb-canvas' }), version: -1, src: l.mask };
          maskThumbs.set(l.meta.id, mt);
        }
        if (mt.version !== l.pixelVersion) {
          drawMaskThumb(l, mt.canvas);
          mt.version = l.pixelVersion;
        }
        maskEl = h(
          'span',
          {
            class: `thumb mask-thumb${target === 'mask' ? ' target' : ''}${l.meta.maskEnabled === false ? ' off' : ''}`,
            'data-tip': 'Маска: щелчок — рисовать по маске, Shift — вкл/выкл, ⌘/Ctrl — загрузить как выделение',
            role: 'button',
            'aria-label': 'Маска слоя',
          },
          mt.canvas,
        );
        maskEl.addEventListener('click', (e) => {
          e.stopPropagation();
          ed.selectLayer(l.meta.id);
          if (e.shiftKey) ed.toggleMask(l.meta.id);
          else if (e.metaKey || e.ctrlKey) ed.selectionFromMask(l.meta.id);
          else ed.setMaskEdit(true);
        });
      }
      const row = h(
        'div',
        {
          class: `layer-row${l === active ? ' active' : ''}${l.meta.visible ? '' : ' hidden'}`,
          role: 'option',
          'aria-selected': String(l === active),
          tabindex: '0',
          'data-id': l.meta.id,
        },
        iconButton(l.meta.visible ? icons.eye : icons.eyeOff, l.meta.visible ? 'Скрыть слой' : 'Показать слой', (e) => {
          e.stopPropagation();
          ed.setLayerMeta(l.meta.id, { visible: !l.meta.visible }, l.meta.visible ? 'Скрыть слой' : 'Показать слой');
        }),
        thumbEl,
        maskEl,
        h('span', { class: 'layer-info' }, name, h('span', { class: 'layer-sub' }, kindLabel(l), l.meta.blend !== 'normal' ? ` · ${BLEND_MODES.find((m) => m.id === l.meta.blend)?.label}` : '', l.meta.opacity < 1 ? ` · ${Math.round(l.meta.opacity * 100)}%` : '')),
        iconButton(l.meta.locked ? icons.lock : icons.unlock, l.meta.locked ? 'Разблокировать' : 'Заблокировать', (e) => {
          e.stopPropagation();
          ed.setLayerMeta(l.meta.id, { locked: !l.meta.locked }, l.meta.locked ? 'Разблокировать слой' : 'Заблокировать слой');
        }),
      );
      if (l.meta.locked) row.classList.add('locked');
      row.addEventListener('click', () => ed.selectLayer(l.meta.id));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') startRename(l, name);
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          const idx = ed.doc.indexOf(l.meta.id) + (e.key === 'ArrowUp' ? 1 : -1);
          if (e.altKey) ed.moveLayer(ed.doc.indexOf(l.meta.id), idx);
          else {
            const n = ed.doc.layers[idx];
            if (n) ed.selectLayer(n.meta.id);
          }
          requestAnimationFrame(() => list.querySelector<HTMLElement>('.layer-row.active')?.focus());
        }
      });
      row.addEventListener('dblclick', (e) => {
        if ((e.target as HTMLElement).closest('button, input')) return;
        startRename(l, name);
      });
      row.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).closest('button, input')) return;
        dragging = { id: l.meta.id, from: i, startY: e.clientY, el: row, started: false, target: i };
      });
      row.addEventListener('pointermove', (e) => {
        const d = dragging;
        if (!d || d.el !== row) return;
        if (!d.started && Math.abs(e.clientY - d.startY) > 4) {
          d.started = true;
          // capture only once a drag really starts so clicks/double-clicks stay untouched
          row.setPointerCapture(e.pointerId);
          row.classList.add('dragging');
          list.classList.add('reordering');
        }
        if (!d.started) return;
        row.style.transform = `translateY(${e.clientY - d.startY}px)`;
        // determine drop index by row midpoints
        const rows = Array.from(list.querySelectorAll<HTMLElement>('.layer-row')).filter((r) => r !== row);
        let pos = rows.length; // visual position from top
        for (let k = 0; k < rows.length; k++) {
          const r = rows[k]!.getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) {
            pos = k;
            break;
          }
        }
        rows.forEach((r, k) => r.classList.toggle('drop-before', k === pos));
        list.classList.toggle('drop-end', pos === rows.length);
        d.target = layers.length - 1 - pos;
      });
      const endDrag = () => {
        const d = dragging;
        if (!d || d.el !== row) return;
        dragging = null;
        list.classList.remove('reordering', 'drop-end');
        if (d.started) {
          row.style.transform = '';
          row.classList.remove('dragging');
          if (d.target !== d.from) ed.moveLayer(d.from, d.target);
          else rebuild();
        }
      };
      row.addEventListener('pointerup', endDrag);
      row.addEventListener('pointercancel', endDrag);
      list.append(row);
    }
    for (const id of thumbs.keys()) if (!seen.has(id)) thumbs.delete(id);
    for (const id of maskThumbs.keys()) if (!seen.has(id)) maskThumbs.delete(id);

    // active layer opacity & blend controls
    clear(blendWrap);
    if (active) {
      blendWrap.append(
        select<BlendMode>('', BLEND_MODES, active.meta.blend, (v) => ed.setLayerMeta(active.meta.id, { blend: v }, 'Режим наложения')),
        slider({
          label: 'Непрозр.',
          min: 0,
          max: 100,
          step: 1,
          value: Math.round(active.meta.opacity * 100),
          unit: '%',
          compact: true,
          onInput: (v) => {
            // live preview without rebuilding the panel; history recorded (coalesced) on commit
            active.meta.opacity = v / 100;
            ed.redraw();
          },
          onCommit: (v) => {
            const target = v / 100;
            active.meta.opacity = opacityAtStart;
            ed.setLayerMeta(active.meta.id, { opacity: target }, 'Непрозрачность слоя', true);
            opacityAtStart = target;
          },
        }).el,
      );
      opacityAtStart = active.meta.opacity;
    }
  };
  let opacityAtStart = 1;

  function startRename(l: Layer, nameEl: HTMLElement): void {
    const input = h('input', { class: 'rename', value: l.meta.name, 'aria-label': 'Имя слоя', maxlength: '120' });
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (ok && v && v !== l.meta.name) ed.setLayerMeta(l.meta.id, { name: v }, 'Переименовать слой');
      else rebuild();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // pixel changes → refresh thumbnails (throttled)
  let thumbTimer = 0;
  ed.events.on('pixels', () => {
    if (thumbTimer) return;
    thumbTimer = window.setTimeout(() => {
      thumbTimer = 0;
      for (const l of ed.doc.layers) {
        const t = thumbs.get(l.meta.id);
        if (t && t.src === l.canvas && t.version !== l.pixelVersion) {
          drawThumb(l, t.canvas);
          t.version = l.pixelVersion;
        }
        const mt = maskThumbs.get(l.meta.id);
        if (mt && l.mask && mt.src === l.mask && mt.version !== l.pixelVersion) {
          drawMaskThumb(l, mt.canvas);
          mt.version = l.pixelVersion;
        }
      }
    }, 250);
  });
  ed.events.on('doc', () => {
    if (!dragging) rebuild();
  });
  rebuild();
  return h('div', { class: 'layers-panel' }, blendWrap, list, footer);
}

function kindLabel(l: Layer): string {
  const k = l.meta.kind;
  const base = k === 'image' ? 'Изображение' : k === 'text' ? 'Текст' : k === 'shape' ? 'Фигура' : k === 'adjustment' ? 'Коррекция' : 'Растровый';
  return l.mask ? `${base} · маска${l.meta.maskEnabled === false ? ' (выкл.)' : ''}` : base;
}
