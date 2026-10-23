import { isBlendMode } from './blend';
import { createCanvas, ctx2d, MAX_SIDE } from './canvas';
import { Doc, Layer, newId } from './document';
import { cloneMeta } from './types';
import { canvasToBlob, decodeImage } from './imageio';
import type { Guide } from './document';
import type { AdjustData, LayerKind, LayerMeta, ShapeData, TextData } from './types';
import { FILTERS } from '../filters/filters';

/**
 * On-disk .lumen format: JSON with PNG data URLs per layer (and per mask).
 * v2 adds masks, guides and text/shape/adjustment data; v1 files still open.
 */
export interface ProjectFile {
  format: 'lumen';
  version: 1 | 2;
  name: string;
  width: number;
  height: number;
  activeId: string;
  layers: { meta: LayerMeta; data: string; mask?: string }[];
  guides?: Guide[];
}

/** Same structure with Blobs (cheaper; used for IndexedDB autosave). */
export interface ProjectRecord {
  name: string;
  width: number;
  height: number;
  activeId: string;
  savedAt: number;
  layers: { meta: LayerMeta; blob: Blob; mask?: Blob }[];
  guides?: Guide[];
}

export function serializeProject(doc: Doc): ProjectFile {
  return {
    format: 'lumen',
    version: 2,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    activeId: doc.activeId,
    layers: doc.layers.map((l) => ({ meta: cloneMeta(l.meta), data: l.canvas.toDataURL('image/png'), ...(l.mask ? { mask: l.mask.toDataURL('image/png') } : {}) })),
    guides: doc.guides.map((g) => ({ ...g })),
  };
}

export async function recordFromDoc(doc: Doc): Promise<ProjectRecord> {
  const layers: ProjectRecord['layers'] = [];
  for (const l of doc.layers) {
    const rec: ProjectRecord['layers'][number] = { meta: cloneMeta(l.meta), blob: await canvasToBlob(l.canvas, 'image/png') };
    if (l.mask) rec.mask = await canvasToBlob(l.mask, 'image/png');
    layers.push(rec);
  }
  return { name: doc.name, width: doc.width, height: doc.height, activeId: doc.activeId, savedAt: Date.now(), layers, guides: doc.guides.map((g) => ({ ...g })) };
}

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const color = (v: unknown): string | null => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);

export function sanitizeText(t: unknown): TextData | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const o = t as Partial<TextData>;
  if (typeof o.text !== 'string') return undefined;
  return {
    text: o.text.slice(0, 10000),
    font: typeof o.font === 'string' && o.font.length < 200 ? o.font : 'Inter, system-ui, sans-serif',
    size: num(o.size, 48, 1, 2000),
    color: color(o.color) ?? '#000000',
    bold: o.bold === true,
    italic: o.italic === true,
    align: o.align === 'center' || o.align === 'right' ? o.align : 'left',
  };
}

export function sanitizeShape(s: unknown): ShapeData | undefined {
  if (!s || typeof s !== 'object') return undefined;
  const o = s as Partial<ShapeData>;
  if (o.type !== 'rect' && o.type !== 'ellipse' && o.type !== 'line' && o.type !== 'polygon' && o.type !== 'star') return undefined;
  const out: ShapeData = {
    type: o.type,
    w: num(o.w, 1, 0, MAX_SIDE),
    h: num(o.h, 1, 0, MAX_SIDE),
    fill: color(o.fill),
    stroke: color(o.stroke),
    strokeWidth: num(o.strokeWidth, 0, 0, 1000),
    radius: num(o.radius, 0, 0, MAX_SIDE),
  };
  if (Array.isArray(o.radii) && o.radii.length === 4) out.radii = o.radii.map((r) => num(r, 0, 0, MAX_SIDE)) as [number, number, number, number];
  if (o.cornerStyle === 'round' || o.cornerStyle === 'smooth' || o.cornerStyle === 'cut' || o.cornerStyle === 'inverse') out.cornerStyle = o.cornerStyle;
  if (o.type === 'polygon' || o.type === 'star') out.sides = Math.round(num(o.sides, o.type === 'star' ? 5 : 6, 3, 60));
  if (o.type === 'star') out.innerRatio = num(o.innerRatio, 0.5, 0.05, 0.98);
  if (o.type === 'line') {
    out.x1 = num(o.x1, 0);
    out.y1 = num(o.y1, 0);
    out.x2 = num(o.x2, out.w);
    out.y2 = num(o.y2, out.h);
  }
  return out;
}

export function sanitizeAdjust(a: unknown): AdjustData | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const o = a as Partial<AdjustData>;
  if (typeof o.filterId !== 'string' || !FILTERS[o.filterId]?.layerable) return undefined;
  const params: Record<string, number> = {};
  if (o.params && typeof o.params === 'object') for (const [k, v] of Object.entries(o.params)) if (typeof v === 'number' && isFinite(v) && k.length < 16) params[k] = v;
  return { filterId: o.filterId, params };
}

export function sanitizeGuides(g: unknown, w: number, h: number): Guide[] {
  if (!Array.isArray(g)) return [];
  return g
    .filter((x): x is Guide => !!x && (x.axis === 'h' || x.axis === 'v') && typeof x.pos === 'number' && isFinite(x.pos))
    .slice(0, 500)
    .map((x) => ({ axis: x.axis, pos: Math.round(Math.max(-w, Math.min(2 * Math.max(w, h), x.pos))) }));
}

