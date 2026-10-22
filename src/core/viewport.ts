/** Screen <-> document transform. screen = doc * zoom + pan (CSS pixels). */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;
export const ZOOM_STEPS = [
  0.02, 0.03, 0.05, 0.0625, 0.083, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64,
];

export class Viewport {
  zoom = 1;
  panX = 0;
  panY = 0;
  /** Size of the view in CSS px. */
  width = 800;
  height = 600;

  toDoc(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom };
  }
  toScreen(x: number, y: number): { x: number; y: number } {
    return { x: x * this.zoom + this.panX, y: y * this.zoom + this.panY };
  }

  /** Zoom to `z` keeping the document point under (sx, sy) fixed. */
  zoomAt(z: number, sx: number, sy: number): void {
    const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const d = this.toDoc(sx, sy);
    this.zoom = nz;
    this.panX = sx - d.x * nz;
    this.panY = sy - d.y * nz;
  }

  stepZoom(dir: 1 | -1, sx = this.width / 2, sy = this.height / 2): void {
    const z = this.zoom;
    let next = z;
    if (dir > 0) next = ZOOM_STEPS.find((s) => s > z * 1.001) ?? MAX_ZOOM;
    else next = [...ZOOM_STEPS].reverse().find((s) => s < z / 1.001) ?? MIN_ZOOM;
    this.zoomAt(next, sx, sy);
  }

  fit(docW: number, docH: number, padding = 40): void {
    const aw = Math.max(50, this.width - padding * 2);
    const ah = Math.max(50, this.height - padding * 2);
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(aw / docW, ah / docH)));
    this.zoom = z;
    this.center(docW, docH);
  }

  center(docW: number, docH: number): void {
    this.panX = Math.round((this.width - docW * this.zoom) / 2);
    this.panY = Math.round((this.height - docH * this.zoom) / 2);
  }

  /** Keep at least `margin` px of the document visible so it can never be "lost". */
  clampPan(docW: number, docH: number, margin = 64): void {
    const w = docW * this.zoom;
    const h = docH * this.zoom;
    const m = Math.min(margin, w, h);
    this.panX = Math.min(this.width - m, Math.max(m - w, this.panX));
    this.panY = Math.min(this.height - m, Math.max(m - h, this.panY));
  }
}
