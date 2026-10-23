/**
 * Rasterisers for re-editable layers: text and vector-like shapes are kept as data on the
 * layer and the layer canvas is regenerated from it after every edit.
 */
import { createCanvas, ctx2d } from './canvas';
import { shapePathCommands } from './shapePath';
import type { ShapeData, TextData } from './types';

export const TEXT_LINE_HEIGHT = 1.25;

export function fontCss(t: Pick<TextData, 'bold' | 'italic' | 'font'>, px: number): string {
  return `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : '400 '}${px}px ${t.font}`;
}

/** Padding around the glyph box inside a text layer canvas. */
export function textPad(size: number): number {
  return Math.ceil(size * 0.3);
}

export function renderText(t: TextData): HTMLCanvasElement {
  const lines = t.text.split('\n');
  const lh = Math.round(t.size * TEXT_LINE_HEIGHT);
  const measure = ctx2d(createCanvas(1, 1));
  measure.font = fontCss(t, t.size);
  const widths = lines.map((l) => measure.measureText(l).width);
  const pad = textPad(t.size);
  const maxW = Math.ceil(Math.max(1, ...widths));
  const c = createCanvas(maxW + pad * 2, lh * lines.length + pad * 2);
  const ctx = ctx2d(c);
  ctx.font = fontCss(t, t.size);
  ctx.fillStyle = t.color;
  ctx.textBaseline = 'top';
  ctx.textAlign = t.align;
  const ax = t.align === 'center' ? pad + maxW / 2 : t.align === 'right' ? pad + maxW : pad;
  lines.forEach((l, i) => ctx.fillText(l, ax, pad + i * lh + (lh - t.size) / 2));
  return c;
}

export function shapePad(s: Pick<ShapeData, 'strokeWidth' | 'stroke' | 'type'>): number {
  const sw = s.stroke || s.type === 'line' ? s.strokeWidth : 0;
  return Math.ceil(sw / 2) + 2;
}

/** Draws the shape with its box at (ox, oy), scaled by `k` (for screen previews). */
export function drawShape(ctx: CanvasRenderingContext2D, s: ShapeData, ox: number, oy: number, k = 1): void {
  ctx.lineWidth = s.strokeWidth * k;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (s.type === 'line') {
    ctx.moveTo(ox + (s.x1 ?? 0) * k, oy + (s.y1 ?? 0) * k);
    ctx.lineTo(ox + (s.x2 ?? s.w) * k, oy + (s.y2 ?? s.h) * k);
    ctx.strokeStyle = s.stroke ?? s.fill ?? '#000';
    ctx.stroke();
    return;
  }
  const w = s.w * k, hh = s.h * k;
  const cmds = shapePathCommands(s);
  if (cmds) {
    for (const c of cmds) {
      if (c.op === 'M') ctx.moveTo(ox + c.x * k, oy + c.y * k);
      else if (c.op === 'L') ctx.lineTo(ox + c.x * k, oy + c.y * k);
      else if (c.op === 'C') ctx.bezierCurveTo(ox + c.x1 * k, oy + c.y1 * k, ox + c.x2 * k, oy + c.y2 * k, ox + c.x * k, oy + c.y * k);
      else ctx.closePath();
    }
  } else ctx.ellipse(ox + w / 2, oy + hh / 2, Math.max(0.01, w / 2), Math.max(0.01, hh / 2), 0, 0, Math.PI * 2);
  if (s.fill) {
    ctx.fillStyle = s.fill;
    ctx.fill();
  }
  if (s.stroke && s.strokeWidth > 0) {
    ctx.strokeStyle = s.stroke;
    ctx.stroke();
  }
}

export function renderShape(s: ShapeData): HTMLCanvasElement {
  const pad = shapePad(s);
  const c = createCanvas(Math.ceil(s.w) + pad * 2 + 1, Math.ceil(s.h) + pad * 2 + 1);
  drawShape(ctx2d(c), s, pad, pad);
  return c;
}
