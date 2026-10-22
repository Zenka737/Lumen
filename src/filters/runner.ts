import { FILTERS, type Params } from './filters';

interface Pending {
  resolve(d: ImageData): void;
  reject(e: Error): void;
  width: number;
  height: number;
}

/**
 * Runs filters off the main thread. Falls back to main-thread execution (deferred via
 * setTimeout so the UI can paint a busy indicator) if Workers are unavailable or crash.
 */
export class FilterRunner {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; buffer?: ArrayBuffer; error?: string }>) => {
        const job = this.pending.get(e.data.id);
        if (!job) return;
        this.pending.delete(e.data.id);
        if (e.data.ok && e.data.buffer) job.resolve(new ImageData(new Uint8ClampedArray(e.data.buffer), job.width, job.height));
        else job.reject(new Error(e.data.error ?? 'Ошибка фильтра'));
      };
      this.worker.onerror = (e) => {
        console.error('[Lumen] filter worker failed, falling back to main thread', e);
        this.failAll(new Error('Фоновый обработчик недоступен — повторите действие'));
        this.worker?.terminate();
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** NOTE: `img.data.buffer` is transferred (detached) when a worker is used. */
  run(filterId: string, params: Params, img: ImageData): Promise<ImageData> {
    const def = FILTERS[filterId];
    if (!def) return Promise.reject(new Error(`Неизвестный фильтр: ${filterId}`));
    if (!this.worker) {
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          try {
            def.apply(img, params);
            resolve(img);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        }, 16),
      );
    }
    const id = ++this.seq;
    const { width, height } = img;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, width, height });
      const buffer = img.data.buffer as ArrayBuffer;
      this.worker!.postMessage({ id, filterId, params, buffer, width, height }, [buffer]);
    });
  }

  dispose(): void {
    this.failAll(new Error('disposed'));
    this.worker?.terminate();
    this.worker = null;
  }
}
