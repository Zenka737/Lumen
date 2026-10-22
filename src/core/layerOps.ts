/** Pure helpers for layer list manipulation (unit tested). */

/** Returns a new array with the item at `from` moved to index `to` (clamped). */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = arr.slice();
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item as T);
  return out;
}

export function uniqueName(base: string, existing: Iterable<string>): string {
  const set = new Set(existing);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const n = `${base} ${i}`;
    if (!set.has(n)) return n;
  }
}

export function copyName(name: string, existing: Iterable<string>): string {
  return uniqueName(`${name.replace(/ копия( \d+)?$/, '')} копия`, existing);
}

export function nextLayerName(existing: Iterable<string>): string {
  let max = 0;
  for (const n of existing) {
    const m = /^Слой (\d+)$/.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Слой ${max + 1}`;
}

/** Index to select after deleting index `i` from a list that had `len` items. */
export function indexAfterDelete(i: number, len: number): number {
  if (len <= 1) return -1;
  return Math.max(0, Math.min(i, len - 2));
}
