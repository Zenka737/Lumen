/** Canvas helpers. All canvases are created through here so sizing/limits stay consistent. */

/** Hard ceiling for any single side (most browsers cap canvases at 16384 or 32767). */
export const MAX_SIDE = 16384;
/** Hard ceiling for area (Chrome/Safari limit is ~268M px; stay well below). */
export const MAX_AREA = 120_000_000;

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.min(MAX_SIDE, Math.round(w)));
  c.height = Math.max(1, Math.min(MAX_SIDE, Math.round(h)));
  return c;
}

export function ctx2d(c: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', opts);
  if (!ctx) throw new Error('Не удалось получить контекст Canvas 2D (недостаточно памяти?)');
  return ctx;
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

/** Releases the backing store immediately instead of waiting for GC. */
export function disposeCanvas(c: HTMLCanvasElement | null | undefined): void {
  if (!c) return;
  c.width = 1;
  c.height = 1;
}

/** Reusable scratch canvases (resized on demand) to avoid allocating per frame. */
const scratch = new Map<string, HTMLCanvasElement>();
export function scratchCanvas(key: string, w: number, h: number): HTMLCanvasElement {
  let c = scratch.get(key);
  if (!c) {
    c = createCanvas(w, h);
    scratch.set(key, c);
  }
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}

/** Draws `src` into a new canvas of size (w, h) with good downscaling quality (progressive halving). */
export function resampleCanvas(src: CanvasImageSource & { width: number; height: number }, w: number, h: number): HTMLCanvasElement {
  let cur: CanvasImageSource = src;
  let cw = src.width;
  let ch = src.height;
  const temps: HTMLCanvasElement[] = [];
  while (cw / 2 >= w && ch / 2 >= h && cw > 2 && ch > 2) {
    cw = Math.floor(cw / 2);
    ch = Math.floor(ch / 2);
    const t = createCanvas(cw, ch);
    const tc = ctx2d(t);
    tc.imageSmoothingQuality = 'high';
    tc.drawImage(cur, 0, 0, cw, ch);
    temps.push(t);
    cur = t;
  }
  const out = createCanvas(w, h);
  const oc = ctx2d(out);
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(cur, 0, 0, w, h);
  temps.forEach(disposeCanvas);
  return out;
}

/**
 * Reads pixels of any canvas through a dedicated `willReadFrequently` scratch canvas, so
 * GPU-backed layer canvases are never read back directly (avoids slow readbacks and the
 * browser's "multiple readback operations" warning).
 */
let readCtx: CanvasRenderingContext2D | null = null;
export function readPixels(src: CanvasImageSource, x: number, y: number, w: number, h: number): ImageData {
  if (!readCtx) readCtx = ctx2d(createCanvas(w, h), { willReadFrequently: true });
  const c = readCtx.canvas;
  if (c.width < w || c.height < h) {
    c.width = Math.max(c.width, w);
    c.height = Math.max(c.height, h);
  }
  readCtx.globalCompositeOperation = 'copy';
  readCtx.globalAlpha = 1;
  readCtx.clearRect(0, 0, w, h);
  readCtx.drawImage(src, x, y, w, h, 0, 0, w, h);
  readCtx.globalCompositeOperation = 'source-over';
  const img = readCtx.getImageData(0, 0, w, h);
  // keep the scratch from pinning huge buffers
  if (c.width * c.height > 4096 * 4096) {
    c.width = 1;
    c.height = 1;
  }
  return img;
}
