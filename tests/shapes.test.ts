import { describe, expect, it } from 'vitest';
import { sanitizeShape } from '../src/core/project';
import { cornerRadii, polygonPoints, roundedPolygon, shapePathCommands, type PathCmd } from '../src/core/shapePath';
import { cloneMeta, type LayerMeta, type ShapeData } from '../src/core/types';

const base: ShapeData = { type: 'rect', w: 100, h: 50, fill: '#ff0000', stroke: null, strokeWidth: 0, radius: 0 };

const endPoints = (cmds: PathCmd[]) => cmds.flatMap((c) => (c.op === 'Z' ? [] : [{ x: c.x, y: c.y }]));
const bezierMid = (from: { x: number; y: number }, c: Extract<PathCmd, { op: 'C' }>) => ({
  x: (from.x + 3 * c.x1 + 3 * c.x2 + c.x) / 8,
  y: (from.y + 3 * c.y1 + 3 * c.y2 + c.y) / 8,
});

describe('rect path', () => {
  it('has four exact corners without rounding', () => {
    const p = shapePathCommands(base)!;
    expect(p.map((c) => c.op)).toEqual(['M', 'L', 'L', 'L', 'Z']);
    expect(endPoints(p)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }]);
  });
  it('rounds every corner by the given radius', () => {
    const p = shapePathCommands({ ...base, radius: 10 })!;
    // 4 corners: each is a start line point plus a curve
    expect(p.filter((c) => c.op === 'C')).toHaveLength(4);
    const m0 = p[0] as Extract<PathCmd, { op: 'M' }>;
    expect(m0.x).toBeCloseTo(0);
    expect(m0.y).toBeCloseTo(10);
    const first = p[1] as Extract<PathCmd, { op: 'C' }>;
    expect(first.x).toBeCloseTo(10);
    expect(first.y).toBeCloseTo(0);
  });
  it('circular fillet midpoint lies on the circle', () => {
    const p = shapePathCommands({ ...base, radius: 10 })!;
    const c = p[1] as Extract<PathCmd, { op: 'C' }>;
    const m = bezierMid({ x: 0, y: 10 }, c);
    // circle centre (10, 10), radius 10
    expect(Math.hypot(m.x - 10, m.y - 10)).toBeCloseTo(10, 1);
  });
  it('clamps oversized radii so the shape stays inside its box (pill)', () => {
    const p = shapePathCommands({ ...base, radius: 500 })!;
    for (const pt of endPoints(p)) {
      expect(pt.x).toBeGreaterThanOrEqual(-1e-6);
      expect(pt.x).toBeLessThanOrEqual(100 + 1e-6);
      expect(pt.y).toBeGreaterThanOrEqual(-1e-6);
      expect(pt.y).toBeLessThanOrEqual(50 + 1e-6);
    }
  });
  it('supports different radii per corner', () => {
    const s = { ...base, radii: [20, 0, 10, 0] as [number, number, number, number] };
    expect(cornerRadii(s)).toEqual([20, 0, 10, 0]);
    const p = shapePathCommands(s)!;
    expect(p.filter((c) => c.op === 'C')).toHaveLength(2);
    const m0 = p[0] as Extract<PathCmd, { op: 'M' }>;
    expect(m0.x).toBeCloseTo(0);
    expect(m0.y).toBeCloseTo(20);
  });
  it('uniform radius is used when radii is absent', () => {
    expect(cornerRadii({ radius: 7 })).toEqual([7, 7, 7, 7]);
    expect(cornerRadii({ radius: -3 })).toEqual([0, 0, 0, 0]);
  });
});

