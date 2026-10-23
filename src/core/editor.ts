import { clearAutosave, saveAutosave } from './autosave';
import { cloneCanvas, createCanvas, ctx2d, disposeCanvas, MAX_SIDE, readPixels, resampleCanvas } from './canvas';
import { hexToRgb, rgbToHex } from './color';
import { createLayer, Doc, Layer, newId } from './document';
import { Emitter } from './emitter';
import { History } from './history';
import { checkSize, decodeImage, fitWithin, toCanvas } from './imageio';
import { copyName, indexAfterDelete, moveItem, nextLayerName, uniqueName } from './layerOps';
import { parseProject, recordFromDoc } from './project';
import { applyAdjustmentLayer, compositeDoc, flattenToCanvas, Renderer } from './render';
import type { SelPart, SelState } from './selection';
import { toCompositeOp } from './blend';
import { cloneFx, type AdjustData, type LayerFx, type LayerMeta, type Rect, type ShapeData, type TextData } from './types';
import { cloneMeta, rectClip } from './types';
import { Viewport } from './viewport';
import { combineMasks, featherMask, growMask, invertMask } from './maskOps';
import { floodMask } from './floodfill';
import { renderShape, renderText, shapePad } from './vector';
import { snapPoint, snapRectOffset, snapTargets } from './guides';
import { encodeCurves, identityCurves } from './curves';
import { defaults, FILTERS, hasControls, scaleParams, type FilterDef, type Params } from '../filters/filters';
import { FilterRunner } from '../filters/runner';
import type { Tool } from '../tools/tool';

export interface EditorEvents {
  /** Layer list / metadata / document size changed. */
  doc: void;
  /** Pixels changed (thumbnails). */
  pixels: void;
  history: void;
  tool: string;
  colors: void;
  view: void;
  selection: void;
  cursor: { x: number; y: number } | null;
  adjust: void;
  saved: { time: number; ok: boolean };
  busy: string | null;
  toolOptions: void;
  /** Animation timeline data changed. */
  animation: void;
}

export type ToastKind = 'info' | 'success' | 'error' | 'warn';

/** Hooks implemented by the UI layer (keeps core free of DOM widgets). */
export interface EditorUI {
  toast(msg: string, kind?: ToastKind): void;
  askLargeImage(w: number, h: number, mustDownscale: boolean): Promise<'downscale' | 'keep' | 'cancel'>;
}

interface LayerState {
  layer: Layer;
  meta: LayerMeta;
  canvas: HTMLCanvasElement;
  mask: HTMLCanvasElement | null;
}
interface DocState {
  layers: LayerState[];
  activeId: string;
  width: number;
  height: number;
  selection: SelState;
}

export type PaintTarget = 'pixels' | 'mask';
export type SelMode = 'new' | 'add' | 'sub' | 'intersect';

/** Perceived luminance of a hex colour, 0..255 (decides reveal/hide when painting masks). */
export function hexLuma(hex: string): number {
  const c = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Copies the alpha channel of a canvas into a compact array. */
export function canvasAlpha(c: HTMLCanvasElement): Uint8ClampedArray {
  const d = readPixels(c, 0, 0, c.width, c.height).data;
  const a = new Uint8ClampedArray(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3]!;
  return a;
}

/** White canvas whose alpha is `a`. */
export function alphaCanvas(a: ArrayLike<number>, w: number, h: number): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = a[i]!;
  }
  ctx2d(c).putImageData(img, 0, 0);
  return c;
}

/** Opaque white canvas (a "reveal all" mask). */
export function whiteCanvas(w: number, h: number): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const x = ctx2d(c);
  x.fillStyle = '#fff';
  x.fillRect(0, 0, w, h);
  return c;
}

/** Applies the same geometric operation to a layer's mask as to its pixels. */
function mapMask(l: Layer, fn: (src: HTMLCanvasElement) => HTMLCanvasElement): void {
  if (l.mask) l.mask = fn(l.mask);
}

export const ADJUSTMENT_LAYER_TYPES = ['brightnessContrast', 'hueSat', 'levels', 'curves'] as const;

export interface AdjustSession {
  filter: FilterDef;
  params: Params;
  layer: Layer;
  previewOn: boolean;
  scale: number;
  /** Downsampled copy of the layer used as preview input. */
  src: HTMLCanvasElement;
  srcData: ImageData;
  token: number;
  timer: number;
  pending: boolean;
}

const AUTOSAVE_DELAY = 2500;

export class Editor {
  doc: Doc = new Doc(1, 1);
  readonly history = new History();
  readonly events = new Emitter<EditorEvents>();
  readonly view = new Viewport();
  readonly runner = new FilterRunner();
  renderer: Renderer | null = null;
  ui: EditorUI = { toast: (m) => console.log(m), askLargeImage: async () => 'downscale' };
  /** Container element of the canvas view (tools mount overlays like the text editor here). */
  viewEl: HTMLElement | null = null;

  fg = '#000000';
  bg = '#ffffff';
  recentColors: string[] = [];
  tools: Tool[] = [];
  tool: Tool | null = null;
  adjust: AdjustSession | null = null;
  busy: string | null = null;
  revision = 0;
  savedRevision = 0;
  private autosaveTimer = 0;
  private autosaving = false;
  autosaveEnabled = true;
  private clipboard: { canvas: HTMLCanvasElement; x: number; y: number } | null = null;
  /** Paint on the active layer's mask instead of its pixels. */
  maskEdit = false;
  snapEnabled = true;
  showRulers = true;

  constructor() {
    this.history.onChange(() => this.events.emit('history', undefined));
  }

  /* ------------------------------------------------------------------ basics */

  attachRenderer(r: Renderer): void {
    this.renderer = r;
  }

  get active(): Layer | null {
    return this.doc.active;
  }

  /** Call after editing `doc.animation`: marks the document dirty and refreshes the timeline. */
  animationChanged(): void {
    this.revision++;
    this.scheduleAutosave();
    this.events.emit('animation', undefined);
  }

  /** Marks the document changed. `structure` → panels rebuild. `rect` → partial recomposite. */
  touch(structure: boolean, rect?: Rect | null): void {
    this.revision++;
    this.renderer?.markDoc(rect ?? null);
    if (structure) this.events.emit('doc', undefined);
    this.events.emit('pixels', undefined);
    this.scheduleAutosave();
  }

  /** Re-render only (no document modification). */
  redraw(rect?: Rect | null): void {
    this.renderer?.markDoc(rect ?? null);
  }

  setBusy(label: string | null): void {
    this.busy = label;
    this.events.emit('busy', label);
  }

  /* ------------------------------------------------------------------ tools */

  setTool(id: string): void {
    const t = this.tools.find((x) => x.id === id);
    if (!t || t === this.tool) return;
    this.tool?.cancel?.();
    this.tool?.deactivate?.();
    this.tool = t;
    t.activate?.();
    this.events.emit('tool', id);
    this.renderer?.markView();
  }

