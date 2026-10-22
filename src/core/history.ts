/**
 * Command-based undo/redo. Each entry knows how to undo/redo itself and reports an
 * approximate memory cost; the stack is bounded both by entry count and total bytes.
 * Pixel edits store only the dirty rectangle (before/after), structural edits store
 * references to layer canvases (cheap).
 */
export interface HistoryEntry {
  label: string;
  undo(): void;
  redo(): void;
  /** Approximate retained memory in bytes. */
  bytes: number;
  /** Consecutive pushes with the same key (within a short window) are merged. */
  coalesceKey?: string;
  time?: number;
  dispose?(): void;
}

export class History {
  private entries: HistoryEntry[] = [];
  /** Index of the last applied entry; -1 = initial state. */
  private cursor = -1;
  private busy = false;
  private listeners = new Set<() => void>();
  /** Number of entries dropped from the bottom (so the panel can show "older steps trimmed"). */
  trimmed = 0;

  constructor(
    public maxEntries = 100,
    public maxBytes = 640 * 1024 * 1024,
    public coalesceWindowMs = 1200,
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  get index(): number {
    return this.cursor;
  }
  get length(): number {
    return this.entries.length;
  }
  get canUndo(): boolean {
    return this.cursor >= 0;
  }
  get canRedo(): boolean {
    return this.cursor < this.entries.length - 1;
  }
  get isBusy(): boolean {
    return this.busy;
  }
  get totalBytes(): number {
    return this.entries.reduce((s, e) => s + e.bytes, 0);
  }
  list(): readonly HistoryEntry[] {
    return this.entries;
  }

  push(entry: HistoryEntry, now = Date.now()): void {
    if (this.busy) return; // never record while undoing/redoing
    entry.time = now;
    // drop redo tail
    const tail = this.entries.splice(this.cursor + 1);
    for (const e of tail) e.dispose?.();

    const last = this.entries[this.entries.length - 1];
    if (
      entry.coalesceKey &&
      last &&
      tail.length === 0 &&
      last.coalesceKey === entry.coalesceKey &&
      last.time !== undefined &&
      now - last.time < this.coalesceWindowMs
    ) {
      const merged: HistoryEntry = {
        label: entry.label,
        undo: last.undo,
        redo: entry.redo,
        bytes: last.bytes + entry.bytes,
        coalesceKey: entry.coalesceKey,
        time: now,
        dispose: () => {
          last.dispose?.();
          entry.dispose?.();
        },
      };
      this.entries[this.entries.length - 1] = merged;
    } else {
      this.entries.push(entry);
    }
    this.cursor = this.entries.length - 1;
    this.enforceLimits();
    this.notify();
  }

  private enforceLimits(): void {
    let total = this.totalBytes;
    // Always keep at least the newest entry, even if it alone exceeds the budget.
    while (this.entries.length > 1 && (this.entries.length > this.maxEntries || total > this.maxBytes)) {
      const e = this.entries.shift()!;
      total -= e.bytes;
      e.dispose?.();
      this.cursor--;
      this.trimmed++;
    }
  }

  private run(fn: () => void): void {
    this.busy = true;
    try {
      fn();
    } finally {
      this.busy = false;
    }
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    const e = this.entries[this.cursor]!;
    this.run(() => e.undo());
    this.cursor--;
    this.notify();
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    const e = this.entries[this.cursor + 1]!;
    this.run(() => e.redo());
    this.cursor++;
    this.notify();
    return true;
  }

  /** Move to state after entry `i` (-1 = initial). */
  jumpTo(i: number): void {
    const target = Math.max(-1, Math.min(this.entries.length - 1, i));
    while (this.cursor > target) if (!this.undo()) break;
    while (this.cursor < target) if (!this.redo()) break;
  }

  clear(): void {
    for (const e of this.entries) e.dispose?.();
    this.entries = [];
    this.cursor = -1;
    this.trimmed = 0;
    this.notify();
  }
}
