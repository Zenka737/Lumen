/** Guides & snapping (pure). */
import type { Guide } from './document';
import type { Rect } from './types';

export interface SnapTargets {
  xs: number[];
  ys: number[];
}

/** Snap lines: guides plus document edges and centre. */
export function snapTargets(guides: readonly Guide[], docW: number, docH: number): SnapTargets {
  const xs = [0, docW / 2, docW], ys = [0, docH / 2, docH];
  for (const g of guides) (g.axis === 'v' ? xs : ys).push(g.pos);
  return { xs, ys };
}

/** Nearest target within `tol`, else null. */
export function snapValue(v: number, targets: readonly number[], tol: number): number | null {
  let best: number | null = null;
  let bd = tol;
  for (const t of targets) {
    const d = Math.abs(t - v);
    if (d <= bd) {
      bd = d;
      best = t;
    }
  }
  return best;
}

export function snapPoint(x: number, y: number, t: SnapTargets, tol: number): { x: number; y: number } {
  return { x: snapValue(x, t.xs, tol) ?? x, y: snapValue(y, t.ys, tol) ?? y };
}

/** Offset (dx, dy) that snaps the nearest of a rect's left/centre/right (top/middle/bottom) edges. */
export function snapRectOffset(r: Rect, t: SnapTargets, tol: number): { dx: number; dy: number } {
  const axis = (vals: number[], targets: number[]) => {
    let best = 0;
    let bd = Infinity;
    for (const v of vals) {
      const s = snapValue(v, targets, tol);
      if (s !== null && Math.abs(s - v) < bd) {
        bd = Math.abs(s - v);
        best = s - v;
      }
    }
    return best;
  };
  return { dx: axis([r.x, r.x + r.w / 2, r.x + r.w], t.xs), dy: axis([r.y, r.y + r.h / 2, r.y + r.h], t.ys) };
}

/** Ruler tick spacing (document px) so labelled ticks are ≥ ~50 screen px apart. */
export function rulerStep(zoom: number): number {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  return steps.find((s) => s * zoom >= 50) ?? 10000;
}
