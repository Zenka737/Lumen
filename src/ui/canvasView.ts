import type { Editor } from '../core/editor';
import { Renderer } from '../core/render';
import { BrushTool } from '../tools/brush';
import type { ToolPointer } from '../tools/tool';
import { h, isMac } from './dom';
import { createRulers, type RulersHandle } from './rulers';
import type { Layer } from '../core/document';

/**
 * The central viewport: owns the <canvas>, routes pointer input to the active tool,
 * implements wheel/pinch zoom, space-drag panning and drag & drop.
 */
export function createCanvasView(ed: Editor, onDropFiles: (files: File[]) => void, onEditShape: (l: Layer) => void = () => undefined): { root: HTMLElement; rulers: RulersHandle } {
  const canvas = h('canvas', { class: 'view-canvas', tabindex: '0', 'aria-label': 'Холст документа' });
  const dropHint = h('div', { class: 'drop-hint' }, h('div', null, 'Отпустите, чтобы добавить изображение'));
  const busy = h('div', { class: 'busy-chip', role: 'status' });
  const root = h('div', { class: 'viewport' }, canvas, dropHint, busy);
  ed.viewEl = root;
  const rulers = createRulers(ed, canvas);
  root.append(...rulers.el);

  const renderer = new Renderer(() => ed.doc, ed.view, canvas);
  ed.attachRenderer(renderer);
  renderer.overlays.push((ctx, view) => ed.tool?.overlay?.(ctx, view));

  let fitted = false;
  const ro = new ResizeObserver(() => {
    const r = root.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const ow = ed.view.width, oh = ed.view.height;
    renderer.resize(r.width, r.height);
    if (!fitted || ed.autoFit) {
      fitted = true;
      ed.fit();
    } else {
      // keep the document visually centred while the viewport resizes
      ed.view.panX += (r.width - ow) / 2;
      ed.view.panY += (r.height - oh) / 2;
      ed.viewChanged();
    }
  });
  ro.observe(root);

  ed.events.on('busy', (label) => {
    busy.textContent = label ?? '';
    busy.classList.toggle('show', !!label);
  });

  /* ----------------------------------------------------------- pointer routing */

  let spaceDown = false;
  let pan: { id: number; sx: number; sy: number; px: number; py: number } | null = null;
  let toolPointer: number | null = null;
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; cx: number; cy: number; zoom: number; px: number; py: number } | null = null;

  const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };
  const toTool = (e: PointerEvent): ToolPointer => {
    const { sx, sy } = local(e);
    const d = ed.view.toDoc(sx, sy);
    return {
      x: d.x,
      y: d.y,
      sx,
      sy,
      pressure: e.pressure,
      shift: e.shiftKey,
      alt: e.altKey,
      mod: isMac ? e.metaKey : e.ctrlKey,
      button: e.button,
      pointerType: e.pointerType,
    };
  };

  const updateCursor = () => {
    if (pan || spaceDown) canvas.style.cursor = pan ? 'grabbing' : 'grab';
    else canvas.style.cursor = ed.tool?.cursor() ?? 'default';
  };
  ed.events.on('tool', updateCursor);
  ed.events.on('view', updateCursor);

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      ed.reportError(err);
      ed.tool?.cancel?.();
      toolPointer = null;
    }
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus({ preventScroll: true });
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        // second finger: abort the stroke and start pinch-zoom
        if (toolPointer !== null) {
          ed.tool?.cancel?.();
          toolPointer = null;
        }
        const [a, b] = [...touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const r = canvas.getBoundingClientRect();
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top, zoom: ed.view.zoom, px: ed.view.panX, py: ed.view.panY };
        return;
      }
      if (touches.size > 2) return;
    }
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      e.preventDefault();
      const { sx, sy } = local(e);
      pan = { id: e.pointerId, sx, sy, px: ed.view.panX, py: ed.view.panY };
      canvas.setPointerCapture(e.pointerId);
      updateCursor();
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (ed.tool?.id === 'move') {
      const { sx, sy } = local(e);
      const gi = rulers.hitGuide(sx, sy);
      if (gi >= 0) {
        e.preventDefault();
        rulers.dragGuide(gi, e, canvas);
        return;
      }
    }
    if (ed.busy) {
      ed.ui.toast('Подождите — идёт обработка…', 'warn');
      return;
    }
    if (ed.adjust && ed.tool && !['hand', 'zoom'].includes(ed.tool.id)) {
      ed.ui.toast('Сначала примените или отмените коррекцию', 'warn');
      return;
    }
    e.preventDefault();
    toolPointer = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    safe(() => ed.tool?.down?.(toTool(e)));
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2) {
        const [a, b] = [...touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const r = canvas.getBoundingClientRect();
        const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
        const k = Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.dist);
        ed.view.panX = pinch.px + (cx - pinch.cx);
        ed.view.panY = pinch.py + (cy - pinch.cy);
        ed.view.zoomAt(pinch.zoom * k, cx, cy);
        ed.viewChanged();
        return;
      }
    }
    const { sx, sy } = local(e);
    const d = ed.view.toDoc(sx, sy);
    ed.events.emit('cursor', { x: d.x, y: d.y });
    if (pan && e.pointerId === pan.id) {
      ed.view.panX = pan.px + sx - pan.sx;
      ed.view.panY = pan.py + sy - pan.sy;
      ed.viewChanged();
      return;
    }
    if (toolPointer === e.pointerId) {
      // coalesced events give smooth strokes at high pointer rates
      const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const list = evs.length ? evs : [e];
      safe(() => {
        for (const ce of list) ed.tool?.move?.(toTool(ce));
      });
    } else if (toolPointer === null) {
      safe(() => ed.tool?.hover?.(toTool(e)));
      if (ed.tool?.id === 'crop' || ed.tool?.id === 'transform') updateCursor();
      if (ed.tool?.id === 'move' && !pan && ed.renderer && !(e.buttons & 1)) {
        const gi = rulers.hitGuide(sx, sy);
        if (gi !== ed.renderer.hotGuide) {
          ed.renderer.hotGuide = gi;
          ed.renderer.markView();
        }
        canvas.style.cursor = gi >= 0 ? (ed.doc.guides[gi]!.axis === 'v' ? 'col-resize' : 'row-resize') : ed.tool.cursor();
      }
    }
  });

  const end = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
    }
    if (pan && e.pointerId === pan.id) {
      pan = null;
      updateCursor();
      return;
    }
    if (toolPointer === e.pointerId) {
      toolPointer = null;
      if (e.type === 'pointercancel') safe(() => ed.tool?.cancel?.());
      else safe(() => ed.tool?.up?.(toTool(e)));
      updateCursor();
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', (e) => {
    if (toolPointer === e.pointerId) end(new PointerEvent('pointerup', e));
  });
  canvas.addEventListener('pointerleave', () => {
    ed.events.emit('cursor', null);
    if (ed.tool instanceof BrushTool && toolPointer === null) ed.tool.leave();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ----------------------------------------------------------- double-click: edit text / shape layers */
  canvas.addEventListener('dblclick', (e) => {
    if (ed.adjust || ed.busy || ed.tool?.id === 'text' || ed.tool?.id === 'transform') return;
    const { sx, sy } = local(e);
    const d = ed.view.toDoc(sx, sy);
    const ls = ed.doc.layers;
    for (let i = ls.length - 1; i >= 0; i--) {
      const l = ls[i]!;
      if (!l.meta.visible || (l.meta.kind !== 'text' && l.meta.kind !== 'shape')) continue;
      if (d.x < l.meta.x || d.y < l.meta.y || d.x >= l.meta.x + l.width || d.y >= l.meta.y + l.height) continue;
      if (l.meta.kind === 'text') {
        ed.tool?.cancel?.();
        (ed.tools.find((t) => t.id === 'text') as unknown as { edit(l: Layer): void } | undefined)?.edit(l);
      } else {
        ed.selectLayer(l.meta.id);
        onEditShape(l);
      }
      return;
    }
  });

  /* ----------------------------------------------------------- wheel: pan / zoom */

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const { sx, sy } = local(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
      if (e.ctrlKey || e.metaKey || e.altKey) {
        // trackpad pinch arrives as ctrl+wheel with small deltas
        const k = Math.exp(-dy * (e.ctrlKey && Math.abs(dy) < 50 ? 0.01 : 0.0025));
        ed.view.zoomAt(ed.view.zoom * k, sx, sy);
      } else if (e.shiftKey && !dx) {
        ed.view.panX -= dy;
      } else {
        ed.view.panX -= dx;
        ed.view.panY -= dy;
      }
      ed.viewChanged();
    },
    { passive: false },
  );

  /* ----------------------------------------------------------- space = temporary hand */

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.tagName === 'BUTTON' || t.tagName === 'SELECT')) return;
    if (document.querySelector('.modal-backdrop')) return;
    e.preventDefault();
    spaceDown = true;
    updateCursor();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    spaceDown = false;
    updateCursor();
  });
  window.addEventListener('blur', () => {
    spaceDown = false;
    pan = null;
    if (toolPointer !== null) {
      ed.tool?.cancel?.();
      toolPointer = null;
    }
    updateCursor();
  });

  /* ----------------------------------------------------------- drag & drop */

  let dragDepth = 0;
  root.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    root.classList.add('dragging');
  });
  root.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  root.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) root.classList.remove('dragging');
  });
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    root.classList.remove('dragging');
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) onDropFiles(files);
  });

  updateCursor();
  return { root, rulers };
}