  setColor(which: 'fg' | 'bg', hex: string): void {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    this[which] = rgbToHex(rgb);
    this.events.emit('colors', undefined);
  }
  pushRecent(hex: string): void {
    this.recentColors = [hex, ...this.recentColors.filter((c) => c !== hex)].slice(0, 12);
    this.events.emit('colors', undefined);
  }
  swapColors(): void {
    [this.fg, this.bg] = [this.bg, this.fg];
    this.events.emit('colors', undefined);
  }
  resetColors(): void {
    this.fg = '#000000';
    this.bg = '#ffffff';
    this.events.emit('colors', undefined);
  }

  /* ------------------------------------------------------------------ document lifecycle */

  newDocument(w: number, h: number, background: 'white' | 'transparent' | 'fg' | 'bg' | string, name = 'Без названия'): void {
    w = Math.max(1, Math.min(MAX_SIDE, Math.round(w)));
    h = Math.max(1, Math.min(MAX_SIDE, Math.round(h)));
    const doc = new Doc(w, h, name);
    const layer = createLayer('Фон', w, h);
    if (background !== 'transparent') {
      const color = background === 'white' ? '#ffffff' : background === 'fg' ? this.fg : background === 'bg' ? this.bg : background;
      const c = ctx2d(layer.canvas);
      c.fillStyle = color;
      c.fillRect(0, 0, w, h);
    }
    doc.layers.push(layer);
    doc.activeId = layer.meta.id;
    this.loadDoc(doc);
  }

  loadDoc(doc: Doc): void {
    this.cancelAdjust();
    this.tool?.cancel?.();
    for (const l of this.doc.layers) if (!doc.layers.includes(l)) disposeCanvas(l.canvas);
    this.doc = doc;
    this.history.clear();
    this.fit();
    this.touch(true);
    this.events.emit('selection', undefined);
  }

  /* ------------------------------------------------------------------ view */

  /** True while the view is in "fit to screen" mode (re-fits on viewport resize). */
  autoFit = true;
  fit(): void {
    this.view.fit(this.doc.width, this.doc.height);
    this.viewChanged();
    this.autoFit = true;
  }
  actualPixels(): void {
    this.view.zoom = 1;
    this.view.center(this.doc.width, this.doc.height);
    this.viewChanged();
  }
  viewChanged(): void {
    this.autoFit = false;
    this.view.clampPan(this.doc.width, this.doc.height);
    this.renderer?.markView();
    this.events.emit('view', undefined);
  }

  /* ------------------------------------------------------------------ history primitives */

  private snapshot(): DocState {
    return {
      layers: this.doc.layers.map((l) => ({ layer: l, meta: cloneMeta(l.meta), canvas: l.canvas, mask: l.mask })),
      activeId: this.doc.activeId,
      width: this.doc.width,
      height: this.doc.height,
      selection: this.doc.selection.getState(),
    };
  }

  private restore(s: DocState): void {
    this.cancelAdjust();
    this.doc.layers = s.layers.map((st) => {
      st.layer.meta = cloneMeta(st.meta);
      st.layer.canvas = st.canvas;
      st.layer.mask = st.mask;
      st.layer.pixelVersion++;
      return st.layer;
    });
    this.doc.width = s.width;
    this.doc.height = s.height;
    this.doc.activeId = s.activeId;
    this.doc.selection.setState(s.selection);
    if (this.maskEdit && !this.doc.active?.mask) this.maskEdit = false;
    this.touch(true);
    this.events.emit('selection', undefined);
  }

  /**
   * Runs `fn` (which may change layers, metadata, canvases, size, selection) and records it
   * as one undoable step. Returns false if fn threw (state is rolled back).
   */
  structural(label: string, fn: () => void, coalesceKey?: string): boolean {
    if (this.adjust) this.cancelAdjust();
    const before = this.snapshot();
    try {
      fn();
    } catch (err) {
      this.restore(before);
      this.reportError(err);
      return false;
    }
    const after = this.snapshot();
    const canvasesOf = (st: DocState) => new Set(st.layers.flatMap((l) => (l.mask ? [l.canvas, l.mask] : [l.canvas])));
    const beforeCanvases = canvasesOf(before);
    const afterCanvases = canvasesOf(after);
    let bytes = 256;
    for (const c of afterCanvases) if (!beforeCanvases.has(c)) bytes += c.width * c.height * 4;
    for (const c of beforeCanvases) if (!afterCanvases.has(c)) bytes += c.width * c.height * 4;
    this.history.push({ label, bytes, coalesceKey, undo: () => this.restore(before), redo: () => this.restore(after) });
    this.touch(true);
    return true;
  }

  /**
   * Records a pixel edit on `layer` limited to `rect` (layer coords, null = whole layer).
   * Only the dirty rectangle is stored (before & after), keeping history memory small.
   */
  pixelEdit(layer: Layer, rect: Rect | null, label: string, fn: (ctx: CanvasRenderingContext2D) => void, target: PaintTarget = 'pixels'): boolean {
    const canvas = target === 'mask' && layer.mask ? layer.mask : layer.canvas;
    const r = rectClip(rect ?? { x: 0, y: 0, w: canvas.width, h: canvas.height }, canvas.width, canvas.height);
    const ctx = ctx2d(canvas);
    if (!r) {
      fn(ctx);
      return false;
    }
    const before = readPixels(canvas, r.x, r.y, r.w, r.h);
    try {
      ctx.save();
      fn(ctx);
      ctx.restore();
    } catch (err) {
      ctx.putImageData(before, r.x, r.y);
      this.reportError(err);
      return false;
    }
    const after = readPixels(canvas, r.x, r.y, r.w, r.h);
    const apply = (img: ImageData) => {
      ctx2d(canvas).putImageData(img, r.x, r.y);
      layer.pixelVersion++;
      this.touch(false, { x: r.x + layer.meta.x, y: r.y + layer.meta.y, w: r.w, h: r.h });
    };
    this.history.push({ label, bytes: r.w * r.h * 8, undo: () => apply(before), redo: () => apply(after) });
    layer.pixelVersion++;
    this.touch(false, { x: r.x + layer.meta.x, y: r.y + layer.meta.y, w: r.w, h: r.h });
    return true;
  }

  undo(): void {
    if (this.tool?.active) this.tool.cancel?.();
    if (this.adjust) {
      this.cancelAdjust();
      return;
    }
    if (!this.history.undo()) this.ui.toast('Нечего отменять');
  }
  redo(): void {
    if (this.tool?.active) this.tool.cancel?.();
    this.cancelAdjust();
    if (!this.history.redo()) this.ui.toast('Нечего повторять');
  }

  reportError(err: unknown): void {
    console.error('[Lumen]', err);
    const msg = err instanceof Error ? err.message : String(err);
    this.ui.toast(msg || 'Неизвестная ошибка', 'error');
  }

  /* ------------------------------------------------------------------ layer checks */

  /** Where painting tools draw on `l`: its mask (when mask editing is on) or its pixels. */
  paintTarget(l: Layer | null = this.active): PaintTarget {
    // adjustment layers have no pixels of their own: painting always targets their mask
    return l && l.mask && (this.maskEdit || l.meta.kind === 'adjustment') ? 'mask' : 'pixels';
  }
  targetCanvas(l: Layer): HTMLCanvasElement {
    return this.paintTarget(l) === 'mask' ? l.mask! : l.canvas;
  }

