import { describe, expect, it } from 'vitest';
import { ACCENTS, appearanceVars, defaultAppearance, sanitizeAppearance } from '../src/ui/appearance';

describe('appearance settings', () => {
  it('glass defaults on only for the macOS desktop app', () => {
    expect(defaultAppearance(true).glass).toBe(true);
    expect(defaultAppearance(false).glass).toBe(false);
  });
  it('falls back to defaults for garbage', () => {
    expect(sanitizeAppearance(null)).toEqual(defaultAppearance(false));
    expect(sanitizeAppearance('x', true)).toEqual(defaultAppearance(true));
    const s = sanitizeAppearance({ accent: 'javascript:alert(1)', radius: 'big', density: 'huge', glass: 'yes', glassBlur: 1e6, glassOpacity: -4 });
    expect(s.accent).toBe(ACCENTS[0]);
    expect(s.radius).toBe(1);
    expect(s.density).toBe('comfortable');
    expect(s.glassBlur).toBe(80);
    expect(s.glassOpacity).toBe(0.25);
  });
  it('keeps valid values and normalises colour case', () => {
    const s = sanitizeAppearance({ accent: '#FF00AA', radius: 1.5, density: 'compact', glass: true, glassBlur: 12, glassOpacity: 0.7 });
    expect(s).toEqual({ accent: '#ff00aa', radius: 1.5, density: 'compact', glass: true, glassBlur: 12, glassOpacity: 0.7 });
  });
  it('derives CSS variables', () => {
    const v = appearanceVars({ accent: '#ff0000', radius: 2, density: 'compact', glass: true, glassBlur: 30, glassOpacity: 0.5 });
    expect(v['--accent']).toBe('#ff0000');
    expect(v['--accent-soft']).toBe('rgba(255, 0, 0, 0.16)');
    expect(v['--radius']).toBe('16px');
    expect(v['--radius-lg']).toBe('24px');
    expect(v['--topbar-h']).toBe('36px');
    expect(v['--glass-blur']).toBe('30px');
    expect(v['--glass-opacity']).toBe('50%');
  });
});
