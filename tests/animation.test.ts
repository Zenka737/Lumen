import { describe, expect, it } from 'vitest';
import { cloneAnimation, createAnimation, durationSeconds, ease, hasKeyframe, isAnimated, neighbourKeyframe, removeKeyframe, sampleTrack, sanitizeAnimation, setKeyframe, setLength, stateAt, type Keyframe } from '../src/core/animation';

const base = { x: 10, y: 20, scale: 1, rotation: 0, opacity: 1 };

describe('easing', () => {
  it('endpoints are exact for every curve', () => {
    for (const e of ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'] as const) {
      expect(ease(e, 0)).toBe(0);
      expect(ease(e, 1)).toBe(1);
    }
  });
  it('shapes: ease-in slow start, ease-out fast start, hold is a step', () => {
    expect(ease('ease-in', 0.5)).toBeLessThan(0.5);
    expect(ease('ease-out', 0.5)).toBeGreaterThan(0.5);
    expect(ease('ease-in-out', 0.5)).toBeCloseTo(0.5);
    expect(ease('hold', 0.99)).toBe(0);
    expect(ease('linear', 5)).toBe(1);
    expect(ease('linear', -5)).toBe(0);
  });
});

describe('sampling', () => {
  const kfs: Keyframe[] = [
    { f: 10, v: 0, ease: 'linear' },
    { f: 20, v: 100, ease: 'linear' },
    { f: 30, v: 50, ease: 'hold' },
  ];
  it('falls back when empty and clamps before / after the range', () => {
    expect(sampleTrack(undefined, 5, 7)).toBe(7);
    expect(sampleTrack([], 5, 7)).toBe(7);
    expect(sampleTrack(kfs, 0, 0)).toBe(0);
    expect(sampleTrack(kfs, 99, 0)).toBe(50);
  });
  it('interpolates linearly between keyframes', () => {
    expect(sampleTrack(kfs, 15, 0)).toBe(50);
    expect(sampleTrack(kfs, 12, 0)).toBeCloseTo(20);
    expect(sampleTrack(kfs, 20, 0)).toBe(100);
  });
  it('hold keeps the value until the next keyframe', () => {
    const k: Keyframe[] = [{ f: 0, v: 1, ease: 'hold' }, { f: 10, v: 9, ease: 'linear' }];
    expect(sampleTrack(k, 9, 0)).toBe(1);
    expect(sampleTrack(k, 10, 0)).toBe(9);
  });
});

describe('editing keyframes', () => {
  it('sets, replaces and keeps keyframes sorted', () => {
    const a = createAnimation(24, 3);
    setKeyframe(a, 'L1', 'x', 30, 5);
    setKeyframe(a, 'L1', 'x', 0, 1);
    setKeyframe(a, 'L1', 'x', 30, 9);
    expect(a.tracks.L1!.x!.map((k) => [k.f, k.v])).toEqual([[0, 1], [30, 9]]);
    expect(hasKeyframe(a, 'L1', 'x', 30)).toBe(true);
    expect(isAnimated(a, 'L1')).toBe(true);
    expect(isAnimated(a, 'nope')).toBe(false);
  });
  it('clamps frames into the timeline', () => {
    const a = createAnimation(10, 1);
    setKeyframe(a, 'L', 'opacity', 999, 0.5);
    setKeyframe(a, 'L', 'opacity', -4, 1);
    expect(a.tracks.L!.opacity!.map((k) => k.f)).toEqual([0, 9]);
  });
  it('removes keyframes and cleans empty tracks', () => {
    const a = createAnimation();
    setKeyframe(a, 'L', 'y', 5, 1);
    expect(removeKeyframe(a, 'L', 'y', 6)).toBe(false);
    expect(removeKeyframe(a, 'L', 'y', 5)).toBe(true);
    expect(a.tracks.L).toBeUndefined();
  });
  it('finds neighbouring keyframes across properties', () => {
    const a = createAnimation();
    setKeyframe(a, 'L', 'x', 10, 0);
    setKeyframe(a, 'L', 'scale', 20, 1);
    setKeyframe(a, 'L', 'rotation', 30, 1);
    expect(neighbourKeyframe(a, 'L', 10, 1)).toBe(20);
    expect(neighbourKeyframe(a, 'L', 25, -1)).toBe(20);
    expect(neighbourKeyframe(a, 'L', 30, 1)).toBeNull();
    expect(neighbourKeyframe(a, 'L', 10, -1)).toBeNull();
    expect(neighbourKeyframe(a, 'X', 0, 1)).toBeNull();
  });
  it('resizing the timeline clamps keyframes to the new end', () => {
    const a = createAnimation(24, 3);
    setKeyframe(a, 'L', 'x', 10, 1);
    setKeyframe(a, 'L', 'x', 60, 2);
    setKeyframe(a, 'L', 'x', 70, 3);
    setLength(a, 12, 20);
    expect(a.fps).toBe(12);
    expect(a.frames).toBe(20);
    expect(a.tracks.L!.x!.map((k) => k.f)).toEqual([10, 19]);
    expect(a.tracks.L!.x![1]!.v).toBe(3);
    expect(durationSeconds(a)).toBeCloseTo(20 / 12);
  });
});

describe('layer state', () => {
  it('uses static values for layers without tracks and animates the rest', () => {
    const a = createAnimation();
    expect(stateAt(a, 'none', 5, base)).toEqual(base);
    setKeyframe(a, 'L', 'x', 0, 0, 'linear');
    setKeyframe(a, 'L', 'x', 10, 100, 'linear');
    setKeyframe(a, 'L', 'opacity', 0, 2, 'linear');
    const s = stateAt(a, 'L', 5, base);
    expect(s.x).toBe(50);
    expect(s.y).toBe(20);
    expect(s.opacity).toBe(1);
  });
  it('scale never reaches zero', () => {
    const a = createAnimation();
    setKeyframe(a, 'L', 'scale', 0, -5);
    expect(stateAt(a, 'L', 0, base).scale).toBeGreaterThan(0);
  });
});

describe('project data', () => {
  it('sanitises garbage, clamps, and drops unknown layers', () => {
    const s = sanitizeAnimation({ fps: 9999, frames: -5, tracks: { A: { x: [{ f: 3, v: 1, ease: 'weird' }, { f: 3, v: 2, ease: 'linear' }, { f: 'q', v: 'z' }], y: 'no' }, B: { x: [{ f: 1, v: 1, ease: 'linear' }] }, C: 7 } }, new Set(['A', 'C']))!;
    expect(s.fps).toBe(60);
    expect(s.frames).toBe(1);
    expect(Object.keys(s.tracks)).toEqual(['A']);
    expect(s.tracks.A!.x!.length).toBe(1);
    expect(s.tracks.A!.x![0]!.f).toBe(0);
    expect(sanitizeAnimation(null)).toBeUndefined();
    expect(sanitizeAnimation('x')).toBeUndefined();
  });
  it('clone is deep', () => {
    const a = createAnimation();
    setKeyframe(a, 'L', 'x', 1, 1);
    const c = cloneAnimation(a);
    c.tracks.L!.x![0]!.v = 99;
    expect(a.tracks.L!.x![0]!.v).toBe(1);
  });
});