  /**
   * Active layer if editable; otherwise toasts why not and returns null.
   * purpose 'pixels' needs real pixels (text/shape layers are rasterised on demand);
   * 'paint' also accepts the layer mask as the target.
   */
  editableLayer(requireVisible = true, purpose: 'any' | 'pixels' | 'paint' = 'any'): Layer | null {
    const l = this.active;
    if (!l) {
      this.ui.toast('Нет активного слоя', 'warn');
      return null;
    }
    if (l.meta.locked) {
      this.ui.toast('Слой заблокирован — снимите замок на панели «Слои»', 'warn');
      return null;
    }
    if (requireVisible && !l.meta.visible) {
      this.ui.toast('Слой скрыт — включите его видимость', 'warn');
      return null;
    }
    if (purpose === 'any' || (purpose === 'paint' && this.paintTarget(l) === 'mask')) return l;
    if (l.meta.kind === 'adjustment') {
      this.ui.toast('У корректирующего слоя нет пикселей — выберите его маску', 'warn');
      return null;
    }
    if (l.meta.kind === 'text' || l.meta.kind === 'shape') {
      if (!this.rasterizeLayer(l.meta.id)) return null;
      this.ui.toast('Слой растрирован для рисования', 'info');
    }
    return l;
  }

  /** Selection mask aligned to a layer's coordinate space (or null = no selection). */
  layerMask(layer: Layer): HTMLCanvasElement | null {
    const m = this.doc.selection.mask(this.doc.width, this.doc.height);
    if (!m) return null;
    const c = createCanvas(layer.width, layer.height);
    ctx2d(c).drawImage(m, -layer.meta.x, -layer.meta.y);
    return c;
  }

  /** Selection bounds converted to layer coords (null = whole layer). */
  layerSelRect(layer: Layer): Rect | null {
    const b = this.doc.selection.bounds(this.doc.width, this.doc.height);
    if (!b) return null;
    return { x: b.x - layer.meta.x, y: b.y - layer.meta.y, w: b.w, h: b.h };
  }

  /* ------------------------------------------------------------------ layer operations */

  selectLayer(id: string): void {
    if (this.doc.activeId === id || !this.doc.find(id)) return;
    this.cancelAdjust();
    this.doc.activeId = id;
    this.maskEdit = this.maskEdit && !!this.doc.find(id)?.mask;
    this.events.emit('doc', undefined);
  }

  addLayer(name?: string, canvas?: HTMLCanvasElement, opts: Partial<LayerMeta> = {}, label = 'Новый слой'): Layer | null {
    let created: Layer | null = null;
    const ok = this.structural(label, () => {
      const nm = name ? uniqueName(name, this.doc.layers.map((l) => l.meta.name)) : nextLayerName(this.doc.layers.map((l) => l.meta.name));
      const layer = createLayer(nm, this.doc.width, this.doc.height, opts.kind ?? 'raster', canvas);
      Object.assign(layer.meta, opts, { id: layer.meta.id, name: nm });
      const idx = this.doc.active ? this.doc.indexOf(this.doc.active.meta.id) + 1 : this.doc.layers.length;
      this.doc.layers.splice(idx, 0, layer);
      this.doc.activeId = layer.meta.id;
      created = layer;
    });
    return ok ? created : null;
  }

  deleteLayer(id = this.doc.activeId): void {
    const idx = this.doc.indexOf(id);
    if (idx < 0) return;
    if (this.doc.layers.length <= 1) {
      this.ui.toast('Нельзя удалить единственный слой', 'warn');
      return;
    }
    this.structural('Удалить слой', () => {
      const next = indexAfterDelete(idx, this.doc.layers.length);
      this.doc.layers.splice(idx, 1);
      this.doc.activeId = this.doc.layers[next]?.meta.id ?? '';
    });
  }

  duplicateLayer(id = this.doc.activeId): void {
    const src = this.doc.find(id);
    if (!src) return;
    this.structural('Дублировать слой', () => {
      const copy = new Layer(
        { ...cloneMeta(src.meta), id: newId(), name: copyName(src.meta.name, this.doc.layers.map((l) => l.meta.name)) },
        cloneCanvas(src.canvas),
      );
      copy.mask = src.mask ? cloneCanvas(src.mask) : null;
      this.doc.layers.splice(this.doc.indexOf(id) + 1, 0, copy);
      this.doc.activeId = copy.meta.id;
    });
  }

  moveLayer(from: number, to: number): void {
    if (from === to || from < 0 || from >= this.doc.layers.length) return;
    this.structural('Порядок слоёв', () => {
      this.doc.layers = moveItem(this.doc.layers, from, to);
    });
  }

  setLayerMeta(id: string, patch: Partial<LayerMeta>, label: string, coalesce = false): void {
    const l = this.doc.find(id);
    if (!l) return;
    const changed = (Object.keys(patch) as (keyof LayerMeta)[]).some((k) => l.meta[k] !== patch[k]);
    if (!changed) return;
    this.structural(label, () => Object.assign(l.meta, patch), coalesce ? `${label}:${id}` : undefined);
  }

  /** Sets (or clears) the non-destructive layer styles. */
  setLayerFx(id: string, fx: LayerFx | undefined, coalesce = false): void {
    const l = this.doc.find(id);
    if (!l || l.meta.kind === 'adjustment') return;
    if (JSON.stringify(l.meta.fx) === JSON.stringify(fx)) return;
    this.structural('Стили слоя', () => {
      if (fx) l.meta.fx = cloneFx(fx);
      else delete l.meta.fx;
    }, coalesce ? `fx:${id}` : undefined);
  }

  mergeDown(id = this.doc.activeId): void {
    const idx = this.doc.indexOf(id);
    if (idx <= 0) {
      this.ui.toast('Под слоем нет слоя для объединения', 'warn');
      return;
    }
    const upper = this.doc.layers[idx]!;
    const lower = this.doc.layers[idx - 1]!;
    if (lower.meta.locked) {
      this.ui.toast('Нижний слой заблокирован', 'warn');
      return;
    }
    if (lower.meta.kind === 'adjustment') {
      this.ui.toast('Нельзя объединить с корректирующим слоем', 'warn');
      return;
    }
    this.structural('Объединить с нижним', () => {
      const lowerSrc = bakeMask(lower);
      if (upper.meta.kind === 'adjustment') {
        // bake the adjustment into the lower layer's pixels
        const c = cloneCanvas(lowerSrc);
        if (upper.meta.visible) {
          const shifted = new Layer({ ...cloneMeta(upper.meta), x: upper.meta.x - lower.meta.x, y: upper.meta.y - lower.meta.y }, upper.canvas);
          const m = upper.mask && upper.meta.maskEnabled !== false ? upper.mask : null;
          applyAdjustmentLayer(shifted, ctx2d(c, { willReadFrequently: true }), 0, 0, c.width, c.height, m);
        }
        lower.canvas = c;
      } else {
        // union bounds in doc space
        const x0 = Math.min(upper.meta.x, lower.meta.x), y0 = Math.min(upper.meta.y, lower.meta.y);
        const x1 = Math.max(upper.meta.x + upper.width, lower.meta.x + lower.width);
        const y1 = Math.max(upper.meta.y + upper.height, lower.meta.y + lower.height);
        const c = createCanvas(x1 - x0, y1 - y0);
        const ctx = ctx2d(c);
        // Lower's own opacity/blend are kept on the merged layer; bake upper with its settings.
        ctx.drawImage(lowerSrc, lower.meta.x - x0, lower.meta.y - y0);
        if (upper.meta.visible) {
          ctx.globalAlpha = upper.meta.opacity;
          ctx.globalCompositeOperation = toCompositeOp(upper.meta.blend);
          ctx.drawImage(bakeMask(upper), upper.meta.x - x0, upper.meta.y - y0);
        }
        lower.canvas = c;
        lower.meta.x = x0;
        lower.meta.y = y0;
      }
      lower.mask = null;
      delete lower.meta.maskEnabled;
      delete lower.meta.text;
      delete lower.meta.shape;
      lower.meta.kind = 'raster';
      this.doc.layers.splice(idx, 1);
      this.doc.activeId = lower.meta.id;
      this.maskEdit = false;
    });
  }