describe('corner styles', () => {
  const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const style = (st: Parameters<typeof roundedPolygon>[2]) => roundedPolygon(sq, [20, 20, 20, 20], st);
  it('cut produces straight chamfers only', () => {
    expect(style('cut').some((c) => c.op === 'C')).toBe(false);
    expect(style('cut').filter((c) => c.op === 'L').length).toBe(7);
  });
  it('round < cut < inverse in how far the corner reaches the vertex', () => {
    const vertex = { x: 0, y: 0 };
    const dist = (st: Parameters<typeof roundedPolygon>[2]) => {
      const p = style(st);
      const start = p[0] as Extract<PathCmd, { op: 'M' }>;
      const end = p[1]!;
      const e = end as { x: number; y: number };
      const m = end.op === 'C' ? bezierMid(start, end) : { x: (start.x + e.x) / 2, y: (start.y + e.y) / 2 };
      return Math.hypot(m.x - vertex.x, m.y - vertex.y);
    };
    expect(dist('round')).toBeLessThan(dist('cut'));
    expect(dist('cut')).toBeLessThan(dist('inverse'));
  });
  it('smooth starts the curve further from the vertex than round', () => {
    const r = roundedPolygon(sq, [20, 20, 20, 20], 'round')[0] as Extract<PathCmd, { op: 'M' }>;
    const s = roundedPolygon(sq, [20, 20, 20, 20], 'smooth')[0] as Extract<PathCmd, { op: 'M' }>;
    expect(s.y).toBeGreaterThan(r.y);
  });
  it('all styles close the path and stay finite', () => {
    for (const st of ['round', 'smooth', 'cut', 'inverse'] as const) {
      const p = style(st);
      expect(p[p.length - 1]!.op).toBe('Z');
      for (const c of p) for (const v of Object.values(c)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('polygon and star', () => {
  it('regular hexagon points on the box ellipse, first vertex on top', () => {
    const pts = polygonPoints(100, 100, 6);
    expect(pts).toHaveLength(6);
    expect(pts[0]!.x).toBeCloseTo(50);
    expect(pts[0]!.y).toBeCloseTo(0);
    for (const p of pts) expect(Math.hypot(p.x - 50, p.y - 50)).toBeCloseTo(50);
  });
  it('clamps side counts', () => {
    expect(polygonPoints(10, 10, 1)).toHaveLength(3);
    expect(polygonPoints(10, 10, 500)).toHaveLength(60);
  });
  it('star alternates outer and inner radius', () => {
    const pts = polygonPoints(100, 100, 5, 0.4);
    expect(pts).toHaveLength(10);
    expect(Math.hypot(pts[0]!.x - 50, pts[0]!.y - 50)).toBeCloseTo(50);
    expect(Math.hypot(pts[1]!.x - 50, pts[1]!.y - 50)).toBeCloseTo(20);
  });
  it('shape path for polygon / star / rounded polygon', () => {
    const poly: ShapeData = { ...base, type: 'polygon', w: 100, h: 100, sides: 5 };
    expect(shapePathCommands(poly)!.filter((c) => c.op === 'L' || c.op === 'M')).toHaveLength(5);
    expect(shapePathCommands({ ...poly, radius: 8 })!.filter((c) => c.op === 'C')).toHaveLength(5);
    const star: ShapeData = { ...base, type: 'star', w: 100, h: 100, sides: 5, innerRatio: 0.5 };
    expect(shapePathCommands(star)!.filter((c) => c.op === 'L' || c.op === 'M')).toHaveLength(10);
  });
  it('ellipse and line have no custom path', () => {
    expect(shapePathCommands({ ...base, type: 'ellipse' })).toBeNull();
    expect(shapePathCommands({ ...base, type: 'line' })).toBeNull();
  });
});

describe('shape project data', () => {
  it('keeps and sanitises the new fields', () => {
    const s = sanitizeShape({ type: 'star', w: 100, h: 100, fill: '#00ff00', stroke: null, strokeWidth: 0, radius: 4, sides: 99, innerRatio: 5, cornerStyle: 'smooth', radii: [1, 2, 3, 4] })!;
    expect(s.sides).toBe(60);
    expect(s.innerRatio).toBe(0.98);
    expect(s.cornerStyle).toBe('smooth');
    expect(s.radii).toEqual([1, 2, 3, 4]);
  });
  it('drops invalid values and still opens old files', () => {
    const old = sanitizeShape({ type: 'rect', w: 10, h: 10, fill: '#112233', stroke: null, strokeWidth: 1, radius: 3 })!;
    expect(old.cornerStyle).toBeUndefined();
    expect(old.radii).toBeUndefined();
    const bad = sanitizeShape({ type: 'rect', w: 10, h: 10, radius: 3, radii: [1, 2], cornerStyle: 'wavy' })!;
    expect(bad.radii).toBeUndefined();
    expect(bad.cornerStyle).toBeUndefined();
    expect(sanitizeShape({ type: 'blob' })).toBeUndefined();
  });
  it('cloneMeta deep-copies radii', () => {
    const m: LayerMeta = { id: 'a', name: 'a', kind: 'shape', visible: true, locked: false, opacity: 1, blend: 'normal', x: 0, y: 0, shape: { ...base, radii: [1, 2, 3, 4] } };
    const c = cloneMeta(m);
    c.shape!.radii![0] = 99;
    expect(m.shape!.radii![0]).toBe(1);
  });
});
