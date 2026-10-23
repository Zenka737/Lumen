/**
 * Keyframe animation model (DOM-free): per-layer tracks for position, scale, rotation and
 * opacity, sampled by frame number with easing.
 */
export type AnimProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity';
export const ANIM_PROPS: AnimProp[] = ['x', 'y', 'scale', 'rotation', 'opacity'];

export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold';
export const EASINGS: { id: Easing; label: string }[] = [
  { id: 'linear', label: 'Линейно' },
  { id: 'ease-in', label: 'Разгон' },
  { id: 'ease-out', label: 'Торможение' },
  { id: 'ease-in-out', label: 'Плавно' },
  { id: 'hold', label: 'Ступенька' },
];

/** Value `v` at frame `f`; `ease` shapes the segment that starts at this keyframe. */
export interface Keyframe {
  f: number;
  v: number;
  ease: Easing;
}
export type Tracks = Partial<Record<AnimProp, Keyframe[]>>;

export interface Animation {
  fps: number;
  /** Number of frames (frame indices 0 … frames-1). */
  frames: number;
  tracks: Record<string, Tracks>;
}

export const MAX_FRAMES = 3600;
export const MAX_FPS = 60;

export function createAnimation(fps = 24, seconds = 3): Animation {
  return { fps, frames: Math.round(fps * seconds), tracks: {} };
}

export function ease(e: Easing, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  switch (e) {
    case 'ease-in':
      return x * x * x;
    case 'ease-out':
      return 1 - (1 - x) ** 3;
    case 'ease-in-out':
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    case 'hold':
      return x >= 1 ? 1 : 0;
    default:
      return x;
  }
}

/** Sorted keyframes sampled at frame `f`; `fallback` when the track is empty. */
export function sampleTrack(kfs: Keyframe[] | undefined, f: number, fallback: number): number {
  if (!kfs || kfs.length === 0) return fallback;
  if (f <= kfs[0]!.f) return kfs[0]!.v;
  const last = kfs[kfs.length - 1]!;
  if (f >= last.f) return last.v;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!, b = kfs[i + 1]!;
    if (f >= a.f && f <= b.f) {
      const span = b.f - a.f;
      return a.v + (b.v - a.v) * ease(a.ease, span === 0 ? 1 : (f - a.f) / span);
    }
  }
  return last.v;
}