  flatten(): void {
    if (this.doc.layers.length < 1) return;
    this.structural('Выполнить сведение', () => {
      const c = flattenToCanvas(this.doc);
      const layer = createLayer('Фон', this.doc.width, this.doc.height, 'raster', c);
      this.doc.layers = [layer];
      this.doc.activeId = layer.meta.id;
    });
  }

  /* ------------------------------------------------------------------ selection */

  setSelection(parts: SelPart[], label = 'Выделение', raster: HTMLCanvasElement | null = null): void {
    if (this.doc.selection.equals({ parts, raster })) return;
    this.structural(label, () => this.doc.selection.setParts(parts, raster));
    this.events.emit('selection', undefined);
  }
  selectAll(): void {
    this.setSelection([{ mode: 'add', shape: { type: 'rect', x: 0, y: 0, w: this.doc.width, h: this.doc.height } }], 'Выделить всё');
  }
  deselect(): void {
    if (this.doc.selection.active) this.setSelection([], 'Снять выделение');
  }
  invertSelection(): void {
    if (!this.doc.selection.active) return this.selectAll();
    const parts = this.doc.selection.inverted(this.doc.width, this.doc.height);
    if (parts) return this.setSelection(parts, 'Инверсия выделения');
    const a = this.selectionAlpha();
    if (a) this.setSelection([], 'Инверсия выделения', alphaCanvas(invertMask(a), this.doc.width, this.doc.height));
  }

  /** Current selection coverage as a document-sized alpha array (null = no selection). */
  selectionAlpha(): Uint8ClampedArray | null {
    const m = this.doc.selection.mask(this.doc.width, this.doc.height);
    return m ? canvasAlpha(m) : null;
  }

  /** Replaces the selection with a pixel mask, combined with the current one by `mode`. */
  setSelectionAlpha(a: Uint8ClampedArray, mode: SelMode, label: string): void {
    const W = this.doc.width, H = this.doc.height;
    let out = a;
    const cur = mode === 'new' ? null : this.selectionAlpha();
    if (cur) out = combineMasks(cur, a, mode === 'new' ? 'add' : mode);
    else if (mode === 'sub' || mode === 'intersect') return;
    this.setSelection([], label, alphaCanvas(out, W, H));
  }

  private refineSelection(label: string, fn: (a: Uint8ClampedArray, w: number, h: number) => Uint8ClampedArray): void {
    const a = this.selectionAlpha();
    if (!a) {
      this.ui.toast('Нет выделения', 'warn');
      return;
    }
    this.setSelection([], label, alphaCanvas(fn(a, this.doc.width, this.doc.height), this.doc.width, this.doc.height));
  }
  featherSelection(radius: number): void {
    this.refineSelection(`Растушёвка ${radius} px`, (a, w, h) => featherMask(a, w, h, radius));
  }
  growSelection(px: number): void {
    this.refineSelection(px >= 0 ? `Расширить на ${px} px` : `Сжать на ${-px} px`, (a, w, h) => growMask(a, w, h, px));
  }

  /** Magic wand: selects similar colours around (x, y) of the active layer or the merged image. */
  magicWand(x: number, y: number, tolerance: number, contiguous: boolean, sampleMerged: boolean, mode: SelMode): void {
    const W = this.doc.width, H = this.doc.height;
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;
    const src = createCanvas(W, H);
    const sc = ctx2d(src, { willReadFrequently: true });
    const l = this.active;
    if (sampleMerged || !l || l.meta.kind === 'adjustment') compositeDoc(this.doc, sc, { committedOnly: true });
    else sc.drawImage(bakeMask(l), l.meta.x, l.meta.y);
    const img = sc.getImageData(0, 0, W, H);
    disposeCanvas(src);
    const m = floodMask(img, ix, iy, tolerance, contiguous);
    const a = new Uint8ClampedArray(W * H);
    for (let i = 0; i < a.length; i++) a[i] = m[i] ? 255 : 0;
    this.setSelectionAlpha(a, mode, 'Волшебная палочка');
  }

  /** Loads a layer mask as the selection (⌘/Ctrl+click on the mask thumbnail). */
  selectionFromMask(id = this.doc.activeId): void {
    const l = this.doc.find(id);
    if (!l?.mask) return;
    const c = createCanvas(this.doc.width, this.doc.height);
    ctx2d(c).drawImage(l.mask, l.meta.x, l.meta.y);
    this.setSelection([], 'Выделение из маски', c);
  }

