/** Tiny typed event emitter. Listener errors are isolated so one bad panel can't break others. */
export class Emitter<E extends object> {
  private map = new Map<keyof E, Set<(payload: never) => void>>();

  on<K extends keyof E>(key: K, fn: (payload: E[K]) => void): () => void {
    let set = this.map.get(key);
    if (!set) {
      set = new Set();
      this.map.set(key, set);
    }
    set.add(fn as (payload: never) => void);
    return () => set!.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof E>(key: K, payload: E[K]): void {
    const set = this.map.get(key);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (p: E[K]) => void)(payload);
      } catch (err) {
        console.error(`[Lumen] listener "${String(key)}" failed`, err);
      }
    }
  }
}
