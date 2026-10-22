import type { ProjectRecord } from './project';

/** Minimal promise wrapper around IndexedDB for the single autosave slot. */
const DB = 'lumen';
const STORE = 'autosave';
const KEY = 'current';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB недоступен'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB error'));
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction error'));
      t.onabort = () => reject(t.error ?? new Error('IndexedDB: недостаточно места'));
    });
  } finally {
    db.close();
  }
}

export const saveAutosave = (rec: ProjectRecord) => tx('readwrite', (s) => s.put(rec, KEY)).then(() => undefined);
export const loadAutosave = () => tx<ProjectRecord | undefined>('readonly', (s) => s.get(KEY) as IDBRequest<ProjectRecord | undefined>);
export const clearAutosave = () => tx('readwrite', (s) => s.delete(KEY)).then(() => undefined);
