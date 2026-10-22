import { createCanvas } from './canvas';
import { Selection } from './selection';
import type { LayerKind, LayerMeta } from './types';

let idSeq = 0;
export function newId(): string {
  return `L${Date.now().toString(36)}${(idSeq++).toString(36)}`;
}

/** In-progress brush/eraser stroke, composited live above the layer pixels. */
export interface LiveStroke {
  canvas: HTMLCanvasElement;
  opacity: number;
  erase: boolean;
  /** Stroke paints the layer mask instead of its pixels. */
  mask?: boolean;
  /** `canvas` is the complete replacement of the target (already clipped/blended). */
  replace?: boolean;
}

/** Affine matrix [a, b, c, d, e, f] as used by CanvasRenderingContext2D.transform. */
export type Matrix = [number, number, number, number, number, number];

/**
 * Live free-transform preview: `base` (layer coords, may be null) drawn untransformed,
 * `float` drawn through `m` (float pixels → document). When `maskAfter`, the layer mask is
 * applied to the combined result; otherwise `float` already has the mask baked in.
 */
export interface LiveTransform {
  base: HTMLCanvasElement | null;
  float: HTMLCanvasElement;
  m: Matrix;
  maskAfter: boolean;
}

export interface Guide {
  axis: 'h' | 'v';
  /** Document coordinate (y for horizontal, x for vertical guides). */
  pos: number;
}

export class Layer {
  /** Non-destructive adjustment preview (may be smaller than canvas; drawn scaled). */
  preview: HTMLCanvasElement | null = null;
  live: LiveStroke | null = null;
  /** Layer mask (alpha = visibility), positioned at the layer origin. */
  mask: HTMLCanvasElement | null = null;
  xform: LiveTransform | null = null;
  /** Hidden from the live view while its text is being edited in place. */
  editing = false;
  /** Bumped whenever pixels change (thumbnails). */
  pixelVersion = 0;

  constructor(
    public meta: LayerMeta,
    public canvas: HTMLCanvasElement,
  ) {}

  get width(): number {
    return this.canvas.width;
  }
  get height(): number {
    return this.canvas.height;
  }
}

export function createLayer(name: string, w: number, h: number, kind: LayerKind = 'raster', canvas?: HTMLCanvasElement): Layer {
  return new Layer(
    { id: newId(), name, kind, visible: true, locked: false, opacity: 1, blend: 'normal', x: 0, y: 0 },
    canvas ?? createCanvas(w, h),
  );
}

export class Doc {
  layers: Layer[] = [];
  activeId = '';
  selection = new Selection();
  guides: Guide[] = [];

  constructor(
    public width: number,
    public height: number,
    public name = 'Без названия',
  ) {}

  get active(): Layer | null {
    return this.layers.find((l) => l.meta.id === this.activeId) ?? this.layers[this.layers.length - 1] ?? null;
  }
  find(id: string): Layer | undefined {
    return this.layers.find((l) => l.meta.id === id);
  }
  indexOf(id: string): number {
    return this.layers.findIndex((l) => l.meta.id === id);
  }
}