export function sanitizeMeta(m: Partial<LayerMeta> | undefined, i: number): LayerMeta {
  const kinds: LayerKind[] = ['raster', 'image', 'text', 'shape', 'adjustment'];
  const out = sanitizeBase(m, i, kinds);
  const text = out.kind === 'text' ? sanitizeText(m?.text) : undefined;
  const shape = out.kind === 'shape' ? sanitizeShape(m?.shape) : undefined;
  const adjust = out.kind === 'adjustment' ? sanitizeAdjust(m?.adjust) : undefined;
  if (text) out.text = text;
  if (shape) out.shape = shape;
  if (adjust) out.adjust = adjust;
  // data missing → degrade gracefully
  if ((out.kind === 'text' && !text) || (out.kind === 'shape' && !shape)) out.kind = 'raster';
  if (out.kind === 'adjustment' && !adjust) out.visible = false;
  if (typeof m?.maskEnabled === 'boolean') out.maskEnabled = m.maskEnabled;
  return out;
}

function sanitizeBase(m: Partial<LayerMeta> | undefined, i: number, kinds: LayerKind[]): LayerMeta {
  return {
    id: typeof m?.id === 'string' && m.id ? m.id : newId(),
    name: typeof m?.name === 'string' ? m.name.slice(0, 200) : `Слой ${i + 1}`,
    kind: kinds.includes(m?.kind as LayerKind) ? (m!.kind as LayerKind) : 'raster',
    visible: m?.visible !== false,
    locked: m?.locked === true,
    opacity: typeof m?.opacity === 'number' && isFinite(m.opacity) ? Math.max(0, Math.min(1, m.opacity)) : 1,
    blend: isBlendMode(m?.blend) ? m!.blend! : 'normal',
    x: typeof m?.x === 'number' && isFinite(m.x) ? Math.round(m.x) : 0,
    y: typeof m?.y === 'number' && isFinite(m.y) ? Math.round(m.y) : 0,
  };
}

async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const d = await decodeImage(blob);
  try {
    const c = createCanvas(d.width, d.height);
    ctx2d(c).drawImage(d.source, 0, 0);
    return c;
  } finally {
    d.close();
  }
}

/** Masks must match the layer canvas size; mismatches are resampled. */
function attachMask(layer: Layer, m: HTMLCanvasElement): void {
  if (m.width !== layer.width || m.height !== layer.height) {
    const c = createCanvas(layer.width, layer.height);
    ctx2d(c).drawImage(m, 0, 0, layer.width, layer.height);
    m = c;
  }
  layer.mask = m;
  if (layer.meta.maskEnabled === undefined) layer.meta.maskEnabled = true;
}

function checkDims(w: unknown, h: unknown): [number, number] {
  if (typeof w !== 'number' || typeof h !== 'number' || !(w >= 1 && h >= 1 && w <= MAX_SIDE && h <= MAX_SIDE)) {
    throw new Error('Повреждённый проект: неверный размер документа');
  }
  return [Math.round(w), Math.round(h)];
}

export async function docFromRecord(rec: ProjectRecord): Promise<Doc> {
  const [w, h] = checkDims(rec.width, rec.height);
  const doc = new Doc(w, h, rec.name || 'Восстановленный');
  for (let i = 0; i < rec.layers.length; i++) {
    const l = rec.layers[i]!;
    const layer = new Layer(sanitizeMeta(l.meta, i), await blobToCanvas(l.blob));
    if (l.mask) attachMask(layer, await blobToCanvas(l.mask));
    else delete layer.meta.maskEnabled;
    doc.layers.push(layer);
  }
  doc.guides = sanitizeGuides(rec.guides, w, h);
  doc.activeId = doc.find(rec.activeId) ? rec.activeId : doc.layers[doc.layers.length - 1]?.meta.id ?? '';
  return doc;
}

export async function parseProject(text: string): Promise<Doc> {
  let obj: Partial<ProjectFile>;
  try {
    obj = JSON.parse(text) as Partial<ProjectFile>;
  } catch {
    throw new Error('Файл проекта повреждён (неверный JSON)');
  }
  if (obj.format !== 'lumen' || !Array.isArray(obj.layers)) throw new Error('Это не проект Lumen');
  if (obj.version !== 1 && obj.version !== 2) throw new Error(`Неподдерживаемая версия проекта: ${String(obj.version)}`);
  const [w, h] = checkDims(obj.width, obj.height);
  const doc = new Doc(w, h, typeof obj.name === 'string' ? obj.name : 'Проект');
  for (let i = 0; i < obj.layers.length; i++) {
    const l = obj.layers[i]!;
    if (typeof l?.data !== 'string' || !l.data.startsWith('data:image/')) throw new Error(`Слой ${i + 1}: нет данных изображения`);
    const blob = await (await fetch(l.data)).blob();
    const layer = new Layer(sanitizeMeta(l.meta, i), await blobToCanvas(blob));
    if (typeof l.mask === 'string' && l.mask.startsWith('data:image/')) attachMask(layer, await blobToCanvas(await (await fetch(l.mask)).blob()));
    else delete layer.meta.maskEnabled;
    doc.layers.push(layer);
  }
  doc.guides = sanitizeGuides(obj.guides, w, h);
  doc.activeId = typeof obj.activeId === 'string' && doc.find(obj.activeId) ? obj.activeId : doc.layers[doc.layers.length - 1]?.meta.id ?? '';
  return doc;
}
