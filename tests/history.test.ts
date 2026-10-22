import { describe, expect, it } from 'vitest';
import { History } from '../src/core/history';

function counter() {
  const state = { v: 0 };
  const step = (h: History, d: number, bytes = 10, key?: string, now?: number) => {
    const before = state.v;
    state.v += d;
    const after = state.v;
    h.push({ label: `+${d}`, bytes, coalesceKey: key, undo: () => (state.v = before), redo: () => (state.v = after) }, now);
  };
  return { state, step };
}

describe('History', () => {
  it('undoes and redoes in order', () => {
    const h = new History();
    const { state, step } = counter();
    step(h, 1);
    step(h, 2);
    step(h, 3);
    expect(state.v).toBe(6);
    h.undo();
    expect(state.v).toBe(3);
    h.undo();
    expect(state.v).toBe(1);
    h.redo();
    expect(state.v).toBe(3);
    expect(h.canRedo).toBe(true);
  });

  it('drops redo tail on new push', () => {
    const h = new History();
    const { state, step } = counter();
    step(h, 1);
    step(h, 2);
    h.undo();
    step(h, 10);
    expect(state.v).toBe(11);
    expect(h.canRedo).toBe(false);
    expect(h.length).toBe(2);
  });

  it('jumpTo moves across multiple steps including initial state', () => {
    const h = new History();
    const { state, step } = counter();
    for (let i = 1; i <= 5; i++) step(h, i);
    h.jumpTo(-1);
    expect(state.v).toBe(0);
    h.jumpTo(2);
    expect(state.v).toBe(6);
    expect(h.index).toBe(2);
  });

  it('enforces entry count limit and disposes trimmed entries', () => {
    const h = new History(3);
    let disposed = 0;
    for (let i = 0; i < 5; i++) h.push({ label: String(i), bytes: 1, undo() {}, redo() {}, dispose: () => disposed++ });
    expect(h.length).toBe(3);
    expect(disposed).toBe(2);
    expect(h.trimmed).toBe(2);
    expect(h.index).toBe(2);
  });

  it('enforces memory budget but keeps the newest entry', () => {
    const h = new History(100, 100);
    const { step } = counter();
    step(h, 1, 60);
    step(h, 1, 60);
    expect(h.length).toBe(1);
    step(h, 1, 500);
    expect(h.length).toBe(1);
    expect(h.totalBytes).toBe(500);
  });

  it('coalesces consecutive entries with the same key inside the window', () => {
    const h = new History(100, 1e9, 1000);
    const { state, step } = counter();
    step(h, 1, 1, 'op', 0);
    step(h, 1, 1, 'op', 500);
    step(h, 1, 1, 'op', 900);
    expect(h.length).toBe(1);
    h.undo();
    expect(state.v).toBe(0);
    h.redo();
    expect(state.v).toBe(3);
    step(h, 1, 1, 'op', 5000); // outside window
    expect(h.length).toBe(2);
  });

  it('ignores pushes during undo (re-entrancy guard)', () => {
    const h = new History();
    h.push({ label: 'a', bytes: 1, undo: () => h.push({ label: 'evil', bytes: 1, undo() {}, redo() {} }), redo() {} });
    h.undo();
    expect(h.length).toBe(1);
  });

  it('returns false when nothing to undo/redo', () => {
    const h = new History();
    expect(h.undo()).toBe(false);
    expect(h.redo()).toBe(false);
  });
});