  /** Delete pixels inside selection (or whole layer). On a mask target this hides (paints black). */
  clearPixels(): void {
    const l = this.editableLayer(true, 'paint');
    if (!l) return;
    const target = this.paintTarget(l);
    const canvas = target === 'mask' ? l.mask! : l.canvas;
    const mask = this.layerMask(l);
    this.pixelEdit(l, this.layerSelRect(l), 'Очистить', (ctx) => {
      if (mask) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(mask, 0, 0);
      } else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }, target);
  }

  fillWith(color: string): void {
    const l = this.editableLayer(true, 'paint');
    if (!l) return;
    const target = this.paintTarget(l);
    if (target === 'mask' && hexLuma(color) < 128) return this.clearPixels();
    const fill = target === 'mask' ? '#ffffff' : color;
    const mask = this.layerMask(l);
    this.pixelEdit(l, this.layerSelRect(l), 'Заливка', (ctx) => {
      if (mask) {
        const t = createCanvas(l.width, l.height);
        const tc = ctx2d(t);
        tc.drawImage(mask, 0, 0);
        tc.globalCompositeOperation = 'source-in';
        tc.fillStyle = fill;
        tc.fillRect(0, 0, l.width, l.height);
        ctx.drawImage(t, 0, 0);
        disposeCanvas(t);
      } else {
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, l.width, l.height);
      }
    }, target);
  }

  /* ------------------------------------------------------------------ guides & snapping */

  private guidesChanged(): void {
    this.revision++;
    this.scheduleAutosave();
    this.renderer?.markView();
    this.events.emit('view', undefined);
  }
  addGuide(axis: 'h' | 'v', pos: number): number {
    this.doc.guides.push({ axis, pos: Math.round(pos) });
    this.guidesChanged();
    return this.doc.guides.length - 1;
  }
  moveGuide(i: number, pos: number): void {
    const g = this.doc.guides[i];
    if (!g) return;
    g.pos = Math.round(pos);
    this.guidesChanged();
  }
  removeGuide(i: number): void {
    if (i < 0 || i >= this.doc.guides.length) return;
    this.doc.guides.splice(i, 1);
    this.guidesChanged();
  }
  clearGuides(): void {
    if (!this.doc.guides.length) return;
    this.doc.guides = [];
    this.guidesChanged();
  }
  private snapSet() {
    return snapTargets(this.renderer?.showGuides === false ? [] : this.doc.guides, this.doc.width, this.doc.height);
  }
  /** Snaps a document point to guides / document edges and centre (6 screen px tolerance). */
  snap(x: number, y: number): { x: number; y: number } {
    if (!this.snapEnabled) return { x, y };
    return snapPoint(x, y, this.snapSet(), 6 / this.view.zoom);
  }
  snapRect(r: Rect): { dx: number; dy: number } {
    if (!this.snapEnabled) return { dx: 0, dy: 0 };
    return snapRectOffset(r, this.snapSet(), 6 / this.view.zoom);
  }

  /* ------------------------------------------------------------------ masks */

  setMaskEdit(on: boolean): void {
    const v = on && !!this.active?.mask;
    if (v === this.maskEdit) return;
    this.maskEdit = v;
    this.events.emit('doc', undefined);
    this.events.emit('toolOptions', undefined);
  }

  /** Adds a mask: 'reveal' (white), 'hide' (black) or from the current selection. */
  addMask(kind: 'reveal' | 'hide' | 'selection' = this.doc.selection.active ? 'selection' : 'reveal'): void {
    const l = this.editableLayer(false);
    if (!l) return;
    if (l.mask) {
      this.ui.toast('У слоя уже есть маска', 'warn');
      return;
    }
    this.structural('Добавить маску слоя', () => {
      let m: HTMLCanvasElement;
      if (kind === 'reveal') m = whiteCanvas(l.width, l.height);
      else {
        m = createCanvas(l.width, l.height);
        const sel = kind === 'selection' ? this.doc.selection.mask(this.doc.width, this.doc.height) : null;
        if (sel) ctx2d(m).drawImage(sel, -l.meta.x, -l.meta.y);
      }
      l.mask = m;
      l.meta.maskEnabled = true;
      this.maskEdit = true;
    });
  }
  deleteMask(): void {
    const l = this.active;
    if (!l?.mask) return;
    this.structural('Удалить маску слоя', () => {
      l.mask = null;
      delete l.meta.maskEnabled;
      this.maskEdit = false;
    });
  }
  /** Bakes the mask into the pixels and removes it. */
  applyMask(): void {
    const l = this.active;
    if (!l?.mask) return;
    if (l.meta.kind === 'adjustment') {
      this.ui.toast('Маску корректирующего слоя нельзя применить к пикселям', 'warn');
      return;
    }
    this.structural('Применить маску слоя', () => {
      if (l.meta.maskEnabled !== false) l.canvas = bakeMask(l);
      l.mask = null;
      delete l.meta.maskEnabled;
      if (l.meta.kind === 'text' || l.meta.kind === 'shape') {
        delete l.meta.text;
        delete l.meta.shape;
        l.meta.kind = 'raster';
      }
      this.maskEdit = false;
    });
  }
  invertLayerMask(): void {
    const l = this.active;
    if (!l?.mask) return;
    this.structural('Инвертировать маску', () => {
      const m = l.mask!;
      l.mask = alphaCanvas(invertMask(canvasAlpha(m)), m.width, m.height);
    });
  }
  toggleMask(id = this.doc.activeId): void {
    const l = this.doc.find(id);
    if (!l?.mask) return;
    const on = l.meta.maskEnabled === false;
    this.setLayerMeta(l.meta.id, { maskEnabled: on }, on ? 'Включить маску' : 'Выключить маску');
  }

  /* ------------------------------------------------------------------ adjustment / text / shape layers */

  addAdjustmentLayer(filterId: string): Layer | null {
    const def = FILTERS[filterId];
    if (!def?.layerable) return null;
    const params: Params = def.custom === 'curves' ? encodeCurves(identityCurves()) : defaults(def);
    let created: Layer | null = null;
    this.structural(`Корр. слой: ${def.label}`, () => {
      const layer = createLayer(uniqueName(def.label, this.doc.layers.map((l) => l.meta.name)), this.doc.width, this.doc.height, 'adjustment');
      layer.meta.adjust = { filterId, params };
      layer.mask = whiteCanvas(this.doc.width, this.doc.height);
      layer.meta.maskEnabled = true;
      const idx = this.doc.active ? this.doc.indexOf(this.doc.active.meta.id) + 1 : this.doc.layers.length;
      this.doc.layers.splice(idx, 0, layer);
      this.doc.activeId = layer.meta.id;
      this.maskEdit = false;
      created = layer;
    });
    return created;
  }

  /** Live (not yet recorded) parameter change of an adjustment layer; commitAdjustmentLayer records it. */
  previewAdjustmentLayer(id: string, params: Params): void {
    const l = this.doc.find(id);
    if (!l?.meta.adjust) return;
    l.meta.adjust = { filterId: l.meta.adjust.filterId, params: { ...l.meta.adjust.params, ...params } };
    this.redraw();
  }
  /** Records the adjustment layer's params going from `before` to their current value. */
  commitAdjustmentLayer(id: string, before: AdjustData): void {
    const l = this.doc.find(id);
    if (!l?.meta.adjust) return;
    const after = l.meta.adjust;
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    l.meta.adjust = { filterId: before.filterId, params: { ...before.params } };
    this.structural('Параметры коррекции', () => (l.meta.adjust = { filterId: after.filterId, params: { ...after.params } }), `adj:${id}`);
  }

  /** Adds a re-editable text layer whose canvas top-left is at (x, y). */
  addTextLayer(t: TextData, x: number, y: number): Layer | null {
    const name = t.text.split('\n')[0]!.slice(0, 24) || 'Текст';
    return this.addLayer(name, renderText(t), { kind: 'text', x: Math.round(x), y: Math.round(y), text: { ...t } }, 'Текст');
  }

  /** Re-renders a text layer from new data (keeps its position and mask). */
  updateText(id: string, t: TextData, label = 'Изменить текст', coalesce = false): void {
    const l = this.doc.find(id);
    if (!l || l.meta.kind !== 'text') return;
    if (JSON.stringify(l.meta.text) === JSON.stringify(t)) return;
    const oldAuto = (l.meta.text?.text.split('\n')[0] ?? '').slice(0, 24);
    this.structural(label, () => {
      const c = renderText(t);
      this.refitMask(l, c.width, c.height, 0, 0);
      l.canvas = c;
      l.meta.text = { ...t };
      const nm = t.text.split('\n')[0]!.slice(0, 24);
      if (nm && l.meta.name === oldAuto) l.meta.name = nm;
    }, coalesce ? `text:${id}` : undefined);
  }

  /** Adds a vector-like shape layer; (x, y) = top-left of the shape box in the document. */
  addShapeLayer(sd: ShapeData, x: number, y: number, name: string): Layer | null {
    const pad = shapePad(sd);
    return this.addLayer(name, renderShape(sd), { kind: 'shape', x: Math.round(x - pad), y: Math.round(y - pad), shape: { ...sd } }, name);
  }

  updateShape(id: string, patch: Partial<ShapeData>, label = 'Изменить фигуру', coalesce = false): void {
    const l = this.doc.find(id);
    if (!l || l.meta.kind !== 'shape' || !l.meta.shape) return;
    const prev = l.meta.shape;
    const next: ShapeData = { ...prev, ...patch };
    if (next.type === 'line') {
      // keep endpoints proportional when the box is resized
      const sx = next.w / Math.max(1e-6, prev.w), sy = next.h / Math.max(1e-6, prev.h);
      if (patch.w !== undefined && patch.x1 === undefined) {
        next.x1 = (prev.x1 ?? 0) * sx;
        next.x2 = (prev.x2 ?? prev.w) * sx;
      }
      if (patch.h !== undefined && patch.y1 === undefined) {
        next.y1 = (prev.y1 ?? 0) * sy;
        next.y2 = (prev.y2 ?? prev.h) * sy;
      }
    }
    next.w = Math.max(1, next.w);
    next.h = Math.max(next.type === 'line' ? 0 : 1, next.h);
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    this.structural(label, () => {
      const oldPad = shapePad(prev), pad = shapePad(next);
      const c = renderShape(next);
      this.refitMask(l, c.width, c.height, pad - oldPad, pad - oldPad);
      l.canvas = c;
      l.meta.x += oldPad - pad;
      l.meta.y += oldPad - pad;
      l.meta.shape = next;
    }, coalesce ? `shape:${id}` : undefined);
  }

  /** Converts a text/shape layer to plain pixels. Returns false if not possible. */
  rasterizeLayer(id = this.doc.activeId): boolean {
    const l = this.doc.find(id);
    if (!l || (l.meta.kind !== 'text' && l.meta.kind !== 'shape')) return false;
    return this.structural('Растрировать слой', () => {
      delete l.meta.text;
      delete l.meta.shape;
      l.meta.kind = 'raster';
    });
  }

  /** Keeps a mask aligned when the layer canvas is regenerated (dx, dy = shift of old content in the new canvas). */
  private refitMask(l: Layer, w: number, h: number, dx: number, dy: number): void {
    if (!l.mask) return;
    const m = whiteCanvas(w, h);
    const mc = ctx2d(m);
    mc.clearRect(dx, dy, l.mask.width, l.mask.height);
    mc.drawImage(l.mask, dx, dy);
    l.mask = m;
  }

  /* ------------------------------------------------------------------ clipboard */

  /** Copies selected pixels of the active layer (or the merged image when `merged`). */
  async copy(merged = false): Promise<void> {
    const src = merged ? flattenToCanvas(this.doc) : this.active?.canvas;
    const l = this.active;
    if (!src || !l) return;
    const ox = merged ? 0 : l.meta.x, oy = merged ? 0 : l.meta.y;
    const b = this.doc.selection.bounds(this.doc.width, this.doc.height) ?? { x: ox, y: oy, w: src.width, h: src.height };
    const out = createCanvas(b.w, b.h);
    const oc = ctx2d(out);
    oc.drawImage(src, ox - b.x, oy - b.y);
    const mask = this.doc.selection.mask(this.doc.width, this.doc.height);
    if (mask) {
      oc.globalCompositeOperation = 'destination-in';
      oc.drawImage(mask, -b.x, -b.y);
    }
    this.clipboard = { canvas: out, x: b.x, y: b.y };
    try {
      if (navigator.clipboard && 'write' in navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
        if (blob) await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      }
    } catch {
      /* system clipboard is optional; internal buffer still works */
    }
    this.ui.toast('Скопировано', 'success');
  }

  async cut(): Promise<void> {
    if (!this.editableLayer()) return;
    await this.copy(false);
    this.clearPixels();
  }

  /** Paste internal clipboard as a new layer at the original position. */
  pasteInternal(): boolean {
    if (!this.clipboard) return false;
    const { canvas, x, y } = this.clipboard;
    this.addLayer('Вставка', cloneCanvas(canvas), { x, y }, 'Вставить');
    return true;
  }

  /* ------------------------------------------------------------------ import */

  /** Decodes and size-guards an image, returning a canvas (or null if cancelled). */
  async imageToCanvas(blob: Blob): Promise<HTMLCanvasElement | null> {
    const d = await decodeImage(blob);
    try {
      let { width: w, height: h } = d;
      const verdict = checkSize(w, h);
      if (verdict !== 'ok') {
        const choice = await this.ui.askLargeImage(w, h, verdict === 'too-large');
        if (choice === 'cancel') return null;
        if (choice === 'downscale' || verdict === 'too-large') ({ w, h } = fitWithin(w, h, verdict === 'too-large' ? Math.min(MAX_SIDE, 8192) : 8192));
      }
      return toCanvas(d, w, h);
    } finally {
      d.close();
    }
  }

  async openFile(file: File, asLayer: boolean): Promise<void> {
    try {
      if (/\.lumen$|\.json$/i.test(file.name) || file.type === 'application/json') {
        this.setBusy('Открытие проекта…');
        const doc = await parseProject(await file.text());
        this.loadDoc(doc);
        this.ui.toast(`Проект «${doc.name}» открыт`, 'success');
        return;
      }
      if (file.type && !file.type.startsWith('image/')) throw new Error(`Неподдерживаемый файл: ${file.name}`);
      this.setBusy('Загрузка изображения…');
      const canvas = await this.imageToCanvas(file);
      if (!canvas) return;
      const name = file.name.replace(/\.[^.]+$/, '') || 'Изображение';
      if (asLayer) this.addImageLayer(canvas, name);
      else {
        const doc = new Doc(canvas.width, canvas.height, name);
        const layer = createLayer(name, canvas.width, canvas.height, 'image', canvas);
        doc.layers.push(layer);
        doc.activeId = layer.meta.id;
        this.loadDoc(doc);
      }
    } catch (err) {
      this.reportError(err);
    } finally {
      this.setBusy(null);
    }
  }

  /** Adds an image as a centred layer (scaled down to fit the document if larger). */
  addImageLayer(canvas: HTMLCanvasElement, name: string): void {
    let c = canvas;
    const k = Math.min(1, this.doc.width / c.width, this.doc.height / c.height);
    if (k < 1) {
      c = resampleCanvas(canvas, Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
      disposeCanvas(canvas);
    }
    this.addLayer(name, c, { kind: 'image', x: Math.round((this.doc.width - c.width) / 2), y: Math.round((this.doc.height - c.height) / 2) }, 'Поместить изображение');
  }

  /* ------------------------------------------------------------------ image transforms */

  crop(r: Rect): void {
    const rc = rectClip(r, this.doc.width, this.doc.height);
    if (!rc || rc.w < 1 || rc.h < 1) return;
    this.structural('Кадрирование', () => {
      for (const l of this.doc.layers) {
        l.meta.x -= rc.x;
        l.meta.y -= rc.y;
      }
      this.doc.width = rc.w;
      this.doc.height = rc.h;
      this.doc.selection.clear();
      // Trim layer canvases that now lie partly outside to save memory.
      for (const l of this.doc.layers) {
        const vis = rectClip({ x: -l.meta.x, y: -l.meta.y, w: rc.w, h: rc.h }, l.width, l.height);
        if (!vis) {
          l.canvas = createCanvas(1, 1);
          mapMask(l, () => createCanvas(1, 1));
          l.meta.x = 0;
          l.meta.y = 0;
          continue;
        }
        if (vis.w === l.width && vis.h === l.height) continue;
        const trim = (src: HTMLCanvasElement) => {
          const c = createCanvas(vis.w, vis.h);
          ctx2d(c).drawImage(src, -vis.x, -vis.y);
          return c;
        };
        l.canvas = trim(l.canvas);
        mapMask(l, trim);
        l.meta.x += vis.x;
        l.meta.y += vis.y;
      }
    });
    this.events.emit('selection', undefined);
    this.fit();
  }

  resizeImage(w: number, h: number): void {
    w = Math.max(1, Math.min(MAX_SIDE, Math.round(w)));
    h = Math.max(1, Math.min(MAX_SIDE, Math.round(h)));
    const kx = w / this.doc.width, ky = h / this.doc.height;
    this.structural('Размер изображения', () => {
      for (const l of this.doc.layers) {
        const nw = Math.max(1, Math.round(l.width * kx)), nh = Math.max(1, Math.round(l.height * ky));
        l.canvas = resampleCanvas(l.canvas, nw, nh);
        mapMask(l, (m) => resampleCanvas(m, nw, nh));
        if (l.meta.shape) l.meta.kind = 'raster';
        if (l.meta.text) l.meta.kind = 'raster';
        delete l.meta.shape;
        delete l.meta.text;
        l.meta.x = Math.round(l.meta.x * kx);
        l.meta.y = Math.round(l.meta.y * ky);
      }
      this.doc.width = w;
      this.doc.height = h;
      this.doc.selection.clear();
    });
    this.events.emit('selection', undefined);
    this.fit();
  }

  canvasSize(w: number, h: number): void {
    w = Math.max(1, Math.min(MAX_SIDE, Math.round(w)));
    h = Math.max(1, Math.min(MAX_SIDE, Math.round(h)));
    const dx = Math.round((w - this.doc.width) / 2), dy = Math.round((h - this.doc.height) / 2);
    this.structural('Размер холста', () => {
      for (const l of this.doc.layers) {
        l.meta.x += dx;
        l.meta.y += dy;
      }
      this.doc.width = w;
      this.doc.height = h;
      this.doc.selection.clear();
    });
    this.events.emit('selection', undefined);
    this.fit();
  }

  /** Rotate whole image by ±90° or 180°. */
  rotate(deg: 90 | -90 | 180): void {
    const W = this.doc.width, H = this.doc.height;
    this.structural('Поворот изображения', () => {
      for (const l of this.doc.layers) {
        const swap = deg !== 180;
        const rot = (src: HTMLCanvasElement) => {
          const c = createCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
          const ctx = ctx2d(c);
          ctx.translate(c.width / 2, c.height / 2);
          ctx.rotate((deg * Math.PI) / 180);
          ctx.drawImage(src, -src.width / 2, -src.height / 2);
          return c;
        };
        const c = rot(l.canvas);
        mapMask(l, rot);
        if (l.meta.kind === 'text' || l.meta.kind === 'shape') {
          l.meta.kind = 'raster';
          delete l.meta.text;
          delete l.meta.shape;
        }
        const { x, y } = l.meta;
        if (deg === 90) [l.meta.x, l.meta.y] = [H - y - l.height, x];
        else if (deg === -90) [l.meta.x, l.meta.y] = [y, W - x - l.width];
        else [l.meta.x, l.meta.y] = [W - x - l.width, H - y - l.height];
        l.canvas = c;
      }
      if (deg !== 180) [this.doc.width, this.doc.height] = [H, W];
      this.doc.selection.clear();
    });
    this.events.emit('selection', undefined);
    this.fit();
  }

  flip(axis: 'h' | 'v', layerOnly = false): void {
    const W = this.doc.width, H = this.doc.height;
    const targets = layerOnly ? [this.editableLayer()].filter((l): l is Layer => !!l) : this.doc.layers;
    if (!targets.length) return;
    this.structural(layerOnly ? 'Отразить слой' : 'Отразить изображение', () => {
      for (const l of targets) {
        const fl = (src: HTMLCanvasElement) => {
          const c = createCanvas(src.width, src.height);
          const ctx = ctx2d(c);
          if (axis === 'h') ctx.setTransform(-1, 0, 0, 1, src.width, 0);
          else ctx.setTransform(1, 0, 0, -1, 0, src.height);
          ctx.drawImage(src, 0, 0);
          return c;
        };
        l.canvas = fl(l.canvas);
        mapMask(l, fl);
        if (l.meta.kind === 'text' || l.meta.kind === 'shape') {
          l.meta.kind = 'raster';
          delete l.meta.text;
          delete l.meta.shape;
        }
        if (!layerOnly) {
          if (axis === 'h') l.meta.x = W - l.meta.x - l.width;
          else l.meta.y = H - l.meta.y - l.height;
        }
      }
    });
  }

  /* ------------------------------------------------------------------ adjustments / filters */

  /** Starts a live-preview adjustment session (or applies instantly for parameterless filters). */
  startAdjust(filterId: string): void {
    const def = FILTERS[filterId];
    if (!def) return;
    if (this.busy) return this.ui.toast('Подождите завершения операции', 'warn');
    const layer = this.editableLayer(true, 'pixels');
    if (!layer) return;
    this.cancelAdjust();
    if (!hasControls(def)) {
      void this.applyFilter(def, {}, layer);
      return;
    }
    const scale = Math.min(1, Math.sqrt(2_500_000 / (layer.width * layer.height)));
    const sw = Math.max(1, Math.round(layer.width * scale)), sh = Math.max(1, Math.round(layer.height * scale));
    const src = scale < 1 ? resampleCanvas(layer.canvas, sw, sh) : cloneCanvas(layer.canvas);
    const srcData = ctx2d(src).getImageData(0, 0, src.width, src.height);
    this.adjust = { filter: def, params: defaults(def), layer, previewOn: true, scale: src.width / layer.width, src, srcData, token: 0, timer: 0, pending: false };
    this.events.emit('adjust', undefined);
    this.schedulePreview();
  }

  updateAdjust(patch: Params): void {
    if (!this.adjust) return;
    Object.assign(this.adjust.params, patch);
    this.schedulePreview();
  }

  setPreview(on: boolean): void {
    const a = this.adjust;
    if (!a) return;
    a.previewOn = on;
    if (!on) {
      disposeCanvas(a.layer.preview);
      a.layer.preview = null;
      this.redraw();
    } else this.schedulePreview();
    this.events.emit('adjust', undefined);
  }

  private schedulePreview(): void {
    const a = this.adjust;
    if (!a || !a.previewOn) return;
    clearTimeout(a.timer);
    a.timer = window.setTimeout(() => this.runPreview(), 24);
  }

  private runPreview(): void {
    const a = this.adjust;
    if (!a || !a.previewOn) return;
    if (a.pending) {
      // one job in flight: re-run when it finishes (drops intermediate slider states)
      a.timer = window.setTimeout(() => this.runPreview(), 30);
      return;
    }
    const token = ++a.token;
    a.pending = true;
    const input = new ImageData(new Uint8ClampedArray(a.srcData.data), a.srcData.width, a.srcData.height);
    this.runner
      .run(a.filter.id, scaleParams(a.filter, a.params, a.scale), input)
      .then((out) => {
        if (this.adjust !== a || token !== a.token || !a.previewOn) return;
        let res = createCanvas(out.width, out.height);
        ctx2d(res).putImageData(out, 0, 0);
        const mask = this.layerMask(a.layer);
        if (mask) res = mergeMasked(a.src, res, mask);
        disposeCanvas(a.layer.preview);
        a.layer.preview = res;
        this.redraw();
      })
      .catch((e) => this.reportError(e))
      .finally(() => {
        a.pending = false;
      });
  }

  cancelAdjust(): void {
    const a = this.adjust;
    if (!a) return;
    clearTimeout(a.timer);
    this.adjust = null;
    disposeCanvas(a.layer.preview);
    a.layer.preview = null;
    disposeCanvas(a.src);
    this.redraw();
    this.events.emit('adjust', undefined);
  }

  async applyAdjust(): Promise<void> {
    const a = this.adjust;
    if (!a) return;
    clearTimeout(a.timer);
    this.adjust = null;
    this.events.emit('adjust', undefined);
    try {
      await this.applyFilter(a.filter, a.params, a.layer);
    } finally {
      disposeCanvas(a.layer.preview);
      a.layer.preview = null;
      disposeCanvas(a.src);
      this.redraw();
    }
  }

  /** Full-resolution filter in the worker, then recorded as a pixel edit (selection-aware). */
  async applyFilter(def: FilterDef, params: Params, layer: Layer): Promise<void> {
    const selRect = this.layerSelRect(layer);
    const region = rectClip(selRect ?? { x: 0, y: 0, w: layer.width, h: layer.height }, layer.width, layer.height);
    if (!region) return this.ui.toast('Выделение вне слоя', 'warn');
    // Spatial filters need context around the selection edge.
    const padRadius = def.params.some((p) => p.spatial) ? Math.ceil((params.radius ?? 0) * 3) + 2 : 0;
    const work = rectClip({ x: region.x - padRadius, y: region.y - padRadius, w: region.w + padRadius * 2, h: region.h + padRadius * 2 }, layer.width, layer.height)!;
    this.setBusy(`${def.label}…`);
    try {
      const canvas = layer.canvas;
      const input = readPixels(canvas, work.x, work.y, work.w, work.h);
      const out = await this.runner.run(def.id, params, input);
      if (layer.canvas !== canvas || !this.doc.layers.includes(layer)) throw new Error('Слой изменился во время обработки — фильтр отменён');
      let res = createCanvas(work.w, work.h);
      ctx2d(res).putImageData(out, 0, 0);
      const mask = this.layerMask(layer);
      if (mask) {
        const crop = createCanvas(work.w, work.h);
        ctx2d(crop).drawImage(mask, -work.x, -work.y);
        const orig = createCanvas(work.w, work.h);
        ctx2d(orig).drawImage(canvas, -work.x, -work.y);
        res = mergeMasked(orig, res, crop);
        disposeCanvas(crop);
        disposeCanvas(orig);
      }
      this.pixelEdit(layer, work, def.label, (ctx) => {
        ctx.clearRect(work.x, work.y, work.w, work.h);
        ctx.drawImage(res, work.x, work.y);
      });
      disposeCanvas(res);
    } catch (e) {
      this.reportError(e);
    } finally {
      this.setBusy(null);
    }
  }

  /* ------------------------------------------------------------------ sampling */

  /** Samples the composited (visible) image; returns hex or null outside the canvas. */
  sampleColor(x: number, y: number, size = 1): string | null {
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= this.doc.width || iy >= this.doc.height) return null;
    const r = Math.floor(size / 2);
    const rect = rectClip({ x: ix - r, y: iy - r, w: size, h: size }, this.doc.width, this.doc.height)!;
    const c = createCanvas(rect.w, rect.h);
    const ctx = ctx2d(c, { willReadFrequently: true });
    ctx.translate(-rect.x, -rect.y);
    compositeDoc(this.doc, ctx, { clip: rect, committedOnly: true });
    const d = ctx.getImageData(0, 0, rect.w, rect.h).data;
    let R = 0, G = 0, B = 0, A = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3]!;
      R += d[i]! * a;
      G += d[i + 1]! * a;
      B += d[i + 2]! * a;
      A += a;
    }
    disposeCanvas(c);
    if (A === 0) return null;
    const hx = (v: number) => Math.round(v / A).toString(16).padStart(2, '0');
    return `#${hx(R)}${hx(G)}${hx(B)}`;
  }

  /* ------------------------------------------------------------------ autosave */

  scheduleAutosave(): void {
    if (!this.autosaveEnabled) return;
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => void this.autosaveNow(), AUTOSAVE_DELAY);
  }

  async autosaveNow(): Promise<void> {
    if (this.revision === this.savedRevision) return;
    if (this.autosaving || this.tool?.active || this.busy) {
      this.scheduleAutosave();
      return;
    }
    this.autosaving = true;
    const rev = this.revision;
    try {
      const rec = await recordFromDoc(this.doc);
      await saveAutosave(rec);
      this.savedRevision = rev;
      this.events.emit('saved', { time: rec.savedAt, ok: true });
    } catch (err) {
      console.warn('[Lumen] autosave failed', err);
      this.events.emit('saved', { time: Date.now(), ok: false });
    } finally {
      this.autosaving = false;
    }
  }

  async discardAutosave(): Promise<void> {
    try {
      await clearAutosave();
    } catch {
      /* ignore */
    }
  }
}

/** Layer pixels with its (enabled) mask applied; the layer canvas itself when there is none. */
export function bakeMask(l: Layer): HTMLCanvasElement {
  if (!l.mask || l.meta.maskEnabled === false) return l.canvas;
  const c = cloneCanvas(l.canvas);
  const x = ctx2d(c);
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(l.mask, 0, 0);
  return c;
}

/** result inside mask, original outside (all canvases same size). */
export function mergeMasked(orig: HTMLCanvasElement, result: HTMLCanvasElement, mask: HTMLCanvasElement): HTMLCanvasElement {
  const w = result.width, h = result.height;
  const inside = createCanvas(w, h);
  const ic = ctx2d(inside);
  ic.drawImage(result, 0, 0);
  ic.globalCompositeOperation = 'destination-in';
  ic.drawImage(mask, 0, 0, w, h);
  const out = createCanvas(w, h);
  const oc = ctx2d(out);
  oc.drawImage(orig, 0, 0, w, h);
  oc.globalCompositeOperation = 'destination-out';
  oc.drawImage(mask, 0, 0, w, h);
  oc.globalCompositeOperation = 'source-over';
  oc.drawImage(inside, 0, 0);
  disposeCanvas(inside);
  disposeCanvas(result);
  return out;
}
