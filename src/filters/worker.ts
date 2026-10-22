/// Filter worker: receives a transferable RGBA buffer, processes it, transfers it back.
import { FILTERS } from './filters';

interface Req {
  id: number;
  filterId: string;
  params: Record<string, number>;
  buffer: ArrayBuffer;
  width: number;
  height: number;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Req>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

scope.onmessage = (e) => {
  const { id, filterId, params, buffer, width, height } = e.data;
  try {
    const def = FILTERS[filterId];
    if (!def) throw new Error(`Неизвестный фильтр: ${filterId}`);
    def.apply({ data: new Uint8ClampedArray(buffer), width, height }, params);
    scope.postMessage({ id, ok: true, buffer }, [buffer]);
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) }, []);
  }
};