export interface LayerState {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

/** Animated state of a layer at frame `f`, falling back to its static values. */
export function stateAt(anim: Animation | undefined, id: string, f: number, base: LayerState): LayerState {
  const t = anim?.tracks[id];
  if (!t) return base;
  return {
    x: sampleTrack(t.x, f, base.x),
    y: sampleTrack(t.y, f, base.y),
    scale: Math.max(0.001, sampleTrack(t.scale, f, base.scale)),
    rotation: sampleTrack(t.rotation, f, base.rotation),
    opacity: Math.max(0, Math.min(1, sampleTrack(t.opacity, f, base.opacity))),
  };
}

export function isAnimated(anim: Animation | undefined, id: string): boolean {
  const t = anim?.tracks[id];
  return !!t && ANIM_PROPS.some((p) => (t[p]?.length ?? 0) > 0);
}

/** Inserts or replaces the keyframe at frame `f` (keeps the track sorted). */
export function setKeyframe(anim: Animation, id: string, prop: AnimProp, f: number, v: number, easing?: Easing): void {
  const frame = Math.max(0, Math.min(anim.frames - 1, Math.round(f)));
  const tracks = (anim.tracks[id] ??= {});
  const list = (tracks[prop] ??= []);
  const i = list.findIndex((k) => k.f === frame);
  if (i >= 0) list[i] = { f: frame, v, ease: easing ?? list[i]!.ease };
  else {
    list.push({ f: frame, v, ease: easing ?? 'ease-in-out' });
    list.sort((a, b) => a.f - b.f);
  }
}

export function removeKeyframe(anim: Animation, id: string, prop: AnimProp, f: number): boolean {
  const list = anim.tracks[id]?.[prop];
  if (!list) return false;
  const i = list.findIndex((k) => k.f === Math.round(f));
  if (i < 0) return false;
  list.splice(i, 1);
  if (list.length === 0) {
    delete anim.tracks[id]![prop];
    if (ANIM_PROPS.every((p) => !anim.tracks[id]![p])) delete anim.tracks[id];
  }
  return true;
}

export function hasKeyframe(anim: Animation | undefined, id: string, prop: AnimProp, f: number): boolean {
  return !!anim?.tracks[id]?.[prop]?.some((k) => k.f === Math.round(f));
}

/** Nearest keyframe frame of a layer strictly before / after `f` (any property), or null. */
export function neighbourKeyframe(anim: Animation | undefined, id: string, f: number, dir: -1 | 1): number | null {
  const t = anim?.tracks[id];
  if (!t) return null;
  let best: number | null = null;
  for (const p of ANIM_PROPS) {
    for (const k of t[p] ?? []) {
      if (dir === 1 && k.f > f && (best === null || k.f < best)) best = k.f;
      if (dir === -1 && k.f < f && (best === null || k.f > best)) best = k.f;
    }
  }
  return best;
}

/** Resizes the timeline; keyframes beyond the new end are clamped to the last frame. */
export function setLength(anim: Animation, fps: number, frames: number): void {
  const nf = Math.max(1, Math.min(MAX_FRAMES, Math.round(frames)));
  anim.fps = Math.max(1, Math.min(MAX_FPS, Math.round(fps)));
  anim.frames = nf;
  for (const t of Object.values(anim.tracks)) {
    for (const p of ANIM_PROPS) {
      const list = t[p];
      if (!list) continue;
      const kept = new Map<number, Keyframe>();
      for (const k of list) kept.set(Math.min(k.f, nf - 1), { ...k, f: Math.min(k.f, nf - 1) });
      t[p] = [...kept.values()].sort((a, b) => a.f - b.f);
    }
  }
}

export function durationSeconds(anim: Animation): number {
  return anim.frames / anim.fps;
}

export function cloneAnimation(a: Animation): Animation {
  const tracks: Animation['tracks'] = {};
  for (const [id, t] of Object.entries(a.tracks)) {
    const nt: Tracks = {};
    for (const p of ANIM_PROPS) if (t[p]) nt[p] = t[p]!.map((k) => ({ ...k }));
    tracks[id] = nt;
  }
  return { fps: a.fps, frames: a.frames, tracks };
}

const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const EASE_IDS = new Set<string>(EASINGS.map((e) => e.id));

/** Validates untrusted project data; unknown layers are dropped when `layerIds` is given. */
export function sanitizeAnimation(a: unknown, layerIds?: Set<string>): Animation | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const o = a as Partial<Animation>;
  const out: Animation = { fps: Math.round(num(o.fps, 24, 1, MAX_FPS)), frames: Math.round(num(o.frames, 72, 1, MAX_FRAMES)), tracks: {} };
  if (o.tracks && typeof o.tracks === 'object') {
    for (const [id, t] of Object.entries(o.tracks).slice(0, 2000)) {
      if (layerIds && !layerIds.has(id)) continue;
      if (!t || typeof t !== 'object') continue;
      const nt: Tracks = {};
      for (const p of ANIM_PROPS) {
        const list = (t as Tracks)[p];
        if (!Array.isArray(list)) continue;
        const kept = new Map<number, Keyframe>();
        for (const k of list.slice(0, MAX_FRAMES)) {
          if (!k || typeof k !== 'object') continue;
          const f = Math.round(num(k.f, 0, 0, out.frames - 1));
          kept.set(f, { f, v: num(k.v, 0, -1e6, 1e6), ease: EASE_IDS.has(k.ease) ? k.ease : 'ease-in-out' });
        }
        if (kept.size) nt[p] = [...kept.values()].sort((x, y) => x.f - y.f);
      }
      if (Object.keys(nt).length) out.tracks[id] = nt;
    }
  }
  return out;
}
