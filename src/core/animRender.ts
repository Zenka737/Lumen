/** Renders a frame of the document animation by compositing animated copies of its layers. */
import { stateAt, type LayerState } from './animation';
import { createCanvas, ctx2d } from './canvas';
import { Doc, Layer } from './document';
import { compositeDoc } from './render';
import { cloneMeta } from './types';

/** Static (un-animated) state of a layer. */
export function baseState(l: Layer): LayerState {
  return { x: l.meta.x, y: l.meta.y, scale: 1, rotation: 0, opacity: l.meta.opacity };
}

/** Layer canvas with its mask baked in (null when there is no active mask). */
function bakedCanvas(l: Layer): HTMLCanvasElement {
  if (!l.mask || l.meta.maskEnabled === false) return l.canvas;
  const c = createCanvas(l.width, l.height);
  const x = ctx2d(c);
  x.drawImage(l.canvas, 0, 0);
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(l.mask, 0, 0);
  return c;
}

/** Temporary document whose layers are positioned / scaled / rotated for `frame`. */
export function frameDoc(doc: Doc, frame: number): Doc {
  const out = new Doc(doc.width, doc.height, doc.name);
  for (const l of doc.layers) {
    if (l.meta.kind === 'adjustment') {
      out.layers.push(l);
      continue;
    }
    const st = stateAt(doc.animation, l.meta.id, frame, baseState(l));
    const meta = cloneMeta(l.meta);
    meta.opacity = st.opacity;
    const plain = st.scale === 1 && st.rotation === 0;
    if (plain && !l.mask) {
      meta.x = Math.round(st.x);
      meta.y = Math.round(st.y);
      out.layers.push(new Layer(meta, l.canvas));
      continue;
    }
    // scale / rotate around the layer centre
    const src = bakedCanvas(l);
    const w = l.width * st.scale, h = l.height * st.scale;
    const a = (st.rotation * Math.PI) / 180;
    const bw = Math.ceil(Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))) + 2;
    const bh = Math.ceil(Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a))) + 2;
    const c = createCanvas(Math.max(1, bw), Math.max(1, bh));
    const x = ctx2d(c);
    x.imageSmoothingQuality = 'high';
    x.translate(c.width / 2, c.height / 2);
    x.rotate(a);
    x.drawImage(src, -w / 2, -h / 2, w, h);
    const cx = st.x + l.width / 2, cy = st.y + l.height / 2;
    meta.x = Math.round(cx - c.width / 2);
    meta.y = Math.round(cy - c.height / 2);
    delete meta.maskEnabled;
    out.layers.push(new Layer(meta, c));
  }
  out.activeId = doc.activeId;
  return out;
}

/** Draws `frame` onto `ctx` (document pixel space, clears nothing: caller prepares the background). */
export function renderFrame(doc: Doc, frame: number, ctx: CanvasRenderingContext2D): void {
  compositeDoc(frameDoc(doc, frame), ctx, { committedOnly: true });
}
