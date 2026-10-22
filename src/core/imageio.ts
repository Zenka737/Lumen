import { createCanvas, ctx2d, MAX_AREA, MAX_SIDE, resampleCanvas } from './canvas';

export interface Decoded {
  width: number;
  height: number;
  source: CanvasImageSource & { width: number; height: number };
  close(): void;
}

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,image/svg+xml';

/** Decodes an image blob. Prefers createImageBitmap (off-main-thread decode), falls back to <img>. */
export async function decodeImage(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function' && blob.type !== 'image/svg+xml') {
    try {
      const bmp = await createImageBitmap(blob);
      return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
    } catch {
      /* fall through */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 512, h = img.naturalHeight || 512;
    return { width: w, height: h, source: Object.assign(img, { width: w, height: h }), close: () => undefined };
  } catch {
    throw new Error('Не удалось прочитать изображение — формат не поддерживается или файл повреждён');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type SizeVerdict = 'ok' | 'large' | 'too-large';
/** Images above "large" get a warning + downscale offer; above hard limits must be downscaled. */
export function checkSize(w: number, h: number): SizeVerdict {
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_AREA) return 'too-large';
  if (Math.max(w, h) > 8192 || w * h > 40_000_000) return 'large';
  return 'ok';
}

export function fitWithin(w: number, h: number, maxSide: number): { w: number; h: number } {
  const k = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(MAX_AREA / (w * h)));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

export function toCanvas(d: Decoded, w = d.width, h = d.height): HTMLCanvasElement {
  if (w === d.width && h === d.height) {
    const c = createCanvas(w, h);
    ctx2d(c).drawImage(d.source, 0, 0);
    return c;
  }
  return resampleCanvas(d.source, w, h);
}

export type ExportFormat = 'image/png' | 'image/jpeg' | 'image/webp';

export function canvasToBlob(c: HTMLCanvasElement, type: ExportFormat | 'image/png' = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось закодировать изображение'))), type, quality);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** JPEG has no alpha — composite onto white first. */
export async function exportCanvas(src: HTMLCanvasElement, type: ExportFormat, quality: number): Promise<Blob> {
  if (type !== 'image/jpeg') return canvasToBlob(src, type, quality);
  const c = createCanvas(src.width, src.height);
  const x = ctx2d(c);
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, c.width, c.height);
  x.drawImage(src, 0, 0);
  try {
    return await canvasToBlob(c, type, quality);
  } finally {
    c.width = c.height = 1;
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}
